//! Global, cross-repository memory under `~/.atlas/memory/`.
//!
//! A store that outlives any single repository. It is populated by a
//! **deterministic, conservative promotion rule** over each repository's record
//! store ([`promote_facts`], run by the indexer's `Compact` job), and is blended
//! into retrieval (`MemoryEngine::retrieve`) when a repository's local memory is
//! sparse.
//!
//! ## Promotion rule (deterministic; thresholds are tunable consts)
//!
//! A record entry is promoted to global **only** when it is a Fact, its
//! confidence is ≥ [`PROMOTION_MIN_CONFIDENCE`] (0.8), and the *same content*
//! (the record's normalised content hash) has been seen at that confidence in
//! ≥ [`PROMOTION_MIN_REPOSITORIES`] (2) **distinct repositories** (record-store
//! scope roots, so two worktrees of one repository count once). Everything else
//! stays repository-local.
//!
//! ## Discovering the other repositories
//!
//! Nothing scans the disk. Each repository records its own qualifying Facts
//! under its scope root in the candidates ledger when it is opened; the ledger
//! is what remembers every repository a content hash was seen in, so the second
//! repository to record a Fact is the one that promotes it.
//!
//! ## Layout (`~/.atlas/memory/`)
//!
//! - `MEMORY.md` — the human-readable promoted list, kept **< 200 lines**,
//!   newest-first: `- **[fact]** <content> *(confidence: NN%)*`.
//! - `global-promoted.jsonl` — every promoted memory, one `{"content": …}` line
//!   each in promotion order, never trimmed: what recall searches (with
//!   `MEMORY.md` for promotions made before it existed).
//! - `global-candidates.json` — the candidates ledger: `content_hash ->
//!   { category, max_confidence, project_roots, promoted }`. Promotion is
//!   idempotent: a `content_hash` is promoted exactly once (the `promoted`
//!   flag), re-recording the same `(repository, content)` is a no-op, and a
//!   content `MEMORY.md` already lists is never listed twice.
//!
//! Rows written before the record store (`preference` / `constraint` rows keyed
//! by an older hash) stay in the ledger untouched, and their `MEMORY.md`
//! bullets stay recallable.
//!
//! ## Resolving the global dir
//!
//! We avoid pulling a new `home`/`dirs` dependency: the dir is resolved from the
//! `ATLAS_GLOBAL_MEMORY_DIR` env override first (used by tests so the real
//! `~/.atlas` is never touched), otherwise `$HOME/.atlas/memory`. All public
//! functions have an explicit-`dir` `*_in` sibling so tests can inject a temp dir
//! without racing on the process-global env var.
//!
//! All writes are atomic (temp + rename).

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::record::{self, EntryKind, Origin, RecordStore};

/// Minimum confidence for a Fact to be eligible for global promotion.
pub const PROMOTION_MIN_CONFIDENCE: f64 = 0.8;
/// Number of **distinct repositories** a Fact must appear in before promotion.
pub const PROMOTION_MIN_REPOSITORIES: usize = 2;
/// Hard cap on `MEMORY.md` length (kept strictly under this many lines).
pub const MEMORY_MD_MAX_LINES: usize = 200;
/// Env override for the global memory dir (tests inject a temp dir here).
pub const GLOBAL_DIR_ENV: &str = "ATLAS_GLOBAL_MEMORY_DIR";

/// The ledger category (and `MEMORY.md` label) of a promoted Fact.
const FACT_CATEGORY: &str = "fact";

/// On-disk format: kept byte-for-byte from the pre-record-store list (as is the
/// ledger's `project_roots` field name, which now holds repository roots).
const MEMORY_MD_HEADER: &str = "# Global Memory (promoted, cross-project)";

/// One ledger row, keyed by the content hash.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CandidateEntry {
    /// Category label (`"fact"`; older rows carry `"preference"` / `"constraint"`).
    pub category: String,
    /// Highest confidence seen for this content across all repositories.
    pub max_confidence: f32,
    /// Distinct repository roots this content has been recorded from.
    pub project_roots: BTreeSet<String>,
    /// Whether this content has already been promoted (idempotency guard).
    pub promoted: bool,
}

/// The on-disk candidates ledger (`global-candidates.json`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Ledger {
    /// `content_hash -> CandidateEntry`.
    candidates: BTreeMap<String, CandidateEntry>,
}

/// One qualifying Fact offered for promotion by one repository.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    /// The record's normalised content hash — the Fact's identity across
    /// repositories.
    pub content_hash: String,
    pub content: String,
    pub confidence: f64,
}

/// Resolve the global memory dir: `ATLAS_GLOBAL_MEMORY_DIR` if set, else
/// `$HOME/.atlas/memory` (`%USERPROFILE%` on Windows, where `HOME` is normally
/// unset; falling back to `./.atlas/memory` if neither is set). `.atlas-dev`
/// rather than `.atlas` under the dev profile (`atlas-profile`).
pub fn global_dir() -> PathBuf {
    if let Ok(d) = std::env::var(GLOBAL_DIR_ENV) {
        if !d.is_empty() {
            return PathBuf::from(d);
        }
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    atlas_profile::dir_in(home).join("memory")
}

fn ledger_path(dir: &Path) -> PathBuf {
    dir.join("global-candidates.json")
}

fn memory_md_path(dir: &Path) -> PathBuf {
    dir.join("MEMORY.md")
}

fn promoted_path(dir: &Path) -> PathBuf {
    dir.join("global-promoted.jsonl")
}

/// One line of `global-promoted.jsonl`.
#[derive(Debug, Serialize, Deserialize)]
struct Promoted {
    content: String,
}

fn load_ledger(dir: &Path) -> Ledger {
    std::fs::read(ledger_path(dir))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_ledger(dir: &Path, ledger: &Ledger) -> Result<()> {
    let json = serde_json::to_vec_pretty(ledger).context("serialize global ledger")?;
    write_atomic(&ledger_path(dir), &json)
}

/// Offer one repository's qualifying Facts to the global store, promoting any
/// that now qualify. Resolves the global dir from env/`$HOME` — see
/// [`promote_facts_in`] for the injectable form. Returns the number of Facts
/// **promoted on this call**.
pub fn promote_facts(store: &RecordStore) -> Result<usize> {
    promote_facts_in(&global_dir(), store)
}

/// Injectable-dir form of [`promote_facts`] (tests pass a temp dir).
pub fn promote_facts_in(global_dir: &Path, store: &RecordStore) -> Result<usize> {
    let facts = store.list(EntryKind::Fact, store.count(EntryKind::Fact)?, Origin::Any)?;
    let items: Vec<Candidate> = facts
        .into_iter()
        .filter(|e| e.confidence >= PROMOTION_MIN_CONFIDENCE)
        .map(|e| Candidate {
            content_hash: e.content_hash,
            content: e.content,
            confidence: e.confidence,
        })
        .collect();
    if items.is_empty() {
        return Ok(0);
    }
    record_candidates_in(global_dir, &store.root().to_string_lossy(), &items)
}

/// Record promotion candidates from one repository into the ledger, promoting
/// any whose content hash has now been seen in enough repositories. Items
/// below [`PROMOTION_MIN_CONFIDENCE`] are ignored. Returns the number promoted
/// on this call.
pub fn record_candidates_in(
    global_dir: &Path,
    repository_root: &str,
    items: &[Candidate],
) -> Result<usize> {
    std::fs::create_dir_all(global_dir).context("create global memory dir")?;
    let mut ledger = load_ledger(global_dir);
    let listed: BTreeSet<String> = listed_contents(global_dir)
        .iter()
        .map(|c| record::normalize(c))
        .collect();

    let mut promoted_now = 0usize;
    // (label, content, confidence) bullets to add to MEMORY.md, newest-first.
    let mut md_appends: Vec<(String, String, f32)> = Vec::new();
    let mut promoted: Vec<String> = Vec::new();
    let mut dirty = false;

    for item in items {
        if item.confidence < PROMOTION_MIN_CONFIDENCE {
            continue;
        }
        let confidence = item.confidence as f32;
        let entry = ledger
            .candidates
            .entry(item.content_hash.clone())
            .or_insert_with(|| CandidateEntry {
                category: FACT_CATEGORY.to_string(),
                max_confidence: confidence,
                project_roots: BTreeSet::new(),
                promoted: false,
            });
        if entry.project_roots.insert(repository_root.to_string()) {
            dirty = true;
        }
        if confidence > entry.max_confidence {
            entry.max_confidence = confidence;
            dirty = true;
        }

        if !entry.promoted && entry.project_roots.len() >= PROMOTION_MIN_REPOSITORIES {
            entry.promoted = true;
            promoted_now += 1;
            dirty = true;
            let content = item.content.trim();
            promoted.push(content.to_string());
            if !listed.contains(&record::normalize(content)) {
                md_appends.push((
                    entry.category.clone(),
                    content.to_string(),
                    entry.max_confidence,
                ));
            }
        }
    }

    // The recall archive first: a crash before the ledger save re-promotes
    // (recall dedups), while the reverse order would lose the memory.
    if !promoted.is_empty() {
        append_promoted(global_dir, &promoted)?;
    }
    if dirty {
        save_ledger(global_dir, &ledger)?;
    }
    if !md_appends.is_empty() {
        append_memory_md(global_dir, &md_appends)?;
    }
    Ok(promoted_now)
}

/// Recall over the promoted memories for retrieval blending. Resolves the global
/// dir from env/`$HOME`. Returns `(text, score)` pairs; empty when nothing has
/// been promoted yet (the read path never creates anything).
pub fn global_recall(query: &str, k: usize) -> Vec<(String, f32)> {
    global_recall_in(&global_dir(), query, k)
}

/// Injectable-dir form of [`global_recall`]: the promoted memories whose text
/// contains the whole query (case-sensitive), oldest promotion first, capped
/// at `k`. Every hit contains every query word, so each scores 1.0.
pub fn global_recall_in(global_dir: &Path, query: &str, k: usize) -> Vec<(String, f32)> {
    if k == 0 || query.trim().is_empty() {
        return Vec::new();
    }
    promoted_contents(global_dir)
        .into_iter()
        .filter(|c| c.contains(query))
        .take(k)
        .map(|c| (c, 1.0))
        .collect()
}

/// Every promoted memory, oldest first, each once: the ones `MEMORY.md`
/// lists from before the archive existed, then the archive in order.
fn promoted_contents(dir: &Path) -> Vec<String> {
    let archived: Vec<String> = std::fs::read_to_string(promoted_path(dir))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<Promoted>(l).ok())
        .map(|p| p.content)
        .collect();
    let mut listed = listed_contents(dir);
    listed.reverse();

    let in_archive: BTreeSet<String> = archived.iter().map(|a| record::normalize(a)).collect();
    let mut seen = BTreeSet::new();
    listed
        .into_iter()
        .filter(|c| !in_archive.contains(&record::normalize(c)))
        .chain(archived)
        .filter(|c| seen.insert(record::normalize(c)))
        .collect()
}

/// Append `contents` to the recall archive.
fn append_promoted(dir: &Path, contents: &[String]) -> Result<()> {
    use std::io::Write;
    let mut lines = String::new();
    for content in contents {
        lines.push_str(&serde_json::to_string(&Promoted {
            content: content.clone(),
        })?);
        lines.push('\n');
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(promoted_path(dir))
        .context("open global-promoted.jsonl")?;
    file.write_all(lines.as_bytes())
        .context("append global-promoted.jsonl")
}

/// The contents `MEMORY.md` lists, newest first (empty when there is none).
fn listed_contents(dir: &Path) -> Vec<String> {
    std::fs::read_to_string(memory_md_path(dir))
        .unwrap_or_default()
        .lines()
        .filter_map(bullet_content)
        .collect()
}

/// The content of one `- **[label]** content *(confidence: NN%)*` bullet.
fn bullet_content(line: &str) -> Option<String> {
    let rest = line.trim().strip_prefix("- **[")?;
    let (_, rest) = rest.split_once("]**")?;
    let content = match rest.rsplit_once("*(confidence:") {
        Some((content, _)) => content,
        None => rest,
    };
    let content = content.trim();
    (!content.is_empty()).then(|| content.to_string())
}

/// Append promoted bullets to `MEMORY.md`, newest-first, re-trimming to strictly
/// under [`MEMORY_MD_MAX_LINES`] lines (oldest bullets fall off the bottom).
fn append_memory_md(dir: &Path, appends: &[(String, String, f32)]) -> Result<()> {
    let path = memory_md_path(dir);
    let existing = std::fs::read_to_string(&path).unwrap_or_default();

    // New bullets first (newest-first), then the previously-kept bullets.
    let mut bullets: Vec<String> = Vec::with_capacity(appends.len());
    for (label, content, conf) in appends {
        bullets.push(format!(
            "- **[{}]** {} *(confidence: {:.0}%)*",
            label,
            content.trim(),
            conf * 100.0
        ));
    }
    for line in existing.lines() {
        if line.trim_start().starts_with("- ") {
            bullets.push(line.to_string());
        }
    }

    // Reserve the header + blank line; keep strictly under the cap.
    let max_bullets = MEMORY_MD_MAX_LINES.saturating_sub(3);
    bullets.truncate(max_bullets);

    let mut out = String::with_capacity(bullets.len() * 80 + 64);
    out.push_str(MEMORY_MD_HEADER);
    out.push_str("\n\n");
    for b in &bullets {
        out.push_str(b);
        out.push('\n');
    }
    write_atomic(&path, out.as_bytes())
}

/// Atomic temp + rename write.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, bytes).with_context(|| format!("write tmp {tmp:?}"))?;
    std::fs::rename(&tmp, path).with_context(|| format!("rename {tmp:?} -> {path:?}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record::NewEntry;

    fn tmp_dir(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "atlas-memory-global-{}-{}",
            std::process::id(),
            name
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// A repository's record store holding `facts` as `(content, confidence)`.
    fn repository(base: &Path, name: &str, facts: &[(&str, f64)]) -> RecordStore {
        let root = base.join(name);
        std::fs::create_dir_all(&root).unwrap();
        let store = RecordStore::open(&root).unwrap();
        for (i, (content, confidence)) in facts.iter().enumerate() {
            store
                .upsert(NewEntry {
                    kind: EntryKind::Fact,
                    key: String::new(),
                    content: (*content).to_string(),
                    source: "extractor".into(),
                    agent: "claude".into(),
                    session_id: "s1".into(),
                    confidence: *confidence,
                    at: i as i64 + 1,
                })
                .unwrap();
        }
        store
    }

    fn md(dir: &Path) -> String {
        std::fs::read_to_string(memory_md_path(dir)).unwrap_or_default()
    }

    #[test]
    fn the_same_fact_in_two_repositories_appears_in_global_memory_once() {
        let base = tmp_dir("two-repos");
        let global = base.join("global");
        let a = repository(&base, "a", &[("Always use tabs", 0.9)]);
        let b = repository(&base, "b", &[("always  use tabs", 0.85)]);

        assert_eq!(
            promote_facts_in(&global, &a).unwrap(),
            0,
            "one repository does not promote"
        );
        assert!(!memory_md_path(&global).exists());

        assert_eq!(
            promote_facts_in(&global, &b).unwrap(),
            1,
            "the second repository promotes"
        );
        // Re-running either repository changes nothing.
        assert_eq!(promote_facts_in(&global, &a).unwrap(), 0);
        assert_eq!(promote_facts_in(&global, &b).unwrap(), 0);

        assert_eq!(
            md(&global),
            "# Global Memory (promoted, cross-project)\n\n- **[fact]** always  use tabs *(confidence: 90%)*\n"
        );
        let ledger = load_ledger(&global);
        assert_eq!(ledger.candidates.len(), 1);
        let row = ledger
            .candidates
            .get(&record::content_hash("Always use tabs"))
            .unwrap();
        assert!(row.promoted);
        assert_eq!(row.category, "fact");
        assert_eq!(row.project_roots.len(), 2);

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn a_fact_below_the_floor_or_in_one_repository_is_not_promoted() {
        let base = tmp_dir("not-promoted");
        let global = base.join("global");
        let a = repository(
            &base,
            "a",
            &[("Prefer dark mode", 0.7), ("Only here", 0.95)],
        );
        let b = repository(&base, "b", &[("Prefer dark mode", 0.7)]);

        assert_eq!(promote_facts_in(&global, &a).unwrap(), 0);
        assert_eq!(promote_facts_in(&global, &b).unwrap(), 0);

        assert!(
            !memory_md_path(&global).exists(),
            "nothing promoted, no list"
        );
        let ledger = load_ledger(&global);
        assert_eq!(
            ledger.candidates.len(),
            1,
            "only the qualifying Fact is a candidate"
        );
        assert!(!ledger.candidates[&record::content_hash("Only here")].promoted);

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn two_worktrees_of_one_repository_count_once() {
        let base = tmp_dir("one-scope");
        let global = base.join("global");
        let a = repository(&base, "a", &[("Use RS256", 0.9)]);
        let again = RecordStore::open(a.root()).unwrap();

        promote_facts_in(&global, &a).unwrap();
        assert_eq!(promote_facts_in(&global, &again).unwrap(), 0);

        std::fs::remove_dir_all(&base).ok();
    }

    /// The list and ledger keep the shape they had before the record store
    /// (golden captured from the graph-backed promotion, #89): header, blank
    /// line, `- **[label]** content *(confidence: NN%)*` newest-first; ledger
    /// `{ "candidates": { hash: { category, max_confidence, project_roots,
    /// promoted } } }`.
    #[test]
    fn list_and_ledger_keep_their_shape() {
        let dir = tmp_dir("shape");
        let item = |hash: &str, content: &str, confidence: f64| Candidate {
            content_hash: hash.into(),
            content: content.into(),
            confidence,
        };
        record_candidates_in(&dir, "/proj/a", &[item("h1", "Always use tabs", 0.9)]).unwrap();
        record_candidates_in(&dir, "/proj/b", &[item("h1", "Always use tabs", 0.9)]).unwrap();
        record_candidates_in(&dir, "/proj/b", &[item("h2", "No secrets in logs", 0.85)]).unwrap();
        record_candidates_in(&dir, "/proj/c", &[item("h2", "No secrets in logs", 0.95)]).unwrap();

        assert_eq!(
            md(&dir),
            "# Global Memory (promoted, cross-project)\n\n\
             - **[fact]** No secrets in logs *(confidence: 95%)*\n\
             - **[fact]** Always use tabs *(confidence: 90%)*\n"
        );
        let ledger: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(ledger_path(&dir)).unwrap()).unwrap();
        assert_eq!(
            ledger,
            serde_json::json!({
                "candidates": {
                    "h1": { "category": "fact", "max_confidence": 0.9, "project_roots": ["/proj/a", "/proj/b"], "promoted": true },
                    "h2": { "category": "fact", "max_confidence": 0.95, "project_roots": ["/proj/b", "/proj/c"], "promoted": true }
                }
            })
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A ledger and list written by the graph-backed promotion load as-is; a
    /// Fact whose content is already listed is not listed a second time.
    #[test]
    fn an_already_listed_content_is_not_listed_twice() {
        let dir = tmp_dir("legacy");
        std::fs::write(
            memory_md_path(&dir),
            "# Global Memory (promoted, cross-project)\n\n- **[preference]** Always use tabs *(confidence: 90%)*\n",
        )
        .unwrap();
        std::fs::write(
            ledger_path(&dir),
            r#"{"candidates":{"31d418d04d3727e4":{"category":"preference","max_confidence":0.9,"project_roots":["/proj/a","/proj/b"],"promoted":true}}}"#,
        )
        .unwrap();
        let item = Candidate {
            content_hash: "h1".into(),
            content: "Always use tabs".into(),
            confidence: 0.9,
        };
        record_candidates_in(&dir, "/proj/a", std::slice::from_ref(&item)).unwrap();
        assert_eq!(record_candidates_in(&dir, "/proj/b", &[item]).unwrap(), 1);

        assert_eq!(md(&dir).lines().filter(|l| l.starts_with("- ")).count(), 1);
        assert_eq!(
            load_ledger(&dir).candidates.len(),
            2,
            "the older row is kept"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// MEMORY.md stays < 200 lines after many promotions (oldest trimmed).
    #[test]
    fn memory_md_stays_bounded() {
        let dir = tmp_dir("bounded");
        for i in 0..300 {
            let item = Candidate {
                content_hash: format!("h{i}"),
                content: format!("Constraint number {i} must always hold"),
                confidence: 0.9,
            };
            record_candidates_in(&dir, "/a", std::slice::from_ref(&item)).unwrap();
            assert_eq!(record_candidates_in(&dir, "/b", &[item]).unwrap(), 1);
        }
        let md = md(&dir);
        assert!(md.lines().count() < MEMORY_MD_MAX_LINES);
        assert!(md.contains("Constraint number 299"));
        assert!(!md.contains("Constraint number 0 must"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Every promoted memory stays recallable after MEMORY.md trims it, as
    /// every node of the graph it replaces did.
    #[test]
    fn a_promotion_trimmed_from_the_list_is_still_recalled() {
        let dir = tmp_dir("recall-trimmed");
        for i in 0..250 {
            let item = Candidate {
                content_hash: format!("h{i}"),
                content: format!("Rule number {i} always holds"),
                confidence: 0.9,
            };
            record_candidates_in(&dir, "/a", std::slice::from_ref(&item)).unwrap();
            record_candidates_in(&dir, "/b", &[item]).unwrap();
        }
        assert!(!md(&dir).contains("Rule number 3 always"));
        assert_eq!(
            global_recall_in(&dir, "Rule number 3 always", 5),
            vec![("Rule number 3 always holds".to_string(), 1.0)]
        );
        assert_eq!(
            global_recall_in(&dir, "Rule number", 300).len(),
            250,
            "each once"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn recall_finds_promoted_memories_containing_the_query() {
        let dir = tmp_dir("recall");
        assert!(
            global_recall_in(&dir, "tabs", 5).is_empty(),
            "nothing promoted yet"
        );
        std::fs::write(
            memory_md_path(&dir),
            "# Global Memory (promoted, cross-project)\n\n\
             - **[fact]** Tabs over spaces in Rust *(confidence: 95%)*\n\
             - **[preference]** Always use tabs *(confidence: 90%)*\n\
             - **[fact]** Commit messages are conventional *(confidence: 80%)*\n",
        )
        .unwrap();

        assert_eq!(
            global_recall_in(&dir, "tabs", 5),
            vec![("Always use tabs".to_string(), 1.0)],
            "whole-query, case-sensitive substring, like the graph it replaces"
        );
        assert_eq!(
            global_recall_in(&dir, "s", 1),
            vec![("Commit messages are conventional".to_string(), 1.0)]
        );
        assert!(global_recall_in(&dir, "tabs", 0).is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }
}
