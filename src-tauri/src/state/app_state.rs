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
pub const SCHEMA_VERSION: u32 = 2;

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
    #[serde(default)]
    pub color: Option<String>,
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

impl Default for AppState {
    fn default() -> Self {
        Self {
            current_project: None,
            recent_projects: Vec::new(),
            workspaces: Vec::new(),
            groups: Vec::new(),
            active_workspace_id: None,
            settings: AppSettings::default(),
            telemetry_anon_id: None,
            version: SCHEMA_VERSION,
        }
    }
}

impl AppState {
    /// Migrate a freshly-deserialized v1 payload in place: if no workspaces
    /// exist yet but a legacy `current_project` is present, synthesize a
    /// single workspace from it and make it active. Idempotent — once
    /// `workspaces` is populated this is a no-op.
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
                    color: None,
                    last_active_at: None,
                });
            }
        }
        self.current_project = None;
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
    /// Selected on-device **embedding** model id (== its dir name under
    /// `app_data/models/`). Drives `memory_graph::model_dir` and every embedding
    /// consumer via the shared provider. Switching it wipes + rebuilds the
    /// per-project memory index (different model = different vector space).
    /// See `crate::commands::models`.
    #[serde(default = "default_embedding_model")]
    pub embedding_model_id: String,
    /// Selected on-device **LLM** model id (== its dir name). Drives
    /// `memory_chat::chat_model_dir` (RAG chat generation + code-index summaries).
    #[serde(default = "default_llm_model")]
    pub llm_model_id: String,
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
    /// Show inline Git blame (author · relative time · commit summary) at the
    /// end of the editor's active line, Zed-style. Default ON; when off the
    /// blame extension is left out of the editor entirely (no overhead).
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

/// Default local LLM — the historical `qwen3-0.6b` dir.
pub fn default_llm_model() -> String {
    "qwen3-0.6b".to_string()
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
            embedding_model_id: default_embedding_model(),
            llm_model_id: default_llm_model(),
            code_editor_theme: default_code_editor_theme(),
            atlas_theme: default_atlas_theme(),
            git_blame_inline: true,
            auto_update: true,
            updater_ignored_version: None,
        }
    }
}

/// Thread-safe handle registered as Tauri managed state.
pub type AppStateHandle = Arc<Mutex<AppState>>;

impl AppState {
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
