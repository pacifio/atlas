//! The wire is what `docs/agents/delta-wire-contract.md` says it is.
//!
//! The contract doc is not a description of this code — it is the agreement the
//! Timeline, the capture record, analytics, transcripts, memory ingest and the
//! whole chat UI were written against, and the port's top risk is this enum
//! drifting away from it (research §D12-1). So the test reads the document and
//! compares it to the real serialisation, in both directions: a variant or
//! field that exists in one and not the other fails here.

use std::collections::{BTreeMap, BTreeSet};

use atlas_agent_wire::{
    AgentId, Message, MessageMode, MessageRole, PlanEntry, SessionDelta, SessionDeltaEnvelope,
    SessionStatus, ToolCall, ToolCallStatus, ToolContentBlock, Usage,
};
use uuid::Uuid;

/// The contract, as this test asserts it.
///
/// Written out here rather than only in the document because `docs/*.md` is
/// git-ignored in this repository (working notes), so a check that only read
/// the file would silently pass in CI, which is the one place it has to hold.
/// [`documented`] cross-checks this against the document whenever the document
/// is present, so the two cannot drift apart unnoticed.
fn expected() -> BTreeMap<String, BTreeSet<String>> {
    [
        ("status", &["status", "turn_seq"][..]),
        ("message_appended", &["message"]),
        ("text_chunk", &["message_id", "delta"]),
        ("thinking_chunk", &["message_id", "delta"]),
        ("tool_call_upserted", &["message_id", "tool_call"]),
        (
            "tool_call_output_chunk",
            &["message_id", "tool_call_id", "delta"],
        ),
        ("plan_updated", &["plan"]),
        ("mode_changed", &["mode_id"]),
        (
            "retry_status",
            &["attempt", "max_attempts", "delay_ms", "last_error"],
        ),
        ("model_changed", &["model_id"]),
        ("available_commands", &["commands"]),
        ("usage_updated", &["usage"]),
        (
            "elicitation_requested",
            &["request_id", "mode", "message", "requested_schema", "url"],
        ),
        ("title_updated", &["title"]),
        ("config_options_updated", &["config_options"]),
        ("context_usage", &["used", "size", "cost"]),
        ("compaction", &["active"]),
        ("compression_saved", &["saved_tokens"]),
        ("permission_request", &["request_id", "tool_call", "options"]),
        ("permission_resolved", &["request_id"]),
        ("turn_finished", &["stop_reason", "turn_seq"]),
        ("turn_failed", &["error", "turn_seq", "error_kind"]),
        ("agent_disconnected", &["reason"]),
    ]
    .into_iter()
    .map(|(kind, fields)| {
        (
            kind.to_string(),
            fields.iter().map(std::string::ToString::to_string).collect(),
        )
    })
    .collect()
}

/// The same table, read out of the contract doc — `None` when the doc is not
/// checked out (it is git-ignored; see [`expected`]).
fn documented() -> Option<BTreeMap<String, BTreeSet<String>>> {
    let doc = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../docs/agents/delta-wire-contract.md"
    ))
    .ok()?;

    // The variant table is the run of table rows after its heading.
    let body = doc
        .split("## Rust `SessionDelta`")
        .nth(1)
        .expect("the variant table's heading");
    let table: Vec<&str> = body
        .lines()
        .skip_while(|line| !line.starts_with('|'))
        .take_while(|line| line.starts_with('|'))
        .collect();
    assert!(
        table.len() > 20,
        "the variant table did not parse: {} rows",
        table.len()
    );

    let mut out = BTreeMap::new();
    for line in table {
        let cells: Vec<&str> = line.split('|').map(str::trim).collect();
        // `| kind | fields | notes |` → ["", kind, fields, notes, ""]
        if cells.len() < 4 {
            continue;
        }
        let kind = cells[1].trim_matches('`');
        if kind.is_empty() || kind == "`kind`" || kind.starts_with("---") || kind == "kind" {
            continue;
        }
        let fields = cells[2]
            .split(',')
            .filter_map(|field| {
                let field = field.trim().trim_matches('`');
                let name = field.split(':').next()?.trim().trim_matches('`');
                (!name.is_empty()).then(|| name.to_string())
            })
            .collect::<BTreeSet<String>>();
        out.insert(kind.to_string(), fields);
    }
    Some(out)
}

/// One sample of every variant, with every skippable field present so the
/// documented shape is fully exercised.
fn samples() -> Vec<SessionDelta> {
    let request_id = Uuid::nil();
    vec![
        SessionDelta::Status {
            status: SessionStatus::Running,
            turn_seq: 3,
        },
        SessionDelta::MessageAppended {
            message: sample_message(),
        },
        SessionDelta::TextChunk {
            message_id: "msg-1".into(),
            delta: "hello".into(),
        },
        SessionDelta::ThinkingChunk {
            message_id: "msg-1".into(),
            delta: "hmm".into(),
        },
        SessionDelta::ToolCallUpserted {
            message_id: "msg-1".into(),
            tool_call: sample_tool_call(),
        },
        SessionDelta::ToolCallOutputChunk {
            message_id: "msg-1".into(),
            tool_call_id: "call-1".into(),
            delta: "line\n".into(),
        },
        SessionDelta::PlanUpdated {
            plan: vec![PlanEntry {
                content: "do the thing".into(),
                priority: Some("medium".into()),
                status: "pending".into(),
            }],
        },
        SessionDelta::ModeChanged {
            mode_id: "plan".into(),
        },
        SessionDelta::RetryStatus {
            attempt: 1,
            max_attempts: 3,
            delay_ms: 500,
            last_error: "overloaded".into(),
        },
        SessionDelta::ModelChanged {
            model_id: "anthropic/claude".into(),
        },
        SessionDelta::AvailableCommands {
            commands: vec![serde_json::json!({ "name": "login" })],
        },
        SessionDelta::UsageUpdated {
            usage: Usage {
                input_tokens: 10,
                output_tokens: 20,
                cache_creation_tokens: 1,
                cache_read_tokens: 2,
                cost: 0.5,
            },
        },
        SessionDelta::ElicitationRequested {
            request_id,
            mode: "form".into(),
            message: "which one?".into(),
            requested_schema: Some(serde_json::json!({ "type": "object" })),
            url: Some("https://example.invalid".into()),
        },
        SessionDelta::TitleUpdated {
            title: "a session".into(),
        },
        SessionDelta::ConfigOptionsUpdated {
            config_options: vec![serde_json::json!({ "id": "thinking" })],
        },
        SessionDelta::ContextUsage {
            used: 100,
            size: 200_000,
            cost: 0.25,
        },
        SessionDelta::Compaction { active: true },
        SessionDelta::CompressionSaved { saved_tokens: 42 },
        SessionDelta::PermissionRequest {
            request_id,
            tool_call: serde_json::json!({ "toolCallId": "call-1" }),
            options: serde_json::json!([{ "optionId": "allow_once" }]),
        },
        SessionDelta::PermissionResolved { request_id },
        SessionDelta::TurnFinished {
            stop_reason: "end_turn".into(),
            turn_seq: 3,
        },
        SessionDelta::TurnFailed {
            error: "boom".into(),
            turn_seq: 3,
            error_kind: Some("transient".into()),
        },
        SessionDelta::AgentDisconnected {
            reason: "process died".into(),
        },
    ]
}

fn sample_message() -> Message {
    Message {
        id: "msg-1".into(),
        role: MessageRole::Assistant,
        mode: MessageMode::Text,
        content: "hi".into(),
        thinking: "hmm".into(),
        tool_calls: vec![sample_tool_call()],
        plan: Some(Vec::new()),
        model: Some("anthropic/claude".into()),
        timestamp: chrono::Utc::now(),
    }
}

fn sample_tool_call() -> ToolCall {
    ToolCall {
        id: "call-1".into(),
        tool_name: "Read".into(),
        title: Some("Read src/main.rs".into()),
        kind: Some("read".into()),
        status: ToolCallStatus::Completed,
        arguments: serde_json::json!({ "path": "src/main.rs" }),
        result: Some("fn main() {}".into()),
        locations: vec![serde_json::json!({ "path": "src/main.rs" })],
        raw_output: Some(serde_json::json!({ "ok": true })),
        content_blocks: vec![ToolContentBlock::Diff {
            path: "src/main.rs".into(),
            old_text: Some("old".into()),
            new_text: "new".into(),
        }],
    }
}

fn kind_of(value: &serde_json::Value) -> String {
    value["kind"].as_str().expect("every delta is tagged").into()
}

#[test]
fn every_contracted_variant_exists_and_no_others() {
    let contracted: BTreeSet<String> = expected().keys().cloned().collect();
    let produced: BTreeSet<String> = samples()
        .iter()
        .map(|delta| kind_of(&serde_json::to_value(delta).unwrap()))
        .collect();

    assert_eq!(
        contracted, produced,
        "the contract and the enum disagree about which kinds exist"
    );
}

/// The document and this test are the same contract, said twice.
#[test]
fn the_contract_doc_says_the_same_thing() {
    let Some(documented) = documented() else {
        // Ignored rather than failed: the doc is git-ignored, so it is simply
        // absent in CI. `expected()` is what holds there.
        return;
    };
    assert_eq!(
        documented,
        expected(),
        "docs/agents/delta-wire-contract.md and this test disagree"
    );
}

#[test]
fn every_variant_serializes_to_its_contracted_fields() {
    let documented = expected();
    for delta in samples() {
        let value = serde_json::to_value(&delta).unwrap();
        let kind = kind_of(&value);
        let expected = documented
            .get(&kind)
            .unwrap_or_else(|| panic!("`{kind}` is not in the contract"));

        let mut actual: BTreeSet<String> = value
            .as_object()
            .expect("a delta is an object")
            .keys()
            .cloned()
            .collect();
        assert!(actual.remove("kind"), "the tag is always present");

        assert_eq!(
            *expected, actual,
            "`{kind}` does not serialize to its contracted fields"
        );
    }
}

#[test]
fn a_variant_with_no_fields_still_serializes_as_an_object() {
    // `permission_resolved` is the narrowest one; a tuple or unit variant here
    // would change the wire from an object to something the frontend cannot
    // destructure.
    let value = serde_json::to_value(SessionDelta::PermissionResolved {
        request_id: Uuid::nil(),
    })
    .unwrap();
    assert!(value.is_object());
    assert_eq!(value["kind"], "permission_resolved");
}

#[test]
fn the_envelope_flattens_the_delta_beside_its_routing_keys() {
    let value = serde_json::to_value(SessionDeltaEnvelope {
        agent_id: AgentId(Uuid::nil()),
        session_id: "sess-1".into(),
        delta: SessionDelta::Compaction { active: false },
    })
    .unwrap();

    assert_eq!(value["session_id"], "sess-1");
    assert_eq!(value["agent_id"], Uuid::nil().to_string());
    // Flattened, not nested: consumers read `kind` off the envelope itself.
    assert_eq!(value["kind"], "compaction");
    assert_eq!(value["active"], false);
    assert!(value.get("delta").is_none());
}

#[test]
fn optional_fields_are_omitted_rather_than_null() {
    // The TS union declares these optional; emitting `null` where the frontend
    // expects "absent" is a shape change even though the type looks the same.
    let value = serde_json::to_value(SessionDelta::TurnFailed {
        error: "boom".into(),
        turn_seq: 0,
        error_kind: None,
    })
    .unwrap();
    assert!(value.get("error_kind").is_none());

    let mut tool_call = sample_tool_call();
    tool_call.raw_output = None;
    tool_call.content_blocks = Vec::new();
    let value = serde_json::to_value(&tool_call).unwrap();
    assert!(value.get("raw_output").is_none());
    assert!(value.get("content_blocks").is_none());
}

#[test]
fn the_nested_enums_use_the_documented_tokens() {
    for (status, want) in [
        (SessionStatus::Idle, "idle"),
        (SessionStatus::Running, "running"),
        (SessionStatus::Waiting, "waiting"),
        (SessionStatus::Error, "error"),
    ] {
        assert_eq!(serde_json::to_value(status).unwrap(), want);
    }
    for (role, want) in [
        (MessageRole::User, "user"),
        (MessageRole::Assistant, "assistant"),
        (MessageRole::System, "system"),
    ] {
        assert_eq!(serde_json::to_value(role).unwrap(), want);
    }
    for (mode, want) in [
        (MessageMode::Text, "text"),
        (MessageMode::Tool, "tool"),
        (MessageMode::Thinking, "thinking"),
    ] {
        assert_eq!(serde_json::to_value(mode).unwrap(), want);
    }
    for (status, want) in [
        (ToolCallStatus::Pending, "pending"),
        (ToolCallStatus::Running, "running"),
        (ToolCallStatus::Completed, "completed"),
        (ToolCallStatus::Failed, "failed"),
    ] {
        assert_eq!(serde_json::to_value(status).unwrap(), want);
    }
}

#[test]
fn tool_content_blocks_keep_their_camel_case_wire_names() {
    let value = serde_json::to_value(ToolContentBlock::Diff {
        path: "a.rs".into(),
        old_text: None,
        new_text: "x".into(),
    })
    .unwrap();
    assert_eq!(value["type"], "diff");
    assert_eq!(value["newText"], "x");
    assert!(value.get("oldText").is_none(), "absent for a new file");

    let value = serde_json::to_value(ToolContentBlock::Terminal {
        terminal_id: "t1".into(),
    })
    .unwrap();
    assert_eq!(value["type"], "terminal");
    assert_eq!(value["terminalId"], "t1");
}
