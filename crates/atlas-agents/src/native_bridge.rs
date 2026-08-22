//! Adapts the native agent's protocol-free events into this stack's `AcpEvent`.
//!
//! `atlas-cersei` no longer speaks a protocol version: it must stay linkable
//! from both this stack (`agent-client-protocol` 1.3) and the ported one (2.0),
//! and those can never share a Cargo graph because the protocol crate pins its
//! schema crate exactly. So the runtime emits `atlas_cersei::NativeEvent` and
//! each consumer renders it in its own version.
//!
//! This is that rendering for 1.3, and it is deliberately mechanical: the JSON
//! it deserializes is the same JSON the runtime used to deserialize itself, one
//! function earlier. Nothing about the resulting `AcpEvent`s changed.

use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp_schema;
use atlas_acp::{AcpEvent, AgentId, EventSink, SessionId};
use atlas_cersei::{
    AgentId as NativeAgentId, NativeEvent, NativeEventSink, PermissionDecision,
    PermissionOptionKind, PermissionOptionSpec, PermissionToolCall, SessionId as NativeSessionId,
};

pub fn to_native_agent_id(id: AgentId) -> NativeAgentId {
    NativeAgentId(id.0)
}

pub fn from_native_agent_id(id: NativeAgentId) -> AgentId {
    AgentId(id.0)
}

pub fn to_native_session_id(id: &SessionId) -> NativeSessionId {
    NativeSessionId::new(id.to_string())
}

pub fn from_native_session_id(id: &NativeSessionId) -> SessionId {
    SessionId::new(id.as_str().to_string())
}

pub fn to_native_decision(decision: atlas_acp::PermissionDecision) -> PermissionDecision {
    match decision {
        atlas_acp::PermissionDecision::Selected { option_id } => PermissionDecision::Selected {
            option_id: option_id.to_string(),
        },
        atlas_acp::PermissionDecision::Cancelled => PermissionDecision::Cancelled,
    }
}

pub fn to_acp_error(err: atlas_cersei::Error) -> atlas_acp::AcpError {
    use atlas_cersei::Error as E;
    match err {
        E::UnknownAgent => atlas_acp::AcpError::UnknownAgent,
        E::UnknownSession => atlas_acp::AcpError::UnknownSession,
        E::UnknownPermissionRequest(id) => atlas_acp::AcpError::UnknownPermissionRequest(id),
        E::Other(message) => atlas_acp::AcpError::Other(message),
    }
}

pub fn to_acp_new_session_info(info: atlas_cersei::NewSessionInfo) -> atlas_acp::NewSessionInfo {
    atlas_acp::NewSessionInfo {
        session_id: from_native_session_id(&info.session_id),
        modes: info.modes,
        models: info.models,
    }
}

pub fn to_acp_agent_info(info: atlas_cersei::AgentInfo) -> atlas_acp::AgentInfo {
    atlas_acp::AgentInfo {
        agent_id: from_native_agent_id(info.agent_id),
        spec_id: info.spec_id,
        display_name: info.display_name,
    }
}

fn to_acp_permission_option(option: &PermissionOptionSpec) -> acp_schema::PermissionOption {
    let kind = match option.kind {
        PermissionOptionKind::AllowOnce => acp_schema::PermissionOptionKind::AllowOnce,
        PermissionOptionKind::AllowAlways => acp_schema::PermissionOptionKind::AllowAlways,
        PermissionOptionKind::RejectOnce => acp_schema::PermissionOptionKind::RejectOnce,
    };
    acp_schema::PermissionOption::new(option.id, option.name, kind)
}

/// The same JSON the runtime used to build and decode in one step.
fn to_acp_tool_call(call: &PermissionToolCall) -> acp_schema::ToolCallUpdate {
    let v = serde_json::json!({
        "toolCallId": call.id,
        "title": call.title,
        "kind": call.kind,
        "status": "pending",
        "rawInput": call.raw_input,
    });
    serde_json::from_value(v).unwrap_or_else(|_| {
        acp_schema::ToolCallUpdate::new(
            call.id.clone(),
            acp_schema::ToolCallUpdateFields::default(),
        )
    })
}

/// Renders one [`NativeEvent`] as an [`AcpEvent`].
///
/// `None` when the payload is not a `SessionUpdate` this protocol version
/// understands — which is the failure the runtime used to log itself.
pub fn to_acp_event(event: NativeEvent) -> Option<AcpEvent> {
    Some(match event {
        NativeEvent::SessionUpdate { session_id, update } => {
            match serde_json::from_value::<acp_schema::SessionUpdate>(update) {
                Ok(update) => AcpEvent::SessionUpdate {
                    session_id: from_native_session_id(&session_id),
                    update,
                },
                Err(e) => {
                    tracing::warn!(
                        target: "atlas_agents::native_bridge",
                        "session update decode failed: {e}"
                    );
                    return None;
                }
            }
        }
        NativeEvent::PermissionRequest {
            request_id,
            session_id,
            tool_call,
            options,
        } => AcpEvent::PermissionRequest {
            request_id,
            session_id: from_native_session_id(&session_id),
            tool_call: to_acp_tool_call(&tool_call),
            options: options.iter().map(to_acp_permission_option).collect(),
        },
        NativeEvent::Usage {
            session_id,
            input_tokens,
            output_tokens,
            cost,
        } => AcpEvent::Usage {
            session_id: from_native_session_id(&session_id),
            input_tokens,
            output_tokens,
            cost,
            // The native agent reports no cache split; `None` leaves whatever an
            // ACP end-of-turn response contributed intact rather than zeroing it.
            cache_read_tokens: None,
            cache_write_tokens: None,
        },
        NativeEvent::Compaction { session_id, active } => AcpEvent::Compaction {
            session_id: from_native_session_id(&session_id),
            active,
        },
        NativeEvent::CompressionSaved {
            session_id,
            saved_tokens,
        } => AcpEvent::CompressionSaved {
            session_id: from_native_session_id(&session_id),
            saved_tokens,
        },
        NativeEvent::Retry {
            session_id,
            attempt,
            max_attempts,
            delay_ms,
            last_error,
        } => AcpEvent::Retry {
            session_id: from_native_session_id(&session_id),
            attempt,
            max_attempts,
            delay_ms,
            last_error,
        },
    })
}

/// The sink the native runtime is spawned with: converts, then forwards to the
/// host's `EventSink` unchanged.
pub struct NativeSink(pub Arc<dyn EventSink>);

impl NativeEventSink for NativeSink {
    fn emit(&self, agent_id: NativeAgentId, event: NativeEvent, turn: Option<u64>) {
        if let Some(event) = to_acp_event(event) {
            self.0.emit(from_native_agent_id(agent_id), event, turn);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_update_json_decodes_to_the_typed_update() {
        let event = NativeEvent::SessionUpdate {
            session_id: NativeSessionId::new("s1"),
            update: serde_json::json!({
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "hi" },
            }),
        };
        let AcpEvent::SessionUpdate { session_id, update } =
            to_acp_event(event).expect("known update shape")
        else {
            panic!("expected a session update");
        };
        assert_eq!(session_id.to_string(), "s1");
        assert_eq!(
            serde_json::to_value(update).unwrap()["sessionUpdate"],
            "agent_message_chunk"
        );
    }

    #[test]
    fn undecodable_session_update_is_dropped_not_panicked() {
        let event = NativeEvent::SessionUpdate {
            session_id: NativeSessionId::new("s1"),
            update: serde_json::json!({ "sessionUpdate": "not_a_real_variant" }),
        };
        assert!(to_acp_event(event).is_none());
    }

    #[test]
    fn permission_request_carries_the_tool_call_and_all_three_options() {
        let event = NativeEvent::PermissionRequest {
            request_id: uuid::Uuid::new_v4(),
            session_id: NativeSessionId::new("s1"),
            tool_call: PermissionToolCall {
                id: "t1".into(),
                title: "Bash".into(),
                kind: "execute",
                raw_input: serde_json::json!({ "command": "ls" }),
            },
            options: vec![
                PermissionOptionSpec {
                    id: "allow_once",
                    name: "Allow once",
                    kind: PermissionOptionKind::AllowOnce,
                },
                PermissionOptionSpec {
                    id: "allow_always",
                    name: "Allow for this session",
                    kind: PermissionOptionKind::AllowAlways,
                },
                PermissionOptionSpec {
                    id: "reject",
                    name: "Reject",
                    kind: PermissionOptionKind::RejectOnce,
                },
            ],
        };
        let AcpEvent::PermissionRequest {
            tool_call, options, ..
        } = to_acp_event(event).expect("permission request")
        else {
            panic!("expected a permission request");
        };
        assert_eq!(tool_call.tool_call_id.to_string(), "t1");
        let ids: Vec<String> = options
            .iter()
            .map(|o| o.option_id.to_string())
            .collect();
        assert_eq!(ids, ["allow_once", "allow_always", "reject"]);
    }
}
