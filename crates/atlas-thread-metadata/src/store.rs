//! The store: an in-memory index of every thread, a queued writer behind it.
//!
//! Two properties are worth stating
//! because everything else follows from them:
//!
//! * **Reads never touch SQLite.** The whole table is loaded at open and kept
//!   in memory, indexed by thread id, by folder-path list, by main-worktree
//!   path list and by session id. The sidebar re-queries on every keystroke;
//!   it must cost nothing.
//! * **Writes are queued, batched and deduped to the last operation per
//!   thread.** A streaming turn updates one row dozens of times a second; only
//!   the last one is worth a disk write.
//!
//! Every `agent_id` is written literally, never as SQL `NULL` for the native
//! agent. Special-casing one agent in the storage layer is
//! exactly the shape the "no ACP agent gets special treatment" rule forbids,
//! and the column costs the same either way.
//!
//! There is no ambient async runtime here, so the queue drains on a plain
//! thread and [`ThreadMetadataStore::flush`] exists to wait for it — at
//! shutdown, and in tests.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::mpsc::{self, Sender};
use std::sync::{
    Arc, Condvar, Mutex, MutexGuard, PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard,
};
use std::thread::JoinHandle;

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::connection::AgentId;
use chrono::{DateTime, Utc};
use tokio::sync::broadcast;

use crate::db::Db;
use crate::error::{Error, Result};
use crate::model::{ThreadId, ThreadMetadata};
use crate::paths::{PathList, WorktreePaths};
use crate::projects::{self, AttachedProject, ProjectAccess};
use crate::pull_requests::{self, PullRequestLink, PullRequestSnapshot, WatchSync};

/// How many change events a slow subscriber may fall behind before it is told
/// it lagged. The payload carries no data, so a subscriber that lags simply
/// re-reads the store — which is the correct response to any event anyway.
const EVENT_CAPACITY: usize = 64;

/// How many write failures are kept for [`ThreadMetadataStore::flush`] to
/// report. A store failing to write is failing systemically; the first few say
/// why, and the rest would only grow without bound.
const MAX_RETAINED_ERRORS: usize = 64;

/// Something changed in the store.
///
/// The sidebar's refresh comes from these. Activity Atlas does not host — a
/// terminal session, seen by the app's session watcher — reaches the store
/// through [`ThreadMetadataStore::touch_sessions`] and is announced the same
/// way.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ThreadStoreEvent {
    /// One or more rows were added, changed or removed.
    Changed,
}

/// What [`ThreadMetadataStore::mark_unread`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarkUnread {
    /// The session reads as unread now.
    Marked,
    /// It already did; nothing was written.
    AlreadyUnread,
    /// No turn of it has completed, so there is nothing to be unread.
    NoCompletedTurn,
    /// No such session.
    Missing,
}

/// One project's threads, as the sidebar groups them.
#[derive(Debug, Clone)]
pub struct ThreadProject {
    /// The project's main worktree paths — its identity, and its group key.
    pub paths: PathList,
    /// Its threads, newest first — every lifecycle state, which the sidebar
    /// sorts into sections. Never empty.
    pub threads: Vec<ThreadMetadata>,
}

/// The live update behind one row, as the conversation produces it.
///
/// The caller supplies what the thread
/// currently is, and the store decides both what to preserve from the row that
/// is already there and what not to persist at all. Keeping those rules here
/// rather than at the call site is what makes them testable, and what stops a
/// second caller from getting them subtly wrong.
#[derive(Debug, Clone)]
pub struct LiveThreadUpdate {
    pub thread_id: ThreadId,
    /// Whether the thread is still a draft — no message sent yet.
    ///
    /// A draft's session id is **never persisted**, even when the caller has
    /// one: a draft session is re-created on reload and its id would be stale
    /// the moment it was written (`:1286-1290`).
    pub is_draft: bool,
    /// The agent's session id for this thread, once it has one.
    pub session_id: Option<acp::SessionId>,
    pub agent_id: AgentId,
    /// The agent's current title for the thread, if any. Never overwrites a
    /// user's rename.
    pub title: Option<Arc<str>>,
    pub worktree_paths: WorktreePaths,
    pub remote_connection: Option<serde_json::Value>,
}

/// Atlas's session history.
///
/// Cheap to clone; every clone is the same store. Dropping the last one drains
/// the write queue before the process loses it.
#[derive(Clone)]
pub struct ThreadMetadataStore {
    inner: Arc<Inner>,
}

struct Inner {
    cache: RwLock<Cache>,
    events: broadcast::Sender<ThreadStoreEvent>,
    ops_tx: Mutex<Option<Sender<DbOperation>>>,
    progress: Progress,
    worker: Mutex<Option<JoinHandle<()>>>,
}

/// One queued write.
#[derive(Debug, Clone, PartialEq)]
enum DbOperation {
    Upsert(Box<ThreadMetadata>),
    Delete(ThreadId),
    /// The one-time backfill has run for this agent and must not run again.
    MarkBackfilled(AgentId),
    /// The user deleted this session's row; no import may bring it back.
    MarkSessionDeleted(acp::SessionId),
    /// Atlas wrote a row for the session again, so the delete is moot.
    UnmarkSessionDeleted(acp::SessionId),
    /// A transcript id confirmed to belong to another session: (alias, owner).
    SaveAlias(acp::SessionId, acp::SessionId),
    /// The alias's owner was deleted.
    DeleteAlias(acp::SessionId),
    /// A session was branched from another: (child, parent).
    SaveFork(acp::SessionId, acp::SessionId),
}

/// What a queued write is *about*, so a burst about the same thing collapses.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum OpKey {
    Thread(ThreadId),
    Backfill(AgentId),
    DeletedSession(acp::SessionId),
    Alias(acp::SessionId),
    Fork(acp::SessionId),
}

impl DbOperation {
    fn key(&self) -> OpKey {
        match self {
            DbOperation::Upsert(thread) => OpKey::Thread(thread.thread_id),
            DbOperation::Delete(thread_id) => OpKey::Thread(*thread_id),
            DbOperation::MarkBackfilled(agent_id) => OpKey::Backfill(agent_id.clone()),
            DbOperation::MarkSessionDeleted(session_id)
            | DbOperation::UnmarkSessionDeleted(session_id) => {
                OpKey::DeletedSession(session_id.clone())
            }
            DbOperation::SaveAlias(alias, _) | DbOperation::DeleteAlias(alias) => {
                OpKey::Alias(alias.clone())
            }
            DbOperation::SaveFork(child, _) => OpKey::Fork(child.clone()),
        }
    }
}

#[derive(Default)]
struct Cache {
    threads: HashMap<ThreadId, ThreadMetadata>,
    by_paths: HashMap<PathList, HashSet<ThreadId>>,
    by_main_paths: HashMap<PathList, HashSet<ThreadId>>,
    by_session: HashMap<acp::SessionId, ThreadId>,
    /// Agents the one-time first-run backfill has already run for.
    backfilled: HashSet<AgentId>,
    /// Sessions whose rows the user deleted (schema V4). Disjoint from
    /// `by_session`: writing a row for one removes it from here.
    deleted: HashSet<acp::SessionId>,
    /// Confirmed transcript aliases, alias → owner (schema V5).
    aliases: HashMap<acp::SessionId, acp::SessionId>,
    /// Branched sessions, child → parent (`session_forks`).
    forks: HashMap<acp::SessionId, acp::SessionId>,
}

/// Lets a caller wait for the queue to reach the disk, and reports what failed
/// while it did.
#[derive(Default)]
struct Progress {
    counts: Mutex<Counts>,
    drained: Condvar,
    /// Failures, each stamped with the drain count at which it happened, so a
    /// flush can report the ones that belong to it without consuming them out
    /// from under a concurrent flush.
    errors: Mutex<Vec<(u64, String)>>,
}

#[derive(Default, Clone, Copy)]
struct Counts {
    enqueued: u64,
    drained: u64,
    /// The writer has stopped and nothing further will ever drain. Set on the
    /// writer's way out, however it leaves — so a waiter is never stranded by
    /// a thread that died.
    writer_finished: bool,
}

impl ThreadMetadataStore {
    /// Open the store at `db_path`, creating it if it does not exist, and load
    /// every row into memory.
    pub fn open(db_path: impl AsRef<Path>) -> Result<Self> {
        let db = Db::open(db_path.as_ref())?;
        let rows = db.list()?;

        let mut cache = Cache::default();
        for row in rows {
            cache.insert(row);
        }
        cache.backfilled = db
            .backfilled_agents()?
            .into_iter()
            .map(AgentId::new)
            .collect();
        cache.deleted = db
            .deleted_sessions()?
            .into_iter()
            .map(acp::SessionId::new)
            .filter(|id| !cache.by_session.contains_key(id))
            .collect();
        cache.aliases = db
            .session_aliases()?
            .into_iter()
            .map(|(alias, owner)| (acp::SessionId::new(alias), acp::SessionId::new(owner)))
            .collect();
        cache.forks = db
            .session_forks()?
            .into_iter()
            .map(|(child, parent)| (acp::SessionId::new(child), acp::SessionId::new(parent)))
            .collect();

        let (ops_tx, ops_rx) = mpsc::channel::<DbOperation>();
        let (events, _) = broadcast::channel(EVENT_CAPACITY);
        let inner = Arc::new(Inner {
            cache: RwLock::new(cache),
            events,
            ops_tx: Mutex::new(Some(ops_tx)),
            progress: Progress::default(),
            worker: Mutex::new(None),
        });

        // The writer owns the connection; nothing else may hold it, which is
        // what keeps one row's write one statement without a second lock.
        let worker_inner = Arc::downgrade(&inner);
        let worker = std::thread::Builder::new()
            .name("thread-metadata-writer".into())
            .spawn(move || {
                // Whatever ends this thread — the queue closing, a panic in
                // rusqlite — releases everyone waiting in `flush`.
                let _release = WriterExit(worker_inner.clone());
                while let Ok(first) = ops_rx.recv() {
                    // Take everything already waiting: a streaming turn queues
                    // many updates for one thread and only the last matters.
                    let mut batch = vec![first];
                    while let Ok(next) = ops_rx.try_recv() {
                        batch.push(next);
                    }
                    let queued = batch.len() as u64;
                    let mut failures = Vec::new();
                    for op in dedup_operations(batch) {
                        let outcome = match &op {
                            DbOperation::Upsert(row) => db.save(row),
                            DbOperation::Delete(id) => db.delete(*id),
                            DbOperation::MarkBackfilled(agent_id) => {
                                db.mark_backfilled(agent_id.as_str())
                            }
                            DbOperation::MarkSessionDeleted(id) => db.mark_session_deleted(&id.0),
                            DbOperation::UnmarkSessionDeleted(id) => {
                                db.unmark_session_deleted(&id.0)
                            }
                            DbOperation::SaveAlias(alias, owner) => {
                                db.save_session_alias(&alias.0, &owner.0)
                            }
                            DbOperation::DeleteAlias(alias) => db.delete_session_alias(&alias.0),
                            DbOperation::SaveFork(child, parent) => {
                                db.save_session_fork(&child.0, &parent.0)
                            }
                        };
                        if let Err(e) = outcome {
                            tracing::warn!(error = %e, "thread-metadata write failed");
                            failures.push(e.to_string());
                        }
                    }
                    let Some(inner) = worker_inner.upgrade() else {
                        return;
                    };
                    inner.progress.record(queued, failures);
                }
            })
            .map_err(|e| Error::Storage(format!("spawn thread-metadata writer: {e}")))?;
        *lock(&inner.worker) = Some(worker);

        Ok(Self { inner })
    }

    /// Subscribe to store changes. This is the sidebar's refresh signal.
    pub fn subscribe(&self) -> broadcast::Receiver<ThreadStoreEvent> {
        self.inner.events.subscribe()
    }

    /// Block until everything queued so far has reached the disk.
    ///
    /// Returns the failures that queue hit — the only place a queued write can
    /// report one. Failures are reported, not consumed: two callers flushing
    /// the same batch both learn it failed.
    pub fn flush(&self) -> Result<()> {
        let reached = self.inner.progress.wait_for_drain();
        let failures: Vec<String> = lock(&self.inner.progress.errors)
            .iter()
            .filter(|(at, _)| *at <= reached)
            .map(|(_, message)| message.clone())
            .collect();
        if failures.is_empty() {
            Ok(())
        } else {
            Err(Error::Storage(failures.join("; ")))
        }
    }

    // ---------------------------------------------------------------- reads

    /// Every thread, most recently active first.
    pub fn threads(&self) -> Vec<ThreadMetadata> {
        let mut out: Vec<ThreadMetadata> =
            read(&self.inner.cache).threads.values().cloned().collect();
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then_with(|| tiebreak(a, b)));
        out
    }

    /// The history view's list: every row, newest **created** first, because
    /// the view buckets threads by when they started rather than by when they
    /// last moved.
    pub fn history(&self) -> Vec<ThreadMetadata> {
        let mut out: Vec<ThreadMetadata> =
            read(&self.inner.cache).threads.values().cloned().collect();
        out.sort_by(|a, b| started(b).cmp(&started(a)).then_with(|| tiebreak(a, b)));
        out
    }

    pub fn thread(&self, thread_id: ThreadId) -> Option<ThreadMetadata> {
        read(&self.inner.cache).threads.get(&thread_id).cloned()
    }

    /// The thread that owns `session_id`, if Atlas knows it.
    pub fn thread_for_session(&self, session_id: &acp::SessionId) -> Option<ThreadMetadata> {
        let cache = read(&self.inner.cache);
        let thread_id = cache.by_session.get(session_id)?;
        cache.threads.get(thread_id).cloned()
    }

    /// Has the one-time first-run backfill already run for this agent?
    ///
    /// "Once" has to survive a restart, so this is read from the store rather
    /// than from anything the process remembers.
    pub fn has_backfilled(&self, agent_id: &AgentId) -> bool {
        read(&self.inner.cache).backfilled.contains(agent_id)
    }

    /// Record that the backfill has run for this agent.
    ///
    /// Written even when the agent contributed nothing: "we asked and it had
    /// nothing" and "we never asked" must not look the same, or an agent with
    /// no history is re-probed — and re-spawned — on every launch.
    pub fn mark_backfilled(&self, agent_id: &AgentId) {
        if !write(&self.inner.cache).backfilled.insert(agent_id.clone()) {
            return;
        }
        self.enqueue(DbOperation::MarkBackfilled(agent_id.clone()));
    }

    /// Every session id the store knows — those with a row, and those whose
    /// row the user deleted. Import dedupes against this, which is what keeps
    /// a deleted session deleted while its agent still lists it; the watcher
    /// reads it to tell a new session from one already accounted for.
    pub fn known_session_ids(&self) -> HashSet<acp::SessionId> {
        let cache = read(&self.inner.cache);
        cache
            .by_session
            .keys()
            .chain(cache.deleted.iter())
            .chain(cache.aliases.keys())
            .cloned()
            .collect()
    }

    /// Every confirmed transcript alias, alias → owner session id.
    pub fn session_aliases(&self) -> HashMap<acp::SessionId, acp::SessionId> {
        read(&self.inner.cache).aliases.clone()
    }

    /// Record a confirmed transcript alias: `alias` is another on-disk id of
    /// `owner`, a session Atlas ran. Answers whether it was recorded.
    ///
    /// Refused when the owner has no row (a deleted owner's continuation must
    /// not be resurrected as anything) or the alias already has one. From
    /// here on the alias id is known (`known_session_ids`), so no import or
    /// sync lists it in as a session of its own, across restarts.
    pub fn record_session_alias(&self, alias: &acp::SessionId, owner: &acp::SessionId) -> bool {
        let mut cache = write(&self.inner.cache);
        if alias == owner
            || !cache.by_session.contains_key(owner)
            || cache.by_session.contains_key(alias)
            || cache.aliases.get(alias) == Some(owner)
        {
            return false;
        }
        cache.aliases.insert(alias.clone(), owner.clone());
        self.enqueue(DbOperation::SaveAlias(alias.clone(), owner.clone()));
        true
    }

    /// Record that `child` was branched from `parent` ("Branch from here").
    /// Answers whether it was recorded: a session is never its own parent,
    /// and re-recording the same pair is a no-op. The child need not have a
    /// row yet — a fork is recorded the moment the agent names the child.
    pub fn record_session_fork(&self, child: &acp::SessionId, parent: &acp::SessionId) -> bool {
        {
            let mut cache = write(&self.inner.cache);
            if child == parent || cache.forks.get(child) == Some(parent) {
                return false;
            }
            cache.forks.insert(child.clone(), parent.clone());
        }
        self.enqueue(DbOperation::SaveFork(child.clone(), parent.clone()));
        let _ = self.inner.events.send(ThreadStoreEvent::Changed);
        true
    }

    /// The session `child` was branched from, if it was.
    pub fn session_fork_parent(&self, child: &acp::SessionId) -> Option<acp::SessionId> {
        read(&self.inner.cache).forks.get(child).cloned()
    }

    /// Every recorded fork, child → parent.
    pub fn session_forks(&self) -> HashMap<acp::SessionId, acp::SessionId> {
        read(&self.inner.cache).forks.clone()
    }

    /// Whether the user deleted this session's row (and Atlas has not written
    /// one for it since).
    pub fn is_session_deleted(&self, session_id: &acp::SessionId) -> bool {
        read(&self.inner.cache).deleted.contains(session_id)
    }

    /// Every project the user has threads in, newest first, each with its own
    /// threads.
    ///
    /// The sidebar's whole list. Grouped by *main worktree* paths, so a thread
    /// opened in a linked git worktree is listed under the project it belongs
    /// to rather than as a project of its own (`sidebar.rs:1592-1602`).
    ///
    /// Across every project, not just the open one: the store is app-level
    /// precisely so that work in another worktree is visible and resumable
    /// without switching to it first (ADR-0001).
    ///
    /// Drafts are absent: a draft *is* the chat tab already on
    /// screen, and it is deleted when that tab closes — so a row for it would
    /// be a second copy of the thing the user is looking at.
    pub fn projects(&self) -> Vec<ThreadProject> {
        let cache = read(&self.inner.cache);
        let mut projects: Vec<ThreadProject> = cache
            .by_main_paths
            .iter()
            .filter_map(|(paths, ids)| {
                let mut threads: Vec<ThreadMetadata> = ids
                    .iter()
                    .filter_map(|id| cache.threads.get(id))
                    .filter(|t| !t.is_draft())
                    .cloned()
                    .collect();
                if threads.is_empty() {
                    return None;
                }
                threads
                    .sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then_with(|| tiebreak(a, b)));
                Some(ThreadProject {
                    paths: paths.clone(),
                    threads,
                })
            })
            .collect();
        // A project is as recent as the last thing done in it.
        projects.sort_by(|a, b| b.threads[0].updated_at.cmp(&a.threads[0].updated_at));
        projects
    }

    /// The threads whose folder paths are exactly `path_list` —
    /// the sidebar's per-project query.
    ///
    /// Atlas has no remote connections, so there is nothing to filter by on the
    /// row's remote-connection slot and it stays write-only until there is.
    pub fn threads_for_path(&self, path_list: &PathList) -> Vec<ThreadMetadata> {
        self.grouped(path_list, |cache| &cache.by_paths)
    }

    /// The threads whose *main* worktree paths are exactly
    /// `path_list` — which gathers threads opened in a linked worktree under
    /// the project they belong to (`sidebar.rs:1592-1602`).
    pub fn threads_for_main_worktree_path(&self, path_list: &PathList) -> Vec<ThreadMetadata> {
        self.grouped(path_list, |cache| &cache.by_main_paths)
    }

    fn grouped(
        &self,
        path_list: &PathList,
        index: impl Fn(&Cache) -> &HashMap<PathList, HashSet<ThreadId>>,
    ) -> Vec<ThreadMetadata> {
        let cache = read(&self.inner.cache);
        let mut out: Vec<ThreadMetadata> = index(&cache)
            .get(path_list)
            .into_iter()
            .flatten()
            .filter_map(|id| cache.threads.get(id))
            .cloned()
            .collect();
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then_with(|| tiebreak(a, b)));
        out
    }

    // --------------------------------------------------------------- writes

    /// Insert or replace whole rows as one change — what `session/list` import
    /// commits (`thread_import.rs:380-388`).
    ///
    /// Wholesale: every field of an existing row is replaced. That is right for
    /// import, which builds complete rows from scratch, and wrong for a live
    /// conversation, which knows nothing about the user's rename or when the
    /// thread was created. That path is
    /// [`ThreadMetadataStore::record_live_update`], and it is the only one that
    /// preserves those fields.
    pub fn save_all(&self, metadata: Vec<ThreadMetadata>) {
        if metadata.is_empty() {
            return;
        }
        for row in metadata {
            self.save_internal(row);
        }
        self.notify(ThreadStoreEvent::Changed);
    }

    /// Insert imported rows whose session the store does not know, as one
    /// atomic step. Answers how many landed.
    ///
    /// Every import path — the manual import, the first-run backfill, the
    /// per-project sync — lists an agent's sessions (slowly, over ACP), filters
    /// them against [`ThreadMetadataStore::known_session_ids`], and saves the
    /// rest. Two of those running at once both filter against the same
    /// snapshot and both save: two rows for one session, and nothing in the
    /// schema forbids it. This re-checks every row's session id under the same
    /// write lock that inserts it, so whichever import lands second finds the
    /// first one's rows and skips them. A session the user deleted is known
    /// too, and skipped the same way. A row without a session id is skipped:
    /// an import never produces one.
    pub fn insert_new_sessions(&self, rows: Vec<ThreadMetadata>) -> usize {
        let mut inserted = 0;
        {
            let mut cache = write(&self.inner.cache);
            for row in rows {
                let Some(session_id) = row.session_id.as_ref() else {
                    continue;
                };
                if cache.by_session.contains_key(session_id) || cache.deleted.contains(session_id) {
                    continue;
                }
                cache.insert(row.clone());
                self.enqueue(DbOperation::Upsert(Box::new(row)));
                inserted += 1;
            }
        }
        if inserted > 0 {
            self.notify(ThreadStoreEvent::Changed);
        }
        inserted
    }

    /// Record what a live conversation currently is, preserving everything the
    /// conversation does not own: the user's rename, when the thread was
    /// created, when the user last interacted, the branch, and the whole
    /// lifecycle (settled, pinned, snoozed, viewed). Those are the user's —
    /// or the host's, through their own mutators — never the conversation's.
    ///
    /// Read-modify-write under one write lock, so a concurrent rename or
    /// settle is never overwritten with the copy read before it. A session
    /// whose row the user had deleted stops being deleted: Atlas is writing
    /// its row again because the conversation carried on.
    pub fn record_live_update(&self, update: LiveThreadUpdate) {
        let mut cache = write(&self.inner.cache);
        let existing = cache.threads.get(&update.thread_id).cloned();
        let updated_at = Utc::now();

        // A draft's session id is never persisted (`:1286-1290`) — but a
        // thread that already has one never goes back to being a draft.
        // `is_draft` is "the thread has no entries", and a session reopened
        // with `session/resume` has none by definition: the agent continues
        // it without replaying it. Taking that at face value would blank the
        // session id of a real conversation, and the row would then be
        // deleted as an abandoned draft when its tab closed.
        let session_id = if update.is_draft {
            existing.as_ref().and_then(|t| t.session_id.clone())
        } else {
            update.session_id
        };
        let mut row = existing.unwrap_or_else(|| {
            let mut fresh = ThreadMetadata::new(
                update.thread_id,
                update.agent_id.clone(),
                PathList::default(),
            );
            fresh.created_at = Some(updated_at);
            fresh.interacted_at = Some(updated_at);
            fresh
        });
        row.session_id = session_id;
        row.agent_id = update.agent_id;
        row.title = update.title;
        row.updated_at = updated_at;
        row.created_at = row.created_at.or(Some(updated_at));
        row.worktree_paths = update.worktree_paths;
        row.remote_connection = update.remote_connection;

        if let Some(session_id) = row.session_id.as_ref() {
            if cache.deleted.remove(session_id) {
                self.enqueue(DbOperation::UnmarkSessionDeleted(session_id.clone()));
            }
        }
        cache.insert(row.clone());
        self.enqueue(DbOperation::Upsert(Box::new(row)));
        drop(cache);
        self.notify(ThreadStoreEvent::Changed);
    }

    /// The user renamed the thread. Survives every later agent title
    /// (`:702-719`). An empty name is a clear, not a blank row.
    pub fn set_title_override(&self, thread_id: ThreadId, title: impl Into<Arc<str>>) {
        let title = title.into();
        let title = (!title.trim().is_empty()).then_some(title);
        self.update(thread_id, |thread| {
            if thread.title_override == title {
                return false;
            }
            thread.title_override = title;
            true
        });
    }

    /// Replace the thread's name with a freshly generated one, dropping any
    /// rename (`:721-739`).
    ///
    /// This is **not** how an agent's ordinary titles arrive — those come
    /// through [`ThreadMetadataStore::record_live_update`], which preserves the
    /// rename. Its only callers are the user's own "regenerate title"
    /// action, so the generated title is the user's latest word on the name and replaces the older one.
    pub fn set_generated_title(&self, thread_id: ThreadId, title: impl Into<Arc<str>>) {
        let title = title.into();
        self.update(thread_id, |thread| {
            if thread.title.as_deref() == Some(title.as_ref()) && thread.title_override.is_none() {
                return false;
            }
            thread.title = Some(title);
            thread.title_override = None;
            true
        });
    }

    /// The user sent or queued a message (`:843-856`).
    ///
    /// Sending to a settled or snoozed session un-settles and un-snoozes it:
    /// the user is working in it again. That is not a wake — the user is
    /// already looking at it — so it leaves no "woke" mark. Nothing else that
    /// moves a row does this: agent output and activity seen outside Atlas
    /// leave a settled row on the shelf, and a completed turn leaves a
    /// snoozed one asleep.
    pub fn update_interacted_at(&self, thread_id: ThreadId, time: DateTime<Utc>) {
        self.update(thread_id, |thread| {
            if thread.interacted_at == Some(time)
                && thread.settled_at.is_none()
                && thread.snoozed_until.is_none()
            {
                return false;
            }
            thread.interacted_at = Some(time);
            thread.settled_at = None;
            thread.snoozed_until = None;
            thread.snoozed_at = None;
            true
        });
    }

    /// Record activity seen for known sessions: bump `updated_at`, only ever
    /// forward. One change event if anything moved. Returns how many rows
    /// changed.
    ///
    /// Activity observed outside Atlas is the caller — the session watcher
    /// seeing a terminal session write its transcript, or the project sync
    /// reading an agent's `session/list` (ADR-0001 amendment, Rule 5).
    /// Sessions the store does not know are ignored, and a time at or before
    /// the row's own never moves it back. It moves no session between
    /// lifecycle states: a settled row stays on the shelf and a snoozed one
    /// stays asleep, as for any other activity that is not the user sending.
    ///
    /// A session whose row the user deleted is never touched — there is no row
    /// to touch, and this never makes one. Each row is read and written under
    /// the cache's write lock, so a delete, settle or rename that lands while
    /// a batch is being applied is never undone by it.
    pub fn touch_sessions(&self, updates: &[(acp::SessionId, DateTime<Utc>)]) -> usize {
        let mut changed = 0;
        for (session_id, time) in updates {
            let time = *time;
            if self.update_session_silently(session_id, |thread| {
                if time <= thread.updated_at {
                    return false;
                }
                thread.updated_at = time;
                true
            }) {
                changed += 1;
            }
        }
        if changed > 0 {
            self.notify(ThreadStoreEvent::Changed);
        }
        changed
    }

    /// The project's worktrees changed (`:812-841`).
    pub fn update_worktree_paths(&self, thread_ids: &[ThreadId], worktree_paths: WorktreePaths) {
        let mut changed = false;
        for &thread_id in thread_ids {
            changed |= self.update_silently(thread_id, |thread| {
                if thread.worktree_paths == worktree_paths {
                    return false;
                }
                thread.worktree_paths = worktree_paths.clone();
                true
            });
        }
        if changed {
            self.notify(ThreadStoreEvent::Changed);
        }
    }

    /// Replace one thread's working directories, keeping its main-worktree
    /// pairing where the lengths still line up (`:789-810`).
    pub fn update_working_directories(&self, thread_id: ThreadId, work_dirs: PathList) {
        self.update(thread_id, |thread| {
            thread.worktree_paths = WorktreePaths::from_path_lists(
                thread.main_worktree_paths().clone(),
                work_dirs.clone(),
            )
            .unwrap_or_else(|_| WorktreePaths::from_folder_paths(&work_dirs));
            true
        });
    }

    /// Record the git branch the thread's working directory is on now.
    ///
    /// `None` clears it back to "not known"; an empty name counts as `None`.
    /// Whether an unresolvable branch (detached HEAD, not a repository)
    /// should clear the last one seen is the caller's policy — the host keeps
    /// the last known branch and only writes names it actually read. No change
    /// means no write and no event.
    /// Record the model the session is running on. Skips the write, and the
    /// sidebar event, when it has not changed.
    pub fn update_model(&self, thread_id: ThreadId, model: Option<Arc<str>>) {
        let model = model.filter(|m| !m.trim().is_empty());
        self.update(thread_id, |thread| {
            if thread.model == model {
                return false;
            }
            thread.model = model;
            true
        });
    }

    pub fn update_branch(&self, thread_id: ThreadId, branch: Option<Arc<str>>) {
        let branch = branch.filter(|b| !b.trim().is_empty());
        self.update(thread_id, |thread| {
            if thread.branch == branch {
                return false;
            }
            thread.branch = branch;
            true
        });
    }

    /// The projects attached to the session, in the order they were attached.
    /// Empty for a row that does not exist.
    pub fn attached_projects(&self, thread_id: ThreadId) -> Vec<AttachedProject> {
        read(&self.inner.cache)
            .threads
            .get(&thread_id)
            .map(|thread| thread.attached_projects.clone())
            .unwrap_or_default()
    }

    /// Attach `project` to the session. Answers whether anything changed.
    ///
    /// One entry per path: attaching a path that is already attached changes
    /// nothing — not its access, which only [`Self::set_project_access`]
    /// moves, so a second `@` mention (read-only by default) never quietly
    /// takes write access away. Nor is a session's own folder attached to
    /// it: the agent already runs there. Attaching is not activity, so
    /// `updated_at` stays where it is.
    pub fn attach_project(&self, thread_id: ThreadId, project: AttachedProject) -> bool {
        self.update(thread_id, |thread| {
            if thread.references_folder_path(&project.path)
                || projects::position(&thread.attached_projects, &project.path).is_some()
            {
                return false;
            }
            thread.attached_projects.push(project);
            true
        })
    }

    /// Detach the project at `path`. Answers whether it was attached.
    pub fn detach_project(&self, thread_id: ThreadId, path: &Path) -> bool {
        self.update(thread_id, |thread| {
            let Some(ix) = projects::position(&thread.attached_projects, path) else {
                return false;
            };
            thread.attached_projects.remove(ix);
            true
        })
    }

    /// Change what the agent may do in the attached project at `path`.
    /// Answers whether anything changed: `false` for a path that is not
    /// attached, or already at `access`.
    pub fn set_project_access(
        &self,
        thread_id: ThreadId,
        path: &Path,
        access: ProjectAccess,
    ) -> bool {
        self.update(thread_id, |thread| {
            let Some(ix) = projects::position(&thread.attached_projects, path) else {
                return false;
            };
            let entry = &mut thread.attached_projects[ix];
            if entry.access == access {
                return false;
            }
            entry.access = access;
            true
        })
    }

    /// The pull requests linked to the session, tombstones included, in the
    /// order they were linked. Empty for a row that does not exist.
    pub fn pull_requests(&self, thread_id: ThreadId) -> Vec<PullRequestLink> {
        read(&self.inner.cache)
            .threads
            .get(&thread_id)
            .map(|thread| thread.pull_requests.clone())
            .unwrap_or_default()
    }

    /// Link `link` to the session, or revive or strengthen the link already
    /// there (see [`PullRequestLink`]'s module). Answers whether anything
    /// changed. Linking is not activity: `updated_at` stays.
    pub fn link_pull_request(&self, thread_id: ThreadId, link: PullRequestLink) -> bool {
        self.update(thread_id, |thread| {
            pull_requests::link(&mut thread.pull_requests, link)
        })
    }

    /// Link every pull request in `found` that the session does not already
    /// hold — a tombstone counts as held, so a dismissed link stays dismissed.
    /// One write and one event for the lot. Answers whether any was added.
    pub fn link_detected_pull_requests(
        &self,
        thread_id: ThreadId,
        found: Vec<PullRequestLink>,
    ) -> bool {
        self.update(thread_id, |thread| {
            let mut changed = false;
            for link in found {
                if pull_requests::position(&thread.pull_requests, &link.repository, link.number)
                    .is_none()
                {
                    thread.pull_requests.push(link);
                    changed = true;
                }
            }
            changed
        })
    }

    /// Unlink `repository#number`: tombstoned, so the branch sweep does not
    /// bring it back. Answers whether a visible link was there.
    pub fn unlink_pull_request(&self, thread_id: ThreadId, repository: &str, number: u32) -> bool {
        self.update(thread_id, |thread| {
            pull_requests::unlink(&mut thread.pull_requests, repository, number)
        })
    }

    /// Start or stop watching `repository#number` for the session. Answers
    /// whether anything changed. A settled session starts no watch — it is
    /// done, and a wake would bring it straight back — and only a visible link
    /// can be watched; link it first.
    pub fn set_pull_request_watch(
        &self,
        thread_id: ThreadId,
        repository: &str,
        number: u32,
        watching: bool,
    ) -> bool {
        let now = Utc::now();
        self.update(thread_id, |thread| {
            if watching && thread.is_settled() {
                return false;
            }
            pull_requests::set_watch(&mut thread.pull_requests, repository, number, watching, now)
        })
    }

    /// Apply a watch reactor pass to `repository#number`, only while the
    /// watch it read (`started_at`) is still on — see
    /// [`PullRequestLink::watch`]. Answers whether it applied; `false` means
    /// the watch was stopped, restarted, unlinked or its session settled while
    /// the pass read the host, and the pass must say nothing.
    ///
    /// A watch that goes on changes nothing any surface shows, so it writes
    /// without an event; one that ends announces it.
    pub fn sync_pull_request_watch(
        &self,
        thread_id: ThreadId,
        repository: &str,
        number: u32,
        started_at: DateTime<Utc>,
        result: WatchSync,
    ) -> bool {
        let ends = matches!(result, WatchSync::End { .. });
        let applied = self.update_silently(thread_id, |thread| {
            if thread.is_settled() && !ends {
                return false;
            }
            pull_requests::sync_watch(
                &mut thread.pull_requests,
                repository,
                number,
                started_at,
                result,
            )
        });
        if applied && ends {
            self.notify(ThreadStoreEvent::Changed);
        }
        applied
    }

    /// End every watch on the session — the user stopped it. Answers whether
    /// one was on.
    pub fn end_pull_request_watches(&self, thread_id: ThreadId) -> bool {
        self.update(thread_id, |thread| {
            pull_requests::end_watches(&mut thread.pull_requests)
        })
    }

    /// Record what the host just said about `repository#number` on every
    /// session linked to it. One event for the lot; none when no snapshot
    /// changed. Answers how many sessions changed.
    pub fn sync_pull_request(
        &self,
        repository: &str,
        number: u32,
        snapshot: &PullRequestSnapshot,
    ) -> usize {
        // Collected on purpose: the read guard must drop before
        // `update_silently` takes the write lock, or this deadlocks.
        #[allow(clippy::needless_collect)]
        let holders: Vec<ThreadId> = read(&self.inner.cache)
            .threads
            .values()
            .filter(|t| t.pull_requests.iter().any(|l| l.is(repository, number)))
            .map(|t| t.thread_id)
            .collect();
        let changed = holders
            .into_iter()
            .filter(|id| {
                self.update_silently(*id, |thread| {
                    pull_requests::sync(
                        &mut thread.pull_requests,
                        repository,
                        number,
                        snapshot.clone(),
                    )
                })
            })
            .count();
        if changed > 0 {
            self.notify(ThreadStoreEvent::Changed);
        }
        changed
    }

    /// Move the session to the Settled shelf: done for now, still listed,
    /// still resumable. Answers whether anything changed — settling a row that
    /// is already settled, or that does not exist, is a no-op with no event.
    ///
    /// Settling clears a pin and a snooze: a settled session is neither held
    /// at the top nor waiting to come back. It ends the session's pull request
    /// watches too: a wake would only bring it back.
    ///
    /// Whether the session may be settled right now (not mid-turn) is the
    /// host's to decide, with one exception decided here, under the lock: a
    /// row the user sent to within [`SETTLE_AFTER_SEND_GRACE_SECS`] is
    /// refused. A send records the interaction before the host counts the
    /// turn in, so a settle landing in that gap would pass the host's busy
    /// check and bury the session the user just spoke to.
    pub fn settle(&self, thread_id: ThreadId) -> bool {
        let now = Utc::now();
        self.update(thread_id, |thread| {
            if (thread.settled_at.is_some() && !thread.is_pinned() && !thread.is_snoozed())
                || sent_to_recently(thread, now)
            {
                return false;
            }
            thread.settled_at = thread.settled_at.or(Some(now));
            clear_pin(thread);
            thread.snoozed_until = None;
            thread.snoozed_at = None;
            pull_requests::end_watches(&mut thread.pull_requests);
            true
        })
    }

    /// Whether the user sent to this session within the settle grace — the
    /// host refuses a settle with a message when it is.
    pub fn sent_to_recently(&self, thread_id: ThreadId) -> bool {
        read(&self.inner.cache)
            .threads
            .get(&thread_id)
            .is_some_and(|thread| sent_to_recently(thread, Utc::now()))
    }

    /// Back off the shelf. Recorded as `unsettled_at`, which keeps the idle
    /// sweep from settling it straight back ([`Self::auto_settle_idle`]).
    pub fn unsettle(&self, thread_id: ThreadId) -> bool {
        self.update(thread_id, |thread| {
            if thread.settled_at.is_none() {
                return false;
            }
            thread.settled_at = None;
            thread.unsettled_at = Some(Utc::now());
            true
        })
    }

    /// Pin the session. A pin brings a settled or snoozed session back to
    /// active — pinning is "keep this in front of me" — and a snoozed one
    /// counts as woken. `order_key` places it among the pinned; it is only
    /// taken for a session not already pinned (moving a pin is
    /// [`Self::reorder_pin`]). Answers whether anything changed.
    pub fn pin(&self, thread_id: ThreadId, order_key: Option<Arc<str>>) -> bool {
        let now = Utc::now();
        self.update(thread_id, |thread| {
            let promotes = thread.is_settled() || thread.is_snoozed();
            if thread.is_pinned() && !promotes {
                return false;
            }
            if !thread.is_pinned() {
                thread.pinned_at = Some(now);
                thread.pin_order = order_key.filter(|key| !key.is_empty());
            }
            if thread.is_settled() {
                thread.settled_at = None;
                thread.unsettled_at = Some(now);
            }
            wake(thread, now);
            true
        })
    }

    /// Unpin it. It stays where its other state puts it (active, normally),
    /// and its idle clock starts over from now: the pin held it out of the
    /// sweep, and unpinning is not "settle this".
    pub fn unpin(&self, thread_id: ThreadId) -> bool {
        let now = Utc::now();
        self.update(thread_id, |thread| {
            if !thread.is_pinned() {
                return false;
            }
            clear_pin(thread);
            thread.unpinned_at = Some(now);
            true
        })
    }

    /// Move a pinned session to `order_key`. Refused for one that is not
    /// pinned: a reorder racing an unpin must not resurrect the pin.
    pub fn reorder_pin(&self, thread_id: ThreadId, order_key: Arc<str>) -> bool {
        if order_key.is_empty() {
            return false;
        }
        self.update(thread_id, |thread| {
            if !thread.is_pinned() || thread.pin_order.as_deref() == Some(order_key.as_ref()) {
                return false;
            }
            thread.pin_order = Some(order_key);
            true
        })
    }

    /// Snooze the session until `until`. Re-snoozing restamps `snoozed_at`
    /// even for the same time: "I saw it, not now" again.
    ///
    /// A time not in the future is refused. So — by the host, which can see
    /// the live thread — is a session with a pending request: snoozing would
    /// hide the very thing waiting on the user. Answers whether it snoozed.
    pub fn snooze(&self, thread_id: ThreadId, until: DateTime<Utc>) -> bool {
        let now = Utc::now();
        if until <= now {
            return false;
        }
        self.update(thread_id, |thread| {
            thread.snoozed_until = Some(until);
            thread.snoozed_at = Some(now);
            true
        })
    }

    /// The user woke the session by hand. Like any wake it reads as "woke"
    /// until viewed. Answers whether it was snoozed.
    pub fn wake(&self, thread_id: ThreadId) -> bool {
        let now = Utc::now();
        self.update(thread_id, |thread| wake(thread, now))
    }

    /// Take back a snooze the user just set — the Undo on "Session snoozed".
    /// Unlike [`Self::wake`] it leaves no "woke" mark and no idle-clock
    /// restart: the snooze never happened, as far as the session's state
    /// goes. Answers whether it was snoozed.
    pub fn unsnooze(&self, thread_id: ThreadId) -> bool {
        self.update(thread_id, |thread| {
            if !thread.is_snoozed() {
                return false;
            }
            thread.snoozed_until = None;
            thread.snoozed_at = None;
            true
        })
    }

    /// The session raised its hand at `at`: a permission request, a question
    /// for the user, or a failure. A snoozed session wakes for it, early. A
    /// completed turn is not a raised hand and never comes through here.
    /// Answers whether it woke.
    pub fn raise_hand(&self, thread_id: ThreadId, at: DateTime<Utc>) -> bool {
        self.update(thread_id, |thread| wake(thread, at))
    }

    /// Wake every snooze whose time is at or before `now`, each stamped as
    /// waking at its own time. One change event if any woke. The host's wake
    /// timer calls this when [`Self::next_snooze_wake`] comes due.
    pub fn wake_due(&self, now: DateTime<Utc>) -> usize {
        let due: Vec<ThreadId> = read(&self.inner.cache)
            .threads
            .values()
            .filter(|t| t.snoozed_until.is_some_and(|until| until <= now))
            .map(|t| t.thread_id)
            .collect();
        let mut woke = 0;
        for thread_id in due {
            if self.update_silently(thread_id, |thread| match thread.snoozed_until {
                Some(until) if until <= now => wake(thread, until),
                _ => false,
            }) {
                woke += 1;
            }
        }
        if woke > 0 {
            self.notify(ThreadStoreEvent::Changed);
        }
        woke
    }

    /// The soonest snooze still to wake, if any: what the wake timer sleeps
    /// until. One timer for all of them, re-read whenever the store changes.
    pub fn next_snooze_wake(&self) -> Option<DateTime<Utc>> {
        read(&self.inner.cache)
            .threads
            .values()
            .filter_map(|t| t.snoozed_until)
            .min()
    }

    /// A turn of the session completed at `at`. What unread is measured
    /// against. Not a wake: a snoozed session that finishes work stays asleep.
    pub fn note_turn_completed(&self, thread_id: ThreadId, at: DateTime<Utc>) -> bool {
        self.update(thread_id, |thread| {
            if thread.last_turn_completed_at.is_some_and(|done| done >= at) {
                return false;
            }
            thread.last_turn_completed_at = Some(at);
            true
        })
    }

    /// The user opened or focused the session at `at`. Only ever forward.
    /// Clears unread and "woke". The caller debounces: this is a write.
    pub fn mark_viewed(&self, thread_id: ThreadId, at: DateTime<Utc>) -> bool {
        self.update(thread_id, |thread| {
            if thread.last_viewed_at.is_some_and(|seen| seen >= at) {
                return false;
            }
            thread.last_viewed_at = Some(at);
            true
        })
    }

    /// Make the session read as unread again: last viewed just before its
    /// latest turn completed.
    pub fn mark_unread(&self, thread_id: ThreadId) -> MarkUnread {
        let mut outcome = MarkUnread::Missing;
        self.update(thread_id, |thread| {
            let Some(done) = thread.last_turn_completed_at else {
                outcome = MarkUnread::NoCompletedTurn;
                return false;
            };
            if thread.is_unread() {
                outcome = MarkUnread::AlreadyUnread;
                return false;
            }
            thread.last_viewed_at = Some(done - chrono::Duration::milliseconds(1));
            outcome = MarkUnread::Marked;
            true
        });
        outcome
    }

    /// The sessions the idle sweep would settle at `cutoff`, with the folders
    /// each ran in, before the host rules out the busy ones. Read under the
    /// read lock, and only these rows are copied out: the host's busy check
    /// costs a thread lock and possibly a directory scan per session, so it
    /// runs over this short list rather than every row.
    pub fn idle_sessions(&self, cutoff: DateTime<Utc>) -> Vec<(acp::SessionId, PathList)> {
        self.idle_sessions_keeping(cutoff, false)
    }

    /// [`Self::idle_sessions`], leaving out every session with a linked pull
    /// request when `keep_pull_requests` (the `autoSettleKeepPullRequests`
    /// setting): such a session waits on its pull request, and settles when
    /// that merges or closes.
    pub fn idle_sessions_keeping(
        &self,
        cutoff: DateTime<Utc>,
        keep_pull_requests: bool,
    ) -> Vec<(acp::SessionId, PathList)> {
        read(&self.inner.cache)
            .threads
            .values()
            .filter(|t| due_for_settling(t, cutoff, keep_pull_requests))
            .filter_map(|t| Some((t.session_id.clone()?, t.folder_paths().clone())))
            .collect()
    }

    /// Settle every session idle since before `cutoff`. Answers how many were
    /// settled; one change event if any were.
    ///
    /// A row is left alone when it is a draft, already settled, pinned,
    /// snoozed, active at or after `cutoff`, or un-settled by the user after
    /// its last activity — they said it is not done, and nothing has happened
    /// since. `busy` names the sessions the host knows
    /// are running, waiting on the user, or live in another process; those
    /// are skipped too. It is passed in rather than asked for because it is
    /// read from the host, which reads this store.
    ///
    /// The scan runs under the read lock; the write lock is taken only when
    /// something is due, and each row is checked again under it, since a send
    /// may have landed in between.
    ///
    /// The settled time is the row's last activity, not now: the session
    /// was done then, and that is the order the shelf lists it in.
    pub fn auto_settle_idle(&self, cutoff: DateTime<Utc>, busy: &HashSet<acp::SessionId>) -> usize {
        self.auto_settle_idle_keeping(cutoff, busy, false)
    }

    /// [`Self::auto_settle_idle`] with [`Self::idle_sessions_keeping`]'s
    /// `keep_pull_requests`. A session whose pull request Atlas is watching
    /// is never settled for being idle either way: an agent is waiting on it.
    pub fn auto_settle_idle_keeping(
        &self,
        cutoff: DateTime<Utc>,
        busy: &HashSet<acp::SessionId>,
        keep_pull_requests: bool,
    ) -> usize {
        let is_due = |t: &ThreadMetadata| {
            due_for_settling(t, cutoff, keep_pull_requests)
                && t.session_id
                    .as_ref()
                    .is_some_and(|session_id| !busy.contains(session_id))
        };
        let due: Vec<ThreadId> = read(&self.inner.cache)
            .threads
            .values()
            .filter(|t| is_due(t))
            .map(|t| t.thread_id)
            .collect();
        if due.is_empty() {
            return 0;
        }
        let mut settled = 0;
        {
            let mut cache = write(&self.inner.cache);
            for thread_id in due {
                let Some(mut thread) = cache.threads.get(&thread_id).cloned() else {
                    continue;
                };
                if !is_due(&thread) {
                    continue;
                }
                thread.settled_at = Some(thread.last_activity());
                cache.insert(thread.clone());
                self.enqueue(DbOperation::Upsert(Box::new(thread)));
                settled += 1;
            }
        }
        if settled > 0 {
            self.notify(ThreadStoreEvent::Changed);
        }
        settled
    }

    /// Remove the row. Local only — asking the agent to forget its session is
    /// a separate, capability-gated step the caller makes.
    ///
    /// A row with a session id also records that session as deleted (schema
    /// V4), durably: import is ongoing (ADR-0001 amendment), and an agent that
    /// cannot forget the session would otherwise list it straight back into
    /// the sidebar on the next sync. A draft has no session to remember.
    pub fn delete(&self, thread_id: ThreadId) {
        if self.delete_internal(thread_id) {
            self.notify(ThreadStoreEvent::Changed);
        }
    }

    pub fn delete_all(&self, thread_ids: impl IntoIterator<Item = ThreadId>) {
        let mut changed = false;
        for thread_id in thread_ids {
            changed |= self.delete_internal(thread_id);
        }
        if changed {
            self.notify(ThreadStoreEvent::Changed);
        }
    }

    /// Read one row, let `mutate` change it, and save it back if it did.
    ///
    /// Every single-row mutator is this shape; having it once is what keeps
    /// "no change means no write and no event" true for all of them.
    fn update(
        &self,
        thread_id: ThreadId,
        mutate: impl FnOnce(&mut ThreadMetadata) -> bool,
    ) -> bool {
        let changed = self.update_silently(thread_id, mutate);
        if changed {
            self.notify(ThreadStoreEvent::Changed);
        }
        changed
    }

    /// The read, the mutation and the write all happen under the cache's
    /// write lock, and the disk write is queued before it is released. Reading
    /// a copy under a read lock and saving it back later — what this used to
    /// do — let a concurrent delete, archive or rename land in between and be
    /// overwritten by the stale copy; a deleted row even came back, because
    /// the queue keeps the last write per thread. `mutate` therefore must not
    /// call back into the store.
    fn update_silently(
        &self,
        thread_id: ThreadId,
        mutate: impl FnOnce(&mut ThreadMetadata) -> bool,
    ) -> bool {
        let mut cache = write(&self.inner.cache);
        let Some(mut thread) = cache.threads.get(&thread_id).cloned() else {
            return false;
        };
        if !mutate(&mut thread) {
            return false;
        }
        cache.insert(thread.clone());
        self.enqueue(DbOperation::Upsert(Box::new(thread)));
        true
    }

    /// [`Self::update_silently`], for the row that owns `session_id`; the
    /// lookup is under the same lock as the write.
    fn update_session_silently(
        &self,
        session_id: &acp::SessionId,
        mutate: impl FnOnce(&mut ThreadMetadata) -> bool,
    ) -> bool {
        let mut cache = write(&self.inner.cache);
        let Some(mut thread) = cache
            .by_session
            .get(session_id)
            .and_then(|id| cache.threads.get(id))
            .cloned()
        else {
            return false;
        };
        if !mutate(&mut thread) {
            return false;
        }
        cache.insert(thread.clone());
        self.enqueue(DbOperation::Upsert(Box::new(thread)));
        true
    }

    // Every write below queues its disk operation while still holding the
    // cache's write lock. Two writers to one row must reach the queue in the
    // order they changed the cache, or the disk could end on the older one —
    // an upsert queued after the delete that preceded it resurrects the row at
    // the next launch.

    fn save_internal(&self, metadata: ThreadMetadata) {
        let mut cache = write(&self.inner.cache);
        if let Some(session_id) = metadata.session_id.as_ref() {
            if cache.deleted.remove(session_id) {
                self.enqueue(DbOperation::UnmarkSessionDeleted(session_id.clone()));
            }
        }
        cache.insert(metadata.clone());
        self.enqueue(DbOperation::Upsert(Box::new(metadata)));
    }

    fn delete_internal(&self, thread_id: ThreadId) -> bool {
        let mut cache = write(&self.inner.cache);
        let Some(removed) = cache.remove(thread_id) else {
            return false;
        };
        self.enqueue(DbOperation::Delete(thread_id));
        if let Some(session_id) = removed.session_id {
            // The owner's aliases go with it, and each alias id is recorded as
            // deleted too: dropping the alias alone would make the
            // continuation an unknown session the next sync imports — the
            // deleted conversation back under another id.
            let aliases: Vec<acp::SessionId> = cache
                .aliases
                .iter()
                .filter(|(_, owner)| **owner == session_id)
                .map(|(alias, _)| alias.clone())
                .collect();
            for alias in aliases {
                cache.aliases.remove(&alias);
                self.enqueue(DbOperation::DeleteAlias(alias.clone()));
                if cache.deleted.insert(alias.clone()) {
                    self.enqueue(DbOperation::MarkSessionDeleted(alias));
                }
            }
            if cache.deleted.insert(session_id.clone()) {
                self.enqueue(DbOperation::MarkSessionDeleted(session_id));
            }
        }
        true
    }

    fn enqueue(&self, op: DbOperation) {
        let tx = lock(&self.inner.ops_tx);
        let Some(tx) = tx.as_ref() else {
            return;
        };
        self.inner.progress.enqueue();
        if tx.send(op).is_err() {
            // The writer is gone; nothing more can be persisted this run.
            self.inner.progress.record(1, Vec::new());
        }
    }

    fn notify(&self, event: ThreadStoreEvent) {
        let _ = self.inner.events.send(event);
    }
}

/// Which of a burst of queued writes actually reach the disk: the last one per
/// thread, in no particular order across threads.
fn dedup_operations(operations: Vec<DbOperation>) -> Vec<DbOperation> {
    let mut seen: HashMap<OpKey, DbOperation> = HashMap::new();
    for operation in operations.into_iter().rev() {
        seen.entry(operation.key()).or_insert(operation);
    }
    seen.into_values().collect()
}

/// Releases every `flush` waiter when the writer thread leaves, by any route.
struct WriterExit(std::sync::Weak<Inner>);

impl Drop for WriterExit {
    fn drop(&mut self) {
        if let Some(inner) = self.0.upgrade() {
            inner.progress.finish();
        }
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        // Closing the queue is what tells the writer to finish and stop; it
        // drains what is already queued before it sees the disconnect.
        lock(&self.ops_tx).take();
        if let Some(worker) = lock(&self.worker).take() {
            let _ = worker.join();
        }
    }
}

impl Cache {
    fn insert(&mut self, metadata: ThreadMetadata) {
        if let Some(previous) = self.threads.get(&metadata.thread_id) {
            // Re-index only what moved: a row whose paths changed must not be
            // left findable under its old grouping key.
            if previous.folder_paths() != metadata.folder_paths() {
                remove_from(
                    &mut self.by_paths,
                    previous.folder_paths(),
                    metadata.thread_id,
                );
            }
            if previous.main_worktree_paths() != metadata.main_worktree_paths() {
                remove_from(
                    &mut self.by_main_paths,
                    previous.main_worktree_paths(),
                    metadata.thread_id,
                );
            }
            if previous.session_id != metadata.session_id {
                if let Some(session_id) = previous.session_id.as_ref() {
                    self.by_session.remove(session_id);
                }
            }
        }

        // A draft has no session id yet, so it is not indexed by one.
        if let Some(session_id) = metadata.session_id.as_ref() {
            self.by_session
                .insert(session_id.clone(), metadata.thread_id);
        }
        if !metadata.folder_paths().is_empty() {
            self.by_paths
                .entry(metadata.folder_paths().clone())
                .or_default()
                .insert(metadata.thread_id);
        }
        if !metadata.main_worktree_paths().is_empty() {
            self.by_main_paths
                .entry(metadata.main_worktree_paths().clone())
                .or_default()
                .insert(metadata.thread_id);
        }
        self.threads.insert(metadata.thread_id, metadata);
    }

    fn remove(&mut self, thread_id: ThreadId) -> Option<ThreadMetadata> {
        let removed = self.threads.remove(&thread_id)?;
        if let Some(session_id) = removed.session_id.as_ref() {
            self.by_session.remove(session_id);
        }
        remove_from(&mut self.by_paths, removed.folder_paths(), thread_id);
        remove_from(
            &mut self.by_main_paths,
            removed.main_worktree_paths(),
            thread_id,
        );
        Some(removed)
    }
}

impl Progress {
    fn enqueue(&self) {
        lock(&self.counts).enqueued += 1;
    }

    fn record(&self, drained: u64, failures: Vec<String>) {
        let mut counts = lock(&self.counts);
        counts.drained += drained;
        if !failures.is_empty() {
            let mut errors = lock(&self.errors);
            errors.extend(
                failures
                    .into_iter()
                    .map(|message| (counts.drained, message)),
            );
            let overflow = errors.len().saturating_sub(MAX_RETAINED_ERRORS);
            errors.drain(..overflow);
        }
        self.drained.notify_all();
    }

    fn finish(&self) {
        lock(&self.counts).writer_finished = true;
        self.drained.notify_all();
    }

    /// Waits until everything enqueued so far has drained, and returns the
    /// drain count reached. Returns early if the writer has stopped — a waiter
    /// must not outlive the thread it is waiting on.
    fn wait_for_drain(&self) -> u64 {
        let mut counts = lock(&self.counts);
        let target = counts.enqueued;
        while counts.drained < target && !counts.writer_finished {
            counts = self
                .drained
                .wait(counts)
                .unwrap_or_else(PoisonError::into_inner);
        }
        counts.drained
    }
}

fn remove_from(
    index: &mut HashMap<PathList, HashSet<ThreadId>>,
    key: &PathList,
    thread_id: ThreadId,
) {
    if let Some(ids) = index.get_mut(key) {
        ids.remove(&thread_id);
        if ids.is_empty() {
            index.remove(key);
        }
    }
}

/// When a thread started, for the history view's ordering: falls back to
/// `updated_at` for rows written before `created_at` existed.
fn started(thread: &ThreadMetadata) -> DateTime<Utc> {
    thread.created_at.unwrap_or(thread.updated_at)
}

/// Timestamps collide at millisecond resolution during a burst; the id keeps
/// every ordering total so a list never flickers.
fn tiebreak(a: &ThreadMetadata, b: &ThreadMetadata) -> std::cmp::Ordering {
    b.thread_id.as_uuid().cmp(a.thread_id.as_uuid())
}

// A poisoned lock means some other thread panicked mid-mutation. The data
// behind these locks is a cache of what is already on disk and a pair of
// counters — none of it is a half-applied invariant — so taking it anyway
// degrades to "possibly one stale row" rather than turning every later sidebar
// read into a second panic.
/// How long after a user send a settle is refused ([`ThreadMetadataStore::settle`]).
pub const SETTLE_AFTER_SEND_GRACE_SECS: i64 = 10;

fn sent_to_recently(thread: &ThreadMetadata, now: DateTime<Utc>) -> bool {
    thread.interacted_at.is_some_and(|at| {
        now.signed_duration_since(at) < chrono::Duration::seconds(SETTLE_AFTER_SEND_GRACE_SECS)
    })
}

/// The store's half of the idle sweep's rule; the host adds "not busy".
///
/// Idleness is measured from [`ThreadMetadata::idle_since`], so a session
/// just woken from a snooze or just unpinned gets a full window first. The
/// un-settle guard still compares against real activity: an un-settle says
/// "not done", and only something happening since can change that.
///
/// A watched pull request always keeps its session; any linked one does when
/// `keep_pull_requests`.
fn due_for_settling(
    thread: &ThreadMetadata,
    cutoff: DateTime<Utc>,
    keep_pull_requests: bool,
) -> bool {
    let last = thread.last_activity();
    let mut links = pull_requests::visible(&thread.pull_requests);
    let held_by_pull_request = if keep_pull_requests {
        links.next().is_some()
    } else {
        links.any(PullRequestLink::is_watched)
    };
    thread.session_id.is_some()
        && thread.settled_at.is_none()
        && !thread.is_pinned()
        && !thread.is_snoozed()
        && !held_by_pull_request
        && thread.idle_since() < cutoff
        && thread.unsettled_at.is_none_or(|at| at <= last)
}

fn clear_pin(thread: &mut ThreadMetadata) {
    thread.pinned_at = None;
    thread.pin_order = None;
}

/// End a snooze, stamped as waking at `at`. False when it was not snoozed.
fn wake(thread: &mut ThreadMetadata, at: DateTime<Utc>) -> bool {
    if !thread.is_snoozed() {
        return false;
    }
    thread.snoozed_until = None;
    thread.snoozed_at = None;
    thread.last_snooze_wake_at = Some(at);
    true
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn read<T>(lock: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(PoisonError::into_inner)
}

fn write<T>(lock: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    lock.write().unwrap_or_else(PoisonError::into_inner)
}
