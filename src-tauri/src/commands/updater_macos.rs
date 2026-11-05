//! In-app auto-updater (macOS DMG) — **background staged**
//! updates.
//!
//! Atlas ships as an Apple-signed + notarized + stapled `.dmg` (no Tauri-updater
//! `.app.tar.gz`/minisign artifact), so we don't use the Tauri updater plugin.
//! Instead:
//!
//! 1. On startup (and every few hours) a non-blocking check queries PostHog
//!    remote config for `{version, uri}` ([`check_in_background`]), where the
//!    URI comes from the key matching this machine's architecture —
//!    `uri_mac_arm` or `uri_mac_intel` (see `telemetry::update_uri_flag`).
//! 2. If newer, the DMG is **downloaded in the background** (resumable) to a
//!    staging dir — the app stays fully usable, only a titlebar arc shows.
//! 3. The DMG's Apple signature is verified and the `.app` is unpacked into a
//!    pending "staged" location (the running binary is untouched).
//! 4. The user is notified non-blockingly ("Restart to update"). They can
//!    **Restart now** (swap + relaunch) or **Later** — in which case the staged
//!    update is applied automatically on the next natural quit ([`apply_on_exit`]).
//!
//! Everything is `auto_update`-gated and honors an "ignored version".
//!
//! Events emitted to the frontend:
//!   `atlas:update-checking` `{ checking }`
//!   `atlas:update-available` `{ version, currentVersion }`      (download starting)
//!   `atlas:update-progress`  `{ version, downloaded, total, phase }`
//!   `atlas:update-ready`     `{ version }`                       (staged, restart to apply)
//!   `atlas:update-error`     `{ message }`
//!   `atlas:update-applied`   `{ version }`                       (post-restart toast)

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use super::download::{download_to, emit_progress};
use super::{UpdateStatus, UpdaterSnapshot};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::telemetry::{RemoteUpdateConfig, TelemetryClient};

/// The running app's version (compile-time). Compared against the remote value.
const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Apple Team ID the downloaded DMG's app MUST be signed by, or we refuse to
/// install it — the security anchor for the whole update, since the DMG is
/// fetched over an attacker-controllable remote-config URL.
const EXPECTED_TEAM_ID: &str = "PLKDA3WBJJ";

/// How often to re-check for updates while the app runs.
const RECHECK_INTERVAL: Duration = Duration::from_secs(2 * 60 * 60);

/// Persisted record of a staged update (`<app_data>/updates/staging.json`).
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct Staging {
    version: String,
    /// Path to the verified, unpacked `.app` once ready.
    staged_app: Option<String>,
    /// The DMG has been downloaded, verified, and unpacked — ready to swap.
    ready: bool,
    /// The swap has been performed (applied on restart/quit) — used at startup
    /// to detect a completed update and clean up.
    #[serde(default)]
    applied: bool,
}

/// In-memory updater state (managed).
#[derive(Default)]
pub struct UpdaterState {
    /// Latest `{version, uri}` from a check.
    pending: Mutex<Option<RemoteUpdateConfig>>,
    /// Guards against concurrent background downloads.
    downloading: AtomicBool,
    /// Version currently staged + ready (mirror of the on-disk manifest).
    ready: Mutex<Option<String>>,
}

impl UpdaterState {
    pub fn new() -> Self {
        Self::default()
    }
}

// ── Paths / manifest ─────────────────────────────────────────────────────────

fn updates_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    Ok(base.join("updates"))
}

fn manifest_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(updates_dir(app)?.join("staging.json"))
}

fn load_manifest(app: &AppHandle) -> Option<Staging> {
    let path = manifest_path(app).ok()?;
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn save_manifest(app: &AppHandle, m: &Staging) -> Result<(), String> {
    let dir = updates_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("updates dir: {e}"))?;
    let raw = serde_json::to_string_pretty(m).map_err(|e| format!("serialize manifest: {e}"))?;
    std::fs::write(dir.join("staging.json"), raw).map_err(|e| format!("write manifest: {e}"))
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Semver "is `remote` strictly newer than `current`?". False on parse failure.
fn is_newer(remote: &str, current: &str) -> bool {
    match (
        semver::Version::parse(remote.trim()),
        semver::Version::parse(current.trim()),
    ) {
        (Ok(r), Ok(c)) => r > c,
        _ => false,
    }
}

fn read_settings(app: &AppHandle) -> (bool, Option<String>) {
    let settings = crate::state::atlas_config::read(app);
    (settings.auto_update, settings.updater_ignored_version)
}

async fn fetch_remote(app: &AppHandle) -> Option<RemoteUpdateConfig> {
    let tel = app.state::<Arc<TelemetryClient>>().inner().clone();
    tel.fetch_remote_config().await
}

fn emit_checking(app: &AppHandle, checking: bool) {
    let _ = app.emit(
        "atlas:update-checking",
        serde_json::json!({ "checking": checking }),
    );
}

// ── Check ────────────────────────────────────────────────────────────────────

/// Non-blocking check. Honors `auto_update` + ignored version. If a newer
/// version is found, kicks off the background download+stage (or re-notifies
/// "ready" if it's already staged). Emits `atlas:update-available`.
pub fn check_in_background(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let (auto, ignored) = read_settings(&app);
        if !auto {
            return;
        }
        emit_checking(&app, true);
        let cfg = fetch_remote(&app).await;
        emit_checking(&app, false);
        let Some(cfg) = cfg else { return };
        if !is_newer(&cfg.version, CURRENT_VERSION) {
            return;
        }
        if ignored.as_deref() == Some(cfg.version.as_str()) {
            return;
        }
        maybe_start_update(&app, cfg, false).await;
    });
}

/// Given a newer remote config, either re-notify a matching staged update or
/// start the background download. `force` bypasses the ignored-version gate
/// (used by the manual check).
async fn maybe_start_update(app: &AppHandle, cfg: RemoteUpdateConfig, _force: bool) {
    *app.state::<UpdaterState>().pending.lock() = Some(cfg.clone());

    // Already downloaded + staged for this exact version → just notify.
    if let Some(m) = load_manifest(app) {
        if m.ready && m.version == cfg.version {
            if let Some(p) = &m.staged_app {
                if Path::new(p).exists() {
                    *app.state::<UpdaterState>().ready.lock() = Some(cfg.version.clone());
                    let _ = app.emit(
                        "atlas:update-ready",
                        serde_json::json!({ "version": cfg.version }),
                    );
                    return;
                }
            }
        }
    }

    let _ = app.emit(
        "atlas:update-available",
        serde_json::json!({ "version": cfg.version, "currentVersion": CURRENT_VERSION }),
    );
    download_and_stage(app.clone(), cfg).await;
}

/// Manual "Check for updates" — bypasses the auto_update / ignored gates (an
/// explicit user action). Triggers the background download when newer.
pub(super) async fn update_check_now(app: AppHandle) -> Result<UpdateStatus, String> {
    emit_checking(&app, true);
    let cfg = fetch_remote(&app).await;
    emit_checking(&app, false);
    let available = cfg
        .as_ref()
        .map(|c| is_newer(&c.version, CURRENT_VERSION))
        .unwrap_or(false);
    let version = cfg.as_ref().map(|c| c.version.clone());
    if available {
        maybe_start_update(&app, cfg.unwrap(), true).await;
    }
    Ok(UpdateStatus {
        available,
        version,
        current_version: CURRENT_VERSION.to_string(),
    })
}

/// Current updater state for UI hydration on mount.
pub(super) fn update_state(app: AppHandle, state: State<'_, UpdaterState>) -> UpdaterSnapshot {
    if let Some(v) = state.ready.lock().clone() {
        return UpdaterSnapshot {
            phase: "ready".into(),
            version: Some(v),
            current_version: CURRENT_VERSION.to_string(),
        };
    }
    if state.downloading.load(Ordering::SeqCst) {
        let v = state.pending.lock().as_ref().map(|c| c.version.clone());
        return UpdaterSnapshot {
            phase: "downloading".into(),
            version: v,
            current_version: CURRENT_VERSION.to_string(),
        };
    }
    // Fall back to the on-disk manifest (e.g. staged before this window mounted).
    if let Some(m) = load_manifest(&app) {
        if m.ready && is_newer(&m.version, CURRENT_VERSION) {
            return UpdaterSnapshot {
                phase: "ready".into(),
                version: Some(m.version),
                current_version: CURRENT_VERSION.to_string(),
            };
        }
    }
    UpdaterSnapshot {
        phase: "idle".into(),
        version: None,
        current_version: CURRENT_VERSION.to_string(),
    }
}

/// Persist a "don't prompt for this version again" choice.
pub(super) async fn update_ignore(version: String, app: AppHandle) -> Result<(), String> {
    let patch = crate::state::SettingsPatch {
        updater_ignored_version: Some(Some(version)),
        ..Default::default()
    };
    // Off the async runtime thread — this touches the filesystem.
    let app_for_write = app.clone();
    let snapshot = tokio::task::spawn_blocking(move || {
        crate::state::atlas_config::update(&app_for_write, patch)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    crate::commands::atlas_config::notify_settings_changed(
        &app,
        &snapshot.settings,
        snapshot.generation,
    );
    Ok(())
}

// ── Download + stage ─────────────────────────────────────────────────────────

/// Orchestrate a background download → verify → stage. Single-flight via the
/// `downloading` guard. On success emits `atlas:update-ready`.
async fn download_and_stage(app: AppHandle, cfg: RemoteUpdateConfig) {
    if app
        .state::<UpdaterState>()
        .downloading
        .swap(true, Ordering::SeqCst)
    {
        return; // a download is already in flight
    }
    let result = do_download_and_stage(&app, &cfg).await;
    app.state::<UpdaterState>()
        .downloading
        .store(false, Ordering::SeqCst);

    match result {
        Ok(_) => {
            *app.state::<UpdaterState>().ready.lock() = Some(cfg.version.clone());
            let _ = app.emit(
                "atlas:update-ready",
                serde_json::json!({ "version": cfg.version }),
            );
        }
        Err(e) => {
            tracing::warn!(target: "atlas::updater", "download/stage failed: {e}");
            let _ = app.emit("atlas:update-error", serde_json::json!({ "message": e }));
        }
    }
}

async fn do_download_and_stage(
    app: &AppHandle,
    cfg: &RemoteUpdateConfig,
) -> Result<PathBuf, String> {
    let dir = updates_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("updates dir: {e}"))?;
    let dmg = dir.join(format!("Atlas-{}.dmg", cfg.version));
    let part = dir.join(format!("Atlas-{}.dmg.part", cfg.version));

    // Already fully staged? short-circuit.
    if let Some(m) = load_manifest(app) {
        if m.ready && m.version == cfg.version {
            if let Some(p) = m.staged_app {
                if Path::new(&p).exists() {
                    return Ok(PathBuf::from(p));
                }
            }
        }
    }

    if !dmg.exists() {
        download_to(app, &cfg.uri, &part, &dmg, &cfg.version).await?;
    }

    // Mount + verify + unpack (blocking / subprocess heavy).
    let appc = app.clone();
    let dmgc = dmg.clone();
    let dirc = dir.clone();
    let ver = cfg.version.clone();
    let staged =
        tauri::async_runtime::spawn_blocking(move || stage_from_dmg(&appc, &dmgc, &dirc, &ver))
            .await
            .map_err(|e| format!("stage join: {e}"))??;

    save_manifest(
        app,
        &Staging {
            version: cfg.version.clone(),
            staged_app: Some(staged.to_string_lossy().into_owned()),
            ready: true,
            applied: false,
        },
    )?;
    // The DMG is unpacked; free the disk space (keep only the staged .app).
    let _ = std::fs::remove_file(&dmg);
    Ok(staged)
}

/// Mount the DMG, verify its Apple signature, and unpack the `.app` into
/// `<updates>/staged/Atlas.app`. Returns the staged `.app` path.
fn stage_from_dmg(
    app: &AppHandle,
    dmg: &Path,
    dir: &Path,
    version: &str,
) -> Result<PathBuf, String> {
    emit_progress(app, version, 0, 0, "verifying");
    let mount_point = dir.join("mnt");
    let _ = std::fs::remove_dir_all(&mount_point);
    std::fs::create_dir_all(&mount_point).map_err(|e| format!("mount dir: {e}"))?;

    let out = Command::new("hdiutil")
        .args(["attach", "-nobrowse", "-readonly", "-mountpoint"])
        .arg(&mount_point)
        .arg(dmg)
        .output()
        .map_err(|e| format!("hdiutil attach: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "failed to mount update DMG: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }

    let result = stage_from_mount(&mount_point, dir);

    let _ = Command::new("hdiutil")
        .args(["detach", "-quiet"])
        .arg(&mount_point)
        .output();
    let _ = std::fs::remove_dir_all(&mount_point);
    result
}

fn stage_from_mount(mount_point: &Path, dir: &Path) -> Result<PathBuf, String> {
    let src_app = std::fs::read_dir(mount_point)
        .map_err(|e| format!("read mount: {e}"))?
        .filter_map(std::result::Result::ok)
        .map(|e| e.path())
        .find(|p| p.extension().map(|x| x == "app").unwrap_or(false))
        .ok_or_else(|| "no .app found in the update DMG".to_string())?;

    // Verify the Apple signature + team id BEFORE trusting the payload.
    verify_signature(&src_app)?;

    let staged_dir = dir.join("staged");
    let _ = std::fs::remove_dir_all(&staged_dir);
    std::fs::create_dir_all(&staged_dir).map_err(|e| format!("staged dir: {e}"))?;
    let staged_app = staged_dir.join("Atlas.app");

    let out = Command::new("ditto")
        .arg(&src_app)
        .arg(&staged_app)
        .output()
        .map_err(|e| format!("ditto: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "failed to unpack update: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(staged_app)
}

// ── Apply (swap) ─────────────────────────────────────────────────────────────

/// "Restart now": swap the staged `.app` over the running install and relaunch.
pub(super) async fn update_apply(app: AppHandle) -> Result<(), String> {
    let m = load_manifest(&app).ok_or("no update is staged")?;
    if !m.ready {
        return Err("update not ready yet".into());
    }
    let staged = m.staged_app.clone().ok_or("no staged app")?;
    let staged_path = PathBuf::from(staged);
    if !staged_path.exists() {
        return Err("staged update is missing".into());
    }
    let dest = current_app_bundle()?;

    let sp = staged_path.clone();
    let res = tauri::async_runtime::spawn_blocking(move || swap_app(&sp, &dest))
        .await
        .map_err(|e| format!("apply join: {e}"))?;

    match res {
        Ok(()) => {
            let _ = save_manifest(
                &app,
                &Staging {
                    version: m.version,
                    staged_app: None,
                    ready: false,
                    applied: true,
                },
            );
            if let Ok(dir) = updates_dir(&app) {
                let _ = std::fs::remove_dir_all(dir.join("staged"));
            }
            app.restart();
        }
        Err(e) => {
            let _ = app.emit("atlas:update-error", serde_json::json!({ "message": e }));
            Err(e)
        }
    }
}

/// Apply a staged update at natural quit ("Later"). Best-effort, blocking, no
/// relaunch — the next launch is the new version. Skipped for ignored versions.
pub fn apply_on_exit(app: &AppHandle) {
    let Some(m) = load_manifest(app) else { return };
    if !m.ready {
        return;
    }
    if !is_newer(&m.version, CURRENT_VERSION) {
        return;
    }
    let ignored = crate::state::atlas_config::read(app).updater_ignored_version;
    if ignored.as_deref() == Some(m.version.as_str()) {
        return;
    }
    let Some(staged) = m.staged_app.clone() else {
        return;
    };
    let staged_path = PathBuf::from(staged);
    if !staged_path.exists() {
        return;
    }
    let Ok(dest) = current_app_bundle() else {
        return;
    };
    if swap_app(&staged_path, &dest).is_ok() {
        let _ = save_manifest(
            app,
            &Staging {
                version: m.version,
                staged_app: None,
                ready: false,
                applied: true,
            },
        );
        if let Ok(dir) = updates_dir(app) {
            let _ = std::fs::remove_dir_all(dir.join("staged"));
        }
    }
}

/// Startup housekeeping: if a staged update was applied (we're now running a
/// version >= the staged one), clean it up and toast. Call before the first
/// check.
pub fn init_on_startup(app: &AppHandle) {
    let Some(m) = load_manifest(app) else { return };
    // Running a version at or beyond the staged one → the staging is obsolete
    // (applied on the previous quit, or superseded by a manual install).
    if !is_newer(&m.version, CURRENT_VERSION) {
        if let Ok(dir) = updates_dir(app) {
            let _ = std::fs::remove_dir_all(&dir);
        }
        if m.applied {
            let _ = app.emit(
                "atlas:update-applied",
                serde_json::json!({ "version": CURRENT_VERSION }),
            );
        }
    }
}

/// Periodically re-check for updates while the app runs.
pub fn spawn_periodic(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(RECHECK_INTERVAL);
        interval.tick().await; // consume the immediate first tick (startup already checked)
        loop {
            interval.tick().await;
            check_in_background(&app);
        }
    });
}

/// Swap `staged` over `dest` with a `.bak` rollback. Tries an atomic rename
/// (same APFS volume — instant); falls back to a `ditto` copy.
fn swap_app(staged: &Path, dest: &Path) -> Result<(), String> {
    let backup = dest.with_extension("app.bak");
    let _ = std::fs::remove_dir_all(&backup);
    if dest.exists() {
        std::fs::rename(dest, &backup).map_err(|e| format!("back up current app: {e}"))?;
    }
    // Fast path: atomic directory rename on the same volume.
    if std::fs::rename(staged, dest).is_err() {
        let out = Command::new("ditto")
            .arg(staged)
            .arg(dest)
            .output()
            .map_err(|e| format!("ditto: {e}"))?;
        if !out.status.success() {
            // Roll back to the original bundle.
            let _ = std::fs::remove_dir_all(dest);
            if backup.exists() {
                let _ = std::fs::rename(&backup, dest);
            }
            return Err(format!(
                "install failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
    }
    let _ = std::fs::remove_dir_all(&backup);
    Ok(())
}

/// `codesign --verify --deep --strict` + Team ID match + `spctl` Gatekeeper
/// assessment. All three must pass.
fn verify_signature(app_path: &Path) -> Result<(), String> {
    let verify = Command::new("codesign")
        .args(["--verify", "--deep", "--strict", "--verbose=2"])
        .arg(app_path)
        .output()
        .map_err(|e| format!("codesign: {e}"))?;
    if !verify.status.success() {
        return Err("update rejected: code signature invalid".into());
    }

    let info = Command::new("codesign")
        .args(["-dvvv"])
        .arg(app_path)
        .output()
        .map_err(|e| format!("codesign -dvvv: {e}"))?;
    let meta = String::from_utf8_lossy(&info.stderr);
    let team_ok = meta
        .lines()
        .any(|l| l.trim() == format!("TeamIdentifier={EXPECTED_TEAM_ID}"));
    if !team_ok {
        return Err("update rejected: unexpected signing team".into());
    }

    let spctl = Command::new("spctl")
        .args(["--assess", "--type", "execute", "--verbose=2"])
        .arg(app_path)
        .output()
        .map_err(|e| format!("spctl: {e}"))?;
    if !spctl.status.success() {
        return Err("update rejected: notarization check failed".into());
    }
    Ok(())
}

/// Resolve the running `Atlas.app` bundle root from the executable path
/// (`…/Atlas.app/Contents/MacOS/atlas` → `…/Atlas.app`).
fn current_app_bundle() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let app = exe
        .parent() // MacOS
        .and_then(|p| p.parent()) // Contents
        .and_then(|p| p.parent()) // Atlas.app
        .map(std::path::Path::to_path_buf)
        .ok_or_else(|| "could not resolve app bundle path".to_string())?;
    if app.extension().map(|x| x == "app").unwrap_or(false) {
        Ok(app)
    } else {
        Err(format!(
            "running from a non-.app location ({}); update via the DMG",
            app.display()
        ))
    }
}
