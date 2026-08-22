//! The live feed: a running conversation keeping its store row current.
//!
//! Ported from Zed's `ThreadMetadataStore::handle_conversation_event`
//! (`thread_metadata_store.rs:1265-1356`) and the subscription that drives it
//! (`:1188-1212`). Zed subscribes to every `ConversationView` it ever creates
//! and upserts on the events that could have changed what the sidebar shows.
//! Atlas has no views, so the host forwards its thread events here instead;
//! everything downstream of that is Zed's.
//!
//! The one piece that is Atlas's own is the thread-id resolution below, and it
//! exists because of a difference in when a session is created. Zed mints a
//! `ThreadId` up front and attaches a session later, so its drafts are
//! addressable and it keeps them. Atlas's chat panel opens an ACP session the
//! moment a tab mounts, so a draft here already *has* a session — one that is
//! thrown away and re-created on reload, which is exactly why its id must not
//! be persisted (`:1286-1290`), and therefore why a draft row is unreachable
//! the moment its process forgets it. Atlas consequently deletes a draft rather
//! than keeping it: see [`ThreadRecorder::forget`]. CONTEXT.md records the
//! divergence under *Draft*.

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
/// Zed's `affects_thread_metadata` (`agent_ui/src/conversation_view.rs:557-582`),
/// which lives with its store rather than with the thread — as this does, so
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
        | AcpThreadEvent::ToolAuthorizationRequested(_)
        | AcpThreadEvent::ToolAuthorizationReceived(_)
        | AcpThreadEvent::ElicitationRequested(_)
        | AcpThreadEvent::ElicitationResponded(_)
        | AcpThreadEvent::Stopped(_)
        | AcpThreadEvent::Error
        | AcpThreadEvent::LoadError(_)
        | AcpThreadEvent::Refusal
        | AcpThreadEvent::WorkingDirectoriesUpdated => true,
        AcpThreadEvent::StatusChanged
        | AcpThreadEvent::PromptUpdated
        | AcpThreadEvent::TokenUsageUpdated
        | AcpThreadEvent::EntryUpdated(_)
        | AcpThreadEvent::EntriesRemoved(_)
        | AcpThreadEvent::Retry(_)
        | AcpThreadEvent::PromptCapabilitiesUpdated
        | AcpThreadEvent::AvailableCommandsUpdated(_)
        | AcpThreadEvent::ModeUpdated(_)
        | AcpThreadEvent::ConfigOptionsUpdated(_) => false,
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
    /// Zed's other write trigger: its store upserts when a `ConversationView`'s
    /// server state becomes `Connected` (`conversation_view.rs:917-919`), not
    /// only on thread events. Without it a chat nobody has typed into yet emits
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
        self.upsert(agent_id, session_id, snapshot);
    }

    /// The user sent or queued a message (Zed's `update_interacted_at`,
    /// `:843-856`). Separate from [`ThreadRecorder::record`] because the send
    /// path knows this and the thread's own events do not.
    pub fn note_interaction(&self, session_id: &acp::SessionId, at: DateTime<Utc>) {
        let thread_id = self.lock().get(session_id).copied();
        if let Some(thread_id) = thread_id {
            self.store.update_interacted_at(thread_id, at);
        }
    }

    /// The conversation is over.
    ///
    /// A thread that was ever sent to keeps its row — history outliving the
    /// process is the point. A thread that was **not** loses it: an abandoned
    /// empty chat is litter, and Atlas cannot re-find it anyway. Zed can keep
    /// its drafts because it mints the thread id before the session and stores
    /// the unsent prompt with it; Atlas mints a fresh ACP session per tab
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

    fn upsert(&self, agent_id: &AgentId, session_id: &acp::SessionId, snapshot: ThreadSnapshot) {
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
