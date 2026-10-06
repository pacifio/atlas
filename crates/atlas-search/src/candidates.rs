//! Prefilter hook for [`grep`](crate::grep) (Phase 5).
//!
//! An index (`atlas-grepindex`) implements [`CandidateSource`]. `grep` asks it once per request
//! for a [`CandidateFilter`]; then, for every file the normal walk yields, the file is skipped
//! unread when the filter proves it cannot match. The walk itself is untouched, so ignore rules,
//! globs, file types, hidden files, deny globs and the size cap behave exactly as without an
//! index, and every file the filter keeps is still verified by the real matcher.

use std::fs::Metadata;
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use crate::{CancelToken, GrepRequest};

/// What an index compares to decide a file is unchanged since it read it. An index
/// vouches for a file only while every field still matches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct FileStamp {
    pub size: u64,
    pub mtime_ns: i64,
    /// Status-change time, which no user tool can set (`cp -p`, `rsync -t` and
    /// `touch -r` restore mtime only).
    pub ctime_ns: i64,
    /// The inode, which an atomic save (temp file renamed over) changes.
    pub inode: u64,
}

impl FileStamp {
    /// `None` off Unix: std exposes no change time or file id there, so no
    /// stamp could tell a same-size rewrite that restores mtime, and an index
    /// must never vouch for a file.
    pub fn from_metadata(meta: &Metadata) -> Option<FileStamp> {
        if !cfg!(unix) {
            return None;
        }
        let since_epoch = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
        let (ctime_ns, inode) = change_time_and_inode(meta);
        Some(FileStamp {
            size: meta.len(),
            mtime_ns: i64::try_from(since_epoch.as_nanos()).ok()?,
            ctime_ns,
            inode,
        })
    }
}

#[cfg(unix)]
fn change_time_and_inode(meta: &Metadata) -> (i64, u64) {
    use std::os::unix::fs::MetadataExt;
    (
        meta.ctime()
            .saturating_mul(1_000_000_000)
            .saturating_add(meta.ctime_nsec()),
        meta.ino(),
    )
}

#[cfg(not(unix))]
fn change_time_and_inode(_meta: &Metadata) -> (i64, u64) {
    unreachable!("FileStamp::from_metadata returns None before asking")
}

/// Per-request answer from a [`CandidateSource`].
pub trait CandidateFilter: Send + Sync {
    /// `rel` is relative to [`GrepRequest::root`] and `/`-separated (the same string
    /// [`FileHit::rel`](crate::FileHit) carries). `stamp` stats the file; call it only when the
    /// answer depends on it. Return `false` only when the file provably cannot contain a match.
    fn must_search(&self, rel: &str, stamp: &dyn Fn() -> Option<FileStamp>) -> bool;
}

/// A prefilter consulted by [`grep`](crate::grep) when [`GrepRequest::candidates`] is set.
pub trait CandidateSource: Send + Sync + std::fmt::Debug {
    /// Called once per request, before the walk. `None` means "no opinion": every walked file
    /// is searched, exactly as without a source.
    fn candidates(
        &self,
        req: &GrepRequest,
        cancel: &CancelToken,
    ) -> Option<Arc<dyn CandidateFilter>>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grep;
    use std::path::Path;
    use std::sync::Mutex;

    fn req(
        root: &Path,
        pattern: &str,
        candidates: Option<Arc<dyn CandidateSource>>,
    ) -> GrepRequest {
        GrepRequest {
            candidates,
            limit: Some(10_000),
            deny_globs: Vec::new(),
            ..GrepRequest::new(root, pattern)
        }
    }

    type Seen = Arc<Mutex<Vec<(String, Option<FileStamp>)>>>;

    /// Keeps only `keep`; records every stamp it is shown.
    #[derive(Debug)]
    struct Only {
        keep: &'static str,
        seen: Seen,
    }
    impl CandidateFilter for Only {
        fn must_search(&self, rel: &str, stamp: &dyn Fn() -> Option<FileStamp>) -> bool {
            self.seen.lock().unwrap().push((rel.to_string(), stamp()));
            rel == self.keep
        }
    }
    #[derive(Debug)]
    struct Source(Option<&'static str>, Seen);
    impl CandidateSource for Source {
        fn candidates(&self, _: &GrepRequest, _: &CancelToken) -> Option<Arc<dyn CandidateFilter>> {
            let keep = self.0?;
            Some(Arc::new(Only {
                keep,
                seen: Arc::clone(&self.1),
            }))
        }
    }

    fn two_files() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "needle\n").unwrap();
        std::fs::write(dir.path().join("b.txt"), "needle\n").unwrap();
        dir
    }

    #[test]
    fn filter_skips_files_it_rules_out() {
        let dir = two_files();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let src: Arc<dyn CandidateSource> = Arc::new(Source(Some("a.txt"), Arc::clone(&seen)));
        let res = grep(&req(dir.path(), "needle", Some(src)), &CancelToken::new()).unwrap();
        let rels: Vec<&str> = res.files.iter().map(|f| f.rel.as_str()).collect();
        assert_eq!(rels, vec!["a.txt"]);
        assert_eq!(res.skipped_by_index, 1);
    }

    #[test]
    fn no_filter_searches_everything() {
        let dir = two_files();
        let src: Arc<dyn CandidateSource> =
            Arc::new(Source(None, Arc::new(Mutex::new(Vec::new()))));
        let res = grep(&req(dir.path(), "needle", Some(src)), &CancelToken::new()).unwrap();
        assert_eq!(res.files.len(), 2);
        assert_eq!(res.skipped_by_index, 0);
    }

    #[cfg(unix)]
    #[test]
    fn stamp_is_the_files_metadata() {
        let dir = two_files();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let src: Arc<dyn CandidateSource> = Arc::new(Source(Some("a.txt"), Arc::clone(&seen)));
        grep(&req(dir.path(), "needle", Some(src)), &CancelToken::new()).unwrap();
        let expected =
            FileStamp::from_metadata(&std::fs::metadata(dir.path().join("b.txt")).unwrap());
        let seen = seen.lock().unwrap();
        let b = seen.iter().find(|(rel, _)| rel == "b.txt").unwrap();
        assert_eq!(b.1, expected);
        assert!(expected.is_some());
    }
}
