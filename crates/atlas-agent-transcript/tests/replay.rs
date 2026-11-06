//! The helpers left over from the Claude JSONL replay, which is gone: Atlas no
//! longer reads another program's storage to draw a resumed session (ADR-0001).
//! What survives has live callers that still depend on exactly these rules.
//!
//! - `encode_cwd` names the `~/.claude/projects/<slug>` folder that the
//!   checkpoint importer (`capture.rs`) and the session handoff
//!   (`memory_pack.rs`) read. A slug that differs from Claude Code's own finds
//!   nothing, for any project whose path has a space or a dot.
//! - `strip_injected_context` / `is_injected_user_text` keep Atlas's own memory
//!   scaffolding and harness text out of what reads as the user's words — in
//!   thread titles, the memory timeline and the handoff. An un-stripped memory
//!   block becomes the session's title.

use atlas_agent_transcript::{
    encode_cwd, is_injected_user_text, strip_injected_context, wrap_memory_envelope,
    MEMORY_ENVELOPE_CLOSE, MEMORY_ENVELOPE_NOTE, MEMORY_ENVELOPE_OPEN,
};

#[test]
fn cwd_encoding_collapses_every_non_alphanumeric() {
    // Claude Code's own slug rule. A mismatch here means zero history rows
    // for any project whose path has a space or a dot.
    assert_eq!(
        encode_cwd("/Users/adib/Desktop/atlas"),
        "-Users-adib-Desktop-atlas"
    );
    assert_eq!(
        encode_cwd("/Users/adib/Codes/Test Atlas"),
        "-Users-adib-Codes-Test-Atlas"
    );
    assert_eq!(encode_cwd("/a/b.c_d"), "-a-b-c-d");
    // A trailing slash is not part of the project path.
    assert_eq!(encode_cwd("/a/b/"), encode_cwd("/a/b"));
}

/// Expected values are the SDK's own `xt()` run under node (core.mjs,
/// 0.3.287), not derived from the Rust: a non-BMP character is two UTF-16
/// units and so two dashes, and a slug over 200 units is cut and suffixed
/// with a base-36 hash of the whole path.
#[test]
fn cwd_encoding_matches_the_sdk_for_unicode_and_long_paths() {
    assert_eq!(encode_cwd("/tmp/\u{1F600} x"), "-tmp----x");
    assert_eq!(encode_cwd("/Users/a/caf\u{e9}"), "-Users-a-caf-");

    let long = format!(
        "/Users/adib/{}project",
        "very-long-directory-name/".repeat(9)
    );
    assert_eq!(
        encode_cwd(&long),
        "-Users-adib-very-long-directory-name-very-long-directory-name-very-long-directory-name-very-long-directory-name-very-long-directory-name-very-long-directory-name-very-long-directory-name-very-long-dir-dg7k6s"
    );

    let long_emoji = format!("/Users/adib/{}end", "dir\u{1F600}name/".repeat(25));
    assert_eq!(
        encode_cwd(&long_emoji),
        "-Users-adib-dir--name-dir--name-dir--name-dir--name-dir--name-dir--name-dir--name-dir--name-dir--name-dir--name-dir--name-dir--name-dir--name-dir--name-dir--name-dir--name-dir--name-dir--name-dir--nam-a0477a"
    );
}

#[test]
fn injected_user_text_is_recognised() {
    for t in [
        "",
        "   ",
        "<system-reminder>x</system-reminder>",
        "[Request interrupted by user]",
        "warmup",
        "WARMUP",
    ] {
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

#[test]
fn the_envelope_opens_with_the_do_not_persist_line() {
    let env = wrap_memory_envelope(&["--- SHARED MEMORY ---\nfacts\n--- END SHARED MEMORY ---"])
        .expect("a non-empty block makes an envelope");
    let mut lines = env.lines();
    assert_eq!(lines.next(), Some(MEMORY_ENVELOPE_OPEN));
    assert_eq!(lines.next(), Some(MEMORY_ENVELOPE_NOTE));
    assert_eq!(env.lines().last(), Some(MEMORY_ENVELOPE_CLOSE));
}

#[test]
fn an_envelope_with_nothing_in_it_is_not_written() {
    assert_eq!(wrap_memory_envelope(&[]), None);
    assert_eq!(wrap_memory_envelope(&["", "   "]), None);
}

#[test]
fn the_whole_envelope_is_stripped_including_its_note() {
    // What an agent that saved Atlas's injected prompt writes back to disk.
    let env = wrap_memory_envelope(&[
        "--- SHARED MEMORY ---\nUse RS256\n--- END SHARED MEMORY ---",
        "--- PROJECT MEMORY ---\nnever commit\n--- END PROJECT MEMORY ---",
    ])
    .unwrap();
    let text = format!("{env}\n\nwhat changed?");
    let stripped = strip_injected_context(&text);
    assert_eq!(stripped, "what changed?");
    for leaked in [
        MEMORY_ENVELOPE_OPEN,
        MEMORY_ENVELOPE_CLOSE,
        MEMORY_ENVELOPE_NOTE,
        "RS256",
        "never commit",
    ] {
        assert!(!stripped.contains(leaked), "{leaked:?} survived the strip");
    }
}

#[test]
fn an_unterminated_envelope_does_not_eat_the_rest_of_the_prompt() {
    // A truncated preview cuts the closing tag off. Dropping the remainder is
    // the safe side: scaffolding must never read as the user's words.
    let text = format!("{MEMORY_ENVELOPE_OPEN}\n{MEMORY_ENVELOPE_NOTE}\nfacts");
    assert_eq!(strip_injected_context(&text), "");
}

#[test]
fn prose_mentioning_the_tag_inline_is_left_alone() {
    // Only a line that IS the tag opens an envelope, so prose about the feature
    // survives being written down.
    let text = "we wrap blocks in an <atlas-memory> tag now";
    assert_eq!(strip_injected_context(text), text);
}
