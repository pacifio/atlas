//! Shared Cross-Agent Memory (v2) — LLM compile pass (prose → typed events).
//!
//! Heuristic capture (`super::memory_delta`) only catches structured deltas
//! (plans, file edits) and a few marker phrases, so an agent's **prose**
//! reasoning — "we'll use RS256 because…", "tried X, it deadlocks" — is lost.
//! This module closes that gap the way relayBrain does: after a turn finishes,
//! it sends the completed assistant message to the project's BYOK summarizer
//! provider and asks it to distill durable items into typed
//! `decision`/`fact`/`failure`/`architecture` events.
//!
//! It is **strictly off the hot path**: triggered on `TurnFinished` via
//! `tauri::async_runtime::spawn`, time-bounded, and a complete no-op unless the
//! project's summarizer is set to `mode: "provider"` (so it only ever runs when
//! the user has opted into a provider + key). Any failure is silent.

use std::time::Duration;

use super::agent_host::{AgentHost, SessionKey};
use atlas_agent_wire::{AgentId, MessageRole};
use tauri::{AppHandle, Manager};

use super::memory_delta::redact;
use super::memory_sharing::MemorySharingState;
use super::memory_summarize::run_completion;
use super::shared_memory::{EventKind, RawEvent, SharedMemoryStore};

const COMPILE_TIMEOUT_SECS: u64 = 12;
/// Cap the assistant text sent to the model (chars).
const MAX_TEXT: usize = 6000;
/// Skip trivially short replies (greetings, acks).
const MIN_TEXT: usize = 40;
/// Max items kept per category from one reply.
const MAX_PER_KIND: usize = 8;

const COMPILE_INSTRUCTION: &str = "You are extracting durable cross-agent memory from one AI coding assistant's reply so a DIFFERENT agent can continue the work. From the reply below, extract only concrete, reusable items. Respond with ONLY a JSON object (no prose, no code fences) of exactly this shape:\n{\"decisions\":[],\"facts\":[],\"failures\":[],\"architecture\":[]}\nWhere: decisions = technical choices made; facts = durable project facts/conventions; failures = things tried that failed or anti-patterns to avoid; architecture = structural notes about the system. Each item is ONE short string. Omit anything speculative, conversational, or transient. Use empty arrays when nothing qualifies.\n\n--- REPLY ---\n";

/// Triggered on `TurnFinished`. Resolves the session's cwd/agent + provider
/// pref, grabs the last assistant message, distills it, and appends the events.
/// Silent no-op when sharing is off, no provider is configured, or anything
/// fails. Runs inside a spawned task — never blocks the delta stream.
pub async fn compile_finished_turn(app: &AppHandle, agent_id: AgentId, session_id: String) {
    let store = app.state::<SharedMemoryStore>();
    let Some(meta) = store.session_meta(&session_id) else {
        return;
    };

    let sharing = app.state::<MemorySharingState>();
    if !sharing.is_enabled(&meta.cwd) {
        return;
    }
    let pref = sharing.summarizer_pref(&meta.cwd);
    if pref.mode != "provider" || pref.provider.is_empty() || pref.model.is_empty() {
        return; // compile only runs when the user opted into a BYOK provider
    }

    // Pull the last assistant message text from the session snapshot.
    let host = app.state::<std::sync::Arc<AgentHost>>();
    let key = SessionKey {
        agent_id,
        session_id: session_id.clone(),
    };
    let Ok(snapshot) = host.snapshot(&key) else {
        return;
    };
    let Some(text) = snapshot
        .messages
        .iter()
        .rev()
        .find(|m| m.role == MessageRole::Assistant && !m.content.trim().is_empty())
        .map(|m| m.content.clone())
    else {
        return;
    };

    let events =
        compile_turn(app, &meta.agent, &session_id, &text, &pref.provider, &pref.model).await;
    for ev in events {
        if let Err(e) = store.append_event(&meta.cwd, ev) {
            tracing::debug!(target: "atlas::shared_memory", "compile append failed: {e}");
        }
    }
}

/// Distill one assistant reply into typed events via the BYOK provider.
/// Time-bounded; returns empty on any failure. Public for unit-testing the
/// parser path via [`parse_events`].
pub async fn compile_turn(
    app: &AppHandle,
    agent: &str,
    session_id: &str,
    assistant_text: &str,
    provider: &str,
    model: &str,
) -> Vec<RawEvent> {
    if provider.is_empty() || model.is_empty() || assistant_text.trim().len() < MIN_TEXT {
        return Vec::new();
    }
    let text: String = assistant_text.chars().take(MAX_TEXT).collect();
    let prompt = format!("{COMPILE_INSTRUCTION}{text}");

    let resp = match tokio::time::timeout(
        Duration::from_secs(COMPILE_TIMEOUT_SECS),
        run_completion(app, prompt, provider, model),
    )
    .await
    {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            tracing::debug!(target: "atlas::shared_memory", "compile provider error: {e}");
            return Vec::new();
        }
        Err(_) => {
            tracing::warn!(target: "atlas::shared_memory", "compile timed out after {COMPILE_TIMEOUT_SECS}s");
            return Vec::new();
        }
    };
    parse_events(&resp, agent, session_id)
}

/// Pure: parse the model's JSON response into typed [`RawEvent`]s. Lenient —
/// extracts the first `{…}` block and ignores unknown fields. Unit-testable.
pub fn parse_events(resp: &str, agent: &str, session_id: &str) -> Vec<RawEvent> {
    let Some(json) = extract_json_object(resp) else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&json) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for (field, kind) in [
        ("decisions", EventKind::Decision),
        ("facts", EventKind::Fact),
        ("failures", EventKind::Failure),
        ("architecture", EventKind::Architecture),
    ] {
        let Some(arr) = v.get(field).and_then(|x| x.as_array()) else {
            continue;
        };
        for item in arr.iter().filter_map(|i| i.as_str()).take(MAX_PER_KIND) {
            let t = item.trim();
            if t.len() < 4 {
                continue;
            }
            out.push(RawEvent {
                agent: agent.to_string(),
                session_id: session_id.to_string(),
                kind,
                key: String::new(), // keyless → dedup by normalized text in the fold
                payload: serde_json::json!({ "text": redact(t) }),
            });
        }
    }
    out
}

/// Extract the outermost `{ … }` object from a response that may have stray
/// prose or code fences around it.
fn extract_json_object(s: &str) -> Option<String> {
    let start = s.find('{')?;
    let end = s.rfind('}')?;
    if end > start {
        Some(s[start..=end].to_string())
    } else {
        None
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_all_kinds() {
        let resp = r#"Here you go:
        {"decisions":["Use RS256 for JWT"],"facts":["App uses Next.js 16"],"failures":["HS256 needs shared secret — avoid"],"architecture":["Server Components for /todos"]}"#;
        let evs = parse_events(resp, "claude-code", "s1");
        assert_eq!(evs.len(), 4);
        assert!(evs.iter().any(|e| e.kind == EventKind::Decision));
        assert!(evs.iter().any(|e| e.kind == EventKind::Fact));
        assert!(evs.iter().any(|e| e.kind == EventKind::Failure));
        assert!(evs.iter().any(|e| e.kind == EventKind::Architecture));
    }

    #[test]
    fn empty_arrays_yield_nothing() {
        let resp = r#"{"decisions":[],"facts":[],"failures":[],"architecture":[]}"#;
        assert!(parse_events(resp, "a", "s").is_empty());
    }

    #[test]
    fn non_json_yields_nothing() {
        assert!(parse_events("I could not produce JSON.", "a", "s").is_empty());
    }

    #[test]
    fn short_items_skipped() {
        let resp = r#"{"decisions":["ok","Use Postgres for persistence"]}"#;
        let evs = parse_events(resp, "a", "s");
        assert_eq!(evs.len(), 1);
        assert!(evs[0].payload["text"].as_str().unwrap().contains("Postgres"));
    }

    #[test]
    fn secrets_redacted_in_compiled_events() {
        let resp = r#"{"facts":["The token is sk-ABCDEF0123456789ABCDEF for the API"]}"#;
        let evs = parse_events(resp, "a", "s");
        assert_eq!(evs.len(), 1);
        assert!(evs[0].payload["text"].as_str().unwrap().contains("[REDACTED]"));
    }
}
