//! Step 9a — idle-time memory consolidation + our own prune.
//!
//! [`consolidate`] runs the AutoDream "Orient → Gather → Consolidate → Prune"
//! cadence for one project, off the hot path (the indexer's `Compact` job calls
//! it). We use Cersei's [`AutoDream`] for the **gates + lock + state ONLY**
//! (Step 0 confirmed it ships no consolidation logic) and implement the prune
//! ourselves.
//!
//! ## Why the prune operates on the memdir, not the graph
//!
//! Step 0 verified two hard limits in the Cersei SDK that shape this design:
//!
//! 1. **`GraphMemory` exposes no delete** — there is no `remove`/`delete` on the
//!    public API, and the inner `GrafeoDB` is private, so we cannot drop nodes.
//! 2. **`GraphMemory` queries return only `m.content`** — `by_type`/`recall`/
//!    `recall_top_k` hand back bare content strings with **no id, confidence, or
//!    timestamp**, so we cannot even *read* a node's confidence to decide what to
//!    prune, and Grafeo's decay/`revalidate_memory` are no-ops.
//!
//! So a graph-node prune is impossible through the SDK. The data that *does*
//! carry confidence + recency is the `extracted/*.md` memdir we write in Step 7
//! (`cersei_agent::session_memory::persist_memories` renders each fact as
//! `- **[<cat>]** <content> *(confidence: NN%)*` under `### Session memories —
//! <date>` headers). That memdir is exactly the AutoDream "Prune" target ("keep
//! the memory dir bounded"), so [`prune_memdir`] is our prune: it drops entries
//! below a confidence floor, caps the total retained (newest-first), and rewrites
//! the files. Recency is computed by us from the date headers — we never rely on
//! Grafeo decay.
//!
//! **Documented limitation:** stale graph *nodes* are left in place (no delete
//! API). That is acceptable because Step 6 keeps the graph as the down-weighted
//! *secondary* recall contributor (substring/word-overlap only), never able to
//! outrank an embedding hit — and the authoritative recall corpus is the HNSW
//! index, which re-embeds from the memdir we just pruned.
//!
//! ## Conversations dir
//!
//! [`AutoDream::new`] wants a `conversations_dir` whose `*.jsonl` files the
//! session-gate counts. `atlas-memory` is a LOW crate that only knows the project
//! root, and Atlas keeps no reliably-derivable per-project `*.jsonl` session
//! folder here, so we point it at the engine's **memory dir** itself (the plan
//! explicitly permits "the memory dir if none"). The session-gate is therefore
//! conservative — today nothing drops `*.jsonl` into the memory dir, so
//! consolidation is governed primarily by the 24h time-gate and stays a safe
//! near-no-op until session transcripts land there. The lock + prune logic is
//! fully implemented and exercised by tests through a forced-gate path.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use crate::dream::AutoDream;
use crate::graph::GraphMemory;

use crate::MemoryEngine;

/// Drop extracted memories whose confidence is below this floor (50%).
pub const CONFIDENCE_FLOOR: f32 = 0.5;
/// Hard cap on retained extracted memories across all session files. Mirrors the
/// memdir's own 200-file cap (`cersei_memory::memdir::MAX_MEMORY_FILES`).
pub const MAX_RETAINED: usize = 200;

/// What one [`consolidate`] call did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsolidateOutcome {
    /// Gates not met (not enough time/sessions since the last run) — nothing ran.
    Skipped,
    /// Another consolidation holds a fresh lock — skipped to avoid a double-run.
    Locked,
    /// Ran: dropped `pruned` extracted memories, kept `kept`.
    Consolidated { pruned: usize, kept: usize },
}

/// Releases the AutoDream lock on every exit path (incl. `?`-propagated errors).
struct LockGuard<'a>(&'a AutoDream);

impl Drop for LockGuard<'_> {
    fn drop(&mut self) {
        if let Err(e) = self.0.release_lock() {
            tracing::warn!(target: "atlas_memory::consolidate", "release_lock failed: {e}");
        }
    }
}

/// Idle-time consolidation for one project's memory, gated + locked by AutoDream.
///
/// - Gates via `AutoDream` (time ≥24h **and** ≥5 new session jsonls); a failed
///   gate returns [`ConsolidateOutcome::Skipped`] without touching anything.
/// - A fresh lock held by a concurrent run returns [`ConsolidateOutcome::Locked`].
/// - Otherwise acquires the lock (released on every path by [`LockGuard`]), prunes
///   the memdir, records `update_state`, and returns the counts.
pub fn consolidate(engine: &mut MemoryEngine) -> Result<ConsolidateOutcome> {
    let memory_dir = engine.memory_dir().to_path_buf();
    // See module docs: the memory dir doubles as the (conservative) conversations
    // dir for the session gate.
    let dream = AutoDream::new(memory_dir.clone(), memory_dir.clone());

    let state = dream.load_state();
    // Cheapest-first gates, minus the lock (we distinguish Skipped vs Locked).
    if !(dream.time_gate_passes(&state) && dream.session_gate_passes(&state)) {
        return Ok(ConsolidateOutcome::Skipped);
    }
    if !dream.lock_gate_passes() {
        return Ok(ConsolidateOutcome::Locked);
    }

    dream.acquire_lock().context("acquire consolidation lock")?;
    let _guard = LockGuard(&dream);

    let (pruned, kept) = prune_memdir(&memory_dir)?;

    // Step 9b: feed qualifying high-confidence preferences/constraints to the
    // global cross-project promotion ledger. Idempotent (the ledger dedups by
    // content hash + a `promoted` flag), and best-effort — a global write failure
    // must never fail this project's consolidation.
    record_global_candidates(engine);

    // Read-only graph signal for logging. The SDK exposes no delete and no
    // per-node confidence, so graph nodes themselves are not pruned (module docs).
    let graph_nodes = count_graph_nodes(engine.graph());
    tracing::info!(
        target: "atlas_memory::consolidate",
        pruned, kept, graph_nodes,
        "consolidated project memdir"
    );

    dream.update_state().context("update consolidation state")?;
    Ok(ConsolidateOutcome::Consolidated { pruned, kept })
}

/// Promote this project's qualifying extracted memories into the global
/// cross-project store (Step 9b). Reads the (already-pruned) `extracted/*.md`
/// memdir, filters to the qualifying preference/constraint bullets at confidence
/// ≥ [`crate::global::PROMOTION_MIN_CONFIDENCE`], and records them under this
/// project's root. Best-effort: any error is logged, never propagated.
fn record_global_candidates(engine: &MemoryEngine) {
    let items = collect_global_candidates(engine.memory_dir());
    if items.is_empty() {
        return;
    }
    let project_root = engine.project_root.to_string_lossy();
    match crate::global::record_candidates(&project_root, &items) {
        Ok(promoted) if promoted > 0 => {
            tracing::info!(target: "atlas_memory::consolidate", promoted, "promoted memories to global store");
        }
        Ok(_) => {}
        Err(e) => {
            tracing::warn!(target: "atlas_memory::consolidate", "global promotion failed: {e}");
        }
    }
}

/// Parse the memdir and return `(content, label, confidence)` for every entry
/// that qualifies for global promotion (preference/constraint at confidence
/// ≥ the global floor). The ≥0.8 floor sits above the prune's 0.5 floor, so these
/// always survive [`prune_memdir`] and reflect the on-disk survivors.
fn collect_global_candidates(memory_dir: &Path) -> Vec<(String, String, f32)> {
    let extracted = memory_dir.join("extracted");
    if !extracted.is_dir() {
        return Vec::new();
    }
    let mut paths: Vec<PathBuf> = match std::fs::read_dir(&extracted) {
        Ok(rd) => rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("md"))
            .collect(),
        Err(_) => return Vec::new(),
    };
    paths.sort();

    let mut out = Vec::new();
    for path in paths {
        let body = std::fs::read_to_string(&path).unwrap_or_default();
        for e in parse_entries(&body) {
            let label = e.category.to_lowercase();
            let qualifies = (label == "preference" || label == "constraint")
                && e.confidence >= crate::global::PROMOTION_MIN_CONFIDENCE;
            if qualifies {
                out.push((e.content, label, e.confidence));
            }
        }
    }
    out
}

/// Count current graph memories across all four `MemoryType`s (read-only; the
/// graph has no delete API, so this is a signal only — see module docs).
fn count_graph_nodes(graph: &GraphMemory) -> usize {
    use crate::graph::MemoryType::*;
    [User, Feedback, Project, Reference]
        .iter()
        .map(|t| graph.by_type(*t).len())
        .sum()
}

/// One parsed extracted-memory bullet from an `extracted/*.md` file.
#[derive(Debug, Clone, PartialEq)]
struct RawEntry {
    /// `### Session memories — <date>` the bullet sat under (lexicographically
    /// sortable `YYYY-MM-DD`; `"0000-00-00"` when no header preceded it).
    date: String,
    /// Category label (`preference`/`project`/`pattern`/`decision`/`constraint`).
    category: String,
    /// The fact text.
    content: String,
    /// Confidence in `[0, 1]` (parsed from the `*(confidence: NN%)*` suffix).
    confidence: f32,
}

/// Prune every `extracted/*.md` file under `memory_dir`: drop sub-floor entries,
/// cap the global total (newest-first), and rewrite the files. Returns
/// `(pruned, kept)`. A missing `extracted/` dir is a clean `(0, 0)`.
fn prune_memdir(memory_dir: &Path) -> Result<(usize, usize)> {
    let extracted = memory_dir.join("extracted");
    if !extracted.is_dir() {
        return Ok((0, 0));
    }

    // (path, parsed entries) per file, in a stable (sorted) order.
    let mut files: Vec<(PathBuf, Vec<RawEntry>)> = Vec::new();
    let mut paths: Vec<PathBuf> = std::fs::read_dir(&extracted)
        .with_context(|| format!("read extracted dir {extracted:?}"))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("md"))
        .collect();
    paths.sort();
    for path in paths {
        let body = std::fs::read_to_string(&path).unwrap_or_default();
        files.push((path, parse_entries(&body)));
    }

    let total: usize = files.iter().map(|(_, e)| e.len()).sum();
    let mut per_file: Vec<Vec<RawEntry>> = files.iter().map(|(_, e)| e.clone()).collect();
    let kept = apply_floor_and_cap(&mut per_file, CONFIDENCE_FLOOR, MAX_RETAINED);
    let pruned = total - kept;

    if pruned == 0 {
        return Ok((0, total)); // nothing dropped → leave files untouched
    }

    // Rewrite each file with its survivors (or delete it if none remain).
    for ((path, _), survivors) in files.iter().zip(per_file.into_iter()) {
        if survivors.is_empty() {
            let _ = std::fs::remove_file(path);
            continue;
        }
        write_atomic(path, &render_entries(&survivors))?;
    }

    Ok((pruned, kept))
}

/// In place: drop entries below `floor`, then if more than `cap` survive globally,
/// keep the `cap` newest (date desc, confidence desc tie-break). Returns the kept
/// count.
fn apply_floor_and_cap(per_file: &mut [Vec<RawEntry>], floor: f32, cap: usize) -> usize {
    // 1. Confidence floor (per file).
    for entries in per_file.iter_mut() {
        entries.retain(|e| e.confidence >= floor);
    }

    let surviving: usize = per_file.iter().map(|e| e.len()).sum();
    if surviving <= cap {
        return surviving;
    }

    // 2. Global cap: rank all survivors, keep the top `cap`, drop the rest.
    // Build (file_idx, entry_idx, date, confidence) keys we can sort then re-apply.
    let mut keys: Vec<(usize, usize, String, f32)> = Vec::with_capacity(surviving);
    for (fi, entries) in per_file.iter().enumerate() {
        for (ei, e) in entries.iter().enumerate() {
            keys.push((fi, ei, e.date.clone(), e.confidence));
        }
    }
    // Newest first; confidence breaks date ties.
    keys.sort_by(|a, b| b.2.cmp(&a.2).then(b.3.partial_cmp(&a.3).unwrap_or(std::cmp::Ordering::Equal)));

    // Mark which (file, entry) indices to keep.
    let mut keep: Vec<Vec<bool>> = per_file.iter().map(|e| vec![false; e.len()]).collect();
    for (fi, ei, _, _) in keys.into_iter().take(cap) {
        keep[fi][ei] = true;
    }
    for (fi, entries) in per_file.iter_mut().enumerate() {
        let flags = &keep[fi];
        let mut i = 0;
        entries.retain(|_| {
            let k = flags[i];
            i += 1;
            k
        });
    }

    per_file.iter().map(|e| e.len()).sum()
}

/// Parse the `- **[cat]** content *(confidence: NN%)*` bullets out of one memdir
/// file, tracking the most recent `### Session memories — <date>` header.
fn parse_entries(body: &str) -> Vec<RawEntry> {
    let mut date = "0000-00-00".to_string();
    let mut out = Vec::new();
    for line in body.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("### Session memories") {
            // Header form: `### Session memories — <date>`. Take the trailing token.
            if let Some((_, d)) = rest.rsplit_once(char::is_whitespace) {
                let d = d.trim();
                if !d.is_empty() {
                    date = d.to_string();
                }
            }
            continue;
        }
        if let Some(entry) = parse_bullet(trimmed, &date) {
            out.push(entry);
        }
    }
    out
}

/// Parse a single `- **[cat]** content *(confidence: NN%)*` line, else `None`.
fn parse_bullet(line: &str, date: &str) -> Option<RawEntry> {
    let rest = line.strip_prefix("- **[")?;
    let (category, rest) = rest.split_once("]**")?;
    // Confidence suffix is optional-but-expected; default to 0 so a malformed
    // line is treated as low-confidence (prunable) rather than silently kept.
    let (content, confidence) = match rest.rsplit_once("*(confidence:") {
        Some((content, conf)) => {
            let pct = conf.trim().trim_end_matches(")*").trim().trim_end_matches('%').trim();
            let confidence = pct.parse::<f32>().ok().map(|p| p / 100.0).unwrap_or(0.0);
            (content, confidence)
        }
        None => (rest, 0.0),
    };
    let content = content.trim().to_string();
    if content.is_empty() {
        return None;
    }
    Some(RawEntry {
        date: date.to_string(),
        category: category.trim().to_string(),
        content,
        confidence: confidence.clamp(0.0, 1.0),
    })
}

/// Render kept entries back into the `persist_memories` file format, grouped by
/// date header in first-seen order so future Step-7 appends stay compatible.
fn render_entries(entries: &[RawEntry]) -> String {
    let mut out = String::from("## Auto-extracted memories\n");
    let mut seen_dates: Vec<&str> = Vec::new();
    for e in entries {
        if !seen_dates.contains(&e.date.as_str()) {
            seen_dates.push(&e.date);
            out.push_str(&format!("\n### Session memories — {}\n", e.date));
        }
        out.push_str(&format!(
            "- **[{}]** {} *(confidence: {:.0}%)*\n",
            e.category,
            e.content,
            e.confidence * 100.0
        ));
    }
    out
}

/// Atomic temp+rename write (matches the docstore/manifest discipline).
fn write_atomic(path: &Path, contents: &str) -> Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, contents.as_bytes()).with_context(|| format!("write tmp {tmp:?}"))?;
    std::fs::rename(&tmp, path).with_context(|| format!("rename {tmp:?} -> {path:?}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::MemoryType;

    fn tmp_root(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("atlas-memory-consolidate-{}-{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// Drop `n` dummy `*.jsonl` into the memory dir so AutoDream's session-gate
    /// (≥5) passes — the memory dir is also the conversations dir (see module docs).
    fn force_session_gate(memory_dir: &Path) {
        std::fs::create_dir_all(memory_dir).unwrap();
        for i in 0..6 {
            std::fs::write(memory_dir.join(format!("sess-{i}.jsonl")), "{}").unwrap();
        }
    }

    fn write_extracted(memory_dir: &Path, file: &str, body: &str) {
        let dir = memory_dir.join("extracted");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(file), body).unwrap();
    }

    /// Gate respected: a fresh engine with no session jsonls skips (not due).
    #[test]
    fn skips_when_not_due() {
        let root = tmp_root("not-due");
        let mut engine = MemoryEngine::open(root.clone());
        // No *.jsonl in the memory dir → session gate fails.
        let outcome = consolidate(&mut engine).unwrap();
        assert_eq!(outcome, ConsolidateOutcome::Skipped);
        std::fs::remove_dir_all(&root).ok();
    }

    /// A fresh lock held by a "concurrent" run makes a second call return Locked,
    /// not run twice. (Gates are forced to pass so we exercise the lock branch.)
    #[test]
    fn lock_prevents_concurrent_run() {
        let root = tmp_root("locked");
        let mut engine = MemoryEngine::open(root.clone());
        let memory_dir = engine.memory_dir().to_path_buf();
        force_session_gate(&memory_dir);

        // Simulate another consolidation already holding the lock.
        let other = AutoDream::new(memory_dir.clone(), memory_dir.clone());
        other.acquire_lock().unwrap();

        let outcome = consolidate(&mut engine).unwrap();
        assert_eq!(outcome, ConsolidateOutcome::Locked);

        // The held lock is untouched by the skipped run.
        assert!(!other.lock_gate_passes());
        other.release_lock().unwrap();
        std::fs::remove_dir_all(&root).ok();
    }

    /// Prune drops below-floor entries and keeps above-floor ones; the memdir file
    /// is rewritten accordingly. Synthetic graph nodes are left intact (no delete
    /// API) — asserted to document the limitation.
    #[test]
    fn prune_drops_below_floor_keeps_above() {
        let root = tmp_root("prune");
        // This path reaches `Consolidated`, which fires Step-9b global promotion.
        // Redirect the global store at a temp dir so the test never touches the
        // real `~/.atlas/memory` (the global.rs tests use the explicit-dir form).
        std::env::set_var(
            crate::global::GLOBAL_DIR_ENV,
            root.join("global-memory-override"),
        );
        let mut engine = MemoryEngine::open(root.clone());
        let memory_dir = engine.memory_dir().to_path_buf();
        force_session_gate(&memory_dir);

        // Synthetic graph nodes (open_in_memory-style graph inside the engine).
        engine
            .graph()
            .store_memory("kept project fact", MemoryType::Project, 0.9)
            .unwrap();
        engine
            .graph()
            .store_memory("a user preference", MemoryType::User, 0.8)
            .unwrap();
        let graph_before = count_graph_nodes(engine.graph());
        assert_eq!(graph_before, 2);

        // Three above-floor, two below-floor.
        write_extracted(
            &memory_dir,
            "sess-a.md",
            "## Auto-extracted memories\n\n\
             ### Session memories — 2026-06-01\n\
             - **[preference]** keeps me, high conf *(confidence: 90%)*\n\
             - **[project]** also kept *(confidence: 60%)*\n\
             - **[decision]** dropped, too low *(confidence: 30%)*\n",
        );
        write_extracted(
            &memory_dir,
            "sess-b.md",
            "## Auto-extracted memories\n\n\
             ### Session memories — 2026-06-02\n\
             - **[constraint]** kept at the floor *(confidence: 50%)*\n\
             - **[pattern]** dropped, below floor *(confidence: 10%)*\n",
        );

        let outcome = consolidate(&mut engine).unwrap();
        assert_eq!(
            outcome,
            ConsolidateOutcome::Consolidated { pruned: 2, kept: 3 }
        );

        // File rewritten: above-floor content survives, below-floor is gone.
        let a = std::fs::read_to_string(memory_dir.join("extracted").join("sess-a.md")).unwrap();
        assert!(a.contains("keeps me, high conf"));
        assert!(a.contains("also kept"));
        assert!(!a.contains("dropped, too low"));

        let b = std::fs::read_to_string(memory_dir.join("extracted").join("sess-b.md")).unwrap();
        assert!(b.contains("kept at the floor"));
        assert!(!b.contains("below floor"));

        // Re-parse the rewritten files to confirm exactly the survivors remain.
        let reparsed = parse_entries(&a).len() + parse_entries(&b).len();
        assert_eq!(reparsed, 3);

        // Graph nodes are NOT pruned (no delete API) — documented limitation.
        assert_eq!(count_graph_nodes(engine.graph()), graph_before);

        std::fs::remove_dir_all(&root).ok();
    }

    /// The global cap keeps the newest `cap` survivors (date desc) after the floor.
    #[test]
    fn cap_keeps_newest_after_floor() {
        let mut per_file = vec![vec![
            RawEntry { date: "2026-01-01".into(), category: "project".into(), content: "old".into(), confidence: 0.9 },
            RawEntry { date: "2026-03-01".into(), category: "project".into(), content: "new".into(), confidence: 0.9 },
            RawEntry { date: "2026-02-01".into(), category: "project".into(), content: "mid".into(), confidence: 0.9 },
            RawEntry { date: "2026-09-01".into(), category: "project".into(), content: "lowconf".into(), confidence: 0.2 },
        ]];
        // Floor removes the 0.2 entry; cap=2 keeps the two newest of the remaining.
        let kept = apply_floor_and_cap(&mut per_file, CONFIDENCE_FLOOR, 2);
        assert_eq!(kept, 2);
        let contents: Vec<&str> = per_file[0].iter().map(|e| e.content.as_str()).collect();
        assert!(contents.contains(&"new"));
        assert!(contents.contains(&"mid"));
        assert!(!contents.contains(&"old"));
        assert!(!contents.contains(&"lowconf"));
    }

    /// Round-trip: render → parse is stable for the persist_memories format.
    #[test]
    fn parse_render_roundtrip() {
        let entries = vec![
            RawEntry { date: "2026-06-01".into(), category: "preference".into(), content: "likes rust".into(), confidence: 0.8 },
            RawEntry { date: "2026-06-01".into(), category: "project".into(), content: "uses tauri".into(), confidence: 0.6 },
        ];
        let rendered = render_entries(&entries);
        let reparsed = parse_entries(&rendered);
        assert_eq!(reparsed, entries);
    }
}
