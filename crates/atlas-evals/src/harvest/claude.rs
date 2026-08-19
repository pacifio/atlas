//! Claude Code JSONL parsing — one file per session under
//! `~/.claude/projects/<encoded-cwd>/<session_id>.jsonl`. Line schema per
//! the corpus itself: conversation lines are `type: user|assistant` with an
//! Anthropic-shaped `message`; tool calls are assistant `tool_use` blocks,
//! results are user `tool_result` blocks correlated by id (the result line
//! names no tool). Injected context (system reminders, command envelopes)
//! is filtered with the same rules the product uses
//! (`atlas_agents::transcript`).

use std::collections::HashMap;
use std::path::Path;

use serde_json::Value;

use super::{canonical_tool, is_bash_search, Candidate, CandidateKind, SessionBaseline};

const MAX_CANDIDATE_LEN: usize = 500;

/// Parse one session file into (baseline metrics, retrieval candidates).
/// Malformed lines are skipped individually (a live session file ends
/// mid-object); an unreadable file is the caller's counted failure.
pub fn parse_file(path: &Path) -> Result<(SessionBaseline, Vec<Candidate>), String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let session_id = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(parse_lines(&raw, session_id))
}

fn parse_lines(raw: &str, session_id: String) -> (SessionBaseline, Vec<Candidate>) {
    let mut b = SessionBaseline {
        source: "claude_code".into(),
        session_id: session_id.clone(),
        ..Default::default()
    };
    let mut candidates = Vec::new();
    // tool_use id → wire tool name, for attributing tool_result errors.
    let mut call_names: HashMap<String, String> = HashMap::new();

    for line in raw.lines().filter(|l| !l.trim().is_empty()) {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if truthy(&v, "isSidechain") || truthy(&v, "isMeta") || truthy(&v, "isCompactSummary") {
            continue;
        }
        if b.cwd.is_empty() {
            if let Some(cwd) = v.get("cwd").and_then(Value::as_str) {
                b.cwd = cwd.to_string();
            }
        }
        match v.get("type").and_then(Value::as_str) {
            Some("user") => harvest_user_line(&v, &mut b, &mut candidates, &call_names),
            Some("assistant") => harvest_assistant_line(&v, &mut b, &mut candidates, &mut call_names),
            _ => {}
        }
    }
    (b, candidates)
}

fn harvest_user_line(
    v: &Value,
    b: &mut SessionBaseline,
    candidates: &mut Vec<Candidate>,
    call_names: &HashMap<String, String>,
) {
    let Some(content) = v.pointer("/message/content") else {
        return;
    };
    match content {
        // A plain-string user message is a genuine prompt unless it's an
        // injected envelope (system reminders, command wrappers).
        Value::String(text) => {
            if atlas_agents::transcript::is_injected_user_text(text) {
                return;
            }
            let stripped = atlas_agents::transcript::strip_injected_context(text);
            let anchor = truncate(stripped.trim(), MAX_CANDIDATE_LEN);
            if anchor.is_empty() {
                return;
            }
            b.user_prompts += 1;
            candidates.push(Candidate {
                kind: CandidateKind::PromptAnchor,
                value: anchor,
                source: b.source.clone(),
                session_id: b.session_id.clone(),
            });
        }
        Value::Array(blocks) => {
            for block in blocks {
                if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                    continue;
                }
                if !truthy(block, "is_error") {
                    continue;
                }
                let Some(name) = block
                    .get("tool_use_id")
                    .and_then(Value::as_str)
                    .and_then(|id| call_names.get(id))
                else {
                    continue;
                };
                let canonical = canonical_tool(name);
                *b.tool_errors.entry(canonical.clone()).or_default() += 1;
                if canonical == "edit" {
                    b.edit_errors += 1;
                }
            }
        }
        _ => {}
    }
}

fn harvest_assistant_line(
    v: &Value,
    b: &mut SessionBaseline,
    candidates: &mut Vec<Candidate>,
    call_names: &mut HashMap<String, String>,
) {
    if let Some(model) = v.pointer("/message/model").and_then(Value::as_str) {
        b.models.insert(model.to_string());
    }
    if let Some(usage) = v.pointer("/message/usage") {
        // Total context processed: fresh input plus both cache legs.
        for key in ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"] {
            b.tokens_in += usage.get(key).and_then(Value::as_u64).unwrap_or(0);
        }
        b.tokens_out += usage.get("output_tokens").and_then(Value::as_u64).unwrap_or(0);
    }
    let Some(blocks) = v.pointer("/message/content").and_then(Value::as_array) else {
        return;
    };
    for block in blocks {
        if block.get("type").and_then(Value::as_str) != Some("tool_use") {
            continue;
        }
        let Some(name) = block.get("name").and_then(Value::as_str) else {
            continue;
        };
        if let Some(id) = block.get("id").and_then(Value::as_str) {
            call_names.insert(id.to_string(), name.to_string());
        }
        let canonical = canonical_tool(name);
        *b.tool_calls.entry(canonical.clone()).or_default() += 1;
        if canonical == "edit" {
            b.edit_calls += 1;
        }

        let input = block.get("input");
        let get = |k: &str| input.and_then(|i| i.get(k)).and_then(Value::as_str);
        let mut push = |kind, value: &str| {
            candidates.push(Candidate {
                kind,
                value: truncate(value, MAX_CANDIDATE_LEN),
                source: b.source.clone(),
                session_id: b.session_id.clone(),
            });
        };
        match name {
            "Grep" => {
                if let Some(pattern) = get("pattern") {
                    push(CandidateKind::GrepPattern, pattern);
                }
            }
            "Bash" => {
                if let Some(command) = get("command") {
                    if is_bash_search(command) {
                        b.bash_searches += 1;
                        push(CandidateKind::BashSearch, command);
                    }
                }
            }
            "Read" | "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => {
                if let Some(fp) = get("file_path") {
                    push(CandidateKind::FileTarget, fp);
                }
            }
            _ => {}
        }
    }
}

/// Shared candidate truncation (both sources cap values the same way).
pub(crate) fn truncate_candidate(s: &str) -> String {
    truncate(s, MAX_CANDIDATE_LEN)
}

fn truthy(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        let mut end = max;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s[..end].to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> String {
        [
            // Genuine user prompt.
            r#"{"type":"user","sessionId":"s","cwd":"/proj","message":{"role":"user","content":"why does the parser drop the last token"}}"#,
            // Injected envelope — not a prompt.
            r#"{"type":"user","message":{"role":"user","content":"<system-reminder>noise</system-reminder>"}}"#,
            // Assistant: a search bash call, a grep, an edit, with usage.
            r#"{"type":"assistant","message":{"role":"assistant","model":"claude-x","usage":{"input_tokens":100,"cache_read_input_tokens":900,"output_tokens":40},"content":[
                {"type":"tool_use","id":"c1","name":"Bash","input":{"command":"rg -n token src/parser.rs"}},
                {"type":"tool_use","id":"c2","name":"Grep","input":{"pattern":"drop_last"}},
                {"type":"tool_use","id":"c3","name":"Edit","input":{"file_path":"/proj/src/parser.rs","old_string":"a","new_string":"b"}}
            ]}}"#
                .replace('\n', " ")
                .leak(),
            // The edit failed.
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"c3","is_error":true,"content":"not found"}]}}"#,
            // Sidechain lines are skipped entirely.
            r#"{"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[{"type":"tool_use","id":"x","name":"Bash","input":{"command":"rg side"}}]}}"#,
            // A non-search bash call produces no candidate.
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"c4","name":"Bash","input":{"command":"cargo test"}}]}}"#,
            "{not json — skipped per line}",
        ]
        .join("\n")
    }

    #[test]
    fn a_session_file_yields_baseline_metrics_and_candidates() {
        let (b, candidates) = parse_lines(&fixture(), "s".into());
        assert_eq!(b.cwd, "/proj");
        assert_eq!(b.user_prompts, 1);
        assert_eq!(b.edit_calls, 1);
        assert_eq!(b.edit_errors, 1);
        assert_eq!(b.bash_searches, 1);
        assert_eq!(b.tool_calls["bash"], 2);
        assert_eq!(b.tool_calls["search"], 1);
        assert_eq!(b.tool_errors["edit"], 1);
        assert_eq!(b.tokens_in, 1000);
        assert_eq!(b.tokens_out, 40);
        assert!(b.models.contains("claude-x"));

        let kinds: Vec<_> = candidates.iter().map(|c| c.kind).collect();
        assert_eq!(
            kinds,
            vec![
                CandidateKind::PromptAnchor,
                CandidateKind::BashSearch,
                CandidateKind::GrepPattern,
                CandidateKind::FileTarget,
            ]
        );
        assert_eq!(candidates[2].value, "drop_last");
    }

    #[test]
    fn truncation_respects_char_boundaries() {
        let long = "é".repeat(600);
        let t = truncate(&long, MAX_CANDIDATE_LEN);
        assert!(t.len() <= MAX_CANDIDATE_LEN);
        assert!(t.chars().all(|c| c == 'é'));
    }
}
