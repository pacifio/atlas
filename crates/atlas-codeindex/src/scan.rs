//! Discovery and parallel extraction.
//!
//! Discovery walks in parallel (`ignore::WalkParallel`), then SORTS the paths:
//! row ids are assigned in path order, so two builds of one tree produce
//! identical rows. Extraction runs largest-file-first on a dedicated rayon
//! pool (each worker reuses one parser per grammar), and results are put
//! back in path order before anything is written.

use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, UNIX_EPOCH};

use atlas_search::CancelToken;
use ignore::{WalkBuilder, WalkState};
use rayon::prelude::*;

use crate::extract;
use crate::lang::Lang;
use crate::skip::{self, Rules, SkipReason, MAX_FILE_BYTES};
use crate::store::FileRecord;

/// Wall-clock budget for parsing one file before it is recorded as partial.
pub(crate) const PARSE_BUDGET: Duration = Duration::from_secs(3);

/// A file the walk kept, with its stat.
#[derive(Debug, Clone)]
pub(crate) struct Candidate {
    pub rel: String,
    pub abs: PathBuf,
    pub lang: Lang,
    pub size: u64,
    pub mtime_ns: i64,
}

/// What processing one candidate produced.
#[derive(Debug)]
pub(crate) enum Outcome {
    Indexed(Box<FileRecord>),
    /// Content hash equals the stored one: only the stat moved.
    Unchanged {
        size: u64,
        mtime_ns: i64,
    },
    Skipped(SkipReason),
    /// Gone between discovery and read.
    Vanished,
    Cancelled,
}

/// `a/b/c.rs` regardless of platform separator.
pub(crate) fn rel_string(rel: &Path) -> String {
    rel.components()
        .filter(|c| !matches!(c, std::path::Component::CurDir))
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

pub(crate) fn mtime_ns(md: &std::fs::Metadata) -> i64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| i64::try_from(d.as_nanos()).unwrap_or(i64::MAX))
}

/// Directories a walk pruned, with the skip reason their files report.
type Pruned = Arc<Mutex<Vec<(PathBuf, SkipReason)>>>;

/// Gitignore-respecting walk settings shared by every walk the index does.
pub(crate) fn walker(dir: &Path, root: &Path, rules: Arc<Rules>) -> WalkBuilder {
    walker_noting(dir, root, rules, None)
}

fn base_walker(dir: &Path) -> WalkBuilder {
    let mut b = WalkBuilder::new(dir);
    b.hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .require_git(false)
        .follow_links(false);
    b
}

/// [`walker`], noting each directory it prunes in `pruned` (when given).
fn walker_noting(
    dir: &Path,
    root: &Path,
    rules: Arc<Rules>,
    pruned: Option<Pruned>,
) -> WalkBuilder {
    let mut b = base_walker(dir);
    let root = root.to_path_buf();
    b.filter_entry(move |e| {
        if !e.file_type().is_some_and(|t| t.is_dir()) || e.depth() == 0 {
            return true;
        }
        let Ok(rel) = e.path().strip_prefix(&root) else {
            return true;
        };
        let rel = rel_string(rel);
        if !rules.prune_dir(&rel) {
            return true;
        }
        if let (Some(pruned), Some(reason)) = (&pruned, rules.prune_reason(&rel)) {
            pruned
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push((e.path().to_path_buf(), reason));
        }
        false
    });
    b
}

/// Every source file under the pruned directories, with its directory's
/// reason. Pruning saves reading and parsing them, not knowing they exist:
/// without these the index would look complete while missing a whole tree.
/// Only names are looked at (no stat, no read); gitignore still applies.
fn pruned_files(
    root: &Path,
    pruned: Vec<(PathBuf, SkipReason)>,
    cancel: &CancelToken,
) -> Vec<(String, SkipReason)> {
    let Some(((first, _), rest)) = pruned.split_first() else {
        return Vec::new();
    };
    let mut b = base_walker(first);
    for (dir, _) in rest {
        b.add(dir);
    }
    b.filter_entry(|e| {
        e.depth() == 0
            || !e.file_type().is_some_and(|t| t.is_dir())
            || e.file_name().to_str().is_none_or(skip::counted_dir)
    });
    let (tx, rx) = mpsc::channel::<(String, SkipReason)>();
    let pruned = Arc::new(pruned);
    b.build_parallel().run(|| {
        let tx = tx.clone();
        let pruned = pruned.clone();
        let cancel = cancel.clone();
        let root = root.to_path_buf();
        Box::new(move |entry| {
            if cancel.is_cancelled() {
                return WalkState::Quit;
            }
            let Ok(entry) = entry else {
                return WalkState::Continue;
            };
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                return WalkState::Continue;
            }
            let path = entry.path();
            let Ok(rel) = path.strip_prefix(&root).map(rel_string) else {
                return WalkState::Continue;
            };
            if Lang::from_path(&rel).is_none() {
                return WalkState::Continue;
            }
            // The deepest pruned directory holding it (they never nest, but
            // a walk root given twice must not double-count).
            if let Some((_, reason)) = pruned
                .iter()
                .filter(|(d, _)| path.starts_with(d))
                .max_by_key(|(d, _)| d.as_os_str().len())
            {
                let _ = tx.send((rel, *reason));
            }
            WalkState::Continue
        })
    });
    drop(tx);
    let mut out: Vec<_> = rx.into_iter().collect();
    out.sort();
    out.dedup();
    out
}

/// Classify one walked or watched file by path and stat.
pub(crate) fn classify(
    root: &Path,
    abs: &Path,
    md: &std::fs::Metadata,
    rules: &Rules,
) -> Option<Result<Candidate, (String, SkipReason)>> {
    let rel = rel_string(abs.strip_prefix(root).ok()?);
    let lang = Lang::from_path(&rel)?;
    if let Some(reason) = rules.path_verdict(&rel) {
        return Some(Err((rel, reason)));
    }
    if md.len() > MAX_FILE_BYTES {
        return Some(Err((rel, SkipReason::TooLarge)));
    }
    Some(Ok(Candidate {
        rel,
        abs: abs.to_path_buf(),
        lang,
        size: md.len(),
        mtime_ns: mtime_ns(md),
    }))
}

/// What a walk saw that is not a source file to index: one it skipped, or a
/// graph config file (`Cargo.toml`, `tsconfig.json`, …) as a
/// `rel size mtime_ns` stamp.
enum Seen {
    File(Result<Candidate, (String, SkipReason)>),
    Config(String),
}

/// The indexable files under `dir`, sorted by path; every source file
/// skipped and why (by path, size, or under a pruned directory); and a stamp
/// of every graph config file met on the way (see [`config_stamp`]).
pub(crate) fn discover(
    root: &Path,
    dir: &Path,
    rules: &Arc<Rules>,
    cancel: &CancelToken,
) -> (Vec<Candidate>, Vec<(String, SkipReason)>, Vec<String>) {
    let (tx, rx) = mpsc::channel::<Seen>();
    let pruned: Pruned = Arc::default();
    walker_noting(dir, root, rules.clone(), Some(pruned.clone()))
        .build_parallel()
        .run(|| {
            let tx = tx.clone();
            let rules = rules.clone();
            let cancel = cancel.clone();
            Box::new(move |entry| {
                if cancel.is_cancelled() {
                    return WalkState::Quit;
                }
                let Ok(entry) = entry else {
                    return WalkState::Continue;
                };
                if !entry.file_type().is_some_and(|t| t.is_file()) {
                    return WalkState::Continue;
                }
                let Ok(md) = entry.metadata() else {
                    return WalkState::Continue;
                };
                let is_config = entry
                    .file_name()
                    .to_str()
                    .is_some_and(crate::graph_batch::is_config_file);
                if is_config {
                    if let Ok(rel) = entry.path().strip_prefix(root) {
                        let _ = tx.send(Seen::Config(config_line(&rel_string(rel), &md)));
                    }
                }
                if let Some(found) = classify(root, entry.path(), &md, &rules) {
                    let _ = tx.send(Seen::File(found));
                }
                WalkState::Continue
            })
        });
    drop(tx);
    let mut kept = Vec::new();
    let pruned = std::mem::take(
        &mut *pruned
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
    );
    let mut skipped = pruned_files(root, pruned, cancel);
    let mut configs = Vec::new();
    for seen in rx {
        match seen {
            Seen::File(Ok(c)) => kept.push(c),
            Seen::File(Err(s)) => skipped.push(s),
            Seen::Config(stamp) => configs.push(stamp),
        }
    }
    kept.sort_by(|a, b| a.rel.cmp(&b.rel));
    skipped.sort();
    configs.sort();
    (kept, skipped, configs)
}

/// A graph config file's line in the config stamp: `rel size mtime_ns`.
pub(crate) fn config_line(rel: &str, md: &std::fs::Metadata) -> String {
    format!("{rel} {} {}", md.len(), mtime_ns(md))
}

/// The `rel` of a [`config_line`].
pub(crate) fn config_line_rel(line: &str) -> &str {
    line.rsplitn(3, ' ').nth(2).unwrap_or("")
}

/// One value for a walk's sorted config lines: it changes when any graph config
/// file is added, removed or edited. The lines themselves, so a watcher-reported
/// edit can replace just its own (see `CodeIndex::update_paths`).
pub(crate) fn config_stamp(configs: &[String]) -> String {
    configs.join("\n")
}

/// Read, sniff, hash and (unless the hash matches `known`) extract one file.
pub(crate) fn process(c: &Candidate, known: Option<&[u8]>) -> Outcome {
    let Ok(bytes) = std::fs::read(&c.abs) else {
        return Outcome::Vanished;
    };
    if let Some(reason) = skip::sniff(&bytes) {
        return Outcome::Skipped(reason);
    }
    let hash = *blake3::hash(&bytes).as_bytes();
    let size = bytes.len() as u64;
    if known == Some(&hash[..]) {
        return Outcome::Unchanged {
            size,
            mtime_ns: c.mtime_ns,
        };
    }
    let ex = extract::extract(c.lang, &c.rel, &bytes, Instant::now() + PARSE_BUDGET);
    if ex.timed_out {
        return Outcome::Skipped(SkipReason::ParseTimeout);
    }
    Outcome::Indexed(Box::new(FileRecord {
        rel: c.rel.clone(),
        lang: c.lang.label(),
        size,
        mtime_ns: c.mtime_ns,
        hash,
        partial: ex.partial,
        symbols: ex.symbols,
        imports: ex.imports,
        graph: ex.graph,
        chunks: ex.chunks,
        // The bytes extraction read: chunk bodies are cut from this text, so
        // an edit landing in between can never mismatch a chunk's hash.
        text: String::from_utf8_lossy(&bytes).into_owned(),
    }))
}

fn pool() -> Option<&'static rayon::ThreadPool> {
    static POOL: OnceLock<Option<rayon::ThreadPool>> = OnceLock::new();
    POOL.get_or_init(|| {
        // Leave a core for the UI.
        let n = std::thread::available_parallelism()
            .map_or(2, std::num::NonZeroUsize::get)
            .saturating_sub(1)
            .max(1);
        rayon::ThreadPoolBuilder::new()
            .num_threads(n)
            .thread_name(|i| format!("atlas-codeindex-{i}"))
            .build()
            .ok()
    })
    .as_ref()
}

/// Process `cands` in parallel, largest first; results come back in input
/// (path) order. `known(i)` is the stored hash for candidate `i`, if any.
pub(crate) fn process_all(
    cands: &[Candidate],
    known: &(dyn Fn(usize) -> Option<Vec<u8>> + Sync),
    cancel: &CancelToken,
) -> Vec<Outcome> {
    let mut order: Vec<usize> = (0..cands.len()).collect();
    order.sort_by(|&a, &b| cands[b].size.cmp(&cands[a].size).then(a.cmp(&b)));
    let run = || {
        order
            .par_iter()
            .with_max_len(1)
            .map(|&i| {
                if cancel.is_cancelled() {
                    return (i, Outcome::Cancelled);
                }
                (i, process(&cands[i], known(i).as_deref()))
            })
            .collect::<Vec<_>>()
    };
    let mut done = match pool() {
        Some(p) => p.install(run),
        None => run(),
    };
    done.sort_by_key(|(i, _)| *i);
    done.into_iter().map(|(_, o)| o).collect()
}
