//! Importing on-disk transcripts, against fixture directories.

use std::path::Path;

use atlas_checkpoint::model::WorkspaceMode;
use atlas_checkpoint::tools::ToolName;
use atlas_checkpoint::{
    import_all, import_preview, Capture, Role, SessionKey, Source, Store, ToolStatus,
    TranscriptSource,
};

const WORKSPACE: &str = "ws-atlas";

fn store_in(root: &Path) -> Store {
    Store::open(root.join(".atlas")).expect("store opens")
}

/// One Claude Code transcript line.
fn line(kind: &str, uuid: &str, text: &str) -> String {
    line_at(kind, uuid, text, "2026-07-01T10:00:00.000Z")
}

/// One Claude Code transcript line, with its own timestamp.
fn line_at(kind: &str, uuid: &str, text: &str, timestamp: &str) -> String {
    serde_json::json!({
        "type": kind,
        "uuid": uuid,
        "timestamp": timestamp,
        "message": { "role": kind, "content": text, "model": "opus-5" },
    })
    .to_string()
}

/// Write a transcript file named after its session id.
fn transcript(dir: &Path, session_id: &str, lines: &[String]) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(
        dir.join(format!("{session_id}.jsonl")),
        format!("{}\n", lines.join("\n")),
    )
    .unwrap();
}

fn a_conversation() -> Vec<String> {
    vec![
        line("user", "u1", "Add rate limiting to the upload endpoint"),
        line("assistant", "a1", "I've added a token bucket keyed on org_id."),
        line("user", "u2", "Now cover the burst case"),
        line("assistant", "a2", "Added a burst allowance."),
    ]
}

// ── Fresh import ────────────────────────────────────────────────────────────

#[test]
fn existing_transcripts_import_as_sessions_and_messages() {
    let dir = tempfile::tempdir().unwrap();
    let transcripts = dir.path().join("transcripts");
    transcript(&transcripts, "sess-abc", &a_conversation());

    let mut store = store_in(dir.path());
    let outcome = import_all(
        &mut store,
        WORKSPACE,
        &TranscriptSource::new(&transcripts),
        WorkspaceMode::Local,
    )
    .expect("imports");

    assert_eq!(outcome.files_seen, 1);
    assert_eq!(outcome.sessions_imported, 1);

    let sessions = store.sessions_for_workspace(WORKSPACE).unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].source, Source::ExternalJsonl);
    assert_eq!(
        sessions[0].native_session_id, "sess-abc",
        "identity is the agent's own session id"
    );
    assert_eq!(
        sessions[0].title.as_deref(),
        Some("Add rate limiting to the upload endpoint"),
        "the title derives from the first prompt, as for live capture"
    );

    let messages = store.messages_for_session(&sessions[0].id).unwrap();
    assert_eq!(messages.len(), 4);
    assert_eq!(messages.iter().filter(|m| m.role == Role::User).count(), 2);
    assert_eq!(
        messages.iter().filter(|m| m.role == Role::Assistant).count(),
        2
    );
}

#[test]
fn imported_sessions_are_attributable_as_imported() {
    let dir = tempfile::tempdir().unwrap();
    let transcripts = dir.path().join("transcripts");
    transcript(&transcripts, "sess-abc", &a_conversation());

    let mut store = store_in(dir.path());
    import_all(&mut store, WORKSPACE, &TranscriptSource::new(&transcripts), WorkspaceMode::Local)
        .unwrap();

    let sessions = store.sessions_for_workspace(WORKSPACE).unwrap();
    assert_eq!(sessions[0].source, Source::ExternalJsonl);
    assert!(!sessions[0].source.is_live(), "imported, not live-captured");
}

#[test]
fn several_transcripts_import_as_several_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let transcripts = dir.path().join("transcripts");
    for id in ["one", "two", "three"] {
        transcript(&transcripts, id, &a_conversation());
    }

    let mut store = store_in(dir.path());
    let outcome =
        import_all(&mut store, WORKSPACE, &TranscriptSource::new(&transcripts), WorkspaceMode::Local)
            .unwrap();

    assert_eq!(outcome.files_seen, 3);
    assert_eq!(outcome.sessions_imported, 3);
    assert_eq!(store.sessions_for_workspace(WORKSPACE).unwrap().len(), 3);
}

// ── Transcript timestamps ───────────────────────────────────────────────────

#[test]
fn imported_history_keeps_its_real_dates_not_the_import_date() {
    // Ordering, day grouping and the promotion preview all read these back;
    // a year of history dating from the day the import ran defeats "day one
    // looks like month six".
    let dir = tempfile::tempdir().unwrap();
    let transcripts = dir.path().join("transcripts");
    transcript(
        &transcripts,
        "sess-old",
        &[
            line_at("user", "u1", "An old question", "2025-02-03T09:15:00.000Z"),
            line_at("assistant", "a1", "An old answer", "2025-02-03T09:16:30.000Z"),
        ],
    );

    let mut store = store_in(dir.path());
    import_all(&mut store, WORKSPACE, &TranscriptSource::new(&transcripts), WorkspaceMode::Local)
        .unwrap();

    let session = &store.sessions_for_workspace(WORKSPACE).unwrap()[0];
    assert_eq!(
        session.started_at.to_rfc3339(),
        "2025-02-03T09:15:00+00:00",
        "the session starts when the transcript says it did"
    );

    let messages = store.messages_for_session(&session.id).unwrap();
    assert_eq!(messages[0].created_at.to_rfc3339(), "2025-02-03T09:15:00+00:00");
    assert_eq!(messages[1].created_at.to_rfc3339(), "2025-02-03T09:16:30+00:00");
}

// ── Redaction ───────────────────────────────────────────────────────────────

#[test]
fn imported_content_is_redacted_before_storage_including_the_title() {
    // An old transcript is exactly as likely to contain a pasted key as a new
    // one, so it goes through the same on-write scrubbing.
    let dir = tempfile::tempdir().unwrap();
    let transcripts = dir.path().join("transcripts");
    transcript(
        &transcripts,
        "sess-secret",
        &[
            line("user", "u1", "here's my key sk-ABCDEF0123456789ABCDEF, why does it fail"),
            line("assistant", "a1", "The value API_KEY=supersecretvalue123 is wrong."),
        ],
    );

    let mut store = store_in(dir.path());
    import_all(&mut store, WORKSPACE, &TranscriptSource::new(&transcripts), WorkspaceMode::Local)
        .unwrap();

    let session = &store.sessions_for_workspace(WORKSPACE).unwrap()[0];
    assert!(!session.title.as_deref().unwrap().contains("sk-ABCDEF0123456789ABCDEF"));

    for message in store.messages_for_session(&session.id).unwrap() {
        let body = store.message_body(&message).unwrap();
        assert!(!body.contains("sk-ABCDEF0123456789ABCDEF"), "{body}");
        assert!(!body.contains("supersecretvalue123"), "{body}");
    }
}

// ── Dedupe ──────────────────────────────────────────────────────────────────

#[test]
fn a_session_already_captured_via_acp_is_not_imported_again() {
    // Atlas's ACP-hosted Claude Code writes JSONL to the same directory. The
    // schema permits both rows — skipping the duplicate is the importer's job.
    let dir = tempfile::tempdir().unwrap();
    let transcripts = dir.path().join("transcripts");
    transcript(&transcripts, "sess-shared", &a_conversation());

    let mut store = store_in(dir.path());
    {
        let mut capture = Capture::new(&mut store, WorkspaceMode::Local);
        capture
            .record_prompt(
                &SessionKey {
                    workspace_id: WORKSPACE.into(),
                    source: Source::Acp,
                    native_session_id: "sess-shared".into(),
                },
                "captured live inside Atlas",
                1,
                None,
                None,
                None,
            )
            .unwrap();
    }

    let outcome =
        import_all(&mut store, WORKSPACE, &TranscriptSource::new(&transcripts), WorkspaceMode::Local)
            .unwrap();

    assert_eq!(outcome.skipped_already_captured, 1);
    assert_eq!(outcome.sessions_imported, 0);

    let sessions = store.sessions_for_workspace(WORKSPACE).unwrap();
    assert_eq!(sessions.len(), 1, "one Session, not two");
    assert_eq!(sessions[0].source, Source::Acp, "the live one wins");
}

#[test]
fn re_running_the_import_is_a_no_op() {
    let dir = tempfile::tempdir().unwrap();
    let transcripts = dir.path().join("transcripts");
    transcript(&transcripts, "sess-abc", &a_conversation());
    let source = TranscriptSource::new(&transcripts);

    let mut store = store_in(dir.path());
    import_all(&mut store, WORKSPACE, &source, WorkspaceMode::Local).unwrap();
    let after_first = store.messages_for_session(
        &store.sessions_for_workspace(WORKSPACE).unwrap()[0].id,
    )
    .unwrap()
    .len();

    let second = import_all(&mut store, WORKSPACE, &source, WorkspaceMode::Local).unwrap();
    assert_eq!(second.sessions_imported, 0);
    assert_eq!(second.skipped_unchanged, 1);

    let sessions = store.sessions_for_workspace(WORKSPACE).unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(
        store.messages_for_session(&sessions[0].id).unwrap().len(),
        after_first,
        "no duplicate turns"
    );
}

// ── Growing files ───────────────────────────────────────────────────────────

#[test]
fn a_transcript_that_grows_during_import_ends_up_complete_without_duplicates() {
    // A live terminal session appends while it is being read.
    let dir = tempfile::tempdir().unwrap();
    let transcripts = dir.path().join("transcripts");
    let source = TranscriptSource::new(&transcripts);
    let mut store = store_in(dir.path());

    transcript(&transcripts, "sess-live", &a_conversation()[..2]);
    import_all(&mut store, WORKSPACE, &source, WorkspaceMode::Local).unwrap();
    let session = store.sessions_for_workspace(WORKSPACE).unwrap()[0].id.clone();
    assert_eq!(store.messages_for_session(&session).unwrap().len(), 2);

    // The agent keeps talking.
    transcript(&transcripts, "sess-live", &a_conversation());
    import_all(&mut store, WORKSPACE, &source, WorkspaceMode::Local).unwrap();

    assert_eq!(
        store.messages_for_session(&session).unwrap().len(),
        4,
        "the new turns arrive and the old ones are not duplicated"
    );
    assert_eq!(store.sessions_for_workspace(WORKSPACE).unwrap().len(), 1);
}

#[test]
fn a_grown_transcript_resumes_mid_file_instead_of_reparsing_from_byte_zero() {
    // The 30s watch tick used to re-parse an actively-growing multi-MB JSONL
    // from byte 0 every pass. Each clean pass now commits a resume offset; the
    // growth tests above prove the resumed rows match a full re-parse, and
    // this pins that the offset is actually stored and advances with growth.
    let dir = tempfile::tempdir().unwrap();
    let transcripts = dir.path().join("transcripts");
    let source = TranscriptSource::new(&transcripts);
    let mut store = store_in(dir.path());

    transcript(&transcripts, "sess-resume", &a_conversation()[..2]);
    let path = transcripts.join("sess-resume.jsonl");
    let first_size = std::fs::metadata(&path).unwrap().len();
    import_all(&mut store, WORKSPACE, &source, WorkspaceMode::Local).unwrap();

    // Resume state lives in a SIDECAR, not sessions.db — it's a cache, and
    // caches must never raise the schema-gated store's version floor.
    let key = path.to_string_lossy().to_string();
    let sidecar = dir.path().join(".atlas").join("import-resume.json");
    let read_offset = |key: &str| -> u64 {
        let map: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&sidecar).unwrap()).unwrap();
        map[key]["offset"].as_u64().unwrap()
    };
    let offset = read_offset(&key);
    assert_eq!(
        offset, first_size,
        "the committed offset covers the whole newline-terminated file"
    );

    transcript(&transcripts, "sess-resume", &a_conversation());
    import_all(&mut store, WORKSPACE, &source, WorkspaceMode::Local).unwrap();
    let grown: u64 = read_offset(&key);
    assert_eq!(grown, std::fs::metadata(&path).unwrap().len());
    assert!(grown > offset, "the offset advances with the file");

    let session = store.sessions_for_workspace(WORKSPACE).unwrap()[0].id.clone();
    assert_eq!(store.messages_for_session(&session).unwrap().len(), 4);
}

#[test]
fn a_transcript_appearing_after_the_first_pass_is_picked_up() {
    // The terminal-gap case: a Session that did not exist when capture was
    // enabled.
    let dir = tempfile::tempdir().unwrap();
    let transcripts = dir.path().join("transcripts");
    let source = TranscriptSource::new(&transcripts);
    let mut store = store_in(dir.path());

    transcript(&transcripts, "first", &a_conversation());
    import_all(&mut store, WORKSPACE, &source, WorkspaceMode::Local).unwrap();

    transcript(&transcripts, "second", &a_conversation());
    let outcome = import_all(&mut store, WORKSPACE, &source, WorkspaceMode::Local).unwrap();

    assert_eq!(outcome.sessions_imported, 1);
    assert_eq!(store.sessions_for_workspace(WORKSPACE).unwrap().len(), 2);
}

// ── Tool calls from transcripts ─────────────────────────────────────────────

/// A conversation whose assistant runs two tools — one succeeds, one fails —
/// with a secret in the arguments and an identifier that must survive.
fn a_conversation_with_tools(secret: &str) -> String {
    let user = line("user", "u1", "Run the tests and read the config");
    let uses = serde_json::json!({
        "type": "assistant",
        "uuid": "a1",
        "timestamp": "2026-07-01T10:01:00.000Z",
        "message": { "model": "opus-5", "content": [
            { "type": "text", "text": "Running them now." },
            { "type": "tool_use", "id": "toolu_ok", "name": "Bash",
              "input": { "command": "cargo test", "password": secret,
                         "message_id": "xJ3kQ9vB2mZ7pL5rT8wN4cF6yH1sD0gA",
                         "host": "db.internal", "user": "app" } },
            { "type": "tool_use", "id": "toolu_bad", "name": "Read",
              "input": { "file_path": "/tmp/missing.toml" } },
        ] },
    })
    .to_string();
    let results = serde_json::json!({
        "type": "user",
        "uuid": "u2",
        "timestamp": "2026-07-01T10:02:00.000Z",
        "message": { "content": [
            { "type": "tool_result", "tool_use_id": "toolu_ok",
              "content": [{ "type": "text", "text": "test result: ok" }] },
            { "type": "tool_result", "tool_use_id": "toolu_bad",
              "content": "No such file", "is_error": true },
        ] },
    })
    .to_string();
    format!("{user}\n{uses}\n{results}")
}

#[test]
fn tool_use_and_tool_result_blocks_import_as_tool_call_rows() {
    // An explicit ATL-91 acceptance criterion: "tool calls as rows with status
    // where the transcript records it". Without them every imported Session
    // renders with empty facets.
    let dir = tempfile::tempdir().unwrap();
    let transcripts = dir.path().join("transcripts");
    std::fs::create_dir_all(&transcripts).unwrap();
    // Assembled at runtime so the fixture never contains a greppable secret.
    let secret = ["hun", "ter2"].concat();
    std::fs::write(
        transcripts.join("sess-tools.jsonl"),
        format!("{}\n", a_conversation_with_tools(&secret)),
    )
    .unwrap();

    let mut store = store_in(dir.path());
    import_all(&mut store, WORKSPACE, &TranscriptSource::new(&transcripts), WorkspaceMode::Local)
        .unwrap();

    let session = &store.sessions_for_workspace(WORKSPACE).unwrap()[0];
    let calls = store.tool_calls_for_session(&session.id).unwrap();
    assert_eq!(calls.len(), 2);

    let ok = calls.iter().find(|c| c.tool_name == ToolName::Bash).expect("the Bash call");
    assert_eq!(ok.status, ToolStatus::Completed);
    assert_eq!(
        String::from_utf8(store.tool_call_result(ok).unwrap().unwrap()).unwrap(),
        "test result: ok"
    );

    let bad = calls.iter().find(|c| c.tool_name == ToolName::Read).expect("the Read call");
    assert_eq!(bad.status, ToolStatus::Failed, "is_error maps to Failed");

    // The facet counts are what the sidebar renders; they must not be empty for
    // imported Sessions.
    let counts = store.tool_call_counts(&session.id).unwrap();
    assert_eq!(counts.iter().map(|(_, c)| c).sum::<i64>(), 2);

    // Redaction applied identically: the quoted credential is gone, the
    // identifier the JSON walk protects survives.
    let args = ok.arguments.as_deref().unwrap();
    assert!(!args.contains(&secret), "{args}");
    assert!(args.contains("xJ3kQ9vB2mZ7pL5rT8wN4cF6yH1sD0gA"), "{args}");
}

#[test]
fn re_importing_a_transcript_with_tools_does_not_duplicate_the_calls() {
    // The block id is the idempotency key; a grown-file re-read must update,
    // not append.
    let dir = tempfile::tempdir().unwrap();
    let transcripts = dir.path().join("transcripts");
    std::fs::create_dir_all(&transcripts).unwrap();
    let secret = ["hun", "ter2"].concat();
    let body = a_conversation_with_tools(&secret);
    std::fs::write(transcripts.join("sess-tools.jsonl"), format!("{body}\n")).unwrap();
    let source = TranscriptSource::new(&transcripts);

    let mut store = store_in(dir.path());
    import_all(&mut store, WORKSPACE, &source, WorkspaceMode::Local).unwrap();
    // The file grows, forcing a full re-read.
    std::fs::write(
        transcripts.join("sess-tools.jsonl"),
        format!("{body}\n{}\n", line("assistant", "a2", "All done.")),
    )
    .unwrap();
    import_all(&mut store, WORKSPACE, &source, WorkspaceMode::Local).unwrap();

    let session = &store.sessions_for_workspace(WORKSPACE).unwrap()[0];
    assert_eq!(store.tool_calls_for_session(&session.id).unwrap().len(), 2);
}

// ── Robustness ──────────────────────────────────────────────────────────────

#[test]
fn malformed_lines_are_skipped_and_counted_and_the_file_still_imports() {
    let dir = tempfile::tempdir().unwrap();
    let transcripts = dir.path().join("transcripts");
    std::fs::create_dir_all(&transcripts).unwrap();
    std::fs::write(
        transcripts.join("sess-messy.jsonl"),
        format!(
            "{}\nnot json at all\n{}\n{{\"truncated\": ",
            line("user", "u1", "Add rate limiting"),
            line("assistant", "a1", "Done."),
        ),
    )
    .unwrap();

    let mut store = store_in(dir.path());
    let outcome =
        import_all(&mut store, WORKSPACE, &TranscriptSource::new(&transcripts), WorkspaceMode::Local)
            .unwrap();

    assert_eq!(outcome.malformed_lines, 2);
    assert_eq!(outcome.sessions_imported, 1);
    assert_eq!(
        store
            .messages_for_session(&store.sessions_for_workspace(WORKSPACE).unwrap()[0].id)
            .unwrap()
            .len(),
        2,
        "the good lines still import"
    );
}

#[test]
fn a_uuid_less_transcript_imported_twice_does_not_duplicate() {
    // Claude Code lines carry `uuid` today, but the importer must survive
    // transcripts that do not: without an idempotency key, every growing-file
    // re-read would duplicate everything before the growth.
    let dir = tempfile::tempdir().unwrap();
    let transcripts = dir.path().join("transcripts");
    std::fs::create_dir_all(&transcripts).unwrap();
    let bare = |kind: &str, text: &str| {
        serde_json::json!({
            "type": kind,
            "message": { "content": text, "model": "opus-5" },
        })
        .to_string()
    };
    let first = bare("user", "first prompt without a uuid");
    std::fs::write(transcripts.join("sess-bare.jsonl"), format!("{first}\n")).unwrap();
    let source = TranscriptSource::new(&transcripts);

    let mut store = store_in(dir.path());
    import_all(&mut store, WORKSPACE, &source, WorkspaceMode::Local).unwrap();

    // The file grows; the whole file is re-read.
    std::fs::write(
        transcripts.join("sess-bare.jsonl"),
        format!("{first}\n{}\n", bare("assistant", "a reply, also without a uuid")),
    )
    .unwrap();
    import_all(&mut store, WORKSPACE, &source, WorkspaceMode::Local).unwrap();

    let session = &store.sessions_for_workspace(WORKSPACE).unwrap()[0];
    let messages = store.messages_for_session(&session.id).unwrap();
    assert_eq!(messages.len(), 2, "the first line must not import twice");
}

#[test]
fn an_io_error_mid_file_does_not_claim_the_unread_tail() {
    // `BufReader::lines` yields Err for a non-UTF-8 line, which ends the pass.
    // Progress must not be recorded as the full file size, or the tail after
    // the error would be skipped forever.
    let dir = tempfile::tempdir().unwrap();
    let transcripts = dir.path().join("transcripts");
    std::fs::create_dir_all(&transcripts).unwrap();
    let good = line("user", "u1", "Before the corruption");
    let mut bytes = format!("{good}\n").into_bytes();
    bytes.extend_from_slice(&[0xff, 0xfe, 0xfd]); // not UTF-8
    bytes.extend_from_slice(b"\n");
    std::fs::write(transcripts.join("sess-torn.jsonl"), &bytes).unwrap();
    let source = TranscriptSource::new(&transcripts);

    let mut store = store_in(dir.path());
    import_all(&mut store, WORKSPACE, &source, WorkspaceMode::Local).unwrap();

    let session = &store.sessions_for_workspace(WORKSPACE).unwrap()[0];
    assert_eq!(store.messages_for_session(&session.id).unwrap().len(), 1);

    // The file was not marked done, so the next pass re-examines it rather
    // than treating it as unchanged — and the re-read duplicates nothing.
    let second = import_all(&mut store, WORKSPACE, &source, WorkspaceMode::Local).unwrap();
    assert_eq!(second.skipped_unchanged, 0, "an unfinished file is not 'done'");
    assert_eq!(store.messages_for_session(&session.id).unwrap().len(), 1);

    // Once the file is repaired, the tail imports.
    std::fs::write(
        transcripts.join("sess-torn.jsonl"),
        format!("{good}\n{}\n", line("assistant", "a1", "After the repair")),
    )
    .unwrap();
    import_all(&mut store, WORKSPACE, &source, WorkspaceMode::Local).unwrap();
    assert_eq!(store.messages_for_session(&session.id).unwrap().len(), 2);
}

#[test]
fn sidechain_lines_are_excluded() {
    // A subagent's own conversation, not this Session's — including it would
    // double-count work under the wrong Session.
    let dir = tempfile::tempdir().unwrap();
    let transcripts = dir.path().join("transcripts");
    std::fs::create_dir_all(&transcripts).unwrap();

    let sidechain = serde_json::json!({
        "type": "assistant",
        "uuid": "side-1",
        "isSidechain": true,
        "message": { "content": "subagent chatter", "model": "opus-5" },
    })
    .to_string();
    std::fs::write(
        transcripts.join("sess-sub.jsonl"),
        format!(
            "{}\n{sidechain}\n{}\n",
            line("user", "u1", "Add rate limiting"),
            line("assistant", "a1", "Done."),
        ),
    )
    .unwrap();

    let mut store = store_in(dir.path());
    import_all(&mut store, WORKSPACE, &TranscriptSource::new(&transcripts), WorkspaceMode::Local)
        .unwrap();

    let session = &store.sessions_for_workspace(WORKSPACE).unwrap()[0];
    for message in store.messages_for_session(&session.id).unwrap() {
        assert!(!store.message_body(&message).unwrap().contains("subagent chatter"));
    }
}

#[test]
fn a_transcript_with_no_usable_turns_leaves_no_empty_session() {
    let dir = tempfile::tempdir().unwrap();
    let transcripts = dir.path().join("transcripts");
    std::fs::create_dir_all(&transcripts).unwrap();
    std::fs::write(
        transcripts.join("sess-empty.jsonl"),
        "{\"type\":\"summary\",\"summary\":\"nothing\"}\n",
    )
    .unwrap();

    let mut store = store_in(dir.path());
    let outcome =
        import_all(&mut store, WORKSPACE, &TranscriptSource::new(&transcripts), WorkspaceMode::Local)
            .unwrap();

    assert_eq!(outcome.sessions_imported, 0);
    assert!(store.sessions_for_workspace(WORKSPACE).unwrap().is_empty());
}

#[test]
fn a_missing_transcript_directory_is_not_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let outcome = import_all(
        &mut store,
        WORKSPACE,
        &TranscriptSource::new(dir.path().join("does-not-exist")),
        WorkspaceMode::Local,
    )
    .expect("no error");
    assert_eq!(outcome.files_seen, 0);
}

// ── No Checkpoints, ever ────────────────────────────────────────────────────

#[test]
fn imported_sessions_produce_no_checkpoints() {
    // The link rule needs `existed_before` captured at write time, which is
    // unknowable retroactively. Inferring it would manufacture exactly the false
    // attribution the rule exists to prevent.
    let dir = tempfile::tempdir().unwrap();
    let transcripts = dir.path().join("transcripts");
    transcript(&transcripts, "sess-abc", &a_conversation());

    let mut store = store_in(dir.path());
    import_all(&mut store, WORKSPACE, &TranscriptSource::new(&transcripts), WorkspaceMode::Local)
        .unwrap();

    let session = &store.sessions_for_workspace(WORKSPACE).unwrap()[0];
    assert!(store.checkpoints_for_session(&session.id).unwrap().is_empty());
    assert!(
        store.file_touches_for_session(&session.id).unwrap().is_empty(),
        "no write-time file records exist to invent"
    );
}

// ── Sync state follows the Workspace ────────────────────────────────────────

#[test]
fn imported_rows_are_local_in_a_local_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let transcripts = dir.path().join("transcripts");
    transcript(&transcripts, "sess-abc", &a_conversation());

    let mut store = store_in(dir.path());
    import_all(&mut store, WORKSPACE, &TranscriptSource::new(&transcripts), WorkspaceMode::Local)
        .unwrap();

    assert_eq!(
        store.sessions_for_workspace(WORKSPACE).unwrap()[0].sync_state,
        atlas_checkpoint::SyncState::Local
    );
}

#[test]
fn imported_rows_are_pending_in_a_cloud_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let transcripts = dir.path().join("transcripts");
    transcript(&transcripts, "sess-abc", &a_conversation());

    let mut store = store_in(dir.path());
    import_all(&mut store, WORKSPACE, &TranscriptSource::new(&transcripts), WorkspaceMode::Cloud)
        .unwrap();

    assert_eq!(
        store.sessions_for_workspace(WORKSPACE).unwrap()[0].sync_state,
        atlas_checkpoint::SyncState::Pending,
        "drained by the existing outbox, with no separate backfill path"
    );
}

// ── The disclosure gate ─────────────────────────────────────────────────────

#[test]
fn the_preview_reports_real_numbers_for_the_confirmation() {
    let dir = tempfile::tempdir().unwrap();
    let transcripts = dir.path().join("transcripts");
    for id in ["one", "two"] {
        transcript(&transcripts, id, &a_conversation());
    }

    let preview = import_preview(&TranscriptSource::new(&transcripts), WorkspaceMode::Cloud);
    assert_eq!(preview.session_count, 2);
    assert!(preview.total_bytes > 0);
    assert_eq!(preview.earliest.as_deref(), Some("2026-07-01T10:00:00.000Z"));
    assert!(
        preview.is_bulk_disclosure,
        "importing into a Cloud Workspace publishes months of terminal conversations"
    );
}

#[test]
fn the_preview_counts_what_an_import_would_actually_take() {
    // The dialog must not promise 3 sessions when 2 will be skipped — one
    // already imported, one already captured live under another source.
    let dir = tempfile::tempdir().unwrap();
    let transcripts = dir.path().join("transcripts");
    for id in ["already-imported", "captured-live", "genuinely-new"] {
        transcript(&transcripts, id, &a_conversation());
    }
    let source = TranscriptSource::new(&transcripts);
    let mut store = store_in(dir.path());

    // One captured live via ACP first...
    {
        let mut capture = Capture::new(&mut store, WorkspaceMode::Local);
        capture
            .record_prompt(
                &SessionKey {
                    workspace_id: WORKSPACE.into(),
                    source: Source::Acp,
                    native_session_id: "captured-live".into(),
                },
                "live in Atlas",
                1,
                None,
                None,
                None,
            )
            .unwrap();
    }
    // ...and one imported by hiding the others, so only it is marked done.
    let hidden = dir.path().join("hidden");
    std::fs::create_dir_all(&hidden).unwrap();
    for id in ["captured-live", "genuinely-new"] {
        std::fs::rename(
            transcripts.join(format!("{id}.jsonl")),
            hidden.join(format!("{id}.jsonl")),
        )
        .unwrap();
    }
    import_all(&mut store, WORKSPACE, &source, WorkspaceMode::Local).unwrap();
    for id in ["captured-live", "genuinely-new"] {
        std::fs::rename(
            hidden.join(format!("{id}.jsonl")),
            transcripts.join(format!("{id}.jsonl")),
        )
        .unwrap();
    }

    let preview = atlas_checkpoint::import::preview_with_store(
        &store,
        WORKSPACE,
        &source,
        WorkspaceMode::Cloud,
    );
    assert_eq!(preview.session_count, 3, "everything on disk");
    assert_eq!(
        preview.new_session_count, 1,
        "only the genuinely new file would import"
    );

    // Without a store the preview cannot know better and says so honestly.
    let blind = import_preview(&source, WorkspaceMode::Cloud);
    assert_eq!(blind.new_session_count, blind.session_count);
}

#[test]
fn a_local_import_is_not_a_bulk_disclosure() {
    let dir = tempfile::tempdir().unwrap();
    let transcripts = dir.path().join("transcripts");
    transcript(&transcripts, "one", &a_conversation());

    let preview = import_preview(&TranscriptSource::new(&transcripts), WorkspaceMode::Local);
    assert!(
        !preview.is_bulk_disclosure,
        "nothing leaves the machine, so no ceremony is warranted"
    );
}

// ── Resumability and scale ──────────────────────────────────────────────────

#[test]
fn an_interrupted_import_resumes_rather_than_restarting() {
    let dir = tempfile::tempdir().unwrap();
    let transcripts = dir.path().join("transcripts");
    for id in ["one", "two", "three"] {
        transcript(&transcripts, id, &a_conversation());
    }
    let source = TranscriptSource::new(&transcripts);

    {
        let mut store = store_in(dir.path());
        import_all(&mut store, WORKSPACE, &source, WorkspaceMode::Local).unwrap();
        // Store dropped — Atlas closed mid-import.
    }

    let mut reopened = store_in(dir.path());
    let outcome = import_all(&mut reopened, WORKSPACE, &source, WorkspaceMode::Local).unwrap();
    assert_eq!(
        outcome.skipped_unchanged, 3,
        "already-imported files are recognised across a restart"
    );
    assert_eq!(reopened.sessions_for_workspace(WORKSPACE).unwrap().len(), 3);
}

#[test]
fn a_large_corpus_imports_in_reasonable_time() {
    let dir = tempfile::tempdir().unwrap();
    let transcripts = dir.path().join("transcripts");
    let long: Vec<String> = (0..200)
        .flat_map(|i| {
            vec![
                line("user", &format!("u{i}"), "a question about the rate limiter"),
                line("assistant", &format!("a{i}"), "a reasonably long answer about it"),
            ]
        })
        .collect();
    for i in 0..20 {
        transcript(&transcripts, &format!("sess-{i}"), &long);
    }

    let mut store = store_in(dir.path());
    let started = std::time::Instant::now();
    let outcome =
        import_all(&mut store, WORKSPACE, &TranscriptSource::new(&transcripts), WorkspaceMode::Local)
            .unwrap();

    assert_eq!(outcome.sessions_imported, 20);
    // Every line is recorded through the same path, so the count is exact.
    assert_eq!(outcome.messages_imported, 20 * 400);
    assert!(
        started.elapsed().as_secs() < 60,
        "8000 turns took {:?}",
        started.elapsed()
    );
}

// ── Token usage ─────────────────────────────────────────────────────────────
//
// The importer read no usage at all, so every imported Session reported zero
// tokens and the Timeline's Tokens tile was permanently a dash. The usage is on
// the assistant lines — and the same logical message is written more than once,
// which is the part that has to be got right.

/// An assistant line carrying a usage block, keyed by request.
fn usage_line(uuid: &str, request: &str, text: &str, input: u64, output: u64) -> String {
    serde_json::json!({
        "type": "assistant",
        "uuid": uuid,
        "requestId": request,
        "timestamp": "2026-07-01T10:00:00.000Z",
        "message": {
            "role": "assistant",
            "content": text,
            "model": "claude-opus-5",
            "usage": {
                "input_tokens": input,
                "output_tokens": output,
                "cache_creation_input_tokens": 29_002,
                "cache_read_input_tokens": 15_565,
            },
        },
    })
    .to_string()
}

fn import_once(root: &Path, lines: &[String]) -> Store {
    let transcripts = root.join("transcripts");
    transcript(&transcripts, "sess-usage", lines);
    let mut store = store_in(root);
    import_all(&mut store, WORKSPACE, &TranscriptSource::new(&transcripts), WorkspaceMode::Local)
        .expect("imports");
    store
}

#[test]
fn usage_is_read_off_the_transcript_and_reaches_the_session() {
    let dir = tempfile::tempdir().unwrap();
    let store = import_once(
        dir.path(),
        &[
            line("user", "u1", "Add rate limiting"),
            usage_line("a1", "req_1", "Done.", 2, 1_009),
        ],
    );

    let sessions = store.sessions_for_workspace(WORKSPACE).unwrap();
    let totals = sessions[0].token_totals;
    assert_eq!(totals.input_tokens, 2);
    assert_eq!(totals.output_tokens, 1_009);
    assert_eq!(totals.cache_creation_tokens, 29_002, "cache writes are spend too");
    assert_eq!(totals.cache_read_tokens, 15_565);
    assert_eq!(
        sessions[0].model.as_deref(),
        Some("claude-opus-5"),
        "the model comes off the same lines"
    );
}

#[test]
fn repeated_lines_for_one_request_are_counted_once() {
    let dir = tempfile::tempdir().unwrap();
    // Three copies of one request and one of another — the ratio a real
    // transcript shows, where 18 usage lines were 8 requests.
    let store = import_once(
        dir.path(),
        &[
            line("user", "u1", "Go"),
            usage_line("a1", "req_1", "Working.", 2, 1_000),
            usage_line("a1b", "req_1", "Working.", 2, 1_000),
            usage_line("a1c", "req_1", "Working.", 2, 1_000),
            usage_line("a2", "req_2", "Done.", 5, 500),
        ],
    );

    let totals = store.sessions_for_workspace(WORKSPACE).unwrap()[0].token_totals;
    assert_eq!(totals.output_tokens, 1_500, "two requests, not four lines");
    assert_eq!(totals.input_tokens, 7);
    assert_eq!(
        totals.cache_read_tokens, 31_130,
        "the cache figures collapse per request as well"
    );
}

#[test]
fn re_importing_a_grown_transcript_does_not_double_the_totals() {
    let dir = tempfile::tempdir().unwrap();
    let transcripts = dir.path().join("transcripts");
    let mut lines = vec![line("user", "u1", "Go"), usage_line("a1", "req_1", "Done.", 2, 1_000)];
    transcript(&transcripts, "sess-usage", &lines);

    let mut store = store_in(dir.path());
    let source = TranscriptSource::new(&transcripts);
    import_all(&mut store, WORKSPACE, &source, WorkspaceMode::Local).unwrap();

    lines.push(usage_line("a2", "req_2", "More.", 3, 700));
    transcript(&transcripts, "sess-usage", &lines);
    import_all(&mut store, WORKSPACE, &source, WorkspaceMode::Local).unwrap();

    let totals = store.sessions_for_workspace(WORKSPACE).unwrap()[0].token_totals;
    assert_eq!(totals.output_tokens, 1_700, "the whole file, once");
    assert_eq!(totals.input_tokens, 5);
    // A replace, not a sum: the file is always re-read from its first byte.
    assert_eq!(totals.cache_read_tokens, 31_130);
}

#[test]
fn usage_on_a_tool_only_assistant_line_is_not_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let tool_only = serde_json::json!({
        "type": "assistant",
        "uuid": "a1",
        "requestId": "req_1",
        "timestamp": "2026-07-01T10:00:00.000Z",
        "message": {
            "role": "assistant",
            "model": "claude-opus-5",
            "content": [{ "type": "tool_use", "id": "call_1", "name": "Bash", "input": { "command": "ls" } }],
            "usage": { "input_tokens": 4, "output_tokens": 88 },
        },
    })
    .to_string();

    let store = import_once(dir.path(), &[line("user", "u1", "List them"), tool_only]);
    let totals = store.sessions_for_workspace(WORKSPACE).unwrap()[0].token_totals;
    assert_eq!(totals.output_tokens, 88, "a line with no text still spent tokens");
    assert_eq!(
        store.sessions_for_workspace(WORKSPACE).unwrap()[0].model.as_deref(),
        Some("claude-opus-5"),
        "and still names its model"
    );
}

#[test]
fn a_transcript_with_no_usage_reports_none_rather_than_zeros() {
    let dir = tempfile::tempdir().unwrap();
    let store = import_once(dir.path(), &a_conversation());
    let totals = store.sessions_for_workspace(WORKSPACE).unwrap()[0].token_totals;
    assert_eq!(totals, Default::default(), "nothing recorded stays nothing recorded");
}
