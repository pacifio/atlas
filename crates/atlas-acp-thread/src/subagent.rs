//! Reading a subagent out of an ACP tool call, for any ACP agent.
//!
//! ACP has no subagent concept. The v1 `SessionUpdate` enum carries no variant
//! for one and no catch-all, so an agent that delegates work can only say so
//! through the fields it already has: the tool call that launched the child,
//! its `rawInput`, and `_meta`. Every agent does say it — in its own words.
//!
//! So this is not a per-agent table. It is three families of *evidence*,
//! each read from how several agents independently chose to express the same
//! idea, and **nothing here keys on an agent id** (ADR-0002). A tool call is a
//! launch when it carries any of them:
//!
//! 1. **The tool is named for it.** `Task`, `Agent`, `subagent`,
//!    `spawn_agent`, `spawn_subagent`, `start_subagent`, `delegate` — matched
//!    on the agent's own tool name, and failing that on the rendered title,
//!    which is the only name some agents send (see [`names_a_subagent`]).
//! 2. **The input describes a child.** A role field — `subagent_type`,
//!    `agent_type`, `agentType`, `subagentType` — names the kind of agent to
//!    run, and only a delegation has one.
//! 3. **A vendor `_meta` namespace says so.** Agents that extend ACP put their
//!    subagent facts under their own key, so the namespace is unknowable but
//!    the leaf names repeat: `subagent_started`, `subagent_completed`,
//!    `parentToolUseId`, `parentAgentId` (see [`META_LAUNCH_KEYS`]).
//!
//! Plus one shape that is a lifecycle *step* rather than a launch: a call whose
//! input pairs an agent path with an activity kind, which is how an agent that
//! models children as a tree reports each thing it does to one.
//!
//! The same three families give the **parent link** — which child a piece of
//! work belongs to — because a child's calls arrive on the parent's session,
//! interleaved with the parent's own, and `_meta` is the only thing that tells
//! them apart.
//!
//! Evidence was read from the ACP adapters Atlas ships against and from how
//! Grok, Devin, Copilot, Antigravity, Cursor, Pi, Muse and OpenCode each
//! express delegation. The point of generalising rather than writing a hook
//! per flavour is that an ACP agent Atlas has never heard of, expressing
//! delegation the way the others do, gets subagent rendering without a code
//! change.
//!
//! Detection is deliberately conservative throughout: a false positive is a
//! phantom subagent row that never completes, which is worse than showing a
//! real subagent as an ordinary tool call.

use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;

/// Tool names that mean "run a child agent".
///
/// Collected from: Claude Code (`Task`, `Agent`), the native engine
/// (`spawn_agent`), Grok (`task`, `spawn_subagent`), Antigravity
/// (`start_subagent`), Pi (`subagent`), Cursor (`task`), and the delegate tool
/// of earlier Atlas builds.
///
/// Compared case-insensitively against the last segment of a namespaced name,
/// so `multi_agent_v1__spawn_agent` matches on `spawn_agent`.
const LAUNCH_TOOL_NAMES: &[&str] = &[
    "task",
    "agent",
    "subagent",
    "spawn_agent",
    "spawnagent",
    "spawn_subagent",
    "start_subagent",
    "run_subagent",
    "delegate",
];

/// `rawInput` keys that name the KIND of agent to run.
///
/// From Claude (`subagent_type`), Copilot and the native engine (`agent_type`),
/// and Grok (which accepts either spelling). Only a delegation names one.
const ROLE_KEYS: &[&str] = &["subagent_type", "subagentType", "agent_type", "agentType"];

/// `rawInput` keys carrying the child's instructions.
const PROMPT_KEYS: &[&str] = &["prompt", "task", "input", "instructions", "goal"];

/// `rawInput` keys carrying a short human label for the child.
const DESCRIPTION_KEYS: &[&str] = &["description", "title", "name"];

/// Leaf keys inside a vendor `_meta` namespace that announce a subagent.
///
/// From Devin (`cognition.ai/subagent_started`, `…/subagent_completed`). The
/// namespace differs per vendor and cannot be enumerated; the leaf names are
/// what repeat, so the scan is one level deep into whatever namespaces are
/// present.
const META_LAUNCH_KEYS: &[&str] = &["subagent_started", "subagent_completed", "subagent"];

/// Leaf keys inside a vendor `_meta` namespace naming the launch a piece of
/// work belongs to.
///
/// From Claude (`claudeCode.parentToolUseId`) and Devin
/// (`cognition.ai/subagent_context.parentAgentId`). A client that groups a
/// child's calls under its row has nothing else to group on.
const META_PARENT_KEYS: &[&str] = &[
    "parentToolUseId",
    "parent_tool_use_id",
    "parentToolCallId",
    "parentAgentId",
    "parent_agent_id",
    "parentSubagentId",
];

/// `_meta` leaf keys naming the agent's own tool name, which the rendered
/// `title` has usually replaced. Claude writes `claudeCode.toolName`; Devin
/// writes `cognition.ai/inferenceToolName`.
const META_TOOL_NAME_KEYS: &[&str] = &["toolName", "tool_name", "inferenceToolName"];

/// The client capability that makes an adapter forward a subagent's own text
/// and thinking to the parent session instead of keeping it inside the
/// launching tool call.
///
/// Declared in `ClientCapabilities._meta`. `claude-agent-acp` reads exactly
/// this key (`supportsSubagentTranscript`); without it a delegating row runs
/// for minutes saying nothing. Harmless to an agent that does not know it —
/// an unknown `_meta` key is ignored by the protocol.
///
/// Deliberately not the subagents RFD's `clientCapabilities.subagents`: that
/// moves each child onto its own ACP session and reports it with
/// `subagent_update` session updates, which the v1 `SessionUpdate` enum has no
/// variant for and cannot deserialize. This capability needs no new wire shape.
pub const SUBAGENT_TRANSCRIPT_META_KEY: &str = "subagent-transcript";

/// What a launch says about the child.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentLaunch {
    /// What to call it: the description, the role, or a bare fallback.
    pub name: String,
    /// The child's instructions, when the launch carried them.
    pub prompt: Option<String>,
    /// The child's role — the value of whichever [`ROLE_KEYS`] was present.
    pub role: Option<String>,
    /// The agent's own identity for the child, when it has one that outlives
    /// the launching call (an agent path, a child agent id). `None` means the
    /// launching call's id is the only identity available.
    pub native_id: Option<String>,
    /// The child runs on an agent thread of its own, which this session never
    /// sees — the engine's lifecycle steps (natively and over ACP). Its calls
    /// are not attributed here, so a count of them reads 0 whatever it did;
    /// a surface says where the work went instead.
    pub own_thread: bool,
}

/// Whether this tool call launches (or is a lifecycle step of) a subagent.
///
/// `tool_name` is the agent's own tool name when it sent one; `title` is the
/// rendered label. Both are consulted because neither is reliably present: an
/// adapter may send the tool name only in `_meta`, and an agent that sends no
/// tool name at all leaves the title as the only evidence of what ran.
pub fn launch_of(
    tool_name: Option<&str>,
    title: Option<&str>,
    raw_input: Option<&serde_json::Value>,
    meta: Option<&acp::Meta>,
) -> Option<SubagentLaunch> {
    // A lifecycle step first: its shape is unambiguous, and such a call's
    // name and title say nothing useful.
    if let Some(launch) = path_activity_launch(raw_input) {
        return Some(launch);
    }

    let named = tool_name
        .or_else(|| meta_tool_name(meta))
        .is_some_and(names_a_subagent)
        // The title only when no tool name was sent at all: a rendered title
        // is a sentence, and "Run the task list" must not be a delegation.
        || (tool_name.is_none()
            && meta_tool_name(meta).is_none()
            && title.is_some_and(title_names_a_subagent));
    let described = raw_input.is_some_and(|input| field(input, ROLE_KEYS).is_some());
    let announced = meta_announces_subagent(meta);

    if !named && !described && !announced {
        return None;
    }
    Some(described_launch(raw_input, meta))
}

/// The launch a piece of work belongs to, from its `_meta`.
///
/// Carried by a child's tool calls and — once the transcript capability is
/// declared — by the chunks of its narration, which is what lets a client nest
/// both under one row without the agent modelling a child session at all.
pub fn parent_tool_call_id(meta: Option<&acp::Meta>) -> Option<Arc<str>> {
    meta_leaf(meta, META_PARENT_KEYS)
        .and_then(|value| value.as_str())
        .filter(|id| !id.is_empty() && *id != "root")
        .map(Arc::from)
}

/// `_meta` / output markers saying the child was launched to run on its own,
/// so the launching call completing means "started", not "finished".
///
/// Claude Code answers an async `Agent` call with
/// `_meta.claudeCode.toolResponse.{isAsync: true, status: "async_launched"}`
/// and the call goes `completed` at once, while the child's own tool calls
/// keep arriving for minutes afterwards.
const ASYNC_LAUNCH_KEYS: &[&str] = &["isAsync", "async_launched", "asyncLaunched"];

/// The sentence an agent puts in an async launch's result text.
///
/// Claude's `Agent` answers with "Async agent launched successfully." before
/// a model-directed trailer. Matched case-insensitively on the two words that
/// carry the meaning, so a reworded sentence stops matching (and the child
/// shows as finished early) rather than matching something else.
fn text_says_async(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("async") && (lower.contains("launched") || lower.contains("started"))
}

/// Whether the launch handed the child off to run independently.
///
/// Read from the call's output and its metadata, because agents put it in
/// both: Claude sends `_meta.claudeCode.toolResponse.{isAsync, status:
/// "async_launched"}` AND a `rawOutput` whose first text block opens "Async
/// agent launched successfully."
///
/// Without this a child shows as finished the instant it starts: an async
/// launch's call goes `completed` while the child's own tool calls keep
/// arriving for minutes.
pub fn launched_async(raw_output: Option<&serde_json::Value>, meta: Option<&acp::Meta>) -> bool {
    /// How far to look. The markers sit at most three levels down
    /// (`_meta` → `claudeCode` → `toolResponse` → `isAsync`), and a bound
    /// rather than a full walk keeps an agent's arbitrarily nested payload
    /// from costing an unbounded scan on every tool-call update.
    const MAX_DEPTH: u8 = 4;

    fn walk(value: &serde_json::Value, depth: u8) -> bool {
        if depth == 0 {
            return false;
        }
        match value {
            serde_json::Value::String(text) => text_says_async(text),
            serde_json::Value::Array(items) => items.iter().any(|item| walk(item, depth - 1)),
            serde_json::Value::Object(object) => {
                for key in ASYNC_LAUNCH_KEYS {
                    if object.get(*key) == Some(&serde_json::Value::Bool(true)) {
                        return true;
                    }
                }
                if object
                    .get("status")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(text_says_async)
                {
                    return true;
                }
                object.values().any(|nested| walk(nested, depth - 1))
            }
            _ => false,
        }
    }

    raw_output.is_some_and(|output| walk(output, MAX_DEPTH))
        || meta.is_some_and(|meta| meta.values().any(|value| walk(value, MAX_DEPTH)))
}

/// What a finished child reported about its own run.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ReportedUsage {
    /// How long the child ran, by its own clock.
    pub duration_ms: Option<u64>,
    /// How many tool calls it made, whether or not this session saw them.
    pub tool_uses: Option<u32>,
}

/// The child's own account of its run, from the launch's output.
///
/// The only timing that survives a replay: the thread stamps an entry when it
/// is created, and a replayed transcript creates every entry in the same
/// instant. Claude's `Agent` ends its result with
/// `<usage>… tool_uses: 2\nduration_ms: 17145</usage>`, and its structured
/// response carries the same as `totalDurationMs` / `totalToolUseCount`;
/// both are read, the structured form first.
pub fn reported_usage(raw_output: Option<&serde_json::Value>) -> ReportedUsage {
    const MAX_DEPTH: u8 = 4;

    fn number(value: &serde_json::Value) -> Option<u64> {
        value
            .as_u64()
            .or_else(|| value.as_str()?.trim().parse().ok())
    }

    fn from_text(text: &str, usage: &mut ReportedUsage) {
        let Some(start) = text.rfind("<usage>") else {
            return;
        };
        let block = &text[start + "<usage>".len()..];
        let block = block.split("</usage>").next().unwrap_or(block);
        for line in block.lines() {
            let Some((key, value)) = line.split_once(':') else {
                continue;
            };
            let value = value.trim().parse::<u64>().ok();
            match key.trim() {
                "duration_ms" => usage.duration_ms = usage.duration_ms.or(value),
                "tool_uses" => {
                    usage.tool_uses = usage
                        .tool_uses
                        .or_else(|| value.and_then(|n| u32::try_from(n).ok()));
                }
                _ => {}
            }
        }
    }

    fn walk(value: &serde_json::Value, depth: u8, usage: &mut ReportedUsage) {
        if depth == 0 {
            return;
        }
        match value {
            serde_json::Value::String(text) => from_text(text, usage),
            serde_json::Value::Array(items) => {
                for item in items {
                    walk(item, depth - 1, usage);
                }
            }
            serde_json::Value::Object(object) => {
                if let Some(ms) = object.get("totalDurationMs").and_then(number) {
                    usage.duration_ms = Some(ms);
                }
                if let Some(n) = object
                    .get("totalToolUseCount")
                    .and_then(number)
                    .and_then(|n| u32::try_from(n).ok())
                {
                    usage.tool_uses = Some(n);
                }
                for nested in object.values() {
                    walk(nested, depth - 1, usage);
                }
            }
            _ => {}
        }
    }

    let mut usage = ReportedUsage::default();
    if let Some(output) = raw_output {
        walk(output, MAX_DEPTH, &mut usage);
    }
    usage
}

/// Where a lifecycle step is in a child's life.
///
/// Only `Completed` is terminal. `Interrupted` is something the parent did,
/// and a child can be interacted with again after either.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Activity {
    Started,
    Interacted,
    Interrupted,
    Completed,
}

/// The lifecycle step a call reports, when it reports one.
pub fn activity(raw_input: Option<&serde_json::Value>) -> Option<Activity> {
    match field(raw_input?, &["activityKind", "activity_kind"])?
        .to_ascii_lowercase()
        .as_str()
    {
        "started" | "start" | "spawned" => Some(Activity::Started),
        "interacted" | "interact" | "message" => Some(Activity::Interacted),
        "interrupted" | "interrupt" | "cancelled" | "canceled" => Some(Activity::Interrupted),
        "completed" | "complete" | "finished" => Some(Activity::Completed),
        _ => None,
    }
}

// ── evidence ────────────────────────────────────────────────────────────────

/// Whether `name` is one of [`LAUNCH_TOOL_NAMES`].
///
/// The last segment of a namespaced name is what counts, so an agent that
/// namespaces its tools (`multi_agent_v1__spawn_agent`, `acme.task`) matches
/// on the tool rather than on its namespace.
fn names_a_subagent(name: &str) -> bool {
    let bare = name
        .rsplit_once("__")
        .or_else(|| name.rsplit_once('.'))
        .or_else(|| name.rsplit_once('/'))
        .map_or(name, |(_, last)| last);
    let bare = bare.trim().to_ascii_lowercase();
    LAUNCH_TOOL_NAMES.contains(&bare.as_str())
}

/// Whether a rendered title names a subagent tool.
///
/// Titles are prose — an agent renders `start_subagent` as "Running
/// start_subagent" or "Run start_subagent?" — so this matches on WORDS, never
/// on substrings. "Run the task list" has the word `task` and must not be a
/// delegation, so a bare one-word match is not enough either: the title has to
/// be the tool name alone, or a short verb phrase around it.
fn title_names_a_subagent(title: &str) -> bool {
    let words: Vec<String> = title
        .split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-')
        .filter(|word| !word.is_empty())
        .map(str::to_ascii_lowercase)
        .collect();
    match words.len() {
        // `Task`, `spawn_subagent` — the tool name, rendered as-is.
        1 => LAUNCH_TOOL_NAMES.contains(&words[0].as_str()),
        // `Running start_subagent`, `Run start_subagent?`, `spawn subagent`.
        2 => {
            LAUNCH_TOOL_NAMES.contains(&words[1].as_str())
                && matches!(words[0].as_str(), "run" | "running" | "spawn" | "start")
                || (words[0] == "spawn" || words[0] == "start") && words[1] == "subagent"
        }
        _ => false,
    }
}

/// Whether a vendor `_meta` namespace announces a subagent.
fn meta_announces_subagent(meta: Option<&acp::Meta>) -> bool {
    meta_leaf(meta, META_LAUNCH_KEYS).is_some_and(|value| !value.is_null() && value != false)
}

/// The agent's own tool name from `_meta`, whatever namespace it chose.
fn meta_tool_name(meta: Option<&acp::Meta>) -> Option<&str> {
    meta_leaf(meta, META_TOOL_NAME_KEYS)?.as_str()
}

/// The first of `keys` found in `_meta`, however the vendor namespaced it.
///
/// Namespacing takes two forms in the wild and both have to be read:
///
/// - a nested object — `_meta.claudeCode.parentToolUseId`;
/// - a slash-joined key — `_meta["cognition.ai/subagent_started"]`.
///
/// One level deep either way, not a full walk: an unbounded search would
/// start matching fields of unrelated payloads that happen to be nested in
/// the metadata.
fn meta_leaf<'a>(meta: Option<&'a acp::Meta>, keys: &[&str]) -> Option<&'a serde_json::Value> {
    let meta = meta?;
    // The key itself, or a `vendor/leaf` spelling of it.
    for (name, value) in meta {
        let leaf = name.rsplit('/').next().unwrap_or(name);
        if keys.contains(&name.as_str()) || keys.contains(&leaf) {
            return Some(value);
        }
    }
    // Or inside a vendor's object.
    for namespace in meta.values() {
        let Some(namespace) = namespace.as_object() else {
            continue;
        };
        for (name, value) in namespace {
            let leaf = name.rsplit('/').next().unwrap_or(name);
            if keys.contains(&name.as_str()) || keys.contains(&leaf) {
                return Some(value);
            }
        }
    }
    None
}

/// The first non-empty string among `keys`, at the top level of `value` or one
/// object deep (Devin nests the launch facts inside `subagent_started`).
fn field<'a>(value: &'a serde_json::Value, keys: &[&str]) -> Option<&'a str> {
    let trimmed = |value: &'a serde_json::Value| {
        value
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
    };
    for key in keys {
        if let Some(text) = value.get(*key).and_then(trimmed) {
            return Some(text);
        }
    }
    let object = value.as_object()?;
    for nested in object.values() {
        if !nested.is_object() {
            continue;
        }
        for key in keys {
            if let Some(text) = nested.get(*key).and_then(trimmed) {
                return Some(text);
            }
        }
    }
    None
}

/// The child, as the launch's input and metadata describe it.
fn described_launch(
    raw_input: Option<&serde_json::Value>,
    meta: Option<&acp::Meta>,
) -> SubagentLaunch {
    // The `_meta` announcement carries the same facts for an agent that puts
    // them there (Devin) rather than in the input.
    let announced = meta_leaf(meta, META_LAUNCH_KEYS).cloned();
    let read = |keys: &[&str]| {
        raw_input
            .and_then(|input| field(input, keys))
            .map(str::to_owned)
            .or_else(|| {
                announced
                    .as_ref()
                    .and_then(|value| field(value, keys))
                    .map(str::to_owned)
            })
    };
    let description = read(DESCRIPTION_KEYS);
    let role = read(ROLE_KEYS);
    let prompt = read(PROMPT_KEYS);
    SubagentLaunch {
        // A description, then the role, then the prompt's first line — a
        // delegation whose only text is its instructions is still better
        // named by them than by "Subagent". Clipped, because a prompt is a
        // paragraph and a name is a label.
        name: description
            .or_else(|| role.clone())
            .or_else(|| prompt.as_deref().map(clip))
            .unwrap_or_else(|| "Subagent".to_owned()),
        prompt,
        role,
        native_id: read(&["agentId", "agent_id", "subagentId", "agentPath"]),
        own_thread: false,
    }
}

/// A lifecycle step: an agent path paired with an activity kind.
///
/// Both are required. A path alone is a path, and a tool that happens to take
/// one must not become a subagent.
fn path_activity_launch(raw_input: Option<&serde_json::Value>) -> Option<SubagentLaunch> {
    let input = raw_input?;
    let path = field(input, &["agentPath", "agent_path"])?;
    activity(raw_input)?;
    Some(SubagentLaunch {
        name: name_of_path(path),
        prompt: field(input, PROMPT_KEYS).map(str::to_owned),
        role: field(input, ROLE_KEYS).map(str::to_owned),
        native_id: Some(path.to_owned()),
        own_thread: true,
    })
}

/// A prompt's first line, short enough to be a label.
///
/// The ellipsis is on a character boundary: a prompt can open with anything,
/// and slicing a multi-byte character would panic.
fn clip(prompt: &str) -> String {
    const MAX: usize = 72;
    let line = prompt.lines().next().unwrap_or(prompt).trim();
    if line.chars().count() <= MAX {
        return line.to_owned();
    }
    let kept: String = line.chars().take(MAX - 1).collect();
    format!("{}…", kept.trim_end())
}

/// `/root/code_reviewer` → `Code reviewer`: the last segment, separators as
/// spaces, first letter raised.
fn name_of_path(path: &str) -> String {
    let last = path.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    let words = last.replace(['_', '-'], " ");
    let words = words.split_whitespace().collect::<Vec<_>>().join(" ");
    if words.is_empty() {
        return "Subagent".to_owned();
    }
    let mut chars = words.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => words,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(value: serde_json::Value) -> acp::Meta {
        value.as_object().expect("an object").clone()
    }

    /// Every case below is one agent's real vocabulary, from its adapter.
    /// Together they are the claim this module makes: that the ways agents
    /// express delegation are few, and none of them needs an agent id.
    #[test]
    fn a_launch_is_recognised_in_each_agents_own_words() {
        // Claude Code: `Task`, with a description and a typed role.
        let claude = launch_of(
            Some("Task"),
            Some("Review the auth module"),
            Some(&serde_json::json!({
                "description": "Review the auth module",
                "prompt": "Read src/auth.",
                "subagent_type": "code-reviewer",
            })),
            None,
        )
        .expect("Claude's Task");
        assert_eq!(claude.name, "Review the auth module");
        assert_eq!(claude.role.as_deref(), Some("code-reviewer"));
        assert_eq!(claude.prompt.as_deref(), Some("Read src/auth."));

        // Copilot: `agent_type` + `prompt`, no recognisable tool name at all.
        let copilot = launch_of(
            None,
            Some("Delegating work"),
            Some(&serde_json::json!({
                "agent_type": "coding-agent",
                "prompt": "Fix the flaky test.",
                "description": "Fix the flaky test",
                "mode": "background",
            })),
            None,
        )
        .expect("Copilot's role field is enough on its own");
        assert_eq!(copilot.role.as_deref(), Some("coding-agent"));
        assert_eq!(copilot.name, "Fix the flaky test");

        // Grok: `subagentType`, the other spelling.
        let grok = launch_of(
            Some("spawn_subagent"),
            None,
            Some(&serde_json::json!({ "subagentType": "explorer", "prompt": "Look around." })),
            None,
        )
        .expect("Grok's spawn_subagent");
        assert_eq!(grok.role.as_deref(), Some("explorer"));
        assert_eq!(
            grok.name, "explorer",
            "no description, so the role names it"
        );

        // Antigravity: no tool name, no useful input — only the title.
        let antigravity = launch_of(None, Some("Running start_subagent"), None, None)
            .expect("Antigravity's rendered title");
        assert_eq!(antigravity.name, "Subagent");
        assert!(launch_of(None, Some("Run start_subagent?"), None, None).is_some());

        // Pi: the tool is simply called `subagent`.
        assert!(launch_of(Some("subagent"), None, None, None).is_some());

        // The native engine: namespaced `spawn_agent`, `agent_type`.
        let engine = launch_of(
            Some("multi_agent_v1__spawn_agent"),
            None,
            Some(&serde_json::json!({ "agent_type": "worker", "input": "Build it." })),
            None,
        )
        .expect("the engine's namespaced spawn_agent");
        assert_eq!(engine.role.as_deref(), Some("worker"));
        assert_eq!(engine.prompt.as_deref(), Some("Build it."));
    }

    /// Devin puts everything in a vendor `_meta` namespace and sends an
    /// ordinary-looking tool call. The namespace is unknowable; the leaf
    /// names are what repeat.
    #[test]
    fn a_vendor_meta_namespace_can_announce_a_subagent_on_its_own() {
        let launch = launch_of(
            Some("Tool"),
            Some("Tool"),
            None,
            Some(&meta(serde_json::json!({
                "cognition.ai/subagent_started": {
                    "agentId": "agent-7",
                    "title": "Investigate the crash",
                    "task": "Read the stack trace.",
                    "model": "devin-1",
                },
            }))),
        )
        .expect("a vendor namespace announcing a child");
        assert_eq!(launch.name, "Investigate the crash");
        assert_eq!(launch.prompt.as_deref(), Some("Read the stack trace."));
        assert_eq!(launch.native_id.as_deref(), Some("agent-7"));
    }

    /// A tree-shaped agent reports each thing it does to a child as its own
    /// call; the child's identity is the path, so the steps collapse to one.
    #[test]
    fn a_path_and_an_activity_are_a_lifecycle_step() {
        let step = |kind: &str| {
            serde_json::json!({
                "agentPath": "/root/ui_test_one",
                "agentThreadId": "thr_1",
                "activityKind": kind,
            })
        };
        let launch = launch_of(
            None,
            Some("Start subagent Ui test one"),
            Some(&step("started")),
            None,
        )
        .expect("a lifecycle step");
        assert_eq!(launch.name, "Ui test one");
        assert_eq!(launch.native_id.as_deref(), Some("/root/ui_test_one"));

        for (kind, expected) in [
            ("started", Activity::Started),
            ("interacted", Activity::Interacted),
            ("interrupted", Activity::Interrupted),
            ("completed", Activity::Completed),
        ] {
            assert_eq!(activity(Some(&step(kind))), Some(expected));
        }
        // Every step names the same child.
        let ids: Vec<_> = ["started", "completed"]
            .into_iter()
            .filter_map(|kind| launch_of(None, None, Some(&step(kind)), None))
            .map(|launch| launch.native_id)
            .collect();
        assert_eq!(ids, vec![Some("/root/ui_test_one".to_owned()); 2]);
    }

    /// The parent link, in each of the three spellings agents use for it.
    #[test]
    fn a_childs_work_names_its_launch_whatever_the_vendor_calls_the_key() {
        for namespace in [
            serde_json::json!({ "claudeCode": { "parentToolUseId": "toolu_01" } }),
            serde_json::json!({ "cognition.ai/subagent_context": { "parentAgentId": "toolu_01" } }),
            serde_json::json!({ "parentToolCallId": "toolu_01" }),
        ] {
            let parent = parent_tool_call_id(Some(&meta(namespace.clone())))
                .unwrap_or_else(|| panic!("no parent read from {namespace}"));
            assert_eq!(&*parent, "toolu_01");
        }
    }

    #[test]
    fn work_of_the_root_session_names_no_parent() {
        assert_eq!(parent_tool_call_id(None), None);
        assert_eq!(
            parent_tool_call_id(Some(&meta(serde_json::json!({})))),
            None
        );
        // An empty id would group every child under one phantom, and `root`
        // is how Devin spells "the top level".
        for empty in [
            serde_json::json!({ "claudeCode": { "parentToolUseId": "" } }),
            serde_json::json!({ "cognition.ai/subagent_context": { "parentAgentId": "root" } }),
        ] {
            assert_eq!(parent_tool_call_id(Some(&meta(empty))), None);
        }
    }

    /// Both spellings of "this child is now running on its own", taken from
    /// a real Claude async `Agent` result. Without this the child is marked
    /// finished the moment it starts.
    #[test]
    fn an_async_launch_is_recognised_in_the_result_and_in_the_metadata() {
        let launched = meta(serde_json::json!({
            "claudeCode": {
                "toolResponse": {
                    "isAsync": true,
                    "status": "async_launched",
                    "agentId": "aacecd385a6245f59",
                },
            },
        }));
        assert!(launched_async(None, Some(&launched)));

        let output = serde_json::json!([
            { "type": "text", "text": "Async agent launched successfully. (internal metadata)" },
        ]);
        assert!(launched_async(Some(&output), None));

        // A synchronous delegation says neither, so its call finishing is the
        // child finishing.
        assert!(!launched_async(
            Some(&serde_json::json!([{ "type": "text", "text": "No issues found." }])),
            Some(&meta(
                serde_json::json!({ "claudeCode": { "toolName": "Agent" } })
            ))
        ));
        assert!(!launched_async(None, None));
    }

    /// The tail of a real Claude `Agent` result, as replayed on `session/load`.
    /// It is the only clock a reopened child has.
    #[test]
    fn a_finished_child_reports_its_own_duration_and_work() {
        let output = serde_json::json!([{
            "type": "text",
            "text": "[Subagent hand-back] The report follows:\n  Hello there!\n\
                     agentId: a2dc4cf7e87baa427\n\
                     <usage>subagent_tokens: 28731\ntool_uses: 2\nduration_ms: 17145</usage>",
        }]);
        assert_eq!(
            reported_usage(Some(&output)),
            ReportedUsage {
                duration_ms: Some(17145),
                tool_uses: Some(2)
            }
        );

        // The structured form, where an agent sends one.
        let structured = serde_json::json!({ "totalDurationMs": 3283, "totalToolUseCount": 0 });
        assert_eq!(
            reported_usage(Some(&structured)),
            ReportedUsage {
                duration_ms: Some(3283),
                tool_uses: Some(0)
            }
        );

        // Prose that merely mentions a duration is not a report.
        let prose =
            serde_json::json!([{ "type": "text", "text": "duration_ms: 5 was the target" }]);
        assert_eq!(reported_usage(Some(&prose)), ReportedUsage::default());
        assert_eq!(reported_usage(None), ReportedUsage::default());
    }

    // ── the guard ───────────────────────────────────────────────────────
    //
    // A false positive is a phantom row that never completes, so ordinary
    // work must never read as a delegation.

    #[test]
    fn ordinary_tool_calls_are_not_launches() {
        let cases: &[(Option<&str>, Option<&str>, serde_json::Value)] = &[
            (
                Some("Bash"),
                Some("ls -la"),
                serde_json::json!({ "command": "ls -la" }),
            ),
            (
                Some("Read"),
                Some("Read src/main.rs"),
                serde_json::json!({ "file_path": "/x" }),
            ),
            // A tool whose name merely contains one of ours.
            (
                Some("TaskList"),
                Some("List the tasks"),
                serde_json::json!({}),
            ),
            (Some("update_task_status"), None, serde_json::json!({})),
            // A prose title with one of our words in it.
            (None, Some("Run the task list"), serde_json::json!({})),
            (None, Some("Start the agent server"), serde_json::json!({})),
            (
                None,
                Some("Delegate access to the team"),
                serde_json::json!({}),
            ),
            // A prompt and a description, but nothing saying it is a child.
            (
                Some("Write"),
                Some("Write the summary"),
                serde_json::json!({ "description": "Write it", "prompt": "Please." }),
            ),
            // A path, but no activity.
            (None, None, serde_json::json!({ "agentPath": "/root/x" })),
            // An activity kind this build does not know.
            (
                None,
                None,
                serde_json::json!({ "agentPath": "/root/x", "activityKind": "teleported" }),
            ),
        ];
        for (tool_name, title, input) in cases {
            assert_eq!(
                launch_of(*tool_name, *title, Some(input), None),
                None,
                "{tool_name:?}/{title:?} must not read as a subagent launch"
            );
        }
    }

    /// A title is only evidence when the agent sent no tool name at all: a
    /// title is prose, and a name is a name.
    #[test]
    fn a_title_never_overrides_a_tool_name_that_was_sent() {
        assert_eq!(
            launch_of(Some("Bash"), Some("Task"), None, None),
            None,
            "the tool said what it was; the title is its rendering"
        );
        assert!(
            launch_of(None, Some("Task"), None, None).is_some(),
            "with no name at all, the title is the only evidence there is"
        );
    }

    /// `_meta` announcements must be positive. An agent that writes
    /// `subagent: false` on every ordinary call is saying the opposite.
    #[test]
    fn a_negative_meta_announcement_is_not_an_announcement() {
        for value in [serde_json::json!(false), serde_json::json!(null)] {
            assert_eq!(
                launch_of(
                    Some("Bash"),
                    None,
                    None,
                    Some(&meta(serde_json::json!({ "acme": { "subagent": value } })))
                ),
                None
            );
        }
        assert!(launch_of(
            Some("Bash"),
            None,
            None,
            Some(&meta(serde_json::json!({ "acme": { "subagent": true } })))
        )
        .is_some());
    }

    /// A delegation whose only text is its instructions is named by them —
    /// "Subagent" tells the user nothing — but a name is a label, so a long
    /// prompt is clipped rather than used whole.
    #[test]
    fn a_launch_with_only_a_prompt_is_named_by_it() {
        let launch = launch_of(
            Some("Task"),
            None,
            Some(&serde_json::json!({ "task": "Investigate the crash" })),
            None,
        )
        .expect("a launch");
        assert_eq!(launch.name, "Investigate the crash");
        assert_eq!(launch.prompt.as_deref(), Some("Investigate the crash"));

        let long = "Read every file under src/ and ".repeat(10);
        let clipped = launch_of(
            Some("Task"),
            None,
            Some(&serde_json::json!({ "prompt": long })),
            None,
        )
        .expect("a launch");
        assert!(clipped.name.chars().count() <= 72, "{}", clipped.name);
        assert!(clipped.name.ends_with('…'));

        // A multi-byte opening must not be sliced mid-character.
        let emoji = "🚀".repeat(200);
        let safe = launch_of(
            Some("Task"),
            None,
            Some(&serde_json::json!({ "prompt": emoji })),
            None,
        )
        .expect("a launch");
        assert!(safe.name.chars().count() <= 72);
    }
}
