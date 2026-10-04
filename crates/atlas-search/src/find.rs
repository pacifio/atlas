//! `find_files`: paths by glob (newest first) or fuzzy text (best first).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::{Mutex, PoisonError};
use std::time::UNIX_EPOCH;

use globset::GlobBuilder;
use ignore::WalkState;
use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};

use crate::grep::MAX_LIMIT;
use crate::walk::{self, DenyList, WalkSpec, DEFAULT_DENY_GLOBS};
use crate::{CancelToken, SearchError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FindMode {
    /// Glob if the query has a glob metacharacter (`* ? [ {`), else fuzzy.
    Auto,
    Glob,
    Fuzzy,
}

#[derive(Debug, Clone)]
pub struct FindRequest {
    pub root: PathBuf,
    pub path: Option<PathBuf>,
    pub query: String,
    pub mode: FindMode,
    pub include_dirs: bool,
    pub include_ignored: bool,
    pub limit: usize,
    pub offset: usize,
    pub deny_globs: Vec<String>,
}

impl FindRequest {
    /// An auto-mode request over `root`: 50 paths, files only, default deny list.
    pub fn new(root: impl Into<PathBuf>, query: impl Into<String>) -> Self {
        Self {
            root: root.into(),
            path: None,
            query: query.into(),
            mode: FindMode::Auto,
            include_dirs: false,
            include_ignored: false,
            limit: 50,
            offset: 0,
            deny_globs: DEFAULT_DENY_GLOBS.iter().map(ToString::to_string).collect(),
        }
    }

    /// Whether this request runs as a glob (otherwise fuzzy).
    pub fn is_glob(&self) -> bool {
        match self.mode {
            FindMode::Glob => true,
            FindMode::Fuzzy => false,
            FindMode::Auto => self.query.contains(['*', '?', '[', '{']),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FindResult {
    /// The requested page; directories end in `/`.
    pub paths: Vec<String>,
    /// Matches before paging.
    pub total: usize,
    pub partial: bool,
}

struct Entry {
    rel: String,
    is_dir: bool,
    mtime_ms: i64,
}

/// Find paths under `req.root`. Glob results are newest-modified first; fuzzy
/// results best match first; ties broken by path.
pub fn find_files(req: &FindRequest, cancel: &CancelToken) -> Result<FindResult, SearchError> {
    let (root, start) = walk::resolve(&req.root, req.path.as_deref())?;
    if !start.is_dir() {
        return Err(SearchError::Path(format!(
            "{} is a file; find_files searches a directory",
            walk::rel_path(&root, &start)
        )));
    }
    let deny = DenyList::new(&req.deny_globs)?;
    let glob = if req.is_glob() {
        Some(
            GlobBuilder::new(&req.query)
                .literal_separator(true)
                .build()
                .map_err(|e| SearchError::Glob(format!("{:?}: {e}", req.query)))?
                .compile_matcher(),
        )
    } else {
        None
    };

    let entries = Mutex::new(Vec::<Entry>::new());
    let stopped = AtomicBool::new(false);
    let spec = WalkSpec {
        root: &root,
        start: &start,
        include_ignored: req.include_ignored,
        globs: &[],
        file_type: None,
    };
    walk::parallel_walker(&spec)?.run(|| {
        let (entries, stopped, deny, root) = (&entries, &stopped, &deny, &root);
        Box::new(move |entry| {
            if cancel.is_cancelled() {
                stopped.store(true, Relaxed);
                return WalkState::Quit;
            }
            let Ok(entry) = entry else {
                return WalkState::Continue;
            };
            if entry.depth() == 0 {
                return WalkState::Continue;
            }
            let Some(kind) = entry.file_type() else {
                return WalkState::Continue;
            };
            let is_dir = kind.is_dir();
            if !(kind.is_file() || (is_dir && req.include_dirs)) {
                return WalkState::Continue;
            }
            let rel = walk::rel_path(root, entry.path());
            if !is_dir && deny.denies(&rel) {
                return WalkState::Continue;
            }
            let mtime_ms = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
            entries
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(Entry {
                    rel,
                    is_dir,
                    mtime_ms,
                });
            WalkState::Continue
        })
    });
    let entries = entries.into_inner().unwrap_or_else(PoisonError::into_inner);

    let ranked: Vec<Entry> = match glob {
        Some(glob) => {
            let by_rel = req.query.contains('/');
            let mut hits: Vec<Entry> = entries
                .into_iter()
                .filter(|e| {
                    let name = e.rel.rsplit('/').next().unwrap_or(&e.rel);
                    glob.is_match(if by_rel { e.rel.as_str() } else { name })
                })
                .collect();
            hits.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms).then_with(|| a.rel.cmp(&b.rel)));
            hits
        }
        None => {
            let pattern = Pattern::parse(&req.query, CaseMatching::Smart, Normalization::Smart);
            let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
            let mut buf = Vec::new();
            let mut scored: Vec<(u32, Entry)> = entries
                .into_iter()
                .filter_map(|e| {
                    let score = pattern.score(Utf32Str::new(&e.rel, &mut buf), &mut matcher)?;
                    Some((score, e))
                })
                .collect();
            scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.rel.cmp(&b.1.rel)));
            scored.into_iter().map(|(_, e)| e).collect()
        }
    };

    Ok(FindResult {
        total: ranked.len(),
        paths: ranked
            .into_iter()
            .skip(req.offset)
            .take(req.limit.clamp(1, MAX_LIMIT))
            .map(|e| {
                if e.is_dir {
                    format!("{}/", e.rel)
                } else {
                    e.rel
                }
            })
            .collect(),
        partial: stopped.into_inner(),
    })
}
