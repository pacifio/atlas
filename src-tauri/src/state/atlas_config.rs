//! `AtlasConfig` — the human- and agent-editable settings file.
//!
//! Replaces `AppState.settings` (formerly the `settings` object inside
//! `state.json`). Lives at `<app_config_dir>/config.toml`: TOML rather than
//! JSON specifically so the file can carry comments, and so a patch (from the
//! Settings UI or the `atlas-self-configure` skill) can preserve them —
//! `toml_edit` edits the document key-by-key instead of reserializing the
//! whole thing the way a JSON round-trip would.
//!
//! Two representations are kept in sync inside [`ConfigManager`]:
//!   - `document` (`toml_edit::DocumentMut`) — the actual on-disk text,
//!     mutated key-by-key so untouched comments/formatting/unknown keys
//!     survive a patch.
//!   - `effective` ([`AppSettings`]) — the typed, validated snapshot every
//!     other module reads. Derived from `document` by round-tripping through
//!     `toml` (cheap; this file is a few hundred bytes).
//!
//! Validation is all-or-nothing: a candidate document is parsed and validated
//! in full before it ever replaces `effective` or touches disk. A malformed
//! external edit — or a bad patch — never displaces the last-known-good state,
//! and this module never repairs/renames/overwrites a malformed file on its
//! own; [`ConfigManager::reset`] is the sole authorized "recreate defaults"
//! path, and it backs up whatever was there first.
//!
//! Scope (see the issue #64 design record): only the preferences that used to
//! live in `AppState.settings` move here. Telemetry identity (`device.json`),
//! the self-hosted PostHog override (`telemetry.json`), and BYOK (the user's
//! shell profile) are deliberately untouched — their separation from
//! coarse-write settings state already fixed a real bug (see
//! `crate::telemetry::device`) or was never Atlas-owned to begin with.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::{Deserialize, Deserializer, Serialize};
use tauri::{AppHandle, Manager};

/// Schema version of `config.toml` itself — independent of `state.json`'s
/// `AppState::SCHEMA_VERSION`. The two files describe different domains and
/// evolve on their own timelines; coupling them would make "what does version
/// N mean" ambiguous.
pub const CONFIG_SCHEMA_VERSION: u32 = 1;

pub const CONFIG_FILE_NAME: &str = "config.toml";

/// Mirrors `MIN_SCALE`/`MAX_SCALE` in
/// `src/features/settings/lib/ui-scale.ts` — kept in sync manually since the
/// frontend clamp and this validation gate the same field from two ends.
pub const MIN_UI_SCALE: f32 = 0.5;
pub const MAX_UI_SCALE: f32 = 2.0;

// ---------------------------------------------------------------------------
// AppSettings
// ---------------------------------------------------------------------------

/// Adaptive next-step suggestion chips in the agent chat's per-turn card.
/// Strict on the live config file (`agent` | `off` only) — the legacy
/// `"parse"`/`"llm"` values only ever existed in old `state.json` payloads
/// and are normalized to `Agent` once, during migration
/// (see [`adaptive_suggestions_from_legacy`]), not accepted ongoing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AdaptiveSuggestions {
    Agent,
    Off,
}

impl Default for AdaptiveSuggestions {
    fn default() -> Self {
        Self::Agent
    }
}

/// User-facing toggles surfaced in Settings → General. Moved out of
/// `state.json`'s `AppState.settings` (issue #64) into its own validated,
/// human-editable `config.toml`.
///
/// New fields MUST be `#[serde(default = "…")]` or have an obvious zero value
/// so older `config.toml` files (written before the field existed) load
/// cleanly.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
    /// gate this. See `crate::telemetry`.
    #[serde(default = "default_true")]
    pub link_telemetry_to_account: bool,
    /// Selected on-device **embedding** model id (== its dir name under
    /// `app_data/models/`). Drives `memory_graph::model_dir` and every embedding
    /// consumer via the shared provider. See `crate::commands::models`.
    #[serde(default = "default_embedding_model")]
    pub embedding_model_id: String,
    /// Code-editor color theme id (see `src/features/editor/themes`).
    #[serde(default = "default_code_editor_theme")]
    pub code_editor_theme: String,
    /// Atlas interface-theme id (see `src/features/theme/themes`).
    #[serde(default = "default_atlas_theme")]
    pub atlas_theme: String,
    /// "agent" (default) asks the coding agent to end each reply with a hidden
    /// `<next_steps>` block; "off" disables it.
    #[serde(default)]
    pub adaptive_suggestions: AdaptiveSuggestions,
    /// Inline Git blame in the code editor. Default ON; when off the editor
    /// doesn't even load the extension (no blame IPC).
    #[serde(default = "default_true")]
    pub git_blame_inline: bool,
    /// Auto-update master switch. See `crate::commands::updater`.
    #[serde(default = "default_true")]
    pub auto_update: bool,
    /// A version the user chose to "Ignore" in the update prompt. `None` =
    /// nothing ignored. Absent from the TOML file rather than written as a
    /// sentinel empty string — TOML has no native null, and an absent key is
    /// the idiomatic way to express "unset".
    #[serde(default)]
    pub updater_ignored_version: Option<String>,
    /// Chat composer send gesture. Default ON: Enter sends, Shift+Enter
    /// inserts a newline. Cmd/Ctrl+Enter always sends regardless.
    #[serde(default = "default_true")]
    pub enter_to_send: bool,
}

fn default_true() -> bool {
    true
}

pub fn default_code_editor_theme() -> String {
    "atlas".to_string()
}

pub fn default_atlas_theme() -> String {
    "atlas-black".to_string()
}

pub fn default_embedding_model() -> String {
    "all-MiniLM-L6-v2".to_string()
}

pub fn default_ui_scale() -> f32 {
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
            adaptive_suggestions: AdaptiveSuggestions::default(),
            git_blame_inline: true,
            auto_update: true,
            updater_ignored_version: None,
            enter_to_send: true,
        }
    }
}

/// The full set of keys `AppSettings` knows about, in wire (camelCase) form.
/// Used to flag anything else in `[settings]` as an unknown key — preserved
/// on disk and surfaced as a diagnostic, never treated as an error.
const KNOWN_SETTINGS_KEYS: &[&str] = &[
    "autoAddAtlasGitignore",
    "enableAtlasLogs",
    "showHiddenFiles",
    "uiScale",
    "shareTelemetry",
    "linkTelemetryToAccount",
    "embeddingModelId",
    "codeEditorTheme",
    "atlasTheme",
    "adaptiveSuggestions",
    "gitBlameInline",
    "autoUpdate",
    "updaterIgnoredVersion",
    "enterToSend",
];

/// One field failed semantic validation. Structural validation only —
/// deliberately NOT a full theme-id/embedding-model-id catalog membership
/// check: that catalog is frontend-owned (`src/features/theme/themes.ts`,
/// `src/features/editor/themes/themes.ts`) and duplicating it into Rust would
/// create a second place both lists must stay in sync, trading one drift bug
/// (the `adaptiveSuggestions` gap this issue fixes) for another. Garbage
/// (empty/non-finite) is still rejected; an unrecognized-but-well-formed id
/// is accepted and left for the frontend to fall back on, same as it does
/// today for a theme id from a newer Atlas version.
#[derive(Debug, Clone, PartialEq)]
pub struct ValidationIssue {
    pub key: &'static str,
    pub message: String,
}

pub fn validate(settings: &AppSettings) -> Result<(), ValidationIssue> {
    if !settings.ui_scale.is_finite()
        || settings.ui_scale < MIN_UI_SCALE
        || settings.ui_scale > MAX_UI_SCALE
    {
        return Err(ValidationIssue {
            key: "uiScale",
            message: format!(
                "must be a finite number between {MIN_UI_SCALE} and {MAX_UI_SCALE}, got {}",
                settings.ui_scale
            ),
        });
    }
    if settings.embedding_model_id.trim().is_empty() {
        return Err(ValidationIssue {
            key: "embeddingModelId",
            message: "must not be empty".to_string(),
        });
    }
    if settings.code_editor_theme.trim().is_empty() {
        return Err(ValidationIssue {
            key: "codeEditorTheme",
            message: "must not be empty".to_string(),
        });
    }
    if settings.atlas_theme.trim().is_empty() {
        return Err(ValidationIssue {
            key: "atlasTheme",
            message: "must not be empty".to_string(),
        });
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// On-disk document shape
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AtlasConfigFile {
    #[serde(default = "default_config_schema_version")]
    schema_version: u32,
    #[serde(default)]
    settings: AppSettings,
}

fn default_config_schema_version() -> u32 {
    CONFIG_SCHEMA_VERSION
}

fn unknown_keys_in(document: &toml_edit::DocumentMut) -> Vec<String> {
    let Some(table) = document.get("settings").and_then(|i| i.as_table()) else {
        return Vec::new();
    };
    table
        .iter()
        .map(|(k, _)| k.to_string())
        .filter(|k| !KNOWN_SETTINGS_KEYS.contains(&k.as_str()))
        .collect()
}

fn document_for(settings: &AppSettings) -> toml_edit::DocumentMut {
    let file = AtlasConfigFile { schema_version: CONFIG_SCHEMA_VERSION, settings: settings.clone() };
    let text = toml::to_string_pretty(&file).expect("AppSettings always serializes to TOML");
    text.parse().expect("freshly-generated TOML always parses")
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum ConfigError {
    Io(String),
    Parse(String),
    Invalid(ValidationIssue),
    UnsupportedVersion(u32),
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfigError::Io(e) => write!(f, "{e}"),
            ConfigError::Parse(e) => write!(f, "config.toml is not valid TOML: {e}"),
            ConfigError::Invalid(issue) => {
                write!(f, "config.toml: `{}` {}", issue.key, issue.message)
            }
            ConfigError::UnsupportedVersion(v) => write!(
                f,
                "config.toml has schemaVersion {v}, newer than this Atlas build supports ({CONFIG_SCHEMA_VERSION}) — it was likely created by a newer Atlas version"
            ),
        }
    }
}

impl std::error::Error for ConfigError {}

// ---------------------------------------------------------------------------
// Patch (partial update from the UI, the self-configure skill's writes go
// straight to disk and are picked up by the watcher instead of this path)
// ---------------------------------------------------------------------------

/// Deserializes a JSON field into `Option<Option<T>>`: key absent stays
/// `None` (untouched, via `#[serde(default)]` on the field), key present
/// (even as `null`) becomes `Some(inner)`. A plain `Option<T>` can't tell
/// "don't touch this field" apart from "clear it" — both arrive as an absent
/// key vs. `null` on the wire, but `#[serde(default)]` alone collapses both
/// to `None`. Only used for `updater_ignored_version`, the one field where
/// clearing (`Some(None)`) is a real, distinct action from leaving it alone.
fn deserialize_double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Some(Option::deserialize(deserializer)?))
}

/// A partial settings update — every field optional so a UI/skill edit can
/// touch exactly the key it means to change, leaving everything else (and
/// its comments/formatting) alone.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub auto_add_atlas_gitignore: Option<bool>,
    pub enable_atlas_logs: Option<bool>,
    pub show_hidden_files: Option<bool>,
    pub ui_scale: Option<f32>,
    pub share_telemetry: Option<bool>,
    pub link_telemetry_to_account: Option<bool>,
    pub embedding_model_id: Option<String>,
    pub code_editor_theme: Option<String>,
    pub atlas_theme: Option<String>,
    pub adaptive_suggestions: Option<AdaptiveSuggestions>,
    pub git_blame_inline: Option<bool>,
    pub auto_update: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub updater_ignored_version: Option<Option<String>>,
    pub enter_to_send: Option<bool>,
}

impl SettingsPatch {
    fn apply_to(&self, settings: &mut AppSettings) {
        if let Some(v) = self.auto_add_atlas_gitignore {
            settings.auto_add_atlas_gitignore = v;
        }
        if let Some(v) = self.enable_atlas_logs {
            settings.enable_atlas_logs = v;
        }
        if let Some(v) = self.show_hidden_files {
            settings.show_hidden_files = v;
        }
        if let Some(v) = self.ui_scale {
            settings.ui_scale = v;
        }
        if let Some(v) = self.share_telemetry {
            settings.share_telemetry = v;
        }
        if let Some(v) = self.link_telemetry_to_account {
            settings.link_telemetry_to_account = v;
        }
        if let Some(v) = &self.embedding_model_id {
            settings.embedding_model_id = v.clone();
        }
        if let Some(v) = &self.code_editor_theme {
            settings.code_editor_theme = v.clone();
        }
        if let Some(v) = &self.atlas_theme {
            settings.atlas_theme = v.clone();
        }
        if let Some(v) = self.adaptive_suggestions {
            settings.adaptive_suggestions = v;
        }
        if let Some(v) = self.git_blame_inline {
            settings.git_blame_inline = v;
        }
        if let Some(v) = self.auto_update {
            settings.auto_update = v;
        }
        if let Some(v) = &self.updater_ignored_version {
            settings.updater_ignored_version = v.clone();
        }
        if let Some(v) = self.enter_to_send {
            settings.enter_to_send = v;
        }
    }

    /// Mutate only the touched keys of `doc["settings"]` — everything else
    /// (comments, ordering, unknown keys, untouched values) is left exactly
    /// as `toml_edit` parsed it.
    fn write_into(&self, doc: &mut toml_edit::DocumentMut) {
        if doc.get("settings").and_then(|i| i.as_table()).is_none() {
            doc["settings"] = toml_edit::Item::Table(toml_edit::Table::new());
        }
        let table = doc["settings"].as_table_mut().expect("just ensured settings is a table");

        macro_rules! set_bool {
            ($field:ident, $key:literal) => {
                if let Some(v) = self.$field {
                    table[$key] = toml_edit::value(v);
                }
            };
        }
        set_bool!(auto_add_atlas_gitignore, "autoAddAtlasGitignore");
        set_bool!(enable_atlas_logs, "enableAtlasLogs");
        set_bool!(show_hidden_files, "showHiddenFiles");
        set_bool!(share_telemetry, "shareTelemetry");
        set_bool!(link_telemetry_to_account, "linkTelemetryToAccount");
        set_bool!(git_blame_inline, "gitBlameInline");
        set_bool!(auto_update, "autoUpdate");
        set_bool!(enter_to_send, "enterToSend");

        if let Some(v) = self.ui_scale {
            table["uiScale"] = toml_edit::value(f64::from(v));
        }
        if let Some(v) = &self.embedding_model_id {
            table["embeddingModelId"] = toml_edit::value(v.as_str());
        }
        if let Some(v) = &self.code_editor_theme {
            table["codeEditorTheme"] = toml_edit::value(v.as_str());
        }
        if let Some(v) = &self.atlas_theme {
            table["atlasTheme"] = toml_edit::value(v.as_str());
        }
        if let Some(v) = self.adaptive_suggestions {
            let s = match v {
                AdaptiveSuggestions::Agent => "agent",
                AdaptiveSuggestions::Off => "off",
            };
            table["adaptiveSuggestions"] = toml_edit::value(s);
        }
        if let Some(inner) = &self.updater_ignored_version {
            match inner {
                Some(v) => table["updaterIgnoredVersion"] = toml_edit::value(v.as_str()),
                None => {
                    table.remove("updaterIgnoredVersion");
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Legacy migration (state.json.settings -> config.toml, one time)
// ---------------------------------------------------------------------------

/// Legacy `state.json` carried `adaptiveSuggestions` values from before it was
/// a closed enum (`"parse"`, `"llm"`) — both meant "on" under the old
/// free-form implementation. Anything except an exact `"off"` normalizes to
/// `Agent`, matching that prior behavior; a missing/absent value also
/// defaults to `Agent`, same as [`AppSettings::default`].
fn adaptive_suggestions_from_legacy(raw: Option<&serde_json::Value>) -> AdaptiveSuggestions {
    match raw.and_then(|v| v.as_str()) {
        Some("off") => AdaptiveSuggestions::Off,
        _ => AdaptiveSuggestions::Agent,
    }
}

/// Extract an `AppSettings` from the raw JSON `settings` object of a legacy
/// `state.json` (i.e. `AppState.settings` before it was removed). Field-by-
/// field with a default fallback, deliberately not a single
/// `serde_json::from_value::<AppSettings>` — that would hard-fail the whole
/// struct the moment it hit the old free-form `adaptiveSuggestions` string,
/// discarding every other perfectly-good legacy value along with it.
pub fn settings_from_legacy_json(raw: Option<&serde_json::Value>) -> AppSettings {
    let mut settings = AppSettings::default();
    let Some(raw) = raw else {
        return settings;
    };

    macro_rules! take_bool {
        ($field:ident, $key:literal) => {
            if let Some(v) = raw.get($key).and_then(serde_json::Value::as_bool) {
                settings.$field = v;
            }
        };
    }
    take_bool!(auto_add_atlas_gitignore, "autoAddAtlasGitignore");
    take_bool!(enable_atlas_logs, "enableAtlasLogs");
    take_bool!(show_hidden_files, "showHiddenFiles");
    take_bool!(share_telemetry, "shareTelemetry");
    take_bool!(link_telemetry_to_account, "linkTelemetryToAccount");
    take_bool!(git_blame_inline, "gitBlameInline");
    take_bool!(auto_update, "autoUpdate");
    take_bool!(enter_to_send, "enterToSend");

    if let Some(v) = raw.get("uiScale").and_then(serde_json::Value::as_f64) {
        let v = v as f32;
        if v.is_finite() && (MIN_UI_SCALE..=MAX_UI_SCALE).contains(&v) {
            settings.ui_scale = v;
        }
    }
    if let Some(v) = raw.get("embeddingModelId").and_then(serde_json::Value::as_str) {
        if !v.trim().is_empty() {
            settings.embedding_model_id = v.to_string();
        }
    }
    if let Some(v) = raw.get("codeEditorTheme").and_then(serde_json::Value::as_str) {
        if !v.trim().is_empty() {
            settings.code_editor_theme = v.to_string();
        }
    }
    if let Some(v) = raw.get("atlasTheme").and_then(serde_json::Value::as_str) {
        if !v.trim().is_empty() {
            settings.atlas_theme = v.to_string();
        }
    }
    if let Some(v) = raw.get("updaterIgnoredVersion").and_then(serde_json::Value::as_str) {
        settings.updater_ignored_version = Some(v.to_string());
    }
    settings.adaptive_suggestions = adaptive_suggestions_from_legacy(raw.get("adaptiveSuggestions"));

    settings
}

// ---------------------------------------------------------------------------
// ConfigManager
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum ConfigStatus {
    Ok,
    /// A hot-reload (external edit) failed; `effective` still holds the
    /// previous, in-process-validated settings.
    UsingLastKnownGood { error: String },
    /// Cold start found no valid file (missing or malformed); `effective` is
    /// `AppSettings::default()`. The malformed file, if any, is left
    /// untouched on disk.
    UsingDefaults { error: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSnapshot {
    pub settings: AppSettings,
    pub generation: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum UpdateOutcome {
    /// The patch applied and was persisted.
    Applied { settings: AppSettings, generation: u64 },
    /// `expected_generation` was stale — nothing was written. `settings`
    /// carries what's actually on disk now so the caller can reconcile.
    Conflict { settings: AppSettings, generation: u64 },
}

#[derive(Debug)]
pub struct ConfigManager {
    path: PathBuf,
    document: toml_edit::DocumentMut,
    effective: AppSettings,
    /// Raw bytes of the last content this manager itself considers current —
    /// used both to dedup the file watcher's self-write echo and as the base
    /// a patch re-reads before merging.
    last_raw: String,
    generation: u64,
    status: ConfigStatus,
    unknown_keys: Vec<String>,
}

impl ConfigManager {
    pub fn config_path(app: &AppHandle) -> Option<PathBuf> {
        app.path().app_config_dir().ok().map(|d| d.join(CONFIG_FILE_NAME))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn effective(&self) -> &AppSettings {
        &self.effective
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn status(&self) -> &ConfigStatus {
        &self.status
    }

    pub fn unknown_keys(&self) -> &[String] {
        &self.unknown_keys
    }

    fn in_memory_defaults(path: PathBuf) -> Self {
        let settings = AppSettings::default();
        let document = document_for(&settings);
        Self {
            path,
            document,
            effective: settings,
            last_raw: String::new(),
            generation: 0,
            status: ConfigStatus::Ok,
            unknown_keys: Vec::new(),
        }
    }

    fn from_raw(path: PathBuf, raw: &str) -> Result<Self, ConfigError> {
        let document: toml_edit::DocumentMut =
            raw.parse().map_err(|e: toml_edit::TomlError| ConfigError::Parse(e.to_string()))?;
        let text = document.to_string();
        let file: AtlasConfigFile =
            toml::from_str(&text).map_err(|e| ConfigError::Parse(e.to_string()))?;
        if file.schema_version > CONFIG_SCHEMA_VERSION {
            return Err(ConfigError::UnsupportedVersion(file.schema_version));
        }
        validate(&file.settings).map_err(ConfigError::Invalid)?;
        let unknown_keys = unknown_keys_in(&document);
        Ok(Self {
            path,
            document,
            effective: file.settings,
            last_raw: raw.to_string(),
            generation: 0,
            status: ConfigStatus::Ok,
            unknown_keys,
        })
    }

    /// Cold-start entry point: read whatever is on disk (or nothing) and
    /// return a manager whose `effective` is always immediately usable.
    /// Never blocks boot — malformed or missing content degrades to
    /// `AppSettings::default()`, exactly like `AppState::load`'s existing
    /// `unwrap_or_default()` behavior for `state.json`.
    pub fn load(app: &AppHandle) -> Self {
        let Some(path) = Self::config_path(app) else {
            return Self::in_memory_defaults(PathBuf::from(CONFIG_FILE_NAME));
        };
        Self::load_at(path)
    }

    /// The path-only half of `load` — split out so `bootstrap_at` (and its
    /// tests) can exercise the real cold-start behavior without needing a
    /// live `AppHandle`/`app_config_dir` to resolve a path from.
    fn load_at(path: PathBuf) -> Self {
        match fs::read_to_string(&path) {
            Ok(raw) => Self::from_raw(path.clone(), &raw).unwrap_or_else(|e| {
                tracing::warn!(
                    target: "atlas::config",
                    "config.toml invalid at cold start, serving defaults in memory (file left untouched): {e}"
                );
                let mut mgr = Self::in_memory_defaults(path);
                mgr.status = ConfigStatus::UsingDefaults { error: e.to_string() };
                mgr
            }),
            // File genuinely absent — the normal pre-first-write state, not
            // an error. `bootstrap` below is what decides whether that's
            // "needs migration" or "already migrated, stay on defaults".
            Err(_) => Self::in_memory_defaults(path),
        }
    }

    /// Re-read disk. `Ok(true)` = adopted new (different, valid) content,
    /// `Ok(false)` = unchanged or the file doesn't exist, `Err` = the file is
    /// malformed. On the error path, `effective`/`document`/`last_raw` are
    /// left completely untouched — that's what stops a bad external edit
    /// from ever reaching them — but `status` DOES move to
    /// `UsingLastKnownGood` so callers (the Settings UI, `get_atlas_config_info`)
    /// can see that the on-disk file is currently broken even though the
    /// in-memory settings are still the last good ones.
    pub fn reload_from_disk(&mut self) -> Result<bool, ConfigError> {
        let raw = match fs::read_to_string(&self.path) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(ConfigError::Io(e.to_string())),
        };
        if raw == self.last_raw {
            return Ok(false);
        }
        let fresh = match Self::from_raw(self.path.clone(), &raw) {
            Ok(fresh) => fresh,
            Err(e) => {
                self.status = ConfigStatus::UsingLastKnownGood { error: e.to_string() };
                return Err(e);
            }
        };
        self.document = fresh.document;
        self.effective = fresh.effective;
        self.last_raw = fresh.last_raw;
        self.unknown_keys = fresh.unknown_keys;
        self.generation += 1;
        self.status = ConfigStatus::Ok;
        Ok(true)
    }

    /// Apply a partial update. Always re-reads disk first (closing the race
    /// between an external edit and this write); rejects outright rather than
    /// clobbering if that re-read finds a malformed file.
    ///
    /// `expected_generation`: `None` for internal Rust-side callers
    /// (`commands::updater`, `commands::models`) that only ever race the
    /// filesystem, never a second in-app editor — always applies, matching
    /// their pre-existing last-write-wins semantics against the old
    /// `AppStateHandle` mutex. `Some(g)` for the IPC command, which enforces
    /// the optimistic check against a UI that may be editing a stale
    /// snapshot.
    pub fn apply_patch(
        &mut self,
        patch: &SettingsPatch,
        expected_generation: Option<u64>,
    ) -> Result<UpdateOutcome, ConfigError> {
        self.reload_from_disk()?;

        if let Some(expected) = expected_generation {
            if expected != self.generation {
                return Ok(UpdateOutcome::Conflict {
                    settings: self.effective.clone(),
                    generation: self.generation,
                });
            }
        }

        let mut candidate = self.effective.clone();
        patch.apply_to(&mut candidate);
        validate(&candidate).map_err(ConfigError::Invalid)?;

        let mut doc = self.document.clone();
        patch.write_into(&mut doc);
        doc["schemaVersion"] = toml_edit::value(i64::from(CONFIG_SCHEMA_VERSION));

        let text = doc.to_string();
        write_atomic(&self.path, &text).map_err(|e| ConfigError::Io(e.to_string()))?;

        self.document = doc;
        self.unknown_keys = unknown_keys_in(&self.document);
        self.effective = candidate.clone();
        self.last_raw = text;
        self.generation += 1;
        self.status = ConfigStatus::Ok;

        Ok(UpdateOutcome::Applied { settings: candidate, generation: self.generation })
    }

    /// The sole path allowed to overwrite a malformed (or just unwanted)
    /// file: back up whatever is currently on disk, then atomically write
    /// fresh defaults.
    pub fn reset(&mut self) -> Result<ConfigSnapshot, ConfigError> {
        if let Ok(existing) = fs::read_to_string(&self.path) {
            let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            let backup = self.path.with_file_name(format!("{CONFIG_FILE_NAME}.bak-{stamp}"));
            let _ = fs::write(&backup, existing);
        }
        let settings = AppSettings::default();
        let document = document_for(&settings);
        let text = document.to_string();
        write_atomic(&self.path, &text).map_err(|e| ConfigError::Io(e.to_string()))?;

        self.document = document;
        self.effective = settings.clone();
        self.last_raw = text;
        self.generation += 1;
        self.status = ConfigStatus::Ok;
        self.unknown_keys.clear();

        Ok(ConfigSnapshot { settings, generation: self.generation })
    }

    /// Write a specific `AppSettings` as a brand-new file (migration's entry
    /// point — there is no existing document to preserve yet).
    fn create_fresh_with(path: PathBuf, settings: AppSettings) -> Result<Self, ConfigError> {
        let document = document_for(&settings);
        let text = document.to_string();
        write_atomic(&path, &text).map_err(|e| ConfigError::Io(e.to_string()))?;
        Ok(Self {
            path,
            document,
            effective: settings,
            last_raw: text,
            generation: 0,
            status: ConfigStatus::Ok,
            unknown_keys: Vec::new(),
        })
    }
}

/// Atomic write: a unique temp file in the same directory (so distinct UI
/// writes, migration, and any external tooling can never collide on one
/// fixed `.tmp` name), flushed then renamed over the target.
fn write_atomic(path: &Path, contents: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| CONFIG_FILE_NAME.to_string());
    let unique = format!("{file_name}.tmp.{}", uuid::Uuid::new_v4());
    let tmp = path.with_file_name(unique);
    fs::write(&tmp, contents)?;
    fs::rename(&tmp, path)
}

/// Thread-safe handle registered as Tauri managed state, mirroring
/// `AppStateHandle`'s shape.
pub type AtlasConfigHandle = Arc<Mutex<ConfigManager>>;

/// Convenience read for call sites that only need the current settings
/// snapshot (e.g. gating a background task at startup, or the Local Model
/// Manager checking the selected embedding model).
pub fn read(app: &AppHandle) -> AppSettings {
    app.state::<AtlasConfigHandle>().lock().effective().clone()
}

/// Apply a patch from Rust-internal code — e.g. the Local Model Manager
/// persisting a model switch, or the updater persisting an ignored version.
/// Always applies (no optimistic `expected_generation` check, so this never
/// returns `Conflict`): these callers only ever race the filesystem, never a
/// second in-app editor, matching the pre-#64 last-write-wins semantics
/// against the old `AppStateHandle` mutex.
///
/// Returns the committed snapshot (settings + generation) rather than just
/// `AppSettings` so the caller can hand both to
/// `commands::atlas_config::notify_settings_changed` — without that, an
/// internal write bumps `ConfigManager`'s generation on disk but the
/// frontend's mirrored `configGeneration` goes stale, and the live telemetry
/// gate (`TelemetryClient::enabled`) never re-syncs to a changed
/// `shareTelemetry`.
pub fn update(app: &AppHandle, patch: SettingsPatch) -> Result<ConfigSnapshot, ConfigError> {
    let handle = app.state::<AtlasConfigHandle>();
    let mut guard = handle.lock();
    match guard.apply_patch(&patch, None)? {
        UpdateOutcome::Applied { settings, generation }
        | UpdateOutcome::Conflict { settings, generation } => Ok(ConfigSnapshot { settings, generation }),
    }
}

/// Startup orchestration: decide whether `config.toml` needs to be created
/// from a legacy `state.json.settings`, and return the manager either way.
///
/// `marker_already_set` is `AppState`'s `settings_config_migrated` flag (v4).
/// It exists because "does `config.toml` exist" is NOT the same question as
/// "has migration already happened" — a user can delete `config.toml` on
/// purpose after migrating, and this must never resurrect the old
/// `state.json` settings when that happens. The marker is what tells those
/// two cases apart.
pub struct MigrationOutcome {
    pub manager: ConfigManager,
    /// Whether the caller should persist `settings_config_migrated = true`
    /// into `state.json` (v4) after this call. Always `true` once this
    /// returns — either the config already existed, or it was just created —
    /// the only remaining question is whether the *caller* still needs to
    /// write that fact down.
    pub mark_migrated: bool,
}

pub fn bootstrap(
    app: &AppHandle,
    marker_already_set: bool,
    legacy_settings_raw: Option<serde_json::Value>,
) -> MigrationOutcome {
    let Some(path) = ConfigManager::config_path(app) else {
        return MigrationOutcome { manager: ConfigManager::load(app), mark_migrated: false };
    };
    bootstrap_at(path, marker_already_set, legacy_settings_raw)
}

/// The actual migration decision, split out from `bootstrap` so it's
/// testable against a real temp-dir path without needing a live `AppHandle`
/// to resolve one from — `ConfigManager::config_path` requires a running
/// Tauri app, which `#[cfg(test)]` here has no way to construct.
fn bootstrap_at(
    path: PathBuf,
    marker_already_set: bool,
    legacy_settings_raw: Option<serde_json::Value>,
) -> MigrationOutcome {
    if path.exists() {
        // Config already exists — never merge stale `state.json` settings
        // into it, whether this is the first time we've seen it (a v3->v4
        // upgrade that lands after a user hand-authored config.toml, or a
        // manual restore) or the Nth.
        return MigrationOutcome { manager: ConfigManager::load_at(path), mark_migrated: true };
    }

    // No file yet. Import from legacy state exactly once, ever.
    let settings = if marker_already_set {
        AppSettings::default()
    } else {
        settings_from_legacy_json(legacy_settings_raw.as_ref())
    };

    match ConfigManager::create_fresh_with(path.clone(), settings) {
        Ok(manager) => MigrationOutcome { manager, mark_migrated: true },
        Err(e) => {
            tracing::warn!(target: "atlas::config", "failed to write migrated config.toml: {e}");
            MigrationOutcome { manager: ConfigManager::load_at(path), mark_migrated: false }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh `config.toml` path inside its own temp directory, so parallel
    /// tests never collide and `write_atomic`'s `create_dir_all` has
    /// somewhere real to write the sibling `.tmp.<uuid>` file.
    fn tmp_config_path() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("atlas-config-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir.join(CONFIG_FILE_NAME)
    }

    #[test]
    fn defaults_pass_validation() {
        assert!(validate(&AppSettings::default()).is_ok());
    }

    #[test]
    fn missing_keys_fall_back_to_defaults() {
        let path = tmp_config_path();
        let raw = "schemaVersion = 1\n\n[settings]\nenterToSend = false\n";
        let mgr = ConfigManager::from_raw(path, raw).expect("partial file parses");
        assert!(!mgr.effective().enter_to_send);
        // Every other field is absent from the file — must be the compiled default.
        assert_eq!(mgr.effective().atlas_theme, default_atlas_theme());
        assert_eq!(mgr.effective().ui_scale, default_ui_scale());
        assert!(mgr.effective().auto_update);
    }

    #[test]
    fn file_missing_entirely_serves_defaults_without_error() {
        let dir = std::env::temp_dir().join(format!("atlas-config-test-{}", uuid::Uuid::new_v4()));
        // Deliberately do NOT create the dir/file.
        let path = dir.join(CONFIG_FILE_NAME);
        let mgr = ConfigManager::in_memory_defaults(path);
        assert_eq!(mgr.status(), &ConfigStatus::Ok);
        assert_eq!(mgr.effective(), &AppSettings::default());
    }

    #[test]
    fn patch_preserves_comments_and_unknown_keys() {
        let path = tmp_config_path();
        let raw = "\
# a user's own comment, must survive every patch
schemaVersion = 1

[settings]
enterToSend = true
someFutureKey = \"left alone\"
";
        fs::write(&path, raw).unwrap();
        let mut mgr = ConfigManager::from_raw(path.clone(), raw).unwrap();
        assert_eq!(mgr.unknown_keys(), &["someFutureKey".to_string()]);

        let patch = SettingsPatch { enter_to_send: Some(false), ..Default::default() };
        let outcome = mgr.apply_patch(&patch, None).expect("patch applies");
        match outcome {
            UpdateOutcome::Applied { settings, generation } => {
                assert!(!settings.enter_to_send);
                assert_eq!(generation, 1);
            }
            UpdateOutcome::Conflict { .. } => panic!("no expected_generation was given"),
        }

        let on_disk = fs::read_to_string(&path).unwrap();
        assert!(on_disk.contains("# a user's own comment, must survive every patch"));
        assert!(on_disk.contains("someFutureKey = \"left alone\""));
        assert!(on_disk.contains("enterToSend = false"));
    }

    #[test]
    fn invalid_ui_scale_is_rejected_and_does_not_touch_disk() {
        let path = tmp_config_path();
        let raw = "schemaVersion = 1\n\n[settings]\nenterToSend = true\n";
        fs::write(&path, raw).unwrap();
        let mut mgr = ConfigManager::from_raw(path.clone(), raw).unwrap();

        let patch = SettingsPatch { ui_scale: Some(99.0), ..Default::default() };
        let err = mgr.apply_patch(&patch, None).expect_err("out-of-range scale must be rejected");
        assert!(matches!(err, ConfigError::Invalid(ref issue) if issue.key == "uiScale"));

        // Untouched: neither in-memory nor on disk.
        assert_eq!(mgr.effective().ui_scale, default_ui_scale());
        assert_eq!(fs::read_to_string(&path).unwrap(), raw);
    }

    #[test]
    fn unsupported_future_schema_version_is_rejected() {
        let path = tmp_config_path();
        let raw = "schemaVersion = 99\n\n[settings]\n";
        let err = ConfigManager::from_raw(path, raw).expect_err("future schema must be rejected");
        assert_eq!(err, ConfigError::UnsupportedVersion(99));
    }

    #[test]
    fn malformed_syntax_at_cold_start_serves_defaults_and_leaves_file_alone() {
        let path = tmp_config_path();
        let raw = "this is not [ valid toml";
        fs::write(&path, raw).unwrap();

        // `ConfigManager::load` needs a real AppHandle, so exercise the same
        // fallback it uses directly against `from_raw`.
        let err = ConfigManager::from_raw(path.clone(), raw).expect_err("garbage TOML must error");
        assert!(matches!(err, ConfigError::Parse(_)));
        // The malformed file itself is never touched by a failed parse.
        assert_eq!(fs::read_to_string(&path).unwrap(), raw);
    }

    #[test]
    fn malformed_external_edit_is_rejected_and_last_known_good_survives() {
        let path = tmp_config_path();
        let good = "schemaVersion = 1\n\n[settings]\nenterToSend = true\n";
        fs::write(&path, good).unwrap();
        let mut mgr = ConfigManager::from_raw(path.clone(), good).unwrap();

        // Simulate an external editor leaving the file mid-save / broken.
        fs::write(&path, "not toml at all {{{").unwrap();

        let patch = SettingsPatch { enter_to_send: Some(false), ..Default::default() };
        let err = mgr.apply_patch(&patch, None).expect_err("must refuse to write over a malformed file");
        assert!(matches!(err, ConfigError::Parse(_)));
        // In-memory last-known-good is untouched.
        assert!(mgr.effective().enter_to_send);
        // The malformed file was never overwritten by the rejected patch.
        assert_eq!(fs::read_to_string(&path).unwrap(), "not toml at all {{{");
        // But the status now reflects the on-disk file being broken.
        assert!(matches!(mgr.status(), ConfigStatus::UsingLastKnownGood { .. }));
    }

    #[test]
    fn stale_generation_reports_conflict_without_writing() {
        let path = tmp_config_path();
        let raw = "schemaVersion = 1\n\n[settings]\nenterToSend = true\n";
        fs::write(&path, raw).unwrap();
        let mut mgr = ConfigManager::from_raw(path.clone(), raw).unwrap();

        let patch = SettingsPatch { enter_to_send: Some(false), ..Default::default() };
        let outcome = mgr.apply_patch(&patch, Some(mgr.generation() + 1)).expect("conflict is not an error");
        match outcome {
            UpdateOutcome::Conflict { settings, generation } => {
                assert!(settings.enter_to_send); // unchanged
                assert_eq!(generation, mgr.generation());
            }
            UpdateOutcome::Applied { .. } => panic!("stale generation must not apply"),
        }
        assert_eq!(fs::read_to_string(&path).unwrap(), raw);
    }

    #[test]
    fn reload_from_disk_dedups_identical_content() {
        let path = tmp_config_path();
        let raw = "schemaVersion = 1\n\n[settings]\nenterToSend = true\n";
        fs::write(&path, raw).unwrap();
        let mut mgr = ConfigManager::from_raw(path, raw).unwrap();
        let gen_before = mgr.generation();
        assert_eq!(mgr.reload_from_disk().unwrap(), false);
        assert_eq!(mgr.generation(), gen_before);
    }

    #[test]
    fn reset_backs_up_and_rewrites_defaults() {
        let path = tmp_config_path();
        let raw = "schemaVersion = 1\n\n[settings]\nenterToSend = false\n";
        fs::write(&path, raw).unwrap();
        let mut mgr = ConfigManager::from_raw(path.clone(), raw).unwrap();

        let snapshot = mgr.reset().expect("reset always succeeds");
        assert_eq!(snapshot.settings, AppSettings::default());
        assert_eq!(fs::read_to_string(&path).unwrap(), mgr.last_raw);

        // A backup of the pre-reset content exists somewhere alongside it.
        let dir = path.parent().unwrap();
        let has_backup = fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().starts_with("config.toml.bak-"));
        assert!(has_backup, "reset() must back up the previous file before overwriting");
    }

    #[test]
    fn legacy_migration_extracts_known_fields() {
        let legacy = serde_json::json!({
            "enterToSend": false,
            "atlasTheme": "custom-theme",
            "uiScale": 1.5,
        });
        let settings = settings_from_legacy_json(Some(&legacy));
        assert!(!settings.enter_to_send);
        assert_eq!(settings.atlas_theme, "custom-theme");
        assert_eq!(settings.ui_scale, 1.5);
        // Untouched fields keep their compiled defaults.
        assert!(settings.auto_update);
    }

    #[test]
    fn legacy_migration_normalizes_parse_and_llm_to_agent() {
        for legacy_value in ["parse", "llm", "agent", "anything-else"] {
            let legacy = serde_json::json!({ "adaptiveSuggestions": legacy_value });
            let settings = settings_from_legacy_json(Some(&legacy));
            assert_eq!(settings.adaptive_suggestions, AdaptiveSuggestions::Agent, "value: {legacy_value}");
        }
        let legacy = serde_json::json!({ "adaptiveSuggestions": "off" });
        assert_eq!(settings_from_legacy_json(Some(&legacy)).adaptive_suggestions, AdaptiveSuggestions::Off);
    }

    #[test]
    fn legacy_migration_defaults_missing_adaptive_to_agent() {
        let settings = settings_from_legacy_json(None);
        assert_eq!(settings.adaptive_suggestions, AdaptiveSuggestions::Agent);
    }

    #[test]
    fn legacy_migration_ignores_out_of_range_ui_scale() {
        let legacy = serde_json::json!({ "uiScale": 99.0 });
        let settings = settings_from_legacy_json(Some(&legacy));
        assert_eq!(settings.ui_scale, default_ui_scale());
    }

    // ── bootstrap_at (migration orchestration) ──────────────────────────

    #[test]
    fn bootstrap_first_run_imports_legacy_settings_and_marks_migrated() {
        let path = tmp_config_path();
        let legacy = serde_json::json!({ "enterToSend": false, "atlasTheme": "custom" });

        let outcome = bootstrap_at(path.clone(), false, Some(legacy));

        assert!(outcome.mark_migrated);
        assert!(!outcome.manager.effective().enter_to_send);
        assert_eq!(outcome.manager.effective().atlas_theme, "custom");
        assert!(path.exists(), "bootstrap must actually write config.toml on first run");
    }

    #[test]
    fn bootstrap_never_reimports_after_marker_is_set() {
        let path = tmp_config_path();
        let legacy = serde_json::json!({ "enterToSend": false });

        // marker_already_set = true: even though config.toml doesn't exist
        // yet, this must NOT be treated as a first run — the user deleted
        // their config on purpose after already migrating once.
        let outcome = bootstrap_at(path, true, Some(legacy));

        assert!(outcome.mark_migrated);
        assert_eq!(outcome.manager.effective(), &AppSettings::default());
    }

    #[test]
    fn bootstrap_leaves_an_existing_config_untouched_regardless_of_legacy_data() {
        let path = tmp_config_path();
        let raw = "schemaVersion = 1\n\n[settings]\nenterToSend = false\n";
        fs::write(&path, raw).unwrap();
        let legacy = serde_json::json!({ "enterToSend": true, "atlasTheme": "should-never-appear" });

        let outcome = bootstrap_at(path.clone(), false, Some(legacy));

        assert!(outcome.mark_migrated);
        // The existing file wins outright — legacy data is never merged in,
        // not even for keys the existing file didn't set.
        assert!(!outcome.manager.effective().enter_to_send);
        assert_eq!(outcome.manager.effective().atlas_theme, default_atlas_theme());
        assert_eq!(fs::read_to_string(&path).unwrap(), raw, "must not rewrite an existing config.toml");
    }

    #[test]
    fn bootstrap_is_idempotent_across_repeated_calls() {
        let path = tmp_config_path();
        let legacy = serde_json::json!({ "enterToSend": false });

        let first = bootstrap_at(path.clone(), false, Some(legacy.clone()));
        assert!(first.mark_migrated);
        let after_first = fs::read_to_string(&path).unwrap();

        // Simulates the caller persisting `mark_migrated` and the process
        // restarting: same call, but now with the marker set.
        let second = bootstrap_at(path.clone(), true, Some(legacy));
        assert!(second.mark_migrated);
        assert_eq!(fs::read_to_string(&path).unwrap(), after_first, "a second bootstrap must not rewrite the file");
        assert!(!second.manager.effective().enter_to_send);
    }

    // ── Cross-artifact key coverage ──────────────────────────────────────
    //
    // `docs/reference/configuration.md` explicitly claims every schema key
    // appears in both itself and the bundled skill. Compiled in via
    // `include_str!` (not read from disk at test time) so this fails the
    // build the moment either document drifts from `KNOWN_SETTINGS_KEYS`,
    // the same way the rest of this crate's `include_str!`'d resources do.

    const CONFIGURATION_DOC: &str = include_str!("../../../docs/reference/configuration.md");
    const SELF_CONFIGURE_SKILL: &str =
        include_str!("../../resources/skills/atlas-self-configure/SKILL.md");

    #[test]
    fn every_known_setting_key_is_documented_in_the_configuration_reference() {
        for key in KNOWN_SETTINGS_KEYS {
            assert!(CONFIGURATION_DOC.contains(key), "docs/reference/configuration.md is missing `{key}`");
        }
    }

    #[test]
    fn every_known_setting_key_is_covered_by_the_self_configure_skill() {
        for key in KNOWN_SETTINGS_KEYS {
            assert!(
                SELF_CONFIGURE_SKILL.contains(key),
                "the atlas-self-configure SKILL.md is missing `{key}`"
            );
        }
    }
}
