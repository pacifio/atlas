//! Shared Threads on the desktop (ADR-0021, ADR-0022; ATL-395).
//!
//! A Shared Thread's canonical file state lives in the cloud. Every participant
//! holds a **replica** of it: a detached git worktree at the thread's Base,
//! created out of the way of their own checkout the first time they open a file
//! or prompt, plus one Yjs text document per file the thread has touched. Saves
//! from any editor become Yjs updates; updates from others are written back to
//! disk atomically, and never echoed.
//!
//! This crate is Tauri-free. The app owns tokens, links and windows; here is
//! the protocol, the replica and the loop that ties them together:
//!
//! * [`wire`] — wire protocol v1, transcribed from the server's contract;
//! * [`replica`] / [`doc`] — the worktree and the documents;
//! * [`session`] — one connection driving one replica;
//! * [`transport`] — the WebSocket, and an in-process fake server for tests;
//! * [`watch`] — saves in the worktree as thread paths;
//! * [`runs`] / [`merge`] — Runs: the Run worktree, and merging a Run's
//!   result back into canonical state (ATL-405);
//! * [`share`] — what a share uploads, and what it holds back (ATL-402);
//! * [`bootstrap`] — bringing the Base to a machine without it (ATL-402);
//! * [`store`] — the thread's blob, bundle and snapshot doors;
//! * [`versions`] — diffs against the Base or a Thread Version (ATL-419);
//! * [`doc`] also anchors and resolves line comments (ATL-416), and the
//!   session answers Remote Run requests made of this desktop (ATL-417);
//! * [`run`] — the loop an app spawns per joined thread.

pub mod apply;
pub mod bootstrap;
pub mod digest;
pub mod doc;
pub mod git;
pub mod merge;
pub mod path;
pub mod replica;
pub mod runs;
pub mod secrets;
pub mod session;
pub mod share;
pub mod store;
pub mod transport;
pub mod versions;
pub mod watch;
pub mod wire;

use std::collections::HashMap;
use std::path::PathBuf;

use serde::Serialize;
use tokio::sync::{mpsc, oneshot};

pub use apply::{Applied, ApplyOutcome};
pub use bootstrap::ThreadRepo;
pub use digest::{DigestComment, DigestInput, DigestScope};
pub use replica::{LocalChange, Replica, ReplicaError};
pub use runs::{ActiveRun, RunReport, RunSpec, RunWorktree};
pub use secrets::SecretReason;
pub use session::Verification;
pub use session::{
    Bootstrapped, ConflictView, OpenedDoc, PeerCursor, PeerRun, PeerView, RemoteView, Resolve,
    RunView, SessionError, ShareReport, ThreadEvent, ThreadSession,
};
pub use share::{ShareFile, ShareKind, SharePreview};
pub use store::{FakeStore, ObjectStore, StoreError};
pub use transport::{
    Connector, FakeConnector, FakeThreadServer, FakeTransport, Message, NoReconnect, Transport,
    TransportError, WsTransport,
};
pub use wire::{RemoteRun, RemoteRunStatus, SyncState};

/// What the app can ask a running thread to do.
pub enum Command {
    /// What a Run's context digest is built from (ATL-411): the Runs in
    /// `scope` with what this replica heard them say, the changed files and
    /// the open Conflicts, under the thread's `goal`.
    Digest {
        goal: String,
        scope: DigestScope,
        reply: oneshot::Sender<DigestInput>,
    },
    /// Check the replica out (first file open or prompt) and start watching it.
    Materialize(oneshot::Sender<Result<PathBuf, String>>),
    /// Make sure the Run worktree at `worktree` exists and holds canonical
    /// state now, without starting a Run — so an agent session can be opened
    /// there before its first prompt.
    PrepareRun {
        worktree: PathBuf,
        reply: oneshot::Sender<Result<PathBuf, String>>,
    },
    /// Start a Run in the Run worktree at `worktree` (ATL-405).
    StartRun {
        worktree: PathBuf,
        spec: RunSpec,
        reply: oneshot::Sender<Result<RunStarted, String>>,
    },
    /// One live frame of a Run this replica started — a serialized
    /// `SessionDelta`. Best effort: the Session drain is the record.
    RunFrame {
        run_id: String,
        payload: Vec<u8>,
    },
    /// The Run's turn ended: merge it back — or, for a Run asked to resolve
    /// a Conflict (ATL-410), resolve it with what the agent wrote.
    FinishRun {
        run_id: String,
        resolves: Option<u64>,
        reply: Option<oneshot::Sender<Result<RunReport, String>>>,
    },
    /// Resolve a Conflict on every replica (ATL-410). Answers the Thread
    /// Version the resolution recorded.
    ResolveConflict {
        conflict_id: u64,
        choice: Resolve,
        reply: oneshot::Sender<Result<u64, String>>,
    },
    /// Conflicts read over REST when the thread was opened.
    SeedConflicts(Vec<wire::ThreadConflict>),
    /// Open a file of the replica in the Atlas editor (ATL-407): its
    /// document now, or `None` for a path the thread does not hold as text.
    OpenDoc {
        path: String,
        reply: oneshot::Sender<Option<OpenedDoc>>,
    },
    CloseDoc(u64),
    /// Keystrokes from the Atlas editor, one batched Yjs update. An error
    /// says why they may not sync; the editor then saves to disk instead.
    EditorUpdate {
        file_id: u64,
        update: Vec<u8>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// The person's selections in a file of the Atlas editor, and whether
    /// they are typing there.
    Cursors {
        file_id: u64,
        cursors: Vec<(u64, u64)>,
        typing: bool,
    },
    /// The file one of this machine's Runs is touching, by its path in the
    /// Run worktree; `None` between files.
    RunFile {
        run_id: String,
        path: Option<String>,
    },
    /// Write the thread's changes into the person's checkout (ATL-408).
    Apply {
        checkout: PathBuf,
        stash: bool,
        reply: oneshot::Sender<Result<ApplyOutcome, String>>,
    },
    /// The Run will not finish: mark it interrupted.
    InterruptRun {
        run_id: String,
    },
    /// Whether to send this repository's history to teammates who lack the
    /// Base (ATL-402). Off until the person agrees.
    ServeHistory(bool),
    /// This Runner's Remote Run choices here (ATL-417): accept them or not,
    /// and whose to approve without asking (`Some(None)` clears it).
    RemoteSettings {
        accept: Option<bool>,
        auto_approve: Option<Option<String>>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Approve or decline a Remote Run this person was asked to run; answers
    /// where it stands after.
    AnswerRemoteRun {
        request_id: String,
        approve: bool,
        reply: oneshot::Sender<Result<RemoteRunStatus, String>>,
    },
    /// The thread's files against the Base, or against a Thread Version's
    /// files as the server captured them (ATL-419).
    Diff {
        against: Option<versions::VersionFiles>,
        reply: oneshot::Sender<Vec<versions::FileDiff>>,
    },
    /// The merge version this replica holds for each of `file_ids`: what a
    /// Restore names, so a file that moved since is refused, not overwritten.
    MergeVersions {
        file_ids: Vec<u64>,
        reply: oneshot::Sender<Vec<(u64, u64)>>,
    },
    /// Anchor lines of a text file for a line comment (ATL-416): its id and
    /// the range, or `None` for lines or a file the thread does not have.
    AnchorRange {
        /// The file by its id, or else by its path in the thread.
        file_id: Option<u64>,
        path: String,
        span: doc::LineSpan,
        reply: oneshot::Sender<Option<(u64, doc::RangeAnchor)>>,
    },
    /// Where each `(file id, start, end)` range is now, in lines; `None`
    /// where its text is gone.
    ResolveRanges {
        ranges: Vec<(u64, String, String)>,
        reply: oneshot::Sender<Vec<Option<doc::LineSpan>>>,
    },
    /// Close the connection and end the loop.
    Stop,
}

/// A Run this replica started.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStarted {
    pub run_id: String,
    pub run_no: u64,
    pub worktree: PathBuf,
}

/// What the app shows about a joined thread.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub connected: bool,
    pub role: Option<String>,
    pub head: u64,
    pub materialized: bool,
    pub worktree: PathBuf,
    pub files: usize,
    /// Files held on this machine because they now look like they contain a
    /// secret. They resume syncing once it is removed.
    pub held: Vec<String>,
    /// The thread's Runs this replica has heard of, newest first.
    pub runs: Vec<RunView>,
    /// Why this replica can only watch — no Base on this machine, a viewer's
    /// role, a closed thread — or `None` when it can edit.
    pub read_only: Option<String>,
    /// Whether this machine sends the repository's history to teammates who
    /// lack the Base, and how many are waiting for it while it does not.
    pub serves_history: bool,
    pub history_wanted: usize,
    /// Things done on the person's behalf they should hear about, newest last.
    pub notices: Vec<String>,
    /// Saves kept on this machine because it may not change the thread (a
    /// viewer, a closed thread); they go once it may (ATL-406).
    pub unsent: Vec<String>,
    /// The thread is closed.
    pub closed: bool,
    /// Text files that stopped syncing because they grew past 1 MiB or
    /// turned binary: their kind was fixed when they entered the thread.
    pub outgrown: Vec<String>,
    /// The thread's Conflicts, open ones first (ATL-410).
    pub conflicts: Vec<ConflictView>,
    /// Everybody else here, and what they are doing (ATL-407).
    pub peers: Vec<PeerView>,
    /// Whether this replica is current, syncing or behind.
    pub sync: Option<SyncState>,
    /// Remote Runs: this Runner's choices, and the requests this person
    /// asked or must run (ATL-417).
    pub remote: RemoteView,
    pub error: Option<String>,
}

fn status_of<T: Transport>(session: &ThreadSession<T>, error: Option<String>) -> SyncStatus {
    let replica = session.replica();
    SyncStatus {
        connected: session.is_connected(),
        role: session.role().map(|r| r.as_str().to_string()),
        head: session.head(),
        materialized: replica.is_materialized(),
        worktree: replica.root().to_path_buf(),
        files: replica.files().count(),
        held: replica.held_files(),
        runs: session.runs(),
        read_only: session.read_only(),
        serves_history: session.serves_bundles(),
        history_wanted: session.bundles_wanted(),
        notices: session.notices().to_vec(),
        unsent: session.unsent(),
        closed: session.is_closed(),
        outgrown: replica.outgrown_files(),
        conflicts: session.conflicts(),
        peers: session.peers(),
        sync: Some(session.sync_state()),
        remote: session.remote(),
        error,
    }
}

enum Event {
    Socket(Option<Message>),
    Command(Option<Command>),
    Saved(String),
    /// Saves have been quiet: files still missing were deleted, not moved.
    Settle,
    /// Time to dial the thread again (ATL-404).
    Reconnect,
    /// Time to check the replica against the thread.
    Verify,
}

/// How long to wait before each attempt to reconnect; the last repeats.
const RECONNECT_BACKOFF: &[std::time::Duration] = &[
    std::time::Duration::from_millis(250),
    std::time::Duration::from_secs(1),
    std::time::Duration::from_secs(2),
    std::time::Duration::from_secs(5),
    std::time::Duration::from_secs(15),
    std::time::Duration::from_secs(30),
];

/// How often a connected replica checks itself against the thread.
const VERIFY_EVERY: std::time::Duration = std::time::Duration::from_secs(300);

/// How long saves must be quiet before a missing file counts as deleted — a
/// move arrives as a removal and a creation, a moment apart (ATL-403).
const SETTLE_AFTER: std::time::Duration = std::time::Duration::from_millis(400);

/// Drive one joined thread until it is stopped or its socket closes.
///
/// Socket frames, app commands and saves in the worktree are taken one at a
/// time, so the replica is only ever touched from here. The watcher starts when
/// the replica is materialized — before that there is nothing on disk to watch.
///
/// The command channel is unbounded because live Run frames arrive on it from
/// the agent's emit path, which must never wait.
pub async fn run<T: Transport>(
    session: ThreadSession<T>,
    commands: mpsc::UnboundedReceiver<Command>,
    status: tokio::sync::watch::Sender<SyncStatus>,
) {
    run_with(session, commands, status, NoReconnect::<T>::default()).await;
}

/// [`run`], dialling the thread again through `connector` whenever the socket
/// drops (ATL-404): saves made meanwhile wait on disk and go out on
/// reconnect, the replica catches up from its last `seq`, and it checks
/// itself against the thread periodically and after each Run. A close the
/// server meant — access revoked, thread closed — ends the loop, and the
/// status says why.
pub async fn run_with<C: Connector>(
    mut session: ThreadSession<C::Transport>,
    mut commands: mpsc::UnboundedReceiver<Command>,
    status: tokio::sync::watch::Sender<SyncStatus>,
    connector: C,
) {
    let mut active: HashMap<String, (ActiveRun, RunWorktree)> = HashMap::new();
    let mut watcher = None;
    let mut saves: Option<mpsc::UnboundedReceiver<String>> = None;
    if session.replica().is_materialized() {
        if let Ok((w, rx)) = watch::watch(session.replica().root()) {
            watcher = Some(w);
            saves = Some(rx);
        }
    }
    let _ = status.send(status_of(&session, None));
    let mut settle_at: Option<tokio::time::Instant> = None;
    let mut reconnect_at: Option<tokio::time::Instant> = None;
    let mut attempts = 0usize;
    let mut verify_at = tokio::time::Instant::now() + VERIFY_EVERY;
    let mut final_error: Option<String> = None;

    loop {
        let connected = session.is_connected();
        let event = tokio::select! {
            message = async {
                if connected {
                    session.next_message().await
                } else {
                    std::future::pending().await
                }
            } => Event::Socket(message),
            () = async {
                match reconnect_at {
                    Some(at) => tokio::time::sleep_until(at).await,
                    None => std::future::pending().await,
                }
            } => Event::Reconnect,
            () = tokio::time::sleep_until(verify_at) => Event::Verify,
            command = commands.recv() => Event::Command(command),
            Some(path) = async {
                match saves.as_mut() {
                    Some(rx) => rx.recv().await,
                    None => std::future::pending().await,
                }
            } => Event::Saved(path),
            () = async {
                match settle_at {
                    Some(at) => tokio::time::sleep_until(at).await,
                    None => std::future::pending().await,
                }
            } => Event::Settle,
        };
        if matches!(event, Event::Saved(_)) {
            settle_at = Some(tokio::time::Instant::now() + SETTLE_AFTER);
        }
        let outcome = match event {
            Event::Socket(None) => {
                let code = session.close_code();
                if let Some(why) = code.and_then(transport::final_close) {
                    final_error = Some(why.to_string());
                    break;
                }
                if !connector.reconnects() {
                    break;
                }
                session.mark_disconnected();
                attempts = 0;
                reconnect_at = Some(tokio::time::Instant::now() + RECONNECT_BACKOFF[0]);
                Ok(())
            }
            Event::Reconnect => {
                reconnect_at = None;
                let dialled = match connector.connect().await {
                    Ok(transport) => session.reconnect(transport).await,
                    Err(e) => Err(e.into()),
                };
                if dialled.is_err() {
                    session.mark_disconnected();
                    attempts += 1;
                    let wait = RECONNECT_BACKOFF[attempts.min(RECONNECT_BACKOFF.len() - 1)];
                    reconnect_at = Some(tokio::time::Instant::now() + wait);
                } else {
                    attempts = 0;
                }
                dialled
            }
            Event::Verify => {
                verify_at = tokio::time::Instant::now() + VERIFY_EVERY;
                session.verify().await.map(|_| ())
            }
            Event::Command(None) | Event::Command(Some(Command::Stop)) => {
                for run_id in active.keys() {
                    let _ = session.interrupt_run(run_id).await;
                }
                break;
            }
            Event::Command(Some(Command::PrepareRun { worktree, reply }))
                if active.values().any(|(run, _)| run.worktree == worktree) =>
            {
                // A Run is working there: never reset it under the agent.
                let _ = reply.send(Ok(worktree));
                Ok(())
            }
            Event::Command(Some(Command::PrepareRun { worktree, reply })) => {
                let result = session
                    .run_worktree(&worktree)
                    .and_then(|worktree| session.prepare_run(&worktree).map(|()| worktree));
                let _ = reply.send(
                    result
                        .as_ref()
                        .map(|worktree| worktree.root().to_path_buf())
                        .map_err(ToString::to_string),
                );
                result.map(|_| ())
            }
            Event::Command(Some(Command::StartRun {
                worktree,
                spec,
                reply,
            })) => {
                let result = match session.run_worktree(&worktree) {
                    Ok(worktree) => session
                        .start_run(&worktree, spec)
                        .await
                        .map(|run| (run, worktree)),
                    Err(e) => Err(e),
                };
                let answer = result.as_ref().map(|(run, _)| RunStarted {
                    run_id: run.run_id.clone(),
                    run_no: run.run_no,
                    worktree: run.worktree.clone(),
                });
                let _ = reply.send(answer.map_err(std::string::ToString::to_string));
                result.map(|(run, worktree)| {
                    active.insert(run.run_id.clone(), (run, worktree));
                })
            }
            Event::Command(Some(Command::RunFrame { run_id, payload })) => {
                match active.get(&run_id) {
                    Some((run, _)) => {
                        session
                            .stream_run(run.run_no, wire::FrameKind::RunStream, payload)
                            .await
                    }
                    None => Ok(()),
                }
            }
            Event::Command(Some(Command::FinishRun {
                run_id,
                resolves: Some(conflict_id),
                reply,
            })) => match active.remove(&run_id) {
                Some((run, worktree)) => {
                    let result = session
                        .resolve_with_run(&run, &worktree, conflict_id)
                        .await
                        .map(|version| RunReport {
                            version: Some(version),
                            ..RunReport::default()
                        });
                    let text = result
                        .as_ref()
                        .map(Clone::clone)
                        .map_err(ToString::to_string);
                    if let Some(reply) = reply {
                        let _ = reply.send(text);
                    }
                    result.map(|_| ())
                }
                None => Ok(()),
            },
            Event::Command(Some(Command::ResolveConflict {
                conflict_id,
                choice,
                reply,
            })) => {
                let result = session.resolve_conflict(conflict_id, choice).await;
                let _ = reply.send(result.as_ref().map(|v| *v).map_err(ToString::to_string));
                result.map(|_| ())
            }
            Event::Command(Some(Command::Apply {
                checkout,
                stash,
                reply,
            })) => {
                let result = session.apply_to(&checkout, stash).await;
                let _ = reply.send(
                    result
                        .as_ref()
                        .map(Clone::clone)
                        .map_err(ToString::to_string),
                );
                result.map(|_| ())
            }
            Event::Command(Some(Command::OpenDoc { path, reply })) => {
                let _ = reply.send(session.open_doc(&path));
                Ok(())
            }
            Event::Command(Some(Command::CloseDoc(file_id))) => {
                session.close_doc(file_id);
                Ok(())
            }
            Event::Command(Some(Command::EditorUpdate {
                file_id,
                update,
                reply,
            })) => {
                let result = session.editor_update(file_id, update).await;
                let _ = reply.send(result.as_ref().map(|_| ()).map_err(ToString::to_string));
                // A refusal is the editor's to handle; it is not the loop's error.
                match result {
                    Err(SessionError::ReadOnly(_)) => Ok(()),
                    other => other,
                }
            }
            Event::Command(Some(Command::Cursors {
                file_id,
                cursors,
                typing,
            })) => {
                session.set_cursors(file_id, cursors);
                session.set_typing(typing.then_some(file_id));
                Ok(())
            }
            Event::Command(Some(Command::Digest { goal, scope, reply })) => {
                let _ = reply.send(session.digest_input(&goal, scope));
                Ok(())
            }
            Event::Command(Some(Command::Diff { against, reply })) => {
                let diffs = match &against {
                    Some(at) => session.diff_against_version(at).await,
                    None => session.diff_against_base(),
                };
                let _ = reply.send(diffs);
                Ok(())
            }
            Event::Command(Some(Command::AnchorRange {
                file_id,
                path,
                span,
                reply,
            })) => {
                let _ = reply.send(match file_id {
                    Some(id) => session.anchor_range_of(id, span),
                    None => session.anchor_range(&path, span),
                });
                Ok(())
            }
            Event::Command(Some(Command::ResolveRanges { ranges, reply })) => {
                let _ = reply.send(session.resolve_ranges(&ranges));
                Ok(())
            }
            Event::Command(Some(Command::MergeVersions { file_ids, reply })) => {
                let _ = reply.send(
                    file_ids
                        .into_iter()
                        .map(|id| (id, session.merge_version(id)))
                        .collect(),
                );
                Ok(())
            }
            Event::Command(Some(Command::RunFile { run_id, path })) => {
                session.set_run_file(&run_id, path.as_deref());
                Ok(())
            }
            Event::Command(Some(Command::SeedConflicts(conflicts))) => {
                session.seed_conflicts(conflicts);
                Ok(())
            }
            Event::Command(Some(Command::FinishRun {
                run_id,
                resolves: None,
                reply,
            })) => {
                match active.remove(&run_id) {
                    Some((run, worktree)) => {
                        let result = session.finish_run(&run, &worktree).await;
                        // Each Run's end is a moment to check the replica.
                        if result.is_ok() {
                            if let Err(e) = session.verify().await {
                                tracing::warn!(target: "atlas_thread_sync", "verify after a Run: {e}");
                            }
                        }
                        let text = result
                            .as_ref()
                            .map(Clone::clone)
                            .map_err(ToString::to_string);
                        if let Some(reply) = reply {
                            let _ = reply.send(text);
                        }
                        result.map(|_| ())
                    }
                    None => Ok(()),
                }
            }
            Event::Command(Some(Command::RemoteSettings {
                accept,
                auto_approve,
                reply,
            })) => {
                let result = session.set_remote_settings(accept, auto_approve).await;
                let _ = reply.send(result.as_ref().copied().map_err(ToString::to_string));
                // A refusal is the panel's to show; it is not the loop's error.
                match result {
                    Err(SessionError::Refused { .. }) => Ok(()),
                    other => other,
                }
            }
            Event::Command(Some(Command::AnswerRemoteRun {
                request_id,
                approve,
                reply,
            })) => {
                let result = session.answer_remote_run(&request_id, approve).await;
                let _ = reply.send(result.as_ref().map(|s| *s).map_err(ToString::to_string));
                match result {
                    Err(SessionError::Refused { .. }) => Ok(()),
                    other => other.map(|_| ()),
                }
            }
            Event::Command(Some(Command::ServeHistory(on))) => {
                session.set_serve_bundles(on);
                Ok(())
            }
            Event::Command(Some(Command::InterruptRun { run_id })) => {
                match active.remove(&run_id) {
                    Some(_) => session.interrupt_run(&run_id).await,
                    None => Ok(()),
                }
            }
            Event::Socket(Some(message)) => session.receive(message).await.map(|_| ()),
            Event::Saved(path) => session.file_saved(&path).await.map(|_| ()),
            Event::Settle => {
                settle_at = None;
                session.settle_removals().await.map(|_| ())
            }
            Event::Command(Some(Command::Materialize(reply))) => {
                let result = session.materialize().await;
                if let Ok(root) = &result {
                    if watcher.is_none() {
                        match watch::watch(root) {
                            Ok((w, rx)) => {
                                watcher = Some(w);
                                saves = Some(rx);
                            }
                            Err(e) => {
                                tracing::warn!(target: "atlas_thread_sync", "watcher failed: {e}")
                            }
                        }
                    }
                }
                let _ = reply.send(
                    result
                        .as_ref()
                        .map(Clone::clone)
                        .map_err(std::string::ToString::to_string),
                );
                result.map(|_| ())
            }
        };
        let mut error = outcome.err().map(|e| e.to_string());
        // Somebody lacks the Base and this replica may hold it (ATL-402).
        // Promoted, or the thread reopened: what was held may go now.
        if session.wants_flush() {
            if let Err(e) = session.flush_unsent().await {
                error.get_or_insert_with(|| e.to_string());
            }
        }
        // Editors bound to a file hear what changed in it; everyone hears
        // where this replica is (ATL-407).
        session.flush_docs();
        if let Err(e) = session.flush_awareness().await {
            tracing::debug!(target: "atlas_thread_sync", "awareness: {e}");
        }
        let wants = session.take_bundle_wants();
        if let Err(e) = session.serve_bundles(wants).await {
            error.get_or_insert_with(|| format!("could not send the Base: {e}"));
        }
        if let Some(e) = &error {
            tracing::warn!(target: "atlas_thread_sync", "thread sync: {e}");
        }
        let _ = status.send(status_of(&session, error));
    }
    drop(watcher);
    session.mark_disconnected();
    let _ = status.send(status_of(&session, final_error));
}
