//! `memory_indexer` — the decoupled background indexing infrastructure (Step 4).
//!
//! Two pieces live here, both in the Tauri app layer (never in `atlas-memory`,
//! which stays Tauri-free):
//!
//! - [`MemoryRegistry`] — a `cwd → Arc<RwLock<MemoryEngine>>` map stored as a
//!   Tauri managed `State`. It is the **single owner** of each project's engine:
//!   the retrieve closure (Step 6, read lock) and the indexer (write lock) both
//!   reach the right engine through it. Opening a project for the first time runs
//!   the Step-3 legacy migration (inside `MemoryEngine::open`), starts an FS
//!   watcher, and enqueues an initial cold [`Job::IndexCorpus`].
//! - [`MemoryIndexer`] — one owned Tokio task draining a **bounded** `mpsc` queue.
//!   Every [`Job`] carries a `cwd` so projects stay isolated. Only `IndexCorpus`
//!   is implemented in Step 4; `ExtractSession` (Step 7) and `Compact` (Step 9a)
//!   are logged no-ops for now.
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
use tauri::{AppHandle, Manager, State};
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
// `ExtractSession`/`Compact` are wired in Steps 7 / 9a; defined now so the queue
// shape and worker match arms are stable across those steps.
#[allow(dead_code)]
pub enum Job {
    /// (Re)index a project's whole corpus into its HNSW store. Step 4.
    IndexCorpus { cwd: String },
    /// Extract distilled memories from a finished session. Step 7 (no-op here).
    ExtractSession {
        cwd: String,
        agent: String,
        session: String,
    },
    /// Idle-time consolidation + prune. Step 9a (no-op here).
    Compact { cwd: String },
}

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
        }
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

    /// Open-or-return the engine for `cwd`. On the **first** open it runs the
    /// Step-3 legacy migration (inside `MemoryEngine::open`), starts the FS
    /// watcher, and enqueues an initial cold `IndexCorpus{cwd}` — so a freshly
    /// opened project is indexed even before the watcher fires. Subsequent calls
    /// just clone the existing handle (no re-enqueue, no second watcher).
    pub fn engine_for(&self, cwd: &str) -> Arc<RwLock<MemoryEngine>> {
        if let Some(existing) = self.engines.get(cwd) {
            return existing.value().clone();
        }

        // Build outside the map so the shard lock isn't held across the (one-time)
        // migration I/O. A lost race is harmless: `or_insert_with` keeps whoever
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
            // Cold index on open. Drop-on-full is fine (watcher/force_reindex retry).
            let _ = self.job_tx.try_send(Job::IndexCorpus {
                cwd: cwd.to_string(),
            });
            // One-time idle-consolidation nudge (Step 9a). The AutoDream 24h/≥5
            // -session gate makes this a near-no-op until actually due, so a
            // per-open enqueue is safe; drop-on-full is fine.
            let _ = self.job_tx.try_send(Job::Compact {
                cwd: cwd.to_string(),
            });
        }
        inserted
    }

    /// Enqueue a job (non-blocking). Drops on a full queue rather than stalling
    /// the caller — the IPC thread must never block on indexing.
    pub fn enqueue(&self, job: Job) -> Result<(), String> {
        self.job_tx
            .try_send(job)
            .map_err(|e| format!("indexer queue: {e}"))
    }

    /// Fire-and-forget background reindex nudge for `cwd` (Step 5). Designed to
    /// be called from the hot `TauriDeltaSink::emit` path on `TurnFinished`: it
    /// **never blocks and never `.await`s**. A full queue is dropped with a
    /// `debug` log (a later FS-watcher tick or `force_reindex` re-enqueues);
    /// a closed queue (app shutting down) is likewise a silent drop.
    pub fn enqueue_index(&self, cwd: &str) {
        use tokio::sync::mpsc::error::TrySendError;
        match self.job_tx.try_send(Job::IndexCorpus {
            cwd: cwd.to_string(),
        }) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                tracing::debug!(
                    target: "atlas::memory_indexer",
                    "reindex nudge dropped (queue full): {cwd}"
                );
            }
            Err(TrySendError::Closed(_)) => {
                tracing::debug!(
                    target: "atlas::memory_indexer",
                    "reindex nudge dropped (indexer stopped): {cwd}"
                );
            }
        }
    }

    /// Get-only lookup: the engine if this project is currently open, `None`
    /// otherwise. Background jobs (index/compact) use this instead of
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
    ///  - `<cwd>/.atlas/codebase-index/docs.json` → watched when present
    ///    (created later → picked up next open; the codebase-index build
    ///    enqueues its own reindex anyway),
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

                // The persisted codebase index, when it exists.
                let codebase_index = Path::new(cwd).join(".atlas").join("codebase-index");
                if codebase_index.is_dir()
                    && w
                        .watch(&codebase_index, notify::RecursiveMode::Recursive)
                        .is_ok()
                    {
                        watched_any = true;
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

/// True for paths the corpus is built from: any `*.md`, `CLAUDE.md`, `AGENTS.md`,
/// or the codebase index's `codebase-index/docs.json`. Dependency/build trees
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
    if name == "docs.json"
        && path
            .components()
            .any(|c| c.as_os_str() == "codebase-index")
    {
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
        while let Some(job) = rx.recv().await {
            match job {
                Job::IndexCorpus { cwd } => {
                    // Shared provider — loaded once, reused by retrieve too.
                    let Some(prov) = registry.provider(&app).await else {
                        tracing::warn!(
                            target: "atlas::memory_indexer",
                            "IndexCorpus {cwd}: MiniLM model not downloaded; skipping"
                        );
                        continue;
                    };
                    if let Err(e) = index_one(&registry, &cwd, &prov).await {
                        tracing::warn!(target: "atlas::memory_indexer", "IndexCorpus {cwd} failed: {e}");
                    }
                }
                Job::ExtractSession {
                    cwd,
                    agent,
                    session,
                } => {
                    if let Err(e) = extract_one(&app, &registry, &cwd, &agent, &session).await {
                        tracing::debug!(
                            target: "atlas::memory_indexer",
                            "ExtractSession {cwd} ({agent}/{session}) failed: {e}"
                        );
                    }
                }
                Job::Compact { cwd } => {
                    if let Err(e) = compact_one(&registry, &cwd).await {
                        tracing::warn!(
                            target: "atlas::memory_indexer",
                            "Compact {cwd} failed: {e}"
                        );
                    }
                }
            }
        }
    }
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
    Ok(())
}

/// Idle-time consolidation + prune (Step 9a) for `cwd`, off the hot path.
///
/// Delegates to `atlas_memory::consolidate`, which uses Cersei's `AutoDream` for
/// the 24h/≥5-session gate + lock and runs our own memdir prune. Cheap when not
/// due — the gate short-circuits before any work — so the per-open enqueue from
/// [`MemoryRegistry::engine_for`] is a safe near-no-op. Takes the engine **write
/// lock** (consolidation is rare and serialized with indexing on this one task).
async fn compact_one(registry: &MemoryRegistry, cwd: &str) -> Result<(), String> {
    // Get-only for the same reason as `index_one`: don't resurrect a closed
    // project. Consolidation for it becomes due again next open.
    let Some(engine) = registry.open_engine(cwd) else {
        return Ok(());
    };
    let mut guard = engine.write().await;
    let outcome = atlas_memory::consolidate(&mut guard).map_err(|e| e.to_string())?;
    drop(guard);
    tracing::info!(
        target: "atlas::memory_indexer",
        "Compact {cwd}: {outcome:?}"
    );
    Ok(())
}

/// Native session extraction (Step 7) — replaces call site B for **all three**
/// agents, off the hot path and behind Cersei's gates.
///
/// Reads the session's transcript through the unified `AgentManager` snapshot
/// (which already normalises Cersei native / Claude Code JSONL / Codex into one
/// role/content/tool-call message shape — the single format adapter), converts it
/// to neutral [`atlas_memory::TranscriptTurn`]s, takes the engine **read lock**
/// (graph writes are `&self`, so no write lock is needed just to store an
/// extracted memory), and calls `atlas_memory::extract::extract_and_store` with a
/// BYOK `llm` closure that **reuses `memory_summarize::run_completion`** — the
/// same provider plumbing the legacy `memory_compile` uses. `atlas-memory` stays
/// BYOK-free; the model call is injected here.
///
/// No-op (same contract as `memory_compile`) unless the project opted into a BYOK
/// summarizer provider — so the default-OFF path costs nothing.
#[expect(
    clippy::await_holding_invalid_type,
    reason = "extract_and_store borrows the graph out of the guard; see the comment at the read()"
)]
async fn extract_one(
    app: &AppHandle,
    registry: &MemoryRegistry,
    cwd: &str,
    agent: &str,
    session: &str,
) -> Result<(), String> {
    use super::agent_host::{AgentHost, SessionKey};
    use atlas_agent_wire::{AgentId, MessageRole};

    use super::memory_sharing::MemorySharingState;

    // Gate on the BYOK summarizer pref — mirrors `compile_finished_turn`'s
    // no-op-without-a-key behaviour so the new path is cost-neutral when unconfigured.
    let sharing = app.state::<MemorySharingState>();
    if !sharing.is_enabled(cwd) {
        return Ok(());
    }
    let pref = sharing.summarizer_pref(cwd);
    if pref.mode != "provider" || pref.provider.is_empty() || pref.model.is_empty() {
        return Ok(());
    }

    // Resolve the unified snapshot for this agent's session.
    let agent_uuid =
        uuid::Uuid::parse_str(agent).map_err(|e| format!("invalid agent id {agent}: {e}"))?;
    let key = SessionKey {
        agent_id: AgentId(agent_uuid),
        session_id: session.to_string(),
    };
    let host = app.state::<std::sync::Arc<AgentHost>>();
    let snapshot = host.snapshot(&key).map_err(|e| format!("snapshot: {e}"))?;

    let turns: Vec<atlas_memory::TranscriptTurn> = snapshot
        .messages
        .iter()
        .map(|m| atlas_memory::TranscriptTurn {
            role: match m.role {
                MessageRole::User => "user",
                MessageRole::Assistant => "assistant",
                MessageRole::System => "system",
            }
            .to_string(),
            text: m.content.clone(),
            tool_calls: m.tool_calls.len(),
        })
        .collect();

    // Engine read lock held across the (single, gated) BYOK call: reads are
    // shared, the indexer runs jobs serially, and graph writes are `&self`.
    let engine = registry.engine_for(cwd);
    let guard = engine.read().await;
    let graph = guard.graph();
    let memory_dir = guard.memory_dir().to_path_buf();
    let mut state = atlas_memory::ExtractState::load(&memory_dir, session);

    let app_for_llm = app.clone();
    let provider = pref.provider.clone();
    let model = pref.model.clone();
    let stored = atlas_memory::extract::extract_and_store(
        &turns,
        &mut state,
        graph,
        &memory_dir,
        session,
        move |prompt| async move {
            super::memory_summarize::run_completion(&app_for_llm, prompt, &provider, &model)
                .await
                .map_err(|e| anyhow::anyhow!(e))
        },
    )
    .await
    .map_err(|e| e.to_string())?;
    drop(guard);

    if stored > 0 {
        tracing::info!(
            target: "atlas::memory_indexer",
            "extracted {stored} memories from {agent}/{session}; reindexing {cwd}"
        );
        // Make the freshly written `extracted/*.md` searchable in HNSW this cycle.
        let _ = registry.enqueue(Job::IndexCorpus {
            cwd: cwd.to_string(),
        });
    }
    Ok(())
}

/// Text actually embedded for a doc — title prepended for short-doc signal.
/// Matches `memory_graph::embed_text` so a doc's `content_hash` is stable across
/// the legacy migration and this indexer (post-migration re-index is a near no-op).
fn embed_text(doc: &MemoryDoc) -> String {
    if doc.text.trim().is_empty() {
        doc.title.clone()
    } else {
        format!("{}\n\n{}", doc.title, doc.text)
    }
}

/// SHA-256 hex of `s` — identical hashing to `memory_graph::hash_text`.
fn hash_text(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    format!("{:x}", h.finalize())
}

/// Map an `agent_memory::MemoryDoc` onto the neutral `atlas_memory::CorpusDoc`.
fn to_corpus_doc(doc: &MemoryDoc) -> CorpusDoc {
    let text = embed_text(doc);
    let content_hash = hash_text(&text);
    CorpusDoc {
        id: doc.id.clone(),
        text,
        content_hash,
        corpus: doc.source.clone(),
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

/// Workspace-close teardown: release `cwd`'s engine, FS watcher and debounce
/// task. Counterpart of `fileindex_close_project`/`git_watch_stop` — without it
/// every workspace ever opened kept a recursive FSEvents stream + an in-RAM
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
        assert!(is_corpus_path(Path::new(
            "/p/.atlas/codebase-index/docs.json"
        )));
        assert!(!is_corpus_path(Path::new("/p/main.rs")));
        assert!(!is_corpus_path(Path::new("/p/other/docs.json")));
        assert!(!is_corpus_path(Path::new("/p/data.json")));
    }

    /// `enqueue_index` (the hot-path `TurnFinished` nudge) must NEVER block and
    /// must drop gracefully when the queue is full. The queue here has capacity 1
    /// and is never drained, so a blocking send would hang this test forever —
    /// completing at all proves it is non-blocking.
    #[test]
    fn enqueue_index_never_blocks_and_drops_when_full() {
        let (job_tx, mut job_rx) = mpsc::channel::<Job>(1);
        let registry = MemoryRegistry::new(job_tx);

        // First nudge fills the single slot.
        registry.enqueue_index("/proj/a");
        // Queue is now full — these overflow nudges must be DROPPED, not block.
        registry.enqueue_index("/proj/a");
        registry.enqueue_index("/proj/b");

        // Exactly one job made it in; the overflow was dropped gracefully.
        match job_rx.try_recv() {
            Ok(Job::IndexCorpus { cwd }) => assert_eq!(cwd, "/proj/a"),
            other => panic!("expected exactly one IndexCorpus, got {other:?}"),
        }
        assert!(
            job_rx.try_recv().is_err(),
            "overflow reindex nudges must be dropped, not queued"
        );
    }

    /// N rapid FS signals collapse into exactly ONE `IndexCorpus` job.
    #[tokio::test]
    async fn debounce_coalesces_burst_into_one_job() {
        let (sig_tx, sig_rx) = mpsc::channel::<()>(64);
        let (job_tx, mut job_rx) = mpsc::channel::<Job>(16);
        let window = Duration::from_millis(80);

        let handle = tokio::spawn(debounce_loop(
            sig_rx,
            job_tx,
            "/proj/a".to_string(),
            window,
        ));

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
        assert!(
            job_rx.try_recv().is_err(),
            "first open enqueues exactly IndexCorpus + Compact"
        );

        // Second open of the same project: same engine handle, no new jobs.
        let _e2 = registry.engine_for(&cwd);
        assert!(
            job_rx.try_recv().is_err(),
            "re-opening must not re-enqueue any job"
        );

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
        assert!(dir_a.starts_with(&root_a), "A dir {dir_a:?} not under {root_a:?}");
        assert!(dir_b.starts_with(&root_b), "B dir {dir_b:?} not under {root_b:?}");
        assert!(!dir_a.starts_with(&root_b));
        assert!(!dir_b.starts_with(&root_a));

        std::fs::remove_dir_all(&root_a).ok();
        std::fs::remove_dir_all(&root_b).ok();
    }
}
