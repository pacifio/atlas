//! Who owns each project's code index: one [`CodeIndex`] and one worker
//! thread per open project root, fed by a coalescing job queue.
//!
//! The queue is bounded by construction: it holds at most one full build,
//! one reconcile, and a set of paths. A full build absorbs everything queued
//! behind it, a reconcile absorbs queued paths, and more than
//! [`MAX_PENDING_PATHS`] paths (a branch switch, `npm install` leaking past
//! the filters) collapse into one reconcile. Tauri-free so it is testable;
//! `mod.rs` wires it to the app.

use std::collections::{BTreeSet, HashMap};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};

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
}

impl Job {
    pub fn label(&self) -> &'static str {
        match self {
            Self::FullBuild => "full_build",
            Self::Paths(_) => "paths",
            Self::Reconcile => "reconcile",
        }
    }
}

/// Told about every finished job: the project path as first opened, the job,
/// and whether rows changed (or the error).
pub type JobObserver = Arc<dyn Fn(&str, &'static str, &Result<bool, String>) + Send + Sync>;

type Waiter = oneshot::Sender<Result<(), String>>;

#[derive(Default)]
struct Pending {
    full: bool,
    reconcile: bool,
    paths: BTreeSet<PathBuf>,
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
        }
    }

    fn is_empty(&self) -> bool {
        !self.full && !self.reconcile && self.paths.is_empty() && self.waiters.is_empty()
    }

    /// The one job that covers everything queued, with everyone waiting on it.
    fn take(&mut self) -> Option<(Job, Vec<Waiter>)> {
        if self.is_empty() {
            return None;
        }
        let taken = std::mem::take(self);
        let job = if taken.full {
            Job::FullBuild
        } else if taken.reconcile {
            Job::Reconcile
        } else {
            Job::Paths(taken.paths.into_iter().collect())
        };
        Some((job, taken.waiters))
    }
}

struct Queue {
    pending: Mutex<Pending>,
    wake: Condvar,
    closed: AtomicBool,
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
    queue: Arc<Queue>,
    busy: Arc<AtomicBool>,
}

impl ProjectIndex {
    /// A job is running or queued.
    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst) || !lock(&self.queue.pending).is_empty()
    }

    pub fn enqueue(&self, job: Job) {
        lock(&self.queue.pending).push(job);
        self.queue.wake.notify_one();
    }

    /// Queue `job`; the receiver resolves when a run covering it finishes.
    pub fn enqueue_and_wait(&self, job: Job) -> oneshot::Receiver<Result<(), String>> {
        let (tx, rx) = oneshot::channel();
        {
            let mut p = lock(&self.queue.pending);
            p.push(job);
            p.waiters.push(tx);
        }
        self.queue.wake.notify_one();
        rx
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
}

fn key(root: &Path) -> PathBuf {
    dunce::canonicalize(root).unwrap_or_else(|_| root.to_path_buf())
}

impl CodeIndexRegistry {
    pub fn new(observer: Option<JobObserver>) -> Self {
        Self {
            projects: Mutex::new(HashMap::new()),
            observer,
        }
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
        let index = Arc::new(CodeIndex::open(&k).map_err(|e| e.to_string())?);
        let first = match index.status() {
            Ok(st) if !st.needs_full_build => Job::Reconcile,
            _ => Job::FullBuild,
        };
        let project = Arc::new(ProjectIndex {
            index,
            opened_as: root.to_string_lossy().into_owned(),
            queue: Arc::new(Queue {
                pending: Mutex::new(Pending::default()),
                wake: Condvar::new(),
                closed: AtomicBool::new(false),
            }),
            busy: Arc::new(AtomicBool::new(false)),
        });
        spawn_worker(&project, self.observer.clone())?;
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

    /// Drop a project; its worker exits after the current job.
    pub fn close(&self, root: &Path) {
        lock(&self.projects).remove(&key(root));
    }
}

fn spawn_worker(project: &Arc<ProjectIndex>, observer: Option<JobObserver>) -> Result<(), String> {
    let index = project.index.clone();
    let queue = project.queue.clone();
    let busy = project.busy.clone();
    let opened_as = project.opened_as.clone();
    std::thread::Builder::new()
        .name("atlas-code-index".into())
        .spawn(move || {
            while let Some((job, waiters)) = next_job(&queue, &busy) {
                let label = job.label();
                let result = catch_unwind(AssertUnwindSafe(|| run(&index, job)))
                    .unwrap_or_else(|_| Err("code index worker panicked".to_string()));
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

/// `Ok(true)` when rows changed.
fn run(index: &CodeIndex, job: Job) -> Result<bool, String> {
    let cancel = CancelToken::new();
    match job {
        Job::FullBuild => index.full_build(&cancel, &|_| {}).map(|_| true),
        Job::Reconcile => index.reconcile(&cancel).map(|s| s.changed()),
        Job::Paths(paths) => index.update_paths(&paths).map(|s| s.changed()),
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
}
