//! The corpus index: the project's foreign memory documents (agent memory
//! files, instructions, notes, captured sessions) for retrieval. SQLite is
//! the source of truth for the documents and their cached vectors; the
//! per-model usearch file is a projection rebuilt from the cache whenever it
//! is missing, torn or out of step — without the model.
//!
//! `corpus.sqlite` (WAL) holds `meta` (model, dims), `docs` (id, vector key,
//! content hash, corpus tag, title, source, text, scope), `docs_fts` (BM25,
//! written in the same transaction as its row) and `embed_cache` (f16
//! vectors keyed by model + content hash). Its vector file is
//! `corpus.<model-slug>.usearch` beside it.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::Result;
use atlas_retrieval::codec::{cache_key, from_f16, slug, to_f16, vkey};
use atlas_retrieval::vectors::VectorFile;
use rusqlite::{params, Connection, OptionalExtension};

use crate::docstore::{split_embedded, DocText};
use crate::{CorpusDoc, IndexStats, DIM, PROVIDER_NAME};

pub const DB_FILE: &str = "corpus.sqlite";

/// The files the corpus index lived in before it moved into SQLite. They are
/// derived (rebuilt from the corpus), so the first open deletes them.
const LEGACY_FILES: [&str; 3] = ["hnsw.usearch", "manifest.json", "docstore.json"];

/// What an index pass must do: ids index into the caller's docs.
pub struct Plan {
    /// Docs new or changed (written as rows).
    pub upsert: Vec<String>,
    /// Docs gone from the corpus.
    pub delete: Vec<String>,
    /// Docs whose text has no cached vector for the current model.
    pub need_embed: Vec<String>,
    pub unchanged: usize,
}

pub struct CorpusIndex {
    dir: PathBuf,
    conn: Mutex<Connection>,
    model: String,
    dims: usize,
    vectors: VectorFile,
    /// The database was damaged and replaced by an empty one on open (taken
    /// by the next health pass).
    pub recreated: bool,
}

/// A doc's usearch key: from its id, so a doc keeps its key across edits.
fn doc_key(id: &str) -> i64 {
    vkey(blake3::hash(id.as_bytes()).as_bytes())
}

/// The cache key of a doc's embedding: per model, per content hash (the
/// caller's hash of exactly the text it embeds).
fn doc_cache_key(model: &str, content_hash: &str) -> [u8; 32] {
    cache_key(model, content_hash)
}

fn vector_path(dir: &Path, model: &str) -> PathBuf {
    dir.join(format!("corpus.{}.usearch", slug(model)))
}

/// The `meta` row present while `model`'s vector file may be behind the
/// cache: a pass committed vectors its save has not written yet (a failed
/// save, or a crash in between). Heal rebuilds while it is set.
fn dirty_key(model: &str) -> String {
    format!("vectors_dirty:{model}")
}

/// Open `corpus.sqlite` in `dir` with its schema, or fail (a damaged file).
fn open_db(dir: &Path) -> Result<Connection> {
    let conn = Connection::open(dir.join(DB_FILE))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS docs (
             id TEXT PRIMARY KEY, vkey INTEGER NOT NULL, content_hash TEXT NOT NULL,
             corpus TEXT NOT NULL, title TEXT NOT NULL, source TEXT NOT NULL, text TEXT NOT NULL,
             scope TEXT NOT NULL DEFAULT 'repo');
         CREATE INDEX IF NOT EXISTS docs_vkey ON docs(vkey);
         CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(title, text, content='',
             contentless_delete=1, tokenize='{}');
         CREATE TABLE IF NOT EXISTS embed_cache (key BLOB PRIMARY KEY, model TEXT NOT NULL,
             dims INTEGER NOT NULL, vec BLOB NOT NULL);",
        crate::record::FTS_TOKENIZE
    ))?;
    let quick: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    if quick != "ok" {
        anyhow::bail!("quick_check: {quick}");
    }
    Ok(conn)
}

impl CorpusIndex {
    /// Open (creating if needed) the corpus index in `dir`, and heal its
    /// vector file from the cache. A damaged database is kept as
    /// `corpus.sqlite.corrupt-<ms>` and replaced by an empty one: the corpus
    /// is derived, so the next index pass gathers it again.
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir)?;
        for f in LEGACY_FILES {
            let _ = std::fs::remove_file(dir.join(f));
        }
        let mut recreated = false;
        let conn = match open_db(dir) {
            Ok(conn) => conn,
            Err(e) => {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_millis());
                tracing::warn!(
                    target: "atlas_memory",
                    "corpus index at {} is damaged ({e:#}); starting it again",
                    dir.display()
                );
                for suffix in ["", "-wal", "-shm"] {
                    let from = dir.join(format!("{DB_FILE}{suffix}"));
                    if from.exists() {
                        std::fs::rename(
                            &from,
                            dir.join(format!("{DB_FILE}{suffix}.corrupt-{now}")),
                        )?;
                    }
                }
                recreated = true;
                open_db(dir)?
            }
        };
        let meta = |k: &str| -> Option<String> {
            conn.query_row("SELECT v FROM meta WHERE k = ?1", [k], |r| r.get(0))
                .optional()
                .ok()
                .flatten()
        };
        let model = meta("model").unwrap_or_else(|| PROVIDER_NAME.to_string());
        let dims = meta("dims").and_then(|d| d.parse().ok()).unwrap_or(DIM);
        let (vectors, _) = VectorFile::open(vector_path(dir, &model), dims)?;
        let mut me = Self {
            dir: dir.to_path_buf(),
            conn: Mutex::new(conn),
            model,
            dims,
            vectors,
            recreated,
        };
        me.heal()?;
        Ok(me)
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    pub fn dims(&self) -> usize {
        self.dims
    }

    fn vectors_dirty(&self) -> bool {
        self.conn()
            .query_row(
                "SELECT 1 FROM meta WHERE k = ?1",
                [dirty_key(&self.model)],
                |_| Ok(()),
            )
            .optional()
            .ok()
            .flatten()
            .is_some()
    }

    /// The vector file was saved: it holds what the cache holds.
    fn mark_vectors_saved(&self) {
        if let Err(e) = self
            .conn()
            .execute("DELETE FROM meta WHERE k = ?1", [dirty_key(&self.model)])
        {
            tracing::warn!(target: "atlas_memory", "corpus vector flag not cleared: {e}");
        }
    }

    /// Make the vector file hold exactly the docs that have a cached vector
    /// for the current model; rebuild it from the cache when they differ or
    /// an earlier pass did not save it. A failed save is logged and retried
    /// later, never an error. Returns how many vectors a rebuild wrote (0
    /// when it was in step).
    pub fn heal(&mut self) -> Result<usize> {
        let want: Vec<(i64, Vec<f32>)> = {
            let conn = self.conn();
            let mut docs = conn.prepare("SELECT vkey, content_hash FROM docs")?;
            let mut get = conn.prepare_cached("SELECT vec FROM embed_cache WHERE key = ?1")?;
            let mut out = Vec::new();
            for row in docs.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))? {
                let (k, hash) = row?;
                if let Some(b) = get
                    .query_row([&doc_cache_key(&self.model, &hash)[..]], |r| {
                        r.get::<_, Vec<u8>>(0)
                    })
                    .optional()?
                {
                    out.push((k, from_f16(&b)));
                }
            }
            out
        };
        let in_step = !self.vectors_dirty()
            && self.vectors.len() == want.len()
            && want.iter().all(|(k, _)| self.vectors.contains(*k));
        if in_step {
            // A save an earlier pass could not finish is retried here.
            if self.vectors.has_unsaved() {
                if let Err(e) = self.vectors.save() {
                    tracing::warn!(
                        target: "atlas_memory",
                        "corpus vector save failed (retried later): {e}"
                    );
                }
            }
            return Ok(0);
        }
        let path = vector_path(&self.dir, &self.model);
        let _ = std::fs::remove_file(&path);
        let (fresh, _) = VectorFile::open(path, self.dims)?;
        for (k, v) in &want {
            if v.len() == self.dims {
                fresh.add(*k, v)?;
            }
        }
        // Kept even when the save fails: it stays unsaved, so the next pass
        // retries it, and the dirty flag makes the next open rebuild again.
        self.vectors = fresh;
        match self.vectors.save() {
            Ok(()) => self.mark_vectors_saved(),
            Err(e) => tracing::warn!(
                target: "atlas_memory",
                "corpus vector save failed (retried later): {e}"
            ),
        }
        tracing::info!(target: "atlas_memory", "corpus vectors rebuilt from cache: {}", want.len());
        Ok(want.len())
    }

    /// Rebuild `docs_fts` from `docs` when they disagree. Returns whether it did.
    pub fn repair_fts(&self) -> Result<bool> {
        let conn = self.conn();
        let missing: i64 = conn.query_row(
            "SELECT COUNT(*) FROM docs WHERE rowid NOT IN (SELECT rowid FROM docs_fts)",
            [],
            |r| r.get(0),
        )?;
        let extra: i64 = conn.query_row(
            "SELECT COUNT(*) FROM docs_fts WHERE rowid NOT IN (SELECT rowid FROM docs)",
            [],
            |r| r.get(0),
        )?;
        if missing + extra == 0 {
            return Ok(false);
        }
        conn.execute_batch(
            "INSERT INTO docs_fts(docs_fts) VALUES('delete-all');
             INSERT INTO docs_fts (rowid, title, text) SELECT rowid, title, text FROM docs;",
        )?;
        Ok(true)
    }

    /// What indexing `docs` (the whole corpus) must do.
    pub fn plan(&self, docs: &[CorpusDoc]) -> Result<Plan> {
        let conn = self.conn();
        let stored: HashMap<String, String> = conn
            .prepare("SELECT id, content_hash FROM docs")?
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut get = conn.prepare_cached("SELECT 1 FROM embed_cache WHERE key = ?1")?;
        let mut plan = Plan {
            upsert: vec![],
            delete: vec![],
            need_embed: vec![],
            unchanged: 0,
        };
        let present: BTreeSet<&str> = docs.iter().map(|d| d.id.as_str()).collect();
        for d in docs {
            let cached = get
                .query_row([&doc_cache_key(&self.model, &d.content_hash)[..]], |_| {
                    Ok(())
                })
                .optional()?
                .is_some();
            let same = stored.get(&d.id).is_some_and(|h| *h == d.content_hash);
            if same && cached {
                plan.unchanged += 1;
                continue;
            }
            plan.upsert.push(d.id.clone());
            if !cached {
                plan.need_embed.push(d.id.clone());
            }
        }
        let mut gone: Vec<String> = stored
            .keys()
            .filter(|id| !present.contains(id.as_str()))
            .cloned()
            .collect();
        gone.sort();
        plan.delete = gone;
        Ok(plan)
    }

    /// Write a plan: docs, FTS rows and fresh vectors in one transaction,
    /// then the vector file (saved only when it changed). A failed save
    /// leaves the file behind the database, flagged dirty until a save
    /// succeeds; the next pass or open retries it.
    pub fn apply(
        &mut self,
        plan: &Plan,
        docs: &[CorpusDoc],
        fresh: &HashMap<String, Vec<f32>>,
    ) -> Result<IndexStats> {
        let by_id: HashMap<&str, &CorpusDoc> = docs.iter().map(|d| (d.id.as_str(), d)).collect();
        let mut added_vectors: Vec<(i64, Vec<f32>)> = Vec::new();
        let mut added = 0;
        let mut updated = 0;
        {
            let mut conn = self.conn();
            let tx = conn.transaction()?;
            for id in &plan.upsert {
                let Some(d) = by_id.get(id.as_str()) else {
                    continue;
                };
                let existed = tx
                    .query_row("SELECT rowid FROM docs WHERE id = ?1", [id], |r| {
                        r.get::<_, i64>(0)
                    })
                    .optional()?;
                if let Some(rowid) = existed {
                    tx.execute("DELETE FROM docs_fts WHERE rowid = ?1", [rowid])?;
                    updated += 1;
                } else {
                    added += 1;
                }
                let (title, body) = split_embedded(&d.text);
                let scope = if id.ends_with("@global") {
                    "user"
                } else {
                    "repo"
                };
                tx.execute(
                    "INSERT INTO docs (id, vkey, content_hash, corpus, title, source, text, scope) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?4, ?6, ?7) \
                     ON CONFLICT(id) DO UPDATE SET content_hash = excluded.content_hash, \
                     corpus = excluded.corpus, title = excluded.title, source = excluded.source, \
                     text = excluded.text, scope = excluded.scope",
                    params![id, doc_key(id), d.content_hash, d.corpus, title, body, scope],
                )?;
                let rowid: i64 =
                    tx.query_row("SELECT rowid FROM docs WHERE id = ?1", [id], |r| r.get(0))?;
                tx.execute(
                    "INSERT INTO docs_fts (rowid, title, text) SELECT rowid, title, text FROM docs \
                     WHERE rowid = ?1",
                    [rowid],
                )?;
                if let Some(v) = fresh.get(id) {
                    tx.execute(
                        "INSERT OR REPLACE INTO embed_cache (key, model, dims, vec) VALUES (?1, ?2, ?3, ?4)",
                        params![
                            &doc_cache_key(&self.model, &d.content_hash)[..],
                            self.model,
                            v.len() as i64,
                            to_f16(v)
                        ],
                    )?;
                    added_vectors.push((doc_key(id), v.clone()));
                } else if let Some(b) = tx
                    .query_row(
                        "SELECT vec FROM embed_cache WHERE key = ?1",
                        [&doc_cache_key(&self.model, &d.content_hash)[..]],
                        |r| r.get::<_, Vec<u8>>(0),
                    )
                    .optional()?
                {
                    added_vectors.push((doc_key(id), from_f16(&b)));
                }
            }
            for id in &plan.delete {
                if let Some(rowid) = tx
                    .query_row("SELECT rowid FROM docs WHERE id = ?1", [id], |r| {
                        r.get::<_, i64>(0)
                    })
                    .optional()?
                {
                    tx.execute("DELETE FROM docs_fts WHERE rowid = ?1", [rowid])?;
                }
                tx.execute("DELETE FROM docs WHERE id = ?1", [id])?;
            }
            tx.execute(
                "INSERT OR REPLACE INTO meta (k, v) VALUES ('model', ?1), ('dims', ?2)",
                params![self.model, self.dims.to_string()],
            )?;
            if !added_vectors.is_empty() || !plan.delete.is_empty() {
                tx.execute(
                    "INSERT OR REPLACE INTO meta (k, v) VALUES (?1, '1')",
                    [dirty_key(&self.model)],
                )?;
            }
            tx.commit()?;
        }
        for id in &plan.delete {
            self.vectors.remove(doc_key(id));
        }
        for (k, v) in &added_vectors {
            if v.len() == self.dims {
                self.vectors.add(*k, v)?;
            }
        }
        if self.vectors.has_unsaved() {
            if let Err(e) = self.vectors.save() {
                tracing::warn!(
                    target: "atlas_memory",
                    "corpus vector save failed (retried by the next pass): {e}"
                );
            }
        }
        if !self.vectors.has_unsaved() {
            self.mark_vectors_saved();
        }
        Ok(IndexStats {
            added,
            updated,
            deleted: plan.delete.len(),
            unchanged: plan.unchanged,
        })
    }

    fn id_of(&self, key: i64) -> Option<String> {
        self.conn()
            .query_row("SELECT id FROM docs WHERE vkey = ?1", [key], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
    }

    /// `(doc id, cosine)` nearest `q`, best first.
    pub fn search_dense(&self, q: &[f32], k: usize) -> Vec<(String, f32)> {
        self.vectors
            .search(q, k)
            .into_iter()
            .filter_map(|(key, sim)| self.id_of(key).map(|id| (id, sim)))
            .collect()
    }

    /// Doc ids whose words match `q` (BM25), best first.
    pub fn search_bm25(&self, q: &str, k: usize) -> Result<Vec<String>> {
        let Some(m) = crate::record::fts_query(q) else {
            return Ok(Vec::new());
        };
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT d.id FROM docs_fts f JOIN docs d ON d.rowid = f.rowid \
             WHERE docs_fts MATCH ?1 ORDER BY f.rank LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![m, k as i64], |r| r.get(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn doc(&self, id: &str) -> Option<DocText> {
        self.conn()
            .query_row(
                "SELECT title, source, text FROM docs WHERE id = ?1",
                [id],
                |r| {
                    Ok(DocText {
                        title: r.get(0)?,
                        source: r.get(1)?,
                        text: r.get(2)?,
                    })
                },
            )
            .optional()
            .ok()
            .flatten()
    }

    pub fn corpus_of(&self, id: &str) -> Option<String> {
        self.conn()
            .query_row("SELECT corpus FROM docs WHERE id = ?1", [id], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
    }

    /// The cached vector of doc `id` while its stored content still hashes
    /// to `hash`.
    pub fn vector(&self, id: &str, hash: &str) -> Option<Vec<f32>> {
        let conn = self.conn();
        let stored: String = conn
            .query_row("SELECT content_hash FROM docs WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .optional()
            .ok()
            .flatten()?;
        if stored != hash {
            return None;
        }
        conn.query_row(
            "SELECT vec FROM embed_cache WHERE key = ?1",
            [&doc_cache_key(&self.model, hash)[..]],
            |r| r.get::<_, Vec<u8>>(0),
        )
        .optional()
        .ok()
        .flatten()
        .map(|b| from_f16(&b))
    }

    /// Remove doc `id`. Returns whether it was indexed.
    pub fn evict(&mut self, id: &str) -> Result<bool> {
        let existed = self
            .conn()
            .query_row("SELECT 1 FROM docs WHERE id = ?1", [id], |_| Ok(()))
            .optional()?
            .is_some();
        if existed {
            let plan = Plan {
                upsert: vec![],
                delete: vec![id.to_string()],
                need_embed: vec![],
                unchanged: 0,
            };
            self.apply(&plan, &[], &HashMap::new())?;
        }
        Ok(existed)
    }

    /// Point the index at another model: its own vector file, the same docs
    /// and cache. Docs whose vectors that model already cached are back at
    /// once; the rest are embedded by the next pass.
    pub fn switch_model(&mut self, model: &str, dims: usize) -> Result<()> {
        self.model = model.to_string();
        self.dims = dims;
        let (v, _) = VectorFile::open(vector_path(&self.dir, model), dims)?;
        self.vectors = v;
        self.conn().execute(
            "INSERT OR REPLACE INTO meta (k, v) VALUES ('model', ?1), ('dims', ?2)",
            params![model, dims.to_string()],
        )?;
        self.heal()?;
        Ok(())
    }

    pub fn len(&self) -> usize {
        self.conn()
            .query_row("SELECT COUNT(*) FROM docs", [], |r| r.get::<_, i64>(0))
            .unwrap_or(0) as usize
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(i: usize) -> Vec<f32> {
        let mut v = vec![0.0; DIM];
        v[i] = 1.0;
        v
    }

    fn index(idx: &mut CorpusIndex, hash: &str, v: Vec<f32>) {
        let docs = vec![CorpusDoc {
            id: "note:a".into(),
            text: "a note".into(),
            content_hash: hash.into(),
            corpus: "note".into(),
        }];
        let plan = idx.plan(&docs).unwrap();
        let fresh = HashMap::from([("note:a".to_string(), v)]);
        idx.apply(&plan, &docs, &fresh).unwrap();
    }

    /// An edit committed to the database whose vector file save never
    /// happened (a crash, a locked file) is rebuilt on the next open, though
    /// the file still holds the same keys.
    #[test]
    fn an_unsaved_vector_edit_is_rebuilt_on_open() {
        let dir = tempfile::tempdir().unwrap();
        let mut idx = CorpusIndex::open(dir.path()).unwrap();
        index(&mut idx, "h1", unit(0));
        let file = vector_path(dir.path(), idx.model());
        let old = std::fs::read(&file).unwrap();
        index(&mut idx, "h2", unit(1));
        assert!(!idx.vectors_dirty(), "a saved pass clears the flag");
        let model = idx.model().to_string();
        drop(idx);

        // As a crash between the commit and the save leaves it.
        std::fs::write(&file, old).unwrap();
        let conn = Connection::open(dir.path().join(DB_FILE)).unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO meta (k, v) VALUES (?1, '1')",
            [dirty_key(&model)],
        )
        .unwrap();
        drop(conn);

        let idx = CorpusIndex::open(dir.path()).unwrap();
        let hits = idx.search_dense(&unit(1), 1);
        assert_eq!(hits.first().map(|h| h.0.as_str()), Some("note:a"));
        assert!(hits[0].1 > 0.9, "the edited vector, not the old one");
        assert!(!idx.vectors_dirty());
    }
}
