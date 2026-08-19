//! Atlas Agent session parsing — one JSON document per session under
//! `<config>/cersei-sessions/<cwd-hash>/<session_id>.json`, written by
//! `atlas-cersei/src/store.rs` (`StoredSession`). Messages are
//! Anthropic-shaped blocks; usage and cost are session-cumulative at the
//! top level (there are no per-message timestamps in this store).

use std::collections::HashMap;
use std::path::Path;

use serde_json::Value;

use super::{canonical_tool, is_bash_search, Candidate, CandidateKind, SessionBaseline};

/// Parse one stored session document.
pub fn parse_file(path: &Path) -> Result<(SessionBaseline, Vec<Candidate>), String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let doc: Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse {}: {e}", path.display()))?;
    Ok(parse_doc(&doc))
}

fn parse_doc(doc: &Value) -> (SessionBaseline, Vec<Candidate>) {
    let str_of = |k: &str| doc.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    let mut b = SessionBaseline {
        source: "cersei".into(),
        session_id: str_of("session_id"),
        cwd: str_of("cwd"),
        tokens_in: doc.pointer("/usage/input_tokens").and_then(Value::as_u64).unwrap_or(0),
        tokens_out: doc.pointer("/usage/output_tokens").and_then(Value::as_u64).unwrap_or(0),
        ..Default::default()
    };
    let model = str_of("model");
    if !model.is_empty() {
        b.models.insert(model);
    }

    let mut candidates = Vec::new();
    let mut call_names: HashMap<String, String> = HashMap::new();
    let empty = Vec::new();
    for msg in doc.get("messages").and_then(Value::as_array).unwrap_or(&empty) {
        let role = msg.get("role").and_then(Value::as_str).unwrap_or_default();
        match msg.get("content") {
            Some(Value::String(text)) if role == "user" => {
                // Steering recoveries and stop notices are runtime-injected
                // "[system] …" lines, not the user speaking.
                let text = text.trim();
                if text.is_empty() || text.starts_with("[system]") {
                    continue;
                }
                b.user_prompts += 1;
                candidates.push(Candidate {
                    kind: CandidateKind::PromptAnchor,
                    value: super::claude::truncate_candidate(text),
                    source: b.source.clone(),
                    session_id: b.session_id.clone(),
                });
            }
            Some(Value::Array(blocks)) => {
                for block in blocks {
                    match block.get("type").and_then(Value::as_str) {
                        Some("tool_use") => {
                            harvest_tool_use(block, &mut b, &mut candidates, &mut call_names)
                        }
                        Some("tool_result") => {
                            if !block.get("is_error").and_then(Value::as_bool).unwrap_or(false) {
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
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    (b, candidates)
}

fn harvest_tool_use(
    block: &Value,
    b: &mut SessionBaseline,
    candidates: &mut Vec<Candidate>,
    call_names: &mut HashMap<String, String>,
) {
    let Some(name) = block.get("name").and_then(Value::as_str) else {
        return;
    };
    if let Some(id) = block.get("id").and_then(Value::as_str) {
        call_names.insert(id.to_string(), name.to_string());
    }
    let canonical = canonical_tool(name);
    *b.tool_calls.entry(canonical.clone()).or_default() += 1;
    if canonical == "edit" {
        b.edit_calls += 1;
    }

    let get = |k: &str| block.pointer(&format!("/input/{k}")).and_then(Value::as_str);
    let mut push = |kind, value: &str| {
        candidates.push(Candidate {
            kind,
            value: super::claude::truncate_candidate(value),
            source: b.source.clone(),
            session_id: b.session_id.clone(),
        });
    };
    match name {
        "Bash" => {
            if let Some(command) = get("command") {
                if is_bash_search(command) {
                    b.bash_searches += 1;
                    push(CandidateKind::BashSearch, command);
                }
            }
        }
        "Grep" | "CodeSearch" => {
            if let Some(pattern) = get("pattern").or_else(|| get("query")) {
                push(CandidateKind::GrepPattern, pattern);
            }
        }
        "Read" | "Edit" | "Write" => {
            if let Some(fp) = get("file_path") {
                push(CandidateKind::FileTarget, fp);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Value {
        serde_json::json!({
            "session_id": "abc",
            "cwd": "/proj",
            "provider": "anthropic",
            "model": "claude-x",
            "updated_at": "2026-08-19T00:00:00Z",
            "usage": {"input_tokens": 500, "output_tokens": 80, "cost": 0.12},
            "messages": [
                {"role": "user", "content": "add a retry to the uploader"},
                {"role": "user", "content": "[system] Run stopped by the user."},
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "grep -rn retry src"}},
                    {"type": "tool_use", "id": "t2", "name": "Edit",
                     "input": {"file_path": "src/upload.rs", "edits": [{"old_string": "a", "new_string": "b"}]}}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "t2", "is_error": true, "content": "Could not find old_string"}
                ]}
            ]
        })
    }

    #[test]
    fn a_stored_session_yields_metrics_and_candidates() {
        let (b, candidates) = parse_doc(&fixture());
        assert_eq!(b.source, "cersei");
        assert_eq!(b.session_id, "abc");
        assert_eq!(b.user_prompts, 1, "[system] lines are not prompts");
        assert_eq!(b.edit_calls, 1);
        assert_eq!(b.edit_errors, 1);
        assert_eq!(b.bash_searches, 1);
        assert_eq!(b.tokens_in, 500);
        assert_eq!(b.tokens_out, 80);
        assert!(b.models.contains("claude-x"));

        let kinds: Vec<_> = candidates.iter().map(|c| c.kind).collect();
        assert_eq!(
            kinds,
            vec![CandidateKind::PromptAnchor, CandidateKind::BashSearch, CandidateKind::FileTarget]
        );
        assert_eq!(candidates[2].value, "src/upload.rs");
    }
}
