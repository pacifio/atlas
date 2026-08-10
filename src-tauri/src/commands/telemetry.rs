//! Tauri command surface for telemetry. The heavy lifting lives in
//! `crate::telemetry`; these just expose the managed `TelemetryClient` to the
//! renderer so it can (a) bootstrap `posthog-js` with the same anonymous id and
//! resolved key/host, (b) flip the live opt-in gate when the user toggles the
//! setting, and (c) optionally route an event through Rust.

use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use crate::telemetry::{OrgIdentity, TelemetryClient, TelemetryConfig};

/// Non-secret config for the frontend's `posthog-js` bootstrap (enabled flag,
/// host, anonymous distinct id, and the write-only project key).
#[tauri::command]
pub fn telemetry_config(client: State<'_, Arc<TelemetryClient>>) -> TelemetryConfig {
    client.config()
}

/// Flip the live opt-in gate (mirrors the persisted `share_telemetry` setting,
/// which the frontend saves via `save_app_state`). Records a single
/// opt-in/opt-out event at the boundary.
#[tauri::command]
pub fn telemetry_set_enabled(enabled: bool, client: State<'_, Arc<TelemetryClient>>) {
    client.set_enabled(enabled);
}

/// Attribute subsequent events to an Organisation.
///
/// Takes **only an id**: everything else telemetry is allowed to know — whether
/// the org is synced, its server-side name, the signed-in user's role in it — is
/// resolved here from app state and the auth snapshot. That keeps the rule about
/// *which* facts may leave the machine in Rust, where it can be read in one
/// place, instead of spread across the callers that happen to switch orgs.
///
/// `None` means no Organisation is active (a fresh profile, mid-teardown during
/// a switch), and un-groups subsequent events rather than leaving them filed
/// under the org that just closed.
#[tauri::command]
pub fn telemetry_set_org(app: AppHandle, org_id: Option<String>) {
    let client = app.state::<Arc<TelemetryClient>>();
    client.set_active_org(resolve_org(&app, org_id.as_deref()));
}

/// Build the org identity telemetry may see, from the local org row plus the
/// auth snapshot. Shared with the startup seed in `lib.rs` — the app has an
/// active Organisation from the first frame, and waiting for the renderer to
/// announce it would leave every launch-time event ungrouped.
pub fn resolve_org(app: &AppHandle, org_id: Option<&str>) -> Option<OrgIdentity> {
    let id = org_id?;
    let state = app.state::<crate::state::AppStateHandle>();
    let org = state.lock().organisations.iter().find(|o| o.id == id).cloned()?;

    // Synced means there is a server row this name is already shared through.
    // Local-only orgs travel as a bare id — see `OrgIdentity`.
    let synced = org.sync_enabled && org.remote_id.is_some();

    // The role is the signed-in user's membership in the *remote* org, so it is
    // keyed by `remote_id` rather than by the local id.
    let role = synced
        .then(|| {
            let snapshot = app.state::<super::auth::AuthState>().core().snapshot();
            let crate::auth::AuthSnapshot::SignedIn { orgs: Some(orgs), .. } = snapshot else {
                return None;
            };
            let remote = org.remote_id.as_deref()?;
            orgs.iter()
                .find(|o| o.id == remote)
                .and_then(|o| o.role)
                .map(|r| format!("{r:?}").to_lowercase())
        })
        .flatten();

    Some(OrgIdentity {
        id: org.id,
        kind: if synced { "cloud" } else { "local" },
        name: synced.then_some(org.name),
        role,
    })
}

/// Escape hatch so the frontend can route a metadata-only event through the
/// Rust emitter (primary frontend path is `posthog-js` direct). No-op unless
/// telemetry is enabled. Callers must pass **metadata only** — this is the same
/// contract as every Rust call site.
#[tauri::command]
pub fn telemetry_capture(
    event: String,
    properties: Option<Value>,
    client: State<'_, Arc<TelemetryClient>>,
) {
    client.capture(&event, properties.unwrap_or_else(|| serde_json::json!({})));
}
