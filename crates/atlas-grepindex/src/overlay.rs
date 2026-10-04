//! Working-tree documents that differ from the base snapshot, and the stamps that let the
//! index vouch for a file without reading it.

use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime};

use atlas_search::FileStamp;

use crate::doc::{classify, MAX_INDEXED_BYTES};
use crate::exec::eval_keys;
use crate::gram::doc_keys;
use crate::plan::Query;

/// A stamp is trusted only when the file's mtime was at least this old when it was observed.
/// A younger file could be rewritten within the file system's timestamp granularity (2 s on
/// FAT, a jiffy on Linux) with the same size, and the stamp would not change.
pub const RACY_WINDOW: Duration = Duration::from_secs(2);

/// The file's stamp, or `None` when it is too fresh to trust (see [`RACY_WINDOW`]).
pub fn trusted_stamp(meta: &fs::Metadata, observed_at: SystemTime) -> Option<FileStamp> {
    let age = observed_at.duration_since(meta.modified().ok()?).ok()?;
    if age < RACY_WINDOW {
        return None;
    }
    FileStamp::from_metadata(meta)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OverlayKind {
    /// Gone, or not a regular file.
    Deleted,
    /// Present but unindexable: always a candidate.
    Forced,
    /// Sorted, deduplicated gram keys of the content.
    Grams(Vec<u32>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverlayDoc {
    /// `None` = never vouch for this file without reading it.
    pub stamp: Option<FileStamp>,
    pub bytes: u64,
    pub kind: OverlayKind,
}

impl OverlayDoc {
    /// Reads the file now. The stamp is taken before the read, so a write racing the read
    /// leaves a stamp that no longer matches, and the file is searched.
    pub fn load(abs: &Path) -> OverlayDoc {
        let deleted = OverlayDoc {
            stamp: None,
            bytes: 0,
            kind: OverlayKind::Deleted,
        };
        let meta = match fs::symlink_metadata(abs) {
            Ok(m) if m.is_file() => m,
            _ => return deleted,
        };
        if meta.len() > MAX_INDEXED_BYTES {
            let stamp = trusted_stamp(&meta, SystemTime::now());
            return OverlayDoc {
                stamp,
                bytes: 0,
                kind: OverlayKind::Forced,
            };
        }
        let Ok(content) = fs::read(abs) else {
            return deleted;
        };
        let stamp = if content.len() as u64 == meta.len() {
            trusted_stamp(&meta, SystemTime::now())
        } else {
            None
        };
        let kind = match classify(&content) {
            Ok(()) => OverlayKind::Grams(doc_keys(&content)),
            Err(_) => OverlayKind::Forced,
        };
        OverlayDoc {
            stamp,
            bytes: content.len() as u64,
            kind,
        }
    }

    pub fn matches(&self, q: &Query) -> bool {
        match &self.kind {
            OverlayKind::Deleted => false,
            OverlayKind::Forced => true,
            OverlayKind::Grams(keys) => eval_keys(q, keys),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn fresh_files_are_not_trusted() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.rs");
        fs::write(&p, "fn fresh_symbol() {}\n").unwrap();
        let doc = OverlayDoc::load(&p);
        assert_eq!(doc.stamp, None);
        assert!(doc.matches(&crate::plan::plan_pattern("fresh_symbol", false, None).unwrap()));
        let old = SystemTime::now() - Duration::from_secs(60);
        fs::File::options()
            .write(true)
            .open(&p)
            .unwrap()
            .set_modified(old)
            .unwrap();
        let doc = OverlayDoc::load(&p);
        assert_eq!(
            doc.stamp,
            FileStamp::from_metadata(&fs::metadata(&p).unwrap())
        );
    }

    #[test]
    fn missing_binary_and_large_files() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            OverlayDoc::load(&dir.path().join("nope")).kind,
            OverlayKind::Deleted
        );
        let bin = dir.path().join("b.bin");
        fs::write(&bin, b"needle\0rest").unwrap();
        assert_eq!(OverlayDoc::load(&bin).kind, OverlayKind::Forced);
        let big = dir.path().join("big.txt");
        fs::write(&big, vec![b'\n'; MAX_INDEXED_BYTES as usize + 1]).unwrap();
        assert_eq!(OverlayDoc::load(&big).kind, OverlayKind::Forced);
        assert!(OverlayDoc::load(&big).matches(&Query::Nothing));
    }
}
