//! `memory_indexer` — the decoupled background indexing infrastructure (Step 4).
//!
//! Two pieces live here, both in the Tauri app layer (never in `atlas-memory`,
//! which stays Tauri-free):
//!
//! - [`MemoryRegistry`] — a `cwd → Arc<RwLock<MemoryEngine>>` map stored as a
//!   Tauri managed `State`. It is the **single owner** of each project's engine:
//!   the retrieve closure (Step 6, read lock) and the indexer (write lock) both
//!   reach the right engine through it. Opening a project for the first time
//!   loads its persisted index, starts an FS watcher, and enqueues an initial
//!   cold [`Job::IndexCorpus`].
//! - [`MemoryIndexer`] — one owned Tokio task draining a **bounded** `mpsc` queue.
//!   Every [`Job`] carries a `cwd` so projects stay isolated: corpus indexing,
//!   the extractor's passes (turn finished and session end, see
//!   `super::memory_extract`), and global promotion (`Compact`).
//!
//! Heavy work (corpus gather + embed + persist) runs off the IPC thread on the
//! async runtime / blocking pool; the FS watcher coalesces bursts via a ~2s
//! debounce into a single `IndexCorpus` per project.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use atlas_memory::{CorpusDoc, MemoryEngine, MiniLmProvider};
use dashmap::DashMap;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;
use tokio::sync::RwLock;

use super::agent_memory::{collect_corpus, MemoryDoc};
use super::memory_graph::{model_dir, MODEL_FILES};

/// Bound on the indexer's job queue — back-pressure so HNSW persistence never
/// races a flood of enqueues; excess `try_send`s are dropped (a later watcher
/// tick or `force_reindex` re-enqueues).
pub const QUEUE_CAPACITY: usize = 256;

/// Debounce window: FS events within this window collapse into one `IndexCorpus`.
const DEBOUNCE_WINDOW: Duration = Duration::from_millis(2000);

/// A unit of background indexing work. **Every variant carries `cwd`** so the
/// worker looks up exactly one project's engine and never touches another's.
#[derive(Debug, Clone)]
pub enum Job {
    /// (Re)index a project's whole corpus into its HNSW store. Step 4.
    IndexCorpus { cwd: String },
    /// A turn finished: the extractor's gated pass over the session's
    /// conversation so far (read when the turn finished).
    ExtractSession {
        cwd: String,
        writer: super::shared_memory::Writer,
        turns: Vec<atlas_memory::TranscriptTurn>,
    },
    /// A session ended: the extractor's one end-of-session pass.
    SessionEnded {
        cwd: String,
        writer: super::shared_memory::Writer,
    },
    /// A session that is not live here may never have had its end pass (the
    /// app quit before it finished): one over its persisted conversation,
    /// a no-op when nothing is new since its last pass. Queued by the health
    /// pass ([`super::memory_extract::Extractor::catch_up`]).
    CatchUpExtraction {
        cwd: String,
        writer: super::shared_memory::Writer,
    },
    /// Offer the repository's high-confidence Facts to global memory
    /// (`atlas_memory::global`): run once when a project opens and after an
    /// extractor pass stores entries.
    Compact { cwd: String },
    /// Check every memory invariant for `cwd` and repair what can be rebuilt
    /// (M2): on open, every 30 minutes, and after a model switch.
    Health { cwd: String },
    /// Demote what `session` wrote in turns the agent took back (M4),
    /// matched by time to the session recorder's turns. `retried`: already
    /// re-queued once because the recorder had not marked the turn yet.
    RewoundCheck {
        cwd: String,
        session: String,
        retried: bool,
    },
    /// The daily dream pass for `cwd` (M4), if it is due: a model call, so
    /// it runs on the extraction lane.
    Dream { cwd: String },
}

/// What the last reconciler pass for a project found and did, for the
/// Memory panel (`memory_health_status`).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthStatus {
    pub checked_at: i64,
    pub record: atlas_memory::health::Report,
    pub corpus: atlas_memory::CorpusHealth,
    /// `(when, from a snapshot)` when an open restored a damaged record.
    pub restored: Option<(i64, bool)>,
    /// Memories this pass archived as unused (M3 expiry).
    pub archived: usize,
    /// Contradicting pairs this pass newly linked (M4 consolidation).
    pub linked: usize,
}

/// The Tauri event a finished health pass emits: `{ "cwd": string }`. The
/// panel re-reads `memory_health_status` on it.
pub const MEMORY_HEALTH_EVENT: &str = "atlas:memory-health";

/// `cwd`-keyed owner of every open project's [`MemoryEngine`] plus its FS watcher.
/// Stored as a Tauri managed `State<Arc<MemoryRegistry>>`.
pub struct MemoryRegistry {
    /// One engine per project root, shared (read by retrieve, written by indexer).
    engines: DashMap<String, Arc<RwLock<MemoryEngine>>>,
    /// Keep each project's `notify` watcher alive (dropping it stops watching).
    watchers: DashMap<String, notify::RecommendedWatcher>,
    /// Producer end of the indexer's bounded queue.
    job_tx: mpsc::Sender<Job>,
    /// Debounce coalesce window (overridable in tests).
    debounce_window: Duration,
    /// The shared on-device MiniLM provider, loaded **once** and reused by BOTH
    /// the indexer (write path) and retrieve (read path) so the model never loads
    /// twice. `None` until the first successful load; a failed load (model not yet
    /// downloaded) leaves it `None` so a later call retries.
    provider: tokio::sync::Mutex<Option<Arc<MiniLmProvider>>>,
    /// Jobs that did not fit the queue, retried by the worker after its next
    /// job instead of being lost.
    overflow: parking_lot::Mutex<Vec<Job>>,
    /// The last health pass per project.
    health: DashMap<String, HealthStatus>,
    /// When each project's sessions were last scanned for a lost end pass
    /// ([`queue_catch_up`]).
    catch_up_scanned: DashMap<String, std::time::Instant>,
}

impl MemoryRegistry {
    /// Build a registry feeding `job_tx` (the [`MemoryIndexer`] holds the matching
    /// receiver). Uses the default 2s debounce window.
    pub fn new(job_tx: mpsc::Sender<Job>) -> Self {
        Self {
            engines: DashMap::new(),
            watchers: DashMap::new(),
            job_tx,
            debounce_window: DEBOUNCE_WINDOW,
            provider: tokio::sync::Mutex::new(None),
            overflow: parking_lot::Mutex::new(Vec::new()),
            health: DashMap::new(),
            catch_up_scanned: DashMap::new(),
        }
    }

    /// Queue `job`; when the queue is full, remember it for the worker to
    /// retry after its next job. Extraction jobs are logged and dropped
    /// instead: their turns are a snapshot that can't be recomputed later,
    /// and the session's end pass still covers them.
    fn send_or_remember(&self, job: Job) {
        use tokio::sync::mpsc::error::TrySendError;
        match self.job_tx.try_send(job) {
            Ok(()) => {}
            Err(TrySendError::Full(job)) => match job {
                Job::ExtractSession { .. }
                | Job::SessionEnded { .. }
                | Job::CatchUpExtraction { .. } => {
                    tracing::warn!(
                        target: "atlas::memory_indexer",
                        "extraction job dropped: queue full"
                    );
                }
                other => {
                    tracing::warn!(
                        target: "atlas::memory_indexer",
                        "queue full; {other:?} kept for retry"
                    );
                    self.overflow.lock().push(other);
                }
            },
            Err(TrySendError::Closed(_)) => {}
        }
    }

    /// The jobs that did not fit, once (the worker re-queues them).
    pub fn take_overflow(&self) -> Vec<Job> {
        std::mem::take(&mut *self.overflow.lock())
    }

    /// Every project with an open engine.
    pub fn open_cwds(&self) -> Vec<String> {
        let mut out: Vec<String> = self.engines.iter().map(|e| e.key().clone()).collect();
        out.sort();
        out
    }

    /// The last health pass for `cwd`, if one ran.
    pub fn health_status(&self, cwd: &str) -> Option<HealthStatus> {
        self.health.get(cwd).map(|h| h.clone())
    }

    /// The shared [`MiniLmProvider`], loaded lazily on first use and cached. Both
    /// the indexer's `IndexCorpus` worker and the retrieve path (Step 6) call this
    /// so the MiniLM model is only ever loaded once per app. Returns `None` (with a
    /// log inside [`load_provider`]) when the model isn't downloaded yet — the next
    /// call retries.
    #[expect(
        clippy::await_holding_invalid_type,
        reason = "double-checked lazy load: the guard must span load_provider so the model loads once"
    )]
    pub async fn provider(&self, app: &AppHandle) -> Option<Arc<MiniLmProvider>> {
        let mut guard = self.provider.lock().await;
        if let Some(p) = guard.as_ref() {
            return Some(p.clone());
        }
        let loaded = load_provider(app).await?;
        *guard = Some(loaded.clone());
        Some(loaded)
    }

    /// The provider if it is already loaded, without waiting or loading.
    pub fn loaded_provider(&self) -> Option<Arc<MiniLmProvider>> {
        self.provider.try_lock().ok().and_then(|p| p.clone())
    }

    /// Drop the cached embedding provider so the next [`provider`](Self::provider)
    /// call reloads from disk. Called when the user selects a different embedding
    /// model (its dir / dim / vector space changed).
    pub async fn invalidate_provider(&self) {
        *self.provider.lock().await = None;
    }

    /// Test hook: a registry with a custom debounce window.
    #[cfg(test)]
    fn with_window(job_tx: mpsc::Sender<Job>, window: Duration) -> Self {
        let mut r = Self::new(job_tx);
        r.debounce_window = window;
        r
    }

    /// Open-or-return the engine for `cwd`. On the **first** open it starts the FS
    /// watcher, and enqueues an initial cold `IndexCorpus{cwd}` — so a freshly
    /// opened project is indexed even before the watcher fires. Subsequent calls
    /// just clone the existing handle (no re-enqueue, no second watcher).
    pub fn engine_for(&self, cwd: &str) -> Arc<RwLock<MemoryEngine>> {
        if let Some(existing) = self.engines.get(cwd) {
            return existing.value().clone();
        }

        // Build outside the map so the shard lock isn't held across the index
        // load I/O. A lost race is harmless: `or_insert_with` keeps whoever
        // won and `ptr_eq` tells us if *we* were the inserter.
        let fresh = Arc::new(RwLock::new(MemoryEngine::open(PathBuf::from(cwd))));
        let inserted = self
            .engines
            .entry(cwd.to_string())
            .or_insert_with(|| fresh.clone())
            .value()
            .clone();

        if Arc::ptr_eq(&inserted, &fresh) {
            self.start_watcher(cwd);
            // Cold index on open, one global-promotion pass (it only reads the
            // record's Facts and the small global ledger), then a health pass.
            // A full queue keeps them for retry.
            self.send_or_remember(Job::IndexCorpus {
                cwd: cwd.to_string(),
            });
            self.send_or_remember(Job::Compact {
                cwd: cwd.to_string(),
            });
            self.send_or_remember(Job::Health {
                cwd: cwd.to_string(),
            });
        }
        inserted
    }

    /// Enqueue a job (non-blocking). A full queue keeps the job for retry
    /// (extraction jobs are dropped with a warning) rather than stalling the
    /// caller — the IPC thread must never block on indexing. `Err` only when
    /// the indexer has stopped.
    pub fn enqueue(&self, job: Job) -> Result<(), String> {
        if self.job_tx.is_closed() {
            return Err("indexer queue: closed".into());
        }
        self.send_or_remember(job);
        Ok(())
    }

    /// Fire-and-forget background reindex nudge for `cwd` (Step 5). Designed to
    /// be called from the hot `TauriDeltaSink::emit` path on `TurnFinished`: it
    /// **never blocks and never `.await`s**. A full queue is dropped with a
    /// `debug` log (a later FS-watcher tick or `force_reindex` re-enqueues);
    /// a closed queue (app shutting down) is likewise a silent drop.
    pub fn enqueue_index(&self, cwd: &str) {
        self.send_or_remember(Job::IndexCorpus {
            cwd: cwd.to_string(),
        });
    }

    /// Queue one `IndexCorpus` pass for `cwd`, the pass that embeds the whole
    /// corpus. If the project's engine is not open yet, opening it queues its
    /// own cold pass, so this never queues two. Non-blocking, like
    /// [`enqueue_index`](Self::enqueue_index).
    pub fn request_reindex(&self, cwd: &str) {
        if self.open_engine(cwd).is_some() {
            self.enqueue_index(cwd);
        } else {
            let _ = self.engine_for(cwd);
        }
    }

    /// Get-only lookup: the engine if this project is currently open, `None`
    /// otherwise. Background jobs (index/promotion) use this instead of
    /// [`engine_for`](Self::engine_for) so a stale queued job for a closed
    /// project skips instead of resurrecting the engine + watcher.
    pub fn open_engine(&self, cwd: &str) -> Option<Arc<RwLock<MemoryEngine>>> {
        self.engines.get(cwd).map(|e| e.value().clone())
    }

    /// Release everything held for `cwd`: dropping the watcher stops the OS watch
    /// and drops the callback's `sig_tx`, which ends the debounce task; dropping
    /// the engine frees its in-RAM HNSW/docstore. No persist needed — the indexer
    /// persists at the end of every `IndexCorpus` pass, so the on-disk state is
    /// already current. Reopening the project re-runs `engine_for` from scratch.
    pub fn close_project(&self, cwd: &str) {
        self.watchers.remove(cwd);
        self.engines.remove(cwd);
    }

    /// Start one `notify` watcher for `cwd`'s corpus roots, filtering to
    /// corpus-relevant paths and coalescing bursts into a single
    /// `IndexCorpus{cwd}` via [`debounce_loop`].
    ///
    /// SCOPED, not a recursive watch of the whole cwd — that was the same
    /// class of mistake the fileindex watcher already paid for (its unscoped
    /// recursive root watch covered ~350k paths of target/ + node_modules).
    /// Here the damage was smaller (raw watcher, no per-event stat storm) but
    /// still real: every `cargo build`/`npm install` woke the callback
    /// repo-wide, and the thousands of README/CHANGELOG `.md` files under
    /// node_modules passed `is_corpus_path` and enqueued spurious IndexCorpus
    /// jobs for the duration of a build. Worse, the watch was misaimed: most
    /// of the corpus lives in `~/.claude/projects/<cwd>/memory`, which the
    /// cwd watch never saw at all. `collect_corpus` reads exactly:
    ///  - `~/.claude/projects/<encoded>/memory/*.md` → watched recursively,
    ///  - `<cwd>/CLAUDE.md` + `<cwd>/AGENTS.md` → cwd watched NON-recursively,
    ///  - Codex sqlite under `~/.codex` → not watchable meaningfully (WAL
    ///    churn); its content rides the debounced reindexes above.
    fn start_watcher(&self, cwd: &str) {
        // Lightweight "something changed" signals from the (sync) notify callback
        // into the async debounce task.
        let (sig_tx, sig_rx) = mpsc::channel::<()>(64);

        tauri::async_runtime::spawn(debounce_loop(
            sig_rx,
            self.job_tx.clone(),
            cwd.to_string(),
            self.debounce_window,
        ));

        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                if event.paths.iter().any(|p| is_corpus_path(p)) {
                    // Non-blocking; a dropped signal just means the debounce already
                    // has a pending tick.
                    let _ = sig_tx.try_send(());
                }
            }
        });

        match watcher {
            Ok(mut w) => {
                use notify::Watcher;
                let mut watched_any = false;

                // Project root, NON-recursive: only CLAUDE.md / AGENTS.md at
                // the top level are corpus.
                match w.watch(Path::new(cwd), notify::RecursiveMode::NonRecursive) {
                    Ok(()) => watched_any = true,
                    Err(e) => {
                        tracing::warn!(target: "atlas::memory_indexer", "watch {cwd} failed: {e}");
                    }
                }

                // The Claude memory dir — the bulk of the corpus. Created
                // eagerly so the watch can attach before the first memory is
                // ever written.
                let mem_dir = super::agent_memory::claude_memory_dir(cwd);
                let _ = std::fs::create_dir_all(&mem_dir);
                match w.watch(&mem_dir, notify::RecursiveMode::Recursive) {
                    Ok(()) => watched_any = true,
                    Err(e) => {
                        tracing::warn!(
                            target: "atlas::memory_indexer",
                            "watch {} failed: {e}", mem_dir.display()
                        );
                    }
                }

                if watched_any {
                    self.watchers.insert(cwd.to_string(), w);
                }
            }
            Err(e) => {
                tracing::warn!(target: "atlas::memory_indexer", "watcher init failed for {cwd}: {e}");
            }
        }
    }
}

/// True for paths the corpus is built from: any `*.md`, `CLAUDE.md` and
/// `AGENTS.md`. Dependency/build trees
/// are rejected outright — the scoped roots in `start_watcher` shouldn't
/// deliver them, but a top-level rename can surface such paths in an event
/// batch, and node_modules is full of README/CHANGELOG `.md` files that would
/// otherwise trigger a pointless reindex.
fn is_corpus_path(path: &Path) -> bool {
    if path.components().any(|c| {
        matches!(
            c.as_os_str().to_str(),
            Some("node_modules") | Some("target") | Some(".git")
        )
    }) {
        return false;
    }
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name == "CLAUDE.md" || name == "AGENTS.md" {
        return true;
    }
    if path.extension().and_then(|e| e.to_str()) == Some("md") {
        return true;
    }
    false
}

/// Coalesce a stream of FS signals into one `IndexCorpus{cwd}` per quiet window.
/// Waits for the first signal, then keeps resetting until no signal arrives for
/// `window`, then enqueues exactly one job. N rapid events → 1 job.
async fn debounce_loop(
    mut sig_rx: mpsc::Receiver<()>,
    job_tx: mpsc::Sender<Job>,
    cwd: String,
    window: Duration,
) {
    loop {
        // Block until the first event of a burst (or channel close → exit).
        if sig_rx.recv().await.is_none() {
            return;
        }
        // Drain follow-up events until it's been quiet for `window`.
        let mut channel_closed = false;
        loop {
            match tokio::time::timeout(window, sig_rx.recv()).await {
                Ok(Some(())) => continue, // more activity, keep coalescing
                Ok(None) => {
                    channel_closed = true; // channel closed → flush a final job, then exit
                    break;
                }
                Err(_) => break, // quiet for `window` → flush
            }
        }
        let _ = job_tx.try_send(Job::IndexCorpus { cwd: cwd.clone() });
        if channel_closed {
            return;
        }
    }
}

/// The single background indexer task. Owns the queue receiver and the lazily
/// loaded [`MiniLmProvider`] (loaded ONCE, on the first `IndexCorpus` that finds
/// the model installed).
pub struct MemoryIndexer;

impl MemoryIndexer {
    /// Drain the queue forever. Spawned once from `lib.rs` with the matching
    /// receiver; returns only when every `job_tx` is dropped (app shutdown).
    pub async fn run(app: AppHandle, registry: Arc<MemoryRegistry>, mut rx: mpsc::Receiver<Job>) {
        let lanes = Lanes::spawn(|job| {
            tauri::async_runtime::spawn(job);
        });
        while let Some(job) = rx.recv().await {
            let extraction = matches!(
                job,
                Job::ExtractSession { .. }
                    | Job::SessionEnded { .. }
                    | Job::CatchUpExtraction { .. }
                    | Job::Dream { .. }
            );
            let (app, registry_for_job) = (app.clone(), registry.clone());
            let work: Work = Box::pin(async move { handle(&app, &registry_for_job, job).await });
            if extraction {
                lanes.extract(work);
            } else {
                lanes.index(work);
            }
            for retry in registry.take_overflow() {
                registry.send_or_remember(retry);
            }
        }
    }
}

/// One queued job's work.
type Work = futures::future::BoxFuture<'static, ()>;

/// The indexer's two lanes: index, promotion and health jobs on one,
/// extraction (model calls, up to 60 s) on another, so neither waits on the
/// other. Each lane runs its jobs in order.
struct Lanes {
    index: mpsc::UnboundedSender<Work>,
    extract: mpsc::UnboundedSender<Work>,
}

impl Lanes {
    /// Two lanes, each a task `spawn` starts that runs its jobs in order.
    fn spawn(spawn: impl Fn(futures::future::BoxFuture<'static, ()>)) -> Self {
        let lane = || {
            let (tx, mut rx) = mpsc::unbounded_channel::<Work>();
            spawn(Box::pin(async move {
                while let Some(job) = rx.recv().await {
                    job.await;
                }
            }));
            tx
        };
        Self {
            index: lane(),
            extract: lane(),
        }
    }

    fn index(&self, work: Work) {
        let _ = self.index.send(work);
    }

    fn extract(&self, work: Work) {
        let _ = self.extract.send(work);
    }
}

/// Run one job.
async fn handle(app: &AppHandle, registry: &MemoryRegistry, job: Job) {
    match job {
        Job::IndexCorpus { cwd } => {
            // Shared provider — loaded once, reused by retrieve too.
            let Some(prov) = registry.provider(app).await else {
                tracing::warn!(
                    target: "atlas::memory_indexer",
                    "IndexCorpus {cwd}: MiniLM model not downloaded; skipping"
                );
                return;
            };
            if let Err(e) = index_one(registry, &cwd, &prov).await {
                tracing::warn!(target: "atlas::memory_indexer", "IndexCorpus {cwd} failed: {e}");
            }
            // The health pass scans at open; a long-running app scans again
            // at most every CATCH_UP_RESCAN on the index nudges every
            // finished turn and file change sends.
            let due = registry
                .catch_up_scanned
                .get(&cwd)
                .is_none_or(|at| at.elapsed() >= CATCH_UP_RESCAN);
            if due {
                queue_catch_up(app, registry, &cwd, chrono::Utc::now().timestamp_millis()).await;
            }
        }
        Job::ExtractSession { cwd, writer, turns } => {
            extract(app, registry, &cwd, writer, Some(turns)).await;
        }
        Job::SessionEnded { cwd, writer } => {
            extract(app, registry, &cwd, writer, None).await;
        }
        Job::CatchUpExtraction { cwd, writer } => {
            catch_up(app, registry, &cwd, writer).await;
        }
        Job::Compact { cwd } => {
            if let Err(e) = compact_one(registry, &cwd).await {
                tracing::warn!(target: "atlas::memory_indexer", "Compact {cwd} failed: {e}");
            }
        }
        Job::Health { cwd } => {
            if let Err(e) = health_one(app, registry, &cwd).await {
                tracing::warn!(target: "atlas::memory_indexer", "Health {cwd} failed: {e}");
            }
        }
        Job::Dream { cwd } => {
            let now = chrono::Utc::now().timestamp_millis();
            match super::memory_dream::dream_if_due(app, &cwd, now).await {
                Ok(Some(id)) => {
                    tracing::info!(target: "atlas::memory_indexer", "dream {id} for {cwd}");
                }
                Ok(None) => {}
                Err(e) => tracing::warn!(target: "atlas::memory_indexer", "Dream {cwd}: {e}"),
            }
        }
        Job::RewoundCheck {
            cwd,
            session,
            retried,
        } => {
            rewound_check(app, vec![(cwd.clone(), session.clone())]).await;
            // The recorder marks the turn on its own worker and may not have
            // yet, even when an earlier turn of the session was rewound
            // already: look once more. Demoting is idempotent.
            if !retried {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    if let Some(registry) = app.try_state::<Arc<MemoryRegistry>>() {
                        let _ = registry.enqueue(Job::RewoundCheck {
                            cwd,
                            session,
                            retried: true,
                        });
                    }
                });
            }
        }
    }
}

/// The session recorder, read-only, as memory reads it: the launch
/// directory, the repository's worktrees and the transcripts directory.
fn capture_reader(app: &AppHandle) -> super::memory_capture::CaptureReader {
    super::memory_capture::CaptureReader {
        transcripts_dir: app
            .try_state::<Arc<super::agent_transcript::TranscriptState>>()
            .map(|t| t.config_dir().to_path_buf()),
    }
}

/// Run the rewound-turn check for each `(cwd, session)`.
async fn rewound_check(app: &AppHandle, sessions: Vec<(String, String)>) {
    let Some(memory) = app
        .try_state::<super::shared_memory::SharedMemoryStore>()
        .map(|m| m.inner().clone())
    else {
        return;
    };
    let reader = capture_reader(app);
    let _ = tokio::task::spawn_blocking(move || {
        for (cwd, session) in sessions {
            let now = memory.now();
            let Some(windows) =
                super::memory_capture::rewound_windows_for(&reader, &cwd, &session, now)
            else {
                continue;
            };
            if windows.is_empty() {
                continue;
            }
            if let Err(e) = memory.demote_rewound(&cwd, &session, &windows) {
                tracing::warn!(target: "atlas::memory_indexer", "rewound check failed: {e}");
            }
        }
    })
    .await;
}

/// One reconciler pass for `cwd`: the record (check → repair → snapshot) and
/// the corpus (vector file, FTS). Stored for the panel and announced.
async fn health_one(app: &AppHandle, registry: &MemoryRegistry, cwd: &str) -> Result<(), String> {
    let Some(engine) = registry.open_engine(cwd) else {
        return Ok(());
    };
    // The vector backfill (VectorsMissing) runs only with the model loaded,
    // and a model switch has just dropped it. A no-op when not downloaded.
    let _ = registry.provider(app).await;
    let now = chrono::Utc::now().timestamp_millis();
    let owned = cwd.to_string();
    let code = app
        .try_state::<Arc<super::code_index::CodeIndexRegistry>>()
        .map(|r| r.inner().clone());
    let (record, restored, archived, linked) = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let store = super::shared_memory::store_for(&owned)?;
        let report = store.heal(now).map_err(|e| format!("{e:#}"))?;
        if let Err(e) = store.snapshot_if_due(now) {
            tracing::warn!(target: "atlas::memory_indexer", "memory snapshot failed: {e:#}");
        }
        // Unused candidates, and unused memories whose cited code changed,
        // leave for the archive. Cited code is read through the code index
        // when one is open, so a symbol that only moved still holds.
        let resolver = match &code {
            Some(registry) => {
                super::code_index::citations::CodeIndexResolver::for_scope(registry, store.root())
            }
            None => super::code_index::citations::CodeIndexResolver::with_index(store.root(), None),
        };
        let archived = store.expire(now, &resolver).unwrap_or_else(|e| {
            tracing::warn!(target: "atlas::memory_indexer", "memory expiry failed: {e:#}");
            0
        });
        // Contradictions become links every reader sees; nothing is merged.
        let linked = atlas_memory::consolidate::link_contradictions(&store, now).unwrap_or_else(|e| {
            tracing::warn!(target: "atlas::memory_indexer", "memory consolidation failed: {e:#}");
            0
        });
        Ok((
            report,
            atlas_memory::record::RecordStore::restored_marker(store.root()),
            archived,
            linked,
        ))
    })
    .await
    .map_err(|e| e.to_string())??;
    // Sessions of the last day: what they wrote in turns they took back.
    let owned = cwd.to_string();
    let recent = tokio::task::spawn_blocking(move || {
        super::shared_memory::store_for(&owned)
            .ok()
            .and_then(|s| s.sessions_since(now - 24 * 3600 * 1000, 50).ok())
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default();
    rewound_check(
        app,
        recent.into_iter().map(|s| (cwd.to_string(), s)).collect(),
    )
    .await;
    // Recent sessions that are not live here: an end pass that never ran.
    queue_catch_up(app, registry, cwd, now).await;
    // The Agent Memory Repo mirror, when the user turned it on: rewritten
    // and committed only when memory changed.
    let mirror = app
        .try_state::<crate::state::AtlasConfigHandle>()
        .is_some_and(|config| config.lock().effective().memory_repo_mirror);
    if let (true, Some(home)) = (mirror, dirs::home_dir()) {
        let owned = cwd.to_string();
        let refreshed = tokio::task::spawn_blocking(move || {
            let store = super::shared_memory::store_for(&owned)?;
            super::memory_repo::refresh_mirror(&home, &store)
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r);
        if let Err(e) = refreshed {
            tracing::warn!(target: "atlas::memory_indexer", "memory mirror not refreshed: {e}");
        }
    }
    // The daily dream, when the user turned it on; it decides itself
    // whether it is due.
    let dreams = app
        .try_state::<crate::state::AtlasConfigHandle>()
        .is_some_and(|config| config.lock().effective().memory_dreams);
    if dreams {
        registry.send_or_remember(Job::Dream {
            cwd: cwd.to_string(),
        });
    }
    let corpus = engine.write().await.heal().map_err(|e| format!("{e:#}"))?;
    if !record.repaired.is_empty() || corpus != atlas_memory::CorpusHealth::default() {
        tracing::info!(
            target: "atlas::memory_indexer",
            "health {cwd}: repaired {:?}, corpus {corpus:?}",
            record.repaired
        );
    }
    // The marker is read once; the restore stays reported while the app runs.
    let restored = restored.or_else(|| registry.health_status(cwd).and_then(|h| h.restored));
    registry.health.insert(
        cwd.to_string(),
        HealthStatus {
            checked_at: now,
            record,
            corpus,
            restored,
            archived,
            linked,
        },
    );
    let _ = app.emit(MEMORY_HEALTH_EVENT, serde_json::json!({ "cwd": cwd }));
    Ok(())
}

/// The last reconciler pass for a project (`null` before the first).
#[tauri::command]
pub fn memory_health_status(
    project_path: String,
    registry: State<'_, Arc<MemoryRegistry>>,
) -> Option<HealthStatus> {
    registry.health_status(&project_path)
}

/// Gather the corpus for `cwd`, diff+embed it into that project's engine under
/// the **write lock**, and persist. Reuses `agent_memory::collect_corpus` so the
/// indexer sees exactly what the old build path saw.
#[expect(
    clippy::await_holding_invalid_type,
    reason = "the write lock must span index_corpus: reset + re-embed + persist is one atomic pass"
)]
async fn index_one(
    registry: &MemoryRegistry,
    cwd: &str,
    provider: &MiniLmProvider,
) -> Result<(), String> {
    // Get-only: a job that outlived its project's close is a skip, not a
    // resurrection (engine_for here would re-open the engine AND restart the
    // watcher). Never-opened projects get their cold index at first memory use
    // (engine_for enqueues one on open).
    let Some(engine) = registry.open_engine(cwd) else {
        return Ok(());
    };
    let corpus = collect_corpus(cwd).await;
    let docs: Vec<CorpusDoc> = corpus.iter().map(to_corpus_doc).collect();

    let mut guard = engine.write().await;
    // If the selected embedding model changed since this project was last indexed
    // (different model id or dim), wipe + rebuild — old vectors live in a different
    // space and can't be mixed with the new model's.
    if !guard.index_params_match(provider) {
        guard
            .reset_index(provider.provider_name(), provider.dim())
            .map_err(|e| e.to_string())?;
    }
    let stats = guard
        .index_corpus(&docs, provider)
        .await
        .map_err(|e| e.to_string())?;
    drop(guard);

    tracing::info!(
        target: "atlas::memory_indexer",
        "indexed {cwd}: +{} ~{} -{} ={}",
        stats.added, stats.updated, stats.deleted, stats.unchanged
    );
    // Memories written while no model was loaded have no vector yet; the
    // model is loaded now, so embed them (off the async runtime).
    let cwd_owned = cwd.to_string();
    let _ = tokio::task::spawn_blocking(move || {
        if let Ok(store) = super::shared_memory::store_for(&cwd_owned) {
            match store.sync_vectors() {
                Ok(n) if n > 0 => tracing::info!(
                    target: "atlas::memory_indexer",
                    "embedded {n} memories missing a vector"
                ),
                Ok(_) => {}
                Err(e) => tracing::warn!(
                    target: "atlas::memory_indexer",
                    "memory vector backfill failed: {e:#}"
                ),
            }
        }
    })
    .await;
    Ok(())
}

/// Global promotion for `cwd`'s repository, off the hot path: its Facts at
/// confidence ≥ 0.8 are recorded in the global candidates ledger, and any seen
/// in two or more repositories are promoted to `~/.atlas/memory`
/// (`atlas_memory::global`). Idempotent, so running it on every open and after
/// every storing extraction is safe.
async fn compact_one(registry: &MemoryRegistry, cwd: &str) -> Result<(), String> {
    // Get-only for the same reason as `index_one`: don't resurrect a closed
    // project. Its promotion runs again next open.
    if registry.open_engine(cwd).is_none() {
        return Ok(());
    }
    let cwd = cwd.to_string();
    let promoted = tokio::task::spawn_blocking(move || -> Result<usize, String> {
        let store = super::shared_memory::store_for(&cwd)?;
        atlas_memory::promote_facts(&store).map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())??;
    if promoted > 0 {
        tracing::info!(target: "atlas::memory_indexer", "promoted {promoted} facts to global memory");
    }
    Ok(())
}

/// One extractor pass (`super::memory_extract`): a finished turn's gated one
/// (`turns` = the session's conversation so far) or the session's end one
/// (`turns` = `None`). Recorded entries are made searchable by a reindex.
async fn extract(
    app: &AppHandle,
    registry: &MemoryRegistry,
    cwd: &str,
    writer: super::shared_memory::Writer,
    turns: Option<Vec<atlas_memory::TranscriptTurn>>,
) {
    let Some(extractor) = app.try_state::<Arc<super::memory_extract::Extractor>>() else {
        return;
    };
    let sharing = app.state::<super::memory_sharing::MemorySharingState>();
    let stored = match turns {
        Some(turns) => extractor.turn_finished(&sharing, cwd, &writer, turns).await,
        None => {
            let held = extractor.holds_turns(&writer.session_id);
            let stored = extractor.session_ended(&sharing, cwd, &writer).await;
            if held {
                stored
            } else {
                // No turn of it finished in this process (it was resumed and
                // closed, or its turns ran before a restart): the end pass
                // reads what Atlas persisted instead.
                return catch_up(app, registry, cwd, writer).await;
            }
        }
    };
    reindex_after(registry, cwd, stored);
}

/// How often a project's sessions are scanned for a lost end pass while the
/// app runs (besides the scan at open).
const CATCH_UP_RESCAN: Duration = Duration::from_secs(30 * 60);

/// Queue an end pass for every recent session of `cwd` that is not live in
/// this process and may never have had one ([`Job::CatchUpExtraction`]; a
/// no-op for one with nothing new since its last pass).
///
/// Two kinds: sessions Atlas hosted whose end pass died with the process
/// (most sessions end at quit), and sessions Atlas never hosted. The
/// latter are the terminal ones the capture recorder imports off disk, and
/// they are most of the work: without this, nothing they decided or learned
/// reached memory, which grew only from in-app sessions. Reading them sends
/// their conversation to the extraction model, so they are scanned only when
/// the user turned that on (`MemorySharingState::extraction_reach`).
async fn queue_catch_up(app: &AppHandle, registry: &MemoryRegistry, cwd: &str, now: i64) {
    registry
        .catch_up_scanned
        .insert(cwd.to_string(), std::time::Instant::now());
    let Some(extractor) = app
        .try_state::<Arc<super::memory_extract::Extractor>>()
        .map(|e| e.inner().clone())
    else {
        return;
    };
    let reach = app
        .state::<super::memory_sharing::MemorySharingState>()
        .extraction_reach(cwd);
    let (owned, reader) = (cwd.to_string(), capture_reader(app));
    let lost = tokio::task::spawn_blocking(move || {
        let live = |id: &str| extractor.holds_turns(id);
        let recorded = super::memory_extract::recorded_catch_up_sessions(
            &reader.stores(&owned),
            reach,
            now,
            &live,
        );
        let hosted = super::shared_memory::store_for(&owned)
            .map(|store| super::memory_extract::catch_up_sessions(&store, now, &live))
            .unwrap_or_default();
        super::memory_extract::merge_catch_up(recorded, hosted)
    })
    .await
    .unwrap_or_default();
    for writer in lost {
        registry.send_or_remember(Job::CatchUpExtraction {
            cwd: cwd.to_string(),
            writer,
        });
    }
}

/// The end pass of a session whose turns this process does not hold, over
/// its persisted conversation (`memory_extract::persisted_turns`).
async fn catch_up(
    app: &AppHandle,
    registry: &MemoryRegistry,
    cwd: &str,
    writer: super::shared_memory::Writer,
) {
    let Some(extractor) = app.try_state::<Arc<super::memory_extract::Extractor>>() else {
        return;
    };
    let Some(config_dir) = app
        .try_state::<Arc<super::agent_transcript::TranscriptState>>()
        .map(|t| t.config_dir().to_path_buf())
    else {
        return;
    };
    let reader = capture_reader(app);
    // Decided when the pass runs, not when it was queued: a session imported
    // from outside Atlas is not read once the user turned that off.
    let reach = app
        .state::<super::memory_sharing::MemorySharingState>()
        .extraction_reach(cwd);
    let (owned, session) = (cwd.to_string(), writer.session_id.clone());
    let turns = tokio::task::spawn_blocking(move || {
        super::memory_extract::persisted_turns(&config_dir, &owned, &session, &reader, reach)
    })
    .await
    .ok()
    .flatten();
    let Some(turns) = turns else {
        return;
    };
    let sharing = app.state::<super::memory_sharing::MemorySharingState>();
    let stored = extractor.catch_up(&sharing, cwd, &writer, turns).await;
    reindex_after(registry, cwd, stored);
}

/// Make freshly extracted entries searchable in the retrieval index, and offer
/// any new high-confidence Facts to global memory.
fn reindex_after(registry: &MemoryRegistry, cwd: &str, stored: usize) {
    if stored > 0 {
        tracing::info!(target: "atlas::memory_indexer", "extracted {stored} memories; reindexing {cwd}");
        let _ = registry.enqueue(Job::IndexCorpus {
            cwd: cwd.to_string(),
        });
        let _ = registry.enqueue(Job::Compact {
            cwd: cwd.to_string(),
        });
    }
}

/// Text actually embedded for a doc — title prepended for short-doc signal.
/// Memory ▸ Graph embeds through [`to_corpus_doc`] too, so the vectors it hands
/// to the index hash identically and the next index pass skips them.
fn embed_text(doc: &MemoryDoc) -> String {
    if doc.text.trim().is_empty() {
        doc.title.clone()
    } else {
        format!("{}\n\n{}", doc.title, doc.text)
    }
}

/// SHA-256 hex of `s`.
fn hash_text(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    format!("{:x}", h.finalize())
}

/// Map an `agent_memory::MemoryDoc` onto the neutral `atlas_memory::CorpusDoc`.
pub(crate) fn to_corpus_doc(doc: &MemoryDoc) -> CorpusDoc {
    let text = embed_text(doc);
    let content_hash = hash_text(&text);
    CorpusDoc {
        id: doc.id.clone(),
        text,
        content_hash,
        corpus: doc.source.clone(),
    }
}

/// The vectors `cwd`'s retrieval index already holds for `docs`, by doc id —
/// only for docs whose content is unchanged since they were indexed, and none
/// when the index was built with a different embedding model. Memory ▸ Graph
/// and the Policy view reuse these instead of re-embedding.
pub(crate) async fn indexed_vectors(
    registry: &MemoryRegistry,
    provider: &MiniLmProvider,
    cwd: &str,
    docs: &[MemoryDoc],
) -> std::collections::HashMap<String, Vec<f32>> {
    let engine = registry.engine_for(cwd);
    let guard = engine.read().await;
    if !guard.index_params_match(provider) {
        return std::collections::HashMap::new();
    }
    docs.iter()
        .filter_map(|d| {
            let c = to_corpus_doc(d);
            guard
                .cached_vector(&c.id, &c.content_hash)
                .map(|v| (c.id, v))
        })
        .collect()
}

/// The shared-memory record's embedder (near-duplicate merge, search): the
/// on-device model when it is loaded, else no vector — the record then
/// dedups by key and content hash only. Never loads the model inline (a
/// record write must not wait on it); a miss asks for a background load so a
/// later write has it.
pub struct ModelEmbedder {
    app: AppHandle,
    /// A background load is in flight; cleared when it finishes, loaded or
    /// not (the model may not be downloaded yet), so a later miss asks again.
    loading: Arc<std::sync::atomic::AtomicBool>,
}

impl ModelEmbedder {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            loading: Arc::default(),
        }
    }
}

impl atlas_memory::record::Embedder for ModelEmbedder {
    fn embed(&self, text: &str) -> Option<atlas_memory::record::Embedding> {
        use std::sync::atomic::Ordering;
        let registry = self.app.try_state::<Arc<MemoryRegistry>>()?;
        let Some(provider) = registry.loaded_provider() else {
            if !self.loading.swap(true, Ordering::SeqCst) {
                let app = self.app.clone();
                let loading = self.loading.clone();
                tauri::async_runtime::spawn(async move {
                    let registry = app.state::<Arc<MemoryRegistry>>();
                    let _ = registry.provider(&app).await;
                    loading.store(false, Ordering::SeqCst);
                });
            }
            return None;
        };
        let vector = provider.embedder().embed_one(text).ok()?;
        Some(atlas_memory::record::Embedding {
            model: provider.provider_name().to_string(),
            vector,
        })
    }

    /// The loaded model's id: what the record's vector cache is keyed by.
    /// `None` until the model is loaded, so a backfill waits for it.
    fn model_id(&self) -> Option<String> {
        let registry = self.app.try_state::<Arc<MemoryRegistry>>()?;
        registry
            .loaded_provider()
            .map(|p| p.provider_name().to_string())
    }
}

/// Load the on-device MiniLM provider ONCE, reusing `memory_graph`'s model-dir
/// resolution. `None` (with a log) when the model isn't downloaded — the indexer
/// then skips index jobs until it is.
async fn load_provider(app: &AppHandle) -> Option<Arc<MiniLmProvider>> {
    let dir = match model_dir(app) {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!(target: "atlas::memory_indexer", "no model dir: {e}");
            return None;
        }
    };
    if !MODEL_FILES.iter().all(|f| dir.join(f).exists()) {
        return None;
    }
    // Tag the provider with the selected model id so the manifest can detect a
    // model switch (and rebuild the index).
    let model_id = super::models::selected_embedding_id(app);
    // Embedder::load is blocking candle work — keep it off the async runtime.
    let embedder = tokio::task::spawn_blocking(move || atlas_embed::Embedder::load(&dir))
        .await
        .ok()?
        .map_err(|e| tracing::warn!(target: "atlas::memory_indexer", "embedder load failed: {e}"))
        .ok()?;
    Some(Arc::new(MiniLmProvider::new(Arc::new(embedder), model_id)))
}

/// Force a full (re)index of `cwd`'s memory corpus off the hot path. Replaces the
/// old manual "Memory Graph" rebuild trigger. Ensures the engine is open (so a
/// cold project also gets its watcher + initial pass) then enqueues `IndexCorpus`.
#[tauri::command]
pub async fn force_reindex(
    cwd: String,
    registry: State<'_, Arc<MemoryRegistry>>,
) -> Result<(), String> {
    let cwd = cwd.trim_end_matches('/').to_string();
    // Opening also enqueues an initial IndexCorpus on first open; the explicit
    // enqueue below covers the already-open case.
    let _ = registry.engine_for(&cwd);
    registry.enqueue(Job::IndexCorpus { cwd })
}

/// Project-close teardown: release `cwd`'s engine, FS watcher and debounce
/// task. Counterpart of `fileindex_close_project`/`git_watch_stop` — without it
/// every project ever opened kept a recursive FSEvents stream + an in-RAM
/// index for the life of the process.
#[tauri::command]
pub async fn memory_indexer_close_project(
    cwd: String,
    registry: State<'_, Arc<MemoryRegistry>>,
) -> Result<(), String> {
    registry.close_project(cwd.trim_end_matches('/'));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_root(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "atlas-indexer-{}-{}-{}",
            std::process::id(),
            name,
            uuid::Uuid::new_v4()
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn is_corpus_path_matches_md_and_known_files() {
        assert!(is_corpus_path(Path::new("/p/NOTES.md")));
        assert!(is_corpus_path(Path::new("/p/CLAUDE.md")));
        assert!(is_corpus_path(Path::new("/p/sub/AGENTS.md")));
        assert!(!is_corpus_path(Path::new("/p/main.rs")));
        assert!(!is_corpus_path(Path::new("/p/other/docs.json")));
        assert!(!is_corpus_path(Path::new("/p/data.json")));
    }

    /// `enqueue_index` (the hot-path `TurnFinished` nudge) must NEVER block and
    /// must drop gracefully when the queue is full. The queue here has capacity 1
    /// and is never drained, so a blocking send would hang this test forever —
    /// completing at all proves it is non-blocking.
    /// A nudge that doesn't fit the queue is remembered, not lost, and never
    /// blocks: the worker re-queues it after its next job.
    #[test]
    fn a_full_queue_is_remembered_and_retried() {
        let (job_tx, mut job_rx) = mpsc::channel::<Job>(1);
        let registry = MemoryRegistry::with_window(job_tx, Duration::from_millis(50));
        registry.enqueue_index("/proj/a");
        registry.enqueue_index("/proj/b"); // queue full
        assert!(matches!(job_rx.try_recv(), Ok(Job::IndexCorpus { cwd }) if cwd == "/proj/a"));
        let retried: Vec<String> = registry
            .take_overflow()
            .into_iter()
            .filter_map(|j| match j {
                Job::IndexCorpus { cwd } => Some(cwd),
                _ => None,
            })
            .collect();
        assert_eq!(retried, ["/proj/b"]);
        assert!(registry.take_overflow().is_empty(), "taken once");
    }

    /// An extraction job that doesn't fit is dropped with a warning: its
    /// turns are a snapshot, and the session's end pass still covers them.
    #[test]
    fn a_full_queue_drops_an_extraction_job_instead_of_keeping_it() {
        let (job_tx, _job_rx) = mpsc::channel::<Job>(1);
        let registry = MemoryRegistry::with_window(job_tx, Duration::from_millis(50));
        registry.enqueue_index("/proj/a");
        let writer = super::super::shared_memory::Writer {
            agent: "codex".into(),
            session_id: "s".into(),
        };
        registry
            .enqueue(Job::SessionEnded {
                cwd: "/proj/a".into(),
                writer,
            })
            .unwrap();
        assert!(registry.take_overflow().is_empty());
    }

    /// A slow extraction (a gateway call can take 60 s) must not hold up the
    /// index pass queued behind it.
    #[tokio::test]
    async fn extraction_does_not_hold_up_indexing() {
        let lanes = Lanes::spawn(|job| {
            tokio::spawn(job);
        });
        let (tx, mut seen) = mpsc::unbounded_channel::<&'static str>();
        let slow = tx.clone();
        lanes.extract(Box::pin(async move {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let _ = slow.send("extract");
        }));
        lanes.index(Box::pin(async move {
            let _ = tx.send("index");
        }));
        let first = tokio::time::timeout(Duration::from_secs(1), seen.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first, "index");
    }

    #[test]
    fn opening_a_project_queues_a_health_pass_after_promotion() {
        let (job_tx, mut job_rx) = mpsc::channel::<Job>(16);
        let registry = MemoryRegistry::with_window(job_tx, Duration::from_millis(50));
        let root = tmp_root("health-open");
        let cwd = root.to_string_lossy().to_string();
        let _ = registry.engine_for(&cwd);
        assert!(matches!(job_rx.try_recv(), Ok(Job::IndexCorpus { .. })));
        assert!(matches!(job_rx.try_recv(), Ok(Job::Compact { .. })));
        assert!(matches!(job_rx.try_recv(), Ok(Job::Health { cwd: c }) if c == cwd));
        assert_eq!(registry.open_cwds(), vec![cwd]);
        std::fs::remove_dir_all(&root).ok();
    }

    /// N rapid FS signals collapse into exactly ONE `IndexCorpus` job.
    #[tokio::test]
    async fn debounce_coalesces_burst_into_one_job() {
        let (sig_tx, sig_rx) = mpsc::channel::<()>(64);
        let (job_tx, mut job_rx) = mpsc::channel::<Job>(16);
        let window = Duration::from_millis(80);

        let handle = tokio::spawn(debounce_loop(sig_rx, job_tx, "/proj/a".to_string(), window));

        // Fire a burst well within the window.
        for _ in 0..20 {
            sig_tx.try_send(()).unwrap();
            tokio::time::sleep(Duration::from_millis(2)).await;
        }

        // After the quiet window, exactly one job should appear.
        let job = tokio::time::timeout(Duration::from_millis(400), job_rx.recv())
            .await
            .expect("a job within timeout")
            .expect("job present");
        match job {
            Job::IndexCorpus { cwd } => assert_eq!(cwd, "/proj/a"),
            other => panic!("expected IndexCorpus, got {other:?}"),
        }

        // No second job from the same burst.
        assert!(
            tokio::time::timeout(Duration::from_millis(200), job_rx.recv())
                .await
                .is_err(),
            "burst should coalesce into a single job"
        );

        // Closing the signal channel ends the loop.
        drop(sig_tx);
        let _ = tokio::time::timeout(Duration::from_millis(300), handle).await;
    }

    /// Opening a project enqueues an initial `IndexCorpus`, and re-opening the
    /// same project does NOT enqueue a second one.
    #[test]
    fn engine_for_enqueues_initial_index_once() {
        let (job_tx, mut job_rx) = mpsc::channel::<Job>(16);
        let registry = MemoryRegistry::with_window(job_tx, Duration::from_millis(50));

        let root = tmp_root("cold");
        let cwd = root.to_string_lossy().to_string();

        let _e1 = registry.engine_for(&cwd);
        // First open enqueues an initial IndexCorpus then a one-time Compact.
        match job_rx.try_recv() {
            Ok(Job::IndexCorpus { cwd: c }) => assert_eq!(c, cwd),
            other => panic!("expected initial IndexCorpus, got {other:?}"),
        }
        match job_rx.try_recv() {
            Ok(Job::Compact { cwd: c }) => assert_eq!(c, cwd),
            other => panic!("expected one-time Compact, got {other:?}"),
        }
        assert!(matches!(job_rx.try_recv(), Ok(Job::Health { cwd: c }) if c == cwd));
        assert!(
            job_rx.try_recv().is_err(),
            "first open enqueues exactly IndexCorpus + Compact + Health"
        );

        // Second open of the same project: same engine handle, no new jobs.
        let _e2 = registry.engine_for(&cwd);
        assert!(
            job_rx.try_recv().is_err(),
            "re-opening must not re-enqueue any job"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    /// An extractor pass that stored entries reindexes and then offers the new
    /// Facts to global memory; one that stored nothing enqueues nothing.
    #[test]
    fn a_storing_extraction_enqueues_reindex_then_promotion() {
        let (job_tx, mut job_rx) = mpsc::channel::<Job>(16);
        let registry = MemoryRegistry::with_window(job_tx, Duration::from_millis(50));

        reindex_after(&registry, "/proj/a", 0);
        assert!(job_rx.try_recv().is_err());

        reindex_after(&registry, "/proj/a", 2);
        assert!(matches!(job_rx.try_recv(), Ok(Job::IndexCorpus { cwd }) if cwd == "/proj/a"));
        assert!(matches!(job_rx.try_recv(), Ok(Job::Compact { cwd }) if cwd == "/proj/a"));
        assert!(job_rx.try_recv().is_err());
    }

    /// `request_reindex` asks for exactly one corpus pass. A never-opened
    /// project gets the cold pass its open queues; an open one gets the
    /// nudge. Neither ever blocks.
    #[test]
    fn request_reindex_queues_exactly_one_index_corpus() {
        let (job_tx, mut job_rx) = mpsc::channel::<Job>(16);
        let registry = MemoryRegistry::with_window(job_tx, Duration::from_millis(50));
        let root = tmp_root("reindex");
        let cwd = root.to_string_lossy().to_string();

        // Not open yet: opening queues the cold IndexCorpus + one-time Compact.
        registry.request_reindex(&cwd);
        assert!(matches!(job_rx.try_recv(), Ok(Job::IndexCorpus { cwd: c }) if c == cwd));
        assert!(matches!(job_rx.try_recv(), Ok(Job::Compact { cwd: c }) if c == cwd));
        assert!(matches!(job_rx.try_recv(), Ok(Job::Health { cwd: c }) if c == cwd));
        assert!(
            job_rx.try_recv().is_err(),
            "no second IndexCorpus on first open"
        );

        // Open: exactly one IndexCorpus, no further Compact.
        registry.request_reindex(&cwd);
        assert!(matches!(job_rx.try_recv(), Ok(Job::IndexCorpus { cwd: c }) if c == cwd));
        assert!(job_rx.try_recv().is_err());

        std::fs::remove_dir_all(&root).ok();
    }

    /// A job for cwd-A only ever touches cwd-A's `.atlas/memory/`; cwd-B's engine
    /// is a distinct handle under a distinct directory — the registry never
    /// cross-wires two projects.
    #[tokio::test]
    async fn projects_are_isolated_by_cwd() {
        let (job_tx, _job_rx) = mpsc::channel::<Job>(64);
        let registry = MemoryRegistry::with_window(job_tx, Duration::from_millis(50));

        let root_a = tmp_root("iso-a");
        let root_b = tmp_root("iso-b");
        let cwd_a = root_a.to_string_lossy().to_string();
        let cwd_b = root_b.to_string_lossy().to_string();

        let engine_a = registry.engine_for(&cwd_a);
        let engine_b = registry.engine_for(&cwd_b);

        // Distinct engine handles.
        assert!(!Arc::ptr_eq(&engine_a, &engine_b));

        // Each engine's memory dir is under its own cwd, never the other's.
        let dir_a = engine_a.read().await.memory_dir().to_path_buf();
        let dir_b = engine_b.read().await.memory_dir().to_path_buf();
        assert!(
            dir_a.starts_with(&root_a),
            "A dir {dir_a:?} not under {root_a:?}"
        );
        assert!(
            dir_b.starts_with(&root_b),
            "B dir {dir_b:?} not under {root_b:?}"
        );
        assert!(!dir_a.starts_with(&root_b));
        assert!(!dir_b.starts_with(&root_a));

        std::fs::remove_dir_all(&root_a).ok();
        std::fs::remove_dir_all(&root_b).ok();
    }
}
