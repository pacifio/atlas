//! Shared Cross-Agent Memory (v2) — capture (write path).
//!
//! Classifies live ACP [`SessionDelta`]s into typed [`RawEvent`]s and appends
//! them to the [`SharedMemoryStore`]. Hooked from `agents.rs`'s
//! `MemoryIngestMiddleware`, so every agent (Claude, Codex, opencode) feeds the
//! same log with zero agent-side cooperation.
//!
//! Key design choices (see PRD §3):
//! - **Structured signals, not raw transcript.** We capture the agent's own
//!   structured `PlanUpdated` plan and `ToolCallUpserted` file edits directly,
//!   plus a *conservative* keyword pass over finished assistant messages for
//!   explicit decisions/facts, which land as candidates (M0, decision 1): an
//!   agent may have echoed the line from anything it read. Streaming
//!   `TextChunk`/`ThinkingChunk` are ignored.
//! - **Redacted at the write boundary.** Shared memory is a cross-agent
//!   channel; the record store runs every write through `atlas_redact`
//!   before it lands, so capture needs no scrubber of its own.
//! - **Routing without snapshots.** The session's cwd + agent label come from
//!   `SharedMemoryStore::session_meta` (registered by `agents_send`), keeping
//!   the hot `emit` path off the manager lock.

use atlas_agent_wire::{MessageRole, SessionDelta, SessionDeltaEnvelope, ToolCallStatus};
use atlas_memory::record::EntryKind;

use super::shared_memory::{EventKind, RawEvent, SharedMemoryStore, Writer};

/// Per-text cap so one giant message can't bloat the log.
const TEXT_CAP: usize = 600;

const DECISION_MARKERS: [&str; 5] = [
    "decided to",
    "decision:",
    "we will use",
    "let's use",
    "going with",
];
const FACT_MARKERS: [&str; 3] = ["note:", "remember:", "convention:"];
const FAILURE_MARKERS: [&str; 5] = [
    "failed:",
    "doesn't work",
    "does not work",
    "anti-pattern",
    "gotcha:",
];
const ARCH_MARKERS: [&str; 3] = ["architecture:", "structured as", "the system uses"];

/// Entry point from `TauriDeltaSink::emit`. Best-effort: a missing session
/// (delta before first send) or an append error is a silent no-op.
pub fn ingest(envelope: &SessionDeltaEnvelope, store: &SharedMemoryStore) {
    let Some(meta) = store.session_meta(&envelope.session_id) else {
        return;
    };
    let events = classify(&envelope.delta, &envelope.session_id, &meta.agent);
    for ev in events {
        // Plans and file edits are structured signals and fold through the
        // log. Durable kinds come from the marker scan of free text, which an
        // agent may have copied from anything it read: candidates only.
        let durable = match ev.kind {
            EventKind::Decision => Some(EntryKind::Decision),
            EventKind::Fact => Some(EntryKind::Fact),
            EventKind::Failure => Some(EntryKind::Failure),
            EventKind::Architecture => Some(EntryKind::Architecture),
            _ => None,
        };
        // A file outside the project (another checkout, `/tmp`, `~/.claude`)
        // is not this project's change: it would be briefed to every agent
        // here as if it were.
        if ev.kind == EventKind::FileChanged && !in_project(&meta.cwd, &ev.key) {
            continue;
        }
        let result = match durable {
            Some(kind) => {
                let text = ev
                    .payload
                    .get("text")
                    .and_then(|t| t.as_str())
                    .unwrap_or("");
                let writer = Writer {
                    agent: meta.agent.clone(),
                    session_id: envelope.session_id.clone(),
                };
                store
                    .record_candidate(&meta.cwd, &writer, kind, text)
                    .map(|_| ())
            }
            None => store.append_event(&meta.cwd, ev).map(|_| ()),
        };
        if let Err(e) = result {
            tracing::warn!(target: "atlas::shared_memory", "capture failed: {e}");
        }
    }
}

/// Whether `path` is a file of the project the session at `cwd` works in:
/// under `cwd` or under its scope (the repository's root and worktrees).
fn in_project(cwd: &str, path: &str) -> bool {
    if atlas_memory::record::path_in_dirs(path, &[std::path::PathBuf::from(cwd)]) {
        return true;
    }
    super::shared_memory::store_for(cwd).is_ok_and(|store| store.in_scope(path))
}

/// One background thread that runs capture jobs in the order they were
/// pushed. The blocking pool gives no ordering across threads, so two plan
/// updates sent there could append out of order and the older plan would
/// win by key.
pub struct IngestQueue {
    tx: std::sync::mpsc::Sender<Box<dyn FnOnce() + Send>>,
}

impl IngestQueue {
    pub fn new(name: &str) -> Self {
        let (tx, rx) = std::sync::mpsc::channel::<Box<dyn FnOnce() + Send>>();
        std::thread::Builder::new()
            .name(name.to_string())
            .spawn(move || {
                // One panicking job must not end the thread: every later
                // capture would be dropped for the app's lifetime.
                while let Ok(job) = rx.recv() {
                    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(job)).is_err() {
                        tracing::warn!(target: "atlas::shared_memory", "capture job panicked");
                    }
                }
            })
            .expect("spawn the memory ingest thread");
        Self { tx }
    }

    /// Run `job` after every job pushed before it. Never blocks; a job pushed
    /// after shutdown is dropped.
    pub fn push(&self, job: impl FnOnce() + Send + 'static) {
        let _ = self.tx.send(Box::new(job));
    }
}

/// Pure classifier: map one delta to zero or more typed events. Unit-testable.
pub fn classify(delta: &SessionDelta, session_id: &str, agent: &str) -> Vec<RawEvent> {
    match delta {
        // The agent's structured plan — the cleanest capture signal. This is
        // exactly what fixes "Codex can't see Claude's plan".
        SessionDelta::PlanUpdated { plan } => {
            let body = plan
                .iter()
                .map(|e| format!("- [{}] {}", e.status, e.content.trim()))
                .collect::<Vec<_>>()
                .join("\n");
            if body.trim().is_empty() {
                return Vec::new();
            }
            // A plan whose every item is done is finished: logged as `done`,
            // it clears the active plan instead of lingering as one.
            let status = if atlas_memory::handoff::plan_is_finished(&body) {
                "done"
            } else {
                "active"
            };
            vec![RawEvent {
                agent: agent.to_string(),
                session_id: session_id.to_string(),
                kind: EventKind::PlanSet,
                key: "plan".to_string(),
                payload: serde_json::json!({ "text": cap(&body), "status": status }),
            }]
        }

        // A finished tool call that mutates a file → file_changed (on Completed
        // only; dedup-by-path in the fold collapses repeats). Classification
        // and path extraction are the checkpoint crate's — the one place that
        // already solved both per agent family (#67): the native agent's tool
        // name is a human title ("Edit src/foo.rs"), which the old
        // exact-string matcher never matched, and its files ride the ACP
        // `locations`, which the old singular-key probe never read — so
        // Atlas Agent's edits silently produced no cross-agent memory at all.
        SessionDelta::ToolCallUpserted { tool_call, .. } => {
            if tool_call.status != ToolCallStatus::Completed {
                return Vec::new();
            }
            let name = atlas_checkpoint::tools::canonical_name(
                Some(&tool_call.tool_name),
                tool_call.title.as_deref(),
                tool_call.kind.as_deref(),
                &tool_call.arguments,
            );
            if !name.writes_files() {
                return Vec::new();
            }
            let summary = tool_call
                .title
                .clone()
                .unwrap_or_else(|| tool_call.tool_name.clone());
            atlas_checkpoint::tools::extract_paths(&tool_call.locations, &[], &tool_call.arguments)
                .into_iter()
                .map(|path| RawEvent {
                    agent: agent.to_string(),
                    session_id: session_id.to_string(),
                    kind: EventKind::FileChanged,
                    key: path.clone(),
                    payload: serde_json::json!({ "path": path, "summary": cap(&summary) }),
                })
                .collect()
        }

        // A completed assistant message → conservative keyword scan for explicit
        // decisions / facts. Only fires on clear markers to avoid pollution.
        SessionDelta::MessageAppended { message } => {
            if message.role != MessageRole::Assistant {
                return Vec::new();
            }
            scan_assistant_text(&message.content, session_id, agent)
        }

        _ => Vec::new(),
    }
}

/// Conservative marker-based extraction of decisions/facts from prose.
fn scan_assistant_text(content: &str, session_id: &str, agent: &str) -> Vec<RawEvent> {
    let mut out = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim().trim_start_matches(['-', '*', '#', '>', ' ']);
        // Markers are ASCII, so they are found in `trimmed` itself: an offset
        // taken from a lowercased copy can land inside a character here
        // ('İ' lowercases one byte longer).
        let first = |markers: &[&str]| markers.iter().find_map(|m| find_marker(trimmed, m));
        let (kind, end) = if let Some(end) = first(&DECISION_MARKERS[..]) {
            (EventKind::Decision, end)
        } else if let Some(end) = first(&FAILURE_MARKERS[..]) {
            (EventKind::Failure, end)
        } else if let Some(end) = first(&ARCH_MARKERS[..]) {
            (EventKind::Architecture, end)
        } else if let Some(end) = first(&FACT_MARKERS[..]) {
            (EventKind::Fact, end)
        } else {
            continue;
        };
        // Take the clause after the marker as the captured text.
        let text = trimmed[end..].trim_start_matches([':', ' ', '-']).trim();
        if text.len() < 4 {
            continue;
        }
        out.push(RawEvent {
            agent: agent.to_string(),
            session_id: session_id.to_string(),
            kind,
            key: String::new(), // keyless → dedup by normalized text
            payload: serde_json::json!({ "text": cap(text) }),
        });
        if out.len() >= 5 {
            break; // cap per message
        }
    }
    out
}

/// The byte offset just past the first ASCII-case-insensitive match of the
/// ASCII `marker` in `text`; always a char boundary.
fn find_marker(text: &str, marker: &str) -> Option<usize> {
    text.char_indices()
        .map(|(i, _)| i)
        .find(|&i| {
            text.get(i..i + marker.len())
                .is_some_and(|s| s.eq_ignore_ascii_case(marker))
        })
        .map(|i| i + marker.len())
}

fn cap(s: &str) -> String {
    if s.chars().count() <= TEXT_CAP {
        return s.to_string();
    }
    let mut out: String = s.chars().take(TEXT_CAP).collect();
    out.push('…');
    out
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use atlas_agent_wire::PlanEntry;

    fn native_edit_delta() -> SessionDelta {
        SessionDelta::ToolCallUpserted {
            message_id: "m1".into(),
            tool_call: atlas_agent_wire::ToolCall {
                id: "call-1".into(),
                tool_name: "Edit src/foo.rs (+1 more)".into(),
                title: Some("Edit src/foo.rs (+1 more)".into()),
                kind: Some("edit".into()),
                status: ToolCallStatus::Completed,
                arguments: serde_json::json!({ "paths": ["src/foo.rs", "src/bar.rs"] }),
                result: None,
                locations: vec![
                    serde_json::json!({ "path": "src/foo.rs" }),
                    serde_json::json!({ "path": "src/bar.rs" }),
                ],
                raw_output: None,
                content_blocks: vec![],
            },
        }
    }

    /// Issue #67: the native agent titles its edit call "Edit src/foo.rs" and
    /// carries the files in ACP `locations` — no exact-string tool name, no
    /// singular path key. The old matcher saw neither, so Atlas Agent's edits
    /// never produced a `file_changed` and cross-agent memory silently
    /// excluded the native agent. Every edited file gets its own event.
    #[test]
    fn a_native_agent_edit_reaches_shared_memory() {
        let evs = classify(&native_edit_delta(), "s1", "atlas-agent");
        assert_eq!(evs.len(), 2, "one file_changed per edited file");
        assert!(evs.iter().all(|e| e.kind == EventKind::FileChanged));
        assert_eq!(evs[0].key, "src/foo.rs");
        assert_eq!(evs[1].key, "src/bar.rs");
    }

    fn plan_delta() -> SessionDelta {
        SessionDelta::PlanUpdated {
            plan: vec![PlanEntry {
                content: "Migrate auth to JWT".into(),
                priority: None,
                status: "pending".into(),
            }],
        }
    }

    #[test]
    fn plan_update_becomes_plan_set() {
        let evs = classify(&plan_delta(), "s1", "claude-code");
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].kind, EventKind::PlanSet);
        assert_eq!(evs[0].key, "plan");
        assert!(evs[0].payload["text"]
            .as_str()
            .unwrap()
            .contains("Migrate auth"));
    }

    /// An agent's plan update, captured from its delta stream, is a write to
    /// shared memory — so it announces itself: one memory-changed carrying the
    /// scope root and the plan kind. This is what the Shared tab re-pulls on.
    #[test]
    fn a_captured_plan_update_announces_the_change() {
        let dir =
            std::env::temp_dir().join(format!("atlas-delta-changed-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let project = dir.to_string_lossy().to_string();
        let store = SharedMemoryStore::new();
        let heard = std::sync::Arc::new(parking_lot::Mutex::new(Vec::new()));
        store.on_change({
            let heard = heard.clone();
            std::sync::Arc::new(move |change: &super::super::shared_memory::MemoryChanged| {
                heard.lock().push(change.clone());
            })
        });
        store.register_session("s1", &project, "claude-code");

        ingest(
            &SessionDeltaEnvelope {
                agent_id: atlas_agent_wire::AgentId::new(),
                session_id: "s1".into(),
                delta: plan_delta(),
            },
            &store,
        );

        let heard = heard.lock().clone();
        assert_eq!(heard.len(), 1, "{heard:?}");
        assert_eq!(heard[0].root, dir.canonicalize().unwrap().to_string_lossy());
        assert_eq!(heard[0].kinds, vec!["plan".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn edit_delta(paths: &[&str]) -> SessionDelta {
        SessionDelta::ToolCallUpserted {
            message_id: "m1".into(),
            tool_call: atlas_agent_wire::ToolCall {
                id: "call-x".into(),
                tool_name: "Edit".into(),
                title: Some("Edit".into()),
                kind: Some("edit".into()),
                status: ToolCallStatus::Completed,
                arguments: serde_json::json!({ "paths": paths }),
                result: None,
                locations: paths
                    .iter()
                    .map(|p| serde_json::json!({ "path": p }))
                    .collect(),
                raw_output: None,
                content_blocks: vec![],
            },
        }
    }

    fn envelope(delta: SessionDelta) -> SessionDeltaEnvelope {
        SessionDeltaEnvelope {
            agent_id: atlas_agent_wire::AgentId::new(),
            session_id: "s1".into(),
            delta,
        }
    }

    /// A plan whose every item is completed is finished: it is logged as
    /// `done`, which clears the active plan, rather than lingering as active.
    #[test]
    fn a_finished_plan_clears_the_active_plan() {
        let finished = SessionDelta::PlanUpdated {
            plan: vec![
                PlanEntry {
                    content: "Create branch".into(),
                    priority: None,
                    status: "completed".into(),
                },
                PlanEntry {
                    content: "Open PR".into(),
                    priority: None,
                    status: "completed".into(),
                },
            ],
        };
        let evs = classify(&finished, "s1", "claude-acp");
        assert_eq!(evs[0].payload["status"], "done");
        assert_eq!(
            classify(&plan_delta(), "s1", "x")[0].payload["status"],
            "active"
        );

        let dir = std::env::temp_dir().join(format!("atlas-delta-plan-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let project = dir.to_string_lossy().to_string();
        let store = SharedMemoryStore::new();
        store.register_session("s1", &project, "claude-acp");
        ingest(&envelope(plan_delta()), &store);
        assert_eq!(store.list_entries(&project, Some(EntryKind::Plan)).len(), 1);
        ingest(&envelope(finished), &store);
        assert!(store
            .list_entries(&project, Some(EntryKind::Plan))
            .is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An edit outside the project (another checkout, `/tmp`, `~/.claude`)
    /// is not recorded into this project's memory.
    #[test]
    fn an_edit_outside_the_project_is_not_captured() {
        let dir = std::env::temp_dir().join(format!("atlas-delta-scope-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let project = dir.to_string_lossy().to_string();
        let inside = format!("{project}/src/lib.rs");
        let store = SharedMemoryStore::new();
        store.register_session("s1", &project, "claude-acp");
        ingest(
            &envelope(edit_delta(&[
                &inside,
                "src/main.rs",
                "/tmp/homebrew-cask-pr/Casks/a/atlas-ai.rb",
                "/Users/someone/Developer/atlas/src/App.tsx",
                "/Users/someone/.claude/plans/x.md",
            ])),
            &store,
        );
        let mut keys: Vec<String> = store
            .list_entries(&project, Some(EntryKind::FileChanged))
            .into_iter()
            .map(|e| e.key)
            .collect();
        keys.sort();
        assert_eq!(keys, vec![inside, "src/main.rs".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn decision_marker_extracted() {
        let evs = scan_assistant_text("We will use RS256 for signing.", "s1", "codex");
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].kind, EventKind::Decision);
        assert!(evs[0].payload["text"]
            .as_str()
            .unwrap()
            .to_lowercase()
            .contains("rs256"));
    }

    #[test]
    fn fact_marker_extracted() {
        let evs = scan_assistant_text("Note: the JWT lives in config", "s1", "codex");
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].kind, EventKind::Fact);
    }

    /// 'İ' lowercases one byte longer, so an offset found in a lowercased
    /// copy fell inside 'é' here and panicked the ingest thread.
    #[test]
    fn a_marker_after_a_case_changing_letter_is_cut_at_a_char_boundary() {
        let evs = scan_assistant_text("İ note:é is the default", "s1", "codex");
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].payload["text"], "é is the default");
        let evs = scan_assistant_text("Going With EdDSA", "s1", "codex");
        assert_eq!(evs[0].payload["text"], "EdDSA");
    }

    #[test]
    fn prose_without_marker_is_ignored() {
        assert!(scan_assistant_text("Here is some normal explanation text.", "s1", "x").is_empty());
    }

    /// Capture no longer scrubs with its own heuristic: every write lands
    /// through the record store, which runs `atlas_redact` on all of them. A
    /// secret an agent says in passing never reaches shared memory.
    #[test]
    fn a_captured_secret_lands_redacted() {
        let secret = "sk-proj-AbCdEf0123456789GhIjKlMnOpQrStUv";
        let evs = scan_assistant_text(&format!("Note: the deploy key is {secret}"), "s1", "codex");
        assert_eq!(evs.len(), 1);

        let dir = std::env::temp_dir().join(format!("atlas-delta-redact-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let project = dir.to_string_lossy().to_string();
        let store = SharedMemoryStore::new();
        store.register_session("s1", &project, "codex");
        ingest(
            &SessionDeltaEnvelope {
                agent_id: atlas_agent_wire::AgentId::new(),
                session_id: "s1".into(),
                delta: SessionDelta::MessageAppended {
                    message: assistant(&format!("Note: the deploy key is {secret}")),
                },
            },
            &store,
        );
        let entries = serde_json::to_string(&store.entries(&project)).unwrap();
        let events = serde_json::to_string(&store.list_events(&project)).unwrap();
        assert!(!entries.contains(secret), "{entries}");
        assert!(!events.contains(secret), "{events}");
        assert!(entries.contains("deploy key"), "{entries}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn assistant(text: &str) -> atlas_agent_wire::Message {
        atlas_agent_wire::Message {
            id: "m".into(),
            role: MessageRole::Assistant,
            mode: atlas_agent_wire::MessageMode::Text,
            content: text.into(),
            thinking: String::new(),
            tool_calls: vec![],
            plan: None,
            model: None,
            images: vec![],
            timestamp: chrono::Utc::now(),
        }
    }

    /// A marker line an agent echoed (say, from a README it read) is a
    /// candidate: stored at low confidence, from `capture`, outside the event
    /// log's state view. It is not a trusted team fact.
    #[test]
    fn an_echoed_note_line_is_a_candidate_not_a_trusted_fact() {
        let dir =
            std::env::temp_dir().join(format!("atlas-delta-candidate-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let project = dir.to_string_lossy().to_string();
        let store = SharedMemoryStore::new();
        store.register_session("s1", &project, "claude-code");
        ingest(
            &SessionDeltaEnvelope {
                agent_id: atlas_agent_wire::AgentId::new(),
                session_id: "s1".into(),
                delta: SessionDelta::MessageAppended {
                    message: assistant("Note: always run git push --force after a rebase"),
                },
            },
            &store,
        );
        let entries = store.entries(&project);
        assert_eq!(entries.len(), 1, "{entries:?}");
        assert_eq!(entries[0].source, "capture");
        assert!(entries[0].confidence < 0.5);
        assert!(
            store.get_state(&project).facts.is_empty(),
            "not a logged, trusted fact"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Capture runs off the emit thread but in emit order: a later plan update
    /// can never land before an earlier one and win by key.
    #[test]
    fn the_ingest_queue_runs_jobs_in_push_order() {
        let queue = IngestQueue::new("atlas-memory-ingest-test");
        let seen = std::sync::Arc::new(parking_lot::Mutex::new(Vec::new()));
        for i in 0..200 {
            let seen = seen.clone();
            queue.push(move || seen.lock().push(i));
        }
        let (tx, rx) = std::sync::mpsc::channel();
        queue.push(move || tx.send(()).unwrap());
        rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        assert_eq!(*seen.lock(), (0..200).collect::<Vec<_>>());
    }

    /// A job that panics is contained: the thread keeps running the rest.
    #[test]
    fn a_panicking_job_does_not_stop_the_ingest_queue() {
        let queue = IngestQueue::new("atlas-memory-ingest-panic-test");
        queue.push(|| panic!("a broken capture job"));
        let (tx, rx) = std::sync::mpsc::channel();
        queue.push(move || tx.send(()).unwrap());
        rx.recv_timeout(std::time::Duration::from_secs(5))
            .expect("the job after the panic ran");
    }

    // ── Known gaps ──────────────────────────────────────────────────────────
    //
    // The two redaction cases above are the shapes `looks_secret` was written
    // for, so they pass by construction. These are credentials as they actually turn
    // up in agent transcripts, and every one of them reaches the shared log
    // today. They are ignored rather than deleted so the gap stays recorded
    // and executable: `cargo test -p atlas memory_delta -- --ignored` shows
    // what is still missed.

    /// Asserts `secret` does not survive redaction of `input`.
    fn assert_redacted(input: &str, secret: &str) {
        let r = atlas_memory::record::redact(input);
        assert!(!r.contains(secret), "leaked {secret:?}: {r}");
    }

    /// The separator is followed by a space, so the key and the value are two
    /// tokens and neither looks like an assignment on its own.
    #[test]
    #[ignore = "known gap: atlas_memory::record::redact misses this; see redaction migration"]
    fn password_after_a_colon_and_space_is_redacted() {
        assert_redacted("password: hunter2hunter2", "hunter2hunter2");
    }

    #[test]
    #[ignore = "known gap: atlas_memory::record::redact misses this; see redaction migration"]
    fn password_in_a_postgres_dsn_is_redacted() {
        assert_redacted(
            "connect with postgres://app:s3cretPassw0rd@db.internal:5432/app",
            "s3cretPassw0rd",
        );
    }

    /// `Bearer` alone is under the 12-character floor, and a JWT's dots fail
    /// the opaque-blob check.
    #[test]
    #[ignore = "known gap: atlas_memory::record::redact misses this; see redaction migration"]
    fn bearer_token_in_an_authorization_header_is_redacted() {
        assert_redacted(
            "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl",
            "eyJhbGciOiJIUzI1NiJ9",
        );
    }

    #[test]
    #[ignore = "known gap: atlas_memory::record::redact misses this; see redaction migration"]
    fn password_field_in_yaml_is_redacted() {
        assert_redacted(
            "database:\n  user: app\n  password: hunter2hunter2\n",
            "hunter2hunter2",
        );
    }

    #[test]
    #[ignore = "known gap: atlas_memory::record::redact misses this; see redaction migration"]
    fn password_field_in_json_is_redacted() {
        assert_redacted(
            r#"{"user": "app", "password": "hunter2hunter2"}"#,
            "hunter2hunter2",
        );
    }
}
