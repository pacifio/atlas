//! Reading the transcripts coding agents write for themselves.
//!
//! Two things live here, and both are Atlas-specific rather than ported from
//! Zed: the Claude Code JSONL replay that makes a resumed session paint its
//! own history, and the [`strip_injected_context`] rule that keeps Atlas's own
//! memory scaffolding from being mistaken for something the user typed.
//!
//! # Why it is its own crate
//!
//! Checkpoint touchpoint #11 says the port must not relocate or stop reading
//! agents' on-disk transcripts, and the readers that do so are spread across
//! the host (`commands/{claude,kilo,agent_memory,memory_pack,memory_timeline,
//! sessions_watch,capture}.rs`) — none of which are ACP code. Leaving this
//! module inside `atlas-agents` would have chained every one of those files to
//! the 1.3 protocol stack, which the ported stack can never share a Cargo graph
//! with (`agent-client-protocol-schema` is pinned exactly, `=1.4.0` vs
//! `=1.5.0`). Moved out of `atlas-agents/src/transcript.rs` unchanged at Stage
//! 3 of the Zed port.
//!
//! Nothing here names a protocol version, and nothing here should.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;

use atlas_agent_wire::{Message, MessageMode, MessageRole, ToolCall, ToolCallStatus};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Where an agent keeps its own record of a conversation, if anywhere.
///
/// This is what decides whether Atlas records a second copy: an agent with a
/// readable store of its own would otherwise put two rows in the sidebar for
/// one conversation, with two competing titles.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum TranscriptKind {
    /// No on-disk transcript — sessions are in-memory only and die with the
    /// process. These are the ones Atlas records itself.
    None,
    /// Canonical Claude Code JSONL at `~/.claude/projects/<encoded-cwd>/<id>.jsonl`.
    ClaudeJsonl,
    /// Native Cersei agent — JSON transcript under the app config dir, replayed
    /// by the native agent itself rather than through this module.
    CerseiJson,
}

/// Replay an agent's on-disk transcript for `(cwd, session_id)` into seed
/// messages. Returns an empty vec for transcript-less agents and for a session
/// whose file does not exist (a fresh session) — neither is an error.
///
/// The read+parse runs on `spawn_blocking`: these files reach 10k+ lines on a
/// long-lived project, and parsing one on a runtime worker would stall every
/// other agent sharing it.
pub async fn replay(kind: TranscriptKind, cwd: &str, session_id: &str) -> Vec<Message> {
    match kind {
        // The native agent replays its own JSON store; nothing to do here.
        TranscriptKind::None | TranscriptKind::CerseiJson => Vec::new(),
        TranscriptKind::ClaudeJsonl => {
            let cwd = cwd.to_string();
            let session_id = session_id.to_string();
            tokio::task::spawn_blocking(move || replay_claude_jsonl(&cwd, &session_id))
                .await
                .unwrap_or_default()
        }
    }
}

/// Parse one Claude Code JSONL transcript. Unreadable files and unparseable
/// lines yield nothing rather than failing the replay — a corrupt tail must not
/// cost the user the whole conversation.
pub fn replay_claude_jsonl(cwd: &str, session_id: &str) -> Vec<Message> {
    let Some(path) = claude_jsonl_path(cwd, session_id) else {
        return Vec::new();
    };
    let Ok(file) = std::fs::File::open(&path) else {
        return Vec::new();
    };
    let reader = BufReader::new(file);

    let mut out: Vec<Message> = Vec::new();
    for line in reader.lines().map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true) {
            continue;
        }
        // Compaction artifacts. Claude Code stamps the giant "This session is
        // being continued…" summary `isCompactSummary` (and marks it
        // `isVisibleInTranscriptOnly`) precisely so hosts don't render it as
        // conversation — replaying it produced a multi-KB fake user message in
        // every resumed compacted thread. `isMeta` lines are the harness
        // talking to itself (same rule the capture importer applies).
        if v.get("isCompactSummary").and_then(|x| x.as_bool()) == Some(true)
            || v.get("isVisibleInTranscriptOnly").and_then(|x| x.as_bool()) == Some(true)
            || v.get("isMeta").and_then(|x| x.as_bool()) == Some(true)
        {
            continue;
        }
        let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let timestamp = parse_timestamp(v.get("timestamp").and_then(|t| t.as_str()));
        match kind {
            "user" => {
                if let Some(text) = extract_user_message_text(&v) {
                    out.push(Message {
                        id: new_message_id(),
                        role: MessageRole::User,
                        mode: MessageMode::Text,
                        content: text,
                        thinking: String::new(),
                        tool_calls: Vec::new(),
                        plan: None,
                        model: None,
                        timestamp,
                    });
                }
            }
            "assistant" => {
                let (text, tool_calls) = extract_assistant_blocks(&v);
                // Claude Code records the producing model on every assistant
                // entry — carry it through so the UI's per-message badge
                // survives a session reload.
                let model = v
                    .get("message")
                    .and_then(|m| m.get("model"))
                    .and_then(|m| m.as_str())
                    .map(str::to_string);
                for tc in tool_calls {
                    out.push(Message {
                        id: new_message_id(),
                        role: MessageRole::Assistant,
                        mode: MessageMode::Tool,
                        content: String::new(),
                        thinking: String::new(),
                        tool_calls: vec![tc],
                        plan: None,
                        model: model.clone(),
                        timestamp,
                    });
                }
                if !text.trim().is_empty() {
                    out.push(Message {
                        id: new_message_id(),
                        role: MessageRole::Assistant,
                        mode: MessageMode::Text,
                        content: text,
                        thinking: String::new(),
                        tool_calls: Vec::new(),
                        plan: None,
                        model,
                        timestamp,
                    });
                }
            }
            _ => {}
        }
    }
    out
}

fn new_message_id() -> String {
    format!("msg-{}", uuid::Uuid::new_v4().simple())
}

fn parse_timestamp(raw: Option<&str>) -> DateTime<Utc> {
    raw.and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(Utc::now)
}

pub fn claude_jsonl_path(cwd: &str, session_id: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let folder = home.join(".claude").join("projects").join(encode_cwd(cwd));
    Some(folder.join(format!("{session_id}.jsonl")))
}

/// Claude Code encodes the project cwd as a folder name by replacing every
/// character that isn't ASCII alphanumeric with `-` (so `/`, spaces, `.`, `_`
/// all collapse to `-`). E.g. `/Users/adib/Desktop/atlas` →
/// `-Users-adib-Desktop-atlas`, and `/Users/adib/Codes/Test Atlas` →
/// `-Users-adib-Codes-Test-Atlas`. Matching this exactly is required — Atlas
/// reads the JSONL transcripts the Claude Agent SDK writes under that folder,
/// so a path with a space or dot must resolve to the SAME slug or the listing
/// finds nothing (was: only `/` was replaced → 0 rows for any path with a
/// space).
pub fn encode_cwd(cwd: &str) -> String {
    let trimmed = cwd.trim_end_matches('/');
    trimmed
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Identify user content injected by Claude Code itself (system tags,
/// interruption notices, warmup pings) rather than typed by the user.
pub fn is_injected_user_text(t: &str) -> bool {
    let trimmed = t.trim();
    if trimmed.is_empty() {
        return true;
    }
    if trimmed.starts_with('<') {
        return true;
    }
    if trimmed.starts_with("[Request interrupted") {
        return true;
    }
    if trimmed.eq_ignore_ascii_case("warmup") {
        return true;
    }
    false
}

/// Strip the Atlas-injected context blocks that `agents_send` prepends to the
/// wire prompt (shared cross-agent memory, retrieved long-term memory, recent-
/// session recap). The coding agent records the prompt it received in its
/// transcript, so a resumed session would otherwise surface the raw
/// `--- SHARED MEMORY ---` / `--- RELEVANT PROJECT MEMORY ---` scaffolding as
/// the user's message and chat title. Line-based: drop everything from a known
/// block start marker through its matching `--- END <LABEL> ---`.
pub fn strip_injected_context(text: &str) -> String {
    // Block START labels (the END marker is always `--- END <CORE> ---`). The
    // SHARED MEMORY block's start line may carry a suffix
    // ("— UPDATES SINCE LAST TURN"), so we match by prefix.
    const CORES: [&str; 4] = [
        "SHARED MEMORY",
        "RELEVANT PROJECT MEMORY",
        "PROJECT MEMORY",
        "RECENT SESSION",
    ];
    let mut out: Vec<&str> = Vec::new();
    let mut skip_until: Option<String> = None;
    for line in text.lines() {
        let l = line.trim();
        if let Some(end) = &skip_until {
            if l == end {
                skip_until = None;
            }
            continue;
        }
        if l.starts_with("--- ") && l.ends_with("---") && !l.starts_with("--- END") {
            let inner = l.trim_start_matches("--- ");
            if let Some(core) = CORES.iter().find(|c| inner.starts_with(**c)) {
                skip_until = Some(format!("--- END {core} ---"));
                continue;
            }
        }
        out.push(line);
    }
    out.join("\n").trim().to_string()
}

fn extract_user_message_text(v: &serde_json::Value) -> Option<String> {
    let content = v.get("message")?.get("content")?;
    if let Some(s) = content.as_str() {
        if is_injected_user_text(s) {
            return None;
        }
        let cleaned = strip_injected_context(s);
        return (!cleaned.is_empty()).then_some(cleaned);
    }
    if let Some(arr) = content.as_array() {
        let has_tool_result = arr
            .iter()
            .any(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result"));
        if has_tool_result {
            return None;
        }
        let text: String = arr
            .iter()
            .filter_map(|b| {
                (b.get("type").and_then(|t| t.as_str()) == Some("text"))
                    .then(|| b.get("text").and_then(|t| t.as_str()).map(str::to_string))
                    .flatten()
            })
            .collect::<Vec<_>>()
            .join("\n");
        if is_injected_user_text(&text) {
            return None;
        }
        let cleaned = strip_injected_context(&text);
        return (!cleaned.is_empty()).then_some(cleaned);
    }
    None
}

/// Map a Claude Code tool name (as stored in the JSONL transcript) to the ACP
/// `kind` the live stream would have set. Lets reloaded sessions recognise
/// bash/execute calls the same way live ones do (the frontend's bash panel +
/// bash-styled cards key off `kind == "execute"`).
fn tool_kind_for(name: &str) -> Option<String> {
    let k = match name {
        "Bash" | "BashOutput" | "KillShell" => "execute",
        "Read" | "NotebookRead" => "read",
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => "edit",
        "Glob" | "Grep" => "search",
        "WebFetch" | "WebSearch" => "fetch",
        _ => return None,
    };
    Some(k.to_string())
}

fn extract_assistant_blocks(v: &serde_json::Value) -> (String, Vec<ToolCall>) {
    let mut text_parts: Vec<String> = Vec::new();
    let mut tool_calls: Vec<ToolCall> = Vec::new();
    let Some(content) = v
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    else {
        return (String::new(), tool_calls);
    };
    for block in content {
        match block.get("type").and_then(|t| t.as_str()).unwrap_or("") {
            "text" => {
                if let Some(s) = block.get("text").and_then(|t| t.as_str()) {
                    text_parts.push(s.to_string());
                }
            }
            "tool_use" => {
                let name = block
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("tool")
                    .to_string();
                let input = block.get("input").cloned().unwrap_or(serde_json::json!({}));
                let id = block
                    .get("id")
                    .and_then(|s| s.as_str())
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("tc-{}", uuid::Uuid::new_v4().simple()));
                let kind = tool_kind_for(&name);
                tool_calls.push(ToolCall {
                    id,
                    tool_name: name.clone(),
                    title: Some(name),
                    kind,
                    status: ToolCallStatus::Completed,
                    arguments: input,
                    result: None,
                    raw_output: None,
                    content_blocks: Vec::new(),
                    locations: Vec::new(),
                });
            }
            _ => {}
        }
    }
    (text_parts.join("\n"), tool_calls)
}
