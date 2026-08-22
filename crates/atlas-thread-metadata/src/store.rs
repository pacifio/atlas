//! The store: an in-memory index of every thread, a queued writer behind it.
//!
//! Ported from Zed's `ThreadMetadataStore`
//! (`thread_metadata_store.rs:497-1360`). Two properties are worth stating
//! because everything else follows from them:
//!
//! * **Reads never touch SQLite.** The whole table is loaded at open and kept
//!   in memory, indexed by thread id, by folder-path list, by main-worktree
//!   path list and by session id. The sidebar re-queries on every keystroke;
//!   it must cost nothing.
//! * **Writes are queued, batched and deduped to the last operation per
//!   thread.** A streaming turn updates one row dozens of times a second; only
//!   the last one is worth a disk write (`:1214-1263`).
//!
//! Divergence from Zed, deliberately: Zed stores the native agent's id as SQL
//! `NULL` and decodes it back (`:1499-1503`, `:1725-1727`). Atlas writes every
//! `agent_id` literally. Special-casing one agent in the storage layer is
//! exactly the shape the "no ACP agent gets special treatment" rule forbids,
//! and the column costs the same either way.
//!
//! Divergence from Zed, structural: Zed's queue drains on a GPUI background
//! task and its callers are async. Atlas has no such ambient runtime here, so
//! the queue drains on a plain thread and [`ThreadMetadataStore::flush`] exists
//! to wait for it — at shutdown, and in tests. That is the whole of the
//! difference; the batching and dedup rules are Zed's.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError, RwLock, RwLockReadGuard,
                RwLockWriteGuard};
use std::thread::JoinHandle;

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::connection::AgentId;
use chrono::{DateTime, Utc};
use tokio::sync::broadcast;

use crate::db::Db;
use crate::error::{Error, Result};
use crate::model::{ThreadFilter, ThreadId, ThreadMetadata};
use crate::paths::{PathList, WorktreePaths};

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
/// The sidebar's refresh comes from these, not from watching anyone's files.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ThreadStoreEvent {
    /// One or more rows were added, changed or removed.
    Changed,
    /// A thread was archived. Emitted in addition to [`ThreadStoreEvent::Changed`]
    /// because archiving is the one mutation with a user-visible consequence
    /// beyond the list contents (Zed's `ThreadArchived`, `:858-871`).
    ThreadArchived(ThreadId),
}

/// The live update behind one row, as the conversation produces it.
///
/// This is the store-side half of Zed's `handle_conversation_event`
/// (`thread_metadata_store.rs:1265-1356`): the caller supplies what the thread
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
}

impl DbOperation {
    fn thread_id(&self) -> ThreadId {
        match self {
            DbOperation::Upsert(thread) => thread.thread_id,
            DbOperation::Delete(thread_id) => *thread_id,
        }
    }
}

#[derive(Default)]
struct Cache {
    threads: HashMap<ThreadId, ThreadMetadata>,
    by_paths: HashMap<PathList, HashSet<ThreadId>>,
    by_main_paths: HashMap<PathList, HashSet<ThreadId>>,
    by_session: HashMap<acp::SessionId, ThreadId>,
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
        let mut out: Vec<ThreadMetadata> = read(&self.inner.cache).threads.values().cloned().collect();
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then_with(|| tiebreak(a, b)));
        out
    }

    /// The history/archive view's list: newest **created** first, because the
    /// view buckets threads by when they started rather than by when they last
    /// moved (Zed's `update_items`, `threads_archive_view.rs:271-299`).
    pub fn history(&self, filter: ThreadFilter) -> Vec<ThreadMetadata> {
        let mut out: Vec<ThreadMetadata> = read(&self.inner.cache)
            .threads
            .values()
            .filter(|t| match filter {
                ThreadFilter::All => true,
                ThreadFilter::ArchivedOnly => t.archived,
            })
            .cloned()
            .collect();
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

    /// Every session id the store knows. Import dedupes against this.
    pub fn known_session_ids(&self) -> HashSet<acp::SessionId> {
        read(&self.inner.cache).by_session.keys().cloned().collect()
    }

    /// The unarchived threads whose folder paths are exactly `path_list` —
    /// the sidebar's per-project query (`sidebar.rs:1604-1618`).
    ///
    /// Zed additionally filters on the row's remote connection
    /// (`:621-660`). Atlas has no remote connections, so there is nothing to
    /// filter by and the slot stays write-only until it does.
    pub fn threads_for_path(&self, path_list: &PathList) -> Vec<ThreadMetadata> {
        self.grouped(path_list, |cache| &cache.by_paths)
    }

    /// The unarchived threads whose *main* worktree paths are exactly
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
            .filter(|t| !t.archived)
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

    /// Record what a live conversation currently is, preserving everything the
    /// conversation does not own: the user's rename, when the thread was
    /// created, when the user last interacted, and — for an archived thread —
    /// the paths it was archived with.
    ///
    /// A thread with no folder path is archived on creation, because it would
    /// otherwise be invisible: the sidebar lists by project, and it belongs to
    /// none (`:1325-1331`).
    pub fn record_live_update(&self, update: LiveThreadUpdate) {
        let existing = self.thread(update.thread_id);
        let updated_at = Utc::now();

        let (worktree_paths, remote_connection) = match existing.as_ref().filter(|t| t.archived) {
            Some(archived) => (
                archived.worktree_paths.clone(),
                archived.remote_connection.clone(),
            ),
            None => (update.worktree_paths, update.remote_connection),
        };
        let archived = existing
            .as_ref()
            .map(|t| t.archived)
            .unwrap_or_else(|| worktree_paths.is_empty());

        self.save(ThreadMetadata {
            thread_id: update.thread_id,
            session_id: if update.is_draft {
                None
            } else {
                update.session_id
            },
            agent_id: update.agent_id,
            title: update.title,
            title_override: existing.as_ref().and_then(|t| t.title_override.clone()),
            updated_at,
            created_at: Some(
                existing
                    .as_ref()
                    .and_then(|t| t.created_at)
                    .unwrap_or(updated_at),
            ),
            interacted_at: existing
                .as_ref()
                .map(|t| t.interacted_at)
                .unwrap_or(Some(updated_at)),
            worktree_paths,
            remote_connection,
            archived,
        });
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
    /// rename. Zed's only two callers are the user's own "regenerate title"
    /// action (`sidebar.rs:3809`, `agent_panel.rs:4060`), so the generated
    /// title is the user's latest word on the name and replaces the older one.
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
    pub fn update_interacted_at(&self, thread_id: ThreadId, time: DateTime<Utc>) {
        self.update(thread_id, |thread| {
            if thread.interacted_at == Some(time) {
                return false;
            }
            thread.interacted_at = Some(time);
            true
        });
    }

    /// The project's worktrees changed. Archived threads are skipped: the
    /// worktree they reference may already be gone (`:812-841`).
    pub fn update_worktree_paths(&self, thread_ids: &[ThreadId], worktree_paths: WorktreePaths) {
        let mut changed = false;
        for &thread_id in thread_ids {
            changed |= self.update_silently(thread_id, |thread| {
                if thread.archived || thread.worktree_paths == worktree_paths {
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
    ///
    /// Archived threads are skipped for the same reason as
    /// [`ThreadMetadataStore::update_worktree_paths`]: their paths are a record
    /// of where the thread lived, not a reading of the current project. Zed
    /// asserts this case away in debug builds (`:790-793`); refusing it outright
    /// is the same rule without a release-build hole.
    pub fn update_working_directories(&self, thread_id: ThreadId, work_dirs: PathList) {
        self.update(thread_id, |thread| {
            if thread.archived {
                return false;
            }
            thread.worktree_paths = WorktreePaths::from_path_lists(
                thread.main_worktree_paths().clone(),
                work_dirs.clone(),
            )
            .unwrap_or_else(|_| WorktreePaths::from_folder_paths(&work_dirs));
            true
        });
    }

    /// Take the thread out of the active sidebar, keeping it in history.
    pub fn archive(&self, thread_id: ThreadId) {
        if self.set_archived(thread_id, true) {
            self.notify(ThreadStoreEvent::ThreadArchived(thread_id));
            self.notify(ThreadStoreEvent::Changed);
        }
    }

    /// Put it back. Opening an archived thread does this (`agent_panel.rs:4382-4386`).
    pub fn unarchive(&self, thread_id: ThreadId) {
        if self.set_archived(thread_id, false) {
            self.notify(ThreadStoreEvent::Changed);
        }
    }

    fn set_archived(&self, thread_id: ThreadId, archived: bool) -> bool {
        self.update_silently(thread_id, |thread| {
            if thread.archived == archived {
                return false;
            }
            thread.archived = archived;
            true
        })
    }

    /// Remove the row. Local only — asking the agent to forget its session is
    /// a separate, capability-gated step the caller makes.
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
    fn update(&self, thread_id: ThreadId, mutate: impl FnOnce(&mut ThreadMetadata) -> bool) -> bool {
        let changed = self.update_silently(thread_id, mutate);
        if changed {
            self.notify(ThreadStoreEvent::Changed);
        }
        changed
    }

    fn update_silently(
        &self,
        thread_id: ThreadId,
        mutate: impl FnOnce(&mut ThreadMetadata) -> bool,
    ) -> bool {
        let Some(mut thread) = self.thread(thread_id) else {
            return false;
        };
        if !mutate(&mut thread) {
            return false;
        }
        self.save_internal(thread);
        true
    }

    /// Insert or replace one row wholesale, announcing the change.
    fn save(&self, metadata: ThreadMetadata) {
        self.save_internal(metadata);
        self.notify(ThreadStoreEvent::Changed);
    }

    fn save_internal(&self, metadata: ThreadMetadata) {
        write(&self.inner.cache).insert(metadata.clone());
        self.enqueue(DbOperation::Upsert(Box::new(metadata)));
    }

    fn delete_internal(&self, thread_id: ThreadId) -> bool {
        if write(&self.inner.cache).remove(thread_id).is_none() {
            return false;
        }
        self.enqueue(DbOperation::Delete(thread_id));
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
/// thread, in no particular order across threads. Zed's `dedup_db_operations`
/// (`:1254-1263`).
fn dedup_operations(operations: Vec<DbOperation>) -> Vec<DbOperation> {
    let mut seen: HashMap<ThreadId, DbOperation> = HashMap::new();
    for operation in operations.into_iter().rev() {
        seen.entry(operation.thread_id()).or_insert(operation);
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
                remove_from(&mut self.by_paths, previous.folder_paths(), metadata.thread_id);
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
            errors.extend(failures.into_iter().map(|message| (counts.drained, message)));
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

/// When a thread started, for the history view's ordering: Zed falls back to
/// `updated_at` for rows written before `created_at` existed
/// (`threads_archive_view.rs:289`).
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
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn read<T>(lock: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(PoisonError::into_inner)
}

fn write<T>(lock: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    lock.write().unwrap_or_else(PoisonError::into_inner)
}
