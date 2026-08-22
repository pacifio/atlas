//! Step 9b — global, cross-project memory under `~/.atlas/memory/`.
//!
//! A global store that outlives any single project. It is populated by a
//! **deterministic, conservative promotion rule** driven from the per-project
//! Step-9a consolidation pass (`consolidate`), and is optionally blended into
//! retrieval (`MemoryEngine::retrieve`) when a project's local memory is sparse.
//!
//! ## Promotion rule (deterministic; thresholds are tunable consts)
//!
//! A memory is promoted to global **only** when it is a `UserPreference` or a
//! `Constraint` (label `"preference"` / `"constraint"`), its confidence is
//! ≥ [`PROMOTION_MIN_CONFIDENCE`] (0.8), and the *same content* has appeared in
//! ≥ [`PROMOTION_MIN_PROJECTS`] (2) **distinct project roots**. Everything else
//! stays project-local.
//!
//! ## Layout (`~/.atlas/memory/`)
//!
//! - `global-graph/` — a [`GraphMemory`] holding the promoted memories.
//! - `MEMORY.md` — the human-readable promoted list, kept **< 200 lines**,
//!   newest-first.
//! - `global-candidates.json` — the candidates ledger: `content_hash ->
//!   { category, max_confidence, project_roots, promoted }`. Promotion is
//!   idempotent: a `content_hash` is promoted exactly once (the `promoted`
//!   flag), and re-recording the same `(project_root, content)` is a no-op.
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

use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeSet, HashMap};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::graph::GraphMemory;
use crate::graph::MemoryType;

/// Minimum confidence for a memory to be eligible for global promotion.
pub const PROMOTION_MIN_CONFIDENCE: f32 = 0.8;
/// Number of **distinct project roots** a memory must appear in before promotion.
pub const PROMOTION_MIN_PROJECTS: usize = 2;
/// Hard cap on `MEMORY.md` length (kept strictly under this many lines).
pub const MEMORY_MD_MAX_LINES: usize = 200;
/// Env override for the global memory dir (tests inject a temp dir here).
pub const GLOBAL_DIR_ENV: &str = "ATLAS_GLOBAL_MEMORY_DIR";

/// Category labels (per `MemoryCategory::label()`) eligible for promotion.
const QUALIFYING_LABELS: [&str; 2] = ["preference", "constraint"];

const MEMORY_MD_HEADER: &str = "# Global Memory (promoted, cross-project)";

/// One ledger row, keyed by the content hash.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CandidateEntry {
    /// Qualifying category label (`"preference"` or `"constraint"`).
    pub category: String,
    /// Highest confidence seen for this content across all projects.
    pub max_confidence: f32,
    /// Distinct project roots this content has been recorded from.
    pub project_roots: BTreeSet<String>,
    /// Whether this content has already been promoted (idempotency guard).
    pub promoted: bool,
}

/// The on-disk candidates ledger (`global-candidates.json`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Ledger {
    /// `content_hash -> CandidateEntry`.
    candidates: HashMap<String, CandidateEntry>,
}

/// Resolve the global memory dir: `ATLAS_GLOBAL_MEMORY_DIR` if set, else
/// `$HOME/.atlas/memory` (falling back to `./.atlas/memory` if `$HOME` is unset).
pub fn global_dir() -> PathBuf {
    if let Ok(d) = std::env::var(GLOBAL_DIR_ENV) {
        if !d.is_empty() {
            return PathBuf::from(d);
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".atlas").join("memory")
}

fn ledger_path(dir: &Path) -> PathBuf {
    dir.join("global-candidates.json")
}

fn global_graph_path(dir: &Path) -> PathBuf {
    dir.join("global-graph")
}

fn memory_md_path(dir: &Path) -> PathBuf {
    dir.join("MEMORY.md")
}

/// Deterministic, process-independent content hash (`DefaultHasher` uses fixed
/// keys, so the digest is stable across runs — adequate for ledger dedup).
fn content_hash(content: &str) -> String {
    let mut h = DefaultHasher::new();
    content.trim().hash(&mut h);
    format!("{:016x}", h.finish())
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

/// Map a qualifying label onto the graph's coarse [`MemoryType`] (mirrors
/// `extract::category_to_memory_type`: preference→User, constraint→Project).
fn label_to_memory_type(label: &str) -> MemoryType {
    match label {
        "preference" => MemoryType::User,
        _ => MemoryType::Project, // "constraint"
    }
}

fn open_global_graph(dir: &Path) -> Result<GraphMemory> {
    std::fs::create_dir_all(dir).context("create global memory dir")?;
    GraphMemory::open(&global_graph_path(dir))
        .map_err(|e| anyhow::anyhow!("open global graph: {e}"))
}

/// Record promotion candidates from one project into the global ledger, promoting
/// any that now qualify. Resolves the global dir from env/`$HOME` — see
/// [`record_candidates_in`] for the injectable form.
///
/// `items` is `(content, category_label, confidence)`; non-qualifying items
/// (wrong category or confidence < [`PROMOTION_MIN_CONFIDENCE`]) are ignored.
/// Returns the number of memories **promoted on this call**.
pub fn record_candidates(project_root: &str, items: &[(String, String, f32)]) -> Result<usize> {
    record_candidates_in(&global_dir(), project_root, items)
}

/// Injectable-dir form of [`record_candidates`] (tests pass a temp dir).
pub fn record_candidates_in(
    global_dir: &Path,
    project_root: &str,
    items: &[(String, String, f32)],
) -> Result<usize> {
    std::fs::create_dir_all(global_dir).context("create global memory dir")?;
    let mut ledger = load_ledger(global_dir);

    let mut promoted_now = 0usize;
    let mut graph: Option<GraphMemory> = None;
    // (label, content, confidence) bullets to append to MEMORY.md, newest-first.
    let mut md_appends: Vec<(String, String, f32)> = Vec::new();
    let mut dirty = false;

    for (content, category, confidence) in items {
        let label = category.trim().to_lowercase();
        if !QUALIFYING_LABELS.contains(&label.as_str()) {
            continue;
        }
        if *confidence < PROMOTION_MIN_CONFIDENCE {
            continue;
        }

        let hash = content_hash(content);
        let entry = ledger.candidates.entry(hash).or_insert_with(|| CandidateEntry {
            category: label.clone(),
            max_confidence: *confidence,
            project_roots: BTreeSet::new(),
            promoted: false,
        });
        let newly_added = entry.project_roots.insert(project_root.to_string());
        if *confidence > entry.max_confidence {
            entry.max_confidence = *confidence;
            dirty = true;
        }
        if newly_added {
            dirty = true;
        }

        if !entry.promoted && entry.project_roots.len() >= PROMOTION_MIN_PROJECTS {
            if graph.is_none() {
                graph = Some(open_global_graph(global_dir)?);
            }
            let g = graph.as_ref().expect("global graph opened");
            let mem_type = label_to_memory_type(&entry.category);
            match g.store_memory(content.trim(), mem_type, entry.max_confidence) {
                Ok(id) => {
                    if let Err(e) = g.tag_memory(&id, &entry.category) {
                        tracing::debug!(target: "atlas_memory::global", "tag_memory failed: {e}");
                    }
                }
                Err(e) => {
                    tracing::warn!(target: "atlas_memory::global", "store_memory failed: {e}");
                    // Leave promoted=false so a later pass retries; skip MEMORY.md.
                    continue;
                }
            }
            entry.promoted = true;
            promoted_now += 1;
            dirty = true;
            md_appends.push((entry.category.clone(), content.trim().to_string(), entry.max_confidence));
        }
    }

    if dirty {
        save_ledger(global_dir, &ledger)?;
    }
    if !md_appends.is_empty() {
        append_memory_md(global_dir, &md_appends)?;
    }
    Ok(promoted_now)
}

/// Semantic-ish recall over the global graph for retrieval blending. Resolves the
/// global dir from env/`$HOME`. Returns `(text, score)` pairs (empty when the
/// global graph does not yet exist — never creates it on the read path).
pub fn global_recall(query: &str, k: usize) -> Vec<(String, f32)> {
    global_recall_in(&global_dir(), query, k)
}

/// Injectable-dir form of [`global_recall`].
pub fn global_recall_in(global_dir: &Path, query: &str, k: usize) -> Vec<(String, f32)> {
    if k == 0 {
        return Vec::new();
    }
    // Never create the global graph from the read path.
    if !global_graph_path(global_dir).exists() {
        return Vec::new();
    }
    match GraphMemory::open(&global_graph_path(global_dir)) {
        Ok(g) => g.recall_top_k(query, k),
        Err(e) => {
            tracing::debug!(target: "atlas_memory::global", "global graph open failed: {e}");
            Vec::new()
        }
    }
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

    fn tmp_dir(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("atlas-memory-global-{}-{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn item(content: &str, label: &str, conf: f32) -> (String, String, f32) {
        (content.to_string(), label.to_string(), conf)
    }

    /// One project does not promote; the SAME content from a SECOND distinct
    /// project promotes — graph has it, MEMORY.md bullet added, ledger promoted.
    #[test]
    fn second_distinct_project_promotes() {
        let dir = tmp_dir("promote");

        let n0 = record_candidates_in(&dir, "/proj/a", &[item("Always use tabs", "preference", 0.9)])
            .unwrap();
        assert_eq!(n0, 0, "one project must not promote");

        let l0 = load_ledger(&dir);
        let e0 = l0.candidates.get(&content_hash("Always use tabs")).unwrap();
        assert!(!e0.promoted);
        assert_eq!(e0.project_roots.len(), 1);
        // No graph created yet, and no MEMORY.md.
        assert!(!global_graph_path(&dir).exists());
        assert!(!memory_md_path(&dir).exists());

        let n1 = record_candidates_in(&dir, "/proj/b", &[item("Always use tabs", "preference", 0.9)])
            .unwrap();
        assert_eq!(n1, 1, "second distinct project promotes");

        // Ledger flips to promoted with two project roots.
        let l1 = load_ledger(&dir);
        let e1 = l1.candidates.get(&content_hash("Always use tabs")).unwrap();
        assert!(e1.promoted);
        assert_eq!(e1.project_roots.len(), 2);

        // Global graph now holds it.
        let recalled = global_recall_in(&dir, "Always use tabs", 5);
        assert!(
            recalled.iter().any(|(t, _)| t.contains("Always use tabs")),
            "promoted memory must be recallable from the global graph"
        );

        // MEMORY.md bullet written.
        let md = std::fs::read_to_string(memory_md_path(&dir)).unwrap();
        assert!(md.contains("Always use tabs"));
        assert!(md.contains("[preference]"));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Non-qualifying category or confidence < 0.8 never promotes, even across
    /// multiple projects.
    #[test]
    fn non_qualifying_never_promotes() {
        let dir = tmp_dir("nonqual");

        // Wrong category (project fact) in two projects.
        assert_eq!(
            record_candidates_in(&dir, "/a", &[item("REST API uses JSON", "project", 0.95)]).unwrap(),
            0
        );
        assert_eq!(
            record_candidates_in(&dir, "/b", &[item("REST API uses JSON", "project", 0.95)]).unwrap(),
            0
        );

        // Right category but below the confidence floor, in two projects.
        assert_eq!(
            record_candidates_in(&dir, "/a", &[item("Prefer dark mode", "preference", 0.7)]).unwrap(),
            0
        );
        assert_eq!(
            record_candidates_in(&dir, "/b", &[item("Prefer dark mode", "preference", 0.7)]).unwrap(),
            0
        );

        // Nothing promoted → no graph, no MEMORY.md, ledger has no qualifying rows.
        assert!(!global_graph_path(&dir).exists());
        assert!(!memory_md_path(&dir).exists());
        let l = load_ledger(&dir);
        assert!(l.candidates.is_empty(), "non-qualifying items never enter the ledger");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// MEMORY.md stays < 200 lines after many promotions (oldest trimmed).
    #[test]
    fn memory_md_stays_bounded() {
        let dir = tmp_dir("bounded");

        for i in 0..300 {
            let content = format!("Constraint number {i} must always hold");
            // Two distinct projects → promotes on the second.
            record_candidates_in(&dir, "/a", &[item(&content, "constraint", 0.9)]).unwrap();
            let n = record_candidates_in(&dir, "/b", &[item(&content, "constraint", 0.9)]).unwrap();
            assert_eq!(n, 1, "each distinct content promotes once on the 2nd project");
        }

        let md = std::fs::read_to_string(memory_md_path(&dir)).unwrap();
        let lines = md.lines().count();
        assert!(lines < MEMORY_MD_MAX_LINES, "MEMORY.md has {lines} lines, must be < 200");
        // Newest content is retained; oldest fell off.
        assert!(md.contains("Constraint number 299"));
        assert!(!md.contains("Constraint number 0 must"));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Re-running with identical inputs does not double-promote (ledger dedup +
    /// promoted flag), and MEMORY.md is unchanged.
    #[test]
    fn idempotent_no_double_promote() {
        let dir = tmp_dir("idempotent");

        record_candidates_in(&dir, "/a", &[item("No secrets in logs", "constraint", 0.85)]).unwrap();
        let first = record_candidates_in(&dir, "/b", &[item("No secrets in logs", "constraint", 0.85)])
            .unwrap();
        assert_eq!(first, 1);
        let md_after_first = std::fs::read_to_string(memory_md_path(&dir)).unwrap();

        // Re-run the exact same (project, content) pairs several times.
        for _ in 0..3 {
            assert_eq!(
                record_candidates_in(&dir, "/a", &[item("No secrets in logs", "constraint", 0.85)])
                    .unwrap(),
                0
            );
            assert_eq!(
                record_candidates_in(&dir, "/b", &[item("No secrets in logs", "constraint", 0.85)])
                    .unwrap(),
                0
            );
        }

        // MEMORY.md unchanged (no duplicate bullets).
        let md_now = std::fs::read_to_string(memory_md_path(&dir)).unwrap();
        assert_eq!(md_now, md_after_first, "no duplicate promotion bullets");
        let bullet_count = md_now.lines().filter(|l| l.starts_with("- ")).count();
        assert_eq!(bullet_count, 1, "exactly one promoted bullet");

        std::fs::remove_dir_all(&dir).ok();
    }
}
