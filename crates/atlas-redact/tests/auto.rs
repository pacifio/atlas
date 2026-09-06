//! `redact_auto` — the shape-dispatching entrypoint for tool arguments and
//! tool results.
//!
//! A tool payload is JSON most of the time but not always, and the two shapes
//! need opposite treatment: flat redaction shreds a JSON envelope (every id
//! clears the entropy threshold), while the JSON walker cannot see prose.
//! `redact_auto` routes each input to the pass that preserves it.

use atlas_redact::{redact_auto, PLACEHOLDER};

mod fixtures;

struct Case {
    name: &'static str,
    input: String,
    /// Substrings that must not survive redaction.
    must_lose: &'static [&'static str],
    /// Substrings that must survive redaction.
    must_keep: &'static [&'static str],
}

#[test]
fn the_dispatch_table() {
    let github_pat = fixtures::github_pat();
    let cases = [
        Case {
            name: "a bare password key in a JSON document is redacted",
            input: r#"{"password": "hunter2"}"#.into(),
            must_lose: &["hunter2"],
            must_keep: &["password"],
        },
        Case {
            name: "a message id is preserved by the structure-aware path",
            input: r#"{"message_id": "xJ3kQ9vB2mZ7pL5rT8wN4cF6yH1sD0gA"}"#.into(),
            must_lose: &[],
            must_keep: &["xJ3kQ9vB2mZ7pL5rT8wN4cF6yH1sD0gA"],
        },
        Case {
            name: "a url field loses its password but keeps host and path",
            input: r#"{"url": "postgres://app:hunter2@db/x"}"#.into(),
            must_lose: &["hunter2"],
            must_keep: &["postgres://app:", "@db/x"],
        },
        Case {
            name: "a long plain url field is untouched",
            input: r#"{"url": "https://example.com/very/long/path"}"#.into(),
            must_lose: &[],
            must_keep: &["https://example.com/very/long/path"],
        },
        Case {
            name: "a provider token embedded in a url field is redacted in place",
            input: format!(r#"{{"url": "https://{github_pat}@github.com/org/repo"}}"#),
            must_lose: &[],
            must_keep: &["github.com/org/repo"],
        },
        Case {
            name: "prose takes the flat path",
            input: "deploy with API_KEY=supersecretvalue123 now".into(),
            must_lose: &["supersecretvalue123"],
            must_keep: &["deploy with API_KEY=", "now"],
        },
        Case {
            name: "a JSON fragment inside prose is caught by the flat quoted-key form",
            input: r#"the tool sent {"password": "hunter2"} and failed"#.into(),
            must_lose: &["hunter2"],
            must_keep: &["the tool sent", "and failed"],
        },
    ];

    for case in &cases {
        let out = redact_auto(&case.input);
        for lost in case.must_lose {
            assert!(
                !out.text.contains(lost),
                "[{}] secret survived\n  input:  {}\n  output: {}",
                case.name,
                case.input,
                out.text
            );
        }
        for kept in case.must_keep {
            assert!(
                out.text.contains(kept),
                "[{}] over-redacted\n  input:  {}\n  output: {}",
                case.name,
                case.input,
                out.text
            );
        }
    }

    // The token fixture never appears in `must_lose` (it is assembled at
    // runtime), so assert its absence separately.
    let embedded = format!(r#"{{"url": "https://{github_pat}@github.com/org/repo"}}"#);
    let out = redact_auto(&embedded);
    assert!(!out.text.contains(&github_pat), "provider token survived: {}", out.text);
    assert!(out.counts.total() > 0);
}

#[test]
fn json_output_is_always_valid_json() {
    // Secrets sitting against quotes inside a string value must not produce an
    // unparseable document — serde re-serialises the walked value, so escaping
    // is structural, but this is the guarantee downstream consumers rely on.
    let inputs = [
        r#"{"content": "he said \"API_KEY=supersecretvalue123\" loudly"}"#.to_string(),
        r#"{"url": "postgres://app:hunter2@db/x", "note": "line\nbreak"}"#.to_string(),
        format!(r#"{{"args": {{"cmd": "git clone https://{}@github.com/org/repo"}}}}"#, fixtures::github_pat()),
    ];
    for input in inputs {
        let out = redact_auto(&input);
        serde_json::from_str::<serde_json::Value>(&out.text)
            .unwrap_or_else(|e| panic!("invalid JSON after redaction of {input:?}: {e}\n  output: {}", out.text));
    }
}

#[test]
fn counts_flow_through_the_dispatch() {
    // Structured path: one credential value.
    let out = redact_auto(r#"{"password": "hunter2"}"#);
    assert_eq!(out.counts.total(), 1);
    assert!(out.changed());

    // Flat path: one credential value.
    let out = redact_auto("API_KEY=supersecretvalue123");
    assert_eq!(out.counts.total(), 1);

    // Clean input, either path: zero.
    assert_eq!(redact_auto(r#"{"role": "user"}"#).counts.total(), 0);
    assert_eq!(redact_auto("nothing secret here").counts.total(), 0);
}

#[test]
fn a_json_array_takes_the_structured_path_too() {
    let input = r#"[{"message_id": "xJ3kQ9vB2mZ7pL5rT8wN4cF6yH1sD0gA"}, {"password": "hunter2"}]"#;
    let out = redact_auto(input);
    assert!(out.text.contains("xJ3kQ9vB2mZ7pL5rT8wN4cF6yH1sD0gA"), "{}", out.text);
    assert!(!out.text.contains("hunter2"), "{}", out.text);
    assert!(out.text.contains(PLACEHOLDER));
}

#[test]
fn a_jsonl_payload_takes_the_structured_path_too() {
    // JSONL parses as no single value, so the dispatch declined it and the flat
    // pass ran over a document: ids shredded by the entropy layer, one count per
    // line instead of one per secret, and a span that ran past a JSON escape
    // leaving a line that no longer parses.
    let input = concat!(
        r#"{"message_id": "xJ3kQ9vB2mZ7pL5rT8wN4cF6yH1sD0gA", "content": "hi"}"#,
        "\n",
        r#"{"message_id": "aB9zQ2vX7mK4pL8rT3wN6cF1yH5sD0gE", "content": "API_KEY=supersecretvalue123"}"#,
        "\n",
        r#"{"cmd": "psql \"host=db.internal user=app password=hunter2 sslmode=require\""}"#,
    );
    let out = redact_auto(input);

    assert!(!out.text.contains("supersecretvalue123"), "secret survived: {}", out.text);
    assert!(!out.text.contains("hunter2"), "secret survived: {}", out.text);
    for id in ["xJ3kQ9vB2mZ7pL5rT8wN4cF6yH1sD0gA", "aB9zQ2vX7mK4pL8rT3wN6cF1yH5sD0gE"] {
        assert!(out.text.contains(id), "message id shredded: {}", out.text);
    }
    assert_eq!(out.counts.total(), 2, "counted per line, not per secret: {}", out.text);
    for line in out.text.split('\n') {
        serde_json::from_str::<serde_json::Value>(line)
            .unwrap_or_else(|e| panic!("line no longer parses: {e}\n  {line}"));
    }
}

#[test]
fn a_multi_line_payload_that_is_not_jsonl_still_takes_the_flat_path() {
    // One JSON line and then prose. Every line has to parse before the
    // structured path claims the input, or a log that happens to open with a
    // brace would come back re-serialised line by line.
    let input = "{\"tool\": \"read\"}\nthen it printed API_KEY=supersecretvalue123";
    let out = redact_auto(input);
    assert!(!out.text.contains("supersecretvalue123"), "secret survived: {}", out.text);
    assert!(out.text.contains("then it printed API_KEY="), "prose lost: {}", out.text);
}

#[test]
fn a_scalar_json_value_is_not_treated_as_a_document() {
    // A bare quoted string parses as JSON, but flat redaction is the right
    // treatment: there is no structure to preserve.
    let out = redact_auto("\"API_KEY=supersecretvalue123\"");
    assert!(!out.text.contains("supersecretvalue123"));
}

#[test]
fn redact_auto_is_idempotent() {
    let inputs = [
        r#"{"password": "hunter2"}"#.to_string(),
        r#"{"url": "postgres://app:hunter2@db/x"}"#.to_string(),
        r#"note: {"password": "hunter2"} failed"#.to_string(),
        format!(r#"{{"url": "https://{}@github.com/org/repo"}}"#, fixtures::github_pat()),
        r#"password: "hunter2""#.to_string(),
        "{\"message_id\": \"xJ3kQ9vB2mZ7pL5rT8wN4cF6yH1sD0gA\"}\n{\"password\": \"hunter2\"}"
            .to_string(),
    ];
    for input in inputs {
        let once = redact_auto(&input);
        let twice = redact_auto(&once.text);
        assert_eq!(twice.text, once.text, "second pass changed the output for {input:?}");
        assert_eq!(
            twice.counts.total(),
            0,
            "second pass re-redacted its own output for {input:?}"
        );
    }
}
