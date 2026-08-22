//! The rules that decide what a resumed session shows the user.
//!
//! Every case here is a line Claude Code actually writes into its JSONL and a
//! decision about whether it is conversation. Getting one wrong is visible:
//! a compaction summary replayed as a user message is multiple KB of harness
//! prose at the top of the thread, and an un-stripped memory block becomes the
//! session's title.

use atlas_agent_transcript::{
    encode_cwd, is_injected_user_text, replay_claude_jsonl, strip_injected_context, TranscriptKind,
};
use atlas_agent_wire::{MessageMode, MessageRole};

#[test]
fn cwd_encoding_collapses_every_non_alphanumeric() {
    // Claude Code's own slug rule. A mismatch here means zero history rows
    // for any project whose path has a space or a dot.
    assert_eq!(encode_cwd("/Users/adib/Desktop/atlas"), "-Users-adib-Desktop-atlas");
    assert_eq!(
        encode_cwd("/Users/adib/Codes/Test Atlas"),
        "-Users-adib-Codes-Test-Atlas"
    );
    assert_eq!(encode_cwd("/a/b.c_d"), "-a-b-c-d");
    // A trailing slash is not part of the project path.
    assert_eq!(encode_cwd("/a/b/"), encode_cwd("/a/b"));
}

#[test]
fn injected_user_text_is_recognised() {
    for t in ["", "   ", "<system-reminder>x</system-reminder>", "[Request interrupted by user]", "warmup", "WARMUP"] {
        assert!(is_injected_user_text(t), "{t:?} should read as injected");
    }
    assert!(!is_injected_user_text("fix the bug"));
}

#[test]
fn memory_blocks_are_stripped_but_the_users_words_survive() {
    let text = "--- SHARED MEMORY — UPDATES SINCE LAST TURN ---\nfacts\n--- END SHARED MEMORY ---\n\nwhat changed?";
    assert_eq!(strip_injected_context(text), "what changed?");
}

#[test]
fn an_unterminated_block_does_not_eat_the_rest_of_the_prompt() {
    // Defensive: a truncated transcript line could leave the END marker off.
    // Everything after the start marker is dropped, which is the safe side —
    // scaffolding must never be shown as the user's words.
    let text = "--- PROJECT MEMORY ---\nfacts\nno end marker";
    assert_eq!(strip_injected_context(text), "");
}

#[test]
fn prose_with_horizontal_rules_is_left_alone() {
    // `---` fences are ordinary markdown; only the known block labels count.
    let text = "before\n--- NOT A MEMORY BLOCK ---\nafter";
    assert_eq!(strip_injected_context(text), text);
}

/// The parser is only ever pointed at `~/.claude/projects/…`, so the
/// file-level behaviour that matters is: a path that isn't there yields
/// nothing rather than an error. A fresh session hits this on every open.
#[test]
fn a_missing_transcript_replays_as_empty() {
    assert!(replay_claude_jsonl("/nonexistent/project", "no-such-session").is_empty());
}

#[tokio::test]
async fn agents_with_no_transcript_of_their_own_replay_nothing() {
    assert!(atlas_agent_transcript::replay(TranscriptKind::None, "/tmp", "s").await.is_empty());
    // The native agent replays its own JSON store, not through this module.
    assert!(atlas_agent_transcript::replay(TranscriptKind::CerseiJson, "/tmp", "s").await.is_empty());
}

/// End-to-end over a real JSONL body, driven through a temp `$HOME` so the
/// canonical path resolution is exercised too.
#[test]
fn a_transcript_replays_to_messages_in_order() {
    let home = std::env::temp_dir().join(format!("atlas-transcript-{}", uuid::Uuid::new_v4()));
    let cwd = "/tmp/proj";
    let dir = home.join(".claude").join("projects").join(encode_cwd(cwd));
    std::fs::create_dir_all(&dir).unwrap();
    let lines = [
        // Conversation.
        r#"{"type":"user","timestamp":"2026-08-22T10:00:00Z","message":{"content":"add a test"}}"#,
        // A tool call and prose in one assistant entry → two wire messages.
        r#"{"type":"assistant","timestamp":"2026-08-22T10:00:01Z","message":{"model":"claude-opus-5","content":[{"type":"tool_use","id":"tc1","name":"Bash","input":{"command":"ls"}},{"type":"text","text":"done"}]}}"#,
        // Everything below must be skipped.
        r#"{"type":"user","isCompactSummary":true,"message":{"content":"This session is being continued…"}}"#,
        r#"{"type":"user","isMeta":true,"message":{"content":"meta"}}"#,
        r#"{"type":"user","isSidechain":true,"message":{"content":"sidechain"}}"#,
        r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"x"}]}}"#,
        r#"{"type":"user","message":{"content":"<system-reminder>hi</system-reminder>"}}"#,
        "not json at all",
    ];
    std::fs::write(dir.join("sess.jsonl"), lines.join("\n")).unwrap();

    // `set_var` is unsafe on 2024 edition; this crate is 2021 and the test is
    // single-threaded, so the temp-HOME swap is sound here.
    let previous = std::env::var("HOME").ok();
    std::env::set_var("HOME", &home);
    let out = replay_claude_jsonl(cwd, "sess");
    match previous {
        Some(h) => std::env::set_var("HOME", h),
        None => std::env::remove_var("HOME"),
    }
    let _ = std::fs::remove_dir_all(&home);

    assert_eq!(out.len(), 3, "prompt + tool call + prose, nothing else");
    assert_eq!(out[0].role, MessageRole::User);
    assert_eq!(out[0].content, "add a test");

    // Tool calls come before the prose of the same entry, so the UI paints the
    // work in the order it happened.
    assert_eq!(out[1].mode, MessageMode::Tool);
    let tc = &out[1].tool_calls[0];
    assert_eq!(tc.id, "tc1");
    assert_eq!(tc.tool_name, "Bash");
    // The `kind` mapping is what makes a reloaded Bash call render as one.
    assert_eq!(tc.kind.as_deref(), Some("execute"));
    assert_eq!(out[1].model.as_deref(), Some("claude-opus-5"));

    assert_eq!(out[2].mode, MessageMode::Text);
    assert_eq!(out[2].content, "done");
}
