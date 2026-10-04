//! Wiring `atlas-checkpoint` into the running app.
//!
//! The crate itself is Tauri-free and knows nothing about agents. This module is
//! the adapter: it turns the agent delta stream into capture calls, and owns the
//! per-Project stores.
//!
//! Three decisions here are not obvious from the crate's API, and all three come
//! from how the runtime actually behaves rather than from how it reads:
//!
//! **Capture is a pipeline stage, not a bus subscriber.** The `atlas-bus`
//! broadcast drops events for a subscriber that lags past the ring capacity —
//! correct for the UI fan-out, where a dropped frame is invisible, and wrong
//! here, where a dropped event is a turn missing from the permanent record. The
//! [`OutboundPipeline`] slot runs synchronously on the emit thread and cannot
//! lag by construction. (`atlas_bus::middleware` has a test pinning that
//! contrast.)
//!
//! **The user's prompt does not arrive on the delta stream.** The session actor
//! deliberately skips emitting a message-appended delta for user messages — the
//! frontend adds them optimistically — and turn start is a status flip carrying
//! no text. A delta subscriber alone would therefore produce Sessions with no
//! prompts and no titles. [`note_prompt`] is called from the send path instead,
//! with the text the user actually typed, *before* Atlas's memory-injection
//! blocks are prepended: injected context is machinery, not something the user
//! said, and titling a Session after it would be nonsense.
//!
//! **Writes happen on one owned thread, not on the emit thread.** SQLite work is
//! disk work and the streaming hot path must never block on it, but
//! `spawn_blocking` would also let two turns land out of order. A single worker
//! thread behind an unbounded channel gets both properties: `on_event` returns
//! immediately, and turns are written in the order they happened.
//!
//! **Streamed bodies are accumulated, not sampled.** `MessageAppended` carries
//! only the *first* streamed chunk of an assistant or thinking message; the rest
//! arrives as `TextChunk` / `ThinkingChunk` deltas. Recording at
//! `MessageAppended` time would therefore store every streamed response
//! truncated to its opening tokens — so the middleware accumulates per message
//! id and submits the completed bodies when the turn finishes.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use atlas_agent_wire::{
    MessageRole, SessionDelta, SessionDeltaEnvelope, ToolCall, ToolCallStatus, ToolContentBlock,
};
use atlas_bus::OutboundMiddleware;
use atlas_checkpoint::model::DrainGate;
use atlas_checkpoint::tools::{extract_paths, resolve_path, ResolvedPath, ToolName};
use atlas_checkpoint::{
    Capture, FileWrite, Mode, ProjectMode, Role, SessionKey, Source, Store, TokenTotals,
    ToolCallContent, ToolStatus, TurnContent,
};
use tauri::{AppHandle, Emitter, Manager};

/// Lock a mutex, recovering from poisoning.
///
/// A panicked capture job poisons whatever mutex it held; the store's own
/// transactionality is what guards consistency, not the poison flag — and
/// letting one panic permanently kill every later capture command (the old
/// `.expect("session store")` behaviour) turns a single bad payload into a
/// dead recorder for the rest of the process.
fn lock_ok<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// What the middleware knows about one agent session, learned at send time.
///
/// The canonical string identity of a Project.
///
/// `workspace_id` is derived twice from two independent sources — the agent's
/// cwd when a Session records, and the git watcher's project path when commits
/// are walked — and the two are compared as strings. `/repo` vs `/repo/`, and
/// `/var/...` vs `/private/var/...` on macOS, are the same directory to every
/// filesystem call in the pipeline but different `String`s, and when they
/// diverge `link_candidates` matches nothing: Sessions record, commits are
/// seen, the walk returns `Ok`, and no Checkpoint is ever created.
///
/// Both sites route through here so the identity cannot drift. Falls back to
/// the lexical path when the directory does not exist (a Project whose folder
/// was renamed or removed) — an id is still needed to read back what was
/// already stored under it.
pub(crate) fn project_id_for(root: &std::path::Path) -> String {
    dunce::canonicalize(root)
        .unwrap_or_else(|_| root.to_path_buf())
        .to_string_lossy()
        .to_string()
}

/// Distinct from `atlas_checkpoint::Binding`, which is how the *Project* is
/// bound (mode, Slug, fingerprints). This is per-conversation routing state.
///
/// Resolved from the manager's session snapshot rather than from
/// `SharedMemoryStore::session_meta`: that store is only populated when the
/// per-project memory-sharing toggle is on, which is off by default, so reusing
/// it would silently capture nothing for most users.
#[derive(Clone)]
struct SessionBinding {
    project_root: PathBuf,
    source: Source,
    native_session_id: String,
    agent: Option<String>,
    model: Option<String>,
    /// Branch at the moment of the first prompt. Read once per Session — a
    /// `git symbolic-ref` on every keystroke-triggered send would be a process
    /// spawn on the send path for a value that does not change.
    branch: Option<String>,
    cwd: String,
    /// The turn a message-appended delta belongs to. Message deltas carry no
    /// turn identity of their own, so the send path stamps it here. Seeded from
    /// the store's `MAX(turn_seq)` on first sighting, so a conversation resumed
    /// after a restart continues from turn N+1 instead of colliding with the
    /// turns already recorded.
    turn_seq: i64,
}

/// Work for the capture thread.
///
/// `ToolCall` dwarfs the other variants (its writes, arguments and now the
/// settled-commit list all ride inline). Boxing it would buy back a few dozen
/// bytes per QUEUED job on an unbounded queue that drains in milliseconds —
/// the indirection costs more in reading than the memory ever will.
#[allow(clippy::large_enum_variant)]
enum Job {
    Prompt {
        binding: SessionBinding,
        prompt: String,
    },
    Turn {
        binding: SessionBinding,
        native_message_id: String,
        role: Role,
        mode: Mode,
        body: String,
        created_at: chrono::DateTime<chrono::Utc>,
    },
    ToolCall {
        binding: SessionBinding,
        native_call_id: String,
        tool_name: ToolName,
        title: Option<String>,
        kind: Option<String>,
        status: ToolStatus,
        locations: serde_json::Value,
        arguments: Option<String>,
        result: Option<String>,
        /// Files this call wrote, complete with the write-time hash — populated
        /// only on the *first* terminal sighting, so repeated terminal upserts
        /// cannot duplicate `file_touch` / `agent_edit` rows.
        writes: Vec<CompletedWrite>,
        /// Commits the shell window saw HEAD move across — a command that
        /// committed its own writes. The worker evaluates exactly these after
        /// the touches land; the walk's cursor has already gone past them.
        settled_commits: Vec<String>,
        /// The patch an edit-shaped call applied, when the arguments carry one.
        /// Recorded once per call, not once per path.
        patch: Option<String>,
    },
    /// Walk from the last-seen commit to HEAD and link what it finds.
    ///
    /// Not tied to a Session — it is driven by the repository moving, and the
    /// Sessions it might link to are whatever the store already holds.
    WalkCommits {
        project_root: PathBuf,
        workspace_id: String,
    },
    FinishTurn {
        binding: SessionBinding,
    },
    /// The agent took back the Session's last `turns` turns (a retry).
    RewindTurns {
        binding: SessionBinding,
        turns: i64,
    },
    Usage {
        binding: SessionBinding,
        totals: TokenTotals,
    },
    /// The agent process for this session is gone; drop the worker's cached
    /// session id so the map does not grow for the life of the process.
    EndSession {
        native_session_id: String,
    },
}

/// A file a tool call is about to write, and what we knew before it did.
#[derive(Clone)]
struct PendingWrite {
    path: ResolvedPath,
    /// Whether the file existed before the agent wrote.
    ///
    /// Sampled at first sighting when that sighting precedes the write. A path
    /// that first appears only on a terminal (post-write) update has an
    /// *unknowable* answer — recorded as `false`, never `true`: the strict arm
    /// of the link rule (content match required) can miss a link, but the
    /// permissive arm (path alone) crediting the agent for a file a human wrote
    /// is exactly the false attribution the rule exists to prevent.
    existed_before: bool,
}

/// A finished write, hashed on the emit thread at the terminal sighting.
///
/// Hashing here rather than on the worker matters when the worker is busy (a
/// multi-minute import or drain): by the time the job is dequeued the developer
/// may have edited the file, and hashing *their* content as the agent's is the
/// false-attribution direction the link rule's new-file arm depends on. The
/// read is bounded by the file the agent just wrote.
#[derive(Clone)]
struct CompletedWrite {
    path: ResolvedPath,
    existed_before: bool,
    /// Hash of what the agent produced. `None` for a deletion.
    sha256_after: Option<String>,
    /// Bounded fingerprint of the same bytes, so the link rule can measure how
    /// much of the agent's content survived into the commit rather than
    /// demanding an exact match. Computed here, from the same read as the hash.
    sketch_after: Option<String>,
    deleted: bool,
}

/// How long a shell command may run and still have its writes attributed.
///
/// The window is the whole weakness of this approach: git cannot tell the
/// agent's write from the user's, so everything that changed while the command
/// ran looks the same. A command that finishes in a moment barely overlaps the
/// user at all; one that runs for minutes — a watch, a build, a server — is
/// long enough that the developer plausibly edited something themselves, and
/// crediting that to the agent would make every later commit on that file link
/// to this Session. Past this, nothing is attributed.
const SHELL_WINDOW_LIMIT: Duration = Duration::from_secs(60);

/// What the tree looked like when a shell command started.
struct ShellWindow {
    before: std::collections::BTreeSet<String>,
    /// Where HEAD stood. A command that COMMITS its own writes leaves the tree
    /// clean again, so a moved HEAD is the only evidence the window keeps.
    head: Option<HeadMark>,
    started: Instant,
}

/// Where HEAD stood when a shell window or a turn opened.
#[derive(Debug, Clone, PartialEq, Eq)]
enum HeadMark {
    At(String),
    /// No commit yet — a fresh `git init`, or not a repository at all. Every
    /// commit that appears afterwards is new, which is the one fact the first
    /// commit of a Project needs: without it the root commit had no "before"
    /// and was never linked.
    Unborn,
}

impl HeadMark {
    /// `None` when HEAD could not be read for some other reason — a failed git
    /// call is not evidence that history is empty.
    fn read(project_root: &Path) -> Option<Self> {
        if let Some(head) = atlas_checkpoint::git::head_commit(project_root) {
            return Some(Self::At(head));
        }
        let unborn =
            !project_root.join(".git").exists() || atlas_checkpoint::git::is_unborn(project_root);
        unborn.then_some(Self::Unborn)
    }
}

/// What moved between `before` and `after`: the paths changed and the commits
/// crossed, oldest first. `None` when HEAD did not move or git could not say.
fn head_moved(
    project_root: &Path,
    before: &HeadMark,
    after: &str,
) -> Option<(Vec<atlas_checkpoint::git::ChangedPath>, Vec<String>)> {
    let (from, since) = match before {
        HeadMark::At(sha) if sha == after => return None,
        HeadMark::At(sha) => (sha.as_str(), Some(sha.as_str())),
        HeadMark::Unborn => (atlas_checkpoint::git::EMPTY_TREE, None),
    };
    let changes = atlas_checkpoint::git::changed_between(project_root, from, after)?;
    let commits =
        atlas_checkpoint::git::commits_between(project_root, since, after).unwrap_or_default();
    Some((changes, commits))
}

/// The sampling state for one tool call's writes.
struct WriteSample {
    writes: Vec<PendingWrite>,
    /// The first terminal sighting has already carried these writes to the
    /// worker; later terminal upserts (a late locations-only refresh) must not
    /// record them again — `file_touch` / `agent_edit` have no idempotency key.
    recorded: bool,
}

/// A message being streamed, accumulated until the turn finishes.
struct PendingMessage {
    id: String,
    role: Role,
    mode: Mode,
    body: String,
    /// When the message's first chunk arrived. The row is written at turn end,
    /// so without this every response in a turn would carry the turn's end
    /// time — and the timeline, and active time, would read them as one burst.
    started_at: chrono::DateTime<chrono::Utc>,
}

/// Everything a turn has streamed so far, plus the session binding as it stood
/// when the turn's first message arrived — so a queued next prompt bumping the
/// registry's `turn_seq` cannot re-stamp this turn's messages.
struct PendingTurn {
    binding: SessionBinding,
    messages: Vec<PendingMessage>,
}

/// App-wide capture state: the session registry and the worker's channel.
pub struct CaptureState {
    sessions: Mutex<HashMap<String, SessionBinding>>,
    /// Write sampling per tool call id — `existed_before` answers and whether
    /// the call's writes have been recorded. Evicted when the session closes.
    pending_writes: Mutex<HashMap<String, WriteSample>>,
    /// Open shell windows, keyed by tool-call id. See [`CaptureState::shell_window`].
    shell_windows: Mutex<HashMap<String, ShellWindow>>,
    /// Where HEAD stood at each session's last prompt (or where the last
    /// fallback attribution left it) — the coarse anchor for a shell call the
    /// per-call window never saw. Some adapters announce a command only once,
    /// already completed, so there is no non-terminal sighting to open a
    /// window at; the turn is then the tightest boundary that provably
    /// predates the command. Advanced after each use, so two calls in one
    /// turn cannot claim the same commits twice.
    turn_heads: Mutex<HashMap<String, HeadMark>>,
    /// Commits a closed shell window saw HEAD move across, keyed by tool-call
    /// id, parked until the worker takes them with the call's job. They ride
    /// separately because the ordinary walk's cursor has already consumed
    /// them — the worker re-evaluates exactly these AFTER the touches land.
    settled_commits: Mutex<HashMap<String, Vec<String>>>,
    /// Tool-call ids seen per session, so the write caches above can be evicted
    /// when the session's agent disconnects.
    session_calls: Mutex<HashMap<String, Vec<String>>>,
    /// Streamed message accumulation per session, flushed at turn end.
    pending_turns: Mutex<HashMap<String, PendingTurn>>,
    /// How the drain gets an access token. Shared with the worker.
    token: TokenProvider,
    /// How the worker tells the UI something was written. Late-bound like
    /// `token`, for the same reason: the app handle does not exist yet when
    /// this state is registered.
    notify: Notifier,
    /// Every writing session store this process has open.
    stores: StoreRegistry,
    /// Set false when the worker thread dies (it should never — each job runs
    /// under `catch_unwind` — but a dead worker is silent capture loss, which is
    /// exactly what the health signal exists to make visible).
    worker_alive: Arc<AtomicBool>,
    /// The sync worker's liveness, as [`CaptureState::worker_alive`] is the
    /// recording worker's.
    sync_alive: Arc<AtomicBool>,
    tx: mpsc::Sender<Job>,
    /// Requests for the sync worker ([`SyncRequest`]).
    sync_tx: mpsc::Sender<SyncRequest>,
}

/// A late-bound source of access tokens, shared between the command surface and
/// the capture worker.
type TokenProvider = Arc<Mutex<Option<Box<dyn Fn() -> Option<String> + Send>>>>;

/// A late-bound window-event emitter, shared with the capture worker.
type Notifier = Arc<Mutex<Option<AppHandle>>>;

/// Emitted when the worker has written something a reader would want to see.
///
/// The Timeline board polls every 15 s as a fallback, which is fine for a
/// background refresh and far too slow for the session you just started — it
/// appears up to fifteen seconds after you sent the prompt. Capture writes move
/// no git ref, so `atlas:git-changed` never fires for them and there was nothing
/// else to listen to.
pub const CAPTURE_CHANGED: &str = "atlas:capture-changed";

/// Coalescing window for [`CAPTURE_CHANGED`].
///
/// One streaming turn produces dozens of jobs — every tool call, every finished
/// message, every usage update. Emitting per job would have the board re-reading
/// every project's store dozens of times a turn. Leading-edge plus trailing, so
/// the first write of a burst shows immediately and the last one is not lost.
const NOTIFY_DEBOUNCE: Duration = Duration::from_millis(250);

/// Work for the **sync worker** — the thread that talks to the cloud and
/// reads transcripts off disk, so the recording worker never does.
///
/// # Why a second thread
///
/// Everything used to run on the one capture worker, for every Project: a
/// cloud drain looped until the whole outbox was sent — minutes, after
/// promoting a Project with a local backlog — holding that Project's store
/// lock across every upload, while every other job waited in the channel.
/// Recording stopped for **all** Projects (new prompts, turns and tool calls
/// sat in memory, lost if the app quit), and every other Project's sync
/// waited behind the one backlog. Now the recording worker only writes
/// locally; this worker drains and imports through a sibling connection
/// ([`Store::sibling`]) so it never holds the recorder's store lock, gives
/// each Project a bounded pass ([`SYNC_PASS_BUDGET`]) in turn, and keeps one
/// entry per Project however many times a drain is asked for.
enum SyncRequest {
    /// Send this Project's outbox. `forced` bypasses the offline backoff: a
    /// human just did something (promote, connect, retry).
    Drain { project_root: PathBuf, forced: bool },
    /// Import any on-disk transcripts for this Project that are not yet
    /// recorded — the historical backfill and the terminal-gap scan.
    Import { project_root: PathBuf },
}

/// How long one drain pass may keep starting batches before it yields to the
/// next Project that is due. A batch in flight always finishes.
const SYNC_PASS_BUDGET: Duration = Duration::from_secs(3);

/// Per-root drain backoff, owned by the sync worker.
struct DrainBackoff {
    next_attempt: Instant,
    delay: Duration,
}

type BackoffMap = Arc<Mutex<HashMap<PathBuf, DrainBackoff>>>;

/// One writing [`Store`] per Project root, for the whole process.
///
/// This exists because the writer lock arbitrates between **processes**, and the
/// first version of this module gave one process two stores per Project: the
/// worker cached one for its lifetime, and every command opened another. The
/// command's store lost the race for the lock and reported "another Atlas window
/// is already recording this project" — naming a window that did not exist,
/// and making `capture_enable` fail permanently on any Project the user had
/// ever sent a prompt in.
///
/// So: exactly one writer per root, shared. Reads do not come through here at
/// all — they open their own connection via [`Store::open_reader`], so listing
/// Sessions never waits behind a long import.
type StoreRegistry = Arc<Mutex<HashMap<PathBuf, StoreHandle>>>;

/// A shared store, plus the one fact about it that must be readable without
/// waiting for whatever is currently using it.
#[derive(Clone)]
struct StoreHandle {
    store: Arc<Mutex<Store>>,
    /// Whether this process took the Project's writer lock, cached at open
    /// time. A status read must be able to answer this while the worker is
    /// midway through a multi-minute import.
    is_writer: bool,
}

impl CaptureState {
    /// `token` mints a fresh access token for the drain. A closure rather than a
    /// value because tokens are short-lived and a post-promotion backlog runs
    /// far longer than one lifetime.
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel();
        // Late-bound: the auth core is managed inside `setup`, after this state
        // is registered, so the provider is installed rather than passed in.
        // Until it is, the closure yields no credential — which parks the drain
        // instead of failing it, and is exactly Local-mode behaviour.
        let token: TokenProvider = Arc::new(Mutex::new(None));
        let notify: Notifier = Arc::new(Mutex::new(None));
        let notify_for_worker = notify.clone();
        let stores: StoreRegistry = Arc::new(Mutex::new(HashMap::new()));
        let stores_for_worker = stores.clone();
        let worker_alive = Arc::new(AtomicBool::new(true));
        let alive_for_worker = worker_alive.clone();
        // Unbounded on purpose. A bounded channel would have to choose between
        // blocking the emit thread and dropping a turn, and both are worse than
        // holding a few queued turns in memory — the worker drains them in
        // milliseconds.
        std::thread::Builder::new()
            .name("atlas-capture".into())
            .spawn(move || worker(rx, notify_for_worker, stores_for_worker, alive_for_worker))
            .expect("capture worker thread");
        // The cloud and the transcript scan, on a thread of their own so a
        // long upload or import never holds a turn's recording (see
        // [`SyncRequest`]).
        let (sync_tx, sync_rx) = mpsc::channel();
        let sync_alive = Arc::new(AtomicBool::new(true));
        let (sync_token, sync_notify, sync_stores, sync_alive_for_worker) = (
            token.clone(),
            notify.clone(),
            stores.clone(),
            sync_alive.clone(),
        );
        std::thread::Builder::new()
            .name("atlas-capture-sync".into())
            .spawn(move || {
                let ingest = Box::new(atlas_checkpoint::sync::ingest_base);
                sync_worker(
                    sync_rx,
                    sync_token,
                    sync_notify,
                    sync_stores,
                    sync_alive_for_worker,
                    ingest,
                )
            })
            .expect("capture sync thread");
        Self {
            sessions: Mutex::new(HashMap::new()),
            pending_writes: Mutex::new(HashMap::new()),
            shell_windows: Mutex::new(HashMap::new()),
            turn_heads: Mutex::new(HashMap::new()),
            settled_commits: Mutex::new(HashMap::new()),
            session_calls: Mutex::new(HashMap::new()),
            pending_turns: Mutex::new(HashMap::new()),
            token,
            notify,
            stores,
            worker_alive,
            sync_alive,
            tx,
            sync_tx,
        }
    }

    /// The process's writing store for this Project, opening it if needed.
    ///
    /// Every write path — binding, promotion, the worker's own jobs — must go
    /// through this. Opening a second `Store` on the same root inside this
    /// process is what produced the phantom "another Atlas window" error.
    fn writer(&self, root: &Path) -> Result<Arc<Mutex<Store>>, String> {
        Ok(open_in(&self.stores, root)?.store)
    }

    /// This process's claim on the Project's writer lock.
    ///
    /// `None` when nothing here has opened the store yet — no claim either way,
    /// and crucially **not** evidence of another window. `Some(false)` means an
    /// acquisition genuinely lost to another process; `Some(true)` means this
    /// process holds it.
    fn writer_claim(&self, root: &Path) -> Option<bool> {
        lock_ok(&self.stores)
            .get(root)
            .map(|handle| handle.is_writer)
    }

    /// Is the capture worker thread still running?
    fn is_worker_alive(&self) -> bool {
        self.worker_alive.load(Ordering::Relaxed) && self.sync_alive.load(Ordering::Relaxed)
    }

    /// Install the credential source the drain uses.
    ///
    /// Called once from `setup`, after the auth core exists.
    pub fn install_token_provider(&self, provider: Box<dyn Fn() -> Option<String> + Send>) {
        *lock_ok(&self.token) = Some(provider);
    }

    /// Install the handle the worker emits [`CAPTURE_CHANGED`] through.
    ///
    /// Called once from `setup`. Until it is, the worker simply writes without
    /// announcing, and the board's poll is the only refresh — which is the
    /// behaviour that existed before this event.
    pub fn install_notifier(&self, app: AppHandle) {
        *lock_ok(&self.notify) = Some(app);
    }

    /// Arm the git watcher for a Project that became a repository after it was
    /// opened.
    ///
    /// The watcher is started when the frontend activates a Project, and
    /// `git_watch_start` skips a folder that is not a repository yet — so an
    /// agent that runs `git init` in a fresh folder left the Project unwatched
    /// for the rest of the app session: no commit walk, no cursor, and every
    /// Checkpoint depending on the per-call path alone. A shell call finishing
    /// is when a new `.git/` can have appeared. The registry check is a map
    /// read; the restart only happens once.
    fn ensure_git_watcher(&self, project_root: &Path) {
        if !project_root.join(".git").exists() {
            return;
        }
        let Some(app) = lock_ok(&self.notify).clone() else {
            return;
        };
        if app
            .state::<super::git_watcher::GitWatcherState>()
            .is_watching_root(project_root)
        {
            return;
        }
        let root = project_root.to_string_lossy().into_owned();
        tauri::async_runtime::spawn(async move {
            heal_git_watcher(&app, &root, None).await;
        });
    }

    /// Record the user's prompt and bind the session, from the send path.
    ///
    /// `prompt` must be the text the user typed, not the memory-prefixed version
    /// that reaches the agent. `session_id` is the agent's own id for the
    /// conversation, which is what makes a later import recognise it as already
    /// captured.
    pub fn note_prompt(
        &self,
        session_id: &str,
        cwd: &str,
        plugin_id: &str,
        model: Option<&str>,
        prompt: &str,
    ) {
        if cwd.is_empty() {
            // No project directory means nowhere to put `.atlas/`. Capture is a
            // no-op rather than an error — the agent turn is unaffected.
            return;
        }

        // Seed the turn counter from the store when this is the first sighting
        // of the session this process. Without this, a conversation resumed
        // after a restart starts again at turn 1, `begin_turn` collides with
        // the completed turn 1 already recorded, and the whole resumed tail is
        // mis-attributed. The read is two indexed lookups, done *before* taking
        // the registry lock so no I/O happens under it.
        let source = source_for(plugin_id);
        // The coarse shell anchor: where HEAD stands as this turn begins. Read
        // BEFORE any lock — it spawns git once per prompt.
        if let Some(head) = HeadMark::read(Path::new(cwd)) {
            lock_ok(&self.turn_heads).insert(session_id.to_string(), head);
        }
        let needs_seed = !lock_ok(&self.sessions).contains_key(session_id);
        let seed = if needs_seed {
            seed_turn_seq(Path::new(cwd), source, session_id)
        } else {
            0
        };

        let binding = {
            let mut sessions = lock_ok(&self.sessions);
            let entry = sessions
                .entry(session_id.to_string())
                .or_insert_with(|| SessionBinding {
                    project_root: PathBuf::from(cwd),
                    source,
                    native_session_id: session_id.to_string(),
                    agent: Some(plugin_id.to_string()),
                    model: model.map(str::to_string),
                    // Resolved here, inside `or_insert_with`, so the `git` call
                    // happens once per Session rather than on every send.
                    branch: atlas_checkpoint::git::current_branch(Path::new(cwd)),
                    cwd: cwd.to_string(),
                    turn_seq: seed,
                });
            entry.turn_seq += 1;
            if model.is_some() {
                entry.model = model.map(str::to_string);
            }
            // A Session that began before `git init` had no branch to record.
            // Ask again on each send until it has one — one `git` call per
            // send, only while unknown — so a later prompt fills it in.
            if entry.branch.is_none() {
                entry.branch = atlas_checkpoint::git::current_branch(Path::new(cwd));
            }
            entry.clone()
        };

        self.submit(Job::Prompt {
            binding,
            prompt: prompt.to_string(),
        });
    }

    /// Send everything pending for a Project.
    ///
    /// Handed to the worker rather than run inline, because a post-promotion
    /// backlog is hundreds of megabytes and must never block the click that
    /// started it.
    pub fn note_drain(&self, project_root: &std::path::Path) {
        self.submit_sync(SyncRequest::Drain {
            project_root: project_root.to_path_buf(),
            forced: true,
        });
    }

    /// Import on-disk transcripts for a Project.
    ///
    /// The same call serves the one-time backfill (on enable) and the ongoing
    /// watch (on the worker's interval), because they are the same reconciling
    /// scan — a file that has not grown is skipped by a size check, which is
    /// what makes running it repeatedly affordable. Whether the import may run
    /// at all (the Cloud bulk-disclosure gate) is checked in `import_for`.
    pub fn note_import(&self, project_root: &std::path::Path) {
        self.submit_sync(SyncRequest::Import {
            project_root: project_root.to_path_buf(),
        });
    }

    /// The repository moved, or a Project was just opened — walk for new
    /// commits.
    ///
    /// This is the **in-process consumer** of the git watcher. The walk is
    /// invoked from the watcher callback directly rather than by round-tripping
    /// through the frontend, so commit detection does not depend on a window
    /// being open, on the frontend having subscribed, or on a renderer that may
    /// be busy.
    ///
    /// Also called on Project open, and that call is not a fallback: a watcher
    /// exists only for a Project activated at least once this app session, so
    /// for a never-activated or evicted Project the open-time walk is the only
    /// thing that will ever link its commits.
    pub fn note_git_change(&self, project_root: &std::path::Path) {
        self.submit(Job::WalkCommits {
            project_root: project_root.to_path_buf(),
            workspace_id: project_id_for(project_root),
        });
    }

    fn binding(&self, session_id: &str) -> Option<SessionBinding> {
        lock_ok(&self.sessions).get(session_id).cloned()
    }

    // ── Streamed-message accumulation ───────────────────────────────────────

    /// A new agent message appeared. Start (or reset) its accumulation entry;
    /// the body recorded at turn end, not this first-chunk snapshot.
    fn begin_message(
        &self,
        session_id: &str,
        binding: &SessionBinding,
        id: String,
        role: Role,
        mode: Mode,
        body: String,
    ) {
        let mut turns = lock_ok(&self.pending_turns);
        let turn = turns
            .entry(session_id.to_string())
            .or_insert_with(|| PendingTurn {
                binding: binding.clone(),
                messages: Vec::new(),
            });
        match turn.messages.iter_mut().find(|m| m.id == id) {
            Some(existing) => {
                // A re-emit for a known id replaces rather than appends — the
                // runtime sends the full snapshot in that case.
                existing.role = role;
                existing.mode = mode;
                existing.body = body;
            }
            None => turn.messages.push(PendingMessage {
                id,
                role,
                mode,
                body,
                started_at: chrono::Utc::now(),
            }),
        }
    }

    /// Append a streamed chunk to the message it belongs to.
    ///
    /// Text and thinking chunks are appended alike: the runtime creates separate
    /// messages for thinking and text, so a chunk's message id already selects
    /// the right body.
    fn append_chunk(&self, session_id: &str, message_id: &str, delta: &str) {
        let mut turns = lock_ok(&self.pending_turns);
        if let Some(turn) = turns.get_mut(session_id) {
            if let Some(message) = turn.messages.iter_mut().find(|m| m.id == message_id) {
                message.body.push_str(delta);
            }
        }
    }

    /// The turn ended — submit every accumulated message (now complete), then
    /// close the turn. Clearing the accumulation here is also what bounds its
    /// memory.
    fn flush_turn(&self, session_id: &str, fallback: &SessionBinding) {
        let turn = lock_ok(&self.pending_turns).remove(session_id);
        match turn {
            Some(turn) => {
                self.submit_pending_messages(&turn);
                self.submit(Job::FinishTurn {
                    binding: turn.binding,
                });
            }
            // A turn with no agent messages (tool-only, or an instant failure)
            // still has to close.
            None => self.submit(Job::FinishTurn {
                binding: fallback.clone(),
            }),
        }
    }

    /// The agent died. Record whatever had streamed — a partial transcript is
    /// better than none — but do *not* close the turn: an agent that died
    /// mid-turn should be reconciled as aborted, not read as finished.
    fn flush_session_end(&self, session_id: &str, binding: &SessionBinding) {
        if let Some(turn) = lock_ok(&self.pending_turns).remove(session_id) {
            self.submit_pending_messages(&turn);
        }
        // Evict the write caches for every call this session made. The
        // `session_calls` guard is released before `pending_writes` is taken —
        // an if-let scrutinee would keep it alive across the body, and
        // `sample_writes` acquires the two locks in the opposite order.
        let calls = lock_ok(&self.session_calls).remove(session_id);
        if let Some(calls) = calls {
            self.forget_shell_windows(&calls);
            self.forget_turn_head(session_id);
            let mut pending = lock_ok(&self.pending_writes);
            for call_id in calls {
                pending.remove(&call_id);
            }
        }
        // The binding registry itself — without this, one SessionBinding per
        // session ever seen survived for the process lifetime (and the map is
        // scanned under its mutex on every delta). Re-sighting the same session
        // later is safe: note_prompt's seed path re-creates the entry.
        lock_ok(&self.sessions).remove(session_id);
        // And the worker's cached store id for the session.
        self.submit(Job::EndSession {
            native_session_id: binding.native_session_id.clone(),
        });
    }

    fn submit_pending_messages(&self, turn: &PendingTurn) {
        for message in &turn.messages {
            if message.body.trim().is_empty() {
                continue;
            }
            self.submit(Job::Turn {
                binding: turn.binding.clone(),
                native_message_id: message.id.clone(),
                role: message.role,
                mode: message.mode,
                body: message.body.clone(),
                created_at: message.started_at,
            });
        }
    }

    // ── Write sampling ──────────────────────────────────────────────────────

    /// Note which files a call is about to touch, and whether each existed.
    ///
    /// The sampling *event* is cached per call id — even when the extracted
    /// path set is empty — because many agents attach locations only on the
    /// completion update, and re-probing the *filesystem* after the write
    /// would always answer `true` for a file the agent just created.
    ///
    /// A path first seen on a later (post-write) sighting therefore falls back
    /// to git rather than to a flat `false`. Recording the strict arm there was
    /// conservative in the right direction but far too blunt in practice: the
    /// agents we host attach locations at completion, so *every* touch took it,
    /// the permissive arm never fired, and a developer who tweaked one word of
    /// agent output before committing silently lost the Checkpoint — the exact
    /// workflow the asymmetric rule exists to support. `tracked_in_head` is
    /// order-independent, so it answers the same before and after the write.
    ///
    /// Returns the writes and whether a terminal sighting has already recorded
    /// them (so repeated terminal upserts cannot duplicate rows).
    fn sample_writes(
        &self,
        session_id: &str,
        project_root: &std::path::Path,
        call: &ToolCall,
        terminal: bool,
    ) -> (Vec<PendingWrite>, bool) {
        let call_id = call.id.as_str();
        let mut pending = lock_ok(&self.pending_writes);

        let first_sighting = !pending.contains_key(call_id);
        if first_sighting {
            lock_ok(&self.session_calls)
                .entry(session_id.to_string())
                .or_default()
                .push(call_id.to_string());
            pending.insert(
                call_id.to_string(),
                WriteSample {
                    writes: Vec::new(),
                    recorded: false,
                },
            );
        }
        let sample = pending.get_mut(call_id).expect("just ensured");

        // Derived here rather than passed in: a caller that computed this for
        // the write-detection gate and then handed over a different slice is a
        // bug with no symptom, and the call is a walk over a handful of blocks.
        for raw in extract_paths(
            &call.locations,
            &diff_paths(&call.content_blocks),
            &call.arguments,
        ) {
            let mut path = resolve_path(&raw, project_root);
            // `resolve_path` is deliberately lexical, so an agent that reports
            // the CANONICAL form of a symlinked root — `/private/var/...` for a
            // project opened as `/var/...`, common on macOS, and exactly what
            // opencode does — fails the prefix strip, gets flagged
            // `out_of_repo`, and its touch can never match a commit. Retry
            // against the canonicalised root before accepting that verdict.
            if path.out_of_repo {
                if let Ok(real_root) = dunce::canonicalize(project_root) {
                    if real_root != project_root {
                        let retry = resolve_path(&raw, &real_root);
                        if !retry.out_of_repo {
                            path = retry;
                        }
                    }
                }
            }
            if sample.writes.iter().any(|w| w.path.path == path.path) {
                continue;
            }
            // The filesystem answers truthfully only when this sighting
            // precedes the write: the first sighting of a call that is not yet
            // terminal. Anything later — including a call whose *first*
            // sighting is already terminal — is post-write, where git's index
            // is the only source that still distinguishes "the agent created
            // this" from "the agent edited what was already here".
            let existed_before = if first_sighting && !terminal {
                project_root.join(&path.path).exists()
            } else {
                atlas_checkpoint::git::tracked_in_head(project_root, &path.path)
            };
            sample.writes.push(PendingWrite {
                path,
                existed_before,
            });
        }

        let already_recorded = sample.recorded;
        if terminal && !already_recorded {
            sample.recorded = true;
        }
        (sample.writes.clone(), already_recorded)
    }

    /// Attribute the files a SHELL command wrote, by watching the tree around it.
    ///
    /// A shell command names no file anywhere in the protocol — not in
    /// `locations`, not in a diff block, not in its arguments — so `sed -i`, a
    /// redirect, a Makefile or a script left the Session nominating nothing and
    /// therefore never earning a checkpoint (#27). The only evidence available
    /// is the tree itself: what differed from HEAD before the command, and what
    /// differs after.
    ///
    /// Deliberately silent when it cannot be sure, because a WRONG path is
    /// worse than a missing one — it keeps linking the user's later commits to
    /// this Session. Nothing is attributed when:
    ///
    /// - there is no "before" (the call's first sighting was already terminal,
    ///   so the command had already run when we first heard of it),
    /// - either snapshot failed or the project is not a repository,
    /// - the command ran longer than [`SHELL_WINDOW_LIMIT`].
    ///
    /// What it still cannot see: an edit the developer made OUTSIDE Atlas while
    /// the command ran. Within Atlas that is knowable; in another editor it is
    /// not, and this deliberately does not guess.
    fn shell_window(
        &self,
        session_id: &str,
        call_id: &str,
        project_root: &std::path::Path,
        terminal: bool,
    ) -> Vec<PendingWrite> {
        if terminal {
            self.ensure_git_watcher(project_root);
        }
        if !terminal {
            // Registered under the session so an open window is evicted when the
            // session ends. Taken and released BEFORE `shell_windows`, matching
            // the order `sample_writes` uses — the two must not interleave.
            {
                let mut calls = lock_ok(&self.session_calls);
                let seen = calls.entry(session_id.to_string()).or_default();
                if !seen.iter().any(|id| id == call_id) {
                    seen.push(call_id.to_string());
                }
            }
            // First sighting, still running: this is the only moment the tree
            // is known to predate the command's writes.
            let mut windows = lock_ok(&self.shell_windows);
            if !windows.contains_key(call_id) {
                if let Some(before) = atlas_checkpoint::git::worktree_changes(project_root) {
                    windows.insert(
                        call_id.to_string(),
                        ShellWindow {
                            before,
                            head: HeadMark::read(project_root),
                            started: Instant::now(),
                        },
                    );
                }
            }
            return Vec::new();
        }

        let Some(window) = lock_ok(&self.shell_windows).remove(call_id) else {
            // No window means the call's FIRST sighting was already terminal —
            // some adapters announce a command exactly once, finished. The
            // per-call window cannot exist, so fall back to the turn anchor:
            // a HEAD that moved since the prompt is still exact evidence, just
            // coarser (the whole turn rather than one call). The anchor
            // advances after use, so a later call in the same turn cannot
            // re-claim these commits. No anchor, or an unmoved HEAD, stays
            // silent — same posture as everywhere else in this file.
            let anchored = lock_ok(&self.turn_heads).get(session_id).cloned();
            let (Some(before_head), Some(after_head)) =
                (anchored, atlas_checkpoint::git::head_commit(project_root))
            else {
                return Vec::new();
            };
            let Some((changes, commits)) = head_moved(project_root, &before_head, &after_head)
            else {
                return Vec::new();
            };
            lock_ok(&self.turn_heads).insert(session_id.to_string(), HeadMark::At(after_head));
            if !commits.is_empty() {
                lock_ok(&self.settled_commits).insert(call_id.to_string(), commits);
            }
            return changes
                .into_iter()
                .map(|change| {
                    let path = resolve_path(&change.path, project_root);
                    PendingWrite {
                        path,
                        existed_before: change.kind.existed_in_parent(),
                    }
                })
                .collect();
        };
        if window.started.elapsed() > SHELL_WINDOW_LIMIT {
            tracing::debug!(
                target: "atlas::capture",
                "shell call {call_id} ran for {:?}; too long to attribute its writes",
                window.started.elapsed()
            );
            return Vec::new();
        }
        let Some(after) = atlas_checkpoint::git::worktree_changes(project_root) else {
            return Vec::new();
        };

        let mut writes: Vec<PendingWrite> = after
            .difference(&window.before)
            .map(|raw| {
                let path = resolve_path(raw, project_root);
                // Post-write by construction, so git's index is the only source
                // that still distinguishes "created" from "edited" — the same
                // reasoning as the late-locations arm above.
                let existed_before =
                    atlas_checkpoint::git::tracked_in_head(project_root, &path.path);
                PendingWrite {
                    path,
                    existed_before,
                }
            })
            .collect();

        // A command that COMMITTED its own writes leaves the tree clean, so
        // the status difference above misses them entirely (#31). The moved
        // HEAD is evidence, not absence: what `before_head..after_head`
        // changed IS what the window can no longer see, with each path's
        // `existed_before` taken from the range's change kind — the
        // post-commit index would call every created file tracked. The
        // commits themselves are parked for the worker, which re-evaluates
        // exactly those after the touches land: the ordinary walk's cursor
        // has already gone past them.
        //
        // A call that commits TWICE links its final commit, not the
        // intermediate ones: the touch hashes the worktree at terminal time —
        // the final state — so an intermediate commit's blob fails the strict
        // arm, which deliberately does not consume the touch, leaving it live
        // for the commit whose content it actually is. One checkpoint for the
        // state the agent left is the honest summary of one call.
        let after_head = atlas_checkpoint::git::head_commit(project_root);
        if let (Some(before_head), Some(after_head)) = (&window.head, &after_head) {
            if let Some((changes, commits)) = head_moved(project_root, before_head, after_head) {
                for change in changes {
                    let path = resolve_path(&change.path, project_root);
                    if writes.iter().any(|w| w.path.path == path.path) {
                        continue;
                    }
                    writes.push(PendingWrite {
                        path,
                        existed_before: change.kind.existed_in_parent(),
                    });
                }
                if !commits.is_empty() {
                    lock_ok(&self.settled_commits).insert(call_id.to_string(), commits);
                }
                // The turn anchor moves with us, so the coarse fallback
                // can never re-claim commits a per-call window settled.
                lock_ok(&self.turn_heads)
                    .insert(session_id.to_string(), HeadMark::At(after_head.clone()));
            }
        }

        writes
    }

    /// The commits a closed window saw HEAD move across, if any. Taken once —
    /// by the worker, when it records the call's writes.
    fn take_settled_commits(&self, call_id: &str) -> Vec<String> {
        lock_ok(&self.settled_commits)
            .remove(call_id)
            .unwrap_or_default()
    }

    /// Drop any shell window still open for a session's calls. Called when the
    /// session ends, so a command that never reported a terminal status does
    /// not hold its snapshot for the life of the process.
    fn forget_shell_windows(&self, call_ids: &[String]) {
        let mut windows = lock_ok(&self.shell_windows);
        let mut settled = lock_ok(&self.settled_commits);
        for id in call_ids {
            windows.remove(id);
            settled.remove(id);
        }
    }

    /// Drop a session's turn anchor with the session.
    fn forget_turn_head(&self, session_id: &str) {
        lock_ok(&self.turn_heads).remove(session_id);
    }

    fn submit_sync(&self, request: SyncRequest) {
        if self.sync_tx.send(request).is_err() {
            tracing::error!(target: "atlas::capture", "capture sync worker is gone; nothing will be sent");
        }
    }

    fn submit(&self, job: Job) {
        // A dead worker must not take the agent down with it. The turn is lost,
        // which is what the capture-health signal exists to surface.
        if self.tx.send(job).is_err() {
            tracing::error!(target: "atlas::capture", "capture worker is gone; turn not recorded");
        }
    }
}

impl Default for CaptureState {
    fn default() -> Self {
        Self::new()
    }
}

/// The highest turn number already recorded for a session, or 0.
///
/// Read through a reader connection so the send path never contends for the
/// writer; run only on the first sighting of a session in this process.
fn seed_turn_seq(root: &Path, source: Source, native_session_id: &str) -> i64 {
    if !enabled_on_disk(root) {
        return 0;
    }
    let Ok(store) = Store::open_reader(atlas_checkpoint::atlas_dir(root)) else {
        return 0;
    };
    let workspace_id = project_id_for(root);
    let Ok(Some(session_id)) = store.session_id_for(&workspace_id, source, native_session_id)
    else {
        return 0;
    };
    store.max_turn_seq(&session_id).unwrap_or(0)
}

// ── Command surface ─────────────────────────────────────────────────────────
//
// Every command is async with its work inside `spawn_blocking`: Tauri v2 runs
// non-async commands on the main thread, and several of these do 30-second
// network calls or bulk store reads — a beachball per click otherwise. Names
// and arguments are unchanged; `invoke` is transparent to async.

/// What Atlas can work out about a directory before anything is bound.
///
/// Drives the popover's "Detected" block: origin, root commit, whether this is
/// a repository at all.
#[tauri::command]
pub async fn capture_detect(
    project_path: String,
) -> Result<atlas_checkpoint::ProjectDetection, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(atlas_checkpoint::detect(std::path::Path::new(
            &project_path,
        )))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// How this Project is bound, or `null` if capture was never enabled.
#[tauri::command]
pub async fn capture_binding(
    project_path: String,
) -> Result<Option<atlas_checkpoint::Binding>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(store) = open_reader(&project_path)? else {
            return Ok(None);
        };
        store.binding().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Turn capture on for this Project — Local mode only.
///
/// Local mode makes no network call and needs no account, which is the whole
/// point: Atlas has to be useful before anyone signs up for anything.
///
/// Cloud is deliberately rejected here. A Cloud Project must be settled on
/// the server first (Slug, Organisation, project id) or it is half-bound:
/// rows queue as `pending` forever with nowhere to go. `capture_register_cloud`
/// is the only Cloud-create path.
#[tauri::command]
pub async fn capture_enable(
    project_path: String,
    mode: String,
    app: AppHandle,
) -> Result<atlas_checkpoint::Binding, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mode =
            ProjectMode::parse(&mode).ok_or_else(|| format!("unknown project mode: {mode}"))?;
        if mode == ProjectMode::Cloud {
            return Err("Cloud requires registration — use capture_register_cloud".to_string());
        }
        let root = std::path::Path::new(&project_path);
        let state = app.state::<CaptureState>();
        // The process-wide writer, not a second store on the same directory:
        // that is what used to lose the writer lock to Atlas's own capture
        // worker and report a nonexistent second window.
        let handle = state.writer(root)?;
        let store = lock_ok(&handle);

        // Re-enabling must not demote: a registered Cloud Project whose user
        // clicks Enable again keeps its mode (and its org, slug and remote id —
        // `upsert_binding` never touches those columns). Local→Cloud only goes
        // through register/promote; Cloud→Local would need an explicit
        // demotion flow that does not exist yet.
        let effective_mode = match store.binding().map_err(|e| e.to_string())? {
            Some(existing) if existing.mode == ProjectMode::Cloud => ProjectMode::Cloud,
            _ => mode,
        };

        atlas_checkpoint::bind(&store, &project_path, root, effective_mode)
            .map_err(|e| e.to_string())?;

        // Local imports without ceremony — nothing leaves the machine — so the
        // approval that gates the background scan is granted here. A Cloud
        // Project is a bulk disclosure and waits for `capture_import_confirm`.
        if effective_mode == ProjectMode::Local {
            store.set_import_approved(true).map_err(|e| e.to_string())?;
        }

        let binding = store
            .binding()
            .map_err(|e| e.to_string())?
            .ok_or("binding vanished")?;
        drop(store);

        // Establish the commit cursor now-ish, so the first commit after
        // enabling is linked rather than waiting for a walk with no baseline.
        // Enqueued rather than run inline: the walk can touch 200 commits, and
        // holding the store mutex through it stalls the worker and the click.
        state.note_git_change(root);

        // Backfill this project's existing transcripts, so the timeline is
        // populated now rather than months from now.
        if effective_mode == ProjectMode::Local {
            state.note_import(root);
        }
        Ok(binding)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// What importing this Project's transcripts would disclose.
///
/// Real numbers, before the decision — how many Sessions, over what dates, how
/// much data. A developer cannot otherwise know what they are about to publish,
/// and this is one of only two bulk-disclosure moments in the whole feature.
#[tauri::command]
pub async fn capture_import_preview(
    project_path: String,
) -> Result<atlas_checkpoint::ImportPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = open_reader(&project_path)?;
        let mode = store
            .as_ref()
            .and_then(|s| s.binding().ok().flatten())
            .map(|b| b.mode)
            .unwrap_or(ProjectMode::Local);
        let root = std::path::Path::new(&project_path);
        let Some(source) = transcript_source_for(root) else {
            return Ok(atlas_checkpoint::ImportPreview::default());
        };
        // With a store at hand the preview excludes already-imported files and
        // cross-source duplicates — the disclosure dialog must lead with what a
        // confirm would actually publish, not the total sitting on disk.
        Ok(match &store {
            Some(s) => {
                atlas_checkpoint::import::preview_with_store(s, &project_path, &source, mode)
            }
            None => atlas_checkpoint::import_preview(&source, mode),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The developer confirmed the bulk import — record the approval, then start.
///
/// The persisted flag is the actual gate: `import_for` refuses a Cloud
/// Project without it, so cancelling the dialog (flag never set) means the
/// 30-second background scan imports nothing, forever, until confirmed.
#[tauri::command]
pub async fn capture_import_confirm(project_path: String, app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = std::path::Path::new(&project_path);
        let state = app.state::<CaptureState>();
        let handle = state.writer(root)?;
        {
            let store = lock_ok(&handle);
            store.set_import_approved(true).map_err(|e| e.to_string())?;
        }
        state.note_import(root);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn refresh_inner(
    project_path: &str,
    app: &AppHandle,
) -> Result<Option<atlas_checkpoint::Binding>, String> {
    let root = std::path::Path::new(project_path);
    // Refreshing detection must never be what plants `.atlas/` in a Project
    // whose capture was never enabled — `git init` from the popover's offer
    // runs this too, and opening the writer would create the store as a side
    // effect. No store yet means nothing to refresh.
    if !atlas_checkpoint::atlas_dir(root)
        .join("sessions.db")
        .exists()
    {
        return Ok(None);
    }
    let state = app.state::<CaptureState>();
    let handle = state.writer(root)?;
    let binding = {
        let store = lock_ok(&handle);
        atlas_checkpoint::refresh_detection(&store, root).map_err(|e| e.to_string())?
    };
    if binding.is_some() {
        state.note_git_change(root);
    }
    Ok(binding)
}

/// Stop capturing. Nothing already recorded is deleted, and rows already
/// queued keep draining — pausing is about *new* records.
#[tauri::command]
pub async fn capture_disable(project_path: String, app: AppHandle) -> Result<(), String> {
    let hook_app = app.clone();
    let hook_path = project_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let handle = app
            .state::<CaptureState>()
            .writer(std::path::Path::new(&project_path))?;
        let store = lock_ok(&handle);
        atlas_checkpoint::disable(&store).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    // A disabled Project must leave the socket set, not keep a subscription.
    crate::commands::artifacts_cloud::resync_targets(&hook_app, Some(&hook_path));
    Ok(())
}

/// Initialise a repository in a non-git Project, then re-detect.
///
/// Framed in the UI as unlocking commit linkage rather than as a requirement,
/// because that is what it is: Sessions are captured either way.
#[tauri::command]
pub async fn capture_git_init(
    project_path: String,
    app: AppHandle,
) -> Result<Option<atlas_checkpoint::Binding>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let status = atlas_process::command("git")
            .arg("-C")
            .arg(&project_path)
            .arg("init")
            .output()
            .map_err(|e| format!("git init: {e}"))?;
        if !status.status.success() {
            return Err(String::from_utf8_lossy(&status.stderr).trim().to_string());
        }
        refresh_inner(&project_path, &app)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A bound Project just became active — make sure its store is open (which
/// also runs the folder-rename re-key) and give its import and drain a kick.
///
/// This is what closes the restart hole for non-git Projects: the 30-second
/// tick only covers stores this process has opened, a git Project gets opened
/// by the watcher's open-time walk, and a non-git one previously waited for the
/// first prompt. The frontend calls this on project activation.
#[tauri::command]
pub async fn capture_activate(project_path: String, app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = std::path::Path::new(&project_path);
        if !enabled_on_disk(root) {
            return Ok(());
        }
        let state = app.state::<CaptureState>();
        // Opening the writer registers the store with the worker's tick and
        // performs the rename re-key. A failure (another process holds it) is
        // fine — that process is doing the capturing.
        let _ = state.writer(root);
        state.note_import(root);
        state.note_drain(root);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Give every failed row another chance and drain immediately.
///
/// The recovery action behind the health signal's "N records could not be
/// sent" — the `failed → pending` transition is a deliberate human action,
/// never automatic.
#[tauri::command]
pub async fn capture_retry_failed(project_path: String, app: AppHandle) -> Result<i64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = std::path::Path::new(&project_path);
        let state = app.state::<CaptureState>();
        let handle = state.writer(root)?;
        let retried = {
            let store = lock_ok(&handle);
            store
                .retry_failed_rows(&project_path)
                .map_err(|e| e.to_string())?
        };
        state.note_drain(root);
        Ok(retried)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The capture-health state for a Project.
///
/// Watcher liveness is read from the watcher registry itself rather than
/// inferred from "no events lately" — a quiet repository and a dead watcher are
/// indistinguishable from the event stream, which is exactly how the clear-all
/// bug stayed invisible.
///
/// **A missing watcher is healed here, not reported here.** An Organisation
/// switch tears down every mounted Project and restarts the incoming one's
/// watcher; if that restart loses a race, health had no way to do anything but
/// tell the user to reopen the Project — advice for a problem one idempotent
/// call fixes. So the poll attempts the restart itself and only reports what is
/// still broken afterwards. `git_watch_start` is idempotent (it returns early
/// when the same root is already watched), so the attempt is free on the
/// overwhelmingly common healthy path.
#[tauri::command]
pub async fn capture_health(
    project_path: String,
    workspace_id: Option<String>,
    app: AppHandle,
) -> Result<atlas_checkpoint::CaptureHealth, String> {
    heal_git_watcher(&app, &project_path, workspace_id.as_deref()).await;

    tauri::async_runtime::spawn_blocking(move || {
        let root = std::path::Path::new(&project_path);
        // A reader, so a status poll never waits behind an import — and
        // therefore one that cannot answer whether this process holds the
        // writer lock. The registry is asked instead.
        let store = match open_reader_raw(&project_path) {
            Ok(Some(store)) => store,
            Ok(None) => {
                // Nothing has ever been captured here. That is the `Off` state,
                // and computing it needs no store.
                return Ok(off_health("Session capture is off"));
            }
            // The one failure the status indicator must not answer with its own
            // error: a store written by a newer build is a Stopped state with a
            // reason, not a broken indicator.
            Err(atlas_checkpoint::Error::SchemaTooNew { .. }) => {
                return Ok(atlas_checkpoint::CaptureHealth {
                    state: atlas_checkpoint::HealthState::Stopped,
                    summary: "This Project's session store was written by a newer Atlas".into(),
                    issues: vec![atlas_checkpoint::health::HealthIssue {
                        state: atlas_checkpoint::HealthState::Stopped,
                        reason: "This Project's session store was written by a newer version \
                                 of Atlas, so this build cannot record to it."
                            .into(),
                        next_step: "Update Atlas to keep capturing here.".into(),
                    }],
                    flagged_sessions: 0,
                    failed_rows: 0,
                    pending_rows: 0,
                });
            }
            Err(e) => return Err(e.to_string()),
        };

        let watchers = app.state::<super::git_watcher::GitWatcherState>();
        let capture = app.state::<CaptureState>();
        let expects_watcher = atlas_checkpoint::git::is_repository(root);
        // Checked under both keys the registry might hold: the project UUID
        // (what the frontend registers watchers under) and the repository root.
        // The root check means an omitted optional `workspace_id` cannot
        // manufacture a permanent false "Stopped".
        let watcher_attached = expects_watcher
            && (workspace_id
                .as_deref()
                .is_some_and(|id| watchers.is_watching(id))
                || watchers.is_watching_root(root));

        atlas_checkpoint::evaluate_health(
            &store,
            &project_path,
            atlas_checkpoint::HostSignals {
                watcher_attached,
                expects_watcher,
                holds_writer: capture.writer_claim(root),
                worker_alive: capture.is_worker_alive(),
            },
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Restart this Project's git watcher if it should have one and does not.
///
/// Silent and best-effort: this is a repair attempt on a status poll, so a
/// failure is not the poll's error to report — the health evaluation that runs
/// straight afterwards reads the registry again and says so properly.
///
/// Not a repository, or already watched, and this is a no-op.
async fn heal_git_watcher(app: &AppHandle, project_path: &str, workspace_id: Option<&str>) {
    let root = std::path::Path::new(project_path);
    if !atlas_checkpoint::git::is_repository(root) {
        return;
    }
    {
        let watchers = app.state::<super::git_watcher::GitWatcherState>();
        let attached = workspace_id.is_some_and(|id| watchers.is_watching(id))
            || watchers.is_watching_root(root);
        if attached {
            return;
        }
    }

    // Straight through the command the frontend calls on Project open, so
    // the repair path and the ordinary path cannot drift apart.
    let state = app.state::<super::git_watcher::GitWatcherState>();
    if let Err(e) = super::git_watcher::git_watch_start(
        project_path.to_string(),
        workspace_id.map(str::to_string),
        app.clone(),
        state,
    )
    .await
    {
        tracing::warn!(
            target: "atlas::capture",
            project = %project_path,
            "git watcher self-heal failed: {e}"
        );
    }
}

/// Restart the git watcher for a Project and report the health that results.
///
/// The retry behind the health banner. Distinct from the silent heal on every
/// poll because this one is a human pressing a button: it runs the same repair
/// and then answers with the *new* state, so the banner either clears or says
/// what is still wrong — rather than clearing optimistically and reappearing on
/// the next poll.
#[tauri::command]
pub async fn capture_retry_watcher(
    project_path: String,
    workspace_id: Option<String>,
    app: AppHandle,
) -> Result<atlas_checkpoint::CaptureHealth, String> {
    capture_health(project_path, workspace_id, app).await
}

fn off_health(summary: &str) -> atlas_checkpoint::CaptureHealth {
    atlas_checkpoint::CaptureHealth {
        state: atlas_checkpoint::HealthState::Off,
        summary: summary.into(),
        issues: Vec::new(),
        flagged_sessions: 0,
        failed_rows: 0,
        pending_rows: 0,
    }
}

/// One Session as an ordered timeline.
///
/// Commit subjects are resolved from git here rather than in the crate: this is
/// the layer that knows the Project root, and git remains the single source of
/// truth for a commit message rather than a copy in the store that goes stale
/// after a reword.
#[tauri::command]
pub async fn artifacts_session(
    project_path: String,
    session_id: String,
) -> Result<Option<atlas_checkpoint::SessionDetail>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = std::path::Path::new(&project_path).to_path_buf();
        let Some(store) = open_reader(&project_path)? else {
            return Ok(None);
        };

        // A Session usually carries a handful of Checkpoints, but one `git show`
        // per Checkpoint is still a process spawn each. Resolving them once up
        // front keeps a long Session from paying that cost repeatedly.
        let mut subjects: HashMap<String, String> = HashMap::new();
        if atlas_checkpoint::git::is_repository(&root) {
            for checkpoint in store
                .checkpoints_for_session(&session_id)
                .map_err(|e| e.to_string())?
            {
                if let Ok(info) = atlas_checkpoint::git::commit_info(&root, &checkpoint.commit_sha)
                {
                    subjects.insert(checkpoint.commit_sha, info.subject);
                }
            }
        }

        atlas_checkpoint::session_detail(&store, &session_id, |sha| subjects.get(sha).cloned())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One Session's summary row, looked up by the AGENT's own session id.
///
/// The composer's Usage popup has the ACP session id (it is the JSONL stem and
/// the protocol id both) and nothing else; the store keys rows by its own id
/// with the agent's under `native_session_id`, per source. `None` when capture
/// is off for the project or the session was never recorded — the popup then
/// simply has no "session" section, rather than a row of zeroes.
#[tauri::command]
pub async fn capture_session_summary(
    project_path: String,
    session_id: String,
) -> Result<Option<atlas_checkpoint::SessionSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(store) = open_reader(&project_path)? else {
            return Ok(None);
        };
        let workspace_id = project_id_for(Path::new(&project_path));
        // An in-app session is recorded under exactly one of these two sources;
        // the on-disk JSONL import of the same session is deliberately a
        // separate row and is not what a live composer is asking about.
        let mut row_id = None;
        for source in [Source::Acp, Source::Native] {
            row_id = store
                .session_id_for(&workspace_id, source, &session_id)
                .map_err(|e| e.to_string())?;
            if row_id.is_some() {
                break;
            }
        }
        let Some(row_id) = row_id else {
            return Ok(None);
        };
        atlas_checkpoint::session_summary(&store, &row_id).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Where a board row was read from.
///
/// `Both` is the normal state of your own work once a Project is synced: it is
/// on this disk *and* on the server. It matters because it says a row can be
/// opened locally — which is faster, and works offline — while still carrying
/// comments.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionOrigin {
    /// This machine only. No comments, because there is nothing to anchor to.
    Local,
    /// A teammate's Session, or your own from another machine.
    Remote,
    Both,
}

/// One row on the Timeline board, tagged with the project it came from.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardSession {
    #[serde(flatten)]
    pub session: atlas_checkpoint::SessionSummary,
    /// Needed to read the Session back: each project has its own store, so the
    /// board has to remember which one a row came from. Empty for a Session
    /// from a Project this machine has no checkout of.
    pub project_path: String,
    pub project_name: String,
    /// Is this Session on the server? True for every remote row, and for a
    /// local row whose Project is bound to Cloud.
    ///
    /// Deliberately **Project-level, not row-level**: "has every one of this
    /// Session's rows drained" would need an outbox scan per Session on a read
    /// that runs on every capture event, to answer a question the developer is
    /// not asking. The queue depth is already reported by `capture_health`.
    pub synced: bool,
    pub origin: SessionOrigin,
    /// The server Project id, for the reads and the socket. `None` on a
    /// Project that was never connected.
    pub remote_project_id: Option<String>,
    /// Stamped server-side from the verified token. `None` on a local row —
    /// a Session on this disk is this account's by construction.
    pub author_id: Option<String>,
}

/// Fold a remote Session into the local read model.
///
/// The wire does not carry four things the local model has, and they are filled
/// with the honest empty value rather than invented: the Session's **starting**
/// branch (only Checkpoint branches survive the push), `needs_attention` and
/// its reason (a local-capture concern that means nothing about someone else's
/// machine), and the input/output token split (the server keeps only the sum
/// and the two cache figures).
///
/// `active_seconds` is also not the desktop's figure for the same Session — the
/// server derives it from gap-capped message intervals, the desktop from turn
/// spans. They legitimately disagree; the server says so on every row.
pub(crate) fn remote_summary(
    remote: atlas_artifacts::RemoteSession,
) -> atlas_checkpoint::SessionSummary {
    atlas_checkpoint::SessionSummary {
        id: remote.id,
        title: remote.title,
        agent: remote.agent,
        model: remote.model,
        source: remote.source,
        started_at: remote.started_at,
        updated_at: remote.updated_at,
        last_activity_at: remote.last_activity_at,
        active_seconds: remote.active_seconds,
        wall_seconds: remote.wall_seconds,
        message_count: remote.message_count,
        tool_call_count: remote.tool_call_count,
        checkpoint_count: remote.checkpoint_count,
        branches: remote.branches,
        insertions: remote.insertions,
        deletions: remote.deletions,
        files_touched: remote.files_touched,
        total_tokens: remote.total_tokens,
        input_tokens: remote.input_tokens,
        output_tokens: remote.output_tokens,
        cache_creation_tokens: remote.cache_creation_tokens,
        cache_read_tokens: remote.cache_read_tokens,
        context_used: remote.context_used,
        context_size: remote.context_size,
        needs_attention: false,
        attention_reason: None,
    }
}

/// Every Session across the Organisation's projects, newest first.
///
/// The board is Organisation-scoped rather than project-scoped: the question it
/// answers — what has been happening in our code — does not stop at the folder
/// that happens to be open. Filtering back down to one project is a display
/// concern, done client-side over this list.
///
/// A project with capture off contributes nothing and is not an error; most
/// projects in the list will be in that state until they are turned on.
/// Most rows the board will return in one read.
///
/// Not a storage limit — every Session stays queryable, and narrowing to one
/// project reads that project unbounded. It caps what crosses the IPC boundary
/// and reaches the list, which renders every row it is given: an Organisation
/// with forty captured projects would otherwise ship tens of thousands of rows
/// every refresh to render a screenful.
const BOARD_LIMIT: usize = 500;

#[tauri::command]
pub async fn artifacts_board(projects: Vec<String>, app: AppHandle) -> Result<BoardPage, String> {
    // Read the cloud cache first, on this thread: it is a lock and a clone, and
    // taking it before the blocking hop keeps the `AppHandle` out of there.
    //
    // **Never a network call.** This read runs on every capture event and every
    // git change while the Timeline is open; awaiting the ingest service here
    // would stall a list whose whole appeal is that it is instant, and would
    // leave it empty offline where the local Sessions are perfectly readable.
    // The cache is filled on a ticker and by the socket instead.
    let cloud = cloud_snapshot(&app);
    let cloud_pending = cloud.pending;
    let cloud_failed = cloud.failed;
    let (remote, remote_names) = (cloud.sessions, cloud.names);
    // For local rows that do not know their Project's server id (never synced,
    // or bound by an older build): the only thing they can be matched on.
    let remote_ids: HashSet<String> = remote.keys().map(|(_, id)| id.clone()).collect();

    tauri::async_runtime::spawn_blocking(move || {
        // One project means the board is filtered, and the caller wants that
        // project's history rather than a slice of the newest across all of
        // them — so the cap does not apply.
        let single = projects.len() == 1;
        let limit = if single { usize::MAX } else { BOARD_LIMIT };
        let mut out: Vec<BoardSession> = Vec::new();
        // Which remote Projects this machine has a checkout of, so a teammate's
        // Session lands under the name the developer already knows it by.
        let mut local_projects: HashMap<String, (String, String)> = HashMap::new();

        for project_path in projects {
            // One unreadable store must not blank the whole board — the other
            // projects' history is still good.
            let Ok(Some(store)) = open_reader(&project_path) else {
                continue;
            };
            let workspace_id = project_id_for(Path::new(&project_path));
            let Ok(summaries) = atlas_checkpoint::session_summaries(&store, &workspace_id) else {
                continue;
            };
            let folder_name = Path::new(&project_path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| project_path.clone());

            // Synced-ness is a property of the Project, read once per Project
            // rather than per Session.
            let binding = store.binding().ok().flatten();
            let remote_project_id = binding.as_ref().and_then(|b| b.remote_workspace_id.clone());

            // A connected Project is named by the Organisation, not by whatever
            // this machine happened to call the folder. Two people who cloned
            // into differently-named directories must still see one Project on
            // a shared timeline.
            let project_name = remote_project_id
                .as_ref()
                .and_then(|id| remote_names.get(id).cloned())
                .unwrap_or(folder_name);
            let synced = binding
                .as_ref()
                .is_some_and(|b| b.mode == atlas_checkpoint::ProjectMode::Cloud);
            if let Some(ref id) = remote_project_id {
                local_projects.insert(id.clone(), (project_path.clone(), project_name.clone()));
            }

            out.extend(summaries.into_iter().map(|session| BoardSession {
                // A local row this Project has pushed is on both sides. We do
                // not know per-row whether it drained, and do not need to: the
                // point of `Both` is that it can be opened from disk.
                origin: if match &remote_project_id {
                    Some(project) => remote.contains_key(&(project.clone(), session.id.clone())),
                    None => remote_ids.contains(&session.id),
                } {
                    SessionOrigin::Both
                } else {
                    SessionOrigin::Local
                },
                session,
                project_path: project_path.clone(),
                project_name: project_name.clone(),
                synced,
                remote_project_id: remote_project_id.clone(),
                author_id: None,
            }));
        }

        // Everything the Organisation has that this machine does not. Keyed by
        // (Project, Session): the Session id is the one the local store minted
        // and pushed verbatim, but one Session can live in two Projects — a
        // Project whose sync was moved leaves its copy in the old one. A local
        // row only stands in for the remote copy in its own Project; the other
        // copy is a separate row. A local row with no Project id falls back to
        // matching on the Session id alone, as before.
        let mut seen: HashSet<(String, String)> = HashSet::new();
        let mut seen_unbound: HashSet<String> = HashSet::new();
        for row in &out {
            match &row.remote_project_id {
                Some(project) => {
                    seen.insert((project.clone(), row.session.id.clone()));
                }
                None => {
                    seen_unbound.insert(row.session.id.clone());
                }
            }
        }
        for (key, row) in remote {
            if seen.contains(&key) || seen_unbound.contains(&key.1) {
                continue;
            }
            let (project_path, project_name) = local_projects
                .get(&row.workspace_id)
                .cloned()
                // No checkout here: leave the path empty so the opener reads it
                // over the network, and name it as the Organisation does.
                .unwrap_or_else(|| {
                    let label = remote_names
                        .get(&row.workspace_id)
                        .cloned()
                        .unwrap_or_else(|| row.workspace_slug.clone());
                    (String::new(), label)
                });
            out.push(BoardSession {
                project_path,
                project_name,
                synced: true,
                origin: SessionOrigin::Remote,
                remote_project_id: Some(row.workspace_id.clone()),
                author_id: row.author_id.clone(),
                session: remote_summary(row),
            });
        }

        // One ordering across every project, so the board reads as a timeline
        // rather than as concatenated per-project lists. Sorting before the cap
        // is what makes the cap mean "newest" rather than "whichever projects
        // happened to be read first".
        // On last activity, matching `session_summaries`' own ordering — the cap
        // has to mean "most recently worked on", and a Session started in June
        // and resumed today is today's work.
        out.sort_by(|a, b| b.session.last_activity_at.cmp(&a.session.last_activity_at));
        out.truncate(limit);
        Ok(BoardPage {
            sessions: out,
            cloud_pending,
            cloud_failed,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The board, plus whether it is finished arriving.
///
/// `cloud_pending` exists because an empty board has two very different
/// meanings and the viewer could not tell them apart: a synced Organisation
/// whose first remote read is still in flight has no local rows to show, and
/// rendering "No sessions captured yet" at that moment is simply wrong — the
/// list appears a moment later. It is false for a local-only Organisation,
/// which has no remote half to wait on.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardPage {
    pub sessions: Vec<BoardSession>,
    pub cloud_pending: bool,
    /// The remote half could not be read at all. The rows below are this
    /// machine's, plus whatever an earlier refresh had cached — a partial view
    /// the viewer has to label rather than present as the whole board.
    pub cloud_failed: bool,
}

/// The Organisation's remote Sessions as of the last refresh, keyed by
/// `(Project id, Session id)`.
///
/// Empty when signed out, in a local-only Organisation, or before the first
/// refresh lands — all three of which mean "show the local board", which is a
/// complete answer rather than a degraded one.
/// The remote board as of the last refresh.
#[derive(Default)]
struct CloudSnapshot {
    sessions: HashMap<atlas_artifacts::SessionKey, atlas_artifacts::RemoteSession>,
    /// Project id → the name the Organisation gave that Project.
    names: HashMap<String, String>,
    /// The first refresh for this Organisation has not finished yet, so an
    /// empty board means "not looked" rather than "nothing here".
    pending: bool,
    /// Every refresh so far failed: the board is local-only and says so.
    failed: bool,
}

fn cloud_snapshot(app: &AppHandle) -> CloudSnapshot {
    let Some(state) = app.try_state::<crate::commands::artifacts_cloud::ArtifactsCloudState>()
    else {
        return CloudSnapshot::default();
    };
    // No synced Organisation: there is no remote half to wait for, so the local
    // board is the whole answer and is never pending.
    let Some(org_id) = state.org.lock().ok().and_then(|org| org.clone()) else {
        return CloudSnapshot::default();
    };
    let pending = state.board.is_pending(&org_id);
    let failed = state.board.has_failed(&org_id);
    let board = state.board.snapshot(&org_id);
    let names = board
        .projects
        .iter()
        .filter_map(|(id, project)| {
            // The name the Organisation chose, falling back to the handle it is
            // addressed by. Never the raw id — that is not a label.
            project
                .name
                .clone()
                .or_else(|| project.slug.clone())
                .map(|label| (id.clone(), label))
        })
        .collect();
    CloudSnapshot {
        sessions: board.sessions,
        names,
        pending,
        failed,
    }
}

/// One Checkpoint on the board, tagged with the project it came from.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardCheckpoint {
    #[serde(flatten)]
    pub checkpoint: atlas_checkpoint::CheckpointRow,
    /// Each project has its own store, so a jump has to remember which one.
    pub project_path: String,
    pub project_name: String,
}

/// How many Checkpoints the recent-commits picker reads across all projects.
///
/// Smaller than [`BOARD_LIMIT`] on purpose: this is a "jump to something you
/// remember doing" list, not a history. Anything older than the newest hundred
/// is found by opening its Session, which is what the board is for.
const CHECKPOINT_LIMIT: i64 = 100;

/// The newest Checkpoints across every project, most recent first.
///
/// Subjects are resolved from git here for the same reason as
/// [`artifacts_session`]: this layer knows the Project root, and git stays the
/// single source of truth for a commit message. Unlike that command this asks
/// git **once per project** with a batched log read rather than once per commit
/// — a hundred Checkpoints would otherwise be a hundred process spawns to fill
/// one dropdown.
#[tauri::command]
pub async fn artifacts_checkpoints(projects: Vec<String>) -> Result<Vec<BoardCheckpoint>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out: Vec<BoardCheckpoint> = Vec::new();
        for project_path in projects {
            // One unreadable store must not blank the whole list.
            let Ok(Some(store)) = open_reader(&project_path) else {
                continue;
            };
            let root = Path::new(&project_path).to_path_buf();
            let is_repo = atlas_checkpoint::git::is_repository(&root);

            let Ok(rows) = atlas_checkpoint::recent_checkpoints(
                &store,
                &project_id_for(&root),
                CHECKPOINT_LIMIT,
                |_| None,
            ) else {
                continue;
            };

            // Resolve subjects only for the shas this project actually returned.
            let mut subjects: HashMap<String, String> = HashMap::new();
            if is_repo {
                for row in &rows {
                    if subjects.contains_key(&row.commit_sha) {
                        continue;
                    }
                    if let Ok(info) = atlas_checkpoint::git::commit_info(&root, &row.commit_sha) {
                        subjects.insert(row.commit_sha.clone(), info.subject);
                    }
                }
            }

            let project_name = root
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| project_path.clone());

            out.extend(rows.into_iter().map(|mut row| {
                row.commit_subject = subjects.get(&row.commit_sha).cloned();
                BoardCheckpoint {
                    checkpoint: row,
                    project_path: project_path.clone(),
                    project_name: project_name.clone(),
                }
            }));
        }
        // One ordering across every project, then cap — so the list means
        // "newest" rather than "whichever project was read first".
        out.sort_by(|a, b| b.checkpoint.at.cmp(&a.checkpoint.at));
        out.truncate(CHECKPOINT_LIMIT as usize);
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One Session that produced a commit.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSession {
    pub session_id: String,
    /// The first prompt, redacted — what was asked of the agent.
    pub title: Option<String>,
    pub message_count: i64,
    pub tool_call_count: i64,
    /// The files this Session contributed to *this* commit — which is what
    /// separates the two when a commit combines the work of two agents.
    pub files: Vec<String>,
}

/// The Sessions behind one commit, for the git panel's "why is this like this".
///
/// The board is not where this question gets asked — a developer asks it while
/// looking at a commit, which is why the record has to be reachable from there
/// rather than only from the Artifacts tab.
///
/// Reads only, so it is safe from a second window, same as the other artifact
/// readers. A Project with capture off returns nothing rather than erroring:
/// the git panel renders for every repository, most of which are not recorded.
#[tauri::command]
pub async fn capture_commit_sessions(
    project_path: String,
    commit_sha: String,
) -> Result<Vec<CommitSession>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(store) = open_reader(&project_path)? else {
            return Ok(Vec::new());
        };
        let checkpoints = store
            .checkpoints_for_commit(&commit_sha)
            .map_err(|e| e.to_string())?;

        let mut out = Vec::with_capacity(checkpoints.len());
        for checkpoint in checkpoints {
            // An orphaned Checkpoint has had its claim on a commit withdrawn by
            // reconciliation — it keeps the old sha as a record, not as an
            // assertion. Answering "what produced this commit" with one would
            // re-assert exactly the link that was deliberately given up.
            if checkpoint.link_state != atlas_checkpoint::LinkState::Linked {
                continue;
            }
            // A Checkpoint whose Session has been pruned is skipped rather than
            // rendered blank — the row exists to open the conversation.
            let Some(session) = store
                .session(&checkpoint.session_id)
                .map_err(|e| e.to_string())?
            else {
                continue;
            };
            out.push(CommitSession {
                message_count: store
                    .message_count(&session.id)
                    .map_err(|e| e.to_string())?,
                tool_call_count: store
                    .tool_call_count(&session.id)
                    .map_err(|e| e.to_string())?,
                session_id: session.id,
                title: session.title,
                files: checkpoint.files_touched,
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One spilled payload — a message body, a tool call's arguments or its
/// result — fetched on demand by "Show full" in the timeline.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactPayload {
    /// The payload as text, or `None` when it is not valid UTF-8.
    pub text: Option<String>,
    /// The payload was binary and `text` is absent.
    pub binary: bool,
    /// Size on disk, so the viewer can say what it is about to render.
    pub bytes: usize,
}

/// Fetch a spilled blob by its content key.
///
/// The timeline inlines bodies up to 64 KB and sends a preview plus a blob ref
/// for anything larger. This is the other half of that trade: the full payload,
/// fetched only when a developer actually asks for it, over its own reader
/// connection so it never waits behind the writer.
#[tauri::command]
pub async fn artifacts_payload(
    project_path: String,
    blob_ref: String,
) -> Result<ArtifactPayload, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = open_reader(&project_path)?.ok_or("this Project has no session store")?;
        let bytes = store.blobs().get(&blob_ref).map_err(|e| e.to_string())?;
        let len = bytes.len();
        Ok(match String::from_utf8(bytes) {
            Ok(text) => ArtifactPayload {
                text: Some(text),
                binary: false,
                bytes: len,
            },
            Err(_) => ArtifactPayload {
                text: None,
                binary: true,
                bytes: len,
            },
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Is this Slug free within the Organisation?
///
/// Debounced by the caller so the answer arrives while the developer is still
/// typing, rather than as a rejection after they commit to a name.
#[tauri::command]
pub async fn capture_slug_available(
    project_path: String,
    org_id: String,
    slug: String,
    app: AppHandle,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let token = token_provider(&app);
        let config = sync_config(&project_path, &org_id, &token);
        Ok(match atlas_checkpoint::sync::check_slug(&config, &slug) {
            atlas_checkpoint::SlugAvailability::Available => "available",
            atlas_checkpoint::SlugAvailability::Taken => "taken",
            // Distinct from "taken": telling a developer their name is gone when
            // the network merely blinked is a lie they will act on.
            atlas_checkpoint::SlugAvailability::Unknown => "unknown",
        }
        .to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Register this Project with an Organisation and switch it to Cloud.
///
/// **Server first.** The Slug is unique within the Organisation, so it has to be
/// settled server-side before any local state changes — otherwise a rejected
/// Slug leaves a half-bound Project behind. A failure here leaves the
/// Project capturing locally, which is a retryable state rather than a broken
/// one.
///
/// The network round-trip runs *outside* the store mutex: registration can take
/// the full 30-second timeout, and holding the writer lock through it would
/// stall the capture worker and every other capture command.
#[tauri::command]
pub async fn capture_register_cloud(
    project_path: String,
    org_id: String,
    slug: String,
    name: Option<String>,
    visibility: Option<String>,
    git_url: Option<String>,
    app: AppHandle,
) -> Result<atlas_checkpoint::Binding, String> {
    let hook_app = app.clone();
    let hook_path = project_path.clone();
    let binding = tauri::async_runtime::spawn_blocking(
        move || -> Result<atlas_checkpoint::Binding, String> {
            let state = app.state::<CaptureState>();
            let root = std::path::Path::new(&project_path);

            // Short lock: read the advisory identity signals, then release.
            let (root_commit_sha, detected_git_url) = {
                let handle = state.writer(root)?;
                let store = lock_ok(&handle);
                let binding = store
                    .binding()
                    .map_err(|e| e.to_string())?
                    .ok_or("enable capture for this Project first")?;
                (binding.root_commit_sha, binding.git_url)
            };

            // The developer may have typed a Repository URL, or cleared the one we
            // detected. An explicit empty string means "no remote", which is not
            // the same as "we did not look".
            let git_url = match git_url {
                Some(typed) => {
                    let typed = typed.trim().to_string();
                    (!typed.is_empty()).then_some(typed)
                }
                None => detected_git_url,
            };

            let token = token_provider(&app);
            let config = sync_config(&project_path, &org_id, &token);

            // Advisory only — the server must accept a registration with neither.
            // The returned id is the Project's wire identity from here on.
            let remote_workspace_id = atlas_checkpoint::register_workspace(
                &config,
                atlas_checkpoint::Registration {
                    slug: &slug,
                    name: name.as_deref(),
                    root_commit_sha: root_commit_sha.as_deref(),
                    git_url: git_url.as_deref(),
                    visibility: visibility
                        .as_deref()
                        .map(atlas_checkpoint::Visibility::parse)
                        .unwrap_or_default(),
                },
            )
            .map_err(|e| e.to_string())?;

            let handle = state.writer(root)?;
            let store = lock_ok(&handle);
            store
                .set_cloud_binding(&org_id, &slug, Some(&remote_workspace_id))
                .map_err(|e| e.to_string())?;
            store
                .binding()
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "binding vanished".into())
        },
    )
    .await
    .map_err(|e| e.to_string())??;
    // The binding now names a server Project; open its socket without waiting
    // for something unrelated to re-run the renderer's retarget.
    crate::commands::artifacts_cloud::resync_targets(&hook_app, Some(&hook_path));
    Ok(binding)
}

/// The Organisation's Projects, with the one this repository most likely
/// belongs to already picked out.
///
/// Returns no pre-selection when several match — every repository created from
/// the same GitHub template shares a root commit, so a match is not proof, and a
/// confident wrong answer pollutes a *shared* timeline with foreign Sessions.
#[tauri::command]
pub async fn capture_connect_options(
    project_path: String,
    org_id: String,
    app: AppHandle,
) -> Result<ConnectOptions, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let token = token_provider(&app);
        let config = sync_config(&project_path, &org_id, &token);
        let projects = atlas_checkpoint::list_workspaces(&config).map_err(|e| e.to_string())?;

        let detection = atlas_checkpoint::detect(std::path::Path::new(&project_path));
        let chosen = atlas_checkpoint::preselect(
            &projects,
            detection.root_commit_sha.as_deref(),
            detection.git_url.as_deref(),
        );

        Ok(match chosen {
            atlas_checkpoint::Preselection::One { project, .. } => ConnectOptions {
                workspaces: projects,
                preselected: Some(project.id),
                // A shallow clone's fingerprint is a graft boundary rather than
                // the true root, so even a match is worth flagging.
                warning: detection.is_shallow.then(|| {
                    "This is a shallow clone, so its fingerprint is not authoritative.".into()
                }),
            },
            atlas_checkpoint::Preselection::Ambiguous { candidates } => ConnectOptions {
                workspaces: projects,
                preselected: None,
                warning: Some(format!(
                    "{} Projects share this repository\u{2019}s root commit — repositories \
                     created from the same template do. Pick the right one.",
                    candidates.len()
                )),
            },
            atlas_checkpoint::Preselection::None => ConnectOptions {
                workspaces: projects,
                preselected: None,
                warning: Some(
                    "This directory does not match any Project. Connecting anyway is fine — a \
                     shallow clone, a squashed history or a fresh repository all look like this."
                        .into(),
                ),
            },
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// What Connect offers the developer.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectOptions {
    pub workspaces: Vec<atlas_checkpoint::RemoteWorkspace>,
    /// `None` when nothing matched, or when several did.
    pub preselected: Option<String>,
    /// Shown, never blocking.
    pub warning: Option<String>,
}

/// Connect this repository to an existing Project.
///
/// From here on it behaves exactly like a Project created as Cloud — same
/// capture, same drain, no separate code path. Works for a never-bound
/// Project (the caller enables Local first) and for a Local Project being
/// promoted onto an existing Cloud Project — in the latter case its captured
/// history is queued for the drain in the same transaction as the binding. `workspace_id` is the picked
/// `RemoteWorkspace.id`.
///
/// The server does the binding, not us: `POST /workspaces/connect` re-checks the
/// pick against the root commit and the origin URL, and refuses to guess when
/// several Projects match. Binding locally on the strength of a picker list
/// fetched moments ago would silently accept a pick the server would not — and
/// connecting the wrong directory pollutes a *shared* timeline.
#[tauri::command]
pub async fn capture_connect(
    project_path: String,
    org_id: String,
    slug: String,
    workspace_id: String,
    app: AppHandle,
) -> Result<ConnectResult, String> {
    let hook_app = app.clone();
    let hook_path = project_path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<ConnectResult, String> {
        let root = std::path::Path::new(&project_path);
        let state = app.state::<CaptureState>();

        let detection = atlas_checkpoint::detect(root);
        let token = token_provider(&app);
        let config = sync_config(&project_path, &org_id, &token);

        let outcome = atlas_checkpoint::connect_workspace(
            &config,
            atlas_checkpoint::ConnectRequest {
                workspace_id: Some(&workspace_id),
                slug: Some(&slug),
                root_commit_sha: detection.root_commit_sha.as_deref(),
                git_url: detection.git_url.as_deref(),
                create: false,
            },
        )
        .map_err(|e| e.to_string())?;

        let (remote_id, remote_slug) = match outcome {
            atlas_checkpoint::ConnectOutcome::Connected {
                workspace_id,
                slug: s,
                ..
            } => (workspace_id, s.unwrap_or(slug)),
            // Nothing bound. Hand the candidates back so the picker can ask
            // again rather than reporting a failure the developer cannot act on.
            atlas_checkpoint::ConnectOutcome::Ambiguous { candidates } => {
                return Ok(ConnectResult {
                    binding: None,
                    candidates,
                    matched: false,
                    moved: 0,
                })
            }
            atlas_checkpoint::ConnectOutcome::NoMatch => {
                return Ok(ConnectResult {
                    binding: None,
                    candidates: Vec::new(),
                    matched: false,
                    moved: 0,
                })
            }
        };

        let handle = state.writer(root)?;
        let (binding, moved) = {
            let store = lock_ok(&handle);
            // `promote_to_cloud`, not `set_cloud_binding`: a Project that was
            // captured Locally before being connected carries history, and the
            // binding flip and the `local` → `pending` row flip must commit
            // together (see `capture_promote`). A freshly enabled Project has
            // no rows, so this moves zero and is exactly `set_cloud_binding`.
            let moved = store
                .promote_to_cloud(&project_path, &org_id, &remote_slug, Some(&remote_id))
                .map_err(|e| e.to_string())?;
            approve_import_if_nothing_to_disclose(&store, root);
            let binding = store
                .binding()
                .map_err(|e| e.to_string())?
                .ok_or("enable capture for this Project first")?;
            (binding, moved)
        };
        state.note_drain(root);
        Ok(ConnectResult {
            binding: Some(binding),
            candidates: Vec::new(),
            matched: true,
            moved,
        })
    })
    .await
    .map_err(|e| e.to_string())??;
    if result.matched {
        crate::commands::artifacts_cloud::resync_targets(&hook_app, Some(&hook_path));
    }
    Ok(result)
}

/// Point a Cloud Project at a different Cloud Project in the same Organisation.
///
/// The server has no move between Projects — each is its own object — so the
/// old one keeps what it was sent, and this re-queues the whole history for
/// the new one. The server call is the same explicit-pick connect as
/// [`capture_connect`], and it happens first, outside the store lock, so a
/// refusal or a dead network leaves the Project exactly where it was.
///
/// Comments do not follow: they live in the old Project's object, anchored to
/// rows that only exist there. The disclosure step says so before Confirm.
#[tauri::command]
pub async fn capture_switch_project(
    project_path: String,
    org_id: String,
    slug: String,
    workspace_id: String,
    app: AppHandle,
) -> Result<ConnectResult, String> {
    let hook_app = app.clone();
    let hook_path = project_path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<ConnectResult, String> {
        let root = std::path::Path::new(&project_path);
        let state = app.state::<CaptureState>();

        let current = {
            let handle = state.writer(root)?;
            let store = lock_ok(&handle);
            store
                .binding()
                .map_err(|e| e.to_string())?
                .ok_or("enable capture for this Project first")?
        };
        if current.mode != ProjectMode::Cloud {
            return Err("this Project is not on Cloud yet — promote it first".into());
        }
        if current.remote_workspace_id.as_deref() == Some(workspace_id.as_str()) {
            return Err("this Project already syncs there".into());
        }

        let detection = atlas_checkpoint::detect(root);
        let token = token_provider(&app);
        let config = sync_config(&project_path, &org_id, &token);
        let outcome = atlas_checkpoint::connect_workspace(
            &config,
            atlas_checkpoint::ConnectRequest {
                workspace_id: Some(&workspace_id),
                slug: Some(&slug),
                root_commit_sha: detection.root_commit_sha.as_deref(),
                git_url: detection.git_url.as_deref(),
                create: false,
            },
        )
        .map_err(|e| e.to_string())?;

        let (remote_id, remote_slug) = match outcome {
            atlas_checkpoint::ConnectOutcome::Connected {
                workspace_id,
                slug: s,
                ..
            } => (workspace_id, s.unwrap_or(slug)),
            atlas_checkpoint::ConnectOutcome::Ambiguous { candidates } => {
                return Ok(ConnectResult {
                    binding: None,
                    candidates,
                    matched: false,
                    moved: 0,
                })
            }
            atlas_checkpoint::ConnectOutcome::NoMatch => {
                return Ok(ConnectResult {
                    binding: None,
                    candidates: Vec::new(),
                    matched: false,
                    moved: 0,
                })
            }
        };

        let handle = state.writer(root)?;
        let (binding, moved) = {
            let store = lock_ok(&handle);
            let moved = store
                .switch_cloud_project(&project_path, &org_id, &remote_slug, &remote_id)
                .map_err(|e| e.to_string())?;
            let binding = store
                .binding()
                .map_err(|e| e.to_string())?
                .ok_or("enable capture for this Project first")?;
            (binding, moved)
        };
        state.note_drain(root);
        Ok(ConnectResult {
            binding: Some(binding),
            candidates: Vec::new(),
            matched: true,
            moved,
        })
    })
    .await
    .map_err(|e| e.to_string())??;
    if result.matched {
        crate::commands::artifacts_cloud::resync_targets(&hook_app, Some(&hook_path));
    }
    Ok(result)
}

/// The answer to a connect attempt.
///
/// `matched: false` with candidates is the server declining to guess, which is
/// a question for the developer rather than an error.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
    pub binding: Option<atlas_checkpoint::Binding>,
    pub candidates: Vec<atlas_checkpoint::RemoteWorkspace>,
    pub matched: bool,
    /// Locally captured Sessions now queued for the drain — non-zero only when
    /// a Local Project was connected to an existing Cloud Project.
    pub moved: i64,
}

/// Is `git` on this machine at all?
///
/// Capture links Sessions to commits, so a machine without git gets a banner
/// rather than a silent half-feature. Distinct from "this directory is not a
/// repository", which `capture_detect` already answers and which `git init`
/// fixes.
#[tauri::command]
pub async fn capture_git_available() -> bool {
    tauri::async_runtime::spawn_blocking(|| {
        atlas_process::command("git")
            .arg("--version")
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

/// What promoting this Project to Cloud would disclose.
///
/// Real numbers before the decision — how many Sessions, over what dates, how
/// many secrets were redacted on the way in. This is one of only two
/// bulk-disclosure moments in the feature, and the developer genuinely cannot
/// otherwise know what they are about to publish.
#[tauri::command]
pub async fn capture_promotion_preview(project_path: String) -> Result<PromotionPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = open_reader(&project_path)?.ok_or("enable capture for this Project first")?;
        let sessions = store
            .sessions_for_project(&project_path)
            .map_err(|e| e.to_string())?;

        let secrets_redacted: u64 = sessions
            .iter()
            .filter_map(|s| s.redaction_counts.as_object())
            .flat_map(|counts| counts.values())
            .filter_map(serde_json::Value::as_u64)
            .sum();

        Ok(PromotionPreview {
            session_count: sessions.len(),
            earliest: sessions
                .iter()
                .map(|s| s.started_at)
                .min()
                .map(|t| t.to_rfc3339()),
            latest: sessions
                .iter()
                .map(|s| s.started_at)
                .max()
                .map(|t| t.to_rfc3339()),
            secrets_redacted,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// What a promotion is about to publish.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromotionPreview {
    pub session_count: usize,
    pub earliest: Option<String>,
    pub latest: Option<String>,
    pub secrets_redacted: u64,
}

/// Promote a Local Project to Cloud, bringing its history.
///
/// The entire mechanism is flipping `local` rows to `pending`. There is
/// deliberately **no separate backfill path**: the accumulated history joins the
/// same queue as everything else, so there is one drain to keep correct rather
/// than two, and closing Atlas mid-drain resumes for free.
///
/// Ordering: register on the server first (outside the store lock — a 30-second
/// round-trip must not stall capture), then flip the binding *and* every local
/// row in one store transaction (`promote_to_cloud`), so a crash can never
/// leave a Cloud Project whose history is stranded as `local`. The drain
/// additionally self-heals stray `local` rows on a Cloud Project, so the
/// invariant is convergent rather than order-dependent.
#[tauri::command]
pub async fn capture_promote(
    project_path: String,
    org_id: String,
    slug: String,
    name: Option<String>,
    visibility: Option<String>,
    app: AppHandle,
) -> Result<i64, String> {
    let hook_app = app.clone();
    let hook_path = project_path.clone();
    let moved = tauri::async_runtime::spawn_blocking(move || -> Result<i64, String> {
        let state = app.state::<CaptureState>();
        let root = std::path::Path::new(&project_path);

        let (root_commit_sha, git_url) = {
            let handle = state.writer(root)?;
            let store = lock_ok(&handle);
            let binding = store
                .binding()
                .map_err(|e| e.to_string())?
                .ok_or("enable capture for this Project first")?;
            (binding.root_commit_sha, binding.git_url)
        };

        // Registration first, and outside the lock — cancelling or failing
        // leaves the Project exactly as it was: still Local, still captured,
        // nothing sent.
        let token = token_provider(&app);
        let config = sync_config(&project_path, &org_id, &token);
        let remote_workspace_id = atlas_checkpoint::register_workspace(
            &config,
            atlas_checkpoint::Registration {
                slug: &slug,
                name: name.as_deref(),
                root_commit_sha: root_commit_sha.as_deref(),
                git_url: git_url.as_deref(),
                visibility: visibility
                    .as_deref()
                    .map(atlas_checkpoint::Visibility::parse)
                    .unwrap_or_default(),
            },
        )
        .map_err(|e| e.to_string())?;

        let moved = {
            let handle = state.writer(root)?;
            let store = lock_ok(&handle);
            let moved = store
                .promote_to_cloud(&project_path, &org_id, &slug, Some(&remote_workspace_id))
                .map_err(|e| e.to_string())?;
            approve_import_if_nothing_to_disclose(&store, root);
            moved
        };

        state.note_drain(root);
        Ok(moved)
    })
    .await
    .map_err(|e| e.to_string())??;
    crate::commands::artifacts_cloud::resync_targets(&hook_app, Some(&hook_path));
    Ok(moved)
}

/// A closure the drain can call to mint or refresh an access token.
///
/// A closure rather than a value because tokens are short-lived and a
/// post-promotion backlog runs far longer than one lifetime — the drain has to
/// be able to get a fresh one *during* a long pass.
fn token_provider(app: &AppHandle) -> impl Fn() -> Option<String> {
    let core = app.state::<crate::commands::auth::AuthState>().core();
    move || {
        // Blocking on the async mint is fine here: every caller runs on a
        // `spawn_blocking` thread or the capture worker, never a runtime core
        // thread and never the UI thread.
        match tauri::async_runtime::block_on(core.mint_access_token()) {
            Ok(token) => Some(token),
            // `None` parks the caller as "not signed in"; without this line a
            // mint failure is indistinguishable from an unreachable registry.
            Err(e) => {
                tracing::warn!(target: "atlas::capture", "access token mint failed: {e:?}");
                None
            }
        }
    }
}

fn sync_config<'a>(
    project_path: &str,
    org_id: &str,
    token: &'a dyn Fn() -> Option<String>,
) -> atlas_checkpoint::SyncConfig<'a> {
    atlas_checkpoint::SyncConfig {
        base_url: atlas_checkpoint::sync::ingest_base(),
        org_id: org_id.to_string(),
        workspace_id: project_path.to_string(),
        // Only `drain()` stamps artifacts with the wire identity, and the drain
        // builds its own config (in `drain_for`) from the binding's registered
        // id. The callers of this helper — slug check, registration, project
        // listing — never produce artifacts, so the placeholder is never sent.
        wire_workspace_id: project_path.to_string(),
        token,
        timeout: std::time::Duration::from_secs(30),
        deadline: None,
    }
}

/// A read-only view of a Project's store, or `None` if it has none.
///
/// Its own connection, and deliberately **not** the writer: reading must never
/// contend for the writer lock, and must never wait behind a multi-minute import
/// holding the shared writing store. WAL makes both safe.
///
/// `None` rather than an empty store, because opening one would create it —
/// and then merely looking at the Artifacts tab would plant an `.atlas/`
/// directory in a Project nobody enabled.
pub(crate) fn open_reader(project_path: &str) -> Result<Option<Store>, String> {
    open_reader_raw(project_path).map_err(|e| e.to_string())
}

/// [`open_reader`] with the typed error kept, for the one caller
/// (`capture_health`) that must distinguish `SchemaTooNew` from a real failure.
fn open_reader_raw(project_path: &str) -> Result<Option<Store>, atlas_checkpoint::Error> {
    if !enabled_on_disk(Path::new(project_path)) {
        return Ok(None);
    }
    Store::open_reader(atlas_checkpoint::atlas_dir(project_path)).map(Some)
}

/// Which capture path a session came from.
///
/// The distinction matters downstream: the native agent reports a real
/// input/output token split where ACP agents only surface a context gauge, and
/// the importer needs to tell an in-app Session from one it read off disk.
fn source_for(plugin_id: &str) -> Source {
    if plugin_id == atlas_native_agent::ATLAS_AGENT_ID {
        Source::Native
    } else {
        Source::Acp
    }
}

/// Has capture ever been enabled here?
///
/// Answered from the filesystem rather than from the store, because opening the
/// store is itself what creates it. This is the guard that keeps an unbound
/// Project free of an `.atlas/` directory it never asked for.
fn enabled_on_disk(root: &Path) -> bool {
    atlas_checkpoint::atlas_dir(root)
        .join("sessions.db")
        .exists()
}

/// Open (once) the process's writing store for a Project root.
///
/// Shared by the worker and by every write command, which is the whole point —
/// see [`StoreRegistry`]. A Project whose store cannot be opened at all is
/// reported and not retried on this call; the next one tries again.
///
/// This is also where a folder rename is healed: `.atlas/` travels with the
/// directory, but every row is keyed on the absolute path it was written under.
/// If the binding's stored `workspace_id` no longer matches the path the store
/// was just opened at, everything is re-keyed in one transaction — otherwise
/// the timeline, the health counts and the promotion preview all silently read
/// as empty after a rename.
fn open_in(stores: &StoreRegistry, root: &Path) -> Result<StoreHandle, String> {
    let mut registry = lock_ok(stores);
    if let Some(handle) = registry.get(root) {
        if handle.is_writer {
            return Ok(handle.clone());
        }
        // A reader-only handle means another process held the writer lock when
        // we last looked. That process may have exited since — and caching the
        // deferral forever would leave capture dead until restart while health
        // keeps blaming a window that no longer exists. Re-attempt the lock:
        // cheap when still held (immediate EXCLUSIVE failure), and the moment
        // it frees, this process resumes recording.
        registry.remove(root);
    }

    let store = Store::open(atlas_checkpoint::atlas_dir(root)).map_err(|e| {
        tracing::error!(
            target: "atlas::capture",
            project = %root.display(),
            "session store unavailable: {e}"
        );
        e.to_string()
    })?;

    let is_writer = store.is_writer();
    if !is_writer {
        // A genuinely different process owns this Project. Deferring is the
        // whole point of the lock: two writers corrupt the outbox state machine.
        tracing::info!(
            target: "atlas::capture",
            project = %root.display(),
            "another Atlas process is recording this project; capture deferred"
        );
    }

    if is_writer {
        if let Ok(Some(binding)) = store.binding() {
            let current = root.to_string_lossy().to_string();
            if binding.workspace_id != current {
                match store.rekey_project(&binding.workspace_id, &current, &current) {
                    Ok(()) => tracing::info!(
                        target: "atlas::capture",
                        from = %binding.workspace_id,
                        to = %current,
                        "project folder was renamed; history re-keyed"
                    ),
                    Err(e) => tracing::warn!(
                        target: "atlas::capture",
                        "project re-key after rename failed: {e}"
                    ),
                }
            }
        }
    }

    let handle = StoreHandle {
        store: Arc::new(Mutex::new(store)),
        is_writer,
    };
    registry.insert(root.to_path_buf(), handle.clone());
    Ok(handle)
}

/// Does all the writing, in order.
///
/// The stores are owned by the shared registry rather than by this thread. The
/// worker takes a store's mutex for the duration of one job and releases it, so
/// a write command issued while the worker is idle does not have to wait for the
/// worker to notice — and, more importantly, does not open a competing store.
fn worker(
    rx: mpsc::Receiver<Job>,
    notify: Notifier,
    stores: StoreRegistry,
    alive: Arc<AtomicBool>,
) {
    /// Flips the liveness flag on the way out, however the thread exits — so a
    /// dead worker is a `Stopped` health state instead of a silent gap.
    struct AliveGuard(Arc<AtomicBool>);
    impl Drop for AliveGuard {
        fn drop(&mut self) {
            self.0.store(false, Ordering::Relaxed);
        }
    }
    let _guard = AliveGuard(alive);

    // Session ids are assigned by the store on first write and reused after.
    let mut session_ids: HashMap<String, String> = HashMap::new();

    // Change notification, coalesced. `dirty` says a write landed that a reader
    // would want; `last_emit` enforces the window. Starting `last_emit` a full
    // window in the past makes the very first write emit immediately.
    let mut dirty = false;
    let mut last_emit = Instant::now() - NOTIFY_DEBOUNCE;
    loop {
        // Short wait while a notification is pending, so the trailing edge of a
        // burst is announced promptly rather than at the next scan.
        // Only local writes run here: the cloud drain and the transcript scan
        // are the sync worker's ([`sync_worker`]), so a job never waits on the
        // network or a long import.
        let wait = if dirty {
            NOTIFY_DEBOUNCE
        } else {
            IMPORT_SCAN_INTERVAL
        };
        let job = match rx.recv_timeout(wait) {
            Ok(job) => Some(job),
            Err(mpsc::RecvTimeoutError::Timeout) => None,
            // The app is shutting down.
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        };

        if let Some(job) = job {
            // One panicking job must not kill the recorder for the rest of the
            // process. The job is lost (and logged); the mutexes it may have
            // poisoned are recovered by `lock_ok` everywhere.
            //
            // Every job changes something a reader can see.
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                process_job(job, &mut session_ids, &stores);
            }));
            if result.is_err() {
                tracing::error!(target: "atlas::capture", "capture job panicked; job dropped");
            }
            dirty = true;
        }

        if dirty && last_emit.elapsed() >= NOTIFY_DEBOUNCE {
            dirty = false;
            last_emit = Instant::now();
            if let Some(app) = lock_ok(&notify).as_ref() {
                let _ = app.emit(CAPTURE_CHANGED, ());
            }
        }
    }
}

/// Handle one queued job.
fn process_job(job: Job, session_ids: &mut HashMap<String, String>, stores: &StoreRegistry) {
    // Needs no store at all.
    if let Job::EndSession { native_session_id } = &job {
        session_ids.remove(native_session_id);
        return;
    }

    // A commit walk is not tied to a Session, so it carries its own root
    // rather than a binding.
    let (session_binding, root) = match &job {
        Job::WalkCommits { project_root, .. } => (None, project_root.clone()),
        Job::Prompt { binding, .. }
        | Job::Turn { binding, .. }
        | Job::ToolCall { binding, .. }
        | Job::FinishTurn { binding }
        | Job::RewindTurns { binding, .. }
        | Job::Usage { binding, .. } => (Some(binding.clone()), binding.project_root.clone()),
        Job::EndSession { .. } => unreachable!("handled above"),
    };

    // Capture is opt-in, and the check has to happen *before* the store is
    // opened. `Store::open` creates `.atlas/` — so opening first and reading
    // the binding second put an empty database in every directory the
    // developer had ever run an agent in, which is precisely the surprise
    // the binding check below was written to avoid. Only `capture_enable`
    // creates the store; until it has, there is nothing here to record to.
    if !enabled_on_disk(&root) {
        return;
    }

    let Ok(handle) = open_in(stores, &root) else {
        return;
    };
    if !handle.is_writer {
        return;
    }
    let mut guard = lock_ok(&handle.store);
    let store = &mut *guard;

    let Ok(Some(project)) = store.binding() else {
        return;
    };
    // Paused stops *new* records only. What was already recorded keeps
    // reconciling and draining — the developer was told pausing deletes
    // nothing, and silently stopping their queued work from reaching the team
    // would make that a half-truth.
    let capturing = project.is_capturing();
    let mode = project.mode;

    // The commit walk needs the store but no Session, so it is handled
    // before the Session-scoped jobs below.
    if let Job::WalkCommits { workspace_id, .. } = &job {
        // Reconcile **before** walking: the walk assumes every Checkpoint's
        // commit reference is current, and running it against just-rewritten
        // history links against stale shas the reconcile pass was about to
        // re-point. A rewrite moves refs exactly like a commit does, so both
        // run on the same trigger.
        let mut mid_rewrite = false;
        match atlas_checkpoint::reconcile_rewrites(store, workspace_id, &root) {
            Ok(outcome) if outcome.deferred => {
                // A rebase is in flight. Reconciliation already refused to
                // judge the half-rewritten history — and the walk below must
                // not either: it would link the transient rebase commits via
                // the permissive arm and consume touches against them. The
                // post-rebase ref movement re-triggers both.
                mid_rewrite = true;
            }
            Ok(outcome) if outcome.is_mass_orphan() => tracing::warn!(
                target: "atlas::capture",
                orphaned = outcome.orphaned,
                "history-wide rewrite orphaned Checkpoints in bulk"
            ),
            Ok(outcome) if outcome.relinked + outcome.orphaned + outcome.recovered > 0 => {
                tracing::info!(
                    target: "atlas::capture",
                    relinked = outcome.relinked,
                    orphaned = outcome.orphaned,
                    recovered = outcome.recovered,
                    "reconciled Checkpoints after a history rewrite"
                )
            }
            Ok(_) => {}
            Err(e) => {
                tracing::warn!(target: "atlas::capture", "reconciliation failed: {e}")
            }
        }

        // New Checkpoints are new capture; a paused Project only reconciles
        // what it already recorded.
        if capturing && !mid_rewrite {
            match atlas_checkpoint::walk_new_commits(store, workspace_id, &root, mode) {
                Ok(outcome) if outcome.checkpoints_created > 0 => tracing::info!(
                    target: "atlas::capture",
                    commits = outcome.commits_seen,
                    checkpoints = outcome.checkpoints_created,
                    "linked commits to sessions"
                ),
                Ok(outcome) if outcome.cursor_recovered => tracing::warn!(
                    target: "atlas::capture",
                    project = %root.display(),
                    "commit cursor could not be resolved; recovered by re-scan"
                ),
                Ok(_) => {}
                Err(e) => tracing::warn!(target: "atlas::capture", "commit walk failed: {e}"),
            }
        }
        return;
    }

    // Everything below records something new.
    if !capturing {
        return;
    }

    let Some(binding) = session_binding else {
        return;
    };
    let key = SessionKey {
        // The Project binding proper arrives with the enable popover; until
        // then a Project is its project directory, which is the same
        // identity `.atlas/` already uses.
        workspace_id: project_id_for(&root),
        source: binding.source,
        native_session_id: binding.native_session_id.clone(),
    };

    let mut capture = Capture::new(store, mode);
    // Commits a shell window saw HEAD move across, linked AFTER the touches
    // land — on this same ordered worker, which is the whole ordering
    // guarantee (#31). The ordinary walk cannot do it: the watcher fired the
    // moment the agent's own `git commit` moved refs, and its walk consumed
    // these commits before any touch existed, advancing the cursor past them.
    let mut link_after: Vec<String> = Vec::new();
    let outcome = match job {
        // Already handled above; none of these needs a Session.
        Job::WalkCommits { .. } | Job::EndSession { .. } => Ok(()),
        Job::Prompt { prompt, .. } => capture
            .record_prompt(
                &key,
                &prompt,
                binding.turn_seq,
                binding.agent.as_deref(),
                binding.model.as_deref(),
                Some(&binding.cwd),
            )
            .and_then(|id| {
                // The branch is a separate call — see `Capture::note_branch`.
                capture.note_branch(&id, binding.branch.as_deref())?;
                session_ids.insert(binding.native_session_id.clone(), id);
                Ok(())
            }),
        Job::Turn {
            native_message_id,
            role,
            mode,
            body,
            created_at,
            ..
        } => match session_ids.get(&binding.native_session_id) {
            Some(session_id) => capture
                .record_turn(
                    session_id,
                    TurnContent {
                        turn_seq: binding.turn_seq,
                        native_message_id: Some(native_message_id),
                        role,
                        mode,
                        body,
                        created_at: Some(created_at),
                    },
                )
                .map(|_| ()),
            // A delta before the session's first send has no Session row to
            // attach to. Normal, not an error.
            None => Ok(()),
        },
        Job::ToolCall {
            native_call_id,
            tool_name,
            title,
            kind,
            status,
            locations,
            arguments,
            result,
            writes,
            settled_commits,
            patch,
            ..
        } => match session_ids.get(&binding.native_session_id) {
            Some(session_id) => {
                let recorded = record_tool_call(
                    &mut capture,
                    session_id,
                    &binding,
                    ToolCallJob {
                        native_call_id,
                        tool_name,
                        title,
                        kind,
                        status,
                        locations,
                        arguments,
                        result,
                        writes,
                        patch,
                    },
                );
                if recorded.is_ok() {
                    link_after = settled_commits;
                }
                recorded
            }
            None => Ok(()),
        },
        Job::FinishTurn { .. } => match session_ids.get(&binding.native_session_id) {
            Some(session_id) => capture.finish_turn(session_id, binding.turn_seq),
            None => Ok(()),
        },
        Job::RewindTurns { turns, .. } => match session_ids.get(&binding.native_session_id) {
            Some(session_id) => capture.rewind_turns(session_id, turns),
            None => Ok(()),
        },
        Job::Usage { totals, .. } => match session_ids.get(&binding.native_session_id) {
            // Against the turn the send path stamped on the binding, so the
            // ledger dates usage by the turn it happened in.
            Some(session_id) => capture.record_usage(
                session_id,
                binding.turn_seq,
                binding.model.as_deref(),
                &totals,
            ),
            None => Ok(()),
        },
    };

    if let Err(e) = outcome {
        // Already flagged on the Session row by the crate where it matters;
        // this is the operator-facing half.
        tracing::warn!(target: "atlas::capture", "capture failed: {e}");
    }

    if !link_after.is_empty() {
        match atlas_checkpoint::link_commits(store, &key.workspace_id, &root, &link_after, mode) {
            Ok(created) if created > 0 => tracing::info!(
                target: "atlas::capture",
                commits = link_after.len(),
                created,
                "linked the commits a shell call made itself"
            ),
            Ok(_) => {}
            Err(e) => tracing::warn!(
                target: "atlas::capture",
                "evaluating a shell call's own commits failed: {e}"
            ),
        }
    }
}

/// How often every bound Project is re-scanned for new transcripts.
///
/// This is the ongoing half of the importer — the terminal-gap scan. Cheap
/// enough to run on a timer because a file that has not grown is skipped by a
/// size comparison before it is opened.
const IMPORT_SCAN_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);

/// The drain retry floor and ceiling: 30 seconds doubling to 15 minutes.
const DRAIN_BACKOFF_FLOOR: Duration = Duration::from_secs(30);
const DRAIN_BACKOFF_CEILING: Duration = Duration::from_secs(15 * 60);

/// Import a Project's transcripts, best-effort.
///
/// Never fails the caller: a missing transcript directory (the developer has
/// never run this agent) is the ordinary case, not an error.
fn import_for(store: &mut Store, root: &std::path::Path) {
    let Ok(Some(binding)) = store.binding() else {
        return;
    };
    if !binding.is_capturing() {
        return;
    }
    // The Cloud bulk-disclosure gate. Local always may — nothing leaves the
    // machine. A Cloud Project imports **nothing** until the developer has
    // seen the real numbers and confirmed (`capture_import_confirm`);
    // cancelling the dialog leaves the flag unset, and this scan honours that
    // forever rather than sneaking the backlog in 30 seconds later.
    if !binding.may_import() {
        return;
    }
    let Some(source) = transcript_source_for(root) else {
        return;
    };

    let workspace_id = root.to_string_lossy().to_string();
    match atlas_checkpoint::import_all(store, &workspace_id, &source, binding.mode) {
        Ok(outcome) if outcome.sessions_imported > 0 => tracing::info!(
            target: "atlas::capture",
            sessions = outcome.sessions_imported,
            messages = outcome.messages_imported,
            malformed = outcome.malformed_lines,
            "imported on-disk transcripts"
        ),
        Ok(_) => {}
        Err(e) => tracing::warn!(target: "atlas::capture", "transcript import failed: {e}"),
    }
}

/// Send everything pending for a Project, best-effort.
///
/// Offline is the ordinary case here, not an error: rows simply stay pending —
/// with exponential backoff on the retry so a dead network is not hammered
/// every 30 seconds. `forced` bypasses the backoff for explicit human actions.
///
/// `deadline` bounds the pass ([`SYNC_PASS_BUDGET`]); `true` when it yielded
/// with rows still pending, so the caller queues the Project for another turn.
fn drain_for(
    store: &mut Store,
    root: &std::path::Path,
    base_url: &str,
    token: &TokenProvider,
    backoff: &BackoffMap,
    forced: bool,
    deadline: Option<Instant>,
) -> bool {
    let Ok(Some(binding)) = store.binding() else {
        return false;
    };
    if binding.mode != ProjectMode::Cloud {
        // Local mode is the same database with draining switched off.
        return false;
    }
    let Some(org_id) = binding.org_id.clone() else {
        return false;
    };

    // Terminal until re-registration: the server said this identity may not
    // push, and retrying a revoked membership every 30 seconds forever is
    // noise. `set_cloud_binding` clears the gate on a fresh registration.
    if binding.drain_state == DrainGate::NotAuthorized {
        return false;
    }

    // The wire identity is the server-assigned project id (slug as a
    // fallback for bindings registered before the id was persisted) — never
    // the local filesystem path, which no teammate shares and which would leak
    // the developer's directory layout to the whole Organisation. A Cloud
    // binding without either predates registration (or was half-bound by an
    // older build) and must not drain at all.
    if binding.remote_workspace_id.is_none() && binding.slug.is_none() {
        warn_once_unregistered(root);
        return false;
    }

    if !forced {
        if let Some(entry) = lock_ok(backoff).get(root) {
            if Instant::now() < entry.next_attempt {
                return false;
            }
        }
    }

    let project_key = root.to_string_lossy().to_string();

    let provider = token.clone();
    let mint_token = move || {
        provider
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|mint| mint()))
            .flatten()
    };

    // The wire identity: the server-assigned project id, or the slug for
    // bindings registered before the id was persisted. The gate above already
    // guaranteed one of them exists.
    let wire_workspace_id = binding
        .remote_workspace_id
        .clone()
        .or_else(|| binding.slug.clone())
        .expect("gated on a wire identity existing");

    let config = atlas_checkpoint::SyncConfig {
        base_url: base_url.to_string(),
        org_id,
        // Local row keying: `pending_artifacts` selects by the path rows were
        // written under. The wire identity is what lands on every artifact.
        workspace_id: project_key,
        wire_workspace_id,
        token: &mint_token,
        timeout: std::time::Duration::from_secs(30),
        deadline,
    };

    let mut yielded = false;
    match atlas_checkpoint::drain(store, &config) {
        Ok(outcome) if outcome.status == atlas_checkpoint::DrainStatus::NotAuthorized => {
            // A terminal state, not a retry loop: persisted so every later tick
            // skips the drain, and surfaced through the capture-health signal.
            // Local capture is unaffected.
            if let Err(e) = store.set_drain_state(DrainGate::NotAuthorized) {
                tracing::warn!(target: "atlas::capture", "recording drain gate failed: {e}");
            }
            lock_ok(backoff).remove(root);
            tracing::warn!(
                target: "atlas::capture",
                "no longer authorized for this project; drain stopped"
            );
        }
        Ok(outcome)
            if matches!(
                outcome.status,
                atlas_checkpoint::DrainStatus::Offline | atlas_checkpoint::DrainStatus::RateLimited
            ) =>
        {
            // A server-sent `Retry-After` outranks the guessed exponential
            // delay — the server knows when it wants to hear from us again.
            bump_backoff(backoff, root, outcome.retry_after);
        }
        Ok(outcome) => {
            lock_ok(backoff).remove(root);
            yielded = outcome.status == atlas_checkpoint::DrainStatus::Yielded;
            if outcome.sent > 0 || outcome.failed > 0 {
                tracing::info!(
                    target: "atlas::capture",
                    sent = outcome.sent,
                    failed = outcome.failed,
                    pending = outcome.still_pending,
                    "drained the outbox"
                );
            }
        }
        Err(e) => {
            bump_backoff(backoff, root, None);
            tracing::warn!(target: "atlas::capture", "drain failed: {e}");
        }
    }
    yielded
}

/// The sync worker: cloud drains and transcript imports for every Project, off
/// the recording path ([`SyncRequest`] says why).
///
/// Round-robin and deduplicated: `due` holds each Project at most once, however
/// many drains were asked for; a pass that yields ([`SYNC_PASS_BUDGET`]) goes to
/// the back, so a large backlog in one Project shares the uplink with every
/// other Project instead of holding it until it is empty. Every thirty seconds
/// each open Project is queued for an import scan and a (backoff-gated) drain,
/// which is how a Project reconnects without the developer doing anything.
///
/// Each drain and import runs on a **sibling** connection ([`with_sibling`]):
/// the recorder's store lock is taken only for the instant it takes to open
/// one, so a turn is never recorded late because a Project is syncing.
///
/// `ingest` names the ingest server, read once per pass (the deployed one in
/// the app; a stub in tests).
fn sync_worker(
    rx: mpsc::Receiver<SyncRequest>,
    token: TokenProvider,
    notify: Notifier,
    stores: StoreRegistry,
    alive: Arc<AtomicBool>,
    ingest: Box<dyn Fn() -> String + Send>,
) {
    struct AliveGuard(Arc<AtomicBool>);
    impl Drop for AliveGuard {
        fn drop(&mut self) {
            self.0.store(false, Ordering::Relaxed);
        }
    }
    let _guard = AliveGuard(alive);

    let backoff: BackoffMap = Arc::new(Mutex::new(HashMap::new()));
    let mut queue = SyncQueue::default();
    let mut last_scan = Instant::now();
    let mut dirty = false;
    let mut last_emit = Instant::now() - NOTIFY_DEBOUNCE;

    loop {
        // Block only when there is nothing to do; otherwise just take what
        // arrived, so a new request joins the rotation at once.
        let wait = if !queue.is_empty() {
            Duration::ZERO
        } else if dirty {
            NOTIFY_DEBOUNCE
        } else {
            IMPORT_SCAN_INTERVAL.saturating_sub(last_scan.elapsed())
        };
        let first = if wait.is_zero() {
            match rx.try_recv() {
                Ok(request) => Some(request),
                Err(mpsc::TryRecvError::Empty) => None,
                Err(mpsc::TryRecvError::Disconnected) => return,
            }
        } else {
            match rx.recv_timeout(wait) {
                Ok(request) => Some(request),
                Err(mpsc::RecvTimeoutError::Timeout) => None,
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        };
        for request in first
            .into_iter()
            .chain(std::iter::from_fn(|| rx.try_recv().ok()))
        {
            queue.push(request);
        }

        if last_scan.elapsed() >= IMPORT_SCAN_INTERVAL {
            last_scan = Instant::now();
            let open: Vec<PathBuf> = lock_ok(&stores)
                .iter()
                .filter(|(_, h)| h.is_writer)
                .map(|(root, _)| root.clone())
                .collect();
            for root in open {
                queue.push(SyncRequest::Import {
                    project_root: root.clone(),
                });
                queue.push(SyncRequest::Drain {
                    project_root: root,
                    forced: false,
                });
            }
        }

        // One import and one drain pass, then back to the channel.
        if let Some(root) = queue.next_import() {
            if with_sibling(&stores, &root, |store| import_for(store, &root)).is_some() {
                dirty = true;
            }
        }
        if let Some((root, forced)) = queue.next_drain() {
            let deadline = Some(Instant::now() + SYNC_PASS_BUDGET);
            let base_url = ingest();
            let yielded = with_sibling(&stores, &root, |store| {
                drain_for(store, &root, &base_url, &token, &backoff, forced, deadline)
            });
            if yielded == Some(true) {
                queue.requeue(root);
            }
            dirty = true;
        }

        if dirty && last_emit.elapsed() >= NOTIFY_DEBOUNCE {
            dirty = false;
            last_emit = Instant::now();
            if let Some(app) = lock_ok(&notify).as_ref() {
                let _ = app.emit(CAPTURE_CHANGED, ());
            }
        }
    }
}

/// What the sync worker has to do: each Project at most once per kind, in
/// arrival order, with "forced" remembered for a drain asked for more than
/// once.
#[derive(Default)]
struct SyncQueue {
    drains: std::collections::VecDeque<PathBuf>,
    forced: std::collections::HashSet<PathBuf>,
    imports: std::collections::VecDeque<PathBuf>,
}

impl SyncQueue {
    fn is_empty(&self) -> bool {
        self.drains.is_empty() && self.imports.is_empty()
    }

    fn push(&mut self, request: SyncRequest) {
        match request {
            SyncRequest::Drain {
                project_root,
                forced,
            } => {
                if forced {
                    self.forced.insert(project_root.clone());
                }
                if !self.drains.contains(&project_root) {
                    self.drains.push_back(project_root);
                }
            }
            SyncRequest::Import { project_root } => {
                if !self.imports.contains(&project_root) {
                    self.imports.push_back(project_root);
                }
            }
        }
    }

    fn next_drain(&mut self) -> Option<(PathBuf, bool)> {
        let root = self.drains.pop_front()?;
        let forced = self.forced.remove(&root);
        Some((root, forced))
    }

    fn next_import(&mut self) -> Option<PathBuf> {
        self.imports.pop_front()
    }

    /// A drain that yielded goes to the back of the line.
    fn requeue(&mut self, root: PathBuf) {
        if !self.drains.contains(&root) {
            self.drains.push_back(root);
        }
    }
}

/// Runs `f` on a **sibling** of the Project's writing store — a connection of
/// its own under the same writer lock ([`Store::sibling`]) — so long work
/// never holds the store the recorder writes through. `None` when the Project
/// is not enabled here, or another process holds its writer lock. A panic in
/// `f` is contained and logged, like a panicking recording job.
fn with_sibling<R>(
    stores: &StoreRegistry,
    root: &Path,
    f: impl FnOnce(&mut Store) -> R,
) -> Option<R> {
    // The same guard the recorder uses: never create `.atlas/` for a Project
    // that has not enabled capture.
    if !enabled_on_disk(root) {
        return None;
    }
    let handle = open_in(stores, root).ok()?;
    if !handle.is_writer {
        return None;
    }
    // The recorder's lock, held only while the sibling opens.
    let sibling = lock_ok(&handle.store).sibling();
    let mut sibling = match sibling {
        Ok(store) => store,
        Err(e) => {
            tracing::warn!(target: "atlas::capture", project = %root.display(), "sync connection failed: {e}");
            return None;
        }
    };
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(&mut sibling))) {
        Ok(result) => Some(result),
        Err(_) => {
            tracing::error!(target: "atlas::capture", project = %root.display(), "capture sync pass panicked; continuing");
            None
        }
    }
}

/// Double the retry delay for a root, clamped to the ceiling; a server-sent
/// `Retry-After` hint raises (never lowers past itself) the wait.
fn bump_backoff(backoff: &BackoffMap, root: &std::path::Path, retry_after: Option<Duration>) {
    let mut map = lock_ok(backoff);
    let doubled = map
        .get(root)
        .map(|entry| (entry.delay * 2).min(DRAIN_BACKOFF_CEILING))
        .unwrap_or(DRAIN_BACKOFF_FLOOR);
    let delay = retry_after.map_or(doubled, |hint| hint.max(doubled));
    map.insert(
        root.to_path_buf(),
        DrainBackoff {
            next_attempt: Instant::now() + delay,
            delay,
        },
    );
}

/// Log the "Cloud binding with no wire identity" condition once per root, not
/// every 30 seconds forever.
fn warn_once_unregistered(root: &std::path::Path) {
    use std::sync::OnceLock;
    static WARNED: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    let warned = WARNED.get_or_init(|| Mutex::new(HashSet::new()));
    if lock_ok(warned).insert(root.to_path_buf()) {
        tracing::warn!(
            target: "atlas::capture",
            project = %root.display(),
            "cloud project has no server identity (no remote id, no slug); drain skipped"
        );
    }
}

/// Where this Project's agent transcripts live.
///
/// Claude Code encodes the project directory into a folder name under
/// `~/.claude/projects/`; the encoding lives in `atlas-agent-transcript`, so it
/// is reused rather than reproduced.
///
/// This is the checkpoint importer, whose contract (research §C9 touchpoint
/// #11) explicitly survives the history port: Atlas stopped *reading* CLI
/// storage for its UI, and never touches these files.
/// After Promote or Connect: approve the transcript import when it would
/// disclose nothing.
///
/// Binding to Cloud clears the import gate, and the gate exists so a bulk
/// publish of on-disk transcripts is always shown first. Create → Cloud shows
/// that preview and confirming it — even an empty one, "new sessions sync from
/// now on" — approves the gate. Promote and Connect never show it, so they left
/// the gate closed with nothing behind it: a "History import is waiting for
/// your review" banner leading to an empty dialog, and future transcripts that
/// would not sync until someone clicked through it. With nothing to import
/// there is nothing to disclose, so approve exactly as Create's empty confirm
/// does. Anything to import keeps the gate and the banner — that review is the
/// point. Best-effort: a failure leaves the gate closed, the safe side.
fn approve_import_if_nothing_to_disclose(store: &Store, root: &std::path::Path) {
    let nothing_to_import = match transcript_source_for(root) {
        None => true,
        Some(source) => {
            let path = root.to_string_lossy();
            atlas_checkpoint::import::preview_with_store(store, &path, &source, ProjectMode::Cloud)
                .new_session_count
                == 0
        }
    };
    if nothing_to_import {
        if let Err(e) = store.set_import_approved(true) {
            tracing::warn!(target: "atlas::capture", "could not approve an empty import: {e}");
        }
    }
}

fn transcript_source_for(root: &std::path::Path) -> Option<atlas_checkpoint::TranscriptSource> {
    Some(atlas_checkpoint::TranscriptSource::new(
        atlas_agent_transcript::discovery::claude_sessions_dir(root)?,
    ))
}

/// The worker's view of one tool call.
struct ToolCallJob {
    native_call_id: String,
    tool_name: ToolName,
    title: Option<String>,
    kind: Option<String>,
    status: ToolStatus,
    locations: serde_json::Value,
    arguments: Option<String>,
    result: Option<String>,
    writes: Vec<CompletedWrite>,
    patch: Option<String>,
}

/// Write the tool call, and — for the first terminal sighting — the writes it
/// performed, hashed on the emit thread when the file was still what the agent
/// left.
fn record_tool_call(
    capture: &mut Capture<'_>,
    session_id: &str,
    binding: &SessionBinding,
    job: ToolCallJob,
) -> atlas_checkpoint::Result<()> {
    let call_id = capture.record_tool_call(
        session_id,
        ToolCallContent {
            turn_seq: binding.turn_seq,
            native_call_id: Some(&job.native_call_id),
            tool_name: job.tool_name,
            title: job.title.as_deref(),
            kind: job.kind.as_deref(),
            status: job.status,
            locations: &job.locations,
            arguments: job.arguments.as_deref(),
            result: job.result.as_deref().map(str::as_bytes),
        },
    )?;

    for write in &job.writes {
        capture.record_file_write(
            session_id,
            &call_id,
            binding.turn_seq,
            FileWrite {
                path: &write.path,
                sha256_after: write.sha256_after.clone(),
                sketch_after: write.sketch_after.clone(),
                existed_before: write.existed_before,
                deleted: write.deleted,
            },
        )?;
    }

    // The patch belongs to the call, not to each path it touched — an edit
    // call reporting three locations applied one patch, not three.
    if let (Some(patch), Some(first)) = (&job.patch, job.writes.first()) {
        capture.record_edit_patch(
            session_id,
            &call_id,
            binding.turn_seq,
            &first.path.path,
            patch,
        )?;
    }
    Ok(())
}

/// Serialise a call's arguments for storage, dropping an empty object rather
/// than storing `{}` on every shell command.
fn serialize_arguments(arguments: &serde_json::Value) -> Option<String> {
    match arguments {
        serde_json::Value::Object(map) if map.is_empty() => None,
        serde_json::Value::Null => None,
        other => Some(other.to_string()),
    }
}

/// The patch an edit-shaped call applied, from whatever shape it arrived in.
///
/// Attribution's input, and unrecoverable once the Session ends and the file
/// moves on — so a best-effort reconstruction from the before/after strings is
/// worth more than nothing. Agents that hand over a real diff are preferred.
///
/// The call's diff BLOCK is checked alongside its arguments, for the same
/// reason the block feeds path extraction: an agent that sends no `rawInput`
/// names its before/after only there, and reading arguments alone left exactly
/// those agents with no attribution input at all while every other agent had it.
///
/// `target` is the path the patch will be stored against, so the right block is
/// chosen when a call edits several files: the blocks carry one patch EACH, and
/// `content_blocks[0]` is not necessarily the same file as the first recorded
/// write (the write set may have come from `locations`, in its own order).
/// Storing a patch under another file's name is a worse answer than storing
/// none, because attribution consumes it as fact.
///
/// The two halves always come from ONE source. Splicing an `old` out of the
/// arguments onto a `new` out of a block would synthesise a before/after that
/// neither description ever claimed.
fn edit_patch(
    arguments: &serde_json::Value,
    blocks: &[ToolContentBlock],
    target: Option<&ResolvedPath>,
    project_root: &std::path::Path,
) -> Option<String> {
    for key in ["patch", "diff"] {
        if let Some(patch) = arguments.get(key).and_then(serde_json::Value::as_str) {
            if !patch.trim().is_empty() {
                return Some(patch.to_string());
            }
        }
    }

    let old_arg = ["old_string", "oldText", "old_str"]
        .iter()
        .find_map(|k| arguments.get(k).and_then(serde_json::Value::as_str));
    let new_arg = ["new_string", "newText", "new_str", "content"]
        .iter()
        .find_map(|k| arguments.get(k).and_then(serde_json::Value::as_str));

    let (old, new) = if old_arg.is_some() || new_arg.is_some() {
        (old_arg, new_arg)
    } else {
        let block = blocks.iter().find_map(|block| match block {
            ToolContentBlock::Diff {
                path,
                old_text,
                new_text,
            } => {
                let same_file = match target {
                    Some(target) => resolve_path(path, project_root).path == target.path,
                    // Nothing to pair against — a lone block is unambiguous,
                    // several are not, so only the lone one is trusted.
                    None => blocks.len() == 1,
                };
                same_file.then_some((old_text.as_deref(), new_text.as_str()))
            }
            ToolContentBlock::Terminal { .. } => None,
        });
        match block {
            Some((old, new)) => (old, Some(new)),
            None => (None, None),
        }
    };

    match (old, new) {
        (None, None) => None,
        (old, new) => Some(format!(
            "--- before\n+++ after\n{}{}",
            old.map(|o| format!("-{}\n", o.replace('\n', "\n-")))
                .unwrap_or_default(),
            new.map(|n| format!("+{}\n", n.replace('\n', "\n+")))
                .unwrap_or_default(),
        )),
    }
}

/// Feeds finalized turns into capture.
///
/// Streaming text and thinking chunks are *accumulated* here (cheap string
/// appends on the emit thread) and become stored artifacts only when the turn
/// finishes — `MessageAppended` alone carries just the first streamed chunk,
/// and recording at that moment stored every streamed response truncated.
pub struct CaptureMiddleware {
    pub app: AppHandle,
}

impl OutboundMiddleware<SessionDeltaEnvelope> for CaptureMiddleware {
    fn on_event(&self, envelope: &SessionDeltaEnvelope) {
        let state = self.app.state::<CaptureState>();
        let Some(binding) = state.binding(&envelope.session_id) else {
            return;
        };

        match &envelope.delta {
            SessionDelta::MessageAppended { message } => {
                // The user's own message never arrives here — see the module
                // docs. Anything that does is the agent's.
                if message.role == MessageRole::User {
                    return;
                }
                let (mode, body) = match message.mode {
                    atlas_agent_wire::MessageMode::Thinking => {
                        (Mode::Thinking, message.thinking.clone())
                    }
                    atlas_agent_wire::MessageMode::Tool => (Mode::Tool, message.content.clone()),
                    atlas_agent_wire::MessageMode::Text => (Mode::Text, message.content.clone()),
                };
                // Started even when the first chunk is empty: the body arrives
                // as later chunks, and entries that stay empty are skipped at
                // flush time.
                state.begin_message(
                    &envelope.session_id,
                    &binding,
                    message.id.clone(),
                    match message.role {
                        MessageRole::Assistant => Role::Assistant,
                        MessageRole::System => Role::System,
                        MessageRole::User => Role::User,
                    },
                    mode,
                    body,
                );
            }

            SessionDelta::TextChunk { message_id, delta }
            | SessionDelta::ThinkingChunk { message_id, delta } => {
                state.append_chunk(&envelope.session_id, message_id, delta);
            }

            SessionDelta::ToolCallUpserted { tool_call, .. } => {
                let status = match tool_call.status {
                    ToolCallStatus::Pending => ToolStatus::Pending,
                    ToolCallStatus::Running => ToolStatus::Running,
                    ToolCallStatus::Completed => ToolStatus::Completed,
                    ToolCallStatus::Failed => ToolStatus::Failed,
                };
                let terminal = matches!(status, ToolStatus::Completed | ToolStatus::Failed);

                // Derived, never the wire value: the runtime's `tool_name` is a
                // display title for ACP agents, and grouping by it would produce
                // one bucket per file the agent touched.
                let tool_name = atlas_checkpoint::canonical_name(
                    Some(&tool_call.tool_name),
                    tool_call.title.as_deref(),
                    tool_call.kind.as_deref(),
                    &tool_call.arguments,
                );

                // Sample (and merge) the write set on every sighting, whether
                // or not paths were extractable yet — the sampling *event* is
                // what must be cached, or a late-locations agent gets its
                // `existed_before` re-sampled after the write.
                // A diff block IS a write — the agent attached the before/after
                // for a named file. That outranks the name derivation, which is
                // a heuristic over a title and a `kind` token: an adapter that
                // labels its edit `other` would otherwise have its diffs
                // ignored, which is the same failure one step earlier.
                let (writes, already_recorded) = if tool_name.writes_files()
                    || !diff_paths(&tool_call.content_blocks).is_empty()
                {
                    state.sample_writes(
                        &envelope.session_id,
                        &binding.project_root,
                        tool_call,
                        terminal,
                    )
                } else if tool_name == ToolName::Bash {
                    // A shell command names no file, so the tree around it is
                    // the only evidence of what it wrote (#27). Gated on the
                    // call being shell-SHAPED, never on which agent sent it.
                    (
                        state.shell_window(
                            &envelope.session_id,
                            &tool_call.id,
                            &binding.project_root,
                            terminal,
                        ),
                        false,
                    )
                } else {
                    (Vec::new(), true)
                };

                // Hash on the emit thread at the terminal sighting, while the
                // file is still what the agent left. Deferring the read to the
                // worker means a multi-minute import in the queue lets the
                // developer's later edits get hashed as the agent's — the exact
                // false attribution the link rule exists to prevent. Only the
                // first terminal sighting records; repeats carry nothing.
                //
                // A FAILED call records nothing. `failed` is also where a
                // rejected edit lands, and such a call has still announced its
                // content — so recording its paths claims the agent wrote a
                // file the user refused to let it write. That claim is not
                // harmless: for a file that already existed, the link rule's
                // permissive arm links on paths alone, without consulting the
                // hash, so the next human commit touching it would be credited
                // to a Session whose only edit was declined.
                let succeeded = matches!(status, ToolStatus::Completed);
                let completed: Vec<CompletedWrite> = if terminal && succeeded && !already_recorded {
                    writes
                        .iter()
                        .map(|write| {
                            let absolute = binding.project_root.join(&write.path.path);
                            let (sha256_after, sketch_after, deleted) =
                                match std::fs::read(&absolute) {
                                    Ok(bytes) => (
                                        Some(atlas_checkpoint::hash_written_content(&bytes)),
                                        atlas_checkpoint::sketch::sketch(&bytes),
                                        false,
                                    ),
                                    Err(_) => (None, None, true),
                                };
                            CompletedWrite {
                                path: write.path.clone(),
                                existed_before: write.existed_before,
                                sha256_after,
                                sketch_after,
                                deleted,
                            }
                        })
                        .collect()
                } else {
                    Vec::new()
                };

                // Before `completed` is moved into the job: the patch is
                // stored against the first recorded write, so that is the file
                // whose block it must come from.
                let patch = edit_patch(
                    &tool_call.arguments,
                    &tool_call.content_blocks,
                    completed.first().map(|write| &write.path),
                    &binding.project_root,
                );
                state.submit(Job::ToolCall {
                    binding,
                    native_call_id: tool_call.id.clone(),
                    tool_name,
                    title: tool_call.title.clone(),
                    kind: tool_call.kind.clone(),
                    status,
                    locations: serde_json::Value::Array(tool_call.locations.clone()),
                    arguments: serialize_arguments(&tool_call.arguments),
                    result: tool_call.result.clone(),
                    writes: completed,
                    settled_commits: state.take_settled_commits(&tool_call.id),
                    patch,
                });
            }

            SessionDelta::UsageUpdated { usage } => {
                // A genuine input/output split — only the native agent reports one.
                state.submit(Job::Usage {
                    binding,
                    totals: TokenTotals {
                        input_tokens: usage.input_tokens,
                        output_tokens: usage.output_tokens,
                        cache_creation_tokens: usage.cache_creation_tokens,
                        cache_read_tokens: usage.cache_read_tokens,
                        reasoning_tokens: usage.reasoning_tokens,
                        ..Default::default()
                    },
                });
            }

            SessionDelta::ContextUsage { used, size, .. } => {
                // A context-window gauge, which is a different measurement.
                // Stored in its own fields so it can never be rendered as a
                // usage split; the accurate ACP split is backfilled from the
                // agent's own transcript by the importer.
                state.submit(Job::Usage {
                    binding,
                    totals: TokenTotals {
                        context_used: Some(*used),
                        context_size: Some(*size),
                        ..Default::default()
                    },
                });
            }

            SessionDelta::TurnFinished { .. } | SessionDelta::TurnFailed { .. } => {
                // The streamed bodies are complete now — record them, then
                // close the turn.
                state.flush_turn(&envelope.session_id, &binding);
            }

            SessionDelta::HistoryRewound { turns } => {
                // A retry took the last turn back before re-sending its
                // prompt. Marked in the store so the chat's comment anchors
                // stop counting it; queued behind the turn it takes back.
                state.submit(Job::RewindTurns {
                    binding,
                    turns: i64::from(*turns),
                });
            }

            SessionDelta::AgentDisconnected { .. } => {
                // Record what streamed (a partial transcript beats none), but
                // leave the turn open so it reconciles as aborted; evict every
                // per-session cache so a long-lived process stays bounded.
                state.flush_session_end(&envelope.session_id, &binding);
            }

            _ => {}
        }
    }
}

/// The files a tool call's diff blocks name.
///
/// ACP's `locations` are a SHOULD, and codex acp and cursor acp both skip them:
/// their edits arrive with `locations: []` and no `rawInput`, naming the file
/// only in the attached diff. That is still the agent being structural about
/// which file the edit concerns — the same fact `locations` carries, in the
/// other place the protocol allows it — so it feeds path extraction just as
/// `locations` do. Reading only `locations` recorded no write for those calls,
/// which left the Session nominating no paths and never earning a checkpoint.
///
/// "Concerns", not "wrote": a diff block is an edit the agent is PROPOSING or
/// has made (`ToolContentBlock::Diff`), and in plan mode or behind a permission
/// prompt it is announced before anything reaches disk. What separates the two
/// is how the call ends, so the caller records writes only for a call that
/// ended `completed` — see the note there.
fn diff_paths(blocks: &[ToolContentBlock]) -> Vec<String> {
    blocks
        .iter()
        .filter_map(|block| match block {
            ToolContentBlock::Diff { path, .. } => Some(path.clone()),
            // A terminal block names no file. Whatever the command wrote is
            // invisible to capture either way — that is a separate gap, not
            // one a path guessed from a command line should paper over.
            ToolContentBlock::Terminal { .. } => None,
        })
        .collect()
}

#[cfg(test)]
mod diff_path_tests {
    use super::*;

    fn tool_call(locations: Vec<serde_json::Value>, blocks: Vec<ToolContentBlock>) -> ToolCall {
        ToolCall {
            id: "call-1".to_string(),
            tool_name: "apply_patch".to_string(),
            // The prose title these agents send — it names no file, which is
            // why the diff block is the only path source.
            title: Some("Editing files".to_string()),
            kind: Some("edit".to_string()),
            status: ToolCallStatus::Completed,
            arguments: serde_json::Value::Null,
            result: None,
            locations,
            raw_output: None,
            content_blocks: blocks,
        }
    }

    fn diff(path: &str) -> ToolContentBlock {
        ToolContentBlock::Diff {
            path: path.to_string(),
            old_text: None,
            new_text: "x".to_string(),
        }
    }

    /// The codex acp / cursor acp shape: the diff is the only place the file is
    /// named, so this is what has to reach `extract_paths`.
    #[test]
    fn a_diff_block_yields_the_file_it_edited() {
        assert_eq!(
            diff_paths(&[diff("/repo/index.html")]),
            vec!["/repo/index.html".to_string()]
        );
    }

    /// One call may edit several files; all of them must nominate the Session.
    #[test]
    fn every_diff_block_is_collected_in_order() {
        assert_eq!(
            diff_paths(&[diff("src/a.rs"), diff("src/b.rs")]),
            vec!["src/a.rs".to_string(), "src/b.rs".to_string()]
        );
    }

    // ── Shell-written files (#27) ───────────────────────────────────────────

    fn shell_call(id: &str) -> ToolCall {
        ToolCall {
            id: id.to_string(),
            tool_name: "bash".to_string(),
            title: Some("Bash".to_string()),
            kind: Some("execute".to_string()),
            status: ToolCallStatus::Completed,
            arguments: serde_json::json!({ "command": "sed -i '' s/a/b/ index.html" }),
            result: None,
            locations: Vec::new(),
            raw_output: None,
            content_blocks: Vec::new(),
        }
    }

    /// A git repository with one commit, so `worktree_changes` has a HEAD to
    /// compare against.
    fn repo(name: &str) -> std::path::PathBuf {
        let root = project(name);
        let git = |args: &[&str]| {
            atlas_process::command("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .output()
                .expect("git runs");
        };
        git(&["init", "--initial-branch=main"]);
        git(&["config", "user.email", "dev@example.com"]);
        git(&["config", "user.name", "Dev"]);
        std::fs::write(root.join("seed.txt"), b"seed").expect("fixture");
        git(&["add", "-A"]);
        git(&["commit", "-m", "initial"]);
        root
    }

    /// The bug: a file written by a shell command is named nowhere in the
    /// protocol, so the Session recorded no write and never earned a
    /// checkpoint. The tree around the command is the only evidence there is.
    #[test]
    fn a_file_written_by_a_shell_command_is_attributed() {
        let root = repo("shell-write");
        let state = CaptureState::new();
        let call = shell_call("call-1");

        // Running: the tree is known to predate whatever the command writes.
        assert!(state.shell_window("s1", &call.id, &root, false).is_empty());
        std::fs::write(root.join("index.html"), b"written by sed").expect("the command's write");
        let writes = state.shell_window("s1", &call.id, &root, true);

        assert_eq!(
            writes
                .iter()
                .map(|w| w.path.path.as_str())
                .collect::<Vec<_>>(),
            vec!["index.html"]
        );
        assert!(!writes[0].existed_before, "the command created it");
    }

    /// Only what changed DURING the command. A file the developer had already
    /// left dirty before it started is theirs, and crediting it to the agent
    /// would link their later commits to this Session.
    #[test]
    fn a_file_already_dirty_before_the_command_is_not_attributed() {
        let root = repo("shell-pre-dirty");
        let state = CaptureState::new();
        let call = shell_call("call-1");

        std::fs::write(root.join("mine.txt"), b"the developer's own edit").expect("fixture");
        assert!(state.shell_window("s1", &call.id, &root, false).is_empty());
        std::fs::write(root.join("theirs.txt"), b"the command's").expect("fixture");

        let writes = state.shell_window("s1", &call.id, &root, true);
        assert_eq!(
            writes
                .iter()
                .map(|w| w.path.path.as_str())
                .collect::<Vec<_>>(),
            vec!["theirs.txt"]
        );
    }

    /// No "before", no answer. A call whose first sighting is already terminal
    /// had already run when we heard of it, so everything dirty in the tree
    /// might predate it — and a wrong path is worse than a missing one.
    #[test]
    fn a_command_already_finished_when_first_seen_attributes_nothing() {
        let root = repo("shell-no-before");
        let state = CaptureState::new();
        std::fs::write(root.join("whoknows.txt"), b"who wrote this?").expect("fixture");

        assert!(state.shell_window("s1", "call-1", &root, true).is_empty());
    }

    /// A project that is not a repository has no tree to compare, and that is
    /// not the same as "nothing changed".
    #[test]
    fn a_project_that_is_not_a_repository_attributes_nothing() {
        let root = project("shell-no-repo");
        let state = CaptureState::new();
        std::fs::write(root.join("a.txt"), b"x").expect("fixture");

        assert!(state.shell_window("s1", "call-1", &root, false).is_empty());
        assert!(state.shell_window("s1", "call-1", &root, true).is_empty());
    }

    /// The window is the weakness: git cannot tell the agent's write from the
    /// developer's, so a command that ran long enough for them to have edited
    /// something themselves attributes nothing.
    #[test]
    fn a_command_that_ran_too_long_attributes_nothing() {
        let root = repo("shell-too-long");
        let state = CaptureState::new();

        state.shell_window("s1", "call-1", &root, false);
        // Age the window past the limit rather than sleeping through it.
        {
            let mut windows = lock_ok(&state.shell_windows);
            let window = windows.get_mut("call-1").expect("an open window");
            window.started = Instant::now() - (SHELL_WINDOW_LIMIT + Duration::from_secs(1));
        }
        std::fs::write(root.join("late.txt"), b"whose is this?").expect("fixture");

        assert!(state.shell_window("s1", "call-1", &root, true).is_empty());
    }

    /// The user's exact report on #31: `write && git add && git commit` in ONE
    /// shell call. HEAD has moved and the tree is clean again by the time the
    /// after-snapshot runs, so the status difference is empty — the commits the
    /// window saw HEAD move across are the only remaining evidence.
    #[test]
    fn a_command_that_commits_its_own_writes_is_still_attributed() {
        let root = repo("shell-self-commit");
        let state = CaptureState::new();
        let call = shell_call("call-1");
        let git = |args: &[&str]| {
            atlas_process::command("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .output()
                .expect("git runs");
        };

        assert!(state.shell_window("s1", &call.id, &root, false).is_empty());
        // The command writes, edits, and commits — all inside the window.
        std::fs::write(root.join("made.txt"), b"created by the agent").expect("write");
        std::fs::write(root.join("seed.txt"), b"edited by the agent").expect("edit");
        git(&["add", "-A"]);
        git(&["commit", "-m", "agent: work"]);

        let writes = state.shell_window("s1", &call.id, &root, true);

        let mut paths: Vec<(&str, bool)> = writes
            .iter()
            .map(|w| (w.path.path.as_str(), w.existed_before))
            .collect();
        paths.sort();
        assert_eq!(
            paths,
            vec![("made.txt", false), ("seed.txt", true)],
            "the moved HEAD is evidence, not absence — with existed_before from \
             the commit's own change kinds, not the post-commit index"
        );
    }

    /// The commits the window saw HEAD move across ride along, so the caller
    /// can evaluate exactly those after the touches land — the ordinary walk's
    /// cursor has already gone past them.
    #[test]
    fn the_window_names_the_commits_it_saw_head_move_across() {
        let root = repo("shell-commit-range");
        let state = CaptureState::new();
        let call = shell_call("call-1");
        let git = |args: &[&str]| {
            let out = atlas_process::command("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .output()
                .expect("git runs");
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };

        state.shell_window("s1", &call.id, &root, false);
        std::fs::write(root.join("a.txt"), b"x").expect("write");
        git(&["add", "-A"]);
        git(&["commit", "-m", "agent: a"]);
        let sha = git(&["rev-parse", "HEAD"]);

        let _ = state.shell_window("s1", &call.id, &root, true);
        let settled = state.take_settled_commits(&call.id);
        assert_eq!(settled, vec![sha]);
    }

    /// The user's live repro on claude acp: the adapter announced the command
    /// exactly once, ALREADY COMPLETED — no non-terminal sighting, so no
    /// per-call window could open, and the write+commit inside it attributed
    /// nothing. The turn anchor (HEAD at prompt time) is the fallback: coarser
    /// than a call window, still exact evidence.
    #[test]
    fn a_call_first_seen_completed_falls_back_to_the_turn_anchor() {
        let root = repo("shell-terminal-first");
        let state = CaptureState::new();
        // The prompt is where the anchor is taken.
        state.note_prompt(
            "s1",
            root.to_str().unwrap(),
            "claude-code",
            None,
            "add a test file",
        );

        // The command runs and commits before capture ever sights the call…
        std::fs::write(root.join("test.txt"), b"test file").expect("write");
        let git = |args: &[&str]| {
            atlas_process::command("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .output()
                .expect("git runs");
        };
        git(&["add", "-A"]);
        git(&["commit", "-m", "agent: add test file"]);

        // …and the FIRST sighting is already terminal.
        let call = shell_call("call-1");
        let writes = state.shell_window("s1", &call.id, &root, true);

        assert_eq!(
            writes
                .iter()
                .map(|w| w.path.path.as_str())
                .collect::<Vec<_>>(),
            vec!["test.txt"]
        );
        assert!(!writes[0].existed_before, "the commit created it");
        assert_eq!(
            state.take_settled_commits(&call.id).len(),
            1,
            "the commit rides along for the cursor-blind evaluation"
        );
    }

    /// The anchor advances after use: a second sighting-starved call in the
    /// same turn cannot re-claim the commits the first one settled.
    #[test]
    fn the_turn_anchor_advances_so_commits_are_claimed_once() {
        let root = repo("shell-anchor-advances");
        let state = CaptureState::new();
        state.note_prompt("s1", root.to_str().unwrap(), "claude-code", None, "work");

        std::fs::write(root.join("a.txt"), b"a").expect("write");
        let git = |args: &[&str]| {
            atlas_process::command("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .output()
                .expect("git runs");
        };
        git(&["add", "-A"]);
        git(&["commit", "-m", "agent: a"]);

        let first = state.shell_window("s1", "call-1", &root, true);
        assert_eq!(first.len(), 1);

        // A later call in the same turn, also first-seen terminal, with no new
        // commit: nothing left to claim.
        let second = state.shell_window("s1", "call-2", &root, true);
        assert!(second.is_empty(), "the anchor moved with the first claim");
        assert!(state.take_settled_commits("call-2").is_empty());
    }

    /// A window whose command never reported an ending must not hold its
    /// snapshot for the life of the process.
    #[test]
    fn an_unfinished_window_is_dropped_with_its_session() {
        let root = repo("shell-forget");
        let state = CaptureState::new();

        state.shell_window("s1", "call-1", &root, false);
        assert_eq!(lock_ok(&state.shell_windows).len(), 1);

        state.forget_shell_windows(&["call-1".to_string()]);
        assert!(lock_ok(&state.shell_windows).is_empty());
    }

    /// A terminal block is not a file write — capture must not invent a path
    /// for it.
    #[test]
    fn a_terminal_block_names_no_file() {
        assert!(diff_paths(&[ToolContentBlock::Terminal {
            terminal_id: "t1".to_string()
        }])
        .is_empty());
        assert!(diff_paths(&[]).is_empty());
    }

    /// A directory of this test's own. The path feeds `existed_before`, which
    /// reads the filesystem — a shared fixed path would make one test's leavings
    /// another's input.
    fn project(name: &str) -> std::path::PathBuf {
        let root =
            std::env::temp_dir().join(format!("atlas-capture-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("test project");
        root
    }

    /// The wiring, not just the helper. This is the regression: sampling a call
    /// shaped like codex acp's — no locations, no arguments, one diff block —
    /// must yield a write, because a Session that records no write nominates no
    /// path and therefore never earns a checkpoint.
    ///
    /// Reverting `sample_writes` to read only `locations`/`arguments` fails
    /// here, which a test of `diff_paths` or `extract_paths` alone would not.
    #[test]
    fn a_call_naming_its_file_only_in_a_diff_block_records_a_write() {
        let root = project("diff-block-write");
        let state = CaptureState::new();
        let call = tool_call(
            Vec::new(),
            vec![diff(&root.join("index.html").to_string_lossy())],
        );

        let (writes, _) = state.sample_writes("session-1", &root, &call, true);

        assert_eq!(
            writes
                .iter()
                .map(|w| w.path.path.as_str())
                .collect::<Vec<_>>(),
            vec!["index.html"],
            "the diff block's absolute path resolves relative to the project"
        );
        assert!(!writes[0].path.out_of_repo, "it is inside the project");
        assert!(
            !writes[0].existed_before,
            "the file is not in the project, and the project is no git repo"
        );
    }

    /// The same call with its diff block removed records nothing — which is the
    /// state every codex acp and cursor acp edit was in.
    #[test]
    fn the_same_call_without_a_diff_block_records_nothing() {
        let root = project("no-diff-block");
        let state = CaptureState::new();
        let call = tool_call(Vec::new(), Vec::new());

        let (writes, _) = state.sample_writes("session-1", &root, &call, true);

        assert!(writes.is_empty());
    }

    /// `existed_before` decides which arm of the link rule can fire, so the
    /// diff-block paths must be sampled the same way location paths are.
    #[test]
    fn a_file_already_on_disk_is_sampled_as_pre_existing() {
        let root = project("diff-block-existing");
        std::fs::write(root.join("index.html"), b"before").expect("fixture");
        let state = CaptureState::new();
        let call = tool_call(
            Vec::new(),
            vec![diff(&root.join("index.html").to_string_lossy())],
        );

        // Not yet terminal, first sighting: the filesystem still answers
        // truthfully, which is the branch that reads it.
        let (writes, _) = state.sample_writes("session-1", &root, &call, false);

        assert!(writes[0].existed_before);
    }

    // ── The write-detection gate ────────────────────────────────────────────

    /// The gate the fix widened. `canonical_name` is a heuristic over a title
    /// and a `kind` token; an adapter free to label its edit `other` would have
    /// had its diffs ignored, which is the same failure one step earlier. A
    /// diff block settles it on its own.
    #[test]
    fn a_diff_block_is_enough_even_when_the_name_says_nothing_about_writing() {
        let mut call = tool_call(Vec::new(), vec![diff("/repo/index.html")]);
        call.tool_name = "shell".to_string();
        call.title = Some("Working".to_string());
        call.kind = Some("other".to_string());

        let tool_name = atlas_checkpoint::canonical_name(
            Some(&call.tool_name),
            call.title.as_deref(),
            call.kind.as_deref(),
            &call.arguments,
        );
        assert!(
            !tool_name.writes_files(),
            "precondition: this name is not write-shaped"
        );
        assert!(
            !diff_paths(&call.content_blocks).is_empty(),
            "but the call carries a diff, which is what opens the gate"
        );
    }

    // ── The patch an edit applied ───────────────────────────────────────────

    /// The agents this fix targets send no `rawInput`, so the block is the only
    /// before/after there is. Without this their checkpoints formed while their
    /// attribution input stayed empty.
    #[test]
    fn the_patch_comes_from_the_diff_block_when_the_arguments_carry_none() {
        let patch = edit_patch(
            &serde_json::Value::Null,
            &[ToolContentBlock::Diff {
                path: "/repo/a.rs".to_string(),
                old_text: Some("one".to_string()),
                new_text: "two".to_string(),
            }],
            None,
            std::path::Path::new("/repo"),
        )
        .expect("a patch");
        assert!(patch.contains("-one"), "{patch}");
        assert!(patch.contains("+two"), "{patch}");
    }

    /// Both halves come from ONE description of the edit. Splicing an `old`
    /// from the arguments onto a `new` from a block invents a before/after
    /// neither of them claimed.
    #[test]
    fn the_two_halves_are_never_spliced_across_sources() {
        let patch = edit_patch(
            &serde_json::json!({ "old_string": "from-args" }),
            &[ToolContentBlock::Diff {
                path: "/repo/a.rs".to_string(),
                old_text: Some("from-block".to_string()),
                new_text: "block-new".to_string(),
            }],
            None,
            std::path::Path::new("/repo"),
        )
        .expect("a patch");
        assert!(patch.contains("-from-args"), "{patch}");
        assert!(
            !patch.contains("block-new"),
            "the arguments won, so the block contributes nothing: {patch}"
        );
    }

    /// A call editing several files carries one patch EACH, and the patch is
    /// stored against the first recorded write — which need not be the first
    /// block. Storing one file's patch under another's name is worse than
    /// storing none.
    #[test]
    fn the_patch_is_taken_from_the_block_for_the_file_it_is_stored_against() {
        let blocks = vec![
            ToolContentBlock::Diff {
                path: "/repo/a.rs".to_string(),
                old_text: Some("a-old".to_string()),
                new_text: "a-new".to_string(),
            },
            ToolContentBlock::Diff {
                path: "/repo/b.rs".to_string(),
                old_text: Some("b-old".to_string()),
                new_text: "b-new".to_string(),
            },
        ];
        let target =
            atlas_checkpoint::tools::resolve_path("/repo/b.rs", std::path::Path::new("/repo"));

        let patch = edit_patch(
            &serde_json::Value::Null,
            &blocks,
            Some(&target),
            std::path::Path::new("/repo"),
        )
        .expect("a patch");

        assert!(patch.contains("-b-old"), "{patch}");
        assert!(
            !patch.contains("a-old"),
            "not the other file's patch: {patch}"
        );
    }

    /// With several blocks and nothing to pair against, which one applies is
    /// unknowable — and a wrong patch is worse than none.
    #[test]
    fn several_blocks_and_no_target_yields_no_patch() {
        let blocks = vec![
            ToolContentBlock::Diff {
                path: "/repo/a.rs".to_string(),
                old_text: None,
                new_text: "a".to_string(),
            },
            ToolContentBlock::Diff {
                path: "/repo/b.rs".to_string(),
                old_text: None,
                new_text: "b".to_string(),
            },
        ];
        assert!(edit_patch(
            &serde_json::Value::Null,
            &blocks,
            None,
            std::path::Path::new("/repo")
        )
        .is_none());
    }
}

#[cfg(test)]
mod sync_worker_tests {
    //! Syncing never blocks recording, and one Project's backlog never blocks
    //! another's sync. The real [`sync_worker`] against a slow stub ingest.

    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;

    use atlas_checkpoint::{Capture, Role, SessionKey, Source, SyncState, TurnContent};

    use super::*;

    #[test]
    fn a_drain_asked_for_twice_is_queued_once_and_remembers_it_was_forced() {
        let (a, b) = (PathBuf::from("/a"), PathBuf::from("/b"));
        let mut queue = SyncQueue::default();
        queue.push(SyncRequest::Drain {
            project_root: a.clone(),
            forced: false,
        });
        queue.push(SyncRequest::Drain {
            project_root: b.clone(),
            forced: false,
        });
        queue.push(SyncRequest::Drain {
            project_root: a.clone(),
            forced: true,
        });
        queue.push(SyncRequest::Import {
            project_root: a.clone(),
        });
        queue.push(SyncRequest::Import {
            project_root: a.clone(),
        });
        assert_eq!(
            queue.next_drain(),
            Some((a.clone(), true)),
            "once, and forced"
        );
        assert_eq!(queue.next_drain(), Some((b, false)));
        assert_eq!(queue.next_drain(), None);
        assert_eq!(queue.next_import(), Some(a));
        assert_eq!(queue.next_import(), None);
        assert!(queue.is_empty());
    }

    #[test]
    fn a_yielded_drain_goes_to_the_back_of_the_line() {
        let (a, b) = (PathBuf::from("/a"), PathBuf::from("/b"));
        let mut queue = SyncQueue::default();
        queue.push(SyncRequest::Drain {
            project_root: a.clone(),
            forced: true,
        });
        queue.push(SyncRequest::Drain {
            project_root: b.clone(),
            forced: true,
        });
        let (first, _) = queue.next_drain().unwrap();
        queue.requeue(first);
        assert_eq!(
            queue.next_drain().map(|(r, _)| r),
            Some(b),
            "b's turn before a's second pass"
        );
        assert_eq!(queue.next_drain().map(|(r, _)| r), Some(a));
    }

    /// An ingest that accepts every batch after `delay`, counting batches per
    /// wire project id.
    fn slow_ingest(delay: Duration) -> (String, Arc<Mutex<HashMap<String, usize>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let batches: Arc<Mutex<HashMap<String, usize>>> = Arc::default();
        let seen = batches.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let seen = seen.clone();
                std::thread::spawn(move || {
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut line = String::new();
                    let _ = reader.read_line(&mut line);
                    let mut length = 0usize;
                    loop {
                        let mut header = String::new();
                        if reader.read_line(&mut header).unwrap_or(0) == 0
                            || header.trim().is_empty()
                        {
                            break;
                        }
                        if let Some((k, v)) = header.split_once(':') {
                            if k.trim().eq_ignore_ascii_case("content-length") {
                                length = v.trim().parse().unwrap_or(0);
                            }
                        }
                    }
                    let mut body = vec![0u8; length];
                    let _ = reader.read_exact(&mut body);
                    let body = String::from_utf8_lossy(&body);
                    for wire in ["rw-a", "rw-b"] {
                        if body.contains(wire) {
                            *seen.lock().unwrap().entry(wire.to_string()).or_default() += 1;
                        }
                    }
                    std::thread::sleep(delay);
                    let _ = stream
                        .write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
                });
            }
        });
        (url, batches)
    }

    /// A cloud-bound Project with `sessions` recorded Sessions pending.
    fn cloud_project(dir: &Path, wire: &str, sessions: usize) -> StoreHandle {
        let root = dir.to_string_lossy().to_string();
        let mut store = Store::open(atlas_checkpoint::atlas_dir(dir)).unwrap();
        atlas_checkpoint::bind(&store, &root, dir, ProjectMode::Local).unwrap();
        store
            .promote_to_cloud(&root, "org-1", wire, Some(wire))
            .unwrap();
        for i in 0..sessions {
            record(&mut store, &root, &format!("{wire}-{i}"));
        }
        StoreHandle {
            store: Arc::new(Mutex::new(store)),
            is_writer: true,
        }
    }

    fn record(store: &mut Store, root: &str, native: &str) {
        let mut capture = Capture::new(store, ProjectMode::Cloud);
        let key = SessionKey {
            workspace_id: root.to_string(),
            source: Source::Native,
            native_session_id: native.into(),
        };
        let session = capture
            .record_prompt(&key, "do the thing", 1, None, None, None)
            .unwrap();
        capture
            .record_turn(
                &session,
                TurnContent {
                    turn_seq: 1,
                    native_message_id: Some(format!("{native}-m")),
                    role: Role::Assistant,
                    mode: atlas_checkpoint::Mode::Text,
                    body: "done".into(),
                    created_at: None,
                },
            )
            .unwrap();
    }

    fn pending(handle: &StoreHandle, root: &Path) -> i64 {
        lock_ok(&handle.store)
            .row_count_in_state(&root.to_string_lossy(), SyncState::Pending)
            .unwrap()
    }

    /// The case reported: Project A was promoted with a large local backlog.
    /// While A syncs, (1) a turn in A records at once, (2) Project B's small
    /// queue is sent without waiting for A's backlog, and (3) A still drains
    /// completely, including what was recorded mid-sync.
    #[test]
    fn a_projects_backlog_blocks_neither_recording_nor_another_projects_sync() {
        let (a_dir, b_dir) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let a = cloud_project(a_dir.path(), "rw-a", 300);
        let b = cloud_project(b_dir.path(), "rw-b", 1);
        let (a_root, b_root) = (a_dir.path().to_path_buf(), b_dir.path().to_path_buf());
        let stores: StoreRegistry = Arc::default();
        lock_ok(&stores).insert(a_root.clone(), a.clone());
        lock_ok(&stores).insert(b_root.clone(), b.clone());

        let (url, batches) = slow_ingest(Duration::from_millis(900));
        let token: TokenProvider = Arc::new(Mutex::new(Some(Box::new(|| Some("t".to_string())))));
        let (tx, rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let ingest: Box<dyn Fn() -> String + Send> = Box::new(move || url.clone());
            sync_worker(
                rx,
                token,
                Arc::default(),
                stores,
                Arc::new(AtomicBool::new(true)),
                ingest,
            )
        });
        tx.send(SyncRequest::Drain {
            project_root: a_root.clone(),
            forced: true,
        })
        .unwrap();
        tx.send(SyncRequest::Drain {
            project_root: b_root.clone(),
            forced: true,
        })
        .unwrap();

        // (1) A is mid-upload: its recorder's store is free, a turn records now.
        let started = Instant::now();
        while batches.lock().unwrap().get("rw-a").copied().unwrap_or(0) == 0 {
            assert!(
                started.elapsed() < Duration::from_secs(20),
                "A never started syncing"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        let recorded = Instant::now();
        record(
            &mut lock_ok(&a.store),
            &a_root.to_string_lossy(),
            "live-during-sync",
        );
        assert!(
            recorded.elapsed() < Duration::from_millis(500),
            "recording in A waited {:?}",
            recorded.elapsed()
        );

        // (2) B's queue is sent while A still has a backlog.
        while pending(&b, &b_root) > 0 {
            assert!(
                started.elapsed() < Duration::from_secs(30),
                "B was never synced"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(pending(&a, &a_root) > 0, "B waited for A's whole backlog");

        // (3) A still finishes, including what was recorded mid-sync.
        while pending(&a, &a_root) > 0 {
            assert!(
                started.elapsed() < Duration::from_secs(90),
                "A never finished: {} pending",
                pending(&a, &a_root)
            );
            std::thread::sleep(Duration::from_millis(100));
        }
        drop(tx);
        worker.join().unwrap();
    }
}
