//! Chunk vectors for one embedding model: a usearch HNSW file per model under
//! `.atlas/code-index/` (`atlas_retrieval::vectors::VectorFile`), keyed by
//! `vkey` (the first 8 bytes of a chunk's content hash, so identical chunks
//! share one vector) and mirrored in `chunk_vectors` so stale keys can be
//! removed. Embeddings are cached by `cache_key(model_id, text)` and survive
//! model switches and reverts.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, PoisonError, RwLock};

use atlas_retrieval::codec::{cache_key, from_f16, slug, to_f16};
use atlas_retrieval::vectors::{Opened, VectorFile};
use atlas_search::CancelToken;
use rusqlite::params;

pub use atlas_retrieval::Embedder;

use crate::chunk::chunk_text;
use crate::{store, CodeIndex, IndexError};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct VectorStats {
    pub added: usize,
    pub removed: usize,
    pub embedded: usize,
    pub cached: usize,
    pub skipped_stale: usize,
}

/// Chunks embedded per model call (and per committed batch of rows).
const BATCH: usize = 32;

fn retrieval_err(e: atlas_retrieval::RetrievalError) -> IndexError {
    IndexError::Invalid(e.to_string())
}

pub(crate) fn index_path(root: &Path, model_id: &str) -> PathBuf {
    store::index_dir(root).join(format!("chunks.{}.usearch", slug(model_id)))
}

/// One chunk to embed: where it is, its header, and its content hash.
struct Present {
    rel: String,
    start: u32,
    end: u32,
    header: String,
    hash: Vec<u8>,
}

impl CodeIndex {
    /// The open vector file for `model_id`, opening (and healing) it once.
    pub(crate) fn vectors_for(
        &self,
        model_id: &str,
        dims: usize,
    ) -> Result<Arc<RwLock<VectorFile>>, IndexError> {
        let mut map = self
            .inner
            .vectors
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(v) = map.get(model_id) {
            return Ok(v.clone());
        }
        let (v, opened) =
            VectorFile::open(index_path(self.root(), model_id), dims).map_err(retrieval_err)?;
        match opened {
            Opened::Fresh | Opened::Reset => {
                // The file is new or unreadable: membership rows are not
                // trustworthy, so every chunk is re-added (from the cache
                // where it can be).
                self.with_writer(|c| {
                    c.execute("DELETE FROM chunk_vectors WHERE model_id = ?1", [model_id])
                })?;
            }
            Opened::Loaded => {
                // `sync_vectors` commits membership per batch but saves the
                // file once at the end, so a crash or an error in between
                // leaves rows for vectors the file lacks. Forget those rows:
                // the next sync re-adds them, from `embed_cache`, without
                // running the model. The opposite case (a vector with no row)
                // is harmless: search maps keys through `chunks.vkey`, and the
                // next sync overwrites it.
                let rows: Vec<i64> = self.with_reader(|c| {
                    c.prepare("SELECT vkey FROM chunk_vectors WHERE model_id = ?1")?
                        .query_map([model_id], |r| r.get(0))?
                        .collect()
                })?;
                let lost: Vec<i64> = rows.into_iter().filter(|k| !v.contains(*k)).collect();
                if !lost.is_empty() {
                    self.with_writer(|c| {
                        let mut del = c.prepare_cached(
                            "DELETE FROM chunk_vectors WHERE model_id = ?1 AND vkey = ?2",
                        )?;
                        for k in &lost {
                            del.execute(params![model_id, k])?;
                        }
                        Ok(())
                    })?;
                }
            }
        }
        let v = Arc::new(RwLock::new(v));
        map.insert(model_id.to_string(), v.clone());
        Ok(v)
    }

    /// Embed every chunk whose content has no vector for this model; drop
    /// vectors whose content is gone. Cancellable between batches; partial
    /// progress is kept.
    pub fn sync_vectors(
        &self,
        emb: &dyn Embedder,
        cancel: &CancelToken,
    ) -> Result<VectorStats, IndexError> {
        let model = emb.model_id().to_string();
        let vectors = self.vectors_for(&model, emb.dims())?;
        let mut stats = VectorStats::default();
        // Present: vkey → the first chunk with that key.
        let present: BTreeMap<i64, Present> = self.with_reader(|c| {
            let mut stmt = c.prepare(
                "SELECT c.vkey, f.rel, c.start_line, c.end_line, c.header, c.content_hash
                 FROM chunks c JOIN files f ON f.id = c.file_id ORDER BY c.vkey, c.id",
            )?;
            let mut out = BTreeMap::new();
            for row in stmt.query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    Present {
                        rel: r.get(1)?,
                        start: r.get(2)?,
                        end: r.get(3)?,
                        header: r.get(4)?,
                        hash: r.get(5)?,
                    },
                ))
            })? {
                let (k, v) = row?;
                out.entry(k).or_insert(v);
            }
            Ok(out)
        })?;
        let have: BTreeSet<i64> = self.with_reader(|c| {
            c.prepare("SELECT vkey FROM chunk_vectors WHERE model_id = ?1")?
                .query_map([&model], |r| r.get(0))?
                .collect()
        })?;
        let stale: Vec<i64> = have
            .iter()
            .filter(|k| !present.contains_key(k))
            .copied()
            .collect();
        let missing: Vec<i64> = present
            .keys()
            .filter(|k| !have.contains(k))
            .copied()
            .collect();
        if !stale.is_empty() {
            {
                // Write lock: usearch forbids searches during remove/reserve.
                let v = vectors.write().unwrap_or_else(PoisonError::into_inner);
                for k in &stale {
                    v.remove(*k);
                }
            }
            self.with_writer(|c| {
                let mut del = c.prepare_cached(
                    "DELETE FROM chunk_vectors WHERE model_id = ?1 AND vkey = ?2",
                )?;
                for k in &stale {
                    del.execute(params![model, k])?;
                }
                Ok(())
            })?;
            stats.removed = stale.len();
        }
        let mut file_cache: HashMap<String, Option<Vec<String>>> = HashMap::new();
        for batch in missing.chunks(BATCH) {
            if cancel.is_cancelled() {
                break;
            }
            // (vkey, text, cache key)
            let mut todo: Vec<(i64, String, [u8; 32])> = Vec::new();
            for &k in batch {
                let p = &present[&k];
                let lines = file_cache.entry(p.rel.clone()).or_insert_with(|| {
                    std::fs::read_to_string(self.root().join(&p.rel))
                        .ok()
                        .map(|t| t.lines().map(str::to_string).collect())
                });
                let Some(lines) = lines else {
                    stats.skipped_stale += 1;
                    continue;
                };
                let from = (p.start as usize).saturating_sub(1).min(lines.len());
                let to = (p.end as usize).min(lines.len()).max(from);
                let text = chunk_text(&p.header, &lines[from..to].join("\n"));
                if blake3::hash(text.as_bytes()).as_bytes()[..] != p.hash[..] {
                    // Edited since indexing; the watcher re-chunks the file
                    // and a later sync embeds the new text.
                    stats.skipped_stale += 1;
                    continue;
                }
                let key = cache_key(&model, &text);
                todo.push((k, text, key));
            }
            let cached: HashMap<[u8; 32], Vec<f32>> = self.with_reader(|c| {
                let mut get = c.prepare_cached("SELECT vec FROM embed_cache WHERE key = ?1")?;
                let mut out = HashMap::new();
                for (_, _, key) in &todo {
                    if let Ok(b) = get.query_row([&key[..]], |r| r.get::<_, Vec<u8>>(0)) {
                        out.insert(*key, from_f16(&b));
                    }
                }
                Ok(out)
            })?;
            let need: Vec<&(i64, String, [u8; 32])> =
                todo.iter().filter(|t| !cached.contains_key(&t.2)).collect();
            let fresh = if need.is_empty() {
                Vec::new()
            } else {
                let texts: Vec<&str> = need.iter().map(|t| t.1.as_str()).collect();
                let out = emb.embed_documents(&texts).map_err(IndexError::Invalid)?;
                if out.len() != texts.len() {
                    return Err(IndexError::Invalid(format!(
                        "the embedder returned {} vectors for {} texts",
                        out.len(),
                        texts.len()
                    )));
                }
                out
            };
            let fresh: HashMap<[u8; 32], Vec<f32>> = need.iter().map(|t| t.2).zip(fresh).collect();
            {
                // Write lock: `add` may `reserve`, which must not run while a
                // search does.
                let v = vectors.write().unwrap_or_else(PoisonError::into_inner);
                for (k, _, key) in &todo {
                    let vec = cached.get(key).or_else(|| fresh.get(key)).ok_or_else(|| {
                        IndexError::Invalid("embedder returned too few vectors".into())
                    })?;
                    v.add(*k, vec).map_err(retrieval_err)?;
                }
            }
            self.with_writer(|c| {
                let mut put_cache = c.prepare_cached(
                    "INSERT OR REPLACE INTO embed_cache(key, dims, vec) VALUES (?1, ?2, ?3)",
                )?;
                for (key, vec) in &fresh {
                    put_cache.execute(params![
                        &key[..],
                        i64::try_from(vec.len()).unwrap_or(i64::MAX),
                        to_f16(vec)
                    ])?;
                }
                let mut put = c.prepare_cached(
                    "INSERT OR IGNORE INTO chunk_vectors(model_id, vkey) VALUES (?1, ?2)",
                )?;
                for (k, _, _) in &todo {
                    put.execute(params![model, k])?;
                }
                Ok(())
            })?;
            stats.added += todo.len();
            stats.embedded += fresh.len();
            stats.cached += todo.len() - fresh.len();
        }
        if stats.added + stats.removed > 0 {
            vectors
                .read()
                .unwrap_or_else(PoisonError::into_inner)
                .save()
                .map_err(retrieval_err)?;
        }
        Ok(stats)
    }
}
