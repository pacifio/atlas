//! Shared fixtures for the crate's tests. Every test module uses these by
//! name: `Project` (a scratch repository), `golden`/`golden_imports` (one
//! line per extracted symbol/import), `dump` and `symbol_set` (index rows).

mod build;
mod docs;
mod e2e;
mod extract_golden;
mod graph;
mod incremental;
mod query;
mod repomap;
mod scan;
mod skip;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use atlas_search::CancelToken;

use crate::{extract, CodeIndex, Lang};

/// A scratch project with an empty `.git/` (so `info/exclude` is honoured),
/// removed on drop.
pub(crate) struct Project {
    dir: tempfile::TempDir,
}

impl Project {
    pub(crate) fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".git").join("info")).unwrap();
        Self { dir }
    }

    pub(crate) fn root(&self) -> &Path {
        self.dir.path()
    }

    pub(crate) fn path(&self, rel: &str) -> PathBuf {
        self.root().join(rel)
    }

    pub(crate) fn write(&self, rel: &str, contents: &str) -> &Self {
        let p = self.path(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, contents).unwrap();
        self
    }

    pub(crate) fn remove(&self, rel: &str) {
        std::fs::remove_file(self.path(rel)).unwrap();
    }

    pub(crate) fn rename(&self, from: &str, to: &str) {
        let to_path = self.path(to);
        std::fs::create_dir_all(to_path.parent().unwrap()).unwrap();
        std::fs::rename(self.path(from), to_path).unwrap();
    }

    pub(crate) fn index(&self) -> CodeIndex {
        CodeIndex::open(self.root()).unwrap()
    }

    /// Open and fully build.
    pub(crate) fn built(&self) -> CodeIndex {
        let ix = self.index();
        ix.full_build(&CancelToken::new(), &|_| {}).unwrap();
        ix
    }
}

/// One line per symbol: `kind qn start-end [pub] [test] ^parent_qn`.
pub(crate) fn golden(rel: &str, src: &str) -> Vec<String> {
    let lang = Lang::from_path(rel).unwrap();
    let ex = extract::extract(
        lang,
        rel,
        src.as_bytes(),
        Instant::now() + Duration::from_secs(30),
    );
    ex.symbols
        .iter()
        .map(|s| {
            let parent = s
                .parent
                .map_or("-", |p| ex.symbols[p].qualified_name.as_str());
            let mut flags = String::new();
            if s.exported {
                flags.push_str(" pub");
            }
            if s.is_test {
                flags.push_str(" test");
            }
            format!(
                "{} {} {}-{}{flags} ^{parent}",
                s.kind, s.qualified_name, s.start_line, s.end_line
            )
        })
        .collect()
}

/// One line per import: `local <- module @line`.
pub(crate) fn golden_imports(rel: &str, src: &str) -> Vec<String> {
    let lang = Lang::from_path(rel).unwrap();
    let ex = extract::extract(
        lang,
        rel,
        src.as_bytes(),
        Instant::now() + Duration::from_secs(30),
    );
    ex.imports
        .iter()
        .map(|i| format!("{} <- {} @{}", i.local_name, i.module_path, i.line))
        .collect()
}

/// Every row that must be identical across two builds of one tree, ids
/// included (timestamps and stat columns excluded).
pub(crate) fn dump(ix: &CodeIndex) -> Vec<String> {
    let mut conn = ix.writer();
    let tx = conn.transaction().unwrap();
    let mut out = Vec::new();
    for (sql, cols) in [
        ("SELECT id, rel, lang, size, hex(hash), parse_partial FROM files ORDER BY id", 6),
        (
            "SELECT id, file_id, parent_id, kind, name, qualified_name, start_line, end_line, start_byte, end_byte, \
             signature, doc, exported, is_test FROM symbols ORDER BY id",
            14,
        ),
        ("SELECT file_id, local_name, module_path, line FROM imports ORDER BY rowid", 4),
    ] {
        let mut stmt = tx.prepare(sql).unwrap();
        let rows = stmt
            .query_map([], |r| {
                (0..cols)
                    .map(|i| r.get::<_, rusqlite::types::Value>(i).map(|v| format!("{v:?}")))
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map(|v| v.join("|"))
            })
            .unwrap();
        out.extend(rows.map(Result::unwrap));
    }
    out
}

/// `rel kind qn start-end` for every symbol: comparable across indexes whose
/// row ids differ (incremental vs fresh).
pub(crate) fn symbol_set(ix: &CodeIndex) -> BTreeSet<String> {
    ix.with_reader(|c| {
        let mut stmt = c.prepare(
            "SELECT f.rel, s.kind, s.qualified_name, s.start_line, s.end_line FROM symbols s JOIN files f ON f.id = s.file_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(format!(
                "{} {} {} {}-{}",
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?
            ))
        })?;
        rows.collect()
    })
    .unwrap()
}
