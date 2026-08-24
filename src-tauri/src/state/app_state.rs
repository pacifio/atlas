//! `AppState` — the small Rust-owned struct that mirrors what `useProjectStore`
//! used to persist via zustand's localStorage middleware. Shape matches the
//! JS side via `#[serde(rename_all = "camelCase")]` so the frontend can use
//! the deserialized payload verbatim.

use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Current schema version. Bump and migrate (or reset) when fields change
/// shape. Older payloads with a smaller `version` are loadable as long as
/// the missing fields default to sensible values.
///
/// v2 introduced the multi-workspace model (`workspaces`/`groups`/
/// `active_workspace_id`); `current_project` is retained only as a
/// migration source for v1 payloads.
///
/// v3 introduced the Organisation layer above workspaces
/// (`organisations`/`active_organisation_id`, plus `org_id` on each
/// workspace/group). v2 payloads are migrated by wrapping all existing
/// workspaces in a default local "Personal" org.
pub const SCHEMA_VERSION: u32 = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub name: String,
    pub path: String,
    /// ISO-8601 timestamp; the frontend reads this verbatim.
    pub last_opened: String,
}

/// A single open workspace = one project plus its UI state identity. The
/// `id` is the stable key that replaces `webview.label()` everywhere Rust
/// state used to be keyed per-window (file index, git watcher, mention
/// cache, recent files).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub group_id: Option<String>,
    /// Owning Organisation. `None` on pre-v3 payloads — `migrate()` backfills
    /// it to the default org. The sidebar filters workspaces by the active org.
    #[serde(default)]
    pub org_id: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    /// Optional git remote. The ONLY field (besides id/name) that syncs to the
    /// server (`workspace_refs.git_url`) for one-click clone; the source tree
    /// itself never syncs. `None` for local-only projects.
    #[serde(default)]
    pub git_url: Option<String>,
    /// ISO-8601 timestamp of the last time this workspace was the active
    /// one; used to order the sidebar / pick a fallback on close.
    #[serde(default)]
    pub last_active_at: Option<String>,
}

/// A user-defined collapsible folder that groups workspaces in the sidebar.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGroup {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub order: u32,
    /// Owning Organisation (mirrors `Workspace::org_id`). `None` on pre-v3
    /// payloads — `migrate()` backfills it to the default org.
    #[serde(default)]
    pub org_id: Option<String>,
}

/// A top-level tenant that owns a set of workspaces (the Linear "workspace
/// picker" model). Exactly one org is active per window. Local-only until the
/// user opts into sync per org (Chrome-profile model). The shape is a superset
/// of the server `organization` row so cloud sync is a thin adapter:
/// `{ id, name, slug, logo, metadata }` map to the server; the rest is local.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Organisation {
    pub id: String,
    pub name: String,
    /// URL-safe unique handle (server enforces a global unique index). Derived
    /// from `name` at create time; kept stable thereafter.
    pub slug: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub logo: Option<String>,
    /// ISO-8601 creation timestamp.
    #[serde(default)]
    pub created_at: Option<String>,
    /// Per-org memory of the last active workspace, so an org switch restores
    /// the user where they left off. Local-only (the server has no such notion).
    #[serde(default)]
    pub active_workspace_id: Option<String>,
    /// Opt-in cloud sync flag (Chrome-profile model). `false` = local-only.
    #[serde(default)]
    pub sync_enabled: bool,
    /// The server `organization.id` once this org has been linked via
    /// "Turn on sync". `None` while local-only. Reconciliation seam for the
    /// auth branch.
    #[serde(default)]
    pub remote_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    /// Legacy single-project field. Kept for migration from v1 `state.json`;
    /// the frontend now derives "current project" from
    /// `active_workspace_id`. New writes leave this `None`.
    #[serde(default)]
    pub current_project: Option<Project>,
    #[serde(default)]
    pub recent_projects: Vec<RecentProject>,
    #[serde(default)]
    pub workspaces: Vec<Workspace>,
    #[serde(default)]
    pub groups: Vec<WorkspaceGroup>,
    #[serde(default)]
    pub active_workspace_id: Option<String>,
    /// The Organisation layer above workspaces (v3). Each workspace/group is
    /// tagged with an `org_id`; the sidebar shows only the active org's set.
    #[serde(default)]
    pub organisations: Vec<Organisation>,
    #[serde(default)]
    pub active_organisation_id: Option<String>,
    #[serde(default)]
    pub settings: AppSettings,
    /// Stable anonymous id for opt-in product telemetry (PostHog `distinct_id`).
    /// Generated once on first launch (see `lib.rs` setup); never contains PII.
    /// `None` on old `state.json` files — backfilled + persisted at startup.
    #[serde(default)]
    pub telemetry_anon_id: Option<String>,
    #[serde(default = "default_version")]
    pub version: u32,
}

fn default_version() -> u32 {
    SCHEMA_VERSION
}

/// The slice of [`AppState`] the **frontend** is allowed to write.
///
/// Deliberately a distinct type. `save_app_state` used to take a whole
/// `AppState` and do `*guard = payload`, so every Rust-owned field was silently
/// destroyed by any settings change: the frontend's `buildAppStatePayload()`
/// never sent `telemetryAnonId`, it deserialized to `None`, persisted as null,
/// and the next launch minted a fresh id. One device became a new analytics
/// person on every settings save.
///
/// Listing the frontend-owned fields here — rather than special-casing the one
/// field that got bitten — means the next Rust-owned field added to `AppState`
/// is safe by construction instead of by remembering.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatePatch {
    #[serde(default)]
    pub recent_projects: Vec<RecentProject>,
    #[serde(default)]
    pub workspaces: Vec<Workspace>,
    #[serde(default)]
    pub groups: Vec<WorkspaceGroup>,
    #[serde(default)]
    pub active_workspace_id: Option<String>,
    #[serde(default)]
    pub organisations: Vec<Organisation>,
    #[serde(default)]
    pub active_organisation_id: Option<String>,
    #[serde(default)]
    pub settings: AppSettings,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            current_project: None,
            recent_projects: Vec::new(),
            workspaces: Vec::new(),
            groups: Vec::new(),
            active_workspace_id: None,
            organisations: Vec::new(),
            active_organisation_id: None,
            settings: AppSettings::default(),
            telemetry_anon_id: None,
            version: SCHEMA_VERSION,
        }
    }
}

/// A globally-unique handle for the auto-created "Personal" organisation.
///
/// Every install creates one, so a fixed `"personal"` would collide for the
/// second person who ever turns on sync — the server's unique index on
/// `organization.slug` would reject it, and the failure would land on a user who
/// never chose the handle in the first place. Suffixing per-install entropy
/// makes the first sync of a default org always succeed.
///
/// The entropy is a **fresh random UUID**, deliberately not the telemetry
/// anon-id: a slug is public and leaves the machine, and the org's creation
/// time sits right next to it, so hashing that id with a timestamp would be
/// recomputable by anyone holding both — quietly linking an anonymous telemetry
/// profile to a named account. Random bytes give the same uniqueness and cannot
/// correlate to anything.
fn default_personal_slug() -> String {
    use sha2::{Digest, Sha256};
    use std::time::{SystemTime, UNIX_EPOCH};

    let entropy = uuid::Uuid::new_v4();
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let digest = Sha256::digest(format!("{entropy}:{millis}").as_bytes());
    // 5 bytes = 10 hex chars (~2^40). The handle stays typeable, and the space
    // is far beyond anything a birthday collision reaches in practice.
    let short: String = digest.iter().take(5).map(|b| format!("{b:02x}")).collect();
    format!("personal-{short}")
}

impl AppState {
    /// Migrate a freshly-deserialized older payload in place. Idempotent —
    /// re-running on an already-migrated state is a no-op.
    ///
    /// v1 → v2: if no workspaces exist yet but a legacy `current_project` is
    /// present, synthesize a single workspace from it and make it active.
    ///
    /// v2 → v3: if no organisations exist yet, wrap every workspace/group in a
    /// default local "Personal" org and make it active.
    fn migrate(&mut self) {
        if self.workspaces.is_empty() {
            if let Some(project) = self.current_project.take() {
                let id = uuid::Uuid::new_v4().to_string();
                self.active_workspace_id = Some(id.clone());
                self.workspaces.push(Workspace {
                    id,
                    name: project.name,
                    path: project.path,
                    group_id: None,
                    org_id: None,
                    color: None,
                    git_url: None,
                    last_active_at: None,
                });
            }
        }
        self.current_project = None;

        // v2 → v3: ensure a default Organisation owns all existing workspaces.
        if self.organisations.is_empty() {
            let org_id = uuid::Uuid::new_v4().to_string();
            self.organisations.push(Organisation {
                id: org_id.clone(),
                name: "Personal".to_string(),
                slug: default_personal_slug(),
                color: None,
                logo: None,
                created_at: None,
                active_workspace_id: self.active_workspace_id.clone(),
                sync_enabled: false,
                remote_id: None,
            });
            self.active_organisation_id = Some(org_id);
        }

        // Repair installs created before the handle carried entropy: their
        // default org still holds the literal `"personal"`, which is exactly
        // the collision above avoids. Safe to rewrite only while the org is
        // UNSYNCED — once `remote_id` is set the server owns that handle and
        // it is not ours to change. Narrowed to the untouched auto-created
        // default (name AND slug both still the originals) so a handle the
        // user deliberately typed is never silently swapped underneath them.
        for org in &mut self.organisations {
            if org.remote_id.is_none() && org.name == "Personal" && org.slug == "personal" {
                org.slug = default_personal_slug();
            }
        }

        // Backfill org ownership on any untagged workspace/group (covers both
        // the fresh migration above and stray untagged entries).
        if let Some(default_org) = self.active_organisation_id.clone() {
            for ws in &mut self.workspaces {
                if ws.org_id.is_none() {
                    ws.org_id = Some(default_org.clone());
                }
            }
            for group in &mut self.groups {
                if group.org_id.is_none() {
                    group.org_id = Some(default_org.clone());
                }
            }
        }

        self.version = SCHEMA_VERSION;
    }
}

/// User-facing toggles surfaced in Settings → General.
///
/// New fields MUST be `#[serde(default = "…")]` or have an obvious zero
/// value so old `state.json` files (written before the field existed)
/// load cleanly.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// On project open, ensure `.atlas/` is listed in the project's
    /// `.gitignore` (creating the file if needed). No-op on non-git
    /// projects. Default ON because Atlas writes caches / state into
    /// `.atlas/` that don't belong in version control.
    #[serde(default = "default_true")]
    pub auto_add_atlas_gitignore: bool,
    /// Record Atlas-internal events (sign-in, agent start/finish,
    /// browser/file open, etc.) into the Logs panel under the `atlas`
    /// source. Default ON so early users can share their logs without
    /// flipping a flag first.
    #[serde(default = "default_true")]
    pub enable_atlas_logs: bool,
    /// Show dotfiles / dot-directories (e.g. `.git`, `.atlas`, `.env`) in
    /// the explorer file tree. Default ON so nothing is silently hidden;
    /// users who want a cleaner tree can turn it off.
    #[serde(default = "default_true")]
    pub show_hidden_files: bool,
    /// Global interface zoom (1.0 == 100%). Applied via the native WebView zoom
    /// on the frontend (⌘+/⌘-/⌘0); persisted so it survives relaunch.
    #[serde(default = "default_ui_scale")]
    pub ui_scale: f32,
    /// Anonymous product telemetry (PostHog). Default **ON** (opt-out, like
    /// VS Code / Zed) — privacy-preserving metadata only; the user can turn it
    /// off anytime in Settings → General. Gates both the Rust emitter and the
    /// frontend `posthog-js` crash reporter. Still inert unless a key resolves.
    /// See `crate::telemetry`.
    #[serde(default = "default_true")]
    pub share_telemetry: bool,
    /// Attribute telemetry to the signed-in Atlas account (PostHog `$identify`),
    /// rather than keeping it on the anonymous per-device person. Default **ON**,
    /// and irrelevant while signed out or while `share_telemetry` is off — both
    /// gate this. Turning it off calls `reset_identity`, so subsequent events go
    /// back to the device person; it does not un-merge what PostHog has already
    /// attributed. See `crate::telemetry`.
    #[serde(default = "default_true")]
    pub link_telemetry_to_account: bool,
    /// Selected on-device **embedding** model id (== its dir name under
    /// `app_data/models/`). Drives `memory_graph::model_dir` and every embedding
    /// consumer via the shared provider. Switching it wipes + rebuilds the
    /// per-project memory index (different model = different vector space).
    /// See `crate::commands::models`.
    #[serde(default = "default_embedding_model")]
    pub embedding_model_id: String,
    /// Code-editor color theme id (see `src/features/editor/themes`). Drives the
    /// CodeMirror editor, the diff viewer and the source-control diff views on
    /// the frontend; persisted so it survives relaunch.
    #[serde(default = "default_code_editor_theme")]
    pub code_editor_theme: String,
    /// Atlas interface-theme id (see `src/features/theme/themes`). Swaps the
    /// whole dark UI palette on the frontend — independent of the editor syntax
    /// theme; persisted so it survives relaunch.
    #[serde(default = "default_atlas_theme")]
    pub atlas_theme: String,
    /// Inline Git blame in the code editor — a dim author / age / commit
    /// summary annotation trailing the active line. Default ON; when off the
    /// editor doesn't even load the extension (no blame IPC).
    #[serde(default = "default_true")]
    pub git_blame_inline: bool,
    /// Auto-update master switch. When ON (default), every startup runs a
    /// non-blocking check against PostHog remote config and prompts if a newer
    /// version is available. See `crate::commands::updater`.
    #[serde(default = "default_true")]
    pub auto_update: bool,
    /// A version the user chose to "Ignore" in the update prompt — the startup
    /// check won't re-prompt for exactly this version. `None` = nothing ignored.
    #[serde(default)]
    pub updater_ignored_version: Option<String>,
    /// Chat composer send gesture. Default ON: Enter sends, Shift+Enter inserts
    /// a newline (Slack/Discord/ChatGPT convention). OFF: only Cmd/Ctrl+Enter
    /// sends, matching Atlas's original behavior. Cmd/Ctrl+Enter always sends
    /// regardless of this setting. See `src/features/chat/components/chat-input.tsx`.
    #[serde(default = "default_true")]
    pub enter_to_send: bool,
}

fn default_true() -> bool {
    true
}

/// Default code-editor theme — the historical monochrome "atlas" look.
pub fn default_code_editor_theme() -> String {
    "atlas".to_string()
}

/// Default Atlas interface theme — the historical AMOLED-black look.
pub fn default_atlas_theme() -> String {
    "atlas-black".to_string()
}

/// Default embedding model — the historical `all-MiniLM-L6-v2` dir, so existing
/// installs keep using their already-downloaded model with no migration.
pub fn default_embedding_model() -> String {
    "all-MiniLM-L6-v2".to_string()
}

fn default_ui_scale() -> f32 {
    1.0
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            auto_add_atlas_gitignore: true,
            enable_atlas_logs: true,
            show_hidden_files: true,
            ui_scale: default_ui_scale(),
            share_telemetry: true,
            link_telemetry_to_account: true,
            embedding_model_id: default_embedding_model(),
            code_editor_theme: default_code_editor_theme(),
            atlas_theme: default_atlas_theme(),
            git_blame_inline: true,
            auto_update: true,
            updater_ignored_version: None,
            enter_to_send: true,
        }
    }
}

/// Thread-safe handle registered as Tauri managed state.
pub type AppStateHandle = Arc<Mutex<AppState>>;

impl AppState {
    /// Apply a frontend save, preserving every Rust-owned field.
    ///
    /// The counterpart to [`AppStatePatch`]: what is absent from the patch is
    /// absent because Rust owns it, and stays untouched here.
    pub fn apply_patch(&mut self, p: AppStatePatch) {
        // Legacy v1 field — the frontend already sends `null` and derives the
        // current project from `active_workspace_id`. Never re-adopted.
        self.current_project = None;
        self.recent_projects = p.recent_projects;
        self.workspaces = p.workspaces;
        self.groups = p.groups;
        self.active_workspace_id = p.active_workspace_id;
        self.organisations = p.organisations;
        self.active_organisation_id = p.active_organisation_id;
        self.settings = p.settings;
        self.version = SCHEMA_VERSION;
        // `telemetry_anon_id` (and anything Rust adds later) is deliberately
        // NOT assigned here. See the `AppStatePatch` doc.
    }

    /// `<app_data_dir>/state.json`. Returns `None` if the data dir can't be
    /// resolved (no $HOME / no `APPDATA`, etc.) — caller falls back to
    /// `AppState::default()`.
    fn path(app: &AppHandle) -> Option<PathBuf> {
        app.path().app_data_dir().ok().map(|d| d.join("state.json"))
    }

    /// Read from disk synchronously. Designed to be called from `setup()`
    /// before the webview opens — the cost is one `fs::read_to_string` of a
    /// few-KB JSON file (~1 ms on warm cache). Returns `Self::default()` on
    /// any I/O or parse failure so a corrupt file never blocks app launch.
    pub fn load(app: &AppHandle) -> Self {
        let Some(path) = Self::path(app) else {
            return Self::default();
        };
        let Ok(raw) = std::fs::read_to_string(&path) else {
            return Self::default();
        };
        let mut state: AppState = serde_json::from_str(&raw).unwrap_or_default();
        state.migrate();
        state
    }

    /// Atomic write — `state.json.tmp` then `rename` so a crash mid-write
    /// can never leave a torn JSON file behind.
    pub fn save(app: &AppHandle, state: &AppState) -> std::io::Result<()> {
        let Some(path) = Self::path(app) else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "could not resolve app_data_dir",
            ));
        };
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        let raw = serde_json::to_string_pretty(state).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string())
        })?;
        std::fs::write(&tmp, raw)?;
        std::fs::rename(tmp, path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Exactly the payload `buildAppStatePayload()` sends — note the absence of
    /// `telemetryAnonId`, which is the whole point.
    fn frontend_payload() -> AppStatePatch {
        serde_json::from_value(serde_json::json!({
            "currentProject": null,
            "recentProjects": [],
            "workspaces": [],
            "groups": [],
            "activeWorkspaceId": null,
            "organisations": [],
            "activeOrganisationId": null,
            "settings": { "shareTelemetry": false },
            "version": 3,
        }))
        .expect("frontend payload deserializes as a patch")
    }

    /// The regression test for the analytics bug: a settings save must not cost
    /// the install its telemetry identity. Before `AppStatePatch`, `save_app_state`
    /// did `*guard = payload` and this id became `None` on every settings change,
    /// so the next launch minted a new PostHog person.
    #[test]
    fn apply_patch_preserves_telemetry_anon_id() {
        let mut state = AppState {
            telemetry_anon_id: Some("device-uuid".into()),
            ..AppState::default()
        };

        state.apply_patch(frontend_payload());

        assert_eq!(state.telemetry_anon_id.as_deref(), Some("device-uuid"));
        // ...while the frontend-owned half really was applied.
        assert!(!state.settings.share_telemetry);
    }

    /// A patch with unknown/extra keys (an older or newer frontend) still parses,
    /// and absent keys fall back to their defaults rather than failing the save.
    #[test]
    fn patch_tolerates_partial_payloads() {
        let patch: AppStatePatch =
            serde_json::from_value(serde_json::json!({ "recentProjects": [] }))
                .expect("partial payload");
        let mut state = AppState {
            telemetry_anon_id: Some("keep-me".into()),
            ..AppState::default()
        };
        state.apply_patch(patch);
        assert_eq!(state.telemetry_anon_id.as_deref(), Some("keep-me"));
        assert_eq!(state.version, SCHEMA_VERSION);
    }

    /// The retired built-in toggle is gone from `AppSettings` (ADR-0002:
    /// nothing ships that can be switched off), but a user's `state.json` may
    /// still carry the key. Their OTHER settings must survive it.
    ///
    /// `enter_to_send` is the probe precisely because its default is `true`:
    /// reading `false` back proves the file was parsed, not that `load` fell
    /// through to `AppState::default()` — which is what a strict deserializer
    /// would have done, silently resetting every setting the user had.
    #[test]
    fn a_retired_key_in_state_json_does_not_reset_the_other_settings() {
        let state: AppState = serde_json::from_value(serde_json::json!({
            "settings": { "disabledBuiltinAgents": ["kilo"], "enterToSend": false }
        }))
        .expect("an older state file parses");
        assert!(!state.settings.enter_to_send);
    }
}
