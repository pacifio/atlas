//! Lexical tier — SQLite FTS5 (BM25) over [`crate::chunk::CodeChunk`]s.
//!
//! This is the zero-download rung of the retrieval ladder: a ranked,
//! incrementally-updated code search that needs no model weights. Dense
//! retrieval tolerates staleness (a stale vector still points roughly right);
//! lexical does not (a search that misses just-written code sends the agent
//! hunting), so this store is git-anchored: builds stamp per-file recency from
//! `git log`, and [`refresh_files`](LexicalStore::refresh_files) re-chunks the
//! dirty overlay at query time.
//!
//! Everything here is synchronous rusqlite; callers wrap in `spawn_blocking`.
//! Writes are transactional (crash-safe by SQLite's contract), and every skip
//! or drop is counted on [`LexicalBuildStats`] — never silent.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use rusqlite::Connection;

use crate::chunk::{chunk_source, CodeChunk};
use crate::ScannedFile;

/// Schema version; a mismatch rebuilds the store (it is derived data).
const SCHEMA_VERSION: i32 = 1;
/// Query tokens considered at most (a paragraph-long query is capped, counted).
const MAX_QUERY_TOKENS: usize = 12;
/// Commits consulted for the per-file recency stamp.
const GIT_LOG_COMMITS: usize = 400;
/// Dirty files re-chunked per refresh call at most.
pub const MAX_REFRESH_FILES: usize = 50;
/// Embeddable text cap: header + body truncated to roughly a model window.
const EMBED_MAX_BYTES: usize = 1600;

/// `<project>/.atlas/codebase-index/lexical.sqlite`
pub fn lexical_path(project_path: &str) -> PathBuf {
    crate::index_dir(project_path).join("lexical.sqlite")
}

/// The shared chunk-document id: `code:<rel>#<hash12>`. Dense and lexical hits
/// carry the same id, so rank fusion accumulates instead of double-counting.
pub fn chunk_doc_id(rel: &str, hash: &str) -> String {
    let short = &hash[..hash.len().min(12)];
    format!("code:{rel}#{short}")
}

/// Embeddable text for a chunk: the context header plus the body, truncated to
/// [`EMBED_MAX_BYTES`] on a char boundary.
pub fn embed_text(chunk: &CodeChunk) -> String {
    let mut s = format!("{}\n{}", chunk.header, chunk.body);
    if s.len() > EMBED_MAX_BYTES {
        let mut cut = EMBED_MAX_BYTES;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
    }
    s
}

/// One ranked lexical hit. `bm25` is normalized so higher is better.
#[derive(Debug, Clone)]
pub struct LexicalHit {
    pub rel: String,
    pub language: String,
    pub kind: String,
    pub symbol: String,
    pub header: String,
    pub body: String,
    pub start_line: u32,
    pub end_line: u32,
    /// Chunk content address (blake3 hex).
    pub hash: String,
    /// Seconds-epoch of the file's last commit (mtime seconds when no git).
    pub recency_epoch: i64,
    pub bm25: f64,
}

impl LexicalHit {
    /// The fusion id shared with the dense corpus.
    pub fn doc_id(&self) -> String {
        chunk_doc_id(&self.rel, &self.hash)
    }
}

/// One incremental build pass, every lossy step counted.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct LexicalBuildStats {
    pub files_indexed: usize,
    pub files_unchanged: usize,
    pub files_removed: usize,
    pub files_unreadable: usize,
    pub chunks: usize,
    /// Files that fell back to whole-file line windows.
    pub fallback_files: usize,
    /// Chunks dropped by the per-file cap.
    pub dropped_chunks: u64,
}

pub struct LexicalStore {
    conn: Connection,
}

impl LexicalStore {
    /// Open-or-create the project store, migrating (by rebuild — it is derived
    /// data) on schema mismatch.
    pub fn open(project_path: &str) -> Result<Self> {
        let path = lexical_path(project_path);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
        }
        Self::open_at(&path)
    }

    /// Open a store at an explicit path (tests, eval harness).
    pub fn open_at(path: &Path) -> Result<Self> {
        let conn = Connection::open(path).with_context(|| format!("open {}", path.display()))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let version: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version != SCHEMA_VERSION {
            conn.execute_batch(
                "DROP TABLE IF EXISTS chunks_fts;\n                 DROP TABLE IF EXISTS chunks_vocab;\n                 DROP TABLE IF EXISTS chunks;",
            )?;
            conn.execute_batch(&format!(
                r#"
                CREATE TABLE chunks (
                    id INTEGER PRIMARY KEY,
                    rel TEXT NOT NULL,
                    language TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    symbol TEXT NOT NULL,
                    header TEXT NOT NULL,
                    body TEXT NOT NULL,
                    start_line INTEGER NOT NULL,
                    end_line INTEGER NOT NULL,
                    hash TEXT NOT NULL,
                    file_hash TEXT NOT NULL,
                    recency_epoch INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX idx_chunks_rel ON chunks(rel);
                -- Default unicode61 splits snake_case into subtokens, so the
                -- conceptual query "verify jwt" matches verify_jwt_token; an
                -- exact identifier query still works as a phrase match.
                CREATE VIRTUAL TABLE chunks_fts USING fts5(
                    symbol, header, body,
                    content='chunks', content_rowid='id'
                );
                CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
                    INSERT INTO chunks_fts(rowid, symbol, header, body)
                    VALUES (new.id, new.symbol, new.header, new.body);
                END;
                CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
                    INSERT INTO chunks_fts(chunks_fts, rowid, symbol, header, body)
                    VALUES ('delete', old.id, old.symbol, old.header, old.body);
                END;
                CREATE VIRTUAL TABLE chunks_vocab USING fts5vocab('chunks_fts', 'row');
                PRAGMA user_version = {SCHEMA_VERSION};
                "#
            ))?;
        }
        Ok(Self { conn })
    }

    /// rel → file_hash for every indexed file (drives the incremental diff).
    pub fn file_hashes(&self) -> Result<HashMap<String, String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT DISTINCT rel, file_hash FROM chunks")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut out = HashMap::new();
        for row in rows {
            let (rel, hash) = row?;
            out.insert(rel, hash);
        }
        Ok(out)
    }

    /// Replace every chunk of `rel` in one transaction.
    pub fn upsert_file(
        &mut self,
        rel: &str,
        file_hash: &str,
        recency_epoch: i64,
        chunks: &[CodeChunk],
    ) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM chunks WHERE rel = ?1", [rel])?;
        {
            let mut ins = tx.prepare(
                "INSERT INTO chunks (rel, language, kind, symbol, header, body,
                                     start_line, end_line, hash, file_hash, recency_epoch)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            )?;
            for c in chunks {
                ins.execute(rusqlite::params![
                    c.rel,
                    c.language,
                    c.kind,
                    c.symbol,
                    c.header,
                    c.body,
                    c.start_line,
                    c.end_line,
                    c.hash,
                    file_hash,
                    recency_epoch,
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn remove_file(&mut self, rel: &str) -> Result<()> {
        self.conn.execute("DELETE FROM chunks WHERE rel = ?1", [rel])?;
        Ok(())
    }

    pub fn chunk_count(&self) -> Result<u64> {
        Ok(self
            .conn
            .query_row("SELECT count(*) FROM chunks", [], |r| r.get(0))?)
    }

    /// Every stored chunk, for feeding the dense corpus. Ordered by (rel, id)
    /// so corpus diffs are stable.
    pub fn all_chunks(&self) -> Result<Vec<CodeChunk>> {
        let mut stmt = self.conn.prepare(
            "SELECT rel, language, kind, symbol, header, body,
                    start_line, end_line, hash
             FROM chunks ORDER BY rel, id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(CodeChunk {
                rel: r.get(0)?,
                language: r.get(1)?,
                kind: r.get(2)?,
                symbol: r.get(3)?,
                header: r.get(4)?,
                body: r.get(5)?,
                start_line: r.get(6)?,
                end_line: r.get(7)?,
                start_byte: 0,
                end_byte: 0,
                hash: r.get(8)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// BM25 search. The query is tokenized defensively (an FTS syntax error is
    /// impossible by construction) and matched as an OR of quoted tokens, with
    /// symbol > header > body column weighting.
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<LexicalHit>> {
        let Some(fts_query) = build_fts_query(query) else {
            return Ok(Vec::new());
        };
        let mut stmt = self.conn.prepare(
            "SELECT c.rel, c.language, c.kind, c.symbol, c.header, c.body,
                    c.start_line, c.end_line, c.hash, c.recency_epoch,
                    bm25(chunks_fts, 6.0, 3.0, 1.0) AS score
             FROM chunks_fts
             JOIN chunks c ON c.id = chunks_fts.rowid
             WHERE chunks_fts MATCH ?1
             ORDER BY score
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(rusqlite::params![fts_query, limit as i64], |r| {
            Ok(LexicalHit {
                rel: r.get(0)?,
                language: r.get(1)?,
                kind: r.get(2)?,
                symbol: r.get(3)?,
                header: r.get(4)?,
                body: r.get(5)?,
                start_line: r.get(6)?,
                end_line: r.get(7)?,
                hash: r.get(8)?,
                recency_epoch: r.get(9)?,
                // SQLite bm25() is lower-is-better (negative); flip it.
                bm25: -r.get::<_, f64>(10)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// How many chunks contain `term`, plus the total chunk count — the
    /// inputs to an IDF weight for rare identifiers. Snake_case identifiers
    /// are split the way the tokenizer splits them, and the **rarest** subtoken
    /// governs (that is what makes the identifier distinctive).
    pub fn doc_frequency(&self, term: &str) -> Result<(u64, u64)> {
        let total = self.chunk_count()?;
        let mut min_df: Option<u64> = None;
        for sub in term.split(|c: char| !c.is_alphanumeric()) {
            if sub.len() < 2 {
                continue;
            }
            let df: u64 = self
                .conn
                .query_row(
                    "SELECT COALESCE(SUM(doc), 0) FROM chunks_vocab WHERE term = ?1",
                    [sub.to_lowercase()],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            min_df = Some(min_df.map_or(df, |m| m.min(df)));
        }
        Ok((min_df.unwrap_or(0), total))
    }

    /// One chunk by file + content-address prefix (how fused doc ids
    /// `code:<rel>#<hash12>` map back to line ranges). `None` when the chunk
    /// is gone (file changed since it was embedded).
    pub fn lookup(&self, rel: &str, hash_prefix: &str) -> Result<Option<LexicalHit>> {
        if hash_prefix.is_empty() || !hash_prefix.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Ok(None);
        }
        let mut stmt = self.conn.prepare(
            "SELECT rel, language, kind, symbol, header, body,
                    start_line, end_line, hash, recency_epoch
             FROM chunks WHERE rel = ?1 AND hash LIKE ?2 || '%' LIMIT 1",
        )?;
        let mut rows = stmt.query_map(rusqlite::params![rel, hash_prefix], |r| {
            Ok(LexicalHit {
                rel: r.get(0)?,
                language: r.get(1)?,
                kind: r.get(2)?,
                symbol: r.get(3)?,
                header: r.get(4)?,
                body: r.get(5)?,
                start_line: r.get(6)?,
                end_line: r.get(7)?,
                hash: r.get(8)?,
                recency_epoch: r.get(9)?,
                bm25: 0.0,
            })
        })?;
        Ok(rows.next().transpose()?)
    }

    /// The freshness contract's dirty overlay: re-chunk `rels` (bounded by
    /// [`MAX_REFRESH_FILES`]) whose on-disk content no longer matches the
    /// store, so a query never misses just-written code. Returns how many
    /// files were re-indexed.
    pub fn refresh_files(&mut self, project_root: &Path, rels: &[String]) -> Result<usize> {
        let stored = self.file_hashes()?;
        let mut refreshed = 0usize;
        for rel in rels.iter().take(MAX_REFRESH_FILES) {
            let path = project_root.join(rel);
            let Ok(source) = std::fs::read_to_string(&path) else {
                // Deleted or unreadable: drop its chunks so hits can't cite a
                // file that is gone.
                if stored.contains_key(rel) {
                    self.remove_file(rel)?;
                    refreshed += 1;
                }
                continue;
            };
            let file_hash = crate::file_content_hash(&source);
            if stored.get(rel).map(String::as_str) == Some(file_hash.as_str()) {
                continue;
            }
            let ext = Path::new(rel)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("");
            let imports = crate::imports_of(&path, &source);
            let outcome = chunk_source(rel, ext, &source, &imports);
            let epoch = mtime_epoch(&path);
            self.upsert_file(rel, &file_hash, epoch, &outcome.chunks)?;
            refreshed += 1;
        }
        Ok(refreshed)
    }
}

/// Incremental lexical build over a structural scan: changed files re-chunk,
/// unchanged files are skipped, vanished files are removed. Recency comes from
/// `git log` (bounded), falling back to mtime.
pub fn build_lexical(project_path: &str, scanned: &[ScannedFile]) -> Result<LexicalBuildStats> {
    let root = Path::new(project_path);
    let mut store = LexicalStore::open(project_path)?;
    let stored = store.file_hashes()?;
    let recency = git_recency(root, GIT_LOG_COMMITS);

    let mut stats = LexicalBuildStats::default();
    let mut seen: HashSet<&str> = HashSet::new();
    for file in scanned {
        seen.insert(file.rel.as_str());
        if stored.get(&file.rel).map(String::as_str) == Some(file.hash.as_str()) {
            stats.files_unchanged += 1;
            continue;
        }
        let path = Path::new(&file.abs_path);
        let Ok(source) = std::fs::read_to_string(path) else {
            stats.files_unreadable += 1;
            continue;
        };
        // The file may have changed since the scan; hash what we actually read
        // so the stored hash always matches the stored chunks.
        let file_hash = crate::file_content_hash(&source);
        let ext = Path::new(&file.rel)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        let outcome = chunk_source(&file.rel, ext, &source, &file.imports);
        let epoch = recency
            .get(&file.rel)
            .copied()
            .unwrap_or_else(|| mtime_epoch(path));
        stats.chunks += outcome.chunks.len();
        stats.dropped_chunks += u64::from(outcome.dropped_over_cap);
        if outcome.fallback_whole_file {
            stats.fallback_files += 1;
        }
        store.upsert_file(&file.rel, &file_hash, epoch, &outcome.chunks)?;
        stats.files_indexed += 1;
    }
    for rel in stored.keys() {
        if !seen.contains(rel.as_str()) {
            store.remove_file(rel)?;
            stats.files_removed += 1;
        }
    }
    tracing::info!(
        target: "atlas::codeindex",
        files_indexed = stats.files_indexed as u64,
        files_unchanged = stats.files_unchanged as u64,
        files_removed = stats.files_removed as u64,
        files_unreadable = stats.files_unreadable as u64,
        chunks = stats.chunks as u64,
        fallback_files = stats.fallback_files as u64,
        dropped_chunks = stats.dropped_chunks,
        "lexical_build"
    );
    Ok(stats)
}

/// Modified/untracked files per `git status --porcelain -z`, filtered to
/// supported source extensions and capped — the dirty overlay's work list.
/// Empty outside a git repo (nothing can be stale relative to git).
pub fn dirty_files(root: &Path, cap: usize) -> Vec<String> {
    let Ok(out) = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["status", "--porcelain", "-z", "--untracked-files=normal"])
        .output()
    else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut rels = Vec::new();
    for entry in text.split('\0') {
        if entry.len() < 4 {
            continue; // includes rename "old path" continuation entries
        }
        let path = &entry[3..];
        let ext = Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("");
        if matches!(
            ext,
            "rs" | "ts" | "tsx" | "js" | "jsx" | "py" | "go" | "mts" | "cts" | "mjs" | "cjs" | "pyi"
        ) {
            rels.push(path.to_string());
        }
        if rels.len() >= cap {
            break;
        }
    }
    rels
}

/// path → last-commit epoch from the most recent [`GIT_LOG_COMMITS`] commits.
/// First occurrence wins (git log is newest-first). Empty outside a repo.
pub fn git_recency(root: &Path, commits: usize) -> HashMap<String, i64> {
    let Ok(out) = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["log", "--format=%ct", "--name-only", "-n"])
        .arg(commits.to_string())
        .output()
    else {
        return HashMap::new();
    };
    if !out.status.success() {
        return HashMap::new();
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut map = HashMap::new();
    let mut current: i64 = 0;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line.bytes().all(|b| b.is_ascii_digit()) {
            current = line.parse().unwrap_or(0);
        } else if current > 0 {
            map.entry(line.to_string()).or_insert(current);
        }
    }
    map
}

fn mtime_epoch(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Quoted-OR FTS query from free text: alnum/underscore tokens ≥ 2 chars,
/// deduped, capped at [`MAX_QUERY_TOKENS`]. `None` when nothing tokenizes.
fn build_fts_query(query: &str) -> Option<String> {
    let mut seen = HashSet::new();
    let mut tokens: Vec<String> = Vec::new();
    for raw in query.split(|c: char| !(c.is_alphanumeric() || c == '_')) {
        let tok = raw.trim();
        if tok.len() < 2 {
            continue;
        }
        let lower = tok.to_lowercase();
        if seen.insert(lower.clone()) {
            tokens.push(format!("\"{lower}\""));
        }
        if tokens.len() >= MAX_QUERY_TOKENS {
            break;
        }
    }
    if tokens.is_empty() {
        None
    } else {
        Some(tokens.join(" OR "))
    }
}

/// Identifier-ish query tokens (what the IDF bonus considers): contains an
/// underscore, mixed case, or is long enough to be a distinctive name.
pub fn identifier_tokens(query: &str) -> Vec<String> {
    query
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .filter(|t| t.len() >= 4)
        .filter(|t| {
            t.contains('_')
                || (t.chars().any(|c| c.is_uppercase()) && t.chars().any(|c| c.is_lowercase()))
                || t.len() >= 8
        })
        .map(|t| t.to_string())
        .take(6)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_store(tag: &str) -> (PathBuf, LexicalStore) {
        let dir = std::env::temp_dir().join(format!(
            "atlas-lexical-test-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("lexical.sqlite");
        let store = LexicalStore::open_at(&path).unwrap();
        (dir, store)
    }

    fn chunks_for(rel: &str, src: &str) -> Vec<CodeChunk> {
        chunk_source(rel, "rs", src, &[]).chunks
    }

    #[test]
    fn fts5_is_compiled_in_and_ranked_search_works() {
        let (dir, mut store) = tmp_store("basic");
        let src_a = "pub fn verify_jwt_token(claims: &Claims) -> bool { claims.exp > now() }\n";
        let src_b = "pub fn render_sidebar() -> Html { html! { <div/> } }\n";
        store
            .upsert_file("src/auth.rs", "h1", 100, &chunks_for("src/auth.rs", src_a))
            .unwrap();
        store
            .upsert_file("src/ui.rs", "h2", 200, &chunks_for("src/ui.rs", src_b))
            .unwrap();

        let hits = store.search("where do we verify jwt tokens", 5).unwrap();
        assert!(!hits.is_empty(), "tokenized OR query must match");
        assert_eq!(hits[0].rel, "src/auth.rs", "auth chunk ranks first");
        assert!(hits[0].bm25 > 0.0, "bm25 normalized to higher-is-better");
        assert!(hits[0].start_line >= 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn upsert_replaces_and_remove_deletes() {
        let (dir, mut store) = tmp_store("upsert");
        store
            .upsert_file("a.rs", "h1", 0, &chunks_for("a.rs", "pub fn old_name() {}\n"))
            .unwrap();
        assert_eq!(store.search("old_name", 5).unwrap().len(), 1);

        store
            .upsert_file("a.rs", "h2", 0, &chunks_for("a.rs", "pub fn new_name() {}\n"))
            .unwrap();
        assert!(store.search("old_name", 5).unwrap().is_empty(), "old chunks replaced");
        assert_eq!(store.search("new_name", 5).unwrap().len(), 1);

        store.remove_file("a.rs").unwrap();
        assert_eq!(store.chunk_count().unwrap(), 0);
        assert!(store.search("new_name", 5).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn doc_frequency_counts_rare_terms() {
        let (dir, mut store) = tmp_store("idf");
        store
            .upsert_file(
                "a.rs",
                "h1",
                0,
                &chunks_for("a.rs", "pub fn quixotic_zebra() { common(); }\n"),
            )
            .unwrap();
        store
            .upsert_file("b.rs", "h2", 0, &chunks_for("b.rs", "pub fn other() { common(); }\n"))
            .unwrap();
        let (df_rare, total) = store.doc_frequency("quixotic_zebra").unwrap();
        let (df_common, _) = store.doc_frequency("common").unwrap();
        assert_eq!(total, 2);
        assert_eq!(df_rare, 1);
        assert_eq!(df_common, 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn build_is_incremental_and_removes_vanished_files() {
        let dir = std::env::temp_dir().join(format!("atlas-lexbuild-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let project = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("a.rs"), "pub fn alpha_one() {}\n").unwrap();
        std::fs::write(dir.join("b.rs"), "pub fn beta_two() {}\n").unwrap();

        let scanned = crate::scan(&dir, |_| 0);
        let stats = build_lexical(&project, &scanned).unwrap();
        assert_eq!(stats.files_indexed, 2);
        assert_eq!(stats.files_removed, 0);

        // Unchanged rebuild: nothing re-indexed.
        let stats2 = build_lexical(&project, &scanned).unwrap();
        assert_eq!(stats2.files_indexed, 0);
        assert_eq!(stats2.files_unchanged, 2);

        // Drop one file: its chunks must go.
        std::fs::remove_file(dir.join("b.rs")).unwrap();
        let scanned3 = crate::scan(&dir, |_| 0);
        let stats3 = build_lexical(&project, &scanned3).unwrap();
        assert_eq!(stats3.files_removed, 1);
        let store = LexicalStore::open(&project).unwrap();
        assert!(store.search("beta_two", 5).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refresh_picks_up_just_written_code() {
        let dir = std::env::temp_dir().join(format!("atlas-lexfresh-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let project = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("a.rs"), "pub fn before_edit() {}\n").unwrap();
        let scanned = crate::scan(&dir, |_| 0);
        build_lexical(&project, &scanned).unwrap();

        // The agent just wrote new code; the store is stale.
        std::fs::write(dir.join("a.rs"), "pub fn freshly_written_function() {}\n").unwrap();
        let mut store = LexicalStore::open(&project).unwrap();
        assert!(store.search("freshly_written_function", 5).unwrap().is_empty());

        let n = store.refresh_files(&dir, &["a.rs".to_string()]).unwrap();
        assert_eq!(n, 1);
        assert_eq!(store.search("freshly_written_function", 5).unwrap().len(), 1);
        assert!(store.search("before_edit", 5).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hostile_query_cannot_break_fts_syntax() {
        let (dir, store) = tmp_store("hostile");
        for q in ["\"; DROP TABLE chunks; --", "NEAR( OR AND", "*^()\"\"", "   "] {
            let r = store.search(q, 5);
            assert!(r.is_ok(), "query {q:?} must not error: {r:?}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn identifier_tokens_pick_rare_looking_names() {
        let toks = identifier_tokens("where is verify_jwt handled in TokenStore for auth");
        assert!(toks.contains(&"verify_jwt".to_string()));
        assert!(toks.contains(&"TokenStore".to_string()));
        assert!(!toks.contains(&"auth".to_string()), "short plain words excluded");
    }
}
