//! The live feed: a conversation's events keeping its store row current.
//!
//! Driven the way the app drives it — a scripted sequence of thread events with
//! the thread state each one was emitted against — against a real temporary
//! SQLite store. Nothing here constructs an agent or a connection.

use std::path::PathBuf;
use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use chrono::TimeZone;
use atlas_acp_thread::thread::AcpThreadEvent;
use atlas_thread_metadata::{
    PathList, ThreadFilter, ThreadMetadataStore, ThreadRecorder, ThreadSnapshot,
};

fn store(dir: &tempfile::TempDir) -> ThreadMetadataStore {
    ThreadMetadataStore::open(dir.path().join("threads.db")).expect("store opens")
}

fn snapshot(is_draft: bool, title: Option<&str>, dirs: &[&str]) -> ThreadSnapshot {
    ThreadSnapshot {
        is_draft,
        title: title.map(Arc::from),
        work_dirs: dirs.iter().map(PathBuf::from).collect(),
    }
}

#[test]
fn a_new_chat_appears_in_history_as_a_draft_and_gains_its_session_id_on_the_first_send() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(&dir);
    let recorder = ThreadRecorder::new(store.clone());
    let session = acp::SessionId::new("ses-1");

    // The tab mounts: the agent hands back a session, the thread connects.
    // Nothing has been typed, so no thread event has fired yet.
    recorder.record_connected(&"cersei".into(), &session, snapshot(true, None, &["/tmp/atlas"]));
    store.flush().unwrap();

    let rows = store.threads();
    assert_eq!(rows.len(), 1, "the chat is in history immediately");
    assert!(rows[0].is_draft(), "and it is a draft until something is sent");

    // First send: the thread has an entry, so the session id is worth keeping.
    let thread_id = rows[0].thread_id;
    recorder.record(
        &"cersei".into(),
        &session,
        &AcpThreadEvent::NewEntry,
        snapshot(false, None, &["/tmp/atlas"]),
    );
    store.flush().unwrap();

    let after = store.thread(thread_id).expect("still the same thread");
    assert_eq!(after.session_id, Some(session), "no second row was minted");
    assert_eq!(store.threads().len(), 1);
}

#[test]
fn a_streaming_turn_does_not_touch_history_on_every_chunk() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(&dir);
    let recorder = ThreadRecorder::new(store.clone());
    let session = acp::SessionId::new("ses-1");

    // Nothing the sidebar shows changes while text streams in.
    for event in [
        AcpThreadEvent::StatusChanged,
        AcpThreadEvent::EntryUpdated(0),
        AcpThreadEvent::TokenUsageUpdated,
        AcpThreadEvent::PromptUpdated,
        AcpThreadEvent::ModeUpdated(acp::SessionModeId::new("code")),
    ] {
        recorder.record(
            &"cersei".into(),
            &session,
            &event,
            snapshot(false, Some("Streaming"), &["/tmp/atlas"]),
        );
    }
    store.flush().unwrap();

    assert!(
        store.threads().is_empty(),
        "no row exists yet — none of those events says anything about the thread"
    );
}

#[test]
fn the_agents_title_reaches_history_but_never_over_the_users_own() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(&dir);
    let recorder = ThreadRecorder::new(store.clone());
    let session = acp::SessionId::new("ses-1");
    let agent = "claude-code".into();

    recorder.record(
        &agent,
        &session,
        &AcpThreadEvent::TitleUpdated,
        snapshot(false, Some("Fix the parser"), &["/tmp/atlas"]),
    );
    store.flush().unwrap();
    let thread_id = store.threads()[0].thread_id;
    assert_eq!(
        store.thread(thread_id).unwrap().display_title().as_ref(),
        "Fix the parser"
    );

    store.set_title_override(thread_id, "Parser work");
    recorder.record(
        &agent,
        &session,
        &AcpThreadEvent::TitleUpdated,
        snapshot(false, Some("Rewrite the tokenizer"), &["/tmp/atlas"]),
    );
    store.flush().unwrap();

    assert_eq!(
        store.thread(thread_id).unwrap().display_title().as_ref(),
        "Parser work"
    );
}

#[test]
fn a_resumed_history_row_keeps_writing_to_itself() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(&dir);
    let session = acp::SessionId::new("ses-old");

    // A row this process did not create — imported, or from a previous launch.
    let earlier = ThreadRecorder::new(store.clone());
    earlier.record(
        &"claude-code".into(),
        &session,
        &AcpThreadEvent::NewEntry,
        snapshot(false, Some("Yesterday's work"), &["/tmp/atlas"]),
    );
    store.flush().unwrap();
    let thread_id = store.threads()[0].thread_id;

    // A fresh recorder — a new launch — resumes it.
    let now = ThreadRecorder::new(store.clone());
    now.record(
        &"claude-code".into(),
        &session,
        &AcpThreadEvent::NewEntry,
        snapshot(false, Some("Yesterday's work"), &["/tmp/atlas"]),
    );
    store.flush().unwrap();

    assert_eq!(store.threads().len(), 1, "no duplicate row");
    assert_eq!(store.threads()[0].thread_id, thread_id);
}

#[test]
fn opening_an_archived_thread_and_working_in_it_leaves_it_archived_until_someone_unarchives_it() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(&dir);
    let recorder = ThreadRecorder::new(store.clone());
    let session = acp::SessionId::new("ses-1");

    recorder.record(
        &"cersei".into(),
        &session,
        &AcpThreadEvent::NewEntry,
        snapshot(false, None, &["/tmp/atlas"]),
    );
    store.flush().unwrap();
    let thread_id = store.threads()[0].thread_id;
    store.archive(thread_id);

    recorder.record(
        &"cersei".into(),
        &session,
        &AcpThreadEvent::NewEntry,
        snapshot(false, Some("More work"), &["/tmp/atlas"]),
    );
    store.flush().unwrap();

    assert_eq!(store.history(ThreadFilter::ArchivedOnly).len(), 1);
    store.unarchive(thread_id);
    assert_eq!(
        store
            .threads_for_path(&PathList::new(&[PathBuf::from("/tmp/atlas")]))
            .len(),
        1
    );
}

#[test]
fn a_send_records_when_the_user_last_interacted() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(&dir);
    let recorder = ThreadRecorder::new(store.clone());
    let session = acp::SessionId::new("ses-1");
    recorder.record(
        &"cersei".into(),
        &session,
        &AcpThreadEvent::NewEntry,
        snapshot(false, None, &["/tmp/atlas"]),
    );
    let sent_at = chrono::Utc.with_ymd_and_hms(2026, 8, 22, 12, 0, 0).unwrap();

    recorder.note_interaction(&session, sent_at);
    store.flush().unwrap();

    assert_eq!(store.threads()[0].interacted_at, Some(sent_at));
}

#[test]
fn a_chat_opened_with_no_project_is_kept_in_history_rather_than_lost() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(&dir);
    let recorder = ThreadRecorder::new(store.clone());

    recorder.record(
        &"cersei".into(),
        &acp::SessionId::new("ses-1"),
        &AcpThreadEvent::NewEntry,
        snapshot(false, None, &[]),
    );
    store.flush().unwrap();

    assert!(store.threads()[0].archived);
    assert_eq!(store.history(ThreadFilter::All).len(), 1);
}

#[test]
fn every_agent_is_recorded_the_same_way() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(&dir);
    let recorder = ThreadRecorder::new(store.clone());

    for (n, agent) in ["cersei", "claude-code", "codex", "kilo", "some-new-agent"]
        .into_iter()
        .enumerate()
    {
        recorder.record(
            &agent.into(),
            &acp::SessionId::new(format!("ses-{n}")),
            &AcpThreadEvent::NewEntry,
            snapshot(false, Some(agent), &["/tmp/atlas"]),
        );
    }
    store.flush().unwrap();

    let agents: Vec<String> = store
        .threads()
        .iter()
        .map(|t| t.agent_id.to_string())
        .collect();
    assert_eq!(agents.len(), 5, "one row each, no agent singled out");
}

#[test]
fn a_chat_nobody_typed_into_leaves_nothing_behind() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(&dir);
    let recorder = ThreadRecorder::new(store.clone());
    let session = acp::SessionId::new("ses-1");
    recorder.record_connected(&"cersei".into(), &session, snapshot(true, None, &["/tmp/atlas"]));
    store.flush().unwrap();
    assert_eq!(store.threads().len(), 1, "it is visible while it is open");

    // The tab closes without a message ever being sent.
    recorder.forget(&session);
    store.flush().unwrap();

    assert!(store.threads().is_empty(), "and it is not left as litter");
}

#[test]
fn a_chat_that_was_used_survives_its_tab_closing() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(&dir);
    let recorder = ThreadRecorder::new(store.clone());
    let session = acp::SessionId::new("ses-1");
    recorder.record_connected(&"cersei".into(), &session, snapshot(true, None, &["/tmp/atlas"]));
    recorder.record(
        &"cersei".into(),
        &session,
        &AcpThreadEvent::NewEntry,
        snapshot(false, Some("Real work"), &["/tmp/atlas"]),
    );

    recorder.forget(&session);
    store.flush().unwrap();

    assert_eq!(store.threads().len(), 1);
    assert_eq!(store.threads()[0].display_title().as_ref(), "Real work");
}

#[test]
fn a_draft_left_behind_by_a_crash_is_gone_at_the_next_launch() {
    let dir = tempfile::tempdir().unwrap();
    {
        let store = store(&dir);
        let recorder = ThreadRecorder::new(store.clone());
        recorder.record_connected(
            &"cersei".into(),
            &acp::SessionId::new("ses-draft"),
            snapshot(true, None, &["/tmp/atlas"]),
        );
        recorder.record(
            &"cersei".into(),
            &acp::SessionId::new("ses-real"),
            &AcpThreadEvent::NewEntry,
            snapshot(false, Some("Real work"), &["/tmp/atlas"]),
        );
        store.flush().unwrap();
        // No `forget` — the process died.
    }

    let store = store(&dir);
    let rows = store.threads();
    assert_eq!(rows.len(), 1, "only the thread that was actually used");
    assert_eq!(rows[0].display_title().as_ref(), "Real work");
}

#[test]
fn everything_that_can_change_a_row_writes_one() {
    for event in [
        AcpThreadEvent::NewEntry,
        AcpThreadEvent::TitleUpdated,
        AcpThreadEvent::Stopped(acp::StopReason::EndTurn),
        AcpThreadEvent::Error,
        AcpThreadEvent::Refusal,
        AcpThreadEvent::WorkingDirectoriesUpdated,
        AcpThreadEvent::ToolAuthorizationRequested(acp::ToolCallId::new("call-1")),
        AcpThreadEvent::ElicitationRequested(atlas_acp_thread::ElicitationEntryId(
            "elicit-1".into(),
        )),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir);
        let recorder = ThreadRecorder::new(store.clone());
        recorder.record(
            &"cersei".into(),
            &acp::SessionId::new("ses-1"),
            &event,
            snapshot(false, None, &["/tmp/atlas"]),
        );
        store.flush().unwrap();
        assert_eq!(store.threads().len(), 1, "{event:?} should have written a row");
    }
}

#[test]
fn a_conversation_the_agent_could_not_reopen_keeps_its_row() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(&dir);
    let recorder = ThreadRecorder::new(store.clone());
    let session = acp::SessionId::new("ses-1");
    recorder.record(
        &"claude-code".into(),
        &session,
        &AcpThreadEvent::NewEntry,
        snapshot(false, Some("Yesterday's work"), &["/tmp/atlas"]),
    );
    store.flush().unwrap();
    let thread_id = store.threads()[0].thread_id;

    // The agent has forgotten the session. That is the agent's record, not
    // Atlas's, and Atlas's must survive it — only the user deletes rows.
    recorder.record(
        &"claude-code".into(),
        &session,
        &AcpThreadEvent::LoadError(atlas_acp_thread::LoadError::Other(
            "no conversation found with that id".into(),
        )),
        snapshot(false, Some("Yesterday's work"), &["/tmp/atlas"]),
    );
    store.flush().unwrap();

    let after = store.thread(thread_id).expect("the row is still there");
    assert_eq!(after.display_title().as_ref(), "Yesterday's work");
    assert_eq!(after.session_id, Some(session));
}

#[test]
fn a_session_resumed_without_its_history_is_not_mistaken_for_a_draft() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(&dir);
    let session = acp::SessionId::new("ses-1");
    {
        let yesterday = ThreadRecorder::new(store.clone());
        yesterday.record(
            &"some-agent".into(),
            &session,
            &AcpThreadEvent::NewEntry,
            snapshot(false, Some("Yesterday's work"), &["/tmp/atlas"]),
        );
        store.flush().unwrap();
    }
    let thread_id = store.threads()[0].thread_id;

    // The agent only supports `session/resume`, so the reopened thread has no
    // entries at all — which is exactly what a draft looks like.
    let today = ThreadRecorder::new(store.clone());
    today.record_connected(
        &"some-agent".into(),
        &session,
        snapshot(true, Some("Yesterday's work"), &["/tmp/atlas"]),
    );
    store.flush().unwrap();
    assert_eq!(
        store.thread(thread_id).unwrap().session_id,
        Some(session.clone()),
        "the conversation keeps its session id"
    );

    // …so closing the tab must not take it for an abandoned draft.
    today.forget(&session);
    store.flush().unwrap();
    assert_eq!(store.threads().len(), 1, "the history row survives");
}
