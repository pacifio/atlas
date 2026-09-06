//! Shared Cross-Agent Memory (v2) — capture (write path).
//!
//! Classifies live ACP [`SessionDelta`]s into typed [`RawEvent`]s and appends
//! them to the [`SharedMemoryStore`]. Hooked from `agents.rs::TauriDeltaSink::emit`,
//! so every agent (Claude, Codex, opencode) feeds the same log with zero
//! agent-side cooperation.
//!
//! Key design choices (see PRD §3):
//! - **Structured signals, not raw transcript.** We capture the agent's own
//!   structured `PlanUpdated` plan and `ToolCallUpserted` file edits directly,
//!   plus a *conservative* keyword pass over finished assistant messages for
//!   explicit decisions/facts. Streaming `TextChunk`/`ThinkingChunk` are ignored.
//! - **Secret-scan + redact at the write boundary.** Shared memory is a
//!   cross-agent channel; anything captured is redacted before it lands.
//! - **Routing without snapshots.** The session's cwd + agent label come from
//!   `SharedMemoryStore::session_meta` (registered by `agents_send`), keeping
//!   the hot `emit` path off the manager lock.

use atlas_agent_wire::{MessageRole, SessionDelta, SessionDeltaEnvelope, ToolCallStatus};

use super::shared_memory::{EventKind, RawEvent, SharedMemoryStore};

/// Per-text cap so one giant message can't bloat the log.
const TEXT_CAP: usize = 600;

const DECISION_MARKERS: [&str; 5] =
    ["decided to", "decision:", "we will use", "let's use", "going with"];
const FACT_MARKERS: [&str; 3] = ["note:", "remember:", "convention:"];
const FAILURE_MARKERS: [&str; 5] =
    ["failed:", "doesn't work", "does not work", "anti-pattern", "gotcha:"];
const ARCH_MARKERS: [&str; 3] = ["architecture:", "structured as", "the system uses"];

/// Entry point from `TauriDeltaSink::emit`. Best-effort: a missing session
/// (delta before first send) or an append error is a silent no-op.
pub fn ingest(envelope: &SessionDeltaEnvelope, store: &SharedMemoryStore) {
    let Some(meta) = store.session_meta(&envelope.session_id) else {
        return;
    };
    let events = classify(&envelope.delta, &envelope.session_id, &meta.agent);
    for ev in events {
        if let Err(e) = store.append_event(&meta.cwd, ev) {
            tracing::warn!(target: "atlas::shared_memory", "capture append failed: {e}");
        }
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
            vec![RawEvent {
                agent: agent.to_string(),
                session_id: session_id.to_string(),
                kind: EventKind::PlanSet,
                key: "plan".to_string(),
                payload: serde_json::json!({ "text": redact(&cap(&body)), "status": "active" }),
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
            atlas_checkpoint::tools::extract_paths(
                &tool_call.locations,
                &[],
                &tool_call.arguments,
            )
            .into_iter()
            .map(|path| RawEvent {
                agent: agent.to_string(),
                session_id: session_id.to_string(),
                kind: EventKind::FileChanged,
                key: path.clone(),
                payload: serde_json::json!({ "path": path, "summary": redact(&cap(&summary)) }),
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
        let lower = trimmed.to_lowercase();
        let (kind, marker) = if let Some(m) = DECISION_MARKERS.iter().find(|m| lower.contains(**m)) {
            (EventKind::Decision, *m)
        } else if let Some(m) = FAILURE_MARKERS.iter().find(|m| lower.contains(**m)) {
            (EventKind::Failure, *m)
        } else if let Some(m) = ARCH_MARKERS.iter().find(|m| lower.contains(**m)) {
            (EventKind::Architecture, *m)
        } else if let Some(m) = FACT_MARKERS.iter().find(|m| lower.contains(**m)) {
            (EventKind::Fact, *m)
        } else {
            continue;
        };
        // Take the clause after the marker as the captured text.
        let idx = lower.find(marker).unwrap_or(0) + marker.len();
        let text = trimmed[idx.min(trimmed.len())..]
            .trim_start_matches([':', ' ', '-'])
            .trim();
        if text.len() < 4 {
            continue;
        }
        out.push(RawEvent {
            agent: agent.to_string(),
            session_id: session_id.to_string(),
            kind,
            key: String::new(), // keyless → dedup by normalized text
            payload: serde_json::json!({ "text": redact(&cap(text)) }),
        });
        if out.len() >= 5 {
            break; // cap per message
        }
    }
    out
}

fn cap(s: &str) -> String {
    if s.chars().count() <= TEXT_CAP {
        return s.to_string();
    }
    let mut out: String = s.chars().take(TEXT_CAP).collect();
    out.push('…');
    out
}

/// Redact obvious secrets before anything is persisted to the shared log.
/// Pattern-based (no entropy scan in MVP) — covers the common credential shapes.
pub fn redact(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for token in s.split_inclusive(char::is_whitespace) {
        let trimmed = token.trim_end();
        if looks_secret(trimmed) {
            let ws = &token[trimmed.len()..];
            out.push_str("[REDACTED]");
            out.push_str(ws);
        } else {
            out.push_str(token);
        }
    }
    out
}

fn looks_secret(tok: &str) -> bool {
    if tok.len() < 12 {
        return false;
    }
    let lower = tok.to_lowercase();
    if lower.starts_with("sk-")
        || lower.starts_with("ghp_")
        || lower.starts_with("gho_")
        || lower.starts_with("xoxb-")
        || lower.starts_with("xoxp-")
        || tok.starts_with("AKIA")
        || lower.starts_with("aws_")
        || lower.starts_with("bearer")
    {
        return true;
    }
    // `KEY=value` / `TOKEN: value` assignment shapes with a long-ish secret.
    if let Some((k, v)) = tok.split_once(['=', ':']) {
        let kl = k.to_lowercase();
        if (kl.contains("secret")
            || kl.contains("token")
            || kl.contains("password")
            || kl.contains("apikey")
            || kl.contains("api_key"))
            && v.trim().len() >= 6
        {
            return true;
        }
    }
    // Long opaque alphanumeric blob (hex/base64-like, mixed digits+letters).
    if tok.len() >= 32
        && tok
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '/' || c == '+')
        && tok.chars().any(|c| c.is_ascii_digit())
        && tok.chars().any(|c| c.is_ascii_alphabetic())
    {
        return true;
    }
    false
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
        let evs = classify(&native_edit_delta(), "s1", "cersei");
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
        assert!(evs[0].payload["text"].as_str().unwrap().contains("Migrate auth"));
    }

    #[test]
    fn decision_marker_extracted() {
        let evs = scan_assistant_text("We will use RS256 for signing.", "s1", "codex");
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].kind, EventKind::Decision);
        assert!(evs[0].payload["text"].as_str().unwrap().to_lowercase().contains("rs256"));
    }

    #[test]
    fn fact_marker_extracted() {
        let evs = scan_assistant_text("Note: the JWT lives in config", "s1", "codex");
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].kind, EventKind::Fact);
    }

    #[test]
    fn prose_without_marker_is_ignored() {
        assert!(scan_assistant_text("Here is some normal explanation text.", "s1", "x").is_empty());
    }

    #[test]
    fn secrets_are_redacted() {
        let r = redact("the key is sk-ABCDEF0123456789ABCDEF and done");
        assert!(r.contains("[REDACTED]"));
        assert!(!r.contains("sk-ABCDEF0123456789"));
    }

    #[test]
    fn assignment_secret_redacted() {
        let r = redact("API_KEY=supersecretvalue123");
        assert!(r.contains("[REDACTED]"));
    }

    #[test]
    fn ordinary_words_not_redacted() {
        let r = redact("the quick brown fox jumps");
        assert_eq!(r, "the quick brown fox jumps");
    }
}
