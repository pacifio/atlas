//! Negative cases — the half of correctness that has no incident report.
//!
//! Because redaction runs *before* storage, there is no raw local copy to
//! recover from: a false positive is permanent data loss, silent, and discovered
//! only when someone opens a Session months later and finds `[REDACTED]` where
//! the explanation used to be. These cases are load-bearing. A change that makes
//! any of them fail is a change that has quietly started destroying transcripts.

use atlas_redact::{redact, redact_json, PLACEHOLDER};

mod fixtures;

#[track_caller]
fn assert_untouched(input: &str) {
    let out = redact(input);
    assert_eq!(
        out.text, input,
        "over-redacted\n  input:  {input}\n  output: {}",
        out.text
    );
    assert_eq!(out.counts.total(), 0, "counted a replacement for {input:?}");
}

#[test]
fn ordinary_prose_is_untouched() {
    for input in [
        "the quick brown fox jumps over the lazy dog",
        "I refactored the session manager to take the writer lock earlier",
        "this fails because the token bucket resets on the wrong boundary",
        "Note: the JWT lives in config, not in the environment",
    ] {
        assert_untouched(input);
    }
}

#[test]
fn code_and_identifiers_are_untouched() {
    for input in [
        "fn get_user_by_identifier(identifier: &str) -> Option<User>",
        "import { ConversationService } from './services/conversation'",
        "const DEFAULT_AUTH_BASE = \"https://auth.tryatlas.cc/api/auth\";",
        "cargo build --release --target aarch64-apple-darwin",
        "git rebase --interactive --autosquash origin/main",
    ] {
        assert_untouched(input);
    }
}

#[test]
fn documentation_placeholders_survive() {
    for input in [
        "set API_KEY=<your-api-key> before running",
        "export DB_PASSWORD=changeme",
        "postgres://user:<password>@localhost:5432/dev",
        "redis://:${REDIS_PASSWORD}@cache:6379/0",
        "SECRET_TOKEN=****",
        "api_key: xxxxxxxx",
    ] {
        assert_untouched(input);
    }
}

#[test]
fn keys_that_merely_contain_a_credential_word_are_untouched() {
    // Every one of these would be redacted by a naive substring match, and every
    // one of them is ordinary application code.
    for input in [
        "token_count=1284",
        "secret_santa_name=alice",
        "password_policy=strict",
        "cache_key=user:1234:profile",
        "primary_key=id",
        "sort_key=created_at",
        "PWD=/Users/nafiz/Development/atlas",
    ] {
        assert_untouched(input);
    }
}

#[test]
fn a_credential_word_used_in_a_sentence_is_untouched() {
    for input in [
        "the secret: it was a race condition all along",
        "token: the lexer emits one per line",
        "password: still the weakest link in the chain",
    ] {
        assert_untouched(input);
    }
}

#[test]
fn a_flag_run_that_is_not_a_dsn_is_untouched() {
    assert_untouched("cargo build --features=a --target=b --profile=release");
    assert_untouched("host=localhost user=app dbname=dev sslmode=disable");
}

#[test]
fn git_shas_and_low_entropy_hex_survive() {
    // A commit sha is 40 hex characters, which a careless entropy threshold
    // flags — and this crate sits directly beside a feature whose entire job is
    // recording commit shas.
    for input in [
        "b7950a9c1d2e3f405162738495a6b7c8d9e0f1a2",
        "reverted in 96b6dfb and re-landed in d35a22e",
    ] {
        assert_untouched(input);
    }
}

#[test]
fn the_provider_layer_carries_no_rule_for_a_publishable_key() {
    // A Supabase publishable key is designed to ship in client code and is
    // protected by row-level security, so the provider layer deliberately has no
    // rule for it. The entropy layer still redacts it, because a 40-character
    // random token is indistinguishable from a secret without a prefix
    // allowlist — and an allowlist that *suppresses* redaction is a mechanism
    // whose failure mode is a real key passing through. Over-redacting one
    // public token is the cheaper wrong answer, and this test records that as a
    // decision rather than leaving it to be rediscovered.
    let out = redact(&fixtures::supabase_publishable_key());
    assert_eq!(out.counts.get(atlas_redact::Category::ProviderToken), 0);

    // A low-entropy publishable key — one the entropy layer cannot see — is
    // genuinely left alone, which is the part the provider layer controls.
    assert_untouched(&fixtures::supabase_publishable_key_low_entropy());
}

#[test]
fn json_fragments_with_ordinary_keys_survive_the_flat_pass() {
    // The quoted-key credential form must not turn every JSON snippet quoted in
    // prose into placeholder soup: numeric limits, flags and counter fields are
    // the bread and butter of tool arguments.
    for input in [
        r#"{"max_tokens": 4096, "temperature": 0.7}"#,
        r#"retrying with {"use_token": true} after the 429"#,
        r#"config was {"token_count": 51234} at the time"#,
        r#"{"role": "assistant", "stop_reason": "end_turn"}"#,
    ] {
        assert_untouched(input);
    }
}

#[test]
fn a_url_field_keeps_its_host_and_path() {
    // `url`/`uri` values skip the entropy layer (a long signed path is not a
    // secret) but are still scanned for embedded credentials — and a clean link
    // must come through byte-identical.
    for input in [
        r#"{"url":"https://example.com/very/long/path"}"#,
        r#"{"uri":"https://docs.example.com/guides/2026/setting-up-redaction?section=layers"}"#,
    ] {
        let out = redact_json(input);
        assert_eq!(out.text, input, "over-redacted: {}", out.text);
        assert_eq!(out.counts.total(), 0);
    }
}

#[test]
fn json_structure_field_names_and_ids_survive() {
    let input = r#"{"session_id":"xJ3kQ9vB2mZ7pL5rT8wN4cF6yH1sD0gA","file_path":"/Users/nafiz/dev/atlas/src/lib.rs","role":"assistant"}"#;
    let out = redact_json(input);
    assert!(!out.text.contains(PLACEHOLDER), "over-redacted: {}", out.text);
    assert_eq!(out.counts.total(), 0);
}

#[test]
fn over_redaction_of_a_whole_transcript_would_be_visible_here() {
    // A realistic assistant turn: prose, code, paths, a shell command. Nothing
    // in it is a secret, and the whole thing must come through intact.
    let input = "\
I've added a token bucket keyed on org_id. The limiter lives in
src/services/rate_limit.rs and reads RATE_LIMIT_RPM from settings.

Run `cargo test --package atlas-codeindex rate_limit` to check it. The
existing test at tests/limits.rs:42 already covers the burst case.";
    assert_untouched(input);
}
