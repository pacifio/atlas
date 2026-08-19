//! Streaming live output from a client-served terminal into the transcript
//! (P1.4, `plans/atlas-acp-parity-loop.md`).
//!
//! P1.2 made Atlas serve `terminal/*`, so an agent's command now runs on a PTY
//! the host owns. But an agent using the spec path reports the command as a tool
//! call whose content is just `ToolCallContent::Terminal { terminalId }` — an
//! id, not text — and the id alone renders as nothing. Meanwhile the *output*
//! sits in `CommandTerminals`, which only this crate can reach.
//!
//! Rather than invent a rendering path, this bridges the spec path onto the one
//! that already works. `claude-agent-acp` and `codex-acp` stream live output via
//! a proprietary `_meta.terminal_output` contract that `atlas-agents`' apply
//! layer already folds into a tool call's visible result as it runs. So when a
//! terminal-shaped tool call appears, a pump task tails the terminal and emits
//! synthetic `tool_call_update`s carrying exactly that `_meta` shape. The
//! transcript renders spec terminals and `_meta` terminals identically, with no
//! UI change at all.
//!
//! ## Why a pump rather than reading on each update
//!
//! An agent typically announces the tool call once, calls
//! `terminal/wait_for_exit`, and only updates the call when the command has
//! finished. Reading output only when an update happens to arrive would show a
//! two-minute build as nothing, then everything. The pump makes output arrive
//! while the command runs, which is the entire point of a live terminal.

use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    SessionId, SessionUpdate, ToolCallId, ToolCallUpdate, ToolCallUpdateFields,
};
use atlas_terminal::command::CommandTerminals;
use dashmap::DashSet;

use crate::events::{AcpEvent, EventSink};
use crate::registry::AgentId;

/// How often the pump checks for new bytes. Fast enough to read as live,
/// slow enough that a chatty command does not flood the IPC channel — the
/// quadratic-IPC defect `apply.rs` guards against is caused by exactly this kind
/// of high-frequency tool-call traffic.
const POLL: Duration = Duration::from_millis(200);

/// Tool calls already being pumped, so repeated `tool_call_update`s for the same
/// call do not start a second tail (which would duplicate every byte).
pub type PumpedCalls = Arc<DashSet<String>>;

/// The `(toolCallId, terminalId)` pairs a session update refers to.
///
/// Uses a JSON round-trip rather than matching the typed enum: `SessionUpdate`
/// and `ToolCallContent` are both `#[non_exhaustive]`, and the apply layer reads
/// these same fields as JSON already, so this stays consistent with how the rest
/// of the pipeline sees a tool call.
#[must_use]
pub fn terminal_refs(update: &SessionUpdate) -> Vec<(String, String)> {
    let Ok(v) = serde_json::to_value(update) else {
        return Vec::new();
    };
    let Some(tool_call_id) = v.get("toolCallId").and_then(|s| s.as_str()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    collect(v.get("content"), tool_call_id, &mut out);
    out
}

fn collect(value: Option<&serde_json::Value>, tool_call_id: &str, out: &mut Vec<(String, String)>) {
    match value {
        Some(serde_json::Value::Array(arr)) => {
            for item in arr {
                collect(Some(item), tool_call_id, out);
            }
        }
        Some(serde_json::Value::Object(o)) => {
            if o.get("type").and_then(|t| t.as_str()) == Some("terminal") {
                if let Some(id) = o.get("terminalId").and_then(|t| t.as_str()) {
                    out.push((tool_call_id.to_string(), id.to_string()));
                }
            } else if let Some(inner) = o.get("content") {
                collect(Some(inner), tool_call_id, out);
            }
        }
        _ => {}
    }
}

/// Start tailing `terminal_id` into `tool_call_id`, unless it is already tailed.
#[allow(clippy::too_many_arguments)]
pub fn spawn(
    pumped: &PumpedCalls,
    terminals: &Arc<CommandTerminals>,
    sink: Arc<dyn EventSink>,
    agent_id: AgentId,
    session_id: SessionId,
    turn: Option<u64>,
    tool_call_id: String,
    terminal_id: String,
) {
    // `insert` returns false when the key was already present — one pump per
    // tool call, whatever the agent re-sends.
    if !pumped.insert(tool_call_id.clone()) {
        return;
    }
    let Some(terminal) = terminals.get(&terminal_id) else {
        // Released or never created. Nothing to tail; drop the reservation so a
        // later update for the same call can still start one.
        pumped.remove(&tool_call_id);
        return;
    };
    let pumped = pumped.clone();
    tokio::spawn(async move {
        let mut sent = 0usize;
        loop {
            let (full, _truncated) = terminal.output();
            let exited = terminal.exit_status().is_some();
            // Truncation drops bytes off the FRONT, so the buffer can shrink
            // relative to what was already forwarded. Re-anchoring to the end
            // (rather than slicing at a stale offset) is what stops a long
            // command from replaying its whole tail once the cap is hit.
            if full.len() < sent {
                sent = full.len();
            }
            if full.len() > sent {
                // Never split a character: `sent` is a byte offset into a
                // String, and slicing off a boundary panics.
                let mut start = sent;
                while start < full.len() && !full.is_char_boundary(start) {
                    start += 1;
                }
                let delta = full[start..].to_string();
                sent = full.len();
                if !delta.is_empty() {
                    sink.emit(agent_id, chunk_event(&session_id, &tool_call_id, delta), turn);
                }
            }
            if exited {
                break;
            }
            tokio::time::sleep(POLL).await;
        }
        pumped.remove(&tool_call_id);
    });
}

/// A `tool_call_update` carrying one output chunk in the `_meta` shape the apply
/// layer already streams.
fn chunk_event(session_id: &SessionId, tool_call_id: &str, data: String) -> AcpEvent {
    let mut update = ToolCallUpdate::new(
        ToolCallId::new(tool_call_id),
        ToolCallUpdateFields::default(),
    );
    let mut meta = serde_json::Map::new();
    meta.insert(
        "terminal_output".into(),
        serde_json::json!({ "data": data }),
    );
    update.meta = Some(meta);
    AcpEvent::SessionUpdate {
        session_id: session_id.clone(),
        update: SessionUpdate::ToolCallUpdate(update),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn update_from(json: serde_json::Value) -> SessionUpdate {
        serde_json::from_value(json).expect("valid SessionUpdate")
    }

    #[test]
    fn a_terminal_block_is_found_in_a_tool_call() {
        let update = update_from(serde_json::json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "call-1",
            "title": "npm test",
            "content": [{ "type": "terminal", "terminalId": "term_9" }],
        }));
        assert_eq!(
            terminal_refs(&update),
            vec![("call-1".to_string(), "term_9".to_string())]
        );
    }

    #[test]
    fn a_tool_call_without_a_terminal_yields_nothing() {
        let update = update_from(serde_json::json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "call-1",
            "title": "npm test",
            "content": [{ "type": "content", "content": { "type": "text", "text": "hi" } }],
        }));
        assert!(terminal_refs(&update).is_empty());
    }

    #[test]
    fn a_non_tool_update_yields_nothing() {
        let update = update_from(serde_json::json!({
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": "hello" },
        }));
        assert!(terminal_refs(&update).is_empty());
    }

    /// The pump must key off the tool call, so an agent re-announcing the same
    /// call does not start a second tail and double every byte.
    #[test]
    fn the_same_tool_call_is_only_reserved_once() {
        let pumped: PumpedCalls = Arc::new(DashSet::new());
        assert!(pumped.insert("call-1".to_string()));
        assert!(!pumped.insert("call-1".to_string()));
    }

    #[test]
    fn the_chunk_event_carries_the_meta_shape_the_apply_layer_reads() {
        let event = chunk_event(&SessionId::new("s1"), "call-1", "output line".into());
        let AcpEvent::SessionUpdate { update, .. } = event else {
            panic!("expected a session update");
        };
        let v = serde_json::to_value(&update).unwrap();
        assert_eq!(v["sessionUpdate"], "tool_call_update");
        assert_eq!(v["toolCallId"], "call-1");
        // This exact path is what `apply.rs` reads to append live output.
        assert_eq!(v["_meta"]["terminal_output"]["data"], "output line");
    }

    /// End-to-end against a real command: the pump must deliver the output of a
    /// process that writes AFTER the tool call was announced.
    #[tokio::test]
    async fn the_pump_streams_output_of_a_running_command() {
        use atlas_terminal::command::{CommandTerminal, DEFAULT_OUTPUT_BYTE_LIMIT};
        use std::sync::Mutex;

        #[derive(Default)]
        struct Collector(Mutex<Vec<String>>);
        impl EventSink for Collector {
            fn emit(&self, _agent: AgentId, event: AcpEvent, _turn: Option<u64>) {
                if let AcpEvent::SessionUpdate { update, .. } = event {
                    let v = serde_json::to_value(&update).unwrap();
                    if let Some(d) = v["_meta"]["terminal_output"]["data"].as_str() {
                        self.0.lock().unwrap().push(d.to_string());
                    }
                }
            }
        }

        let terminals: Arc<CommandTerminals> = Arc::new(CommandTerminals::new());
        let term = CommandTerminal::spawn(
            "/bin/sh",
            &["-c".into(), "printf pumped-ok".into()],
            &[],
            None,
            DEFAULT_OUTPUT_BYTE_LIMIT,
        )
        .expect("spawn");
        let terminal_id = terminals.insert("s1", term);

        let sink = Arc::new(Collector::default());
        let pumped: PumpedCalls = Arc::new(DashSet::new());
        spawn(
            &pumped,
            &terminals,
            sink.clone(),
            AgentId::new(),
            SessionId::new("s1"),
            None,
            "call-1".to_string(),
            terminal_id,
        );

        // The pump exits on its own once the command does.
        for _ in 0..100 {
            if !sink.0.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let joined = sink.0.lock().unwrap().join("");
        assert!(joined.contains("pumped-ok"), "got {joined:?}");
    }

    #[tokio::test]
    async fn an_unknown_terminal_starts_no_pump_and_frees_the_reservation() {
        let terminals: Arc<CommandTerminals> = Arc::new(CommandTerminals::new());
        let pumped: PumpedCalls = Arc::new(DashSet::new());

        struct Silent;
        impl EventSink for Silent {
            fn emit(&self, _: AgentId, _: AcpEvent, _: Option<u64>) {}
        }

        spawn(
            &pumped,
            &terminals,
            Arc::new(Silent),
            AgentId::new(),
            SessionId::new("s1"),
            None,
            "call-1".to_string(),
            "term_missing".to_string(),
        );
        assert!(
            !pumped.contains("call-1"),
            "a released terminal must not leave the call permanently un-pumpable"
        );
    }
}
