//! Recovers the LEGACY `session/new` / `session/load` `models` blob straight
//! off the JSON-RPC wire.
//!
//! Why this exists: `agent-client-protocol`'s v1 `NewSessionResponse` no longer
//! has a `models` field — ACP moved model selection into `configOptions`, and
//! the typed struct silently DROPS the older top-level `models` object during
//! deserialisation. Several shipped agents are still on the old dialect
//! (OpenCode 1.3.x, Cursor), so their model lists never reached the UI and the
//! composer's model picker simply didn't render — "OpenCode cannot change
//! models".
//!
//! Rather than fork the schema, we tap the driver's raw-line debug hook
//! ([`AcpAgent::with_debug`]): remember the JSON-RPC ids of outgoing
//! `session/new` / `session/load` requests, then pull `result.models` off the
//! matching response before serde ever sees it. The blob is already in the
//! `{ currentModelId, availableModels: [{modelId, name, description}] }` shape
//! the rest of the pipeline expects, so it drops straight into the same slot
//! the config-options normaliser fills for newer agents.
//!
//! Selection still goes out over `session/set_model`, which is exactly what
//! these agents implement (see `AcpBackend::set_session_model`'s ladder).

use dashmap::DashMap;
use serde_json::Value;

/// A JSON-RPC id, normalised to a string so numeric and string ids share a key.
fn id_key(id: &Value) -> Option<String> {
    match id {
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) => Some(s.clone()),
        _ => None,
    }
}

/// Per-agent capture of legacy `models` blobs, keyed by ACP session id.
#[derive(Default)]
pub struct ModelSniffer {
    /// In-flight `session/new` (`None`) and `session/load` (`Some(sessionId)`)
    /// request ids. `session/load` responses carry no session id of their own,
    /// so we stash the one from the REQUEST params.
    pending: DashMap<String, Option<String>>,
    /// sessionId → legacy `models` blob, awaiting collection by the registry.
    captured: DashMap<String, Value>,
}

impl ModelSniffer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one raw line written TO the agent (stdin).
    pub fn observe_outgoing(&self, line: &str) {
        // Substring pre-filter before the full parse: this hook sees EVERY
        // stdin line for the life of the agent, and only two lifecycle methods
        // ever matter. (The method name appears verbatim in the frame, so the
        // filter can't miss; a rare false positive just pays the old parse.)
        if !line.contains("session/new") && !line.contains("session/load") {
            return;
        }
        let Ok(msg) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let method = msg.get("method").and_then(Value::as_str).unwrap_or_default();
        if method != "session/new" && method != "session/load" {
            return;
        }
        let Some(id) = msg.get("id").and_then(id_key) else {
            return;
        };
        let session_id = msg
            .get("params")
            .and_then(|p| p.get("sessionId"))
            .and_then(Value::as_str)
            .map(str::to_string);
        // Bound the map: a wedged agent that never answers would otherwise leak
        // one entry per request. Two lifecycle RPCs in flight at once is already
        // generous; anything beyond that is a stuck adapter.
        if self.pending.len() > 32 {
            self.pending.clear();
        }
        self.pending.insert(id, session_id);
    }

    /// Feed one raw line read FROM the agent (stdout). Captures the legacy
    /// `models` blob when the line answers a session/new or session/load we saw.
    pub fn observe_incoming(&self, line: &str) {
        // ~Always empty outside an in-flight session/new|load — skipping the
        // full-DOM parse here removes a duplicate parse of every streaming
        // frame (the ACP client parses the same line again for dispatch).
        if self.pending.is_empty() {
            return;
        }
        let Ok(msg) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let Some(id) = msg.get("id").and_then(id_key) else {
            return;
        };
        let Some((_, req_session_id)) = self.pending.remove(&id) else {
            return;
        };
        let Some(result) = msg.get("result") else {
            return; // error response — nothing to capture
        };
        let Some(models) = result.get("models") else {
            return; // config-options dialect (or no model selection at all)
        };
        if !models.is_object() {
            return;
        }
        // `session/new` answers with the id it just minted; `session/load`
        // echoes nothing, so fall back to the id we sent in the request.
        let session_id = result
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or(req_session_id);
        let Some(session_id) = session_id else {
            return;
        };
        tracing::debug!(
            target: "atlas_acp::model_sniff",
            session = %session_id,
            "captured legacy `models` blob off the wire"
        );
        // Only `new_session` collects from here today, so blobs captured on a
        // `session/load` are never taken. Bound the map so a long-lived agent
        // process resuming many sessions can't accumulate them without limit.
        if self.captured.len() > 64 {
            self.captured.clear();
        }
        self.captured.insert(session_id, models.clone());
    }

    /// Take the captured blob for `session_id`, if the agent sent one. Consumed
    /// on read — the registry folds it into the session's `NewSessionInfo` and
    /// the UI caches it from there.
    pub fn take(&self, session_id: &str) -> Option<Value> {
        self.captured.remove(session_id).map(|(_, v)| v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verbatim shape of the legacy blob OpenCode 1.3.x returns from
    /// `session/new` — the one the typed `NewSessionResponse` throws away.
    fn opencode_new_session_response(id: i64) -> String {
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "sessionId": "ses_abc123",
                "modes": {
                    "currentModeId": "build",
                    "availableModes": [{"id": "build", "name": "build"}]
                },
                "models": {
                    "currentModelId": "opencode/grok-code",
                    "availableModels": [
                        {"modelId": "opencode/grok-code", "name": "Grok Code"},
                        {"modelId": "anthropic/claude-opus-5", "name": "Claude Opus 5"}
                    ]
                }
            }
        })
        .to_string()
    }

    #[test]
    fn captures_legacy_models_from_session_new() {
        let s = ModelSniffer::new();
        s.observe_outgoing(r#"{"jsonrpc":"2.0","id":3,"method":"session/new","params":{"cwd":"/x"}}"#);
        s.observe_incoming(&opencode_new_session_response(3));
        let blob = s.take("ses_abc123").expect("models captured");
        assert_eq!(blob["currentModelId"], "opencode/grok-code");
        assert_eq!(blob["availableModels"].as_array().unwrap().len(), 2);
        // Consumed on read.
        assert!(s.take("ses_abc123").is_none());
    }

    #[test]
    fn session_load_keys_off_the_request_session_id() {
        let s = ModelSniffer::new();
        s.observe_outgoing(
            r#"{"jsonrpc":"2.0","id":"7","method":"session/load","params":{"sessionId":"ses_old","cwd":"/x"}}"#,
        );
        s.observe_incoming(
            r#"{"jsonrpc":"2.0","id":"7","result":{"models":{"currentModelId":"m1","availableModels":[{"modelId":"m1","name":"M1"}]}}}"#,
        );
        assert_eq!(s.take("ses_old").unwrap()["currentModelId"], "m1");
    }

    #[test]
    fn ignores_unrelated_traffic() {
        let s = ModelSniffer::new();
        // A notification (no id) and a response to a request we never tracked.
        s.observe_outgoing(r#"{"jsonrpc":"2.0","method":"session/prompt","params":{}}"#);
        s.observe_incoming(&opencode_new_session_response(99));
        assert!(s.take("ses_abc123").is_none());
        // Non-JSON lines (banner text on stdout) must not panic.
        s.observe_incoming("opencode v1.3.15");
        s.observe_outgoing("");
    }

    #[test]
    fn error_response_captures_nothing() {
        let s = ModelSniffer::new();
        s.observe_outgoing(r#"{"jsonrpc":"2.0","id":1,"method":"session/new","params":{}}"#);
        s.observe_incoming(r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"nope"}}"#);
        assert!(s.take("ses_abc123").is_none());
    }
}
