//! Background security scans of new Checkpoints (ATL-985), in shadow mode.
//!
//! When capture links new Checkpoints (the commit walk, or a commit an agent
//! made from its own shell), it nudges this worker with the Project's root.
//! On its own thread the worker scans each Checkpoint's commit with the local
//! layers of `atlas-security` and stores the result beside the Checkpoint.
//! Nothing is shown to the user yet: results are read with the harness's
//! `security-eval export`. Gated by `securityScan` in `config.toml`: an
//! explicit value wins; absent, it is on in development builds and off in
//! released ones.
//!
//! The capture path never waits on this. A nudge is a channel send; the scan
//! runs with the store unlocked and only re-locks to write its row. History
//! is never scanned: the first pass starts a few minutes back, which takes in
//! the commit that woke it and nothing older.

use std::path::{Path, PathBuf};
use std::process::Command;

use atlas_process::NoWindow;
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use atlas_checkpoint::model::ScanRow;
use atlas_checkpoint::Store;
use atlas_security::deps::lockfiles::{ecosystem_of, Ecosystem};
use atlas_security::deps::osv::{refresh, AdvisoryDb};
use atlas_security::map::Limits;
use atlas_security::provenance::from_store;
use atlas_security::repo::{GitCli, Repo};
use atlas_security::scan::{scan_checkpoint, ScanInput, ScanResult, SCANNER_VERSION};
use atlas_security::view::{
    checkpoint_view, session_summary, ship_overview, CheckpointSecurity, SessionSecurity,
    ShipOverview, ShipScan,
};
use chrono::{DateTime, Utc};

use super::capture::{registered_roots, registered_store, writer_in, StoreRegistry};

/// Checkpoints scanned per pass; the rest wait for the next nudge or tick.
const BATCH: i64 = 20;
/// Each scan gives up on its remaining files after this long.
const SCAN_BUDGET: Duration = Duration::from_secs(30);
/// Without a nudge, every open Project's backlog is checked this often.
const TICK: Duration = Duration::from_secs(10 * 60);
/// How old the advisory index may get before a refresh.
const ADVISORY_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
/// After a failed refresh, try again this soon rather than a day later.
const ADVISORY_RETRY: Duration = Duration::from_secs(60 * 60);
/// A stalled download must not hold the only scan thread forever.
const ADVISORY_CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const ADVISORY_READ_TIMEOUT: Duration = Duration::from_secs(60);

static WORKER: OnceLock<mpsc::Sender<PathBuf>> = OnceLock::new();

/// Start the scan thread. Called once, beside the capture threads.
pub(crate) fn start(stores: StoreRegistry) {
    let (tx, rx) = mpsc::channel::<PathBuf>();
    if WORKER.set(tx).is_err() {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("atlas-security-scan".into())
        .spawn(move || worker(rx, stores));
    if let Err(e) = spawned {
        tracing::warn!(target: "atlas::security", "scan worker did not start: {e}");
    }
}

/// Ask for this Project's new Checkpoints to be scanned. Never blocks.
pub(crate) fn nudge(project_root: &Path) {
    if let Some(tx) = WORKER.get() {
        let _ = tx.send(project_root.to_path_buf());
    }
}

fn worker(rx: mpsc::Receiver<PathBuf>, stores: StoreRegistry) {
    let mut next_refresh: Option<Instant> = None;
    loop {
        let roots = match rx.recv_timeout(TICK) {
            Ok(root) => vec![root],
            Err(mpsc::RecvTimeoutError::Timeout) => registered_roots(&stores),
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        };
        if !scan_enabled(configured_setting(), atlas_profile::is_dev()) {
            continue;
        }
        let Some(data_dir) = data_dir() else {
            continue;
        };
        if next_refresh.is_none_or(|t| Instant::now() >= t) {
            let failed = refresh_advisories(&data_dir);
            next_refresh = Some(Instant::now() + next_refresh_in(failed));
        }
        for root in roots {
            let Some((store, is_writer)) = registered_store(&stores, &root) else {
                continue;
            };
            if !is_writer {
                continue;
            }
            // One Project's failure must not stop the thread for the rest.
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                scan_project_once(&store, &root, &data_dir, true)
            }));
            match result {
                Ok(once) if once.scanned > 0 => {
                    tracing::info!(
                        target: "atlas::security",
                        scanned = once.scanned,
                        findings = once.findings,
                        blocking = once.blocking,
                        "scanned checkpoints"
                    );
                    announce(&root);
                }
                Ok(_) => {}
                Err(_) => tracing::warn!(target: "atlas::security", "a scan pass panicked"),
            }
        }
    }
}

/// On when `securityScan` says so. With the key absent it is on in
/// development builds (`bun run dev:app`) and off in released ones, so the
/// team collects shadow data without every user paying for it.
fn scan_enabled(explicit: Option<bool>, dev_build: bool) -> bool {
    explicit.unwrap_or(dev_build)
}

/// `securityScan` as written in this profile's `config.toml`, if it is.
fn configured_setting() -> Option<bool> {
    let path = crate::state::atlas_config::ConfigManager::config_path()?;
    explicit_setting(&std::fs::read_to_string(path).ok()?)
}

/// `[settings] securityScan` in a config file's text; `None` when the key
/// is absent or the file does not parse.
fn explicit_setting(raw: &str) -> Option<bool> {
    let doc: toml::Table = toml::from_str(raw).ok()?;
    doc.get("settings")?.get("securityScan")?.as_bool()
}

fn next_refresh_in(failed: bool) -> Duration {
    if failed {
        ADVISORY_RETRY
    } else {
        ADVISORY_MAX_AGE
    }
}

fn advisory_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(ADVISORY_CONNECT_TIMEOUT)
        .read_timeout(ADVISORY_READ_TIMEOUT)
        .build()
        .unwrap_or_default()
}

/// Where the advisory index lives: the OS cache folder, per profile.
fn data_dir() -> Option<PathBuf> {
    Some(
        dirs::cache_dir()?
            .join(atlas_profile::current().identifier())
            .join("security"),
    )
}

/// Refresh the advisory index; `true` when any ecosystem failed.
fn refresh_advisories(data_dir: &Path) -> bool {
    let client = advisory_client();
    let outcome =
        tauri::async_runtime::block_on(refresh(&data_dir.join("osv"), &client, ADVISORY_MAX_AGE));
    if !outcome.failed.is_empty() {
        tracing::warn!(
            target: "atlas::security",
            failed = outcome.failed.len(),
            refreshed = outcome.refreshed.len(),
            "advisory refresh incomplete"
        );
    }
    !outcome.failed.is_empty()
}

/// Where scanning starts in a Project scanned for the first time: a few
/// minutes back, so the commit whose checkpoint woke the scanner is
/// included, while the Project's history is not.
fn initial_since(now: DateTime<Utc>) -> DateTime<Utc> {
    now - chrono::Duration::minutes(5)
}

/// What one pass over a Project did.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct ScanOnce {
    /// This pass recorded `since`: the Project's first pass.
    pub started: bool,
    pub scanned: usize,
    pub findings: usize,
    pub blocking: usize,
}

/// Scan this Project's unscanned Checkpoints once. The store is locked only
/// to read a Checkpoint's inputs and to write its row, never while scanning.
pub(crate) fn scan_project_once(
    store: &Mutex<Store>,
    root: &Path,
    data_dir: &Path,
    enabled: bool,
) -> ScanOnce {
    let mut once = ScanOnce::default();
    if !enabled {
        return once;
    }
    // Reads go through their own connection, so capture's writer lock is
    // only taken to write a row (as `StoreRegistry`'s doc asks of readers).
    let atlas_dir = lock(store).root().to_path_buf();
    let Ok(reader) = Store::open_reader(&atlas_dir) else {
        return once;
    };
    let since = match reader.scan_state("since") {
        Ok(Some(raw)) => match DateTime::parse_from_rfc3339(&raw) {
            Ok(t) => t.with_timezone(&Utc),
            Err(_) => return once,
        },
        Ok(None) => {
            let since = initial_since(Utc::now());
            if lock(store)
                .set_scan_state("since", &since.to_rfc3339())
                .is_err()
            {
                return once;
            }
            once.started = true;
            since
        }
        Err(_) => return once,
    };
    let backlog = match reader.scan_backlog(SCANNER_VERSION, since, BATCH) {
        Ok(b) => b,
        Err(_) => return once,
    };
    let repo = GitCli {
        root: root.to_path_buf(),
    };
    for checkpoint in backlog {
        let provenance = from_store(&reader, &checkpoint.session_id).unwrap_or_default();
        // Loaded only for the ecosystems this commit's lockfiles use, and
        // dropped as soon as the scan is written.
        let ecosystems = lockfile_ecosystems(root, &checkpoint.commit_sha);
        let advisories = if ecosystems.is_empty() {
            None
        } else {
            AdvisoryDb::open_only(&data_dir.join("osv"), &ecosystems).ok()
        };
        let db = advisories.as_ref();
        let result = scan_checkpoint(ScanInput {
            sha: &checkpoint.commit_sha,
            repo: &repo,
            provenance: &provenance,
            advisories: db,
            limits: Limits::default(),
            deadline: Instant::now() + SCAN_BUDGET,
        });
        let row = ScanRow {
            checkpoint_id: checkpoint.id.clone(),
            scanner_version: SCANNER_VERSION.to_string(),
            status: result.status.as_str().to_string(),
            level: result.level.as_str().to_string(),
            blocking: result.blocking,
            result_json: serde_json::to_string(&result).unwrap_or_else(|_| "{}".to_string()),
            attempts: 1,
            created_at: Utc::now(),
        };
        if lock(store).put_scan(&row).is_ok() {
            once.scanned += 1;
            once.findings += result.findings.len();
            once.blocking += usize::from(result.blocking);
        }
    }
    once
}

/// The ecosystems whose lockfiles the commit changes, so only their advisory
/// indexes are loaded. A git failure loads all of them: the scan itself will
/// report what it could not read.
fn lockfile_ecosystems(root: &Path, sha: &str) -> Vec<Ecosystem> {
    let out = Command::new("git")
        .no_window()
        .arg("-C")
        .arg(root)
        .args(["-c", "core.quotepath=off"])
        .args([
            "diff-tree",
            "--no-commit-id",
            "--name-only",
            "-r",
            "--root",
            sha,
        ])
        .output();
    let mut ecos = Vec::new();
    match out {
        Ok(o) if o.status.success() => {
            for eco in String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter_map(ecosystem_of)
            {
                if !ecos.contains(&eco) {
                    ecos.push(eco);
                }
            }
        }
        _ => ecos.extend(Ecosystem::ALL),
    }
    ecos
}

fn lock(store: &Mutex<Store>) -> std::sync::MutexGuard<'_, Store> {
    store
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

// ── What the UI reads ───────────────────────────────────────────────────────

/// The channel the worker announces a stored scan on, with `{ projectPath }`.
pub(crate) const SCAN_CHANGED_EVENT: &str = "atlas:security-scan-changed";

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Give the worker the handle it announces new scans through.
pub(crate) fn attach(app: tauri::AppHandle) {
    let _ = APP.set(app);
}

fn announce(root: &Path) {
    use tauri::Emitter as _;
    if let Some(app) = APP.get() {
        let _ = app.emit(
            SCAN_CHANGED_EVENT,
            serde_json::json!({ "projectPath": root.to_string_lossy() }),
        );
    }
}

fn parse_result(json: &str) -> Option<ScanResult> {
    serde_json::from_str(json).ok()
}

/// Every scanned session in the Project, with its badge.
pub(crate) fn project_sessions_in(store: &Store) -> Result<Vec<SessionSecurity>, String> {
    let not_useful = store.not_useful_fingerprints().map_err(|e| e.to_string())?;
    let mut by_session: Vec<(String, Vec<CheckpointSecurity>)> = Vec::new();
    for (checkpoint, row) in store.scans(SCANNER_VERSION).map_err(|e| e.to_string())? {
        let Some(result) = parse_result(&row.result_json) else {
            continue;
        };
        let view = checkpoint_view(
            &checkpoint.id,
            &checkpoint.commit_sha,
            row.created_at,
            &result,
            &not_useful,
        );
        match by_session
            .iter_mut()
            .find(|(s, _)| *s == checkpoint.session_id)
        {
            Some((_, views)) => views.push(view),
            None => by_session.push((checkpoint.session_id.clone(), vec![view])),
        }
    }
    Ok(by_session
        .iter()
        .filter_map(|(session, views)| session_summary(session, views))
        .collect())
}

/// A session's scanned checkpoints, for the Checkpoint cards.
pub(crate) fn session_checkpoints_in(
    store: &Store,
    session_id: &str,
) -> Result<Vec<CheckpointSecurity>, String> {
    let not_useful = store.not_useful_fingerprints().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for checkpoint in store
        .checkpoints_for_session(session_id)
        .map_err(|e| e.to_string())?
    {
        let Some(row) = store
            .scan_for(&checkpoint.id, SCANNER_VERSION)
            .map_err(|e| e.to_string())?
        else {
            continue;
        };
        if let Some(result) = parse_result(&row.result_json) {
            out.push(checkpoint_view(
                &checkpoint.id,
                &checkpoint.commit_sha,
                row.created_at,
                &result,
                &not_useful,
            ));
        }
    }
    Ok(out)
}

/// The branch's scanned checkpoints rolled up against its head; `None` when
/// none of the branch's checkpoints has a scan.
pub(crate) fn ship_overview_in(
    store: &Store,
    root: &Path,
    branch: &str,
) -> Result<Option<ShipOverview>, String> {
    let not_useful = store.not_useful_fingerprints().map_err(|e| e.to_string())?;
    let scans: Vec<ShipScan> = store
        .scans(SCANNER_VERSION)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|(c, _)| c.branch.as_deref() == Some(branch))
        .filter_map(|(c, row)| {
            parse_result(&row.result_json).map(|result| ShipScan {
                commit_sha: c.commit_sha,
                result,
            })
        })
        .collect();
    if scans.is_empty() {
        return Ok(None);
    }
    let repo = GitCli {
        root: root.to_path_buf(),
    };
    let head_file = |path: &str| -> Option<String> {
        repo.file_at(branch, path)
            .ok()
            .flatten()
            .map(|b| String::from_utf8_lossy(&b).into_owned())
    };
    Ok(Some(ship_overview(branch, &scans, &head_file, &not_useful)))
}

/// One line of a file at a commit, redacted, for "Show line".
pub(crate) fn finding_line_in(root: &Path, sha: &str, path: &str, line: u32) -> Option<String> {
    let repo = GitCli {
        root: root.to_path_buf(),
    };
    let bytes = repo.file_at(sha, path).ok()??;
    let text = String::from_utf8_lossy(&bytes);
    let raw = text.lines().nth(line.checked_sub(1)? as usize)?;
    Some(atlas_redact::redact(raw).text)
}

pub(crate) fn set_not_useful_in(
    store: &Mutex<Store>,
    fingerprint: &str,
    rule_id: &str,
    not_useful: bool,
) -> Result<(), String> {
    lock(store)
        .set_not_useful(fingerprint, rule_id, SCANNER_VERSION, not_useful)
        .map_err(|e| e.to_string())
}

/// The Project's store for reading, or `None` when it has never recorded.
fn project_reader(project_path: &str) -> Option<Store> {
    let dir = atlas_profile::dir_in(project_path);
    dir.join("sessions.db")
        .exists()
        .then(|| Store::open_reader(&dir).ok())
        .flatten()
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn security_project_sessions(
    project_path: String,
) -> Result<Vec<SessionSecurity>, String> {
    blocking(move || match project_reader(&project_path) {
        Some(store) => project_sessions_in(&store),
        None => Ok(Vec::new()),
    })
    .await
}

#[tauri::command]
pub async fn security_session_checkpoints(
    project_path: String,
    session_id: String,
) -> Result<Vec<CheckpointSecurity>, String> {
    blocking(move || match project_reader(&project_path) {
        Some(store) => session_checkpoints_in(&store, &session_id),
        None => Ok(Vec::new()),
    })
    .await
}

#[tauri::command]
pub async fn security_ship_overview(
    project_path: String,
    branch: String,
) -> Result<Option<ShipOverview>, String> {
    blocking(move || match project_reader(&project_path) {
        Some(store) => ship_overview_in(&store, Path::new(&project_path), &branch),
        None => Ok(None),
    })
    .await
}

#[tauri::command]
pub async fn security_finding_line(
    project_path: String,
    sha: String,
    path: String,
    line: u32,
) -> Result<Option<String>, String> {
    blocking(move || Ok(finding_line_in(Path::new(&project_path), &sha, &path, line))).await
}

#[tauri::command]
pub async fn security_set_not_useful(
    state: tauri::State<'_, super::capture::CaptureState>,
    project_path: String,
    fingerprint: String,
    rule_id: String,
    not_useful: bool,
) -> Result<(), String> {
    let stores = state.registry();
    blocking(move || {
        let root = Path::new(&project_path);
        let store = writer_in(&stores, root)?;
        set_not_useful_in(&store, &fingerprint, &rule_id, not_useful)?;
        // The roll-up and open sessions re-read, as after a scan.
        announce(root);
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::process::Command;
    use std::sync::Mutex;

    use atlas_checkpoint::model::ProjectMode;
    use atlas_checkpoint::{CheckpointInput, Source, Store};
    use atlas_security::finding::Level;

    use super::*;

    fn git(root: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .no_window()
            .arg("-C")
            .arg(root)
            .args(["-c", "user.name=Test", "-c", "user.email=test@example.com"])
            .args([
                "-c",
                "commit.gpgsign=false",
                "-c",
                "init.defaultBranch=main",
            ])
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .output()
            .expect("git runs");
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    }

    struct Project {
        dir: tempfile::TempDir,
        data: tempfile::TempDir,
        store: Mutex<Store>,
        session_id: String,
    }

    fn project() -> Project {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q"]);
        std::fs::write(dir.path().join("README"), "hello\n").unwrap();
        git(dir.path(), &["add", "README"]);
        git(dir.path(), &["commit", "-q", "-m", "init"]);
        let store = Store::open(dir.path().join(".atlas")).unwrap();
        let session_id = store
            .upsert_session(
                "ws",
                Source::Native,
                "native-1",
                None,
                None,
                Some("main"),
                None,
                ProjectMode::Local,
            )
            .unwrap();
        Project {
            dir,
            data: tempfile::tempdir().unwrap(),
            store: Mutex::new(store),
            session_id,
        }
    }

    /// Commit `content` as `path` and record a Checkpoint for it.
    fn commit_checkpoint(p: &Project, path: &str, content: &str) -> String {
        std::fs::write(p.dir.path().join(path), content).unwrap();
        git(p.dir.path(), &["add", path]);
        git(p.dir.path(), &["commit", "-q", "-m", "change"]);
        let sha = git(p.dir.path(), &["rev-parse", "HEAD"]);
        p.store
            .lock()
            .unwrap()
            .upsert_checkpoint(CheckpointInput {
                session_id: &p.session_id,
                commit_sha: &sha,
                patch_id: Some(&sha),
                branch: Some("main"),
                git_author_name: None,
                git_author_email: None,
                files_touched: &[path.to_string()],
                insertions: 1,
                deletions: 0,
                sync_state: ProjectMode::Local.initial_sync_state(),
            })
            .unwrap()
    }

    #[test]
    fn an_explicit_setting_wins_and_dev_builds_default_on() {
        assert!(scan_enabled(None, true), "dev build, key absent: on");
        assert!(!scan_enabled(None, false), "release build, key absent: off");
        assert!(
            !scan_enabled(Some(false), true),
            "dev can still turn it off"
        );
        assert!(scan_enabled(Some(true), false), "release can turn it on");
        assert_eq!(
            explicit_setting("[settings]\nsecurityScan = false\n"),
            Some(false)
        );
        assert_eq!(
            explicit_setting("schemaVersion = 1\n[settings]\nsecurityScan = true\n"),
            Some(true)
        );
        assert_eq!(
            explicit_setting("[settings]\nshareTelemetry = true\n"),
            None
        );
        assert_eq!(explicit_setting("not = [valid"), None);
    }

    #[test]
    fn a_failed_refresh_is_retried_within_the_hour() {
        assert_eq!(next_refresh_in(false), ADVISORY_MAX_AGE);
        assert!(next_refresh_in(true) <= Duration::from_secs(60 * 60));
    }

    #[test]
    fn the_advisory_client_has_timeouts() {
        // Building it must succeed; the timeouts themselves are reqwest's.
        let _ = advisory_client();
        assert!(ADVISORY_CONNECT_TIMEOUT <= Duration::from_secs(30));
        assert!(ADVISORY_READ_TIMEOUT <= Duration::from_secs(120));
    }

    fn scanned_project() -> (Project, String) {
        let p = project();
        let id = commit_checkpoint(
            &p,
            "pay.ts",
            "const k = \"sk_live_51NzQ8vKj2mXyR4tPq9WbE7cL0dF3gH6\";\n",
        );
        assert_eq!(
            scan_project_once(&p.store, p.dir.path(), p.data.path(), true).scanned,
            1
        );
        (p, id)
    }

    fn reader_of(p: &Project) -> Store {
        Store::open_reader(p.dir.path().join(".atlas")).unwrap()
    }

    #[test]
    fn project_sessions_give_each_scanned_session_its_badge() {
        let (p, _) = scanned_project();
        let sessions = project_sessions_in(&reader_of(&p)).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, p.session_id);
        assert_eq!(sessions[0].level, Level::Critical);
        assert!(sessions[0].blocking);
    }

    #[test]
    fn session_checkpoints_list_findings_by_commit() {
        let (p, id) = scanned_project();
        let views = session_checkpoints_in(&reader_of(&p), &p.session_id).unwrap();
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].checkpoint_id, id);
        assert_eq!(views[0].findings[0].path, "pay.ts");
        assert_eq!(views[0].findings[0].line, 1);
    }

    #[test]
    fn marking_not_useful_drops_the_badge_and_can_be_undone() {
        let (p, _) = scanned_project();
        let fp = session_checkpoints_in(&reader_of(&p), &p.session_id).unwrap()[0].findings[0]
            .fingerprint
            .clone();
        set_not_useful_in(&p.store, &fp, "secret.vendor.stripe-access-token", true).unwrap();
        let sessions = project_sessions_in(&reader_of(&p)).unwrap();
        assert_eq!(sessions[0].level, Level::None);
        assert_eq!(sessions[0].findings, 0);
        set_not_useful_in(&p.store, &fp, "secret.vendor.stripe-access-token", false).unwrap();
        assert_eq!(
            project_sessions_in(&reader_of(&p)).unwrap()[0].level,
            Level::Critical
        );
    }

    #[test]
    fn before_you_ship_reads_the_branch_at_its_head() {
        let (p, _) = scanned_project();
        let o = ship_overview_in(&reader_of(&p), p.dir.path(), "main")
            .unwrap()
            .expect("scanned");
        assert_eq!(o.open.len(), 1);
        assert!(o.blocking);
        // Remove the key on the branch: the finding moves to fixed.
        std::fs::write(p.dir.path().join("pay.ts"), "const k = process.env.KEY;\n").unwrap();
        git(p.dir.path(), &["commit", "-q", "-am", "remove key"]);
        let o = ship_overview_in(&reader_of(&p), p.dir.path(), "main")
            .unwrap()
            .unwrap();
        assert!(o.open.is_empty(), "{:?}", o.open);
        assert_eq!(o.fixed.len(), 1);
        assert!(!o.blocking);
        assert!(
            ship_overview_in(&reader_of(&p), p.dir.path(), "no-such-branch")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn a_finding_line_is_read_from_the_commit_and_redacted() {
        let (p, _) = scanned_project();
        let views = session_checkpoints_in(&reader_of(&p), &p.session_id).unwrap();
        let f = &views[0].findings[0];
        let line = finding_line_in(p.dir.path(), &f.sha, &f.path, f.line).unwrap();
        assert!(line.contains("const k ="), "{line}");
        assert!(
            !line.contains("sk_live_51Nz"),
            "the key is never returned: {line}"
        );
        assert_eq!(finding_line_in(p.dir.path(), &f.sha, &f.path, 999), None);
    }

    #[test]
    fn the_first_pass_scans_the_commit_that_woke_it() {
        // The nudge comes right after the commit is linked, so the pass that
        // records `since` must still count that checkpoint as new.
        let p = project();
        commit_checkpoint(&p, "new.ts", "const a = 1;\n");
        let once = scan_project_once(&p.store, p.dir.path(), p.data.path(), true);
        assert!(once.started);
        assert_eq!(once.scanned, 1);
        assert!(p
            .store
            .lock()
            .unwrap()
            .scan_state("since")
            .unwrap()
            .is_some());
    }

    #[test]
    fn scanning_starts_a_few_minutes_back_not_at_the_beginning() {
        let now = Utc::now();
        assert_eq!(initial_since(now), now - chrono::Duration::minutes(5));
    }

    #[test]
    fn nudge_scans_new_checkpoint_and_writes_row() {
        let p = project();
        scan_project_once(&p.store, p.dir.path(), p.data.path(), true);
        std::thread::sleep(std::time::Duration::from_millis(10));
        let id = commit_checkpoint(
            &p,
            "pay.ts",
            "const k = \"sk_live_51NzQ8vKj2mXyR4tPq9WbE7cL0dF3gH6\";\n",
        );
        let once = scan_project_once(&p.store, p.dir.path(), p.data.path(), true);
        assert_eq!(once.scanned, 1);
        assert_eq!(once.blocking, 1);
        let row = p
            .store
            .lock()
            .unwrap()
            .scan_for(&id, atlas_security::scan::SCANNER_VERSION)
            .unwrap()
            .expect("scan row written");
        assert_eq!(row.status, "done");
        assert_eq!(row.level, "critical");
        assert!(row.blocking);
        assert!(!row.result_json.contains("sk_live"), "no raw secret stored");
        // A second pass has nothing left to do.
        let again = scan_project_once(&p.store, p.dir.path(), p.data.path(), true);
        assert_eq!(again.scanned, 0);
    }

    #[test]
    fn disabled_config_scans_nothing() {
        let p = project();
        let once = scan_project_once(&p.store, p.dir.path(), p.data.path(), false);
        assert!(!once.started);
        assert_eq!(once.scanned, 0);
        assert!(p
            .store
            .lock()
            .unwrap()
            .scan_state("since")
            .unwrap()
            .is_none());
    }

    #[test]
    fn a_checkpoint_whose_commit_is_gone_fails_and_is_retried_at_most_three_times() {
        let p = project();
        scan_project_once(&p.store, p.dir.path(), p.data.path(), true);
        std::thread::sleep(std::time::Duration::from_millis(10));
        let id = {
            let store = p.store.lock().unwrap();
            store
                .upsert_checkpoint(CheckpointInput {
                    session_id: &p.session_id,
                    commit_sha: "0123456789abcdef0123456789abcdef01234567",
                    patch_id: None,
                    branch: Some("main"),
                    git_author_name: None,
                    git_author_email: None,
                    files_touched: &[],
                    insertions: 0,
                    deletions: 0,
                    sync_state: ProjectMode::Local.initial_sync_state(),
                })
                .unwrap()
        };
        for _ in 0..5 {
            scan_project_once(&p.store, p.dir.path(), p.data.path(), true);
        }
        let row = p
            .store
            .lock()
            .unwrap()
            .scan_for(&id, atlas_security::scan::SCANNER_VERSION)
            .unwrap()
            .unwrap();
        assert_eq!(row.status, "failed");
        assert_eq!(row.attempts, 3);
    }
}
