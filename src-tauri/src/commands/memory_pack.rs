//! Shared Cross-Agent Memory — pack + handoff builders.
//!
//! Two pieces of context get prepended to an agent's first message:
//!   1. **Curated pack** — high-signal facts from Atlas's per-project memory
//!      (`collect_corpus`), filtered to the curated kinds, recency-ranked, and
//!      budget-bounded. Built by [`build_memory_pack`] / [`curate_pack`].
//!   2. **Recent-session handoff** — the tail of the most recent *other* Claude
//!      session for this project, so a freshly-switched agent resumes context.
//!      Built by [`build_session_handoff`] / [`parse_handoff_turns`].
//!
//! [`compose_injection`] stitches the (optional) blocks in front of the user's
//! text. Every builder returns `Option`/empty so an absent source is a true
//! no-op (no delimiters, no allocation) — see the empty-pack hardening rule.
//!
//! Disk-touching entry points are kept thin around pure functions
//! (`curate_pack`, `parse_handoff_turns`, `pick_newest_session`) so the ranking,
//! filtering, and parsing logic is unit-testable without a filesystem.

use std::path::PathBuf;
use std::time::SystemTime;

use super::agent_memory::{collect_corpus, MemoryDoc};

/// Kinds that belong in a curated pack (from frontmatter `metadata.type`).
/// Deliberately excludes `index`, `instruction`, `thread`, `file`, `memory` —
/// those are either redundant, raw code, or too noisy for cross-agent priming.
const PACK_KINDS: [&str; 4] = ["feedback", "user", "project", "reference"];

/// Total character budget for the curated pack body.
const PACK_MAX_CHARS: usize = 8_000;

/// Per-entry body cap so one long fact can't dominate the pack.
const ENTRY_MAX_CHARS: usize = 400;

/// How many trailing turns of the previous session to carry over.
const HANDOFF_MAX_TURNS: usize = 8;

/// Per-turn cap for the raw handoff so a giant message can't blow the budget.
const TURN_MAX_CHARS: usize = 800;

// ── Curated pack ─────────────────────────────────────────────────────────────

/// Build the curated pack for a project. Async because `collect_corpus` is
/// async (it does its own `spawn_blocking` internally). Returns `None` when no
/// curated facts exist — caller treats that as "inject nothing".
pub async fn build_memory_pack(project_path: &str) -> Option<String> {
    let docs = collect_corpus(project_path).await;
    curate_pack(docs)
}

/// Pure core of the pack builder: filter to curated kinds, rank newest-first,
/// and accumulate entries until the char budget is hit. Returns the full block
/// (delimiters + footer) or `None` if nothing qualifies.
pub fn curate_pack(mut docs: Vec<MemoryDoc>) -> Option<String> {
    docs.retain(|d| PACK_KINDS.contains(&d.kind.as_str()));
    if docs.is_empty() {
        return None;
    }
    // Newest first — the most recent conventions/decisions matter most.
    docs.sort_by(|a, b| b.timestamp_ms.cmp(&a.timestamp_ms));

    let mut body = String::new();
    let mut count = 0usize;
    for d in &docs {
        let raw = if d.text.trim().is_empty() {
            d.summary.as_str()
        } else {
            d.text.as_str()
        };
        let entry = format!(
            "[{}] {}\n{}\n\n",
            d.kind,
            d.title,
            truncate_chars(raw.trim(), ENTRY_MAX_CHARS)
        );
        // Always include at least one entry; stop before exceeding the budget.
        if count > 0 && body.len() + entry.len() > PACK_MAX_CHARS {
            break;
        }
        body.push_str(&entry);
        count += 1;
    }
    if count == 0 {
        return None;
    }
    let footer = format!("({} memories · {} chars)", count, body.trim_end().len());
    Some(format!(
        "--- PROJECT MEMORY ---\n{}{}\n--- END PROJECT MEMORY ---",
        body, footer
    ))
}

// ── Recent-session handoff ───────────────────────────────────────────────────

/// Locate the newest *other* Claude session JSONL for `cwd` and return its last
/// `HANDOFF_MAX_TURNS` turns as `(raw_body, turn_count)`. Sync — call via
/// `spawn_blocking`. Returns `None` when there is no prior session.
pub fn build_session_handoff(cwd: &str, current_session_id: &str) -> Option<(String, usize)> {
    let home = dirs::home_dir()?;
    let dir = home
        .join(".claude")
        .join("projects")
        .join(atlas_agent_transcript::encode_cwd(cwd));

    // Tolerate a missing dir (user never ran Claude here) → no handoff, no error.
    let rd = std::fs::read_dir(&dir).ok()?;
    let mut candidates: Vec<(PathBuf, SystemTime)> = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        // Skip the current session (no self-handoff) and Claude's internal
        // sub-agent sidechain files (`agent-*.jsonl`).
        if stem == current_session_id || stem.starts_with("agent-") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(mtime) = meta.modified() else { continue };
        candidates.push((path, mtime));
    }
    let newest = pick_newest_session(candidates)?;
    let content = std::fs::read_to_string(&newest).ok()?;
    let turns = parse_handoff_turns(&content, HANDOFF_MAX_TURNS);
    if turns.is_empty() {
        return None;
    }
    let n = turns.len();
    Some((format_turns(&turns), n))
}

/// Pure: pick the most-recently-modified path from `(path, mtime)` candidates.
pub fn pick_newest_session(candidates: Vec<(PathBuf, SystemTime)>) -> Option<PathBuf> {
    candidates.into_iter().max_by_key(|(_, t)| *t).map(|(p, _)| p)
}

/// Pure: parse a Claude Code JSONL transcript into `(role, text)` turns, taking
/// the last `max_turns`. Mirrors `atlas_agent_transcript::replay_claude_jsonl`:
/// skips sidechain lines, tool-result user messages, and injected system text.
pub fn parse_handoff_turns(jsonl: &str, max_turns: usize) -> Vec<(String, String)> {
    let mut turns: Vec<(String, String)> = Vec::new();
    for line in jsonl.lines() {
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true) {
            continue;
        }
        match v.get("type").and_then(|t| t.as_str()).unwrap_or("") {
            "user" => {
                if let Some(t) = user_message_text(&v) {
                    turns.push(("User".into(), t));
                }
            }
            "assistant" => {
                if let Some(t) = assistant_message_text(&v) {
                    turns.push(("Assistant".into(), t));
                }
            }
            _ => {}
        }
    }
    if turns.len() > max_turns {
        turns = turns.split_off(turns.len() - max_turns);
    }
    turns
}

fn user_message_text(v: &serde_json::Value) -> Option<String> {
    let content = v.get("message")?.get("content")?;
    if let Some(s) = content.as_str() {
        if atlas_agent_transcript::is_injected_user_text(s) {
            return None;
        }
        return Some(s.trim().to_string());
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
                if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                    b.get("text").and_then(|t| t.as_str()).map(str::to_string)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        if atlas_agent_transcript::is_injected_user_text(&text) {
            return None;
        }
        return Some(text.trim().to_string());
    }
    None
}

fn assistant_message_text(v: &serde_json::Value) -> Option<String> {
    let arr = v.get("message")?.get("content")?.as_array()?;
    let text: String = arr
        .iter()
        .filter_map(|b| {
            if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                b.get("text").and_then(|t| t.as_str()).map(str::to_string)
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn format_turns(turns: &[(String, String)]) -> String {
    turns
        .iter()
        .map(|(role, text)| format!("{}: {}", role, truncate_chars(text, TURN_MAX_CHARS)))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Wrap a raw handoff body in the labelled block with an attribution footer.
pub fn wrap_handoff(body: &str, turn_count: usize, attribution: &str) -> String {
    format!(
        "--- RECENT SESSION ---\n{}\n(last {} turns · {})\n--- END RECENT SESSION ---",
        body, turn_count, attribution
    )
}

// ── Composition ──────────────────────────────────────────────────────────────

/// Prepend the (optional) already-wrapped blocks to the user's text. With both
/// blocks absent this returns `user_text` unchanged (zero-overhead no-op).
pub fn compose_injection(
    pack_block: Option<&str>,
    handoff_block: Option<&str>,
    user_text: &str,
) -> String {
    let mut parts: Vec<&str> = Vec::new();
    if let Some(p) = pack_block {
        if !p.is_empty() {
            parts.push(p);
        }
    }
    if let Some(h) = handoff_block {
        if !h.is_empty() {
            parts.push(h);
        }
    }
    if parts.is_empty() {
        return user_text.to_string();
    }
    format!("{}\n\n{}", parts.join("\n\n"), user_text)
}

/// Does this turn's text open with a slash command (`/skill-name [args]`)?
///
/// Load-bearing for correctness, not a nicety. Claude Code resolves slash
/// commands — including skills — only when the command sits at **byte 0 of the
/// first text block** (`claude-agent-acp` gates on `firstText.startsWith("/")`,
/// and `promptToClaude` anchors its rewrites with `^`). Every context block
/// Atlas *prepends* therefore pushes the command off byte 0 and demotes it to
/// prose: the command silently never fires. It is most visible on skills marked
/// `disable-model-invocation: true`, because the model cannot see those in its
/// own skill list either, so the turn dead-ends in "that skill isn't installed"
/// instead of the model quietly invoking it anyway and masking the failure.
///
/// Deliberately rejects absolute paths — `/Users/me/foo.rs is broken` opens with
/// a slash but is prose, and the interior `/` is what tells the two apart. A
/// command token runs to whitespace or end-of-string over
/// `[A-Za-z0-9_:-]` (`:` so plugin commands like `/codex:rescue` qualify).
pub fn is_slash_command(text: &str) -> bool {
    let Some(rest) = text.strip_prefix('/') else {
        return false;
    };
    let mut chars = rest.chars();
    // A command name opens alphanumeric: rules out `/ hello`, `/-x`, and `//`.
    match chars.next() {
        Some(c) if c.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    for c in chars {
        if c.is_whitespace() {
            return true; // token closed cleanly, args may follow
        }
        if !(c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == ':') {
            return false; // e.g. the `/` in `/Users/me` — a path, not a command
        }
    }
    true
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Truncate to at most `max` characters (char-boundary safe), appending `…`.
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(kind: &str, title: &str, text: &str, ts: i64) -> MemoryDoc {
        MemoryDoc {
            id: format!("claude:{title}"),
            title: title.into(),
            summary: text.into(),
            kind: kind.into(),
            source: "claude".into(),
            file_path: None,
            timestamp_ms: ts,
            text: text.into(),
            aliases: Vec::new(),
            links: Vec::new(),
        }
    }

    #[test]
    fn test_kind_filter() {
        let docs = vec![
            doc("feedback", "Fb", "f", 1),
            doc("user", "Us", "u", 2),
            doc("project", "Pr", "p", 3),
            doc("reference", "Rf", "r", 4),
            doc("file", "File", "code", 5),
            doc("thread", "Th", "t", 6),
            doc("index", "Ix", "i", 7),
        ];
        let pack = curate_pack(docs).expect("pack");
        assert!(pack.contains("[feedback] Fb"));
        assert!(pack.contains("[user] Us"));
        assert!(pack.contains("[project] Pr"));
        assert!(pack.contains("[reference] Rf"));
        assert!(!pack.contains("[file]"));
        assert!(!pack.contains("[thread]"));
        assert!(!pack.contains("[index]"));
        assert!(pack.contains("(4 memories"));
    }

    #[test]
    fn test_no_curated_docs_is_none() {
        let docs = vec![doc("file", "a", "x", 1), doc("index", "b", "y", 2)];
        assert!(curate_pack(docs).is_none());
    }

    #[test]
    fn test_budget_trim_prefers_recent() {
        // Each entry body is capped to ENTRY_MAX_CHARS; make many large docs so
        // the total exceeds PACK_MAX_CHARS and trimming kicks in.
        let big = "x".repeat(1000);
        let mut docs = Vec::new();
        for i in 0..40 {
            docs.push(doc("project", &format!("D{i}"), &big, i as i64));
        }
        let pack = curate_pack(docs).expect("pack");
        assert!(
            pack.len() <= PACK_MAX_CHARS + 200,
            "pack within budget: {}",
            pack.len()
        );
        // Newest (highest ts = D39) must be present; an old one (D0) dropped.
        assert!(pack.contains("[project] D39"));
        assert!(!pack.contains("[project] D0\n"));
    }

    #[test]
    fn test_transcript_parse_filters() {
        let jsonl = r#"
{"type":"user","message":{"content":"hello there"}}
{"type":"assistant","message":{"content":[{"type":"text","text":"hi back"}]}}
{"type":"user","isSidechain":true,"message":{"content":"sidechain noise"}}
{"type":"user","message":{"content":[{"type":"tool_result","content":"output"}]}}
{"type":"user","message":{"content":"<system-reminder>injected</system-reminder>"}}
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","id":"x","input":{}}]}}
"#;
        let turns = parse_handoff_turns(jsonl, 8);
        assert_eq!(turns.len(), 2, "only 2 real turns: {turns:?}");
        assert_eq!(turns[0], ("User".into(), "hello there".into()));
        assert_eq!(turns[1], ("Assistant".into(), "hi back".into()));
    }

    #[test]
    fn test_transcript_parse_takes_last_n() {
        let mut lines = String::new();
        for i in 0..20 {
            lines.push_str(&format!(
                "{{\"type\":\"user\",\"message\":{{\"content\":\"m{i}\"}}}}\n"
            ));
        }
        let turns = parse_handoff_turns(&lines, 8);
        assert_eq!(turns.len(), 8);
        assert_eq!(turns[0].1, "m12");
        assert_eq!(turns[7].1, "m19");
    }

    #[test]
    fn test_pick_newest_session() {
        let t0 = SystemTime::UNIX_EPOCH;
        let t1 = t0 + std::time::Duration::from_secs(100);
        let t2 = t0 + std::time::Duration::from_secs(200);
        let cands = vec![
            (PathBuf::from("/a/old.jsonl"), t0),
            (PathBuf::from("/a/newest.jsonl"), t2),
            (PathBuf::from("/a/mid.jsonl"), t1),
        ];
        assert_eq!(
            pick_newest_session(cands),
            Some(PathBuf::from("/a/newest.jsonl"))
        );
    }

    #[test]
    fn test_compose_injection_empty_is_passthrough() {
        assert_eq!(compose_injection(None, None, "hello"), "hello");
        assert_eq!(compose_injection(Some(""), Some(""), "hello"), "hello");
    }

    #[test]
    fn test_compose_injection_both() {
        let out = compose_injection(Some("PACK"), Some("HANDOFF"), "user text");
        assert_eq!(out, "PACK\n\nHANDOFF\n\nuser text");
    }

    #[test]
    fn test_compose_injection_pack_only() {
        let out = compose_injection(Some("PACK"), None, "u");
        assert_eq!(out, "PACK\n\nu");
    }

    #[test]
    fn test_wrap_handoff_shape() {
        let w = wrap_handoff("User: hi\nAssistant: yo", 2, "raw");
        assert!(w.starts_with("--- RECENT SESSION ---\n"));
        assert!(w.contains("(last 2 turns · raw)"));
        assert!(w.ends_with("--- END RECENT SESSION ---"));
    }

    #[test]
    fn test_is_slash_command_accepts_commands() {
        assert!(is_slash_command("/improve-codebase-architecture"));
        assert!(is_slash_command("/diagnosing-bugs"));
        assert!(is_slash_command("/codex:rescue")); // plugin command
        assert!(is_slash_command("/to_spec"));
        assert!(is_slash_command("/grill-with-docs some argument text"));
        assert!(is_slash_command("/handoff\nmultiline args"));
    }

    #[test]
    fn test_is_slash_command_rejects_prose_and_paths() {
        // The discriminator: an interior `/` means path, not command.
        assert!(!is_slash_command(
            "/Users/me/Developer/atlas/src/foo.rs is broken"
        ));
        assert!(!is_slash_command("/etc/hosts"));
        assert!(!is_slash_command("please run /implement for me"));
        assert!(!is_slash_command("no slash here"));
        assert!(!is_slash_command("/"));
        assert!(!is_slash_command("/ leading space"));
        assert!(!is_slash_command(""));
    }

    /// Regression: the composed wire text for a slash-command turn must keep the
    /// command at byte 0. Prepending any context block demotes it to prose and
    /// Claude Code never resolves the skill — the bug this guard exists to stop.
    #[test]
    fn test_injection_would_displace_a_slash_command() {
        let text = "/improve-codebase-architecture";
        assert!(is_slash_command(text));
        let injected = compose_injection(Some("--- PROJECT MEMORY ---\nx"), None, text);
        assert!(
            !injected.starts_with('/'),
            "injection moves the command off byte 0 — callers must skip it for slash turns"
        );
    }
}
