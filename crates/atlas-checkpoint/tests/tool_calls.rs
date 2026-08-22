//! Tool calls, file touches and edit patches — driven through the public API
//! against a real database, asserting on what ends up stored.
//!
//! The recurring theme is that every failure mode here is **silent**: a canonical
//! name that churns produces garbage counts nobody validates, a dropped location
//! produces a Checkpoint that never forms, a mangled path produces the same. So
//! these tests assert the stored rows rather than the code path that wrote them.

use atlas_checkpoint::model::WorkspaceMode;
use atlas_checkpoint::tools::{canonical_name, extract_paths, resolve_path, ToolName};
use atlas_checkpoint::{
    hash_written_content, Capture, FileWrite, SessionKey, Source, Store, ToolCallContent,
    ToolStatus, SPILL_THRESHOLD_BYTES,
};

const WORKSPACE: &str = "ws-atlas";

fn store_in(dir: &std::path::Path) -> Store {
    Store::open(dir.join(".atlas")).expect("store opens")
}

fn key() -> SessionKey {
    SessionKey {
        workspace_id: WORKSPACE.to_string(),
        source: Source::Acp,
        native_session_id: "sess-1".to_string(),
    }
}

fn no_locations() -> serde_json::Value {
    serde_json::json!([])
}

/// A session with one prompt already recorded.
fn started(store: &mut Store) -> String {
    let mut capture = Capture::new(store, WorkspaceMode::Local);
    capture
        .record_prompt(&key(), "Add rate limiting", 1, Some("claude-code"), None, None)
        .expect("prompt")
}

// ── Tool calls are rows ─────────────────────────────────────────────────────

#[test]
fn a_turn_that_reads_edits_and_runs_a_shell_command_records_three_rows() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let session_id = started(&mut store);
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    for (native_id, name, title, kind) in [
        ("tc-1", ToolName::Read, "Read src/limits.rs", "read"),
        ("tc-2", ToolName::Edit, "Edit src/rate_limit.rs", "edit"),
        ("tc-3", ToolName::Bash, "Bash(cargo test)", "execute"),
    ] {
        capture
            .record_tool_call(
                &session_id,
                ToolCallContent {
                    turn_seq: 1,
                    native_call_id: Some(native_id),
                    tool_name: name,
                    title: Some(title),
                    kind: Some(kind),
                    status: ToolStatus::Completed,
                    locations: &no_locations(),
                    arguments: None,
                    result: None,
                },
            )
            .expect("tool call recorded");
    }

    let calls = store.tool_calls_for_session(&session_id).unwrap();
    assert_eq!(calls.len(), 3);
    // Ordered within the turn, and attributed to it.
    assert!(calls.windows(2).all(|w| w[0].seq < w[1].seq));
    assert!(calls.iter().all(|c| c.turn_seq == 1));
    assert!(calls.iter().all(|c| c.session_id == session_id));
}

#[test]
fn counting_tool_calls_by_kind_is_answerable_by_query_alone() {
    // The sidebar's *Tool calls 4 · File edits 1 · Bash 1 · Read 2*. No message
    // body is read and no blob is touched.
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let session_id = started(&mut store);
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    for (native_id, name) in [
        ("a", ToolName::Read),
        ("b", ToolName::Read),
        ("c", ToolName::Edit),
        ("d", ToolName::Bash),
    ] {
        capture
            .record_tool_call(
                &session_id,
                ToolCallContent {
                    turn_seq: 1,
                    native_call_id: Some(native_id),
                    tool_name: name,
                    title: None,
                    kind: None,
                    status: ToolStatus::Completed,
                    locations: &no_locations(),
                    arguments: None,
                    result: None,
                },
            )
            .unwrap();
    }

    let counts = store.tool_call_counts(&session_id).unwrap();
    let lookup = |name| {
        counts
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, c)| *c)
            .unwrap_or(0)
    };
    assert_eq!(lookup(ToolName::Read), 2);
    assert_eq!(lookup(ToolName::Edit), 1);
    assert_eq!(lookup(ToolName::Bash), 1);
    assert_eq!(counts.iter().map(|(_, c)| c).sum::<i64>(), 4);
}

#[test]
fn a_failed_tool_call_is_recorded_with_failed_status_rather_than_dropped() {
    // "What did the agent try that didn't work" is often the most useful
    // question about a Session.
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let session_id = started(&mut store);
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    capture
        .record_tool_call(
            &session_id,
            ToolCallContent {
                turn_seq: 1,
                native_call_id: Some("tc-1"),
                tool_name: ToolName::Bash,
                title: Some("Bash(cargo test)"),
                kind: Some("execute"),
                status: ToolStatus::Failed,
                locations: &no_locations(),
                arguments: None,
                result: Some(b"error: test failed"),
            },
        )
        .unwrap();

    let calls = store.tool_calls_for_session(&session_id).unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].status, ToolStatus::Failed);
}

#[test]
fn a_later_update_refines_the_call_rather_than_duplicating_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let session_id = started(&mut store);
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    let first = capture
        .record_tool_call(
            &session_id,
            ToolCallContent {
                turn_seq: 1,
                native_call_id: Some("tc-1"),
                tool_name: ToolName::Bash,
                title: Some("Bash"),
                kind: Some("execute"),
                status: ToolStatus::Running,
                locations: &no_locations(),
                arguments: Some(r#"{"command":"cargo test"}"#),
                result: None,
            },
        )
        .unwrap();

    // The completion update carries only status and result.
    let second = capture
        .record_tool_call(
            &session_id,
            ToolCallContent {
                turn_seq: 1,
                native_call_id: Some("tc-1"),
                tool_name: ToolName::Bash,
                title: None,
                kind: None,
                status: ToolStatus::Completed,
                locations: &no_locations(),
                arguments: None,
                result: Some(b"test result: ok"),
            },
        )
        .unwrap();

    assert_eq!(first, second, "the same call, updated");
    let calls = store.tool_calls_for_session(&session_id).unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].status, ToolStatus::Completed);
    // An update carrying no arguments means "no news", not "cleared".
    assert!(calls[0].arguments.as_deref().unwrap().contains("cargo test"));
    assert_eq!(
        store.tool_call_result(&calls[0]).unwrap().unwrap(),
        b"test result: ok"
    );
}

#[test]
fn locations_arriving_only_on_the_completion_update_are_kept() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let session_id = started(&mut store);
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    capture
        .record_tool_call(
            &session_id,
            ToolCallContent {
                turn_seq: 1,
                native_call_id: Some("tc-1"),
                tool_name: ToolName::Edit,
                title: Some("Edit"),
                kind: Some("edit"),
                status: ToolStatus::Running,
                locations: &no_locations(),
                arguments: None,
                result: None,
            },
        )
        .unwrap();

    let late = serde_json::json!([{ "path": "src/lib.rs" }]);
    capture
        .record_tool_call(
            &session_id,
            ToolCallContent {
                turn_seq: 1,
                native_call_id: Some("tc-1"),
                tool_name: ToolName::Edit,
                title: None,
                kind: None,
                status: ToolStatus::Completed,
                locations: &late,
                arguments: None,
                result: None,
            },
        )
        .unwrap();

    let calls = store.tool_calls_for_session(&session_id).unwrap();
    assert_eq!(calls[0].locations, late);
}

#[test]
fn an_update_with_no_locations_does_not_erase_the_ones_already_stored() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let session_id = started(&mut store);
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    let early = serde_json::json!([{ "path": "src/lib.rs" }]);
    for locations in [&early, &no_locations()] {
        capture
            .record_tool_call(
                &session_id,
                ToolCallContent {
                    turn_seq: 1,
                    native_call_id: Some("tc-1"),
                    tool_name: ToolName::Edit,
                    title: None,
                    kind: None,
                    status: ToolStatus::Completed,
                    locations,
                    arguments: None,
                    result: None,
                },
            )
            .unwrap();
    }

    assert_eq!(
        store.tool_calls_for_session(&session_id).unwrap()[0].locations,
        early
    );
}

// ── Redaction and payloads ──────────────────────────────────────────────────

#[test]
fn a_secret_printed_by_a_shell_command_is_absent_from_the_stored_result() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let session_id = started(&mut store);
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    capture
        .record_tool_call(
            &session_id,
            ToolCallContent {
                turn_seq: 1,
                native_call_id: Some("tc-1"),
                tool_name: ToolName::Bash,
                title: Some("Bash(printenv)"),
                kind: Some("execute"),
                status: ToolStatus::Completed,
                locations: &no_locations(),
                arguments: Some(r#"{"command":"printenv"}"#),
                result: Some(b"API_KEY=supersecretvalue123\nLOG_LEVEL=debug"),
            },
        )
        .unwrap();

    let calls = store.tool_calls_for_session(&session_id).unwrap();
    let result = String::from_utf8(store.tool_call_result(&calls[0]).unwrap().unwrap()).unwrap();
    assert!(!result.contains("supersecretvalue123"), "{result}");
    assert!(result.contains("[REDACTED]"));
    // The non-secret survives, or the transcript is worthless.
    assert!(result.contains("LOG_LEVEL=debug"));
}

#[test]
fn a_secret_in_the_arguments_is_absent_too() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let session_id = started(&mut store);
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    capture
        .record_tool_call(
            &session_id,
            ToolCallContent {
                turn_seq: 1,
                native_call_id: Some("tc-1"),
                tool_name: ToolName::Bash,
                title: None,
                kind: Some("execute"),
                status: ToolStatus::Completed,
                locations: &no_locations(),
                arguments: Some(r#"{"command":"curl -H 'Authorization: Bearer sk-ABCDEF0123456789ABCDEF'"}"#),
                result: None,
            },
        )
        .unwrap();

    let calls = store.tool_calls_for_session(&session_id).unwrap();
    assert!(!calls[0]
        .arguments
        .as_deref()
        .unwrap()
        .contains("sk-ABCDEF0123456789ABCDEF"));
}

#[test]
fn a_quoted_low_entropy_credential_in_json_arguments_is_redacted() {
    // `{"password": "hunter2"}` is invisible to every flat layer: the entropy
    // layer needs long tokens, the credential regex cannot match a quoted key.
    // Only the JSON walk catches it — so the arguments must go through it.
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let session_id = started(&mut store);
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    // Assembled at runtime so the fixture never contains a greppable secret.
    let secret = ["hun", "ter2"].concat();
    let arguments = serde_json::json!({
        "host": "db.internal",
        "user": "app",
        "password": secret,
    })
    .to_string();
    capture
        .record_tool_call(
            &session_id,
            ToolCallContent {
                turn_seq: 1,
                native_call_id: Some("tc-1"),
                tool_name: ToolName::Other,
                title: Some("Connect to the database"),
                kind: None,
                status: ToolStatus::Completed,
                locations: &no_locations(),
                arguments: Some(&arguments),
                result: None,
            },
        )
        .unwrap();

    let stored = store.tool_calls_for_session(&session_id).unwrap();
    let args = stored[0].arguments.as_deref().unwrap();
    assert!(!args.contains(&secret), "{args}");
    assert!(args.contains("[REDACTED]"), "{args}");
    // The envelope survives: the walk redacts leaves, not structure.
    assert!(args.contains("db.internal"), "{args}");
}

#[test]
fn json_identifiers_in_arguments_survive_redaction() {
    // The flat entropy layer would shred a message id into [REDACTED]; the JSON
    // walk's structural skip-list exists precisely to keep it.
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let session_id = started(&mut store);
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    let id_value = "xJ3kQ9vB2mZ7pL5rT8wN4cF6yH1sD0gA";
    let arguments =
        serde_json::json!({ "message_id": id_value, "command": "cargo test" }).to_string();
    capture
        .record_tool_call(
            &session_id,
            ToolCallContent {
                turn_seq: 1,
                native_call_id: Some("tc-1"),
                tool_name: ToolName::Bash,
                title: None,
                kind: Some("execute"),
                status: ToolStatus::Completed,
                locations: &no_locations(),
                arguments: Some(&arguments),
                result: None,
            },
        )
        .unwrap();

    let stored = store.tool_calls_for_session(&session_id).unwrap();
    let args = stored[0].arguments.as_deref().unwrap();
    assert!(args.contains(id_value), "identifier destroyed: {args}");
    assert!(args.contains("cargo test"), "{args}");
}

#[test]
fn a_json_shaped_tool_result_is_redacted_json_aware() {
    // Results frequently print JSON — a `cat` of a config file, an API reply.
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let session_id = started(&mut store);
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    let secret = ["hun", "ter2"].concat();
    let result = serde_json::json!({
        "host": "db.internal",
        "user": "app",
        "password": secret,
        "request_id": "xJ3kQ9vB2mZ7pL5rT8wN4cF6yH1sD0gA",
    })
    .to_string();
    capture
        .record_tool_call(
            &session_id,
            ToolCallContent {
                turn_seq: 1,
                native_call_id: Some("tc-1"),
                tool_name: ToolName::Bash,
                title: None,
                kind: Some("execute"),
                status: ToolStatus::Completed,
                locations: &no_locations(),
                arguments: None,
                result: Some(result.as_bytes()),
            },
        )
        .unwrap();

    let calls = store.tool_calls_for_session(&session_id).unwrap();
    let stored = String::from_utf8(store.tool_call_result(&calls[0]).unwrap().unwrap()).unwrap();
    assert!(!stored.contains(&secret), "{stored}");
    assert!(
        stored.contains("xJ3kQ9vB2mZ7pL5rT8wN4cF6yH1sD0gA"),
        "identifier destroyed: {stored}"
    );
}

#[test]
fn a_binary_result_is_stored_intact_marked_binary_and_round_trips_byte_identically() {
    // Lossily decoding it to scan would corrupt the payload on the way back out,
    // and there is no secret to find in bytes that cannot be read as text.
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let session_id = started(&mut store);
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    let binary: Vec<u8> = vec![0x00, 0xff, 0xfe, 0x41, 0x80, 0xc3, 0x28, 0x00, 0x01];
    capture
        .record_tool_call(
            &session_id,
            ToolCallContent {
                turn_seq: 1,
                native_call_id: Some("tc-1"),
                tool_name: ToolName::Read,
                title: Some("Read target/debug/atlas"),
                kind: Some("read"),
                status: ToolStatus::Completed,
                locations: &no_locations(),
                arguments: None,
                result: Some(&binary),
            },
        )
        .unwrap();

    let calls = store.tool_calls_for_session(&session_id).unwrap();
    assert!(calls[0].result_binary, "must be marked as binary");
    assert_eq!(store.tool_call_result(&calls[0]).unwrap().unwrap(), binary);
}

#[test]
fn a_large_result_spills_to_a_blob_and_is_referenced() {
    // A tool result is the largest payload in a Session — a read of a big file,
    // a verbose test run. Spilling it independently is what keeps rows under the
    // storage row cap.
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let session_id = started(&mut store);
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    let huge = "compiling crate number one\n".repeat(20_000);
    assert!(huge.len() > SPILL_THRESHOLD_BYTES);
    capture
        .record_tool_call(
            &session_id,
            ToolCallContent {
                turn_seq: 1,
                native_call_id: Some("tc-1"),
                tool_name: ToolName::Bash,
                title: None,
                kind: Some("execute"),
                status: ToolStatus::Completed,
                locations: &no_locations(),
                arguments: None,
                result: Some(huge.as_bytes()),
            },
        )
        .unwrap();

    let calls = store.tool_calls_for_session(&session_id).unwrap();
    assert!(calls[0].result.is_none(), "should not sit on the row");
    assert!(calls[0].result_ref.is_some(), "should be referenced");
    assert_eq!(
        store.tool_call_result(&calls[0]).unwrap().unwrap().len(),
        huge.len()
    );
}

// ── File touches ────────────────────────────────────────────────────────────

#[test]
fn every_file_the_agent_writes_records_path_hash_and_whether_it_existed() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let mut store = store_in(&root);
    let session_id = started(&mut store);
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    let call = capture
        .record_tool_call(
            &session_id,
            ToolCallContent {
                turn_seq: 1,
                native_call_id: Some("tc-1"),
                tool_name: ToolName::Write,
                title: Some("Write src/new.rs"),
                kind: Some("edit"),
                status: ToolStatus::Completed,
                locations: &no_locations(),
                arguments: None,
                result: None,
            },
        )
        .unwrap();

    let content = b"pub fn limit() {}";
    let resolved = resolve_path("src/new.rs", &root);
    capture
        .record_file_write(
            &session_id,
            &call,
            1,
            FileWrite {
                path: &resolved,
                sha256_after: Some(hash_written_content(content)),
                sketch_after: atlas_checkpoint::sketch::sketch(content),
                existed_before: false,
                deleted: false,
            },
        )
        .unwrap();

    let touches = store.file_touches_for_session(&session_id).unwrap();
    assert_eq!(touches.len(), 1);
    assert_eq!(touches[0].path, "src/new.rs");
    assert_eq!(
        touches[0].sha256_after.as_deref(),
        Some(hash_written_content(content).as_str())
    );
    assert!(!touches[0].existed_before);
    assert!(!touches[0].out_of_repo);
    assert_eq!(touches[0].tool_call_id, call, "must reference its tool call");
}

#[test]
fn existed_before_distinguishes_a_new_file_from_a_modified_one() {
    // The asymmetric link rule turns entirely on this bit, and it is
    // unrecoverable after the fact: by the time a commit lands the file exists
    // either way.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let mut store = store_in(&root);
    let session_id = started(&mut store);
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    let call = capture
        .record_tool_call(
            &session_id,
            ToolCallContent {
                turn_seq: 1,
                native_call_id: Some("tc-1"),
                tool_name: ToolName::Edit,
                title: None,
                kind: Some("edit"),
                status: ToolStatus::Completed,
                locations: &no_locations(),
                arguments: None,
                result: None,
            },
        )
        .unwrap();

    for (path, existed) in [("src/created.rs", false), ("src/modified.rs", true)] {
        let resolved = resolve_path(path, &root);
        capture
            .record_file_write(
                &session_id,
                &call,
                1,
                FileWrite {
                    path: &resolved,
                    sha256_after: Some(hash_written_content(b"x")),
                sketch_after: atlas_checkpoint::sketch::sketch(b"x"),
                    existed_before: existed,
                    deleted: false,
                },
            )
            .unwrap();
    }

    let touches = store.file_touches_for_session(&session_id).unwrap();
    let created = touches.iter().find(|t| t.path == "src/created.rs").unwrap();
    let modified = touches.iter().find(|t| t.path == "src/modified.rs").unwrap();
    assert!(!created.existed_before);
    assert!(modified.existed_before);
}

#[test]
fn a_file_written_twice_in_one_turn_records_both_and_the_link_rule_sees_the_last() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let mut store = store_in(&root);
    let session_id = started(&mut store);
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    let call = capture
        .record_tool_call(
            &session_id,
            ToolCallContent {
                turn_seq: 1,
                native_call_id: Some("tc-1"),
                tool_name: ToolName::Edit,
                title: None,
                kind: Some("edit"),
                status: ToolStatus::Completed,
                locations: &no_locations(),
                arguments: None,
                result: None,
            },
        )
        .unwrap();

    let resolved = resolve_path("src/lib.rs", &root);
    for content in [b"first".as_slice(), b"second".as_slice()] {
        capture
            .record_file_write(
                &session_id,
                &call,
                1,
                FileWrite {
                    path: &resolved,
                    sha256_after: Some(hash_written_content(content)),
                sketch_after: atlas_checkpoint::sketch::sketch(content),
                    existed_before: true,
                    deleted: false,
                },
            )
            .unwrap();
    }

    assert_eq!(store.file_touches_for_session(&session_id).unwrap().len(), 2);

    // The link rule consumes the last write — that is the content the turn left
    // behind, and therefore what a commit would carry.
    let latest = store.latest_file_touches(&session_id).unwrap();
    let for_path: Vec<_> = latest.iter().filter(|t| t.path == "src/lib.rs").collect();
    assert_eq!(for_path.len(), 1);
    assert_eq!(
        for_path[0].sha256_after.as_deref(),
        Some(hash_written_content(b"second").as_str())
    );
}

#[test]
fn a_file_touched_across_several_turns_records_one_per_turn() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let mut store = store_in(&root);
    let session_id = started(&mut store);
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);
    let resolved = resolve_path("src/lib.rs", &root);

    for turn in 1..=3 {
        let call = capture
            .record_tool_call(
                &session_id,
                ToolCallContent {
                    turn_seq: turn,
                    native_call_id: Some(&format!("tc-{turn}")),
                    tool_name: ToolName::Edit,
                    title: None,
                    kind: Some("edit"),
                    status: ToolStatus::Completed,
                    locations: &no_locations(),
                    arguments: None,
                    result: None,
                },
            )
            .unwrap();
        capture
            .record_file_write(
                &session_id,
                &call,
                turn,
                FileWrite {
                    path: &resolved,
                    sha256_after: Some(hash_written_content(format!("turn {turn}").as_bytes())),
                sketch_after: atlas_checkpoint::sketch::sketch(format!("turn {turn}").as_bytes()),
                    existed_before: true,
                    deleted: false,
                },
            )
            .unwrap();
    }

    assert_eq!(store.file_touches_for_session(&session_id).unwrap().len(), 3);
    assert_eq!(store.latest_file_touches(&session_id).unwrap().len(), 3);
}

#[test]
fn a_file_created_then_deleted_is_represented_truthfully() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let mut store = store_in(&root);
    let session_id = started(&mut store);
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);
    let resolved = resolve_path("src/scratch.rs", &root);

    let call = capture
        .record_tool_call(
            &session_id,
            ToolCallContent {
                turn_seq: 1,
                native_call_id: Some("tc-1"),
                tool_name: ToolName::Write,
                title: None,
                kind: Some("edit"),
                status: ToolStatus::Completed,
                locations: &no_locations(),
                arguments: None,
                result: None,
            },
        )
        .unwrap();
    capture
        .record_file_write(
            &session_id,
            &call,
            1,
            FileWrite {
                path: &resolved,
                sha256_after: Some(hash_written_content(b"temp")),
                sketch_after: atlas_checkpoint::sketch::sketch(b"temp"),
                existed_before: false,
                deleted: false,
            },
        )
        .unwrap();
    capture
        .record_file_write(
            &session_id,
            &call,
            1,
            FileWrite {
                path: &resolved,
                // No content hash for a deletion — the deletion marker is the
                // evidence the link rule uses instead.
                sha256_after: None,
                sketch_after: None,
                existed_before: true,
                deleted: true,
            },
        )
        .unwrap();

    let latest = store.latest_file_touches(&session_id).unwrap();
    let scratch: Vec<_> = latest.iter().filter(|t| t.path == "src/scratch.rs").collect();
    assert_eq!(scratch.len(), 1);
    assert!(scratch[0].deleted);
    assert!(scratch[0].sha256_after.is_none());
}

#[test]
fn a_write_outside_the_workspace_is_flagged_rather_than_recorded_as_a_broken_path() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let mut store = store_in(&root);
    let session_id = started(&mut store);
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    let call = capture
        .record_tool_call(
            &session_id,
            ToolCallContent {
                turn_seq: 1,
                native_call_id: Some("tc-1"),
                tool_name: ToolName::Write,
                title: None,
                kind: Some("edit"),
                status: ToolStatus::Completed,
                locations: &no_locations(),
                arguments: None,
                result: None,
            },
        )
        .unwrap();

    let resolved = resolve_path("../../etc/hosts", &root);
    capture
        .record_file_write(
            &session_id,
            &call,
            1,
            FileWrite {
                path: &resolved,
                sha256_after: Some(hash_written_content(b"x")),
                sketch_after: atlas_checkpoint::sketch::sketch(b"x"),
                existed_before: true,
                deleted: false,
            },
        )
        .unwrap();

    let touches = store.file_touches_for_session(&session_id).unwrap();
    assert!(touches[0].out_of_repo, "must be flagged, not silently dropped");
}

#[test]
fn a_read_only_call_produces_a_tool_call_row_and_no_file_touch() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let session_id = started(&mut store);
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    capture
        .record_tool_call(
            &session_id,
            ToolCallContent {
                turn_seq: 1,
                native_call_id: Some("tc-1"),
                tool_name: ToolName::Read,
                title: Some("Read src/lib.rs"),
                kind: Some("read"),
                status: ToolStatus::Completed,
                locations: &serde_json::json!([{ "path": "src/lib.rs" }]),
                arguments: None,
                result: Some(b"pub fn main() {}"),
            },
        )
        .unwrap();

    assert_eq!(store.tool_calls_for_session(&session_id).unwrap().len(), 1);
    assert!(
        store.file_touches_for_session(&session_id).unwrap().is_empty(),
        "a read writes nothing"
    );
}

// ── Edit patches ────────────────────────────────────────────────────────────

#[test]
fn an_edit_shaped_call_stores_the_patch_it_applied() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let session_id = started(&mut store);
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    let call = capture
        .record_tool_call(
            &session_id,
            ToolCallContent {
                turn_seq: 1,
                native_call_id: Some("tc-1"),
                tool_name: ToolName::Edit,
                title: None,
                kind: Some("edit"),
                status: ToolStatus::Completed,
                locations: &no_locations(),
                arguments: None,
                result: None,
            },
        )
        .unwrap();

    let patch = "@@ -1,3 +1,4 @@\n fn limit() {\n+    check_bucket();\n }";
    capture
        .record_edit_patch(&session_id, &call, 1, "src/rate_limit.rs", patch)
        .unwrap();

    let edits = store.agent_edits_for_session(&session_id).unwrap();
    assert_eq!(edits.len(), 1);
    assert_eq!(edits[0].path, "src/rate_limit.rs");
    assert_eq!(edits[0].patch.as_deref(), Some(patch));
    assert_eq!(edits[0].tool_call_id, call);
}

#[test]
fn a_secret_inside_an_edit_patch_is_redacted_too() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let session_id = started(&mut store);
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    let call = capture
        .record_tool_call(
            &session_id,
            ToolCallContent {
                turn_seq: 1,
                native_call_id: Some("tc-1"),
                tool_name: ToolName::Edit,
                title: None,
                kind: Some("edit"),
                status: ToolStatus::Completed,
                locations: &no_locations(),
                arguments: None,
                result: None,
            },
        )
        .unwrap();

    capture
        .record_edit_patch(
            &session_id,
            &call,
            1,
            ".env",
            "@@ -1 +1 @@\n-API_KEY=old\n+API_KEY=supersecretvalue123",
        )
        .unwrap();

    let edits = store.agent_edits_for_session(&session_id).unwrap();
    assert!(!edits[0].patch.as_deref().unwrap().contains("supersecretvalue123"));
}

// ── Path handling, end to end ───────────────────────────────────────────────

#[test]
fn a_unicode_normalisation_difference_does_not_prevent_a_path_from_matching() {
    // macOS hands back NFD; git stores NFC. A byte comparison of the two fails
    // silently and no Checkpoint ever forms.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let mut store = store_in(&root);
    let session_id = started(&mut store);
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    let call = capture
        .record_tool_call(
            &session_id,
            ToolCallContent {
                turn_seq: 1,
                native_call_id: Some("tc-1"),
                tool_name: ToolName::Edit,
                title: None,
                kind: Some("edit"),
                status: ToolStatus::Completed,
                locations: &no_locations(),
                arguments: None,
                result: None,
            },
        )
        .unwrap();

    // As macOS reports it: `e` + combining acute.
    let decomposed = resolve_path("src/cafe\u{0301}.rs", &root);
    capture
        .record_file_write(
            &session_id,
            &call,
            1,
            FileWrite {
                path: &decomposed,
                sha256_after: Some(hash_written_content(b"x")),
                sketch_after: atlas_checkpoint::sketch::sketch(b"x"),
                existed_before: true,
                deleted: false,
            },
        )
        .unwrap();

    // As git stores it: precomposed.
    let touches = store.file_touches_for_session(&session_id).unwrap();
    assert_eq!(touches[0].path, "src/café.rs");
    assert_eq!(touches[0].path, resolve_path("src/café.rs", &root).path);
}

#[test]
fn paths_are_stored_relative_to_the_workspace_root() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let absolute = root.join("src/lib.rs");
    assert_eq!(
        resolve_path(&absolute.to_string_lossy(), &root).path,
        "src/lib.rs"
    );
}

#[test]
fn capture_degrades_gracefully_when_a_call_carries_no_usable_location() {
    // A shell command has no path, and that must not fail the turn.
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let session_id = started(&mut store);
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    let arguments = serde_json::json!({ "command": "cargo test" });
    assert!(extract_paths(&[], &arguments).is_empty());

    capture
        .record_tool_call(
            &session_id,
            ToolCallContent {
                turn_seq: 1,
                native_call_id: Some("tc-1"),
                tool_name: canonical_name(Some("Bash"), None, Some("execute"), &arguments),
                title: Some("Bash(cargo test)"),
                kind: Some("execute"),
                status: ToolStatus::Completed,
                locations: &no_locations(),
                arguments: Some(&arguments.to_string()),
                result: None,
            },
        )
        .expect("a location-less call still records");

    assert_eq!(store.tool_calls_for_session(&session_id).unwrap().len(), 1);
}
