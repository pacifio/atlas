//! Update discovery on Linux: tell the user a release exists, never install it.
//!
//! macOS and Windows stage a downloaded installer and swap it in on restart.
//! Linux has no single installer to do that with: the deb, rpm and Arch
//! package belong to the system package manager, and the AppImage and tarball
//! live wherever their user put them. So this side only *announces*: the same
//! check as macOS (PostHog remote config, `auto_update`-gated, honouring an
//! ignored version), and on a newer version an `atlas:update-available` event
//! carrying the release page. The frontend shows it as a notice with a link.
//!
//! The link comes from remote config, so it is checked before it is passed
//! on: an `https` URL on the project's release page or its site, or nothing.
//! Nothing here downloads or runs what it points at.
//!
//! The remote config key is `uri_linux_x86_64` or `uri_linux_aarch64`
//! (`telemetry::update_uri_flag`). A missing key means no update is offered,
//! which is how a release that has not shipped for Linux yet stays quiet here.

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};

use super::{UpdateStatus, UpdaterSnapshot};
use crate::telemetry::{RemoteUpdateConfig, TelemetryClient};

/// The running app's version (compile-time). Compared against the remote value.
const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// How often to re-check while the app runs; the same cadence as macOS.
const RECHECK_INTERVAL: Duration = Duration::from_secs(2 * 60 * 60);

/// Where a release announcement may send the user.
const ALLOWED_URL_PREFIXES: &[&str] = &[
    "https://github.com/tryatlas/atlas/releases",
    "https://tryatlas.cc/",
];

/// Nothing to keep between checks: there is no staged update on Linux.
#[derive(Default)]
pub struct UpdaterState;

impl UpdaterState {
    pub fn new() -> Self {
        Self
    }
}

fn is_newer(remote: &str, current: &str) -> bool {
    match (
        semver::Version::parse(remote.trim()),
        semver::Version::parse(current.trim()),
    ) {
        (Ok(r), Ok(c)) => r > c,
        _ => false,
    }
}

/// The release link, if it is one Atlas is willing to open.
fn allowed_url(uri: &str) -> Option<String> {
    let uri = uri.trim();
    ALLOWED_URL_PREFIXES
        .iter()
        .any(|prefix| uri.starts_with(prefix))
        .then(|| uri.to_string())
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

/// Announce `cfg` if it is newer and its link is allowed. Returns whether it
/// was announced.
fn announce(app: &AppHandle, cfg: &RemoteUpdateConfig) -> bool {
    if !is_newer(&cfg.version, CURRENT_VERSION) {
        return false;
    }
    let Some(url) = allowed_url(&cfg.uri) else {
        tracing::warn!(
            target: "atlas::updater",
            "remote config's Linux release link is not an allowed URL; no update offered"
        );
        return false;
    };
    let _ = app.emit(
        "atlas:update-available",
        serde_json::json!({
            "version": cfg.version,
            "currentVersion": CURRENT_VERSION,
            "url": url,
        }),
    );
    true
}

pub fn init_on_startup(_app: &AppHandle) {}

/// Non-blocking check. Honours `auto_update` and the ignored version.
pub fn check_in_background(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let settings = crate::state::atlas_config::read(&app);
        if !settings.auto_update {
            return;
        }
        emit_checking(&app, true);
        let cfg = fetch_remote(&app).await;
        emit_checking(&app, false);
        let Some(cfg) = cfg else { return };
        if settings.updater_ignored_version.as_deref() == Some(cfg.version.as_str()) {
            return;
        }
        announce(&app, &cfg);
    });
}

/// Periodically re-check while the app runs.
pub fn spawn_periodic(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(RECHECK_INTERVAL);
        interval.tick().await; // the startup check already ran
        loop {
            interval.tick().await;
            check_in_background(&app);
        }
    });
}

/// Nothing is ever staged, so nothing is applied on exit.
pub fn apply_on_exit(_app: &AppHandle) {}

/// Manual "Check for updates": bypasses the `auto_update` and ignored gates.
pub(super) async fn update_check_now(app: AppHandle) -> Result<UpdateStatus, String> {
    emit_checking(&app, true);
    let cfg = fetch_remote(&app).await;
    emit_checking(&app, false);
    let available = cfg.as_ref().is_some_and(|c| announce(&app, c));
    Ok(UpdateStatus {
        available,
        version: cfg.map(|c| c.version),
        current_version: CURRENT_VERSION.to_string(),
    })
}

/// Always idle: Linux never downloads or stages.
pub(super) fn update_state(_app: AppHandle, _state: State<'_, UpdaterState>) -> UpdaterSnapshot {
    UpdaterSnapshot {
        phase: "idle".into(),
        version: None,
        current_version: CURRENT_VERSION.to_string(),
    }
}

/// Persist a "don't tell me about this version again" choice.
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

/// An error, not a silent `Ok`: nothing is staged on Linux, and the frontend
/// offers "Restart to update" only after `atlas:update-ready`, which this
/// platform never emits.
pub(super) async fn update_apply(_app: AppHandle) -> Result<(), String> {
    Err("Linux updates are installed through your package manager or the release page".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_strictly_newer_semver_is_an_update() {
        assert!(is_newer("0.4.2", "0.4.1"));
        assert!(!is_newer("0.4.1", "0.4.1"));
        assert!(!is_newer("0.4.0", "0.4.1"));
        assert!(!is_newer("not-a-version", "0.4.1"));
    }

    #[test]
    fn a_release_link_must_be_the_projects_own() {
        assert_eq!(
            allowed_url(" https://github.com/tryatlas/atlas/releases/tag/alpha-0.4.2 "),
            Some("https://github.com/tryatlas/atlas/releases/tag/alpha-0.4.2".to_string())
        );
        assert!(allowed_url("https://tryatlas.cc/download").is_some());
        assert!(allowed_url("http://github.com/tryatlas/atlas/releases").is_none());
        assert!(allowed_url("https://github.com/someone/else/releases").is_none());
        assert!(allowed_url("https://tryatlas.cc.evil.example/").is_none());
        assert!(allowed_url("javascript:alert(1)").is_none());
    }
}
