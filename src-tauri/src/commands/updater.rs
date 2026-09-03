//! In-app auto-updater (macOS DMG) — Figma/VSCode/Zed-style **background staged**
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

use std::os::unix::fs::FileExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;

/// Concurrent connections used to fetch the DMG. GitHub release assets (S3)
/// throttle per-connection, so a single stream can be very slow (~67 KB/s seen
/// for a 20 MB file); splitting into ranged segments saturates the link.
const DL_CONNECTIONS: u64 = 8;
/// Below this size, parallelism isn't worth the extra requests — stream it.
const DL_PARALLEL_MIN: u64 = 4 * 1024 * 1024;
/// Flush accumulated bytes to disk once a segment buffers this much.
const DL_WRITE_CHUNK: usize = 1024 * 1024;

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

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub available: bool,
    pub version: Option<String>,
    pub current_version: String,
}

/// UI-hydration snapshot (Settings / titlebar on mount).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterSnapshot {
    /// "idle" | "downloading" | "ready"
    pub phase: String,
    pub version: Option<String>,
    pub current_version: String,
}

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
    let _ = app.emit("atlas:update-checking", serde_json::json!({ "checking": checking }));
}

fn emit_progress(app: &AppHandle, version: &str, downloaded: u64, total: u64, phase: &str) {
    let _ = app.emit(
        "atlas:update-progress",
        serde_json::json!({ "version": version, "downloaded": downloaded, "total": total, "phase": phase }),
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
                    let _ = app.emit("atlas:update-ready", serde_json::json!({ "version": cfg.version }));
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
#[tauri::command]
pub async fn update_check_now(app: AppHandle) -> Result<UpdateStatus, String> {
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
#[tauri::command]
pub fn update_state(app: AppHandle, state: State<'_, UpdaterState>) -> UpdaterSnapshot {
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
#[tauri::command]
pub async fn update_ignore(version: String, app: AppHandle) -> Result<(), String> {
    let patch = crate::state::SettingsPatch {
        updater_ignored_version: Some(Some(version)),
        ..Default::default()
    };
    // Off the async runtime thread — this touches the filesystem.
    let app_for_write = app.clone();
    let snapshot = tokio::task::spawn_blocking(move || crate::state::atlas_config::update(&app_for_write, patch))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    crate::commands::atlas_config::notify_config_changed(&app, &snapshot);
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
            let _ = app.emit("atlas:update-ready", serde_json::json!({ "version": cfg.version }));
        }
        Err(e) => {
            tracing::warn!(target: "atlas::updater", "download/stage failed: {e}");
            let _ = app.emit("atlas:update-error", serde_json::json!({ "message": e }));
        }
    }
}

async fn do_download_and_stage(app: &AppHandle, cfg: &RemoteUpdateConfig) -> Result<PathBuf, String> {
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
    let staged = tauri::async_runtime::spawn_blocking(move || stage_from_dmg(&appc, &dmgc, &dirc, &ver))
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

/// Download the DMG to `part`, then atomically rename to `final_path`. Uses a
/// **parallel multi-connection range download** when the server supports it
/// (fast on throttled CDNs like GitHub/S3); falls back to a single stream.
async fn download_to(
    app: &AppHandle,
    uri: &str,
    part: &Path,
    final_path: &Path,
    version: &str,
) -> Result<(), String> {
    // One pooled client shared by every connection.
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    // Probe with a 1-byte ranged GET: a 206 + `Content-Range: …/<total>` tells us
    // the size AND that range requests work (so we can parallelize).
    let (total, ranges_ok) = probe_size(&client, uri).await;

    let _ = std::fs::remove_file(part);
    let mut ok = false;
    if ranges_ok && total >= DL_PARALLEL_MIN {
        match download_parallel(app, &client, uri, part, total, version).await {
            Ok(()) => ok = true,
            Err(e) => {
                // Range handling can misbehave behind some redirects/CDNs; degrade
                // to a correct (if slower) single stream rather than fail.
                tracing::warn!(target: "atlas::updater", "parallel download failed ({e}); falling back to single stream");
                let _ = std::fs::remove_file(part);
            }
        }
    }
    if !ok {
        download_stream(app, &client, uri, part, total, version).await?;
    }

    std::fs::rename(part, final_path).map_err(|e| {
        let _ = std::fs::remove_file(part);
        format!("finalize download: {e}")
    })
}

/// Returns `(total_bytes, range_supported)`. `total = 0` when unknown.
async fn probe_size(client: &reqwest::Client, uri: &str) -> (u64, bool) {
    let resp = client
        .get(uri)
        .header(reqwest::header::RANGE, "bytes=0-0")
        .send()
        .await;
    let Ok(resp) = resp else { return (0, false) };
    if resp.status().as_u16() == 206 {
        // Content-Range: "bytes 0-0/12345"
        if let Some(total) = resp
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.rsplit('/').next())
            .and_then(|s| s.trim().parse::<u64>().ok())
        {
            return (total, true);
        }
    }
    // Range not honored — fall back to the full length if advertised.
    (resp.content_length().unwrap_or(0), false)
}

/// Parallel range download: pre-size the file, fetch N byte-ranges concurrently,
/// each writing at its absolute offset. A ticker emits smooth progress.
async fn download_parallel(
    app: &AppHandle,
    client: &reqwest::Client,
    uri: &str,
    part: &Path,
    total: u64,
    version: &str,
) -> Result<(), String> {
    let file = std::fs::File::create(part).map_err(|e| format!("create part: {e}"))?;
    file.set_len(total).map_err(|e| format!("size part: {e}"))?;
    let file = Arc::new(file);

    let downloaded = Arc::new(AtomicU64::new(0));
    let done = Arc::new(AtomicBool::new(false));

    // Progress ticker — decoupled from the writers so emits stay smooth and
    // aren't multiplied by the concurrent connections.
    let ticker = {
        let app = app.clone();
        let downloaded = downloaded.clone();
        let done = done.clone();
        let version = version.to_string();
        tauri::async_runtime::spawn(async move {
            loop {
                emit_progress(&app, &version, downloaded.load(Ordering::Relaxed), total, "downloading");
                if done.load(Ordering::Relaxed) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        })
    };

    let seg = total.div_ceil(DL_CONNECTIONS);
    let mut handles = Vec::new();
    let mut start = 0u64;
    while start < total {
        let end = (start + seg).min(total) - 1;
        let client = client.clone();
        let uri = uri.to_string();
        let file = file.clone();
        let downloaded = downloaded.clone();
        handles.push(tauri::async_runtime::spawn(async move {
            download_segment(&client, &uri, start, end, file, downloaded).await
        }));
        start += seg;
    }

    let mut err: Option<String> = None;
    for h in handles {
        match h.await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => err = Some(e),
            Err(e) => err = Some(format!("segment join: {e}")),
        }
    }
    done.store(true, Ordering::Relaxed);
    let _ = ticker.await;

    if let Some(e) = err {
        let _ = std::fs::remove_file(part);
        return Err(e);
    }
    emit_progress(app, version, total, total, "downloading");
    Ok(())
}

/// Fetch one byte-range and write it at its absolute offset (positional writes
/// are safe to run concurrently on non-overlapping ranges).
async fn download_segment(
    client: &reqwest::Client,
    uri: &str,
    start: u64,
    end: u64,
    file: Arc<std::fs::File>,
    downloaded: Arc<AtomicU64>,
) -> Result<(), String> {
    let resp = client
        .get(uri)
        .header(reqwest::header::RANGE, format!("bytes={start}-{end}"))
        .send()
        .await
        .map_err(|e| format!("segment request: {e}"))?;
    // Require a *partial* response — a 200 means the server ignored the Range and
    // sent the whole file, which would corrupt this offset-based writer.
    if resp.status().as_u16() != 206 {
        return Err(format!("segment download not ranged: HTTP {}", resp.status()));
    }

    let mut offset = start;
    let mut buf: Vec<u8> = Vec::with_capacity(DL_WRITE_CHUNK);
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("segment chunk: {e}"))?;
        downloaded.fetch_add(chunk.len() as u64, Ordering::Relaxed);
        buf.extend_from_slice(&chunk);
        if buf.len() >= DL_WRITE_CHUNK {
            let data = std::mem::take(&mut buf);
            let at = offset;
            offset += data.len() as u64;
            let f = file.clone();
            tokio::task::spawn_blocking(move || f.write_all_at(&data, at))
                .await
                .map_err(|e| format!("write join: {e}"))?
                .map_err(|e| format!("write segment: {e}"))?;
        }
    }
    if !buf.is_empty() {
        let at = offset;
        tokio::task::spawn_blocking(move || file.write_all_at(&buf, at))
            .await
            .map_err(|e| format!("write join: {e}"))?
            .map_err(|e| format!("write segment: {e}"))?;
    }
    Ok(())
}

/// Single-connection fallback (no range support / small file).
async fn download_stream(
    app: &AppHandle,
    client: &reqwest::Client,
    uri: &str,
    part: &Path,
    total: u64,
    version: &str,
) -> Result<(), String> {
    let resp = client.get(uri).send().await.map_err(|e| format!("download: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download failed: HTTP {}", resp.status()));
    }
    let total = if total > 0 { total } else { resp.content_length().unwrap_or(0) };
    let mut file = tokio::fs::File::create(part)
        .await
        .map_err(|e| format!("create part: {e}"))?;
    let mut downloaded = 0u64;
    let mut last_emit = 0u64;
    emit_progress(app, version, 0, total, "downloading");
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("download chunk: {e}"))?;
        file.write_all(&chunk).await.map_err(|e| format!("write: {e}"))?;
        downloaded += chunk.len() as u64;
        if downloaded - last_emit >= DL_WRITE_CHUNK as u64 || (total > 0 && downloaded >= total) {
            last_emit = downloaded;
            emit_progress(app, version, downloaded, total, "downloading");
        }
    }
    file.flush().await.map_err(|e| format!("flush: {e}"))?;
    Ok(())
}

/// Mount the DMG, verify its Apple signature, and unpack the `.app` into
/// `<updates>/staged/Atlas.app`. Returns the staged `.app` path.
fn stage_from_dmg(app: &AppHandle, dmg: &Path, dir: &Path, version: &str) -> Result<PathBuf, String> {
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
#[tauri::command]
pub async fn update_apply(app: AppHandle) -> Result<(), String> {
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
    let Some(staged) = m.staged_app.clone() else { return };
    let staged_path = PathBuf::from(staged);
    if !staged_path.exists() {
        return;
    }
    let Ok(dest) = current_app_bundle() else { return };
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
            let _ = app.emit("atlas:update-applied", serde_json::json!({ "version": CURRENT_VERSION }));
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
