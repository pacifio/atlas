//! Who owns each project's code index: one [`CodeIndex`] and one worker
//! thread per open project root, fed by a coalescing job queue.
//!
//! The queue is bounded by construction: it holds at most one full build,
//! one reconcile, and a set of paths. A full build absorbs everything queued
//! behind it, a reconcile absorbs queued paths, and more than
//! [`MAX_PENDING_PATHS`] paths (a branch switch, `npm install` leaking past
//! the filters) collapse into one reconcile. Tauri-free so it is testable;
//! `mod.rs` wires it to the app.
//!
//! Embedding (Phase 4) is the lowest priority: a `Vectors` job runs only when
//! no index job is queued, any new index job cancels a running one between
//! batches, and a cancelled sync re-queues itself behind that job.

use std::collections::{BTreeSet, HashMap};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError, RwLock};

use atlas_codeindex::CodeIndex;
use atlas_search::CancelToken;
use tokio::sync::oneshot;

/// Queued watcher paths beyond this become one reconcile.
pub const MAX_PENDING_PATHS: usize = 2048;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Job {
    FullBuild,
    Paths(Vec<PathBuf>),
    Reconcile,
    /// Embed chunks that have no vector for the current code model.
    Vectors,
}

impl Job {
    pub fn label(&self) -> &'static str {
        match self {
            Self::FullBuild => "full_build",
            Self::Paths(_) => "paths",
            Self::Reconcile => "reconcile",
            Self::Vectors => "vectors",
        }
    }
}

/// The code embedding model the app loaded, if any; shared by every worker.
type EmbedderSlot = Arc<RwLock<Option<Arc<dyn atlas_codeindex::Embedder>>>>;

/// Told about every finished job: the project path as first opened, the job,
/// and whether rows changed (or the error).
pub type JobObserver = Arc<dyn Fn(&str, &'static str, &Result<bool, String>) + Send + Sync>;

type Waiter = oneshot::Sender<Result<(), String>>;

#[derive(Default)]
struct Pending {
    full: bool,
    reconcile: bool,
    paths: BTreeSet<PathBuf>,
    /// A vector sync is wanted once the index jobs are done.
    vectors: bool,
    waiters: Vec<Waiter>,
}

impl Pending {
    fn push(&mut self, job: Job) {
        match job {
            Job::FullBuild => {
                self.full = true;
                self.reconcile = false;
                self.paths.clear();
            }
            Job::Reconcile if !self.full => {
                self.reconcile = true;
                self.paths.clear();
            }
            Job::Paths(paths) if !self.full && !self.reconcile => {
                self.paths.extend(paths);
                if self.paths.len() > MAX_PENDING_PATHS {
                    self.paths.clear();
                    self.reconcile = true;
                }
            }
            Job::Reconcile | Job::Paths(_) => {}
            Job::Vectors => self.vectors = true,
        }
    }

    /// Index work (or someone waiting on it) is queued.
    fn has_index_work(&self) -> bool {
        self.full || self.reconcile || !self.paths.is_empty() || !self.waiters.is_empty()
    }

    fn is_empty(&self) -> bool {
        !self.has_index_work() && !self.vectors
    }

    /// The one index job that covers everything queued, with everyone waiting
    /// on it; a queued vector sync stays queued behind it. Only when no index
    /// work is left does the vector sync come out.
    fn take(&mut self) -> Option<(Job, Vec<Waiter>)> {
        if self.has_index_work() {
            let vectors = self.vectors;
            let taken = std::mem::take(self);
            self.vectors = vectors;
            let job = if taken.full {
                Job::FullBuild
            } else if taken.reconcile {
                Job::Reconcile
            } else {
                Job::Paths(taken.paths.into_iter().collect())
            };
            return Some((job, taken.waiters));
        }
        if self.vectors {
            self.vectors = false;
            return Some((Job::Vectors, Vec::new()));
        }
        None
    }
}

struct Queue {
    pending: Mutex<Pending>,
    wake: Condvar,
    closed: AtomicBool,
    /// The running vector sync's token: a new index job cancels it.
    running_vectors: Mutex<Option<CancelToken>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// One open project: its index and the handle to its worker.
pub struct ProjectIndex {
    pub index: Arc<CodeIndex>,
    /// The path the project was first opened with (the frontend's spelling),
    /// for callers keyed by it, such as the memory registry.
    pub opened_as: String,
    /// The grep prefilter (Phase 5), at a git work-tree root only. Fed by
    /// the watchers; built in the background; never needed for correctness.
    pub(super) grep: Option<Arc<atlas_grepindex::GrepIndex>>,
    grep_refresh: Arc<GrepRefresh>,
    queue: Arc<Queue>,
    busy: Arc<AtomicBool>,
}

/// Git-driven grep index refreshes: one thread at a time, a burst of git
/// events coalesced into one more pass, and none at all for a repository the
/// last build found below the size thresholds (it is re-checked on reopen).
#[derive(Default)]
struct GrepRefresh {
    small: AtomicBool,
    running: AtomicBool,
    again: AtomicBool,
}

impl ProjectIndex {
    /// The grep prefilter, only while it is built and trusted (so grep can
    /// skip files); `None` means grep scans every walked file.
    pub fn grep_index(&self) -> Option<Arc<atlas_grepindex::GrepIndex>> {
        self.grep.clone().filter(|g| {
            let st = g.status();
            st.ready && st.trusted
        })
    }

    /// A job is running or queued.
    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst) || !lock(&self.queue.pending).is_empty()
    }

    pub fn enqueue(&self, job: Job) {
        let yields = job != Job::Vectors;
        lock(&self.queue.pending).push(job);
        if yields {
            self.cancel_vectors();
        }
        self.queue.wake.notify_one();
    }

    /// Queue `job`; the receiver resolves when a run covering it finishes.
    pub fn enqueue_and_wait(&self, job: Job) -> oneshot::Receiver<Result<(), String>> {
        let (tx, rx) = oneshot::channel();
        let yields = job != Job::Vectors;
        {
            let mut p = lock(&self.queue.pending);
            p.push(job);
            p.waiters.push(tx);
        }
        if yields {
            self.cancel_vectors();
        }
        self.queue.wake.notify_one();
        rx
    }

    /// Edits come first: stop a running vector sync after its current batch.
    fn cancel_vectors(&self) {
        if let Some(t) = lock(&self.queue.running_vectors).as_ref() {
            t.cancel();
        }
    }
}

impl Drop for ProjectIndex {
    fn drop(&mut self) {
        self.queue.closed.store(true, Ordering::SeqCst);
        self.queue.wake.notify_all();
    }
}

/// Canonical root → open project. Stored by the app as `Arc<CodeIndexRegistry>`.
pub struct CodeIndexRegistry {
    projects: Mutex<HashMap<PathBuf, Arc<ProjectIndex>>>,
    observer: Option<JobObserver>,
    embedder: EmbedderSlot,
}

fn key(root: &Path) -> PathBuf {
    dunce::canonicalize(root).unwrap_or_else(|_| root.to_path_buf())
}

/// Why `root` never gets a code index: it is the filesystem root, or the home
/// folder or a folder above it. An agent launched there would otherwise have
/// every source file the user owns parsed and embedded.
fn refused(root: &Path, home: Option<&Path>) -> Option<&'static str> {
    if root.parent().is_none() {
        Some("the filesystem root")
    } else if home.is_some_and(|h| h.starts_with(root)) {
        Some("the home folder or a folder above it")
    } else {
        None
    }
}

impl CodeIndexRegistry {
    pub fn new(observer: Option<JobObserver>) -> Self {
        Self {
            projects: Mutex::new(HashMap::new()),
            observer,
            embedder: Arc::new(RwLock::new(None)),
        }
    }

    /// Swap the code embedding model (`None`: keyword + symbol search only).
    /// Every open project then syncs its vectors for the new model, from the
    /// embedding cache where it can.
    pub fn set_embedder(&self, embedder: Option<Arc<dyn atlas_codeindex::Embedder>>) {
        let has = embedder.is_some();
        *self
            .embedder
            .write()
            .unwrap_or_else(PoisonError::into_inner) = embedder;
        if has {
            let projects: Vec<Arc<ProjectIndex>> = lock(&self.projects).values().cloned().collect();
            for p in projects {
                p.enqueue(Job::Vectors);
            }
        }
    }

    /// The code embedding model in use, if one is loaded.
    pub fn embedder(&self) -> Option<Arc<dyn atlas_codeindex::Embedder>> {
        self.embedder
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// The project at `root`, if open. Never opens (cheap; callable from
    /// watcher callbacks).
    pub fn get(&self, root: &Path) -> Option<Arc<ProjectIndex>> {
        lock(&self.projects).get(&key(root)).cloned()
    }

    /// The open project with the longest root containing `path`.
    pub fn root_for(&self, path: &Path) -> Option<Arc<ProjectIndex>> {
        let path = key(path);
        lock(&self.projects)
            .iter()
            .filter(|(root, _)| path.starts_with(root))
            .max_by_key(|(root, _)| root.as_os_str().len())
            .map(|(_, p)| p.clone())
    }

    /// Open on first use: open the index, start its worker, and queue a full
    /// build (never built, or another extractor version) or a reconcile
    /// (catch up with edits made while Atlas was closed). Blocking.
    pub fn ensure_open(&self, root: &Path) -> Result<Arc<ProjectIndex>, String> {
        let k = key(root);
        let mut projects = lock(&self.projects);
        if let Some(p) = projects.get(&k) {
            return Ok(p.clone());
        }
        let home = dirs::home_dir().map(|h| key(&h));
        if let Some(why) = refused(&k, home.as_deref()) {
            return Err(format!(
                "not indexing {}: it is {why}. Open a project folder instead.",
                k.display()
            ));
        }
        let index = Arc::new(CodeIndex::open(&k).map_err(|e| e.to_string())?);
        let first = match index.status() {
            Ok(st) if !st.needs_full_build => Job::Reconcile,
            _ => Job::FullBuild,
        };
        let project = Arc::new(ProjectIndex {
            index,
            opened_as: root.to_string_lossy().into_owned(),
            grep: super::grep_index::open_for(&k),
            grep_refresh: Arc::default(),
            queue: Arc::new(Queue {
                pending: Mutex::new(Pending::default()),
                wake: Condvar::new(),
                closed: AtomicBool::new(false),
                running_vectors: Mutex::new(None),
            }),
            busy: Arc::new(AtomicBool::new(false)),
        });
        spawn_worker(&project, self.observer.clone(), self.embedder.clone())?;
        if let Some(g) = project.grep.clone() {
            // Built off the worker: a large build must not delay symbol
            // updates. It waits for the first index job's file reads to pass,
            // but not for a vector sync, which can run for many minutes.
            let queue = project.queue.clone();
            let busy = project.busy.clone();
            let state = project.grep_refresh.clone();
            spawn_grep(g, move |g| {
                let indexing = || {
                    (busy.load(Ordering::SeqCst) && lock(&queue.running_vectors).is_none())
                        || lock(&queue.pending).has_index_work()
                };
                while !queue.closed.load(Ordering::SeqCst) && indexing() {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
                if !queue.closed.load(Ordering::SeqCst) {
                    build_grep(g, &state);
                }
            });
        }
        project.enqueue(first);
        projects.insert(k, project.clone());
        Ok(project)
    }

    /// Changed paths under `root` from a watcher. `root` may be spelled
    /// differently from the canonical key; paths are re-rooted onto it.
    pub fn note_paths(&self, root: &Path, paths: Vec<PathBuf>) {
        let Some(project) = self.get(root) else {
            return;
        };
        let canonical = project.index.root().to_path_buf();
        let rerooted: Vec<PathBuf> = paths
            .into_iter()
            .map(|p| match p.strip_prefix(root) {
                Ok(rel) => canonical.join(rel),
                Err(_) => p,
            })
            .collect();
        if !rerooted.is_empty() {
            project.enqueue(Job::Paths(rerooted));
        }
    }

    /// HEAD, the git index, or a watcher overflow moved: walk and compare.
    pub fn note_rescan(&self, root: &Path) {
        if let Some(project) = self.get(root) {
            project.enqueue(Job::Reconcile);
        }
    }

    /// HEAD, the git index or a ref moved: reconcile the code index, and bring
    /// the grep prefilter to the new HEAD (overlaying the changed paths, or
    /// rebuilding in the background when too many changed).
    pub fn note_git_change(&self, root: &Path) {
        let Some(project) = self.get(root) else {
            return;
        };
        project.enqueue(Job::Reconcile);
        let Some(g) = project.grep.clone() else {
            return;
        };
        let state = project.grep_refresh.clone();
        if state.small.load(Ordering::SeqCst) {
            return;
        }
        state.again.store(true, Ordering::SeqCst);
        if state.running.swap(true, Ordering::SeqCst) {
            return; // the running thread makes one more pass
        }
        let thread_state = state.clone();
        let started = spawn_grep(g, move |g| {
            let state = thread_state;
            loop {
                while state.again.swap(false, Ordering::SeqCst) {
                    match g.refresh_head() {
                        Ok(atlas_grepindex::HeadAction::RebuildNeeded) => build_grep(g, &state),
                        Ok(_) => {}
                        Err(e) => {
                            tracing::warn!(target: "atlas::code_index", "grep index head refresh: {e}");
                        }
                    }
                }
                state.running.store(false, Ordering::SeqCst);
                // An event between the last pass and the line above saw
                // `running` still set: take it unless another thread has.
                if !state.again.load(Ordering::SeqCst) || state.running.swap(true, Ordering::SeqCst)
                {
                    break;
                }
            }
        });
        if !started {
            state.running.store(false, Ordering::SeqCst);
        }
    }

    /// Drop a project; its worker exits after the current job.
    pub fn close(&self, root: &Path) {
        lock(&self.projects).remove(&key(root));
    }
}

/// Run `job` on a thread of its own: grep index work (a build takes seconds
/// on a large repository) must never hold up the code index worker or a
/// watcher callback. `false` when the thread could not start.
pub(super) fn spawn_grep(
    g: Arc<atlas_grepindex::GrepIndex>,
    job: impl FnOnce(&atlas_grepindex::GrepIndex) + Send + 'static,
) -> bool {
    let spawned = std::thread::Builder::new()
        .name("atlas-grep-index".into())
        .spawn(move || job(&g));
    if let Err(e) = &spawned {
        tracing::warn!(target: "atlas::code_index", "start grep index thread: {e}");
    }
    spawned.is_ok()
}

/// Load or build the grep prefilter for HEAD (serialized inside the index).
fn build_grep(g: &atlas_grepindex::GrepIndex, state: &GrepRefresh) {
    match g.ensure_built(&CancelToken::new()) {
        Ok(outcome) => {
            state.small.store(
                outcome == atlas_grepindex::BuildOutcome::BelowThreshold,
                Ordering::SeqCst,
            );
            tracing::info!(
                target: "atlas::code_index",
                "grep index for {}: {outcome:?}",
                g.root().display()
            );
        }
        Err(e) => tracing::warn!(
            target: "atlas::code_index",
            "grep index for {}: {e}",
            g.root().display()
        ),
    }
}

fn spawn_worker(
    project: &Arc<ProjectIndex>,
    observer: Option<JobObserver>,
    embedder: EmbedderSlot,
) -> Result<(), String> {
    let index = project.index.clone();
    let queue = project.queue.clone();
    let busy = project.busy.clone();
    let opened_as = project.opened_as.clone();
    std::thread::Builder::new()
        .name("atlas-code-index".into())
        .spawn(move || {
            while let Some((job, waiters)) = next_job(&queue, &busy) {
                let label = job.label();
                let index_job = job != Job::Vectors;
                let result =
                    catch_unwind(AssertUnwindSafe(|| run(&index, job, &queue, &embedder)))
                        .unwrap_or_else(|_| Err("code index worker panicked".to_string()));
                // Rows changed and a code model is loaded: embed what is new
                // once the queue has no index work left.
                let has_embedder = embedder
                    .read()
                    .unwrap_or_else(PoisonError::into_inner)
                    .is_some();
                if index_job && has_embedder && matches!(result, Ok(true)) {
                    lock(&queue.pending).push(Job::Vectors);
                }
                busy.store(false, Ordering::SeqCst);
                if let Err(e) = &result {
                    tracing::warn!(target: "atlas::code_index", "{label} failed for {opened_as}: {e}");
                }
                for w in waiters {
                    let _ = w.send(result.clone().map(|_| ()));
                }
                if let Some(observe) = &observer {
                    observe(&opened_as, label, &result);
                }
            }
        })
        .map(|_| ())
        .map_err(|e| format!("start code index worker: {e}"))
}

/// Block until there is work (marking the worker busy) or the queue closes.
fn next_job(queue: &Queue, busy: &AtomicBool) -> Option<(Job, Vec<Waiter>)> {
    let mut pending = lock(&queue.pending);
    loop {
        if let Some(next) = pending.take() {
            busy.store(true, Ordering::SeqCst);
            return Some(next);
        }
        if queue.closed.load(Ordering::SeqCst) {
            return None;
        }
        pending = queue
            .wake
            .wait(pending)
            .unwrap_or_else(PoisonError::into_inner);
    }
}

/// `Ok(true)` when rows (or vectors) changed.
fn run(
    index: &CodeIndex,
    job: Job,
    queue: &Queue,
    embedder: &EmbedderSlot,
) -> Result<bool, String> {
    let cancel = CancelToken::new();
    match job {
        Job::FullBuild => index.full_build(&cancel, &|_| {}).map(|_| true),
        Job::Reconcile => index.reconcile(&cancel).map(|s| s.changed()),
        Job::Paths(paths) => index.update_paths(&paths).map(|s| s.changed()),
        Job::Vectors => {
            let Some(e) = embedder
                .read()
                .unwrap_or_else(PoisonError::into_inner)
                .clone()
            else {
                return Ok(false);
            };
            *lock(&queue.running_vectors) = Some(cancel.clone());
            // An index job queued between `take` and the line above found no
            // token to cancel: honour it now.
            if lock(&queue.pending).has_index_work() {
                cancel.cancel();
            }
            let r = index
                .sync_vectors(e.as_ref(), &cancel)
                .map(|s| s.added + s.removed > 0);
            *lock(&queue.running_vectors) = None;
            if cancel.is_cancelled() {
                // Resume after the edit that interrupted it.
                lock(&queue.pending).push(Job::Vectors);
            }
            r
        }
    }
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::time::{Duration, Instant};

    use super::*;

    fn project() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/a.rs"), "pub fn alpha() {}\n").unwrap();
        dir
    }

    #[test]
    fn home_and_filesystem_roots_are_never_indexed() {
        let home = Path::new("/home/u");
        assert!(refused(Path::new("/"), Some(home)).is_some());
        assert!(refused(home, Some(home)).is_some());
        assert!(refused(Path::new("/home"), Some(home)).is_some());
        assert!(refused(Path::new("/home/u/code/app"), Some(home)).is_none());
        assert!(refused(Path::new("/srv/app"), None).is_none());
    }

    fn wait_for(mut cond: impl FnMut() -> bool) {
        let start = Instant::now();
        while !cond() {
            assert!(start.elapsed() < Duration::from_secs(10), "timed out");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn queue_coalesces_and_stays_bounded() {
        let mut p = Pending::default();
        p.push(Job::Paths(vec!["a".into(), "b".into()]));
        p.push(Job::Paths(vec!["b".into(), "c".into()]));
        assert_eq!(
            p.take().map(|(j, _)| j),
            Some(Job::Paths(vec!["a".into(), "b".into(), "c".into()]))
        );
        assert!(p.take().is_none());
        p.push(Job::Paths(vec!["a".into()]));
        p.push(Job::Reconcile);
        p.push(Job::Paths(vec!["late".into()]));
        assert_eq!(p.take().map(|(j, _)| j), Some(Job::Reconcile));
        p.push(Job::Reconcile);
        p.push(Job::FullBuild);
        p.push(Job::Reconcile);
        assert_eq!(p.take().map(|(j, _)| j), Some(Job::FullBuild));
        let many: Vec<PathBuf> = (0..=MAX_PENDING_PATHS)
            .map(|i| PathBuf::from(format!("f{i}")))
            .collect();
        p.push(Job::Paths(many));
        assert_eq!(p.take().map(|(j, _)| j), Some(Job::Reconcile));
    }

    #[test]
    fn first_open_builds_and_waiters_resolve() {
        let dir = project();
        let reg = CodeIndexRegistry::new(None);
        let project = reg.ensure_open(dir.path()).unwrap();
        project
            .enqueue_and_wait(Job::Reconcile)
            .blocking_recv()
            .unwrap()
            .unwrap();
        assert_eq!(project.index.status().unwrap().files, 1);
        assert!(
            Arc::ptr_eq(&project, &reg.ensure_open(dir.path()).unwrap()),
            "opened once"
        );
    }

    #[test]
    fn noted_paths_reach_the_index() {
        let dir = project();
        let reg = CodeIndexRegistry::new(None);
        let project = reg.ensure_open(dir.path()).unwrap();
        project
            .enqueue_and_wait(Job::Reconcile)
            .blocking_recv()
            .unwrap()
            .unwrap();
        let g = project.index.generation();
        std::fs::write(dir.path().join("src/b.rs"), "pub fn beta() {}\n").unwrap();
        reg.note_paths(dir.path(), vec![dir.path().join("src/b.rs")]);
        wait_for(|| project.index.generation() > g && !project.is_busy());
        assert_eq!(project.index.status().unwrap().files, 2);
    }

    #[test]
    fn unopened_roots_are_ignored() {
        let dir = project();
        let reg = CodeIndexRegistry::new(None);
        reg.note_paths(dir.path(), vec![dir.path().join("src/a.rs")]);
        reg.note_rescan(dir.path());
        assert!(reg.get(dir.path()).is_none());
        assert!(!dir.path().join(".atlas").exists());
    }

    #[test]
    fn root_for_prefers_the_deepest_open_root() {
        let dir = project();
        std::fs::create_dir_all(dir.path().join("sub/deeper")).unwrap();
        let reg = CodeIndexRegistry::new(None);
        let outer = reg.ensure_open(dir.path()).unwrap();
        let inner = reg.ensure_open(&dir.path().join("sub")).unwrap();
        assert!(Arc::ptr_eq(
            &reg.root_for(&dir.path().join("sub/deeper")).unwrap(),
            &inner
        ));
        assert!(Arc::ptr_eq(
            &reg.root_for(&dir.path().join("src")).unwrap(),
            &outer
        ));
        assert!(reg.root_for(Path::new("/elsewhere")).is_none());
    }

    #[test]
    fn observer_sees_every_job() {
        let dir = project();
        let seen = Arc::new(AtomicUsize::new(0));
        let counter = seen.clone();
        let reg = CodeIndexRegistry::new(Some(Arc::new(move |_, _, r| {
            assert!(r.is_ok());
            counter.fetch_add(1, Ordering::SeqCst);
        })));
        let project = reg.ensure_open(dir.path()).unwrap();
        project
            .enqueue_and_wait(Job::Reconcile)
            .blocking_recv()
            .unwrap()
            .unwrap();
        project
            .enqueue_and_wait(Job::Paths(Vec::new()))
            .blocking_recv()
            .unwrap()
            .unwrap();
        wait_for(|| seen.load(Ordering::SeqCst) >= 2);
    }

    struct Slow;
    impl atlas_codeindex::Embedder for Slow {
        fn model_id(&self) -> &str {
            "slow"
        }
        fn dims(&self) -> usize {
            4
        }
        fn embed_documents(&self, t: &[&str]) -> Result<Vec<Vec<f32>>, String> {
            std::thread::sleep(Duration::from_millis(500));
            Ok(t.iter().map(|_| vec![0.5; 4]).collect())
        }
        fn embed_query(&self, _: &str) -> Result<Vec<f32>, String> {
            Ok(vec![0.5; 4])
        }
    }

    #[test]
    fn vectors_follow_index_changes_when_an_embedder_is_set() {
        let dir = project();
        let reg = CodeIndexRegistry::new(None);
        reg.set_embedder(Some(Arc::new(Slow)));
        let p = reg.ensure_open(dir.path()).unwrap();
        p.enqueue_and_wait(Job::Reconcile)
            .blocking_recv()
            .unwrap()
            .unwrap();
        wait_for(|| {
            dir.path()
                .join(".atlas/code-index/chunks.slow.usearch")
                .is_file()
        });
    }

    #[test]
    fn a_new_job_cancels_vector_sync() {
        let dir = project();
        // 400 chunks = 13 batches of 500 ms: about 6.5 s of embedding, so an edit
        // only returns quickly if the running sync is really cancelled.
        for i in 0..400 {
            std::fs::write(
                dir.path().join(format!("src/f{i}.rs")),
                format!("pub fn f{i}() {{}}\n"),
            )
            .unwrap();
        }
        let reg = CodeIndexRegistry::new(None);
        reg.set_embedder(Some(Arc::new(Slow)));
        let p = reg.ensure_open(dir.path()).unwrap();
        p.enqueue_and_wait(Job::Reconcile)
            .blocking_recv()
            .unwrap()
            .unwrap();
        std::thread::sleep(Duration::from_millis(300)); // the vector job has started
        let t = Instant::now();
        p.enqueue_and_wait(Job::Paths(vec![dir.path().join("src/a.rs")]))
            .blocking_recv()
            .unwrap()
            .unwrap();
        // At most the batch in flight (500 ms) plus the edit itself.
        assert!(
            t.elapsed() < Duration::from_millis(1500),
            "edit waited {:?} behind embedding",
            t.elapsed()
        );
    }

    #[test]
    fn a_queued_vector_sync_waits_behind_index_work_and_survives_it() {
        let mut p = Pending::default();
        p.push(Job::Vectors);
        p.push(Job::Paths(vec!["a".into()]));
        assert_eq!(p.take().map(|(j, _)| j), Some(Job::Paths(vec!["a".into()])));
        assert_eq!(p.take().map(|(j, _)| j), Some(Job::Vectors));
        assert!(p.take().is_none());
    }
}
