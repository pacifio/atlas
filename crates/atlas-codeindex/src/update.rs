//! Writing the index: full build, per-path updates from the watcher, and
//! reconcile (walk + stat compare) after branch switches or missed events.
//!
//! Change detection is two-tier: an unchanged (size, mtime) skips the file;
//! otherwise it is hashed with BLAKE3, and only a changed hash re-parses.
//! A file modified within [`RACY_WINDOW_MS`] of being indexed is always
//! hashed, because a same-size edit inside the filesystem's mtime
//! granularity would otherwise look unchanged ("racy git").

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use atlas_search::CancelToken;
use rusqlite::TransactionBehavior;

use crate::scan::{self, Candidate, Outcome};
use crate::skip::SkipReason;
use crate::store::{self, FileRow, EXTRACTOR_VERSION};
use crate::{CodeIndex, IndexError};

const RACY_WINDOW_MS: i64 = 2000;
/// The last walk's [`scan::config_stamp`].
const META_CONFIG_STAMP: &str = "graph.config_stamp";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuildProgress {
    /// "discover" | "extract" | "write" | "done"
    pub phase: &'static str,
    pub current: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BuildStats {
    pub files: usize,
    pub symbols: usize,
    pub imports: usize,
    /// Files whose tree has parse errors (still indexed).
    pub partial: usize,
    /// Every supported file left out, with why, sorted by path.
    pub skipped: Vec<(String, SkipReason)>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct UpdateStats {
    pub indexed: usize,
    pub unchanged: usize,
    pub removed: usize,
    pub skipped: usize,
}

impl UpdateStats {
    pub fn changed(&self) -> bool {
        self.indexed + self.removed > 0
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IndexStatus {
    pub files: usize,
    pub symbols: usize,
    /// Tier-2 summaries whose content hash still matches.
    pub summaries: usize,
    pub partial_files: usize,
    pub built_at_ms: i64,
    /// Never fully built, or built by another extractor version.
    pub needs_full_build: bool,
    /// Skip counts by reason from the last full build.
    pub skipped: Vec<(String, usize)>,
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// `.atlas/` and `.git/` are never indexed and never trigger work.
fn is_internal(rel: &str) -> bool {
    let first = rel.split('/').next().unwrap_or(rel);
    first == ".atlas" || first == ".git"
}

fn skip_counts(skipped: &[(String, SkipReason)]) -> String {
    let mut counts: std::collections::BTreeMap<&str, usize> = std::collections::BTreeMap::new();
    for (_, r) in skipped {
        *counts.entry(r.label()).or_default() += 1;
    }
    counts
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join(",")
}

impl CodeIndex {
    /// Re-index everything. Rows are renumbered from 1 in path order, so two
    /// builds of one tree are identical. Summaries survive where the content
    /// hash is unchanged. On cancel nothing is written.
    pub fn full_build(
        &self,
        cancel: &CancelToken,
        progress: &dyn Fn(BuildProgress),
    ) -> Result<BuildStats, IndexError> {
        let t0 = Instant::now();
        self.reload_rules();
        let rules = self.rules();
        let root = self.root().to_path_buf();
        progress(BuildProgress {
            phase: "discover",
            current: 0,
            total: 0,
        });
        let (cands, mut skipped, configs) = scan::discover(&root, &root, &rules, cancel);
        if cancel.is_cancelled() {
            return Err(IndexError::Cancelled);
        }
        progress(BuildProgress {
            phase: "extract",
            current: 0,
            total: cands.len(),
        });
        let outcomes = scan::process_all(&cands, &|_| None, cancel);
        if cancel.is_cancelled() {
            return Err(IndexError::Cancelled);
        }
        progress(BuildProgress {
            phase: "write",
            current: 0,
            total: cands.len(),
        });
        let mut stats = BuildStats::default();
        let now = now_ms();
        {
            let mut conn = self.writer();
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let keep = store::load_summaries(&tx)?;
            store::clear_all(&tx)?;
            let mut gb = crate::graph_batch::GraphBatch::full();
            for (c, outcome) in cands.iter().zip(outcomes) {
                match outcome {
                    Outcome::Indexed(rec) => {
                        let id = store::upsert_file(&tx, &rec, None, now)?;
                        gb.after_write(&tx, &rec.rel, &rec.graph)?;
                        if let Some((hash, summary)) = keep.get(&rec.rel) {
                            if hash[..] == rec.hash[..] {
                                store::put_summary_row(&tx, id, hash, summary)?;
                            }
                        }
                        stats.files += 1;
                        stats.symbols += rec.symbols.len();
                        stats.imports += rec.imports.len();
                        stats.partial += usize::from(rec.partial);
                    }
                    Outcome::Skipped(reason) => skipped.push((c.rel.clone(), reason)),
                    Outcome::Cancelled => return Err(IndexError::Cancelled),
                    Outcome::Unchanged { .. } | Outcome::Vanished => {}
                }
            }
            skipped.sort();
            // Resolve imports and references into edges; stores its stats
            // under `graph.last_stats`.
            gb.finish(&tx, &root)?;
            store::set_meta(&tx, "built_at_ms", &now.to_string())?;
            store::set_meta(&tx, "extractor_version", EXTRACTOR_VERSION)?;
            store::set_meta(&tx, META_CONFIG_STAMP, &scan::config_stamp(&configs))?;
            store::set_meta(&tx, "skipped", &skip_counts(&skipped))?;
            tx.commit()?;
        }
        self.bump();
        stats.skipped = skipped;
        stats.elapsed_ms = u64::try_from(t0.elapsed().as_millis()).unwrap_or(u64::MAX);
        progress(BuildProgress {
            phase: "done",
            current: stats.files,
            total: stats.files,
        });
        Ok(stats)
    }

    /// Bring the given paths (absolute or root-relative files or directories,
    /// existing or deleted) up to date. A changed ignore file reconciles.
    pub fn update_paths(&self, changed: &[PathBuf]) -> Result<UpdateStats, IndexError> {
        let mut rels: BTreeSet<String> = BTreeSet::new();
        for p in changed {
            let Some(rel) = self.to_rel(p) else { continue };
            if rel.is_empty() || is_internal(&rel) {
                continue;
            }
            let name = rel.rsplit('/').next().unwrap_or(&rel);
            if matches!(name, ".gitignore" | ".ignore" | ".atlasignore") {
                return self.reconcile(&CancelToken::new());
            }
            rels.insert(rel);
        }
        if rels.is_empty() {
            return Ok(UpdateStats::default());
        }
        let rules = self.rules();
        let chain = self.ignore_chain();
        let root = self.root().to_path_buf();
        let mut stats = UpdateStats::default();
        let mut cands: Vec<Candidate> = Vec::new();
        let mut remove: BTreeSet<String> = BTreeSet::new();
        let mut dirs_gone: Vec<String> = Vec::new();
        for rel in &rels {
            let abs = root.join(rel);
            match std::fs::symlink_metadata(&abs) {
                Err(_) => {
                    remove.insert(rel.clone());
                    dirs_gone.push(rel.clone());
                }
                Ok(md) if md.is_dir() => {
                    let indexed = self.with_writer(|c| store::rels_under(c, rel))?;
                    if chain.is_ignored(rel, true) || rules.prune_dir(rel) {
                        remove.extend(indexed);
                        continue;
                    }
                    let (found, skipped, _) =
                        scan::discover(&root, &abs, &rules, &CancelToken::new());
                    let present: HashSet<&str> = found.iter().map(|c| c.rel.as_str()).collect();
                    remove.extend(
                        indexed
                            .into_iter()
                            .filter(|r| !present.contains(r.as_str())),
                    );
                    stats.skipped += skipped.len();
                    cands.extend(found);
                }
                Ok(md) if md.is_file() => {
                    if chain.is_ignored(rel, false) {
                        remove.insert(rel.clone());
                        continue;
                    }
                    match scan::classify(&root, &abs, &md, &rules) {
                        Some(Ok(c)) => cands.push(c),
                        Some(Err(_)) => {
                            stats.skipped += 1;
                            remove.insert(rel.clone());
                        }
                        None => {
                            remove.insert(rel.clone());
                        }
                    }
                }
                Ok(_) => {
                    remove.insert(rel.clone());
                }
            }
        }
        let wanted: Vec<&str> = cands.iter().map(|c| c.rel.as_str()).collect();
        let rows = self.with_writer(|c| store::file_rows_for(c, &wanted))?;
        let stamp = self.patched_config_stamp(&rels, &chain)?;
        self.apply(cands, remove, &dirs_gone, rows, stats, stamp.as_deref())
    }

    /// The stored config stamp with the lines of the changed config files among `rels`
    /// replaced, so the next reconcile does not resolve the whole graph (and run
    /// `cargo metadata`) a second time for an edit already resolved here. `None` when no
    /// config file changed or no stamp is stored yet. A directory event is left to the
    /// next reconcile's walk.
    fn patched_config_stamp(
        &self,
        rels: &BTreeSet<String>,
        chain: &crate::skip::IgnoreChain,
    ) -> Result<Option<String>, IndexError> {
        let changed: Vec<&str> = rels
            .iter()
            .map(String::as_str)
            .filter(|r| crate::graph_batch::is_config_file(r.rsplit('/').next().unwrap_or(r)))
            .collect();
        if changed.is_empty() {
            return Ok(None);
        }
        let Some(stored) = self.with_writer(|c| store::get_meta(c, META_CONFIG_STAMP))? else {
            return Ok(None);
        };
        let mut lines: BTreeSet<String> = stored
            .lines()
            .filter(|l| !l.is_empty() && !changed.contains(&scan::config_line_rel(l)))
            .map(str::to_string)
            .collect();
        for rel in changed {
            if chain.is_ignored(rel, false) {
                continue;
            }
            if let Ok(md) = std::fs::metadata(self.root().join(rel)) {
                if md.is_file() {
                    lines.insert(scan::config_line(rel, &md));
                }
            }
        }
        Ok(Some(scan::config_stamp(
            &lines.into_iter().collect::<Vec<_>>(),
        )))
    }

    /// Walk the tree and compare with the index: new and changed files are
    /// indexed, files gone (or newly ignored) are removed. Used after a branch
    /// switch, an ignore-file edit, a watcher overflow, and on open.
    pub fn reconcile(&self, cancel: &CancelToken) -> Result<UpdateStats, IndexError> {
        self.reload_rules();
        let rules = self.rules();
        let root = self.root().to_path_buf();
        let (cands, skipped, configs) = scan::discover(&root, &root, &rules, cancel);
        if cancel.is_cancelled() {
            return Err(IndexError::Cancelled);
        }
        let stamp = scan::config_stamp(&configs);
        let rows = self.with_writer(store::load_file_rows)?;
        let present: HashSet<&str> = cands.iter().map(|c| c.rel.as_str()).collect();
        let remove: BTreeSet<String> = rows
            .keys()
            .filter(|r| !present.contains(r.as_str()))
            .cloned()
            .collect();
        let stats = UpdateStats {
            skipped: skipped.len(),
            ..UpdateStats::default()
        };
        // Config files are not indexed, so only this stamp tells a reconcile
        // that one changed (an edit while Atlas was closed, or one whose
        // watcher path a queued reconcile absorbed).
        self.apply(cands, remove, &[], rows, stats, Some(&stamp))
    }

    /// Stat-gate, hash, extract and write `cands`; delete `remove` and
    /// everything under `dirs_gone`; all in one transaction. A
    /// `config_stamp` unlike the stored one resolves the whole graph.
    fn apply(
        &self,
        cands: Vec<Candidate>,
        mut remove: BTreeSet<String>,
        dirs_gone: &[String],
        rows: HashMap<String, FileRow>,
        mut stats: UpdateStats,
        config_stamp: Option<&str>,
    ) -> Result<UpdateStats, IndexError> {
        let mut work: Vec<Candidate> = Vec::new();
        let mut known: Vec<Option<Vec<u8>>> = Vec::new();
        for c in cands {
            remove.remove(&c.rel);
            match rows.get(&c.rel) {
                Some(r)
                    if r.size == c.size
                        && r.mtime_ns == c.mtime_ns
                        && c.mtime_ns / 1_000_000 < r.indexed_at_ms - RACY_WINDOW_MS =>
                {
                    stats.unchanged += 1;
                }
                r => {
                    known.push(r.map(|r| r.hash.clone()));
                    work.push(c);
                }
            }
        }
        let outcomes = scan::process_all(&work, &|i| known[i].clone(), &CancelToken::new());
        let now = now_ms();
        let mut changed_any = false;
        {
            let mut conn = self.writer();
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let mut gb = crate::graph_batch::GraphBatch::incremental();
            // `remove` also carries changed paths the index does not hold (a
            // `Cargo.toml`, a `tsconfig.json`): a config file among them
            // forces a full resolve.
            let noted: Vec<PathBuf> = work
                .iter()
                .map(|c| c.abs.clone())
                .chain(remove.iter().map(PathBuf::from))
                .collect();
            gb.note_paths(&noted);
            if let Some(stamp) = config_stamp {
                if store::get_meta(&tx, META_CONFIG_STAMP)?.as_deref() != Some(stamp) {
                    gb.note_config_change();
                    changed_any = true;
                    store::set_meta(&tx, META_CONFIG_STAMP, stamp)?;
                }
            }
            for (c, outcome) in work.iter().zip(outcomes) {
                let existing = rows.get(&c.rel).map(|r| r.id);
                match outcome {
                    Outcome::Indexed(rec) => {
                        if existing.is_some() {
                            gb.before_change(&tx, &rec.rel)?;
                        }
                        store::upsert_file(&tx, &rec, existing, now)?;
                        gb.after_write(&tx, &rec.rel, &rec.graph)?;
                        stats.indexed += 1;
                    }
                    Outcome::Unchanged { size, mtime_ns } => {
                        if let Some(id) = existing {
                            store::touch_file(&tx, id, size, mtime_ns, now)?;
                        }
                        stats.unchanged += 1;
                    }
                    Outcome::Skipped(_) | Outcome::Vanished => {
                        if matches!(outcome, Outcome::Skipped(_)) {
                            stats.skipped += 1;
                        }
                        if let Some(id) = existing {
                            gb.before_change(&tx, &c.rel)?;
                            store::delete_file(&tx, id)?;
                            gb.after_delete(&c.rel);
                            stats.removed += 1;
                        }
                    }
                    Outcome::Cancelled => {}
                }
            }
            for rel in &remove {
                if let Some(id) = store::file_id(&tx, rel)? {
                    gb.before_change(&tx, rel)?;
                    store::delete_file(&tx, id)?;
                    gb.after_delete(rel);
                    stats.removed += 1;
                }
            }
            for dir in dirs_gone {
                for rel in store::rels_under(&tx, dir)? {
                    if let Some(id) = store::file_id(&tx, &rel)? {
                        gb.before_change(&tx, &rel)?;
                        store::delete_file(&tx, id)?;
                        gb.after_delete(&rel);
                        stats.removed += 1;
                    }
                }
            }
            gb.finish(&tx, self.root())?;
            changed_any |= stats.changed();
            tx.commit()?;
        }
        if changed_any {
            self.bump();
        }
        Ok(stats)
    }

    /// Counts and freshness, cheap enough for a status pill.
    pub fn status(&self) -> Result<IndexStatus, IndexError> {
        self.with_reader(|c| {
            let count = |sql: &str| -> rusqlite::Result<usize> {
                c.query_row(sql, [], |r| r.get::<_, i64>(0)).map(|n| usize::try_from(n).unwrap_or(0))
            };
            let built_at_ms = store::get_meta(c, "built_at_ms")?.and_then(|v| v.parse().ok());
            let extractor = store::get_meta(c, "extractor_version")?;
            let skipped = store::get_meta(c, "skipped")?
                .unwrap_or_default()
                .split(',')
                .filter_map(|kv| kv.split_once('='))
                .map(|(k, v)| (k.to_string(), v.parse().unwrap_or(0)))
                .collect();
            Ok(IndexStatus {
                files: count("SELECT count(*) FROM files")?,
                symbols: count("SELECT count(*) FROM symbols")?,
                summaries: count(
                    "SELECT count(*) FROM file_summaries s JOIN files f ON f.id = s.file_id AND f.hash = s.content_hash",
                )?,
                partial_files: count("SELECT count(*) FROM files WHERE parse_partial = 1")?,
                built_at_ms: built_at_ms.unwrap_or(0),
                needs_full_build: built_at_ms.is_none() || extractor.as_deref() != Some(EXTRACTOR_VERSION),
                skipped,
            })
        })
    }

    /// `p` as a `/`-separated path relative to the root, if it is under it.
    /// `..` never leaves the root.
    pub(crate) fn to_rel(&self, p: &Path) -> Option<String> {
        let rel = if p.is_relative() {
            p
        } else {
            self.roots().iter().find_map(|r| p.strip_prefix(r).ok())?
        };
        rel.components()
            .all(|c| {
                matches!(
                    c,
                    std::path::Component::Normal(_) | std::path::Component::CurDir
                )
            })
            .then(|| scan::rel_string(rel))
    }
}
