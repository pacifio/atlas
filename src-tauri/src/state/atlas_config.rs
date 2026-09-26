//! `AtlasConfig` — the human- and agent-editable settings file.
//!
//! Replaces `AppState.settings` (formerly the `settings` object inside
//! `state.json`). Lives at `~/.config/atlas/config.toml`: TOML rather than
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
use std::collections::BTreeMap;
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

/// Directory under `~/.config` (or `$XDG_CONFIG_HOME`) holding
/// [`CONFIG_FILE_NAME`]. Named for the product, not the bundle id: a path a
/// user types should read `atlas`, not `dev.atlas.ide`.
pub const CONFIG_DIR_NAME: &str = "atlas";

/// How many times [`ConfigManager::apply_patch`] rebuilds its patch when an
/// external write lands inside the merge-then-swap window. Three is enough to
/// ride out an editor's own save (which is itself usually a rename) without
/// letting a runaway writer block the UI indefinitely.
const CAS_ATTEMPTS: usize = 3;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    System,
    Dark,
    Light,
}

impl Default for ThemeMode {
    fn default() -> Self {
        Self::System
    }
}

/// Deserialized by hand (below), not derived: `config.toml` is a file people
/// edit, and one bad override entry must not fail the whole file.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeOverride {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub base: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub palette: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub keys: BTreeMap<String, atlas_theme::ThemeKeyValue>,
}

impl ThemeOverride {
    fn is_empty(&self) -> bool {
        self.base.is_empty() && self.palette.is_empty() && self.keys.is_empty()
    }
}

/// Read `themeOverrides` leniently, the way theme files are read.
///
/// `keys` used to be a plain map of an untagged enum, so the natural TOML
/// spelling `syntax.keyword = "#fff"` — a dotted key, which TOML turns into a
/// nested table — matched neither a colour nor `{ color }`, and the parse
/// error took the WHOLE `config.toml` down with it. Nested tables are now
/// flattened to dotted names exactly as `atlas-theme` flattens a theme's
/// `[keys]`, and anything still unusable — a number, a `font_style`, a value
/// that could break out of the `:root { … }` block the frontend writes it into
/// — is dropped with a warning rather than failing the file.
impl<'de> Deserialize<'de> for ThemeOverride {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = serde_json::Value::deserialize(deserializer)?;
        let mut out = ThemeOverride::default();
        let Some(raw) = raw.as_object() else {
            tracing::warn!(target: "atlas::config", "themeOverrides is not a table; ignored");
            return Ok(out);
        };
        for (section, value) in raw {
            match section.as_str() {
                "base" => out.base = override_strings(value, "base"),
                "palette" => out.palette = override_strings(value, "palette"),
                "keys" => flatten_override_keys(value, "", &mut out.keys),
                other => {
                    tracing::warn!(target: "atlas::config", "themeOverrides.{other} is not base, palette or keys; ignored");
                }
            }
        }
        Ok(out)
    }
}

/// `base` and `palette`: string leaves only, each held to
/// [`atlas_theme::is_safe_css_value`] — the check a theme file's free-text base
/// tokens get. A colour-shaped value always passes it.
fn override_strings(value: &serde_json::Value, section: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let Some(table) = value.as_object() else {
        tracing::warn!(target: "atlas::config", "themeOverrides.{section} is not a table; ignored");
        return out;
    };
    for (key, value) in table {
        match value.as_str().filter(|value| atlas_theme::is_safe_css_value(value)) {
            Some(value) => {
                out.insert(key.clone(), value.to_string());
            }
            None => {
                tracing::warn!(target: "atlas::config", "themeOverrides.{section}.{key} is not a usable CSS value; ignored");
            }
        }
    }
    out
}

fn flatten_override_keys(
    value: &serde_json::Value,
    prefix: &str,
    out: &mut BTreeMap<String, atlas_theme::ThemeKeyValue>,
) {
    let Some(table) = value.as_object() else {
        tracing::warn!(target: "atlas::config", "themeOverrides.keys{prefix} is not a table; ignored");
        return;
    };
    for (key, value) in table {
        let dotted = if prefix.is_empty() { key.clone() } else { format!("{prefix}.{key}") };
        let drop = |why: &str| {
            tracing::warn!(target: "atlas::config", "themeOverrides.keys.{dotted} {why}; ignored");
        };
        match value {
            serde_json::Value::String(color) if atlas_theme::is_safe_css_value(color) => {
                out.insert(dotted, atlas_theme::ThemeKeyValue::Color(color.clone()));
            }
            serde_json::Value::Object(style) if style.contains_key("font_style") => {
                drop("sets font_style, which Atlas does not apply");
            }
            // `{ color = "…" }` and nothing else is the table spelling of one
            // key; any other table is a group of keys, as in a theme file.
            serde_json::Value::Object(style) if style.len() == 1 && style.contains_key("color") => {
                match style["color"].as_str().filter(|color| atlas_theme::is_safe_css_value(color)) {
                    Some(color) => {
                        out.insert(
                            dotted,
                            atlas_theme::ThemeKeyValue::Styled(atlas_theme::ThemeKeyStyle {
                                color: color.to_string(),
                            }),
                        );
                    }
                    None => drop("is not a usable CSS colour"),
                }
            }
            serde_json::Value::Object(_) => flatten_override_keys(value, &dotted, out),
            _ => drop("is not a usable CSS colour"),
        }
    }
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
    /// One theme covers Atlas chrome, editor, terminal, diffs and syntax.
    #[serde(default = "default_theme")]
    pub theme: String,
    /// Whether to follow the OS appearance or request one variant explicitly.
    #[serde(default)]
    pub theme_mode: ThemeMode,
    /// User-local patch applied after the active theme variant.
    #[serde(default, skip_serializing_if = "ThemeOverride::is_empty")]
    pub theme_overrides: ThemeOverride,
    /// The file/folder icon set. Its own track from the colour theme
    /// (decision 4): "minimal" keeps Atlas's lucide icons, and anything else
    /// is a VS Code icon theme — bundled or installed from Open VSX.
    #[serde(default = "default_icon_theme")]
    pub icon_theme: String,
    /// macOS app icon: an id from `icons/app-icons/app-icons.json`. The
    /// manifest's default is the bundle's own icon; any other is applied to
    /// the Dock and the bundle's Finder icon at runtime. Ignored on other
    /// platforms. See `crate::app_icon`.
    #[serde(default = "default_app_icon")]
    pub app_icon: String,
    /// Pre-theme-core config fields. Read once, never serialized again.
    #[serde(default, rename = "codeEditorTheme", skip_serializing)]
    legacy_code_editor_theme: Option<String>,
    #[serde(default, rename = "atlasTheme", skip_serializing)]
    legacy_atlas_theme: Option<String>,
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
    /// Let the Atlas Agent's engine sync OpenAI's curated plugin catalogue
    /// (github.com/openai/plugins) from GitHub when it starts. Off by default:
    /// it is a network fetch at every launch, and it was failing with HTTP
    /// 429. Reaches the in-process engine as `ATLAS_CURATED_PLUGIN_SYNC` —
    /// see `commands::atlas_config::apply_curated_plugin_sync_gate`.
    #[serde(default)]
    pub curated_plugin_sync: bool,
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
    /// Let Atlas Agent act on the window through the UI tool server
    /// (ADR-0012). Off: sessions are not offered the server and every call in
    /// a running one is refused. Default ON.
    #[serde(default = "default_true")]
    pub agent_ui_navigation: bool,
    /// Let Atlas Agent act in the organisation the session's Project is bound
    /// to, through the organisation tool server (ADR-0014). Off: sessions are
    /// not offered the server and every call in a running one is refused.
    /// Default ON.
    #[serde(default = "default_true")]
    pub agent_org_access: bool,
    /// Terminal notifications master switch. A command that fails, runs
    /// longer than `terminal_notify_min_duration_ms`, or asks for input raises
    /// an in-app notification, a toast when its terminal is off screen and a
    /// native notification when Atlas is not the front app.
    #[serde(default = "default_true")]
    pub terminal_notifications: bool,
    /// A successful command shorter than this never notifies (milliseconds).
    #[serde(default = "default_terminal_notify_min_duration_ms")]
    pub terminal_notify_min_duration_ms: u32,
    /// Notify on a non-zero exit code regardless of duration.
    #[serde(default = "default_true")]
    pub terminal_notify_on_failure: bool,
    /// Notify when a command wants input (password prompt, bell, OSC 9/777).
    #[serde(default = "default_true")]
    pub terminal_notify_on_attention: bool,
    /// Also raise a macOS notification when the window is not focused.
    #[serde(default = "default_true")]
    pub terminal_notify_native: bool,
    /// Play a short chime with the notification.
    #[serde(default)]
    pub terminal_notify_sound: bool,
}

fn default_true() -> bool {
    true
}

pub fn default_theme() -> String {
    atlas_theme::DEFAULT_THEME_ID.to_string()
}

pub fn default_app_icon() -> String {
    crate::app_icon::default_id().to_string()
}

pub fn default_icon_theme() -> String {
    atlas_icon_theme::DEFAULT_ICON_THEME_ID.to_string()
}

pub fn default_embedding_model() -> String {
    "all-MiniLM-L6-v2".to_string()
}

pub fn default_ui_scale() -> f32 {
    1.0
}

pub fn default_terminal_notify_min_duration_ms() -> u32 {
    10_000
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
            theme: default_theme(),
            theme_mode: ThemeMode::default(),
            theme_overrides: ThemeOverride::default(),
            icon_theme: default_icon_theme(),
            app_icon: default_app_icon(),
            legacy_code_editor_theme: None,
            legacy_atlas_theme: None,
            adaptive_suggestions: AdaptiveSuggestions::default(),
            git_blame_inline: true,
            auto_update: true,
            curated_plugin_sync: false,
            updater_ignored_version: None,
            enter_to_send: true,
            agent_ui_navigation: true,
            agent_org_access: true,
            terminal_notifications: true,
            terminal_notify_min_duration_ms: default_terminal_notify_min_duration_ms(),
            terminal_notify_on_failure: true,
            terminal_notify_on_attention: true,
            terminal_notify_native: true,
            terminal_notify_sound: false,
        }
    }
}

/// The full set of keys `AppSettings` knows about, in wire (camelCase) form.
/// Used to flag anything else in `[settings]` as an unknown key — preserved
/// on disk and surfaced as a diagnostic, never treated as an error.
/// Preamble written above `schemaVersion` in every `config.toml` Atlas
/// generates.
const CONFIG_HEADER: &str = "\
# Atlas configuration.
#
# Every user-facing Atlas preference lives here. Edit this file by hand or use
# Settings — both write to it, and Atlas picks up external edits live, with no
# restart needed for any key below.
#
# Your comments, formatting, and any keys Atlas doesn't recognize survive its
# own writes. An invalid value is rejected whole: Atlas keeps running on the
# last settings that loaded cleanly, shows the error in Settings, and leaves
# this file exactly as you wrote it.
";

const SCHEMA_VERSION_DOC: &str = "
# Format version of this file. Atlas manages it; leave it alone.
";

/// camelCase key → the comment written directly above it in a generated
/// `config.toml`.
///
/// This is the schema documentation. The `atlas-self-configure` skill
/// deliberately carries no copy of it: the agent reads the real file, which
/// explains itself, rather than a table that can drift from the code. A key
/// missing an entry here therefore ships undocumented —
/// `settings_docs_cover_every_setting` fails the build if that happens.
///
/// Order matches `AppSettings`' field order, and so the generated file's. That
/// matters for a key that serializes to nothing (`updaterIgnoredVersion` when
/// unset): its comment is carried down onto the next key that IS present,
/// rather than dropped.
const SETTINGS_DOCS: &[(&str, &str)] = &[
    (
        "autoAddAtlasGitignore",
        "# Add `.atlas/` to each opened git project's .gitignore, creating the\n\
         # file if needed. No-op on non-git projects. (default: true)",
    ),
    (
        "enableAtlasLogs",
        "# Record Atlas-internal events (sign-in, agent lifecycle, file and\n\
         # browser opens) into the Logs panel. (default: true)",
    ),
    (
        "showHiddenFiles",
        "# Show dotfiles and dot-directories in the explorer file tree.\n\
         # (default: true)",
    ),
    (
        "uiScale",
        "# Interface zoom, where 1.0 is 100%. Also driven by Cmd +/-/0.\n\
         # Must be a number between 0.5 and 2.0. (default: 1.0)",
    ),
    (
        "shareTelemetry",
        "# Anonymous product telemetry. Opt-OUT: on by default, coarse metadata\n\
         # only, never file contents or prompts. See TELEMETRY.md.\n\
         # (default: true)",
    ),
    (
        "linkTelemetryToAccount",
        "# Attribute telemetry to your signed-in Atlas account instead of the\n\
         # anonymous per-device id. Irrelevant while signed out, or while\n\
         # shareTelemetry is false — both gate it. (default: true)",
    ),
    (
        "embeddingModelId",
        "# On-device embedding model, named by its directory. Normally managed\n\
         # for you by the Local Model Manager. Must not be empty.\n\
         # (default: \"all-MiniLM-L6-v2\")",
    ),
    (
        "theme",
        "# Theme id for the whole app: chrome, editor, terminal, diffs and syntax.\n\
         # Unknown ids fall back to \"atlas\" with a warning. (default: \"atlas\")",
    ),
    (
        "themeMode",
        "# Variant selection: exactly \"system\", \"dark\" or \"light\".\n\
         # A missing requested variant falls back to the theme's other one.\n\
         # (default: \"system\")",
    ),
    (
        "themeOverrides",
        "# Optional user-local patch with base, palette and keys tables, applied\n\
         # after the active theme variant. Omitted when empty.",
    ),
    (
        "iconTheme",
        "# File and folder icons, on their own track from the colour theme.\n\
         # \"minimal\" keeps Atlas's own lucide icons; anything else names a VS\n\
         # Code icon theme, bundled or installed from Open VSX.\n\
         # (default: \"material-icon-theme\")",
    ),
    (
        "appIcon",
        "# macOS app icon, by id: \"dark\" (the icon Atlas ships with) or\n\
         # \"light\". Any other than dark replaces the Dock and Finder icon.\n\
         # An id this Atlas does not know shows the default. (default: \"dark\")",
    ),
    (
        "adaptiveSuggestions",
        "# Next-step suggestion chips in the agent chat's per-turn card.\n\
         # Exactly \"agent\" or \"off\", nothing else. (default: \"agent\")",
    ),
    (
        "gitBlameInline",
        "# Inline git blame — a dim author/age/summary annotation trailing the\n\
         # active line in the editor. (default: true)",
    ),
    (
        "autoUpdate",
        "# Check for a newer signed Atlas release on startup and prompt when one\n\
         # is available. (default: true)",
    ),
    (
        "curatedPluginSync",
        "# Let the Atlas Agent's engine fetch OpenAI's curated plugin catalogue\n\
         # (github.com/openai/plugins) when it starts — a network request at\n\
         # every launch. Applies the next time the agent starts. (default: false)",
    ),
    (
        "updaterIgnoredVersion",
        "# updaterIgnoredVersion: a release you chose to skip in the update\n\
         # prompt. Absent unless one was ignored — TOML has no null, so \"unset\"\n\
         # means the key simply isn't here. Delete the line to clear it; never\n\
         # write an empty string.",
    ),
    (
        "enterToSend",
        "# Chat composer send gesture. true = Enter sends and Shift+Enter\n\
         # inserts a newline; false = only Cmd/Ctrl+Enter sends. Cmd/Ctrl+Enter\n\
         # sends either way. (default: true)",
    ),
    (
        "agentUiNavigation",
        "# Let Atlas Agent act on the window: open files at a line, switch tabs\n\
         # and panels, fill in a chat message, type a command for you to run.\n\
         # It never switches projects, sends for you or presses Enter. Off: its\n\
         # UI tools are withdrawn and every call is refused. (default: true)",
    ),
    (
        "agentOrgAccess",
        "# Let Atlas Agent act in your organisation, as you: read the recorded\n\
         # sessions, comments, members and conversations of the organisation a\n\
         # cloud-bound Project belongs to. Anything that reaches another person\n\
         # asks you first. Off: its organisation tools are withdrawn and every\n\
         # call is refused. (default: true)",
    ),
    (
        "terminalNotifications",
        "# Terminal notifications: a command that fails, runs longer than\n\
         # terminalNotifyMinDurationMs, or asks for input raises an in-app\n\
         # notification, a toast when its terminal is off screen and a macOS\n\
         # notification when Atlas is in the background. (default: true)",
    ),
    (
        "terminalNotifyMinDurationMs",
        "# A successful command shorter than this many milliseconds never\n\
         # notifies. Must be between 0 and 3600000. (default: 10000)",
    ),
    (
        "terminalNotifyOnFailure",
        "# Notify on a non-zero exit code regardless of duration. (default: true)",
    ),
    (
        "terminalNotifyOnAttention",
        "# Notify when a command wants input — a password prompt, a bell, or an\n\
         # OSC 9 / OSC 777 notification from the program. (default: true)",
    ),
    (
        "terminalNotifyNative",
        "# Also raise a macOS notification when the Atlas window is not focused.\n\
         # (default: true)",
    ),
    (
        "terminalNotifySound",
        "# Play a short chime with terminal notifications. (default: false)",
    ),
];

/// Every key Atlas recognizes under `[settings]`, in file order.
fn known_settings_keys() -> impl Iterator<Item = &'static str> {
    SETTINGS_DOCS.iter().map(|(key, _)| *key)
}

/// One field failed semantic validation.
#[derive(Debug, Clone, PartialEq)]
pub struct ValidationIssue {
    pub key: &'static str,
    pub message: String,
}

/// One hour — a longer "minimum duration" means "never notify on success".
const MAX_TERMINAL_NOTIFY_MS: u32 = 3_600_000;

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
    if settings.terminal_notify_min_duration_ms > MAX_TERMINAL_NOTIFY_MS {
        return Err(ValidationIssue {
            key: "terminalNotifyMinDurationMs",
            message: format!(
                "must be between 0 and {MAX_TERMINAL_NOTIFY_MS}, got {}",
                settings.terminal_notify_min_duration_ms
            ),
        });
    }
    if settings.embedding_model_id.trim().is_empty() {
        return Err(ValidationIssue {
            key: "embeddingModelId",
            message: "must not be empty".to_string(),
        });
    }
    if settings.theme.trim().is_empty() {
        return Err(ValidationIssue {
            key: "theme",
            message: "must not be empty".to_string(),
        });
    }
    // An icon theme id is used as a directory name under
    // `~/.config/atlas/icon-themes/`, so a value with a separator or a `..` in
    // it would name a path outside it. Rejecting it here means the commands
    // downstream never have to.
    if !atlas_icon_theme::is_valid_id(&settings.icon_theme) {
        return Err(ValidationIssue {
            key: "iconTheme",
            message: "must be a plain id: letters, digits, dot, dash or underscore".to_string(),
        });
    }
    // Names a file (`icons/app-icons/<id>.icns`); same reasoning as `iconTheme`.
    if !crate::app_icon::is_valid_id(&settings.app_icon) {
        return Err(ValidationIssue {
            key: "appIcon",
            message: "must be a plain id: letters, digits, dash or underscore".to_string(),
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
        .filter(|k| !known_settings_keys().any(|known| known == k.as_str()))
        .collect()
}

fn document_for(settings: &AppSettings) -> toml_edit::DocumentMut {
    let file = AtlasConfigFile { schema_version: CONFIG_SCHEMA_VERSION, settings: settings.clone() };
    let text = toml::to_string_pretty(&file).expect("AppSettings always serializes to TOML");
    annotate(&text).parse().expect("freshly-generated TOML always parses")
}

/// Interleave [`CONFIG_HEADER`] and [`SETTINGS_DOCS`] into freshly generated
/// TOML, so the file Atlas writes explains itself.
///
/// Done on the text rather than through `toml_edit`'s decor API for one
/// reason: a key can be missing from the output entirely (`updaterIgnoredVersion`
/// serializes to nothing when unset, since TOML has no null), and there is no
/// decor to hang its comment on. Walking `SETTINGS_DOCS` in order alongside
/// the generated lines lets an absent key's comment fall through onto the next
/// key that is present, which is exactly where a reader looking for it will be.
///
/// Only ever applied to output this module just generated — never to a file a
/// user or agent wrote. Comments already in such a file are preserved by
/// `toml_edit` on patch, and none are ever injected into it.
fn annotate(generated: &str) -> String {
    let mut out = String::with_capacity(generated.len() * 3);
    out.push_str(CONFIG_HEADER);

    let mut docs = SETTINGS_DOCS.iter().peekable();
    // Comments for keys that serialized to nothing, waiting for the next key
    // that did.
    let mut carried: Vec<&str> = Vec::new();

    for line in generated.lines() {
        // A key line, not the `[settings]` header or a blank: it has an `=`,
        // and something before it. Getting this wrong once meant `[settings]`
        // was read as a key, which drained every remaining doc entry into
        // `carried` and dumped all of them at the bottom of the file.
        let Some(assigned) = line
            .split_once('=')
            .map(|(key, _)| key.trim())
            .filter(|key| !key.is_empty())
        else {
            out.push_str(line);
            out.push('\n');
            continue;
        };

        if assigned == "schemaVersion" {
            out.push_str(SCHEMA_VERSION_DOC);
            out.push_str(line);
            out.push('\n');
            continue;
        }

        // Advance to this key's entry, collecting the comments of any keys it
        // skipped past (those didn't make it into the output).
        while docs.peek().is_some_and(|(key, _)| *key != assigned) {
            let (_, comment) = docs.next().expect("peeked");
            carried.push(comment);
        }
        let Some((_, comment)) = docs.next() else {
            // Not a documented key (the `[settings]` header, a blank line, or
            // something new that `settings_docs_cover_every_setting` will
            // catch) — pass it through untouched.
            out.push_str(line);
            out.push('\n');
            continue;
        };

        out.push('\n');
        for skipped in carried.drain(..) {
            out.push_str(skipped);
            out.push('\n');
        }
        out.push_str(comment);
        out.push('\n');
        out.push_str(line);
        out.push('\n');
    }

    // Any documented keys after the last one that was emitted.
    for (_, comment) in docs {
        out.push('\n');
        out.push_str(comment);
        out.push('\n');
    }
    for comment in carried {
        out.push('\n');
        out.push_str(comment);
        out.push('\n');
    }
    out
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
    /// `CAS_ATTEMPTS` consecutive attempts each found the file rewritten
    /// between the merge and the swap. Nothing was written — retrying is
    /// safe, which is what the message tells the user to do.
    Busy,
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
            ConfigError::Busy => write!(
                f,
                "config.toml is being written by something else — nothing was changed; try again"
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
    pub theme: Option<String>,
    pub theme_mode: Option<ThemeMode>,
    pub theme_overrides: Option<ThemeOverride>,
    pub icon_theme: Option<String>,
    pub app_icon: Option<String>,
    pub adaptive_suggestions: Option<AdaptiveSuggestions>,
    pub git_blame_inline: Option<bool>,
    pub auto_update: Option<bool>,
    pub curated_plugin_sync: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub updater_ignored_version: Option<Option<String>>,
    pub enter_to_send: Option<bool>,
    pub agent_ui_navigation: Option<bool>,
    pub agent_org_access: Option<bool>,
    pub terminal_notifications: Option<bool>,
    pub terminal_notify_min_duration_ms: Option<u32>,
    pub terminal_notify_on_failure: Option<bool>,
    pub terminal_notify_on_attention: Option<bool>,
    pub terminal_notify_native: Option<bool>,
    pub terminal_notify_sound: Option<bool>,
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
        if let Some(v) = &self.theme {
            settings.theme = v.clone();
        }
        if let Some(v) = self.theme_mode {
            settings.theme_mode = v;
        }
        if let Some(v) = &self.theme_overrides {
            settings.theme_overrides = v.clone();
        }
        if let Some(v) = &self.icon_theme {
            settings.icon_theme = v.clone();
        }
        if let Some(v) = &self.app_icon {
            settings.app_icon = v.clone();
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
        if let Some(v) = self.curated_plugin_sync {
            settings.curated_plugin_sync = v;
        }
        if let Some(v) = &self.updater_ignored_version {
            settings.updater_ignored_version = v.clone();
        }
        if let Some(v) = self.enter_to_send {
            settings.enter_to_send = v;
        }
        if let Some(v) = self.agent_ui_navigation {
            settings.agent_ui_navigation = v;
        }
        if let Some(v) = self.agent_org_access {
            settings.agent_org_access = v;
        }
        if let Some(v) = self.terminal_notifications {
            settings.terminal_notifications = v;
        }
        if let Some(v) = self.terminal_notify_min_duration_ms {
            settings.terminal_notify_min_duration_ms = v;
        }
        if let Some(v) = self.terminal_notify_on_failure {
            settings.terminal_notify_on_failure = v;
        }
        if let Some(v) = self.terminal_notify_on_attention {
            settings.terminal_notify_on_attention = v;
        }
        if let Some(v) = self.terminal_notify_native {
            settings.terminal_notify_native = v;
        }
        if let Some(v) = self.terminal_notify_sound {
            settings.terminal_notify_sound = v;
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
        set_bool!(curated_plugin_sync, "curatedPluginSync");
        set_bool!(enter_to_send, "enterToSend");
        set_bool!(agent_ui_navigation, "agentUiNavigation");
        set_bool!(agent_org_access, "agentOrgAccess");
        set_bool!(terminal_notifications, "terminalNotifications");
        set_bool!(terminal_notify_on_failure, "terminalNotifyOnFailure");
        set_bool!(terminal_notify_on_attention, "terminalNotifyOnAttention");
        set_bool!(terminal_notify_native, "terminalNotifyNative");
        set_bool!(terminal_notify_sound, "terminalNotifySound");
        if let Some(v) = self.terminal_notify_min_duration_ms {
            table["terminalNotifyMinDurationMs"] = toml_edit::value(i64::from(v));
        }

        if let Some(v) = self.ui_scale {
            table["uiScale"] = toml_edit::value(f64::from(v));
        }
        if let Some(v) = &self.embedding_model_id {
            table["embeddingModelId"] = toml_edit::value(v.as_str());
        }
        if let Some(v) = &self.theme {
            table["theme"] = toml_edit::value(v.as_str());
        }
        if let Some(v) = self.theme_mode {
            table["themeMode"] = toml_edit::value(match v {
                ThemeMode::System => "system",
                ThemeMode::Dark => "dark",
                ThemeMode::Light => "light",
            });
        }
        if let Some(v) = &self.theme_overrides {
            table["themeOverrides"] = theme_override_item(v);
        }
        if let Some(v) = &self.icon_theme {
            table["iconTheme"] = toml_edit::value(v.as_str());
        }
        if let Some(v) = &self.app_icon {
            table["appIcon"] = toml_edit::value(v.as_str());
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
    take_bool!(curated_plugin_sync, "curatedPluginSync");
    take_bool!(enter_to_send, "enterToSend");
    take_bool!(agent_ui_navigation, "agentUiNavigation");
    take_bool!(agent_org_access, "agentOrgAccess");

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
    let old_editor = raw.get("codeEditorTheme").and_then(serde_json::Value::as_str);
    let old_atlas = raw.get("atlasTheme").and_then(serde_json::Value::as_str);
    let (theme, theme_overrides) = migrate_legacy_theme(old_atlas, old_editor);
    settings.theme = theme;
    settings.theme_overrides = theme_overrides;
    if let Some(v) = raw.get("updaterIgnoredVersion").and_then(serde_json::Value::as_str) {
        settings.updater_ignored_version = Some(v.to_string());
    }
    settings.adaptive_suggestions = adaptive_suggestions_from_legacy(raw.get("adaptiveSuggestions"));

    settings
}

/// What the OLD editor-theme picker wrote when nobody had touched it.
///
/// `default_code_editor_theme()` returned `"atlas"` unconditionally — the same
/// answer for every chrome theme — and it was serialized into every fresh
/// `config.toml`. So the value sitting on disk says nothing about what its
/// owner chose, and reading it as a deliberate choice forced Atlas's
/// black/white/yellow `editor.*` / `syntax.*` / `diff.*` keys into the
/// `themeOverrides` of every chyral / mirage / rosé-pine / phosphor user who
/// had simply never opened the editor picker. One theme means one theme
/// (decision 7): an untouched editor picker migrates to nothing.
const LEGACY_EDITOR_DEFAULT: &str = "atlas";

/// Fold the two old pickers (`atlasTheme` + `codeEditorTheme`) into one theme
/// id plus, where the user really did diverge, a `themeOverrides` block.
fn migrate_legacy_theme(
    old_atlas: Option<&str>,
    old_editor: Option<&str>,
) -> (String, ThemeOverride) {
    let mapped_theme = match old_atlas.map(str::trim).filter(|id| !id.is_empty()) {
        Some("atlas-black") | None => default_theme(),
        Some(id) => id.to_string(),
    };
    // Not checked against the catalog: a lookup that fails (a transient read
    // error, a theme this build does not ship) is not a reason to write a
    // different theme into the file. `fallback_unknown_theme` covers the
    // in-memory side.
    let theme = mapped_theme;
    // Overrides are written only for an editor theme that was GENUINELY
    // CHOSEN and that DIFFERS from the theme the chrome picker migrated to:
    // absent, blank, the picker's untouched default, or simply the same theme
    // under both pickers all mean "nothing to preserve".
    let Some(editor_id) = old_editor
        .map(str::trim)
        .filter(|id| !id.is_empty() && *id != LEGACY_EDITOR_DEFAULT && *id != theme.as_str())
    else {
        return (theme, ThemeOverride::default());
    };
    let Ok(editor_theme) = atlas_theme::get_theme(editor_id) else {
        tracing::warn!(target: "atlas::themes", theme = %editor_id, "unknown legacy editor theme; syntax override was not migrated");
        return (theme, ThemeOverride::default());
    };
    let Some(variant) = editor_theme.dark.or(editor_theme.light) else {
        return (theme, ThemeOverride::default());
    };
    let keys = variant
        .keys
        .into_iter()
        .filter(|(key, _)| {
            key.starts_with("editor.") || key.starts_with("syntax.") || key.starts_with("diff.")
        })
        .collect();
    (theme, ThemeOverride { keys, ..ThemeOverride::default() })
}

/// Serve the default theme for this session when `settings.theme` does not
/// resolve — **in memory only**.
///
/// This used to write `theme = "atlas"` back to `config.toml`, which turned
/// anything that made one lookup fail — a user theme mid-edit that briefly did
/// not parse, an unreadable themes directory, an id written by a newer Atlas —
/// into the permanent loss of the user's choice. The file keeps what the user
/// wrote; the next load, once the theme resolves again, uses it.
fn fallback_unknown_theme(settings: &mut AppSettings) {
    if let Err(error) = atlas_theme::get_theme(&settings.theme) {
        tracing::warn!(target: "atlas::themes", theme = %settings.theme, "theme in config.toml does not resolve ({error}); using atlas for this session");
        settings.theme = default_theme();
    }
}

/// Fold the legacy `atlasTheme` / `codeEditorTheme` keys into `theme` and
/// `themeOverrides`, returning whether `document` changed. That migration is
/// the only thing this writes; an unresolvable `theme` is handled in memory.
fn migrate_theme_fields(
    document: &mut toml_edit::DocumentMut,
    settings: &mut AppSettings,
) -> bool {
    let old_atlas = settings.legacy_atlas_theme.take();
    let old_editor = settings.legacy_code_editor_theme.take();
    let migrating = old_atlas.is_some() || old_editor.is_some();
    if !migrating {
        fallback_unknown_theme(settings);
        return false;
    }
    let (theme, theme_overrides) = migrate_legacy_theme(old_atlas.as_deref(), old_editor.as_deref());
    settings.theme = theme;
    settings.theme_overrides = theme_overrides;
    if document.get("settings").and_then(toml_edit::Item::as_table).is_none() {
        document["settings"] = toml_edit::Item::Table(toml_edit::Table::new());
    }
    let table = document["settings"].as_table_mut().expect("settings table was ensured");
    table.remove("atlasTheme");
    table.remove("codeEditorTheme");
    table["theme"] = toml_edit::value(settings.theme.as_str());
    table["themeMode"] = toml_edit::value(match settings.theme_mode {
        ThemeMode::System => "system",
        ThemeMode::Dark => "dark",
        ThemeMode::Light => "light",
    });
    if settings.theme_overrides.is_empty() {
        table.remove("themeOverrides");
    } else {
        table["themeOverrides"] = theme_override_item(&settings.theme_overrides);
    }
    fallback_unknown_theme(settings);
    true
}

fn theme_override_item(theme_override: &ThemeOverride) -> toml_edit::Item {
    fn string_map(values: &BTreeMap<String, String>) -> toml_edit::Item {
        let mut table = toml_edit::Table::new();
        for (key, value) in values {
            table[key] = toml_edit::value(value.as_str());
        }
        toml_edit::Item::Table(table)
    }

    let mut root = toml_edit::Table::new();
    if !theme_override.base.is_empty() {
        root["base"] = string_map(&theme_override.base);
    }
    if !theme_override.palette.is_empty() {
        root["palette"] = string_map(&theme_override.palette);
    }
    if !theme_override.keys.is_empty() {
        let mut keys = toml_edit::Table::new();
        for (key, value) in &theme_override.keys {
            keys[key] = match value {
                atlas_theme::ThemeKeyValue::Color(color) => toml_edit::value(color.as_str()),
                // A styled override is `{ color = "…" }` and nothing more —
                // `font_style` is rejected at load, so it can never be here to
                // write back out.
                atlas_theme::ThemeKeyValue::Styled(style) => {
                    let mut inline = toml_edit::InlineTable::new();
                    inline.insert("color", toml_edit::Value::from(style.color.as_str()));
                    toml_edit::value(inline)
                }
            };
        }
        root["keys"] = toml_edit::Item::Table(keys);
    }
    toml_edit::Item::Table(root)
}

// ---------------------------------------------------------------------------
// ConfigManager
// ---------------------------------------------------------------------------

/// Serialized straight to the frontend (`ConfigInfo.status`,
/// `BootstrapPayload.configStatus`) — `tag = "status"` matches the
/// discriminated union in `atlas-config-api.ts`. Deriving `Serialize` here
/// rather than mirroring the enum into a separate wire type in
/// `commands::atlas_config` keeps one definition of the three states.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
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
    pub fn config_path() -> Option<PathBuf> {
        config_root().map(|d| d.join(CONFIG_FILE_NAME))
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
        let mut document: toml_edit::DocumentMut =
            raw.parse().map_err(|e: toml_edit::TomlError| ConfigError::Parse(e.to_string()))?;
        let text = document.to_string();
        let mut file: AtlasConfigFile =
            toml::from_str(&text).map_err(|e| ConfigError::Parse(e.to_string()))?;
        if file.schema_version > CONFIG_SCHEMA_VERSION {
            return Err(ConfigError::UnsupportedVersion(file.schema_version));
        }
        migrate_theme_fields(&mut document, &mut file.settings);
        validate(&file.settings).map_err(ConfigError::Invalid)?;
        let unknown_keys = unknown_keys_in(&document);
        let migrated_raw = document.to_string();
        Ok(Self {
            path,
            document,
            effective: file.settings,
            last_raw: migrated_raw,
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
    pub fn load() -> Self {
        let Some(path) = Self::config_path() else {
            return Self::in_memory_defaults(PathBuf::from(CONFIG_FILE_NAME));
        };
        Self::load_at(path)
    }

    /// The path-only half of `load` — split out so `bootstrap_at` (and its
    /// tests) can exercise the real cold-start behavior against a temp dir.
    fn load_at(path: PathBuf) -> Self {
        match fs::read_to_string(&path) {
            Ok(raw) => match Self::from_raw(path.clone(), &raw) {
                Ok(manager) => {
                    if manager.last_raw != raw {
                        if let Err(error) = write_atomic(&path, &manager.last_raw) {
                            tracing::warn!(target: "atlas::config", "failed to persist theme settings migration: {error}");
                        }
                    }
                    manager
                }
                Err(e) => {
                    tracing::warn!(
                        target: "atlas::config",
                        "config.toml invalid at cold start, serving defaults in memory (file left untouched): {e}"
                    );
                    let mut mgr = Self::in_memory_defaults(path);
                    mgr.status = ConfigStatus::UsingDefaults { error: e.to_string() };
                    mgr
                }
            },
            // File genuinely absent — the normal pre-first-write state, not
            // an error. `bootstrap` below is what decides whether that's
            // "needs migration" or "already migrated, stay on defaults".
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Self::in_memory_defaults(path),
            // Anything else (permissions, a transient I/O fault, a directory
            // where the file should be) is a *failure to read*, not an
            // absence. Serving defaults is still right at runtime — boot must
            // never block on this — but the status MUST say so, because
            // `bootstrap_at` keys the "the legacy state.json settings are
            // now redundant" decision off it. Reporting `Ok` here is what let
            // an unreadable config silently retire the user's only surviving
            // copy of their preferences.
            Err(e) => {
                tracing::warn!(
                    target: "atlas::config",
                    "config.toml could not be read, serving defaults in memory (file left untouched): {e}"
                );
                let mut mgr = Self::in_memory_defaults(path);
                mgr.status = ConfigStatus::UsingDefaults { error: format!("could not read config.toml: {e}") };
                mgr
            }
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
        if fresh.last_raw != raw {
            write_atomic(&self.path, &fresh.last_raw).map_err(|error| ConfigError::Io(error.to_string()))?;
        }
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
    /// The re-read and the rename are not one atomic step — an external
    /// editor (or the `atlas-self-configure` skill) can still write in the
    /// gap, and that write would be clobbered along with its comments and
    /// unknown keys. Short of taking an advisory file lock, the best
    /// available answer is to re-check the file immediately before the swap
    /// and, if it moved, rebuild the patch on the fresh content and try
    /// again — bounded by [`CAS_ATTEMPTS`], after which the write is refused
    /// with [`ConfigError::Busy`] rather than spinning forever. Note that
    /// `Busy` is only reachable for `expected_generation: None` callers: with
    /// `Some(g)`, the retry's `reload_from_disk` adopts the intervening write
    /// and bumps the generation, so the second pass reports `Conflict`.
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
        for _ in 0..CAS_ATTEMPTS {
            if let Some(outcome) = self.try_apply_patch(patch, expected_generation)? {
                return Ok(outcome);
            }
        }
        Err(ConfigError::Busy)
    }

    /// One compare-and-swap attempt. `Ok(None)` means the file changed
    /// underneath us between the re-read and the swap and nothing was
    /// written — the caller retries against the new content.
    fn try_apply_patch(
        &mut self,
        patch: &SettingsPatch,
        expected_generation: Option<u64>,
    ) -> Result<Option<UpdateOutcome>, ConfigError> {
        self.reload_from_disk()?;

        if let Some(expected) = expected_generation {
            if expected != self.generation {
                return Ok(Some(UpdateOutcome::Conflict {
                    settings: self.effective.clone(),
                    generation: self.generation,
                }));
            }
        }

        let mut candidate = self.effective.clone();
        patch.apply_to(&mut candidate);
        validate(&candidate).map_err(ConfigError::Invalid)?;

        let mut doc = self.document.clone();
        patch.write_into(&mut doc);
        doc["schemaVersion"] = toml_edit::value(i64::from(CONFIG_SCHEMA_VERSION));

        let text = doc.to_string();
        if !self.write_if_unchanged(&text)? {
            return Ok(None);
        }

        self.document = doc;
        self.unknown_keys = unknown_keys_in(&self.document);
        self.effective = candidate.clone();
        self.last_raw = text;
        self.generation += 1;
        self.status = ConfigStatus::Ok;

        Ok(Some(UpdateOutcome::Applied { settings: candidate, generation: self.generation }))
    }

    /// Swap `text` in only if the file still holds exactly the content this
    /// patch was merged against (`last_raw`). `Ok(false)` = it moved, so the
    /// merge base is stale and nothing was written.
    ///
    /// A missing file is not "moved" — that's the pre-first-write state, and
    /// writing is precisely what should happen. Any other read error is
    /// surfaced rather than guessed past.
    fn write_if_unchanged(&self, text: &str) -> Result<bool, ConfigError> {
        match fs::read_to_string(&self.path) {
            Ok(now) if now != self.last_raw => return Ok(false),
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                return Err(ConfigError::Io(e.to_string()));
            }
            _ => {}
        }
        write_atomic(&self.path, text).map_err(|e| ConfigError::Io(e.to_string()))?;
        Ok(true)
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
    fn create_fresh_with(path: PathBuf, mut settings: AppSettings) -> Result<Self, ConfigError> {
        let document = document_for(&settings);
        let text = document.to_string();
        write_atomic(&path, &text).map_err(|e| ConfigError::Io(e.to_string()))?;
        fallback_unknown_theme(&mut settings);
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
    use std::io::Write;

    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| CONFIG_FILE_NAME.to_string());
    let unique = format!("{file_name}.tmp.{}", uuid::Uuid::new_v4());
    let tmp = path.with_file_name(unique);

    // `sync_all` before the rename, not just `fs::write`: without it the
    // rename can reach the disk ahead of the bytes it points at, so power
    // loss just after the UI said "saved" can leave config.toml pointing at
    // an empty or half-written inode. On the failure paths the temp file is
    // removed rather than left as litter next to the real config.
    let written = (|| -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(contents.as_bytes())?;
        f.sync_all()
    })();
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }

    // Make the rename itself durable. Best-effort: some filesystems refuse to
    // open a directory for sync, and that is not worth failing an otherwise
    // successful write over.
    if let Some(dir) = path.parent() {
        if let Ok(d) = fs::File::open(dir) {
            let _ = d.sync_all();
        }
    }
    Ok(())
}

/// `~/.config/atlas/` — deliberately NOT Tauri's `app_config_dir()`, which on
/// macOS is `~/Library/Application Support/dev.atlas.ide/`.
///
/// `config.toml` is meant to be opened, read and hand-edited, by a person or
/// by an agent; a path they can type is part of that, and a bundle id buried
/// under `Application Support` is not. Zed makes the same call for the same
/// reason (`~/.config/zed/settings.json` on macOS), and it puts Atlas's config
/// beside every other tool a developer already keeps under `~/.config`.
///
/// This is a split, not a move: everything else Atlas persists —
/// `state.json`, `device.json`, `telemetry.json`, the models-pricing cache,
/// session chat — stays in the platform data directory. Those are
/// machine-managed state, not documents, and nobody should be editing them.
///
/// **This function is copied twice**, in `atlas-theme` (`user_theme_dir`) and
/// `atlas-icon-theme` (`user_icon_theme_dir`). Both sit below `src-tauri` in
/// the dependency graph and so cannot call this one without a cycle, and a
/// shared crate for three identical ~15-line functions was weighed and
/// declined — the cost is another workspace member and another sequential CI
/// job on a graph where build time is the documented bottleneck. What keeps
/// them honest instead: all three carry the same three tests over
/// `config_root_from`, with the same fixtures and the same expected paths, so
/// changing where config lives in one place reddens a test next to the copy
/// that drifted. Change all three together, or none.
pub(crate) fn config_root() -> Option<PathBuf> {
    let xdg = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from);
    let home = dirs::home_dir().or_else(|| std::env::var_os("HOME").map(PathBuf::from));
    config_root_from(xdg.as_deref(), home.as_deref())
}

/// The decision itself, taking its inputs rather than reading the environment,
/// so it can be tested without racing every other test in the process over
/// `set_var`.
///
/// `$XDG_CONFIG_HOME` wins when it is set to an absolute path — the convention
/// everywhere the variable means anything, and how a user relocates config for
/// every other tool they run. A relative value is ignored rather than resolved
/// against the cwd: the cwd of a GUI app launched from Finder is arbitrary,
/// and writing config into it would be worse than falling back.
fn config_root_from(xdg: Option<&Path>, home: Option<&Path>) -> Option<PathBuf> {
    if let Some(xdg) = xdg {
        if xdg.is_absolute() {
            return Some(xdg.join(CONFIG_DIR_NAME));
        }
    }
    home.map(|home| home.join(".config").join(CONFIG_DIR_NAME))
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
    /// into `state.json` (v4) after this call. `true` once `config.toml`
    /// demonstrably holds the settings — it either loaded cleanly or was
    /// just created. Deliberately `false` when the file exists but could not
    /// be read or parsed: the legacy `state.json.settings` is still the only
    /// copy in that case and must survive until a real config does.
    pub mark_migrated: bool,
}

pub fn bootstrap(
    marker_already_set: bool,
    legacy_settings_raw: Option<serde_json::Value>,
) -> MigrationOutcome {
    let Some(path) = ConfigManager::config_path() else {
        // No resolvable config dir at all (no $HOME / no %APPDATA%). Defaults
        // keep the app usable, but this is a failure and must reach the
        // banner rather than passing for a healthy load.
        let mut manager = ConfigManager::load();
        manager.status = ConfigStatus::UsingDefaults {
            error: "could not resolve the Atlas config directory".to_string(),
        };
        return MigrationOutcome { manager, mark_migrated: false };
    };
    bootstrap_at(path, marker_already_set, legacy_settings_raw)
}

/// The actual migration decision, split out from `bootstrap` so it's
/// testable against a real temp-dir path rather than whatever
/// `config_root()` resolves to on the machine running the tests.
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
        let mut manager = ConfigManager::load_at(path);
        // ...but only report migration as done if that file could actually be
        // READ. While it is malformed or unreadable, `state.json.settings` is
        // still the only surviving copy of the user's preferences; setting
        // the marker here would let `AppState::save` drop it (the typed
        // `AppState` has no `settings` field any more), turning a recoverable
        // bad file into permanent data loss.
        let mark_migrated = matches!(manager.status(), ConfigStatus::Ok);
        if !mark_migrated && !marker_already_set {
            // The file is present but unusable, so migration never ran and
            // `state.json.settings` is still the user's real configuration.
            // Serve THAT rather than compiled defaults: keeping the legacy
            // copy alive (see `AppState::save`) is only half the guarantee —
            // the other half is honouring it while the file is broken, or the
            // user still spends the whole session on defaults with, say,
            // telemetry back on. The broken file itself is left untouched.
            manager.effective = settings_from_legacy_json(legacy_settings_raw.as_ref());
            manager.document = document_for(&manager.effective);
            fallback_unknown_theme(&mut manager.effective);
        }
        return MigrationOutcome { manager, mark_migrated };
    }

    // No file yet. Import from legacy state exactly once, ever.
    let settings = if marker_already_set {
        AppSettings::default()
    } else {
        settings_from_legacy_json(legacy_settings_raw.as_ref())
    };

    match ConfigManager::create_fresh_with(path.clone(), settings.clone()) {
        Ok(manager) => MigrationOutcome { manager, mark_migrated: true },
        Err(e) => {
            tracing::warn!(target: "atlas::config", "failed to write migrated config.toml: {e}");
            // The file was never created, so `load_at` will take its
            // "genuinely absent" branch and report `Ok` — which would hide a
            // real failure behind a healthy status and drop the legacy
            // settings we just computed. Serve those settings in memory and
            // flag the write failure instead.
            let mut manager = ConfigManager::load_at(path);
            manager.effective = settings;
            manager.document = document_for(&manager.effective);
            fallback_unknown_theme(&mut manager.effective);
            manager.status =
                ConfigStatus::UsingDefaults { error: format!("could not write config.toml: {e}") };
            MigrationOutcome { manager, mark_migrated: false }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh `config.toml` path inside its own temp directory, so parallel
    /// tests never collide and `write_atomic`'s `create_dir_all` has
    /// somewhere real to write the sibling `.tmp.<uuid>` file. Keep the
    /// `TempDir` alive for the test: dropping it deletes the directory.
    fn tmp_config_path() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CONFIG_FILE_NAME);
        (dir, path)
    }

    // ── config_root (issue #64 follow-up: ~/.config/atlas, not the bundle id) ──

    #[test]
    fn config_lives_under_dot_config_atlas_not_the_bundle_id() {
        let home = PathBuf::from("/Users/someone");
        let root = config_root_from(None, Some(&home)).expect("a home resolves a root");

        assert_eq!(root, PathBuf::from("/Users/someone/.config/atlas"));
        assert_eq!(root.join(CONFIG_FILE_NAME), PathBuf::from("/Users/someone/.config/atlas/config.toml"));
        // The whole point: nothing here reads `dev.atlas.ide`.
        assert!(!root.to_string_lossy().contains("dev.atlas.ide"));
        assert!(!root.to_string_lossy().contains("Application Support"));
    }

    /// `$XDG_CONFIG_HOME` is how a user relocates config for every other tool
    /// they run; honouring it is the price of living in `~/.config`.
    #[test]
    fn an_absolute_xdg_config_home_wins() {
        let xdg = PathBuf::from("/elsewhere/cfg");
        let home = PathBuf::from("/Users/someone");

        let root = config_root_from(Some(&xdg), Some(&home)).unwrap();

        assert_eq!(root, PathBuf::from("/elsewhere/cfg/atlas"));
    }

    /// A relative `$XDG_CONFIG_HOME` is ignored rather than resolved against
    /// the cwd — a GUI app launched from Finder has an arbitrary one, and
    /// writing config into it is worse than falling back to `$HOME`.
    #[test]
    fn a_relative_xdg_config_home_is_ignored() {
        let xdg = PathBuf::from("relative/cfg");
        let home = PathBuf::from("/Users/someone");

        let root = config_root_from(Some(&xdg), Some(&home)).unwrap();

        assert_eq!(root, PathBuf::from("/Users/someone/.config/atlas"));
    }

    /// No home and no usable XDG: there is nowhere to put it, and `load`
    /// degrades to in-memory defaults rather than inventing a path.
    #[test]
    fn no_home_and_no_xdg_resolves_nothing() {
        assert_eq!(config_root_from(None, None), None);
        assert_eq!(config_root_from(Some(&PathBuf::from("rel")), None), None);
    }

    #[test]
    fn defaults_pass_validation() {
        assert!(validate(&AppSettings::default()).is_ok());
    }

    /// ADR-0012: on unless the user switched it off, and a file that predates
    /// the key reads as on.
    #[test]
    fn agent_ui_navigation_is_on_by_default_and_read_from_the_file() {
        assert!(AppSettings::default().agent_ui_navigation);
        let (_dir, path) = tmp_config_path();
        let mgr = ConfigManager::from_raw(path, "schemaVersion = 1\n\n[settings]\nenterToSend = false\n").unwrap();
        assert!(mgr.effective().agent_ui_navigation);
        let (_dir, path) = tmp_config_path();
        let mgr = ConfigManager::from_raw(path, "schemaVersion = 1\n\n[settings]\nagentUiNavigation = false\n").unwrap();
        assert!(!mgr.effective().agent_ui_navigation);
    }

    /// ADR-0014: on unless the user switched it off, and a file that predates
    /// the key reads as on.
    #[test]
    fn agent_org_access_is_on_by_default_and_read_from_the_file() {
        assert!(AppSettings::default().agent_org_access);
        let (_dir, path) = tmp_config_path();
        let mgr = ConfigManager::from_raw(path, "schemaVersion = 1\n\n[settings]\nenterToSend = false\n").unwrap();
        assert!(mgr.effective().agent_org_access);
        let (_dir, path) = tmp_config_path();
        let mgr = ConfigManager::from_raw(path, "schemaVersion = 1\n\n[settings]\nagentOrgAccess = false\n").unwrap();
        assert!(!mgr.effective().agent_org_access);
    }

    #[test]
    fn missing_keys_fall_back_to_defaults() {
        let (_dir, path) = tmp_config_path();
        let raw = "schemaVersion = 1\n\n[settings]\nenterToSend = false\n";
        let mgr = ConfigManager::from_raw(path, raw).expect("partial file parses");
        assert!(!mgr.effective().enter_to_send);
        // Every other field is absent from the file — must be the compiled default.
        assert_eq!(mgr.effective().theme, default_theme());
        assert_eq!(mgr.effective().ui_scale, default_ui_scale());
        assert!(mgr.effective().auto_update);
    }

    #[test]
    fn file_missing_entirely_serves_defaults_without_error() {
        let root = tempfile::tempdir().unwrap();
        // Deliberately do NOT create the dir/file.
        let path = root.path().join("missing").join(CONFIG_FILE_NAME);
        let mgr = ConfigManager::in_memory_defaults(path);
        assert_eq!(mgr.status(), &ConfigStatus::Ok);
        assert_eq!(mgr.effective(), &AppSettings::default());
    }

    #[test]
    fn patch_preserves_comments_and_unknown_keys() {
        let (_dir, path) = tmp_config_path();
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
        let (_dir, path) = tmp_config_path();
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
        let (_dir, path) = tmp_config_path();
        let raw = "schemaVersion = 99\n\n[settings]\n";
        let err = ConfigManager::from_raw(path, raw).expect_err("future schema must be rejected");
        assert_eq!(err, ConfigError::UnsupportedVersion(99));
    }

    #[test]
    fn malformed_syntax_at_cold_start_serves_defaults_and_leaves_file_alone() {
        let (_dir, path) = tmp_config_path();
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
        let (_dir, path) = tmp_config_path();
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
        let (_dir, path) = tmp_config_path();
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
        let (_dir, path) = tmp_config_path();
        let raw = "schemaVersion = 1\n\n[settings]\nenterToSend = true\n";
        fs::write(&path, raw).unwrap();
        let mut mgr = ConfigManager::from_raw(path, raw).unwrap();
        let gen_before = mgr.generation();
        assert_eq!(mgr.reload_from_disk().unwrap(), false);
        assert_eq!(mgr.generation(), gen_before);
    }

    #[test]
    fn reset_backs_up_and_rewrites_defaults() {
        let (_dir, path) = tmp_config_path();
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
            .filter_map(Result::ok)
            .any(|e| e.file_name().to_string_lossy().starts_with("config.toml.bak-"));
        assert!(has_backup, "reset() must back up the previous file before overwriting");
    }

    #[test]
    fn legacy_migration_extracts_known_fields() {
        let legacy = serde_json::json!({
            "enterToSend": false,
            "atlasTheme": "rose-pine",
            "uiScale": 1.5,
        });
        let settings = settings_from_legacy_json(Some(&legacy));
        assert!(!settings.enter_to_send);
        assert_eq!(settings.theme, "rose-pine");
        assert_eq!(settings.ui_scale, 1.5);
        // Untouched fields keep their compiled defaults.
        assert!(settings.auto_update);
    }

    #[test]
    fn config_theme_migration_merges_the_two_legacy_pickers_once() {
        let (_dir, path) = tmp_config_path();
        let raw = "schemaVersion = 1\n\n[settings]\natlasTheme = \"one-dark\"\ncodeEditorTheme = \"dracula\"\n";
        let manager = ConfigManager::from_raw(path, raw).expect("legacy theme settings parse");

        assert_eq!(manager.effective().theme, "one-dark");
        assert!(manager
            .effective()
            .theme_overrides
            .keys
            .contains_key("syntax.keyword"));
        assert!(!manager.last_raw.contains("atlasTheme"));
        assert!(!manager.last_raw.contains("codeEditorTheme"));
        assert!(manager.last_raw.contains("themeOverrides"));
    }

    /// The six themes the OLD `atlasTheme` picker could hold, and the schema-1
    /// theme each one migrates to. `atlas-black` is the only rename.
    const LEGACY_CHROME_THEMES: [(&str, &str); 6] = [
        ("atlas-black", "atlas"),
        ("chyral", "chyral"),
        ("mirage", "mirage"),
        ("rose-pine", "rose-pine"),
        ("one-dark", "one-dark"),
        ("phosphor", "phosphor"),
    ];

    /// The regression this guards: `default_code_editor_theme()` returned
    /// `"atlas"` for everyone, so `codeEditorTheme = "atlas"` is what an
    /// UNTOUCHED editor picker left on disk — for all six chrome themes, not
    /// just the two that happened to share a name with an editor theme.
    /// Reading it as "deliberately diverging" pinned Atlas's black/white/yellow
    /// editor colours onto chyral, mirage, rosé-pine and phosphor users who had
    /// never opened that picker.
    #[test]
    fn untouched_legacy_editor_picker_migrates_to_no_overrides() {
        for (old_chrome, expected) in LEGACY_CHROME_THEMES {
            for old_editor in [None, Some(""), Some("  "), Some(LEGACY_EDITOR_DEFAULT)] {
                let (theme, overrides) = migrate_legacy_theme(Some(old_chrome), old_editor);
                assert_eq!(theme, expected, "chrome {old_chrome}");
                assert!(
                    overrides.is_empty(),
                    "chrome {old_chrome} with editor {old_editor:?} must not diverge, got {overrides:?}"
                );
            }
        }
    }

    /// The other half of the same rule: an editor theme that really was picked,
    /// and really is a different theme, still carries its colours over.
    #[test]
    fn chosen_legacy_editor_theme_migrates_its_syntax_keys() {
        for (old_chrome, expected) in LEGACY_CHROME_THEMES {
            let (theme, overrides) = migrate_legacy_theme(Some(old_chrome), Some("dracula"));
            assert_eq!(theme, expected, "chrome {old_chrome}");
            assert!(
                overrides.keys.contains_key("syntax.keyword"),
                "chrome {old_chrome} lost its chosen editor theme"
            );
            assert!(overrides.base.is_empty() && overrides.palette.is_empty());
            assert!(
                overrides.keys.keys().all(|key| key.starts_with("editor.")
                    || key.starts_with("syntax.")
                    || key.starts_with("diff.")),
                "only editor-facing keys migrate: {:?}",
                overrides.keys.keys().collect::<Vec<_>>()
            );
        }
    }

    /// Both pickers naming the same theme is not a divergence either.
    #[test]
    fn legacy_editor_theme_equal_to_the_chrome_theme_writes_no_overrides() {
        for id in ["one-dark", "phosphor", "rose-pine"] {
            let (theme, overrides) = migrate_legacy_theme(Some(id), Some(id));
            assert_eq!(theme, id);
            assert!(overrides.is_empty(), "{id} diverged from itself: {overrides:?}");
        }
    }

    /// End to end through `config.toml`: the untouched default leaves no
    /// `themeOverrides` table behind at all.
    #[test]
    fn config_theme_migration_writes_no_overrides_for_the_untouched_editor_default() {
        let (_dir, path) = tmp_config_path();
        let raw =
            "schemaVersion = 1\n\n[settings]\natlasTheme = \"chyral\"\ncodeEditorTheme = \"atlas\"\n";
        let manager = ConfigManager::from_raw(path, raw).expect("legacy theme settings parse");

        assert_eq!(manager.effective().theme, "chyral");
        assert!(manager.effective().theme_overrides.is_empty());
        assert!(!manager.last_raw.contains("themeOverrides"));
        assert!(!manager.last_raw.contains("atlasTheme"));
        assert!(!manager.last_raw.contains("codeEditorTheme"));
    }

    #[test]
    fn unknown_config_theme_falls_back_in_memory_and_is_never_rewritten() {
        let (_dir, path) = tmp_config_path();
        let raw = "schemaVersion = 1\n\n[settings]\ntheme = \"from-a-newer-atlas\"\n";
        let manager = ConfigManager::from_raw(path.clone(), raw).expect("unknown id falls back");

        assert_eq!(manager.effective().theme, default_theme());
        assert_eq!(manager.last_raw, raw, "a failed lookup is not a migration");

        // And through the cold-start path, which is the one that writes.
        fs::write(&path, raw).unwrap();
        let manager = ConfigManager::load_at(path.clone());
        assert_eq!(manager.effective().theme, default_theme());
        assert_eq!(fs::read_to_string(&path).unwrap(), raw);
    }

    /// The legacy keys still migrate — and the theme they name is written as
    /// named, even when this build cannot resolve it.
    #[test]
    fn legacy_theme_keys_migrate_without_rewriting_an_unresolvable_theme() {
        let (_dir, path) = tmp_config_path();
        let raw = "schemaVersion = 1\n\n[settings]\natlasTheme = \"not-shipped-here\"\n";
        let manager = ConfigManager::from_raw(path, raw).expect("legacy settings parse");

        assert_eq!(manager.effective().theme, default_theme(), "served in memory");
        assert!(manager.last_raw.contains("theme = \"not-shipped-here\""), "{}", manager.last_raw);
        assert!(!manager.last_raw.contains("atlasTheme"));
    }

    /// `write_into` is hand-written per field, and a field it forgets is saved
    /// in memory, reported as applied, and gone on the next launch — which is
    /// what happened to `iconTheme`. The patch below is a struct literal with no
    /// `..Default::default()`, so a new `SettingsPatch` field does not compile
    /// until it is added here, and the JSON check proves every setting it sets
    /// actually differs from the default.
    #[test]
    fn every_settings_patch_field_survives_a_write_and_a_reload() {
        let defaults = AppSettings::default();
        let patch = SettingsPatch {
            auto_add_atlas_gitignore: Some(!defaults.auto_add_atlas_gitignore),
            enable_atlas_logs: Some(!defaults.enable_atlas_logs),
            show_hidden_files: Some(!defaults.show_hidden_files),
            ui_scale: Some(1.5),
            share_telemetry: Some(!defaults.share_telemetry),
            link_telemetry_to_account: Some(!defaults.link_telemetry_to_account),
            embedding_model_id: Some("another-model".to_string()),
            theme: Some("dracula".to_string()),
            theme_mode: Some(ThemeMode::Light),
            theme_overrides: Some(ThemeOverride {
                base: BTreeMap::from([("radius".to_string(), "0.5rem".to_string())]),
                palette: BTreeMap::from([("red".to_string(), "#ff0000".to_string())]),
                keys: BTreeMap::from([(
                    "syntax.keyword".to_string(),
                    atlas_theme::ThemeKeyValue::Color("#00ff00".to_string()),
                )]),
            }),
            icon_theme: Some(atlas_icon_theme::MINIMAL_ICON_THEME_ID.to_string()),
            app_icon: Some("light".to_string()),
            adaptive_suggestions: Some(AdaptiveSuggestions::Off),
            git_blame_inline: Some(!defaults.git_blame_inline),
            auto_update: Some(!defaults.auto_update),
            curated_plugin_sync: Some(!defaults.curated_plugin_sync),
            updater_ignored_version: Some(Some("9.9.9".to_string())),
            enter_to_send: Some(!defaults.enter_to_send),
            agent_ui_navigation: Some(!defaults.agent_ui_navigation),
            agent_org_access: Some(!defaults.agent_org_access),
            terminal_notifications: Some(!defaults.terminal_notifications),
            terminal_notify_min_duration_ms: Some(defaults.terminal_notify_min_duration_ms + 1),
            terminal_notify_on_failure: Some(!defaults.terminal_notify_on_failure),
            terminal_notify_on_attention: Some(!defaults.terminal_notify_on_attention),
            terminal_notify_native: Some(!defaults.terminal_notify_native),
            terminal_notify_sound: Some(!defaults.terminal_notify_sound),
        };
        let mut expected = defaults.clone();
        patch.apply_to(&mut expected);

        let expected_json = serde_json::to_value(&expected).unwrap();
        let default_json = serde_json::to_value(&defaults).unwrap();
        for (key, value) in expected_json.as_object().unwrap() {
            assert_ne!(default_json.get(key), Some(value), "the fixture leaves {key} at its default");
        }

        let mut document = document_for(&defaults);
        patch.write_into(&mut document);
        let (_dir, path) = tmp_config_path();
        let reloaded = ConfigManager::from_raw(path, &document.to_string())
            .expect("a written patch reloads");
        assert_eq!(reloaded.effective(), &expected);
    }

    /// `syntax.keyword = "#fff"` is TOML for a nested table. It used to fail
    /// the untagged-enum parse and take every setting in the file with it.
    #[test]
    fn theme_override_keys_accept_dotted_and_nested_forms_and_drop_bad_entries() {
        let raw = r##"schemaVersion = 1

[settings]
enterToSend = false

[settings.themeOverrides.base]
radius = "0.5rem"
font-sans = "x; } body { display: none"

[settings.themeOverrides.palette]
red = "#ff0000"
blue = 7

[settings.themeOverrides.keys]
syntax.keyword = "#ff0000"
"editor.background" = { color = "#000000" }
bad = 5
styled = { color = "#111111", font_style = "italic" }
evil = "red; } body { display: none"

[settings.themeOverrides.keys.terminal.ansi]
red = "#ee0000"
"##;
        let (_dir, path) = tmp_config_path();
        let manager = ConfigManager::from_raw(path, raw).expect("the file still loads");
        let settings = manager.effective();
        assert!(!settings.enter_to_send, "the rest of the file was read");
        let overrides = &settings.theme_overrides;
        assert_eq!(overrides.base.keys().collect::<Vec<_>>(), ["radius"]);
        assert_eq!(overrides.palette.keys().collect::<Vec<_>>(), ["red"]);
        assert_eq!(
            overrides.keys.keys().collect::<Vec<_>>(),
            ["editor.background", "syntax.keyword", "terminal.ansi.red"]
        );
        assert_eq!(overrides.keys["syntax.keyword"].color(), "#ff0000");
        assert_eq!(overrides.keys["editor.background"].color(), "#000000");

        // The same shape arriving as a JSON patch from the UI.
        let patch: SettingsPatch = serde_json::from_value(serde_json::json!({
            "themeOverrides": { "keys": { "syntax": { "keyword": "#fff" } } }
        }))
        .unwrap();
        assert_eq!(patch.theme_overrides.unwrap().keys["syntax.keyword"].color(), "#fff");
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
        let (_dir, path) = tmp_config_path();
        let legacy = serde_json::json!({ "enterToSend": false, "atlasTheme": "rose-pine" });

        let outcome = bootstrap_at(path.clone(), false, Some(legacy));

        assert!(outcome.mark_migrated);
        assert!(!outcome.manager.effective().enter_to_send);
        assert_eq!(outcome.manager.effective().theme, "rose-pine");
        assert!(path.exists(), "bootstrap must actually write config.toml on first run");
    }

    #[test]
    fn bootstrap_never_reimports_after_marker_is_set() {
        let (_dir, path) = tmp_config_path();
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
        let (_dir, path) = tmp_config_path();
        let raw = "schemaVersion = 1\n\n[settings]\nenterToSend = false\n";
        fs::write(&path, raw).unwrap();
        let legacy = serde_json::json!({ "enterToSend": true, "atlasTheme": "should-never-appear" });

        let outcome = bootstrap_at(path.clone(), false, Some(legacy));

        assert!(outcome.mark_migrated);
        // The existing file wins outright — legacy data is never merged in,
        // not even for keys the existing file didn't set.
        assert!(!outcome.manager.effective().enter_to_send);
        assert_eq!(outcome.manager.effective().theme, default_theme());
        assert_eq!(fs::read_to_string(&path).unwrap(), raw, "must not rewrite an existing config.toml");
    }

    #[test]
    fn bootstrap_is_idempotent_across_repeated_calls() {
        let (_dir, path) = tmp_config_path();
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
    // build the moment either document drifts from `SETTINGS_DOCS`, the same
    // way the rest of this crate's `include_str!`'d resources do.

    const CONFIGURATION_DOC: &str = include_str!("../../../docs/reference/configuration.md");
    const SELF_CONFIGURE_SKILL: &str =
        include_str!("../../resources/skills/atlas-self-configure/SKILL.md");

    #[test]
    fn every_known_setting_key_is_documented_in_the_configuration_reference() {
        for key in known_settings_keys() {
            assert!(CONFIGURATION_DOC.contains(key), "docs/reference/configuration.md is missing `{key}`");
        }
    }

    /// `MIN_UI_SCALE`/`MAX_UI_SCALE` are duplicated in `ui-scale.ts`, which
    /// clamps the same field from the frontend end. Nothing but this test
    /// stops the two drifting apart, and drift means the UI happily offers a
    /// zoom level Rust then rejects (or vice versa).
    #[test]
    fn ui_scale_bounds_match_the_frontend_clamp() {
        const UI_SCALE_TS: &str = include_str!("../../../src/features/settings/lib/ui-scale.ts");
        assert!(
            UI_SCALE_TS.contains(&format!("export const MIN_SCALE = {MIN_UI_SCALE:.1};")),
            "ui-scale.ts MIN_SCALE has drifted from MIN_UI_SCALE ({MIN_UI_SCALE})"
        );
        assert!(
            UI_SCALE_TS.contains(&format!("export const MAX_SCALE = {MAX_UI_SCALE:.1};")),
            "ui-scale.ts MAX_SCALE has drifted from MAX_UI_SCALE ({MAX_UI_SCALE})"
        );
    }

    /// `ConfigStatus` serializes straight to the frontend now that the
    /// mirrored `ConfigStatusWire` is gone; this pins the exact discriminated
    /// union `atlas-config-api.ts` destructures.
    #[test]
    fn config_status_serializes_as_the_frontend_union() {
        assert_eq!(
            serde_json::to_value(ConfigStatus::Ok).unwrap(),
            serde_json::json!({ "status": "ok" })
        );
        assert_eq!(
            serde_json::to_value(ConfigStatus::UsingDefaults { error: "boom".into() }).unwrap(),
            serde_json::json!({ "status": "usingDefaults", "error": "boom" })
        );
        assert_eq!(
            serde_json::to_value(ConfigStatus::UsingLastKnownGood { error: "boom".into() }).unwrap(),
            serde_json::json!({ "status": "usingLastKnownGood", "error": "boom" })
        );
    }

    /// A file that exists but cannot be PARSED must not be reported as a
    /// completed migration: `state.json.settings` is still the only surviving
    /// copy of the user's preferences at that point, and the marker is what
    /// authorizes `AppState::save` to drop it.
    #[test]
    fn a_malformed_existing_config_does_not_report_migration_done() {
        let (_dir, path) = tmp_config_path();
        fs::write(&path, "this is not { valid toml").unwrap();
        let legacy = serde_json::json!({ "enterToSend": false, "gitBlameInline": false });

        let outcome = bootstrap_at(path, false, Some(legacy));

        assert!(
            !outcome.mark_migrated,
            "a malformed config.toml must not retire the legacy settings"
        );
        assert!(matches!(outcome.manager.status(), ConfigStatus::UsingDefaults { .. }));
        // Boot never blocks: something usable is always effective. Which
        // settings those are is the subject of
        // `a_broken_config_falls_back_to_the_legacy_settings_not_compiled_defaults`.
        assert!(!outcome.manager.effective().enter_to_send);
    }

    /// The same guarantee for a file that cannot be READ at all (here: a
    /// directory sitting where the config should be — deterministic on every
    /// platform and every uid, unlike a chmod-based test). This is the case
    /// `load_at` used to fold into "file absent" and report as healthy.
    #[test]
    fn an_unreadable_existing_config_does_not_report_migration_done() {
        let (_dir, path) = tmp_config_path();
        fs::create_dir_all(&path).unwrap();

        let outcome = bootstrap_at(path, false, Some(serde_json::json!({ "enterToSend": false })));

        assert!(
            !outcome.mark_migrated,
            "an unreadable config.toml must not retire the legacy settings"
        );
        assert!(
            matches!(outcome.manager.status(), ConfigStatus::UsingDefaults { .. }),
            "an unreadable file must be flagged, not reported as Ok"
        );
    }

    /// Preserving `state.json.settings` is only half the guarantee — while the
    /// file is broken those settings must actually be in EFFECT, or the user
    /// spends the session on compiled defaults (telemetry back on) with their
    /// real preferences sitting unused on disk.
    #[test]
    fn a_broken_config_falls_back_to_the_legacy_settings_not_compiled_defaults() {
        let (_dir, path) = tmp_config_path();
        fs::write(&path, "this is not { valid toml").unwrap();
        let legacy = serde_json::json!({ "shareTelemetry": false, "uiScale": 1.25 });

        let outcome = bootstrap_at(path, false, Some(legacy));

        assert!(!outcome.mark_migrated);
        assert!(!outcome.manager.effective().share_telemetry, "the user's opt-out must survive");
        assert_eq!(outcome.manager.effective().ui_scale, 1.25);
        assert!(matches!(outcome.manager.status(), ConfigStatus::UsingDefaults { .. }));
    }

    /// ...but only before migration is recorded. Once the marker is set, the
    /// legacy object is stale by definition and must not be resurrected.
    #[test]
    fn a_broken_config_after_migration_does_not_resurrect_legacy_settings() {
        let (_dir, path) = tmp_config_path();
        fs::write(&path, "this is not { valid toml").unwrap();
        let legacy = serde_json::json!({ "shareTelemetry": false });

        let outcome = bootstrap_at(path, true, Some(legacy));

        assert!(
            outcome.manager.effective().share_telemetry,
            "a post-migration boot must not read state.json.settings again"
        );
    }

    /// The healthy path still marks migration done, so the two tests above
    /// can't be satisfied by simply never setting the marker.
    #[test]
    fn a_readable_existing_config_reports_migration_done() {
        let (_dir, path) = tmp_config_path();
        fs::write(&path, "schemaVersion = 1\n\n[settings]\nenterToSend = false\n").unwrap();

        let outcome = bootstrap_at(path, false, None);

        assert!(outcome.mark_migrated);
        assert_eq!(outcome.manager.status(), &ConfigStatus::Ok);
        assert!(!outcome.manager.effective().enter_to_send);
    }

    /// The external-edit half of the round trip: a valid edit made outside
    /// Atlas is adopted wholesale and advances the generation, which is what
    /// the frontend mirrors so its next write isn't a spurious conflict.
    #[test]
    fn reload_adopts_a_valid_external_edit_and_bumps_the_generation() {
        let (_dir, path) = tmp_config_path();
        let mut mgr =
            ConfigManager::create_fresh_with(path.clone(), AppSettings::default()).unwrap();
        let before = mgr.generation();
        assert!(mgr.effective().git_blame_inline);

        fs::write(
            &path,
            "schemaVersion = 1\n\n# hand-written\n[settings]\ngitBlameInline = false\nuiScale = 1.25\n",
        )
        .unwrap();

        assert!(mgr.reload_from_disk().unwrap(), "a changed, valid file is adopted");
        assert!(!mgr.effective().git_blame_inline);
        assert_eq!(mgr.effective().ui_scale, 1.25);
        assert_eq!(mgr.generation(), before + 1);
        assert_eq!(mgr.status(), &ConfigStatus::Ok);

        // Idempotent: re-reading the same bytes is a no-op, not another bump.
        assert!(!mgr.reload_from_disk().unwrap());
        assert_eq!(mgr.generation(), before + 1);
    }

    /// The compare-and-swap that guards the merge-then-rename window: if the
    /// file moved since the base this patch was computed against, the write is
    /// refused outright rather than clobbering the other writer's content
    /// (comments and unknown keys included).
    #[test]
    fn a_write_whose_base_went_stale_is_refused_rather_than_clobbering() {
        let (_dir, path) = tmp_config_path();
        let mgr = ConfigManager::create_fresh_with(path.clone(), AppSettings::default()).unwrap();

        // Simulate the racing writer landing inside the window: disk now holds
        // something `mgr.last_raw` doesn't know about.
        let external =
            "schemaVersion = 1\n\n# someone else's comment\n[settings]\nenterToSend = false\n";
        fs::write(&path, external).unwrap();

        assert!(
            !mgr.write_if_unchanged("schemaVersion = 1\n").unwrap(),
            "a stale base must refuse to write"
        );
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            external,
            "the other writer's content survives untouched"
        );
    }

    /// ...and the same call writes when the base IS current, so the guard
    /// can't be satisfied by refusing everything.
    #[test]
    fn a_write_on_a_current_base_goes_through() {
        let (_dir, path) = tmp_config_path();
        let mgr = ConfigManager::create_fresh_with(path.clone(), AppSettings::default()).unwrap();

        let text = "schemaVersion = 1\n\n[settings]\nenterToSend = false\n";
        assert!(mgr.write_if_unchanged(text).unwrap());
        assert_eq!(fs::read_to_string(&path).unwrap(), text);
    }

    fn temp_files_beside(path: &Path) -> Vec<String> {
        fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".tmp."))
            .collect()
    }

    /// `write_atomic` must not leave its `.tmp.<uuid>` sibling behind when the
    /// swap FAILS — that's the path that used to litter, since the success
    /// path renames the temp away by construction. A directory sitting at the
    /// destination makes the rename fail deterministically.
    #[test]
    fn a_failed_atomic_write_cleans_up_its_temp_file() {
        let (_dir, path) = tmp_config_path();
        fs::create_dir_all(&path).unwrap();

        assert!(write_atomic(&path, "schemaVersion = 1\n").is_err(), "renaming onto a dir fails");
        assert!(
            temp_files_beside(&path).is_empty(),
            "a failed write left litter: {:?}",
            temp_files_beside(&path)
        );
    }

    /// ...and the success path both lands the content and leaves nothing.
    #[test]
    fn a_successful_atomic_write_lands_the_content_and_leaves_nothing() {
        let (_dir, path) = tmp_config_path();
        write_atomic(&path, "schemaVersion = 1\n").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "schemaVersion = 1\n");
        assert!(temp_files_beside(&path).is_empty());
    }

    /// The generated file is the schema documentation now — the skill points
    /// agents at the comments rather than carrying its own copy of the key
    /// table. So the guard that used to check SKILL.md checks the emitted file
    /// instead: a key with no `SETTINGS_DOCS` entry would ship undocumented and
    /// leave an agent with nothing to read.
    #[test]
    fn settings_docs_cover_every_setting() {
        let rendered = document_for(&AppSettings::default()).to_string();
        for key in known_settings_keys() {
            let documented = SETTINGS_DOCS
                .iter()
                .find(|(k, _)| *k == key)
                .is_some_and(|(_, comment)| comment.contains(key) || !comment.trim().is_empty());
            assert!(documented, "`{key}` has no SETTINGS_DOCS comment");
        }
        // And every one of those comments actually reaches the file.
        for (_, comment) in SETTINGS_DOCS {
            let first = comment.lines().next().expect("comments are non-empty");
            assert!(
                rendered.contains(first.trim()),
                "this comment never made it into config.toml: {first}"
            );
        }
    }

    /// The skill must NOT re-document the keys — that duplication is what the
    /// comments replaced, and a stale copy is worse than none. It should still
    /// tell the agent where the file is.
    #[test]
    fn the_self_configure_skill_defers_to_the_files_own_comments() {
        let named: Vec<_> =
            known_settings_keys().filter(|key| SELF_CONFIGURE_SKILL.contains(*key)).collect();
        // A worked example may name a key or two; a table of them is the
        // duplication the file's own comments replaced, and a stale copy of
        // the schema is worse for an agent than no copy at all.
        assert!(
            named.len() < 4,
            "SKILL.md is re-documenting the schema instead of deferring to config.toml: {named:?}"
        );
        assert!(SELF_CONFIGURE_SKILL.contains(CONFIG_FILE_NAME));
    }

    /// A key absent from the generated output (`updaterIgnoredVersion` when
    /// unset — TOML has no null) must still get its comment into the file,
    /// carried down onto the next key that IS present. Otherwise the one key
    /// whose *absence* is meaningful is the one nothing explains.
    #[test]
    fn a_key_that_serializes_to_nothing_still_gets_documented() {
        let rendered = document_for(&AppSettings::default()).to_string();
        assert!(
            !rendered.contains("updaterIgnoredVersion ="),
            "unset means the key is absent, not written as a sentinel"
        );
        assert!(
            rendered.contains("# updaterIgnoredVersion:"),
            "its comment must survive even though the key didn't"
        );
        // Sitting immediately above the key that follows it in field order.
        let comment_at = rendered.find("# updaterIgnoredVersion:").unwrap();
        let next_key_at = rendered.find("enterToSend =").unwrap();
        assert!(comment_at < next_key_at);
    }

    /// The annotated file must still be a valid, loadable config — comments
    /// are decoration, not a second schema.
    #[test]
    fn the_annotated_file_round_trips() {
        let (_dir, path) = tmp_config_path();
        let settings = AppSettings { ui_scale: 1.25, enter_to_send: false, ..Default::default() };
        let rendered = document_for(&settings).to_string();

        let mgr = ConfigManager::from_raw(path, &rendered).expect("the generated file parses");
        assert_eq!(mgr.effective(), &settings);
        assert!(mgr.unknown_keys().is_empty(), "comments must not read as unknown keys");
    }
}
