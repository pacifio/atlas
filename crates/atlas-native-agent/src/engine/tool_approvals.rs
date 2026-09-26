//! Outward actions: the engine's ask before a prompted tool on one of Atlas's
//! own servers, through the approval card (ADR-0014).
//!
//! A tool projected with a per-tool `prompt` (the offer's
//! [`atlas_agent_servers::AskFirst`], projected by `engine::mcp`) stops
//! the engine before the call. The engine does not ask with one of the three
//! approval requests the seam already serves; it asks with an **MCP
//! elicitation** it originates itself — `mcpServer/elicitation/request`, a
//! form with an empty schema and `_meta.atlas_agent_approval_kind =
//! "mcp_tool_call"` (`vendor/atlas-engine/core/src/mcp_tool_call.rs`,
//! `request_mcp_tool_user_approval`, with `tool_call_mcp_elicitation` on by
//! default). This module recognises that one form and nothing else, and joins
//! it to the approval card.
//!
//! # Only the engine's own ask, never a tool server's (ADR-0013)
//!
//! A tool server may send an elicitation too, and ADR-0013 keeps those
//! refused: a server Atlas offers returns candidates and the model asks. The
//! app-server gives the client no request id to tell the two apart, and a
//! server can put any `_meta` it likes on its own elicitation. What it cannot
//! do is be one of the servers the host offered this thread while also being
//! a server that elicits: Atlas's own servers never elicit, so an approval-kind
//! form naming one of them can only be the engine asking about a call to it.
//! That is the whole test ([`is_engine_tool_approval`]); anything else is
//! refused exactly as before.
//!
//! # What the card shows
//!
//! The elicitation says which server and which arguments, not which tool, and
//! not whom the call reaches. The tool comes from the call itself: the engine
//! announces the call (`item/started`, applied to the thread on the pump
//! before this request is handled) and then asks, so the call waiting on the
//! thread with this server and these exact arguments is the one being asked
//! about ([`waiting_call`]). Whom it reaches is the host's to say — a comment
//! id is not a person — so the host describes it
//! ([`atlas_agent_servers::SessionMcpServers::describe_call`]): a title naming
//! the act and the recipient, the recipient in full, and the full body. The
//! card attaches to the call's own row, as a command approval does to its
//! command, and keeps the row's tool name so the row still reads as the call.
//!
//! # Allow for this session
//!
//! The engine keeps no session approval for a `prompt` tool — its session key
//! exists only for `auto` tools, and it folds "allow for session" into a plain
//! allow for `prompt` (`normalize_approval_decision_for_mode`). So the seam
//! remembers it: after "Allow for this session", the next call to the same
//! tool in the same session is answered yes with no card, and the engine still
//! asked, so the audit row and the engine's own record are unchanged.
//!
//! # The approval is recorded for the tool server
//!
//! The engine's ask is not the only gate: in bypass mode it approves every
//! prompted tool itself and never asks. So each call the user does approve —
//! on its card, or covered by "Allow for this session" — is reported to the
//! host ([`atlas_agent_servers::SessionMcpServers::approved_call`]) just before
//! the engine hears yes, and the host's server posts only a call it finds
//! approved ([`atlas_agent_servers::OutwardConsent`]). A call the engine ran
//! unasked was never reported, and is refused there.
//!
//! # A rejection
//!
//! Decline is `action: decline`; the engine answers the model "user rejected
//! MCP tool call" as the call's error and never calls the tool. Dismissing the
//! card is `cancel`; the engine does the same with "user cancelled MCP tool
//! call".

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::{AcpThread, AgentThreadEntry};
use atlas_agent_servers::CallDescription;
use atlas_engine_app_server_protocol as v2;
use serde_json::{json, Value as JsonValue};

use super::approvals::Decision;

/// The engine's marker for its own approval of an MCP tool call
/// (`atlas_engine_protocol::mcp_approval_meta`), spelled out because the
/// protocol crate is not this module's to depend on for two strings.
const APPROVAL_KIND_KEY: &str = "atlas_agent_approval_kind";
const APPROVAL_KIND_MCP_TOOL_CALL: &str = "mcp_tool_call";
/// Where the engine puts the call's arguments on that approval.
const TOOL_PARAMS_KEY: &str = "tool_params";

/// Whether `request` is the engine asking to approve a call to `server`'s tool,
/// rather than a tool server asking the user something. `offered` says whether
/// `server` is one the host offered this thread — which never elicits.
pub fn is_engine_tool_approval(request: &v2::McpServerElicitationRequestParams, offered: bool) -> bool {
    let v2::McpServerElicitationRequest::Form { meta, requested_schema, .. } = &request.request else {
        return false;
    };
    let approval = meta
        .as_ref()
        .and_then(|meta| meta.get(APPROVAL_KIND_KEY))
        .and_then(JsonValue::as_str)
        == Some(APPROVAL_KIND_MCP_TOOL_CALL);
    // The engine's approval asks for nothing but the answer itself.
    let asks_nothing = serde_json::to_value(requested_schema)
        .ok()
        .and_then(|schema| schema.get("properties").cloned())
        .is_none_or(|properties| properties.as_object().is_none_or(serde_json::Map::is_empty));
    offered && approval && asks_nothing
}

/// The arguments the engine is asking about, as the tool will receive them.
pub fn arguments(request: &v2::McpServerElicitationRequestParams) -> JsonValue {
    match &request.request {
        v2::McpServerElicitationRequest::Form { meta, .. } => meta
            .as_ref()
            .and_then(|meta| meta.get(TOOL_PARAMS_KEY))
            .cloned()
            .unwrap_or(JsonValue::Null),
        _ => JsonValue::Null,
    }
}

/// The call the engine is asking about: the newest call on `thread` to one of
/// `server`'s tools, still running, with exactly these arguments. Its row id
/// and the tool's bare name. The native seam titles an MCP call
/// `<server>.<tool>` (`engine::sink`).
pub fn waiting_call(thread: &AcpThread, server: &str, arguments: &JsonValue) -> Option<(acp::ToolCallId, String)> {
    let prefix = format!("{server}.");
    thread.entries().iter().rev().find_map(|entry| {
        let AgentThreadEntry::ToolCall(call) = entry else {
            return None;
        };
        let tool = call.label.strip_prefix(&prefix)?;
        let running = call.status.as_acp_status() == Some(acp::ToolCallStatus::InProgress);
        let same = call.raw_input.as_ref().unwrap_or(&JsonValue::Null) == arguments;
        (running && same && !tool.is_empty()).then(|| (call.id.clone(), tool.to_string()))
    })
}

/// The update that puts the card on the call's row: the host's title, the
/// recipient and the full body as its content, and the row's tool name kept
/// as `<server>.<tool>` so the row still reads as the call while the title
/// names the act. With no description the row keeps its own title and the
/// card shows the call's arguments.
pub fn card(id: acp::ToolCallId, server: &str, tool: &str, description: Option<CallDescription>) -> acp::ToolCallUpdate {
    let mut fields = acp::ToolCallUpdateFields::default();
    if let Some(description) = description {
        fields.title = Some(description.title);
        fields.content = Some(
            [description.recipient, description.body]
                .into_iter()
                .map(|text| acp::ToolCallContent::Content(acp::Content::new(acp::ContentBlock::Text(acp::TextContent::new(text)))))
                .collect(),
        );
    }
    let mut meta = acp::Meta::new();
    meta.insert(atlas_acp_thread::TOOL_NAME_META_KEY.to_string(), json!(format!("{server}.{tool}")));
    acp::ToolCallUpdate::new(id, fields).meta(meta)
}

/// The engine's answer for what the user chose. Allow for this session is a
/// plain accept to the engine (it keeps no session approval for a `prompt`
/// tool); the seam remembers it instead.
pub fn response(decision: Decision) -> JsonValue {
    let action = match decision {
        Decision::Accept | Decision::AcceptForSession => v2::McpServerElicitationAction::Accept,
        Decision::Decline => v2::McpServerElicitationAction::Decline,
        Decision::Cancel => v2::McpServerElicitationAction::Cancel,
    };
    let accepted = matches!(action, v2::McpServerElicitationAction::Accept);
    serde_json::to_value(v2::McpServerElicitationRequestResponse {
        action,
        // An accept carries an empty form: the engine's approval asks nothing.
        content: accepted.then(|| json!({})),
        meta: None,
    })
    .unwrap_or(JsonValue::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approval(meta: JsonValue, properties: JsonValue) -> v2::McpServerElicitationRequestParams {
        serde_json::from_value(json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "serverName": "atlas_org",
            "mode": "form",
            "_meta": meta,
            "message": "Allow the atlas_org MCP server to run tool \"org_comment_reply\"?",
            "requestedSchema": { "type": "object", "properties": properties },
        }))
        .expect("an elicitation")
    }

    fn engine_meta() -> JsonValue {
        json!({
            "atlas_agent_approval_kind": "mcp_tool_call",
            "tool_params": { "comment": "k1", "body": "Done." },
        })
    }

    #[test]
    fn the_engines_own_approval_for_an_offered_server_is_recognised() {
        let request = approval(engine_meta(), json!({}));
        assert!(is_engine_tool_approval(&request, true));
        assert_eq!(arguments(&request), json!({ "comment": "k1", "body": "Done." }));
    }

    #[test]
    fn the_same_form_naming_a_server_atlas_did_not_offer_is_not() {
        // A third-party server can forge the marker; it cannot be an offered
        // server of Atlas's, which never elicits.
        assert!(!is_engine_tool_approval(&approval(engine_meta(), json!({})), false));
    }

    #[test]
    fn a_form_without_the_marker_or_that_asks_for_input_is_a_tool_server_talking() {
        assert!(!is_engine_tool_approval(&approval(json!({}), json!({})), true));
        assert!(!is_engine_tool_approval(
            &approval(engine_meta(), json!({ "channel": { "type": "string" } })),
            true
        ));
        let url: v2::McpServerElicitationRequestParams = serde_json::from_value(json!({
            "threadId": "thread-1",
            "serverName": "atlas_org",
            "mode": "url",
            "_meta": engine_meta(),
            "message": "Sign in",
            "url": "https://example.com",
            "elicitationId": "e-1",
        }))
        .expect("an elicitation");
        assert!(!is_engine_tool_approval(&url, true));
    }

    #[test]
    fn each_answer_is_the_engines_own_elicitation_response() {
        assert_eq!(response(Decision::Accept), json!({ "action": "accept", "content": {}, "_meta": null }));
        assert_eq!(response(Decision::AcceptForSession), response(Decision::Accept));
        assert_eq!(response(Decision::Decline), json!({ "action": "decline", "content": null, "_meta": null }));
        assert_eq!(response(Decision::Cancel), json!({ "action": "cancel", "content": null, "_meta": null }));
    }

    #[test]
    fn the_card_carries_the_title_recipient_and_full_body_and_keeps_the_rows_tool_name() {
        let body = "Renamed it.\n".repeat(400);
        let update = card(
            acp::ToolCallId::new("call-1"),
            "atlas_org",
            "org_comment_reply",
            Some(CallDescription {
                title: "Reply on Sam Lee's comment".into(),
                recipient: "Sam Lee, on their comment".into(),
                body: body.clone(),
            }),
        );
        let wire = serde_json::to_value(&update).expect("serialises");
        assert_eq!(wire["title"], "Reply on Sam Lee's comment");
        assert_eq!(wire["content"][0]["content"]["text"], "Sam Lee, on their comment");
        assert_eq!(wire["content"][1]["content"]["text"], body.as_str(), "never shortened");
        assert_eq!(wire["_meta"]["tool_name"], "atlas_org.org_comment_reply");
    }

    #[test]
    fn with_no_description_the_row_keeps_its_own_title() {
        let update = card(acp::ToolCallId::new("call-1"), "atlas_org", "org_comment_reply", None);
        assert!(update.fields.title.is_none());
        assert!(update.fields.content.is_none());
    }
}
