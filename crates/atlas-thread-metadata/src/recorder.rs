//! The live feed: a running conversation keeping its store row current.
//!
//! The host forwards its thread events here, and the recorder upserts on the
//! events that could have changed what the sidebar shows.
//!
//! The subtle piece is the thread-id resolution below, and it exists because
//! of when a session is created. A design that mints a `ThreadId` up front and
//! attaches a session later has addressable drafts it can keep. Atlas's chat
//! panel opens an ACP session the moment a tab mounts, so a draft here already
//! *has* a session — one that is thrown away and re-created on reload, which is
//! exactly why its id must not be persisted, and therefore why a draft row is
//! unreachable the moment its process forgets it. Atlas consequently deletes a
//! draft rather than keeping it: see [`ThreadRecorder::forget`]. CONTEXT.md
//! records this under *Draft*.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::connection::AgentId;
use atlas_acp_thread::thread::AcpThreadEvent;
use chrono::{DateTime, Utc};

use crate::model::ThreadId;
use crate::paths::{PathList, WorktreePaths};
use crate::store::{LiveThreadUpdate, ThreadMetadataStore};

/// What the thread was when an event was emitted against it.
///
/// Passed in rather than read here so this stays a pure function of
/// (event, thread state) — which is what makes a scripted sequence a test.
#[derive(Debug, Clone)]
pub struct ThreadSnapshot {
    /// No message has been sent yet (`AcpThread::is_draft`).
    pub is_draft: bool,
    /// The agent's title for the thread, if it has produced one.
    pub title: Option<Arc<str>>,
    pub work_dirs: Vec<PathBuf>,
}

/// Whether this event could have changed anything the store keeps.
///
/// This lives with the store rather than with the thread, so
/// `atlas-acp-thread` stays free of history vocabulary.
///
/// The excluded half is not "unimportant": a streamed chunk, a token-usage tick
/// or a mode change happens constantly and moves nothing the sidebar shows, so
/// treating them as metadata changes would queue a disk write per chunk for a
/// row that did not change.
pub fn affects_thread_metadata(event: &AcpThreadEvent) -> bool {
    match event {
        AcpThreadEvent::NewEntry
        | AcpThreadEvent::TitleUpdated
        | AcpThreadEvent::ToolAuthorizationRequested { .. }
        | AcpThreadEvent::ToolAuthorizationReceived(_)
        | AcpThreadEvent::ElicitationRequested(_)
        | AcpThreadEvent::ElicitationResponded(_)
        | AcpThreadEvent::Stopped(..)
        | AcpThreadEvent::Error
        | AcpThreadEvent::LoadError(_)
        | AcpThreadEvent::Refusal
        | AcpThreadEvent::WorkingDirectoriesUpdated => true,
        AcpThreadEvent::StatusChanged
        | AcpThreadEvent::PromptUpdated
        | AcpThreadEvent::TokenUsageUpdated
        | AcpThreadEvent::RateLimitsUpdated
        | AcpThreadEvent::EntryUpdated(_)
        | AcpThreadEvent::EntriesRemoved(_)
        | AcpThreadEvent::Retry(_)
        | AcpThreadEvent::PromptCapabilitiesUpdated
        | AcpThreadEvent::AvailableCommandsUpdated(_)
        | AcpThreadEvent::ModeUpdated(_)
        | AcpThreadEvent::ConfigOptionsUpdated(_) => false,
    }
}

/// What a thread event means for the session's lifecycle, beyond its row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleSignal {
    /// A turn ended, at the time the thread stamped on it. Unread is
    /// measured from it. Not a wake.
    TurnCompleted(DateTime<Utc>),
    /// The session needs the user: a permission request, a question, or a
    /// failure. A snoozed session wakes for it.
    RaisedHand,
}

/// Which events move a session's lifecycle. A completed turn is
/// deliberately not a raised hand: a snoozed session that finishes
/// background work stays asleep until its time.
pub fn lifecycle_signal(event: &AcpThreadEvent) -> Option<LifecycleSignal> {
    match event {
        AcpThreadEvent::Stopped(_, turn) => Some(LifecycleSignal::TurnCompleted(turn.ended_at)),
        AcpThreadEvent::ToolAuthorizationRequested { .. }
        | AcpThreadEvent::ElicitationRequested(_)
        | AcpThreadEvent::Error
        | AcpThreadEvent::LoadError(_)
        | AcpThreadEvent::Refusal => Some(LifecycleSignal::RaisedHand),
        _ => None,
    }
}

/// Keeps every live conversation's history row current.
///
/// Cheap to clone; every clone feeds the same store.
#[derive(Clone)]
pub struct ThreadRecorder {
    store: ThreadMetadataStore,
    /// Which thread each live session belongs to.
    ///
    /// Needed because a draft's session id is deliberately not persisted: with
    /// nothing in the store to look the session up by, this is the only thing
    /// that stops every event of a draft from minting a new row.
    threads: Arc<Mutex<HashMap<acp::SessionId, ThreadId>>>,
}

impl ThreadRecorder {
    pub fn new(store: ThreadMetadataStore) -> Self {
        Self {
            store,
            threads: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn store(&self) -> &ThreadMetadataStore {
        &self.store
    }

    /// Bind a live session to a history row that already exists.
    ///
    /// What opening a **draft** row calls: the row has no session id to be
    /// found by, so without this the first event of the new session would mint
    /// a second row and leave the one the user clicked orphaned.
    pub fn adopt(&self, session_id: acp::SessionId, thread_id: ThreadId) {
        self.lock().insert(session_id, thread_id);
    }

    /// The conversation is connected and has a session.
    ///
    /// A second write trigger besides thread events. Without it a chat nobody has typed into yet emits
    /// nothing, and so would never appear in history at all.
    pub fn record_connected(
        &self,
        agent_id: &AgentId,
        session_id: &acp::SessionId,
        snapshot: ThreadSnapshot,
    ) {
        self.upsert(agent_id, session_id, snapshot);
    }

    /// Record one thread event.
    ///
    /// Events that cannot have changed anything the store keeps are dropped
    /// here rather than by the caller: a streamed chunk arrives dozens of times
    /// a second and would otherwise queue a write per chunk for an unchanged
    /// row (`AcpThreadEvent::affects_thread_metadata`).
    pub fn record(
        &self,
        agent_id: &AgentId,
        session_id: &acp::SessionId,
        event: &AcpThreadEvent,
        snapshot: ThreadSnapshot,
    ) {
        // Checked here as well as at the call site: a second caller must not
        // be able to get this wrong, and the check is a match on an enum.
        if !affects_thread_metadata(event) {
            return;
        }
        let thread_id = self.upsert(agent_id, session_id, snapshot);
        match lifecycle_signal(event) {
            Some(LifecycleSignal::TurnCompleted(at)) => {
                self.store.note_turn_completed(thread_id, at);
            }
            Some(LifecycleSignal::RaisedHand) => {
                self.store.raise_hand(thread_id, Utc::now());
            }
            None => {}
        }
    }

    /// The session's turn failed somewhere its thread does not report — the
    /// send itself was refused. A raised hand, like any failure: a snoozed
    /// session wakes for it.
    pub fn note_failure(&self, session_id: &acp::SessionId, at: DateTime<Utc>) {
        if let Some(thread_id) = self.thread_for(session_id) {
            self.store.raise_hand(thread_id, at);
        }
    }

    /// The user opened or focused the session. Clears unread and "woke".
    /// Answers whether the session has a row to mark.
    pub fn note_viewed(&self, session_id: &acp::SessionId, at: DateTime<Utc>) -> bool {
        match self.thread_for(session_id) {
            Some(thread_id) => {
                self.store.mark_viewed(thread_id, at);
                true
            }
            None => false,
        }
    }

    /// The row a live session writes to, without minting one: its binding,
    /// else the row carrying its session id. A draft is found through its
    /// binding, since its session id is never persisted.
    pub fn thread_for(&self, session_id: &acp::SessionId) -> Option<ThreadId> {
        let bound = self.lock().get(session_id).copied();
        bound.or_else(|| {
            self.store
                .thread_for_session(session_id)
                .map(|thread| thread.thread_id)
        })
    }

    /// The user sent or queued a message Separate from [`ThreadRecorder::record`] because the send
    /// path knows this and the thread's own events do not.
    pub fn note_interaction(&self, session_id: &acp::SessionId, at: DateTime<Utc>) {
        let thread_id = self.lock().get(session_id).copied();
        if let Some(thread_id) = thread_id {
            self.store.update_interacted_at(thread_id, at);
        }
    }

    /// The git branch the session's working directory was found on. Like
    /// [`ThreadRecorder::note_interaction`], something only the host can know:
    /// it reads git, the thread's events do not carry it. A session not bound
    /// to a row is ignored.
    pub fn note_branch(&self, session_id: &acp::SessionId, branch: Arc<str>) {
        let thread_id = self.lock().get(session_id).copied();
        if let Some(thread_id) = thread_id {
            self.store.update_branch(thread_id, Some(branch));
        }
    }

    /// The model the session's turn runs on. Like the branch, the host's to
    /// know: the thread's events do not carry it. A session not bound to a
    /// row is ignored.
    pub fn note_model(&self, session_id: &acp::SessionId, model: Arc<str>) {
        let thread_id = self.lock().get(session_id).copied();
        if let Some(thread_id) = thread_id {
            self.store.update_model(thread_id, Some(model));
        }
    }

    /// The conversation is over.
    ///
    /// A thread that was ever sent to keeps its row — history outliving the
    /// process is the point. A thread that was **not** loses it: an abandoned
    /// empty chat is litter, and Atlas cannot re-find it anyway. Atlas mints a fresh ACP session per tab
    /// mount, so a persisted draft row is unreachable the moment its session
    /// is gone. (Spec #15: "abandoned empty chats don't litter my history".)
    pub fn forget(&self, session_id: &acp::SessionId) {
        let thread_id = self.lock().remove(session_id);
        if let Some(thread_id) = thread_id {
            if self.store.thread(thread_id).is_some_and(|t| t.is_draft()) {
                self.store.delete(thread_id);
            }
        }
    }

    fn upsert(
        &self,
        agent_id: &AgentId,
        session_id: &acp::SessionId,
        snapshot: ThreadSnapshot,
    ) -> ThreadId {
        let thread_id = self.resolve(session_id);
        let folder_paths = PathList::new(&snapshot.work_dirs);
        self.store.record_live_update(LiveThreadUpdate {
            thread_id,
            is_draft: snapshot.is_draft,
            session_id: Some(session_id.clone()),
            agent_id: agent_id.clone(),
            title: snapshot.title,
            worktree_paths: WorktreePaths::from_folder_paths(&folder_paths),
            remote_connection: None,
        });
        thread_id
    }

    /// Which row this session writes to: the one it is already bound to, else
    /// the one that already carries this session id (a resumed thread, or a
    /// row this process imported), else a new one.
    fn resolve(&self, session_id: &acp::SessionId) -> ThreadId {
        let mut bound = self.lock();
        if let Some(thread_id) = bound.get(session_id) {
            return *thread_id;
        }
        let thread_id = self
            .store
            .thread_for_session(session_id)
            .map(|thread| thread.thread_id)
            .unwrap_or_else(ThreadId::new);
        bound.insert(session_id.clone(), thread_id);
        thread_id
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<acp::SessionId, ThreadId>> {
        self.threads.lock().unwrap_or_else(PoisonError::into_inner)
    }
}
