//! Step 8 — fold the legacy **shared cross-agent memory** event log into the
//! graph, one time, idempotently.
//!
//! Before this replan, every agent on a project fed a per-project append-only
//! event log at `<project>/.atlas/shared-memory/events.jsonl` (written by
//! `src-tauri/.../commands/shared_memory.rs`). Each line is one typed
//! [`MemoryEvent`] — `decision` / `failure` / `architecture` / `fact` carry
//! durable project knowledge in `payload.text`. That knowledge should now live in
//! the graph so it is retrievable via the fused engine.
//!
//! This crate must NOT depend on `src-tauri`/`atlas-cersei`, so the on-disk line
//! schema is mirrored here as a **deserialize-only** [`SharedEvent`] (mirroring
//! Step 3's `LegacyIndex` approach) matching the exact serde field names of the
//! original writer (`#[serde(rename_all = "camelCase")]` — but every field we read
//! is a single word, so it deserializes 1:1; only the unread `sessionId` is
//! camelCased).
//!
//! **Idempotency:** a marker file `<memory_dir>/.shared-memory-imported` is written
//! after a successful pass. If it already exists the importer is a clean no-op
//! ([`ImportOutcome::AlreadyDone`]). The original `events.jsonl` is left in place
//! (readable for one release for rollback) — only the marker gates re-runs.
//!
//! [`MemoryEngine::open`] calls [`import_shared_memory`] **after** the Step-3 index
//! migration (so the graph already exists), so this runs cheaply on every open.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::Deserialize;

use crate::graph::MemoryType;

use crate::MemoryEngine;

/// Marker file (under the memory dir) recording that the one-time shared-memory
/// import has run for this project. Its presence makes the importer a no-op.
const IMPORT_MARKER: &str = ".shared-memory-imported";

/// Default confidence assigned to imported shared-memory nodes. These are
/// human/agent-recorded decisions and facts — trusted, but not re-validated, so a
/// moderately high (not maximal) confidence is sensible.
const IMPORT_CONFIDENCE: f32 = 0.7;

/// One persisted shared-memory event (one JSONL line). **Deserialize-only** mirror
/// of `shared_memory::MemoryEvent` — only the fields we actually consume are
/// declared; everything else (`agent`, `sessionId`, …) is ignored. `kind` is read
/// as the raw snake_case string the writer emits (`"decision"`, `"failure"`, …) so
/// we don't have to mirror the full `EventKind` enum and unknown future kinds are
/// skipped gracefully.
#[derive(Debug, Deserialize)]
struct SharedEvent {
    #[serde(default)]
    seq: u64,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    payload: serde_json::Value,
}

/// What [`import_shared_memory`] did, so callers (and tests) can branch/log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImportOutcome {
    /// No `events.jsonl` present (fresh project, or shared memory never used).
    NothingToDo,
    /// The import marker already exists — a prior pass folded this log in.
    AlreadyDone,
    /// Imported `count` events into the graph; `skipped` non-knowledge / empty
    /// lines were ignored. The marker was written.
    Imported { count: usize, skipped: usize },
}

fn events_path(project_root: &Path) -> PathBuf {
    project_root
        .join(".atlas")
        .join("shared-memory")
        .join("events.jsonl")
}

fn marker_path(memory_dir: &Path) -> PathBuf {
    memory_dir.join(IMPORT_MARKER)
}

/// Map a shared-memory event `kind` onto the graph's coarse [`MemoryType`].
///
/// Only the four durable-knowledge kinds are imported; operational/ephemeral kinds
/// (`plan_set`, `file_changed`, `session_*`, `todo_*`) carry no lasting recall
/// value and return `None`. The precise kind is preserved as a topic tag.
/// - `decision` / `architecture` / `fact` / `failure` → [`MemoryType::Project`]
fn kind_to_type(kind: &str) -> Option<MemoryType> {
    match kind {
        "decision" | "architecture" | "fact" | "failure" => Some(MemoryType::Project),
        _ => None,
    }
}

/// Pull the embeddable text out of an event payload (`payload.text`, trimmed).
fn payload_text(ev: &SharedEvent) -> String {
    ev.payload
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

/// One-time, idempotent import of `<project>/.atlas/shared-memory/events.jsonl`
/// into the engine's graph memory.
///
/// - Missing `events.jsonl` → [`ImportOutcome::NothingToDo`].
/// - Marker already present → [`ImportOutcome::AlreadyDone`] (no double-import).
/// - Otherwise: every durable-knowledge event ([`kind_to_type`]) with non-empty
///   text becomes a `store_memory` node tagged with its real kind; consecutive
///   same-kind nodes are `link_memories`-linked (`co_imported`). The marker is then
///   written; `events.jsonl` is **kept in place** for one release.
///
/// `&mut MemoryEngine` is taken for symmetry with [`crate::migrate::migrate`];
/// graph writes are `&self`, so no mutation of the engine itself occurs here.
pub fn import_shared_memory(engine: &mut MemoryEngine) -> Result<ImportOutcome> {
    let events = events_path(&engine.project_root);
    if !events.exists() {
        return Ok(ImportOutcome::NothingToDo);
    }

    // Idempotency: the memory dir is where the graph lives; the marker sits beside
    // it. Create the dir first so the marker write at the end can't fail on a
    // brand-new project.
    let memory_dir = engine.memory_dir.clone();
    std::fs::create_dir_all(&memory_dir).context("create memory dir for shared-memory import")?;
    let marker = marker_path(&memory_dir);
    if marker.exists() {
        return Ok(ImportOutcome::AlreadyDone);
    }

    let raw = std::fs::read_to_string(&events)
        .with_context(|| format!("read shared-memory log {events:?}"))?;

    let mut count = 0usize;
    let mut skipped = 0usize;
    // (graph node id, kind) of each successfully stored node, in file order — used
    // to link consecutive same-kind nodes below.
    let mut stored: Vec<(String, String)> = Vec::new();

    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // A malformed line shouldn't abort the whole import (the log is appended to
        // by long-lived agents across versions) — skip and keep going.
        let Ok(ev) = serde_json::from_str::<SharedEvent>(line) else {
            skipped += 1;
            continue;
        };
        let Some(mem_type) = kind_to_type(&ev.kind) else {
            skipped += 1;
            continue;
        };
        let text = payload_text(&ev);
        if text.is_empty() {
            skipped += 1;
            continue;
        }

        match engine.graph.store_memory(&text, mem_type, IMPORT_CONFIDENCE) {
            Ok(id) => {
                // Preserve the precise kind as a topic tag (the graph type is lossy:
                // decision/fact/failure/architecture all collapse to `Project`).
                if let Err(e) = engine.graph.tag_memory(&id, &ev.kind) {
                    tracing::debug!(target: "atlas_memory::shared_import", "tag_memory failed: {e}");
                }
                stored.push((id, ev.kind.clone()));
                count += 1;
            }
            Err(e) => {
                tracing::debug!(target: "atlas_memory::shared_import", seq = ev.seq, "store_memory failed: {e}");
                skipped += 1;
            }
        }
    }

    // Link consecutive same-kind nodes so the graph reflects the log's structure
    // (best-effort; recall never depends on links existing).
    for window in stored.windows(2) {
        let (from, from_kind) = &window[0];
        let (to, to_kind) = &window[1];
        if from_kind == to_kind {
            if let Err(e) = engine.graph.link_memories(from, to, "co_imported") {
                tracing::debug!(target: "atlas_memory::shared_import", "link_memories failed: {e}");
            }
        }
    }

    // Write the marker last, so a crash mid-import re-runs (store_memory is additive
    // but the graph dedups on content, so a partial re-run is safe-ish; the marker
    // only flips once the pass completes).
    std::fs::write(&marker, b"1").with_context(|| format!("write import marker {marker:?}"))?;

    Ok(ImportOutcome::Imported { count, skipped })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn tmp_root(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "atlas-memory-shared-import-{}-{}",
            std::process::id(),
            name
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// Write a fixture `events.jsonl` under `root/.atlas/shared-memory/` mirroring
    /// the real writer's camelCase JSONL line shape.
    fn write_events(root: &Path, lines: &[serde_json::Value]) {
        let dir = root.join(".atlas").join("shared-memory");
        std::fs::create_dir_all(&dir).unwrap();
        let body: String = lines
            .iter()
            .map(|l| serde_json::to_string(l).unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(dir.join("events.jsonl"), body).unwrap();
    }

    fn ev(seq: u64, kind: &str, text: &str) -> serde_json::Value {
        serde_json::json!({
            "seq": seq,
            "ts": seq as i64 * 1000,
            "agent": "claude-code",
            "sessionId": "s1",
            "kind": kind,
            "key": "",
            "payload": { "text": text },
        })
    }

    #[test]
    fn imports_decisions_and_constraints_into_graph() {
        let root = tmp_root("happy");
        write_events(
            &root,
            &[
                ev(1, "decision", "Chose PostgreSQL for persistence"),
                ev(2, "decision", "Use RS256 for JWT signing"),
                ev(3, "failure", "Tried global mutex; deadlocked under load"),
                ev(4, "fact", "The API is REST over JSON"),
                ev(5, "architecture", "Tauri app: Rust backend, React frontend"),
                // Non-knowledge kinds are skipped.
                ev(6, "file_changed", "edited lib.rs"),
                ev(7, "session_start", ""),
            ],
        );

        // `open` runs migration then shared-memory import internally.
        let engine = MemoryEngine::open(root.clone());

        // All five durable-knowledge events landed as Project-typed nodes.
        let projects = engine.graph.by_type(MemoryType::Project);
        assert_eq!(projects.len(), 5, "5 knowledge events imported");

        // Kinds preserved as topic tags.
        assert_eq!(engine.graph.by_topic("decision").len(), 2);
        assert_eq!(engine.graph.by_topic("failure").len(), 1);
        assert_eq!(engine.graph.by_topic("fact").len(), 1);
        assert_eq!(engine.graph.by_topic("architecture").len(), 1);

        // Content is recallable via the graph (substring CONTAINS recall).
        let hits = engine.graph.recall("PostgreSQL", 5);
        assert!(
            hits.iter().any(|h| h.contains("PostgreSQL")),
            "imported decision should be recallable: {hits:?}"
        );

        // Marker written.
        let marker = root.join(".atlas").join("memory").join(IMPORT_MARKER);
        assert!(marker.exists(), "import marker should be written");

        // Original log kept in place for rollback.
        let log = root.join(".atlas").join("shared-memory").join("events.jsonl");
        assert!(log.exists(), "events.jsonl must be kept readable");

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn second_open_is_already_done_no_double_import() {
        let root = tmp_root("idempotent");
        write_events(
            &root,
            &[
                ev(1, "decision", "Chose PostgreSQL for persistence"),
                ev(2, "fact", "The API is REST over JSON"),
            ],
        );

        let first = MemoryEngine::open(root.clone());
        assert_eq!(first.graph.by_type(MemoryType::Project).len(), 2);
        drop(first);

        // Re-open: marker present → AlreadyDone, no duplicates added.
        let mut second = MemoryEngine::open(root.clone());
        assert_eq!(
            import_shared_memory(&mut second).unwrap(),
            ImportOutcome::AlreadyDone
        );
        // Graph is the same (in-memory graph in a fresh open won't carry the prior
        // nodes, but the AlreadyDone short-circuit is the contract under test —
        // it must not re-read the log).

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn missing_log_is_nothing_to_do() {
        let root = tmp_root("missing");
        let mut engine = MemoryEngine::open(root.clone());
        assert_eq!(
            import_shared_memory(&mut engine).unwrap(),
            ImportOutcome::NothingToDo
        );
        // No marker written when there was nothing to import.
        let marker = root.join(".atlas").join("memory").join(IMPORT_MARKER);
        assert!(!marker.exists());

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn counts_skipped_non_knowledge_and_empty_lines() {
        let root = tmp_root("counts");
        // Open on an empty project first (no events.jsonl yet → NothingToDo, no
        // marker), so we can then write the fixture and call the importer directly
        // to assert the explicit `Imported { count, skipped }` outcome.
        let mut engine = MemoryEngine::open(root.clone());

        write_events(
            &root,
            &[
                ev(1, "decision", "real decision"),
                ev(2, "todo_added", "do the thing"), // skipped kind
                ev(3, "fact", ""),                   // empty text → skipped
                ev(4, "fact", "real fact"),
            ],
        );

        let outcome = import_shared_memory(&mut engine).unwrap();
        assert_eq!(outcome, ImportOutcome::Imported { count: 2, skipped: 2 });
        assert_eq!(engine.graph.by_type(MemoryType::Project).len(), 2);

        // A subsequent import is short-circuited by the marker.
        assert_eq!(
            import_shared_memory(&mut engine).unwrap(),
            ImportOutcome::AlreadyDone
        );

        std::fs::remove_dir_all(&root).unwrap();
    }
}
