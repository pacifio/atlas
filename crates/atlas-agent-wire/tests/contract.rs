//! The authority on the session-delta wire's shapes (the TS mirror is
//! `tests/wire-shape-contract.test.ts`).
//!
//! The wire is additive-only: the Timeline, the capture record, analytics,
//! transcripts, memory ingest and the whole chat UI pattern-match its concrete
//! variants and fields. Adding an optional field or variant means updating this
//! file in the same change as its consumers; renaming, removing or re-meaning
//! one is a breaking change that updates every consumer at once. This test
//! spells the contract out and compares it to the real serialisation, in both
//! directions: a variant or field that exists in one and not the other fails.
//!
//! Three layers, each closing a way the previous version could pass while the
//! wire drifted:
//!
//! - [`contract_kind`] is an exhaustive `match` with no wildcard arm, so adding
//!   a `SessionDelta` variant is a compile error in this file until someone
//!   writes down which contract entry it is.
//! - [`golden`] pins every sample's full JSON, so a field changing *type*
//!   (`u64` → `String`, `f64` → integer, an object becoming an array) fails,
//!   not just a field being renamed.
//! - [`expected`] is the table of kinds and field names.
//!
//! What still needs a human: a new variant's arm must be matched by a new
//! sample, golden and table row. The count check in
//! [`every_contracted_variant_exists_and_no_others`] catches a sample without
//! a row (and vice versa), but nothing on stable Rust can count an enum's
//! variants, so an arm with no sample at all is only caught in review.

use std::collections::{BTreeMap, BTreeSet};

use atlas_agent_wire::{
    AgentId, Message, MessageImage, MessageMode, MessageRole, Origin, PlanEntry, QueuedPrompt,
    RateLimitWindow, SessionDelta, SessionDeltaEnvelope, SessionStatus, Subagent, SubagentStatus,
    ToolCall, ToolCallStatus, ToolContentBlock, Usage,
};
use serde_json::json;
use uuid::Uuid;

/// The contract, as this test asserts it.
///
/// Written out here rather than only in the document because the document is
/// not in the repository (and `docs/agents/*.md` is git-ignored), so a check
/// that only read the file would silently pass in CI, which is the one place
/// it has to hold. [`the_contract_doc_says_the_same_thing`] cross-checks this
/// against the document; it is `#[ignore]`d until the document exists.
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
        ("subagent_upserted", &["subagent"]),
        ("plan_updated", &["plan"]),
        ("history_rewound", &["turns"]),
        ("mode_changed", &["mode_id", "origin"]),
        (
            "retry_status",
            &["attempt", "max_attempts", "delay_ms", "last_error"],
        ),
        ("model_changed", &["model_id", "origin"]),
        ("available_commands", &["commands"]),
        ("usage_updated", &["usage"]),
        (
            "elicitation_requested",
            &["request_id", "mode", "message", "requested_schema", "url"],
        ),
        ("title_updated", &["title"]),
        ("config_options_updated", &["config_options", "origin"]),
        ("context_usage", &["used", "size", "cost", "currency"]),
        ("compaction", &["active"]),
        ("compression_saved", &["saved_tokens"]),
        ("rate_limits", &["primary", "secondary", "plan_type"]),
        (
            "permission_request",
            &["request_id", "tool_call", "options"],
        ),
        ("permission_resolved", &["request_id"]),
        (
            "turn_finished",
            &[
                "stop_reason",
                "turn_seq",
                "started_at_ms",
                "ended_at_ms",
                "worked_ms",
            ],
        ),
        ("turn_failed", &["error", "turn_seq", "error_kind"]),
        ("slept_mid_turn", &["turn_seq", "slept_secs"]),
        ("agent_disconnected", &["reason"]),
        ("user_message", &["message", "origin", "client_message_id"]),
        ("queue_changed", &["queue"]),
        ("hold_changed", &["held"]),
    ]
    .into_iter()
    .map(|(kind, fields)| {
        (
            kind.to_string(),
            fields
                .iter()
                .map(std::string::ToString::to_string)
                .collect(),
        )
    })
    .collect()
}

/// Which contract entry a variant is. No wildcard arm, on purpose: a new
/// `SessionDelta` variant stops this file compiling until it is given a row in
/// [`expected`], a sample in [`samples`] and a golden in [`golden`].
fn contract_kind(delta: &SessionDelta) -> &'static str {
    match delta {
        SessionDelta::Status { .. } => "status",
        SessionDelta::MessageAppended { .. } => "message_appended",
        SessionDelta::TextChunk { .. } => "text_chunk",
        SessionDelta::ThinkingChunk { .. } => "thinking_chunk",
        SessionDelta::ToolCallUpserted { .. } => "tool_call_upserted",
        SessionDelta::SubagentUpserted { .. } => "subagent_upserted",
        SessionDelta::ToolCallOutputChunk { .. } => "tool_call_output_chunk",
        SessionDelta::PlanUpdated { .. } => "plan_updated",
        SessionDelta::HistoryRewound { .. } => "history_rewound",
        SessionDelta::ModeChanged { .. } => "mode_changed",
        SessionDelta::RetryStatus { .. } => "retry_status",
        SessionDelta::ModelChanged { .. } => "model_changed",
        SessionDelta::AvailableCommands { .. } => "available_commands",
        SessionDelta::UsageUpdated { .. } => "usage_updated",
        SessionDelta::ElicitationRequested { .. } => "elicitation_requested",
        SessionDelta::TitleUpdated { .. } => "title_updated",
        SessionDelta::ConfigOptionsUpdated { .. } => "config_options_updated",
        SessionDelta::ContextUsage { .. } => "context_usage",
        SessionDelta::Compaction { .. } => "compaction",
        SessionDelta::CompressionSaved { .. } => "compression_saved",
        SessionDelta::RateLimits { .. } => "rate_limits",
        SessionDelta::PermissionRequest { .. } => "permission_request",
        SessionDelta::PermissionResolved { .. } => "permission_resolved",
        SessionDelta::TurnFinished { .. } => "turn_finished",
        SessionDelta::TurnFailed { .. } => "turn_failed",
        SessionDelta::SleptMidTurn { .. } => "slept_mid_turn",
        SessionDelta::AgentDisconnected { .. } => "agent_disconnected",
        SessionDelta::UserMessage { .. } => "user_message",
        SessionDelta::QueueChanged { .. } => "queue_changed",
        SessionDelta::HoldChanged { .. } => "hold_changed",
    }
}

/// Where a prose version of the contract would live. It was once cited as the
/// authority, but is a git-ignored working note, not in the repository.
const CONTRACT_DOC: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../docs/agents/delta-wire-contract.md"
);

/// The same table, read out of the contract doc — `None` when the doc is
/// absent (see [`CONTRACT_DOC`]).
fn documented() -> Option<BTreeMap<String, BTreeSet<String>>> {
    let doc = std::fs::read_to_string(CONTRACT_DOC).ok()?;

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
        SessionDelta::SubagentUpserted {
            subagent: sample_subagent(),
        },
        SessionDelta::PlanUpdated {
            plan: vec![PlanEntry {
                content: "do the thing".into(),
                priority: Some("medium".into()),
                status: "pending".into(),
            }],
        },
        SessionDelta::HistoryRewound { turns: 2 },
        SessionDelta::ModeChanged {
            mode_id: "plan".into(),
            origin: Some(Origin::Local),
        },
        SessionDelta::RetryStatus {
            attempt: 1,
            max_attempts: 3,
            delay_ms: 500,
            last_error: "overloaded".into(),
        },
        SessionDelta::ModelChanged {
            model_id: "anthropic/claude".into(),
            origin: Some(Origin::Remote {
                id: "user-7".into(),
                name: Some("Ada".into()),
            }),
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
                reasoning_tokens: 3,
                cost: 0.5,
                currency: Some("EUR".into()),
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
            origin: Some(Origin::Remote {
                id: "user-7".into(),
                name: None,
            }),
        },
        SessionDelta::ContextUsage {
            used: 100,
            size: 200_000,
            cost: 0.25,
            currency: None,
        },
        SessionDelta::Compaction { active: true },
        SessionDelta::CompressionSaved { saved_tokens: 42 },
        SessionDelta::RateLimits {
            primary: Some(RateLimitWindow {
                used_percent: 40,
                window_minutes: Some(300),
                resets_at: Some(1_800_000_000),
            }),
            secondary: None,
            plan_type: Some("plus".into()),
        },
        SessionDelta::PermissionRequest {
            request_id,
            tool_call: serde_json::json!({ "toolCallId": "call-1" }),
            options: serde_json::json!([{ "optionId": "allow_once" }]),
        },
        SessionDelta::PermissionResolved { request_id },
        SessionDelta::TurnFinished {
            stop_reason: "end_turn".into(),
            turn_seq: 3,
            started_at_ms: Some(1_700_000_000_000),
            ended_at_ms: Some(1_700_000_252_000),
            worked_ms: Some(251_400),
        },
        SessionDelta::TurnFailed {
            error: "boom".into(),
            turn_seq: 3,
            error_kind: Some("transient".into()),
        },
        SessionDelta::SleptMidTurn {
            turn_seq: 3,
            slept_secs: 600,
        },
        SessionDelta::AgentDisconnected {
            reason: "process died".into(),
        },
        SessionDelta::UserMessage {
            message: sample_user_message(),
            origin: Origin::Remote {
                id: "guest:ab12".into(),
                name: Some("Sam".into()),
            },
            client_message_id: Some("cm-1".into()),
        },
        SessionDelta::QueueChanged {
            queue: vec![
                QueuedPrompt {
                    id: "q-1".into(),
                    text: "and then the tests".into(),
                    origin: Origin::Local,
                },
                QueuedPrompt {
                    id: "q-2".into(),
                    text: "ship it".into(),
                    origin: Origin::Remote {
                        id: "user-7".into(),
                        name: None,
                    },
                },
            ],
        },
        SessionDelta::HoldChanged { held: true },
    ]
}

fn sample_user_message() -> Message {
    Message {
        id: "msg-u".into(),
        role: MessageRole::User,
        mode: MessageMode::Text,
        content: "fix the build".into(),
        thinking: String::new(),
        tool_calls: Vec::new(),
        plan: None,
        model: None,
        images: vec![MessageImage {
            mime_type: "image/png".into(),
            data: "iVBORw0K".into(),
        }],
        timestamp: "2026-01-02T03:04:05Z".parse().unwrap(),
    }
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
        images: Vec::new(),
        // Fixed, not `now()`: the golden pins the serialized timestamp.
        timestamp: "2026-01-02T03:04:05Z".parse().unwrap(),
        // Set, so the golden pins the key; `optional_fields_are_omitted…`
        // pins its absence when false.
        timestamp_approximate: true,
        worked_ms: Some(252_000),
        stop_reason: Some("cancelled".into()),
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
        parent_tool_call_id: Some("call-parent".into()),
        started_at_ms: Some(1_700_000_000_000),
        ended_at_ms: Some(1_700_000_001_500),
    }
}

fn sample_subagent() -> Subagent {
    Subagent {
        tool_call_id: "call-parent".into(),
        message_id: "msg-1".into(),
        name: "Review the auth module".into(),
        status: SubagentStatus::Running,
        prompt: Some("Read src/auth.".into()),
        role: Some("code-reviewer".into()),
        result: None,
        tool_call_count: 2,
        started_at_ms: 1_700_000_000_000,
        ended_at_ms: None,
        own_thread: true,
    }
}

/// Every sample's exact JSON. Integers are written as integers and floats as
/// floats on purpose: `serde_json` compares `1` and `1.0` as different
/// values, so a numeric field changing type fails here as surely as a
/// renamed one.
fn golden() -> BTreeMap<&'static str, serde_json::Value> {
    let nil = Uuid::nil().to_string();
    let tool_call = json!({
        "id": "call-1",
        "tool_name": "Read",
        "title": "Read src/main.rs",
        "kind": "read",
        "status": "completed",
        "arguments": { "path": "src/main.rs" },
        "result": "fn main() {}",
        "locations": [{ "path": "src/main.rs" }],
        "raw_output": { "ok": true },
        "content_blocks": [
            { "type": "diff", "path": "src/main.rs", "oldText": "old", "newText": "new" }
        ],
        "parent_tool_call_id": "call-parent",
        "started_at_ms": 1_700_000_000_000_i64,
        "ended_at_ms": 1_700_000_001_500_i64,
    });
    BTreeMap::from([
        (
            "status",
            json!({ "kind": "status", "status": "running", "turn_seq": 3 }),
        ),
        (
            "message_appended",
            json!({
                "kind": "message_appended",
                "message": {
                    "id": "msg-1",
                    "role": "assistant",
                    "mode": "text",
                    "content": "hi",
                    "thinking": "hmm",
                    "tool_calls": [tool_call],
                    "plan": [],
                    "model": "anthropic/claude",
                    "timestamp": "2026-01-02T03:04:05Z",
                    "timestamp_approximate": true,
                    "worked_ms": 252_000,
                    "stop_reason": "cancelled",
                },
            }),
        ),
        (
            "text_chunk",
            json!({ "kind": "text_chunk", "message_id": "msg-1", "delta": "hello" }),
        ),
        (
            "thinking_chunk",
            json!({ "kind": "thinking_chunk", "message_id": "msg-1", "delta": "hmm" }),
        ),
        (
            "tool_call_upserted",
            json!({ "kind": "tool_call_upserted", "message_id": "msg-1", "tool_call": tool_call }),
        ),
        (
            "tool_call_output_chunk",
            json!({
                "kind": "tool_call_output_chunk",
                "message_id": "msg-1",
                "tool_call_id": "call-1",
                "delta": "line\n",
            }),
        ),
        (
            "subagent_upserted",
            json!({
                "kind": "subagent_upserted",
                "subagent": {
                    "toolCallId": "call-parent",
                    "messageId": "msg-1",
                    "name": "Review the auth module",
                    "status": "running",
                    "prompt": "Read src/auth.",
                    "role": "code-reviewer",
                    "toolCallCount": 2,
                    "startedAtMs": 1_700_000_000_000i64,
                    "ownThread": true,
                },
            }),
        ),
        (
            "plan_updated",
            json!({
                "kind": "plan_updated",
                "plan": [{ "content": "do the thing", "priority": "medium", "status": "pending" }],
            }),
        ),
        (
            "history_rewound",
            json!({ "kind": "history_rewound", "turns": 2 }),
        ),
        (
            "mode_changed",
            json!({ "kind": "mode_changed", "mode_id": "plan", "origin": { "kind": "local" } }),
        ),
        (
            "retry_status",
            json!({
                "kind": "retry_status",
                "attempt": 1,
                "max_attempts": 3,
                "delay_ms": 500,
                "last_error": "overloaded",
            }),
        ),
        (
            "model_changed",
            json!({
                "kind": "model_changed",
                "model_id": "anthropic/claude",
                "origin": { "kind": "remote", "id": "user-7", "name": "Ada" },
            }),
        ),
        (
            "available_commands",
            json!({ "kind": "available_commands", "commands": [{ "name": "login" }] }),
        ),
        (
            "usage_updated",
            json!({
                "kind": "usage_updated",
                "usage": {
                    "input_tokens": 10,
                    "output_tokens": 20,
                    "cache_creation_tokens": 1,
                    "cache_read_tokens": 2,
                    "reasoning_tokens": 3,
                    "cost": 0.5,
                    "currency": "EUR",
                },
            }),
        ),
        (
            "elicitation_requested",
            json!({
                "kind": "elicitation_requested",
                "request_id": nil,
                "mode": "form",
                "message": "which one?",
                "requested_schema": { "type": "object" },
                "url": "https://example.invalid",
            }),
        ),
        (
            "title_updated",
            json!({ "kind": "title_updated", "title": "a session" }),
        ),
        (
            "config_options_updated",
            json!({
                "kind": "config_options_updated",
                "config_options": [{ "id": "thinking" }],
                "origin": { "kind": "remote", "id": "user-7" },
            }),
        ),
        (
            "context_usage",
            json!({ "kind": "context_usage", "used": 100, "size": 200_000, "cost": 0.25, "currency": null }),
        ),
        (
            "compaction",
            json!({ "kind": "compaction", "active": true }),
        ),
        (
            "compression_saved",
            json!({ "kind": "compression_saved", "saved_tokens": 42 }),
        ),
        (
            "rate_limits",
            json!({
                "kind": "rate_limits",
                "primary": { "used_percent": 40, "window_minutes": 300, "resets_at": 1_800_000_000 },
                "secondary": null,
                "plan_type": "plus",
            }),
        ),
        (
            "permission_request",
            json!({
                "kind": "permission_request",
                "request_id": nil,
                "tool_call": { "toolCallId": "call-1" },
                "options": [{ "optionId": "allow_once" }],
            }),
        ),
        (
            "permission_resolved",
            json!({ "kind": "permission_resolved", "request_id": nil }),
        ),
        (
            "turn_finished",
            json!({
                "kind": "turn_finished",
                "stop_reason": "end_turn",
                "turn_seq": 3,
                "started_at_ms": 1_700_000_000_000_i64,
                "ended_at_ms": 1_700_000_252_000_i64,
                "worked_ms": 251_400,
            }),
        ),
        (
            "turn_failed",
            json!({
                "kind": "turn_failed",
                "error": "boom",
                "turn_seq": 3,
                "error_kind": "transient",
            }),
        ),
        (
            "slept_mid_turn",
            json!({ "kind": "slept_mid_turn", "turn_seq": 3, "slept_secs": 600 }),
        ),
        (
            "agent_disconnected",
            json!({ "kind": "agent_disconnected", "reason": "process died" }),
        ),
        (
            "user_message",
            json!({
                "kind": "user_message",
                "message": {
                    "id": "msg-u",
                    "role": "user",
                    "mode": "text",
                    "content": "fix the build",
                    "tool_calls": [],
                    "images": [{ "mime_type": "image/png", "data": "iVBORw0K" }],
                    "timestamp": "2026-01-02T03:04:05Z",
                },
                "origin": { "kind": "remote", "id": "guest:ab12", "name": "Sam" },
                "client_message_id": "cm-1",
            }),
        ),
        (
            "queue_changed",
            json!({
                "kind": "queue_changed",
                "queue": [
                    { "id": "q-1", "text": "and then the tests", "origin": { "kind": "local" } },
                    { "id": "q-2", "text": "ship it", "origin": { "kind": "remote", "id": "user-7" } },
                ],
            }),
        ),
        (
            "hold_changed",
            json!({ "kind": "hold_changed", "held": true }),
        ),
    ])
}

fn kind_of(value: &serde_json::Value) -> String {
    value["kind"]
        .as_str()
        .expect("every delta is tagged")
        .into()
}

#[test]
fn every_contracted_variant_exists_and_no_others() {
    let contracted: BTreeSet<String> = expected().keys().cloned().collect();
    let samples = samples();

    let mut produced = BTreeSet::new();
    for delta in &samples {
        let kind = kind_of(&serde_json::to_value(delta).unwrap());
        // The serialized tag and the exhaustive match agree, so the match
        // really is a map from variant to wire kind.
        assert_eq!(
            kind,
            contract_kind(delta),
            "`contract_kind` names this variant differently from its tag"
        );
        assert!(produced.insert(kind.clone()), "two samples of `{kind}`");
    }

    assert_eq!(
        contracted, produced,
        "the contract and the enum disagree about which kinds exist"
    );
    let goldens: BTreeSet<String> = golden().keys().map(ToString::to_string).collect();
    assert_eq!(contracted, goldens, "every contracted kind has a golden");
}

#[test]
fn every_variant_serializes_to_its_golden_json() {
    let golden = golden();
    for delta in samples() {
        let value = serde_json::to_value(&delta).unwrap();
        let kind = contract_kind(&delta);
        let want = golden
            .get(kind)
            .unwrap_or_else(|| panic!("`{kind}` has no golden"));
        assert_eq!(
            &value, want,
            "`{kind}` changed on the wire (names, value types or shape)"
        );
    }
}

/// The document and this test are the same contract, said twice.
///
/// Ignored by default, loudly: `docs/agents/delta-wire-contract.md` is a
/// git-ignored working note that does not exist in the repository, so there is
/// nothing to compare against. The earlier version returned early when the
/// file was missing, which read as a pass. Once the doc is checked in, drop
/// the `#[ignore]`; `cargo test -- --ignored` runs it meanwhile, and fails
/// rather than skips if the doc is still absent.
#[test]
#[ignore = "docs/agents/delta-wire-contract.md is not in the repository; nothing to compare"]
fn the_contract_doc_says_the_same_thing() {
    let documented = documented().unwrap_or_else(|| panic!("{CONTRACT_DOC} does not exist"));
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
        seq: 42,
        delta: SessionDelta::Compaction { active: false },
    })
    .unwrap();

    assert_eq!(value["session_id"], "sess-1");
    // The per-session stream position rides beside the routing keys, always
    // present: a joiner's snapshot-then-tail depends on it (`as_of_seq`).
    assert_eq!(value["seq"], 42);
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

<<<<<<< Updated upstream
    let value = serde_json::to_value(SessionDelta::TurnFinished {
        stop_reason: "end_turn".into(),
        turn_seq: 0,
        started_at_ms: None,
        ended_at_ms: None,
        worked_ms: None,
    })
    .unwrap();
    assert!(value.get("started_at_ms").is_none());
    assert!(value.get("ended_at_ms").is_none());
    assert!(value.get("worked_ms").is_none());

    let mut message = sample_message();
    message.worked_ms = None;
    message.stop_reason = None;
    message.timestamp_approximate = false;
    let value = serde_json::to_value(&message).unwrap();
    assert!(value.get("worked_ms").is_none());
    assert!(value.get("stop_reason").is_none());
    // A timed message (every live one) serializes exactly as before the flag.
    assert!(value.get("timestamp_approximate").is_none());
=======
    // A user message nobody minted an id for (a remote prompt, a queued one)
    // says nothing about it, rather than `null`.
    let value = serde_json::to_value(SessionDelta::UserMessage {
        message: sample_user_message(),
        origin: Origin::Local,
        client_message_id: None,
    })
    .unwrap();
    assert!(value.get("client_message_id").is_none());
    assert_eq!(value["origin"], json!({ "kind": "local" }));

    // A setting the agent changed on its own has no origin to name, and says
    // nothing rather than `null`; one set through the host names who did it.
    for delta in [
        SessionDelta::ModeChanged {
            mode_id: "plan".into(),
            origin: None,
        },
        SessionDelta::ModelChanged {
            model_id: "m".into(),
            origin: None,
        },
        SessionDelta::ConfigOptionsUpdated {
            config_options: Vec::new(),
            origin: None,
        },
    ] {
        let value = serde_json::to_value(&delta).unwrap();
        assert!(value.get("origin").is_none(), "{value}");
    }
>>>>>>> Stashed changes

    let mut tool_call = sample_tool_call();
    tool_call.raw_output = None;
    tool_call.content_blocks = Vec::new();
    tool_call.started_at_ms = None;
    tool_call.ended_at_ms = None;
    let value = serde_json::to_value(&tool_call).unwrap();
    assert!(value.get("raw_output").is_none());
    assert!(value.get("content_blocks").is_none());
    assert!(value.get("started_at_ms").is_none());
    assert!(value.get("ended_at_ms").is_none());
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
