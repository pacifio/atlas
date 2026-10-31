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

use std::collections::BTreeMap;
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

/// Directory under `~/.config` (or `$XDG_CONFIG_HOME`) holding
/// [`CONFIG_FILE_NAME`]. Named for the product, not the bundle id: a path a
/// user types should read `atlas`, not `dev.atlas.ide`. `atlas-dev` under the
/// dev profile, so a source build never edits the released app's settings.
pub fn config_dir_name() -> &'static str {
    atlas_profile::config_dir_name()
}

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

/// Adaptive next-step suggestion chips in the agent chat's per-turn card:
/// exactly `agent` or `off`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AdaptiveSuggestions {
    #[default]
    Agent,
    Off,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    #[default]
    System,
    Dark,
    Light,
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
        match value
            .as_str()
            .filter(|value| atlas_theme::is_safe_css_value(value))
        {
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
        let dotted = if prefix.is_empty() {
            key.clone()
        } else {
            format!("{prefix}.{key}")
        };
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
                match style["color"]
                    .as_str()
                    .filter(|color| atlas_theme::is_safe_css_value(color))
                {
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

/// What picking another agent does to a chat that already has a conversation.
/// A session is paired to one agent, so every option starts a new session; they
/// differ in what happens to the one on screen. An empty chat always just
/// switches in place, and a running one always gets a new tab.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentSwitchBehavior {
    /// Keep the conversation and open the new agent in a new tab.
    NewTab,
    /// Switch in the same tab and attach the conversation to the composer as a
    /// past-session mention, so the new agent receives it with the next message.
    Handoff,
    /// Switch in the same tab and start over; the conversation stays in history.
    /// The default, and how switching always worked before this setting existed.
    #[default]
    Reset,
}

/// How wide the chat transcript and composer column may grow.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChatWidth {
    #[default]
    Normal,
    Wide,
    Full,
}

/// Clock style for every time of day Atlas shows. `System` follows the OS
/// locale.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum TimeFormat {
    #[default]
    #[serde(rename = "system")]
    System,
    #[serde(rename = "12h")]
    TwelveHour,
    #[serde(rename = "24h")]
    TwentyFourHour,
}

/// Colours for added and removed lines in every diff. `Theme` uses the
/// theme's green and red; `BlueOrange` swaps them for blue and orange, which
/// stay apart under red-green colour blindness.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiffPalette {
    #[default]
    Theme,
    BlueOrange,
}

/// The order of chats in the session sidebar.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SidebarSort {
    #[default]
    Recent,
    Created,
}

/// The merge method a pull request's Merge button starts on. `Last` reuses
/// whatever was picked most recently on this device; the others name one.
/// A method the repository does not allow falls back to one it does.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PullRequestMergeMethod {
    #[default]
    Last,
    Merge,
    Squash,
    Rebase,
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
    /// On project open, keep Atlas's directory out of the project's version
    /// control: `.atlas/` is listed in the project's `.gitignore` (creating
    /// the file if needed), while the dev profile lists its `.atlas-dev/` in
    /// `.git/info/exclude` instead (see `commands::fs::ensure_atlas_gitignore`).
    /// No-op on non-git projects. Default ON because Atlas writes caches /
    /// state there that don't belong in version control.
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
    /// The external editor "Open in <editor>" uses: an editor id from
    /// `commands::external_editor`, `"system"` for the OS's own app, or empty
    /// for the first editor detected. Files outside the project go to the
    /// system app unless this names an editor.
    #[serde(default)]
    pub preferred_editor: String,
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
    /// The theme used while Atlas is light. One theme covers Atlas chrome,
    /// editor, terminal, diffs and syntax.
    #[serde(default = "default_theme")]
    pub theme_light: String,
    /// The theme used while Atlas is dark.
    #[serde(default = "default_theme")]
    pub theme_dark: String,
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
    /// "agent" (default) asks the coding agent to end each reply with a hidden
    /// `<next_steps>` block; "off" disables it.
    #[serde(default)]
    pub adaptive_suggestions: AdaptiveSuggestions,
    /// What switching agents does to a chat with a conversation in it.
    #[serde(default)]
    pub agent_switch_behavior: AgentSwitchBehavior,
    /// Before switching agents on a chat with a conversation, send the agent
    /// being left `/remember` (when it advertises that command) and wait for
    /// it. Off by default: it costs the user a turn.
    #[serde(default)]
    pub remember_before_switch: bool,
    /// Inline Git blame in the code editor. Default ON; when off the editor
    /// doesn't even load the extension (no blame IPC).
    #[serde(default = "default_true")]
    pub git_blame_inline: bool,
    /// Background `git fetch` of the open project — on activation, on window
    /// focus, and every few minutes — so ahead/behind reflects the remote.
    /// Default ON. See `crate::commands::git_autofetch`.
    #[serde(default = "default_true")]
    pub git_auto_fetch: bool,
    /// Keep the computer awake while an Atlas agent is actively running.
    /// Default OFF. See `crate::keep_awake`.
    #[serde(default)]
    pub keep_awake_while_running: bool,
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
    /// Mirror the active project's convention files (`CLAUDE.md`,
    /// `.claude/rules/`) into a marked block of its `AGENTS.md`, kept current
    /// as they change, for any agent that reads `AGENTS.md`. Off by default:
    /// it writes into the user's repository. Switching it off takes the block
    /// back out. See `commands::instruction_sync`.
    #[serde(default)]
    pub instruction_sync: bool,
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
    /// Let agents search code through the code tool server (ADR-0015):
    /// `grep` and `find_files` over the session's directory. Off: sessions
    /// are not offered the server and every call in a running one is
    /// refused. Default ON.
    #[serde(default = "default_true")]
    pub agent_code_tools: bool,
    /// Once a day, with new sessions to read, ask the memory model (the same
    /// route and consent as extraction) to propose memory changes. Proposals
    /// wait in the Memory panel's Review tab; nothing is applied without the
    /// user. Default OFF.
    #[serde(default)]
    pub memory_dreams: bool,
    /// Keep a read-only Agent Memory Repo mirror of each project's active
    /// memory in a local git repository outside the project. Default OFF.
    #[serde(default)]
    pub memory_repo_mirror: bool,
    /// Atlas's shared memory is the only memory in Atlas sessions: Claude
    /// Code starts with its auto memory off and Codex with its memories off.
    /// Off: each agent also keeps its own. Default ON.
    #[serde(default = "default_true")]
    pub atlas_only_memory: bool,
    /// A successful command shorter than this never notifies (milliseconds).
    #[serde(default = "default_terminal_notify_min_duration_ms")]
    pub terminal_notify_min_duration_ms: u32,
    /// Notifications master switch: off silences every kind except sign-in problems.
    #[serde(default = "default_true")]
    pub notifications_enabled: bool,
    /// OS banner for "needs you" notifications (permission, question, sign-in, terminal input).
    #[serde(default = "default_true")]
    pub notify_needs_you_native: bool,
    /// Sound for "needs you" notifications.
    #[serde(default = "default_true")]
    pub notify_needs_you_sound: bool,
    /// OS banner for outcome notifications (a turn or command finished or failed).
    #[serde(default = "default_true")]
    pub notify_outcome_native: bool,
    /// Sound for outcome notifications.
    #[serde(default = "default_true")]
    pub notify_outcome_sound: bool,
    /// OS banner for warnings (context nearly full, rate limit, retrying, agent stopped).
    #[serde(default)]
    pub notify_warning_native: bool,
    /// Sound for warnings.
    #[serde(default)]
    pub notify_warning_sound: bool,
    /// OS banner for team notifications (Chat DMs and @mentions).
    #[serde(default = "default_true")]
    pub notify_team_native: bool,
    /// Sound for team notifications.
    #[serde(default = "default_true")]
    pub notify_team_sound: bool,
    /// Show Allow once / Deny on permission banners.
    #[serde(default = "default_true")]
    pub notify_permission_actions: bool,
    /// Notification kinds the user switched off in Settings (kind ids from the frontend catalog). Unknown ids are ignored; a kind that cannot be silenced ignores its entry.
    #[serde(default)]
    pub notify_disabled_kinds: Vec<String>,
    /// An agent turn that finished faster than this stays quiet (milliseconds); 0 = off.
    #[serde(default)]
    pub notify_agent_min_duration_ms: u32,
    /// Models starred in the composer's model picker, as `agentType:modelId`. Unknown entries are ignored.
    #[serde(default)]
    pub favorite_models: Vec<String>,
    /// Ask before deleting a session from the sidebar or history. Settling
    /// never asks: it can be undone. Default ON.
    #[serde(default = "default_true")]
    pub confirm_delete_chat: bool,
    /// Ask before quitting while an agent is mid-turn. A second Quit while
    /// the question is open quits anyway. Default ON. See `commands::quit_guard`.
    #[serde(default = "default_true")]
    pub confirm_quit_while_running: bool,
    /// Continue a turn a quit, crash or update cut short at the next launch.
    /// Default ON. See `commands::restart_continuation`.
    #[serde(default = "default_true")]
    pub continue_sessions_after_restart: bool,
    /// New sessions start on the agent last picked in a composer (the
    /// frontend keeps it). Default ON; `default_agent` is the fallback.
    #[serde(default = "default_true")]
    pub new_session_uses_last_agent: bool,
    /// The agent a new chat starts with: `atlas-agent` or an installed ACP
    /// agent's id. One that isn't installed falls back to Atlas Agent.
    #[serde(default = "default_agent")]
    pub default_agent: String,
    /// Chat column width.
    #[serde(default)]
    pub chat_width: ChatWidth,
    /// Wrap long lines in file views and diffs; off scrolls them sideways.
    #[serde(default = "default_true")]
    pub word_wrap: bool,
    /// Session sidebar order.
    #[serde(default)]
    pub sidebar_sort: SidebarSort,
    /// Days a session may sit idle before it is settled on its own; 0 turns
    /// auto-settling off.
    #[serde(default = "default_auto_settle_after_days")]
    pub auto_settle_after_days: u32,
    /// 12- or 24-hour clock, or the system's.
    #[serde(default)]
    pub time_format: TimeFormat,
    /// Interface font family (a CSS font-family list); empty uses the system font.
    #[serde(default)]
    pub ui_font_family: String,
    /// Code font family for the editor, diffs and chat code (and the terminal,
    /// unless `terminal_font_family` is set); empty uses the default.
    #[serde(default)]
    pub code_font_family: String,
    /// The chat composer's font, as a CSS font-family list. Empty follows
    /// `ui_font_family`.
    #[serde(default)]
    pub composer_font_family: String,
    /// The terminal's font, as a CSS font-family list. Empty follows
    /// `code_font_family`.
    #[serde(default)]
    pub terminal_font_family: String,
    /// Editor font size in pixels.
    #[serde(default = "default_font_size")]
    pub editor_font_size: u32,
    /// Terminal font size in pixels.
    #[serde(default = "default_font_size")]
    pub terminal_font_size: u32,
    /// Hide whitespace-only changes in read-only diffs. Never applied where a
    /// diff can be staged, since a patch without whitespace no longer applies.
    #[serde(default)]
    pub diff_ignore_whitespace: bool,
    /// Diffs open with every file collapsed to its header. Default ON: the
    /// review diff opens as a list of its files, each expanded on a click.
    #[serde(default = "default_true")]
    pub diff_files_collapsed: bool,
    /// Diff colours.
    #[serde(default)]
    pub diff_palette: DiffPalette,
    /// Contrast of borders and secondary text, in percent of the theme's own.
    #[serde(default = "default_interface_contrast")]
    pub interface_contrast: u32,
    /// The turn rail: one tick per turn down the left edge of a session's
    /// transcript, with a preview on hover and a jump on click. Purely visual,
    /// so default ON.
    #[serde(default = "default_true")]
    pub show_turn_rail: bool,
    /// A session whose linked pull request merges is settled, when the merge
    /// came after the user's last interaction with it; a closed pull request
    /// always settles its session. Read by the pull request watch (Rust).
    #[serde(default = "default_true")]
    pub auto_settle_on_merge: bool,
    /// Idle auto-settling (`auto_settle_after_days`) leaves a session with a
    /// linked pull request alone.
    #[serde(default = "default_true")]
    pub auto_settle_keep_pull_requests: bool,
    /// A watched pull request may wake its session's agent with an update
    /// (checks, reviews, conflicts). Off: watches still track, never prompt.
    #[serde(default = "default_true")]
    pub pull_request_watch_wakes: bool,
    /// A pull request link in a session opens in Atlas's pull request tab
    /// when it belongs to the session's repository; off opens the browser.
    #[serde(default = "default_true")]
    pub pull_request_links_open_in_app: bool,
    /// The merge method a pull request starts on. Per project.
    #[serde(default)]
    pub pull_request_merge_method: PullRequestMergeMethod,
    /// Strip agent credit trailers (`Co-Authored-By: Claude …`, "Generated
    /// with …") from merge and squash messages. Per project. Default OFF.
    #[serde(default)]
    pub remove_agent_credits_on_merge: bool,
    /// The pull request Guide tab and its agent-written review tours.
    #[serde(default = "default_true")]
    pub pull_request_guide_enabled: bool,
    /// The agent that writes guides; empty uses `default_agent`.
    #[serde(default)]
    pub pull_request_guide_agent: String,
    /// The model the guide's agent runs on; empty is the agent's own default.
    #[serde(default)]
    pub pull_request_guide_model: String,
    /// The user's preferences for guides, appended to the guide prompt.
    #[serde(default)]
    pub pull_request_guide_instructions: String,
    /// Scan each new Checkpoint's commit with the local security layers
    /// (`commands::security_scan`), storing results without showing them:
    /// shadow mode for ATL-985. Default **OFF**.
    #[serde(default)]
    pub security_scan: bool,
}

/// The longest `pullRequestGuideInstructions` accepted, in bytes.
pub const MAX_GUIDE_INSTRUCTIONS: usize = 4_000;

pub const MIN_INTERFACE_CONTRAST: u32 = 50;
pub const MAX_INTERFACE_CONTRAST: u32 = 200;

fn default_interface_contrast() -> u32 {
    100
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

pub fn default_agent() -> String {
    "atlas-agent".to_string()
}

pub const DEFAULT_FONT_SIZE: u32 = 13;
pub const MIN_FONT_SIZE: u32 = 8;
pub const MAX_FONT_SIZE: u32 = 32;

pub fn default_font_size() -> u32 {
    DEFAULT_FONT_SIZE
}

pub fn default_ui_scale() -> f32 {
    1.0
}

pub const DEFAULT_AUTO_SETTLE_AFTER_DAYS: u32 = 3;
/// 0 is "off": the idle sweep skips its pass.
pub const MIN_AUTO_SETTLE_AFTER_DAYS: u32 = 0;
pub const MAX_AUTO_SETTLE_AFTER_DAYS: u32 = 90;

pub fn default_auto_settle_after_days() -> u32 {
    DEFAULT_AUTO_SETTLE_AFTER_DAYS
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
            preferred_editor: String::new(),
            ui_scale: default_ui_scale(),
            share_telemetry: true,
            link_telemetry_to_account: true,
            embedding_model_id: default_embedding_model(),
            theme_light: default_theme(),
            theme_dark: default_theme(),
            theme_mode: ThemeMode::default(),
            theme_overrides: ThemeOverride::default(),
            icon_theme: default_icon_theme(),
            app_icon: default_app_icon(),
            adaptive_suggestions: AdaptiveSuggestions::default(),
            agent_switch_behavior: AgentSwitchBehavior::default(),
            remember_before_switch: false,
            git_blame_inline: true,
            git_auto_fetch: true,
            keep_awake_while_running: false,
            auto_update: true,
            curated_plugin_sync: false,
            instruction_sync: false,
            updater_ignored_version: None,
            enter_to_send: true,
            agent_ui_navigation: true,
            agent_org_access: true,
            agent_code_tools: true,
            memory_dreams: false,
            memory_repo_mirror: false,
            atlas_only_memory: true,
            terminal_notify_min_duration_ms: default_terminal_notify_min_duration_ms(),
            notifications_enabled: true,
            notify_needs_you_native: true,
            notify_needs_you_sound: true,
            notify_outcome_native: true,
            notify_outcome_sound: true,
            notify_warning_native: false,
            notify_warning_sound: false,
            notify_team_native: true,
            notify_team_sound: true,
            notify_permission_actions: true,
            notify_disabled_kinds: Vec::new(),
            notify_agent_min_duration_ms: 0,
            favorite_models: Vec::new(),
            confirm_delete_chat: true,
            confirm_quit_while_running: true,
            continue_sessions_after_restart: true,
            new_session_uses_last_agent: true,
            default_agent: default_agent(),
            chat_width: ChatWidth::default(),
            word_wrap: true,
            sidebar_sort: SidebarSort::default(),
            auto_settle_after_days: DEFAULT_AUTO_SETTLE_AFTER_DAYS,
            time_format: TimeFormat::default(),
            ui_font_family: String::new(),
            code_font_family: String::new(),
            composer_font_family: String::new(),
            terminal_font_family: String::new(),
            editor_font_size: DEFAULT_FONT_SIZE,
            terminal_font_size: DEFAULT_FONT_SIZE,
            diff_ignore_whitespace: false,
            diff_files_collapsed: true,
            diff_palette: DiffPalette::default(),
            interface_contrast: default_interface_contrast(),
            show_turn_rail: true,
            auto_settle_on_merge: true,
            auto_settle_keep_pull_requests: true,
            pull_request_watch_wakes: true,
            pull_request_links_open_in_app: true,
            pull_request_merge_method: PullRequestMergeMethod::default(),
            remove_agent_credits_on_merge: false,
            pull_request_guide_enabled: true,
            pull_request_guide_agent: String::new(),
            pull_request_guide_model: String::new(),
            pull_request_guide_instructions: String::new(),
            security_scan: false,
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
# Settings — both write to it, and Atlas picks up external edits live. A change
# takes effect at once unless the key's comment says otherwise.
#
# Your comments, formatting, and any keys Atlas doesn't recognize survive its
# own writes. An invalid value is rejected whole: Atlas keeps running on the
# last settings that loaded cleanly, shows the error in Settings, and leaves
# this file exactly as you wrote it.
";

const SCHEMA_VERSION_DOC: &str = "
# Format version of this file. Atlas manages it; leave it alone.
";

// `SETTINGS_DOCS`: camelCase key → the comment written directly above it in a
// generated `config.toml`. Generated from `src-tauri/settings-registry.toml` by
// `bun run settings:gen`; edit that file, never the `.gen.rs`.
//
// This is the schema documentation. The `atlas-self-configure` skill
// deliberately carries no copy of it: the agent reads the real file, which
// explains itself, rather than a table that can drift from the code.
// `the_settings_registry_matches_app_settings` fails the build if a field has
// no entry, so nothing ships undocumented.
//
// Order matches `AppSettings`' field order, and so the generated file's. That
// matters for a key that serializes to nothing (`updaterIgnoredVersion` when
// unset): its comment is carried down onto the next key that IS present,
// rather than dropped.
include!("settings_docs.gen.rs");

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
    if settings.notify_agent_min_duration_ms > MAX_TERMINAL_NOTIFY_MS {
        return Err(ValidationIssue {
            key: "notifyAgentMinDurationMs",
            message: format!(
                "must be between 0 and {MAX_TERMINAL_NOTIFY_MS}, got {}",
                settings.notify_agent_min_duration_ms
            ),
        });
    }
    if settings.embedding_model_id.trim().is_empty() {
        return Err(ValidationIssue {
            key: "embeddingModelId",
            message: "must not be empty".to_string(),
        });
    }
    for (key, value) in [
        ("themeLight", &settings.theme_light),
        ("themeDark", &settings.theme_dark),
    ] {
        if value.trim().is_empty() {
            return Err(ValidationIssue {
                key,
                message: "must not be empty".to_string(),
            });
        }
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
    for (key, size) in [
        ("editorFontSize", settings.editor_font_size),
        ("terminalFontSize", settings.terminal_font_size),
    ] {
        if !(MIN_FONT_SIZE..=MAX_FONT_SIZE).contains(&size) {
            return Err(ValidationIssue {
                key,
                message: format!("must be between {MIN_FONT_SIZE} and {MAX_FONT_SIZE}, got {size}"),
            });
        }
    }
    if !(MIN_AUTO_SETTLE_AFTER_DAYS..=MAX_AUTO_SETTLE_AFTER_DAYS)
        .contains(&settings.auto_settle_after_days)
    {
        return Err(ValidationIssue {
            key: "autoSettleAfterDays",
            message: format!(
                "must be between {MIN_AUTO_SETTLE_AFTER_DAYS} and {MAX_AUTO_SETTLE_AFTER_DAYS}, got {}",
                settings.auto_settle_after_days
            ),
        });
    }
    if !(MIN_INTERFACE_CONTRAST..=MAX_INTERFACE_CONTRAST).contains(&settings.interface_contrast) {
        return Err(ValidationIssue {
            key: "interfaceContrast",
            message: format!(
                "must be between {MIN_INTERFACE_CONTRAST} and {MAX_INTERFACE_CONTRAST}, got {}",
                settings.interface_contrast
            ),
        });
    }
    // A font family is written into a CSS custom property; a brace or a
    // semicolon is never part of one and would end the declaration.
    for (key, family) in [
        ("uiFontFamily", &settings.ui_font_family),
        ("codeFontFamily", &settings.code_font_family),
        ("composerFontFamily", &settings.composer_font_family),
        ("terminalFontFamily", &settings.terminal_font_family),
    ] {
        if family.contains(['{', '}', ';', '<', '>']) || family.len() > 200 {
            return Err(ValidationIssue {
                key,
                message: "must be a CSS font-family list, such as \"Inter\", sans-serif"
                    .to_string(),
            });
        }
    }
    if settings.default_agent.trim().is_empty() {
        return Err(ValidationIssue {
            key: "defaultAgent",
            message: "must not be empty; use \"atlas-agent\" for Atlas Agent".to_string(),
        });
    }
    // An editor id is matched against the detected list, never run; anything
    // but a plain id cannot match one, so it is a typo worth reporting.
    if settings.preferred_editor.len() > 64
        || !settings
            .preferred_editor
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(ValidationIssue {
            key: "preferredEditor",
            message: "must be an editor id such as \"vscode\", \"system\", or empty".to_string(),
        });
    }
    // Names a file (`icons/app-icons/<id>.icns`); same reasoning as `iconTheme`.
    if !crate::app_icon::is_valid_id(&settings.app_icon) {
        return Err(ValidationIssue {
            key: "appIcon",
            message: "must be a plain id: letters, digits, dash or underscore".to_string(),
        });
    }
    // Compared against installed agent ids, never run.
    if settings.pull_request_guide_agent.len() > 64
        || settings
            .pull_request_guide_agent
            .chars()
            .any(|c| !(c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')))
    {
        return Err(ValidationIssue {
            key: "pullRequestGuideAgent",
            message: "must be an agent id such as \"claude-code\", or empty".to_string(),
        });
    }
    if settings.pull_request_guide_model.len() > 200
        || settings.pull_request_guide_model.contains(char::is_control)
    {
        return Err(ValidationIssue {
            key: "pullRequestGuideModel",
            message: "must be a model id on one line, at most 200 characters, or empty".to_string(),
        });
    }
    if settings.pull_request_guide_instructions.len() > MAX_GUIDE_INSTRUCTIONS {
        return Err(ValidationIssue {
            key: "pullRequestGuideInstructions",
            message: format!("must be at most {MAX_GUIDE_INSTRUCTIONS} bytes"),
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

/// The keys under `[settings]` right now, to tell which a patch then adds.
pub(crate) fn settings_keys_in(document: &toml_edit::DocumentMut) -> Vec<String> {
    document
        .get("settings")
        .and_then(|i| i.as_table())
        .map(|table| table.iter().map(|(k, _)| k.to_string()).collect())
        .unwrap_or_default()
}

/// Give each key a patch just added to an existing file the comment a fresh
/// file would have had above it.
///
/// Comments are otherwise only written when Atlas generates the whole file,
/// so a long-lived `config.toml` used to grow keys added in later releases
/// with nothing explaining them — the file stopped documenting itself the
/// first time a new setting was touched. Keys that were already present keep
/// whatever decor they have: a user's own comment is never replaced.
pub(crate) fn document_added_keys(document: &mut toml_edit::DocumentMut, present: &[String]) {
    let Some(table) = document.get_mut("settings").and_then(|i| i.as_table_mut()) else {
        return;
    };
    let added: Vec<String> = table
        .iter()
        .map(|(k, _)| k.to_string())
        .filter(|k| !present.contains(k))
        .collect();
    for key in added {
        let Some((_, comment)) = SETTINGS_DOCS.iter().find(|(known, _)| *known == key) else {
            continue;
        };
        if let Some(mut handle) = table.key_mut(&key) {
            handle.leaf_decor_mut().set_prefix(format!("\n{comment}\n"));
        }
    }
}

fn document_for(settings: &AppSettings) -> toml_edit::DocumentMut {
    let file = AtlasConfigFile {
        schema_version: CONFIG_SCHEMA_VERSION,
        settings: settings.clone(),
    };
    let text = toml::to_string_pretty(&file).expect("AppSettings always serializes to TOML");
    annotate(&text)
        .parse()
        .expect("freshly-generated TOML always parses")
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
    pub preferred_editor: Option<String>,
    pub ui_scale: Option<f32>,
    pub share_telemetry: Option<bool>,
    pub link_telemetry_to_account: Option<bool>,
    pub embedding_model_id: Option<String>,
    pub theme_light: Option<String>,
    pub theme_dark: Option<String>,
    pub theme_mode: Option<ThemeMode>,
    pub theme_overrides: Option<ThemeOverride>,
    pub icon_theme: Option<String>,
    pub app_icon: Option<String>,
    pub adaptive_suggestions: Option<AdaptiveSuggestions>,
    pub agent_switch_behavior: Option<AgentSwitchBehavior>,
    pub remember_before_switch: Option<bool>,
    pub git_blame_inline: Option<bool>,
    pub git_auto_fetch: Option<bool>,
    pub keep_awake_while_running: Option<bool>,
    pub auto_update: Option<bool>,
    pub curated_plugin_sync: Option<bool>,
    pub instruction_sync: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub updater_ignored_version: Option<Option<String>>,
    pub enter_to_send: Option<bool>,
    pub agent_ui_navigation: Option<bool>,
    pub agent_org_access: Option<bool>,
    pub agent_code_tools: Option<bool>,
    pub memory_dreams: Option<bool>,
    pub memory_repo_mirror: Option<bool>,
    pub atlas_only_memory: Option<bool>,
    pub terminal_notify_min_duration_ms: Option<u32>,
    pub notifications_enabled: Option<bool>,
    pub notify_needs_you_native: Option<bool>,
    pub notify_needs_you_sound: Option<bool>,
    pub notify_outcome_native: Option<bool>,
    pub notify_outcome_sound: Option<bool>,
    pub notify_warning_native: Option<bool>,
    pub notify_warning_sound: Option<bool>,
    pub notify_team_native: Option<bool>,
    pub notify_team_sound: Option<bool>,
    pub notify_permission_actions: Option<bool>,
    pub notify_disabled_kinds: Option<Vec<String>>,
    pub notify_agent_min_duration_ms: Option<u32>,
    pub favorite_models: Option<Vec<String>>,
    pub confirm_delete_chat: Option<bool>,
    pub confirm_quit_while_running: Option<bool>,
    pub continue_sessions_after_restart: Option<bool>,
    pub new_session_uses_last_agent: Option<bool>,
    pub default_agent: Option<String>,
    pub chat_width: Option<ChatWidth>,
    pub word_wrap: Option<bool>,
    pub sidebar_sort: Option<SidebarSort>,
    pub auto_settle_after_days: Option<u32>,
    pub time_format: Option<TimeFormat>,
    pub ui_font_family: Option<String>,
    pub code_font_family: Option<String>,
    pub composer_font_family: Option<String>,
    pub terminal_font_family: Option<String>,
    pub editor_font_size: Option<u32>,
    pub terminal_font_size: Option<u32>,
    pub diff_ignore_whitespace: Option<bool>,
    pub diff_files_collapsed: Option<bool>,
    pub diff_palette: Option<DiffPalette>,
    pub interface_contrast: Option<u32>,
    pub show_turn_rail: Option<bool>,
    pub auto_settle_on_merge: Option<bool>,
    pub auto_settle_keep_pull_requests: Option<bool>,
    pub pull_request_watch_wakes: Option<bool>,
    pub pull_request_links_open_in_app: Option<bool>,
    pub pull_request_merge_method: Option<PullRequestMergeMethod>,
    pub remove_agent_credits_on_merge: Option<bool>,
    pub pull_request_guide_enabled: Option<bool>,
    pub pull_request_guide_agent: Option<String>,
    pub pull_request_guide_model: Option<String>,
    pub pull_request_guide_instructions: Option<String>,
    pub security_scan: Option<bool>,
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
        if let Some(v) = &self.preferred_editor {
            settings.preferred_editor = v.clone();
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
        if let Some(v) = &self.theme_light {
            settings.theme_light = v.clone();
        }
        if let Some(v) = &self.theme_dark {
            settings.theme_dark = v.clone();
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
        if let Some(v) = self.agent_switch_behavior {
            settings.agent_switch_behavior = v;
        }
        if let Some(v) = self.remember_before_switch {
            settings.remember_before_switch = v;
        }
        if let Some(v) = self.git_blame_inline {
            settings.git_blame_inline = v;
        }
        if let Some(v) = self.git_auto_fetch {
            settings.git_auto_fetch = v;
        }
        if let Some(v) = self.keep_awake_while_running {
            settings.keep_awake_while_running = v;
        }
        if let Some(v) = self.auto_update {
            settings.auto_update = v;
        }
        if let Some(v) = self.curated_plugin_sync {
            settings.curated_plugin_sync = v;
        }
        if let Some(v) = self.instruction_sync {
            settings.instruction_sync = v;
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
        if let Some(v) = self.agent_code_tools {
            settings.agent_code_tools = v;
        }
        if let Some(v) = self.memory_dreams {
            settings.memory_dreams = v;
        }
        if let Some(v) = self.memory_repo_mirror {
            settings.memory_repo_mirror = v;
        }
        if let Some(v) = self.atlas_only_memory {
            settings.atlas_only_memory = v;
        }
        if let Some(v) = self.terminal_notify_min_duration_ms {
            settings.terminal_notify_min_duration_ms = v;
        }
        if let Some(v) = self.notifications_enabled {
            settings.notifications_enabled = v;
        }
        if let Some(v) = self.notify_needs_you_native {
            settings.notify_needs_you_native = v;
        }
        if let Some(v) = self.notify_needs_you_sound {
            settings.notify_needs_you_sound = v;
        }
        if let Some(v) = self.notify_outcome_native {
            settings.notify_outcome_native = v;
        }
        if let Some(v) = self.notify_outcome_sound {
            settings.notify_outcome_sound = v;
        }
        if let Some(v) = self.notify_warning_native {
            settings.notify_warning_native = v;
        }
        if let Some(v) = self.notify_warning_sound {
            settings.notify_warning_sound = v;
        }
        if let Some(v) = self.notify_team_native {
            settings.notify_team_native = v;
        }
        if let Some(v) = self.notify_team_sound {
            settings.notify_team_sound = v;
        }
        if let Some(v) = self.notify_permission_actions {
            settings.notify_permission_actions = v;
        }
        if let Some(v) = &self.notify_disabled_kinds {
            settings.notify_disabled_kinds = v.clone();
        }
        if let Some(v) = &self.favorite_models {
            settings.favorite_models = v.clone();
        }
        if let Some(v) = self.notify_agent_min_duration_ms {
            settings.notify_agent_min_duration_ms = v;
        }
        macro_rules! copy {
            ($($field:ident),* $(,)?) => {
                $(if let Some(v) = &self.$field {
                    settings.$field = v.clone();
                })*
            };
        }
        copy!(
            confirm_delete_chat,
            confirm_quit_while_running,
            continue_sessions_after_restart,
            new_session_uses_last_agent,
            default_agent,
            chat_width,
            word_wrap,
            sidebar_sort,
            auto_settle_after_days,
            time_format,
            ui_font_family,
            code_font_family,
            composer_font_family,
            terminal_font_family,
            editor_font_size,
            terminal_font_size,
            diff_ignore_whitespace,
            diff_files_collapsed,
            diff_palette,
            interface_contrast,
            show_turn_rail,
            auto_settle_on_merge,
            auto_settle_keep_pull_requests,
            pull_request_watch_wakes,
            pull_request_links_open_in_app,
            pull_request_merge_method,
            remove_agent_credits_on_merge,
            pull_request_guide_enabled,
            pull_request_guide_agent,
            pull_request_guide_model,
            pull_request_guide_instructions,
            security_scan,
        );
    }

    /// Mutate only the touched keys of `doc["settings"]` — everything else
    /// (comments, ordering, unknown keys, untouched values) is left exactly
    /// as `toml_edit` parsed it.
    fn write_into(&self, doc: &mut toml_edit::DocumentMut) {
        if doc.get("settings").and_then(|i| i.as_table()).is_none() {
            doc["settings"] = toml_edit::Item::Table(toml_edit::Table::new());
        }
        let table = doc["settings"]
            .as_table_mut()
            .expect("just ensured settings is a table");

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
        set_bool!(git_auto_fetch, "gitAutoFetch");
        set_bool!(keep_awake_while_running, "keepAwakeWhileRunning");
        set_bool!(auto_update, "autoUpdate");
        set_bool!(curated_plugin_sync, "curatedPluginSync");
        set_bool!(instruction_sync, "instructionSync");
        set_bool!(remember_before_switch, "rememberBeforeSwitch");
        set_bool!(enter_to_send, "enterToSend");
        set_bool!(agent_ui_navigation, "agentUiNavigation");
        set_bool!(agent_org_access, "agentOrgAccess");
        set_bool!(agent_code_tools, "agentCodeTools");
        set_bool!(memory_dreams, "memoryDreams");
        set_bool!(memory_repo_mirror, "memoryRepoMirror");
        set_bool!(atlas_only_memory, "atlasOnlyMemory");
        set_bool!(notifications_enabled, "notificationsEnabled");
        set_bool!(notify_needs_you_native, "notifyNeedsYouNative");
        set_bool!(notify_needs_you_sound, "notifyNeedsYouSound");
        set_bool!(notify_outcome_native, "notifyOutcomeNative");
        set_bool!(notify_outcome_sound, "notifyOutcomeSound");
        set_bool!(notify_warning_native, "notifyWarningNative");
        set_bool!(notify_warning_sound, "notifyWarningSound");
        set_bool!(notify_team_native, "notifyTeamNative");
        set_bool!(notify_team_sound, "notifyTeamSound");
        set_bool!(notify_permission_actions, "notifyPermissionActions");
        set_bool!(confirm_delete_chat, "confirmDeleteChat");
        set_bool!(confirm_quit_while_running, "confirmQuitWhileRunning");
        set_bool!(
            continue_sessions_after_restart,
            "continueSessionsAfterRestart"
        );
        set_bool!(new_session_uses_last_agent, "newSessionUsesLastAgent");
        set_bool!(word_wrap, "wordWrap");
        set_bool!(diff_ignore_whitespace, "diffIgnoreWhitespace");
        set_bool!(diff_files_collapsed, "diffFilesCollapsed");
        set_bool!(show_turn_rail, "showTurnRail");
        set_bool!(auto_settle_on_merge, "autoSettleOnMerge");
        set_bool!(auto_settle_keep_pull_requests, "autoSettleKeepPullRequests");
        set_bool!(pull_request_watch_wakes, "pullRequestWatchWakes");
        set_bool!(pull_request_links_open_in_app, "pullRequestLinksOpenInApp");
        set_bool!(remove_agent_credits_on_merge, "removeAgentCreditsOnMerge");
        set_bool!(security_scan, "securityScan");
        set_bool!(pull_request_guide_enabled, "pullRequestGuideEnabled");
        macro_rules! set_str {
            ($field:ident, $key:literal) => {
                if let Some(v) = &self.$field {
                    table[$key] = toml_edit::value(v.as_str());
                }
            };
        }
        set_str!(preferred_editor, "preferredEditor");
        set_str!(default_agent, "defaultAgent");
        set_str!(ui_font_family, "uiFontFamily");
        set_str!(code_font_family, "codeFontFamily");
        set_str!(composer_font_family, "composerFontFamily");
        set_str!(terminal_font_family, "terminalFontFamily");
        set_str!(pull_request_guide_agent, "pullRequestGuideAgent");
        set_str!(pull_request_guide_model, "pullRequestGuideModel");
        set_str!(
            pull_request_guide_instructions,
            "pullRequestGuideInstructions"
        );
        // Enums are written as the exact string serde reads back.
        macro_rules! set_enum {
            ($field:ident, $key:literal) => {
                if let Some(v) = &self.$field {
                    table[$key] = toml_edit::value(enum_str(v));
                }
            };
        }
        set_enum!(chat_width, "chatWidth");
        set_enum!(sidebar_sort, "sidebarSort");
        set_enum!(time_format, "timeFormat");
        set_enum!(diff_palette, "diffPalette");
        set_enum!(pull_request_merge_method, "pullRequestMergeMethod");
        if let Some(v) = self.interface_contrast {
            table["interfaceContrast"] = toml_edit::value(i64::from(v));
        }
        if let Some(v) = self.editor_font_size {
            table["editorFontSize"] = toml_edit::value(i64::from(v));
        }
        if let Some(v) = self.auto_settle_after_days {
            table["autoSettleAfterDays"] = toml_edit::value(i64::from(v));
        }
        if let Some(v) = self.terminal_font_size {
            table["terminalFontSize"] = toml_edit::value(i64::from(v));
        }
        if let Some(v) = &self.notify_disabled_kinds {
            let mut arr = toml_edit::Array::new();
            for kind in v {
                arr.push(kind.as_str());
            }
            table["notifyDisabledKinds"] = toml_edit::value(arr);
        }
        if let Some(v) = self.notify_agent_min_duration_ms {
            table["notifyAgentMinDurationMs"] = toml_edit::value(i64::from(v));
        }
        if let Some(v) = &self.favorite_models {
            let mut arr = toml_edit::Array::new();
            for model in v {
                arr.push(model.as_str());
            }
            table["favoriteModels"] = toml_edit::value(arr);
        }
        if let Some(v) = self.terminal_notify_min_duration_ms {
            table["terminalNotifyMinDurationMs"] = toml_edit::value(i64::from(v));
        }

        if let Some(v) = self.ui_scale {
            table["uiScale"] = toml_edit::value(f64::from(v));
        }
        if let Some(v) = &self.embedding_model_id {
            table["embeddingModelId"] = toml_edit::value(v.as_str());
        }
        if let Some(v) = &self.theme_light {
            table["themeLight"] = toml_edit::value(v.as_str());
        }
        if let Some(v) = &self.theme_dark {
            table["themeDark"] = toml_edit::value(v.as_str());
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
        if let Some(v) = self.agent_switch_behavior {
            let s = match v {
                AgentSwitchBehavior::NewTab => "new-tab",
                AgentSwitchBehavior::Handoff => "handoff",
                AgentSwitchBehavior::Reset => "reset",
            };
            table["agentSwitchBehavior"] = toml_edit::value(s);
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
// Theme fallback
// ---------------------------------------------------------------------------

/// Serve the default theme for this session when `themeLight` or `themeDark`
/// does not resolve — **in memory only**.
///
/// This used to write `theme = "atlas"` back to `config.toml`, which turned
/// anything that made one lookup fail — a user theme mid-edit that briefly did
/// not parse, an unreadable themes directory, an id written by a newer Atlas —
/// into the permanent loss of the user's choice. The file keeps what the user
/// wrote; the next load, once the theme resolves again, uses it.
fn fallback_unknown_theme(settings: &mut AppSettings) {
    for theme in [&mut settings.theme_light, &mut settings.theme_dark] {
        if let Err(error) = atlas_theme::get_theme(theme) {
            tracing::warn!(target: "atlas::themes", theme = %theme, "theme in config.toml does not resolve ({error}); using atlas for this session");
            *theme = default_theme();
        }
    }
}

/// A unit enum's serde string, e.g. `ChatWidth::Wide` → `"wide"`.
fn enum_str<T: Serialize>(value: &T) -> String {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(s)) => s,
        _ => unreachable!("a settings enum serializes to a string"),
    }
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
    UsingLastKnownGood {
        error: String,
    },
    /// Cold start found no valid file (missing or malformed); `effective` is
    /// `AppSettings::default()`. The malformed file, if any, is left
    /// untouched on disk.
    UsingDefaults {
        error: String,
    },
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
    Applied {
        settings: AppSettings,
        generation: u64,
    },
    /// `expected_generation` was stale — nothing was written. `settings`
    /// carries what's actually on disk now so the caller can reconcile.
    Conflict {
        settings: AppSettings,
        generation: u64,
    },
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
        let document: toml_edit::DocumentMut = raw
            .parse()
            .map_err(|e: toml_edit::TomlError| ConfigError::Parse(e.to_string()))?;
        let text = document.to_string();
        let mut file: AtlasConfigFile =
            toml::from_str(&text).map_err(|e| ConfigError::Parse(e.to_string()))?;
        if file.schema_version > CONFIG_SCHEMA_VERSION {
            return Err(ConfigError::UnsupportedVersion(file.schema_version));
        }
        fallback_unknown_theme(&mut file.settings);
        validate(&file.settings).map_err(ConfigError::Invalid)?;
        let unknown_keys = unknown_keys_in(&document);
        Ok(Self {
            path,
            document,
            effective: file.settings,
            last_raw: text,
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
                Ok(manager) => manager,
                Err(e) => {
                    tracing::warn!(
                        target: "atlas::config",
                        "config.toml invalid at cold start, serving defaults in memory (file left untouched): {e}"
                    );
                    let mut mgr = Self::in_memory_defaults(path);
                    mgr.status = ConfigStatus::UsingDefaults {
                        error: e.to_string(),
                    };
                    mgr
                }
            },
            // File genuinely absent — the normal pre-first-write state, not
            // an error. `bootstrap` below writes the documented defaults.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Self::in_memory_defaults(path),
            // Anything else (permissions, a transient I/O fault, a directory
            // where the file should be) is a *failure to read*, not an
            // absence. Serving defaults is still right at runtime — boot must
            // never block on this — but the status MUST say so, or the
            // Settings banner shows a healthy file while every preference
            // reads back as a default.
            Err(e) => {
                tracing::warn!(
                    target: "atlas::config",
                    "config.toml could not be read, serving defaults in memory (file left untouched): {e}"
                );
                let mut mgr = Self::in_memory_defaults(path);
                mgr.status = ConfigStatus::UsingDefaults {
                    error: format!("could not read config.toml: {e}"),
                };
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
                self.status = ConfigStatus::UsingLastKnownGood {
                    error: e.to_string(),
                };
                return Err(e);
            }
        };
        if fresh.last_raw != raw {
            write_atomic(&self.path, &fresh.last_raw)
                .map_err(|error| ConfigError::Io(error.to_string()))?;
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
        let present = settings_keys_in(&doc);
        patch.write_into(&mut doc);
        document_added_keys(&mut doc, &present);
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

        Ok(Some(UpdateOutcome::Applied {
            settings: candidate,
            generation: self.generation,
        }))
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
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let backup = self
                .path
                .with_file_name(format!("{CONFIG_FILE_NAME}.bak-{stamp}"));
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

        Ok(ConfigSnapshot {
            settings,
            generation: self.generation,
        })
    }

    /// Write a specific `AppSettings` as a brand-new file (first run — there
    /// is no existing document to preserve yet).
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
/// writes, a first-run create, and any external tooling can never collide on one
/// fixed `.tmp` name), flushed then renamed over the target.
pub(crate) fn write_atomic(path: &Path, contents: &str) -> std::io::Result<()> {
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
/// macOS is `~/Library/Application Support/dev.atlas.ide/`. (`~/.config/
/// atlas-dev/` under the dev profile — see `atlas-profile`.)
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
            return Some(xdg.join(config_dir_name()));
        }
    }
    home.map(|home| home.join(".config").join(config_dir_name()))
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
        UpdateOutcome::Applied {
            settings,
            generation,
        }
        | UpdateOutcome::Conflict {
            settings,
            generation,
        } => Ok(ConfigSnapshot {
            settings,
            generation,
        }),
    }
}

/// Startup: load `config.toml`, writing the documented defaults on first run.
pub fn bootstrap() -> ConfigManager {
    let Some(path) = ConfigManager::config_path() else {
        // No resolvable config dir at all (no $HOME / no %APPDATA%). Defaults
        // keep the app usable, but this is a failure and must reach the
        // banner rather than passing for a healthy load.
        let mut manager = ConfigManager::load();
        manager.status = ConfigStatus::UsingDefaults {
            error: "could not resolve the Atlas config directory".to_string(),
        };
        return manager;
    };
    bootstrap_at(path)
}

/// The path half of [`bootstrap`], testable against a temp dir.
fn bootstrap_at(path: PathBuf) -> ConfigManager {
    if path.exists() {
        return ConfigManager::load_at(path);
    }
    match ConfigManager::create_fresh_with(path.clone(), AppSettings::default()) {
        Ok(manager) => manager,
        Err(e) => {
            tracing::warn!(target: "atlas::config", "failed to write a fresh config.toml: {e}");
            // `load_at` would take its "genuinely absent" branch and report
            // `Ok`, hiding a real failure behind a healthy status.
            let mut manager = ConfigManager::load_at(path);
            manager.status = ConfigStatus::UsingDefaults {
                error: format!("could not write config.toml: {e}"),
            };
            manager
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
        assert_eq!(
            root.join(CONFIG_FILE_NAME),
            PathBuf::from("/Users/someone/.config/atlas/config.toml")
        );
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

    /// 0 is "off", not out of range; past 90 is.
    #[test]
    fn auto_settle_after_days_takes_zero_for_off() {
        let off = AppSettings {
            auto_settle_after_days: 0,
            ..AppSettings::default()
        };
        assert!(validate(&off).is_ok());
        let too_long = AppSettings {
            auto_settle_after_days: MAX_AUTO_SETTLE_AFTER_DAYS + 1,
            ..AppSettings::default()
        };
        assert_eq!(validate(&too_long).unwrap_err().key, "autoSettleAfterDays");
    }

    #[test]
    fn pull_request_guide_settings_are_bounded() {
        let ok = AppSettings {
            pull_request_guide_agent: "claude-code".to_string(),
            pull_request_guide_model: "claude-opus-4".to_string(),
            pull_request_guide_instructions: "Contracts first.\nSkip tests.".to_string(),
            ..AppSettings::default()
        };
        assert!(validate(&ok).is_ok());
        let bad_agent = AppSettings {
            pull_request_guide_agent: "../claude".to_string(),
            ..AppSettings::default()
        };
        assert_eq!(
            validate(&bad_agent).unwrap_err().key,
            "pullRequestGuideAgent"
        );
        let two_lines = AppSettings {
            pull_request_guide_model: "opus\nsonnet".to_string(),
            ..AppSettings::default()
        };
        assert_eq!(
            validate(&two_lines).unwrap_err().key,
            "pullRequestGuideModel"
        );
        let long = AppSettings {
            pull_request_guide_instructions: "x".repeat(MAX_GUIDE_INSTRUCTIONS + 1),
            ..AppSettings::default()
        };
        assert_eq!(
            validate(&long).unwrap_err().key,
            "pullRequestGuideInstructions"
        );
    }

    /// The pull request keys C1's watch reads default to on, and a file
    /// written before they existed reads as on.
    #[test]
    fn pull_request_watch_keys_default_on_for_an_old_file() {
        let (_dir, path) = tmp_config_path();
        let mgr =
            ConfigManager::from_raw(path, "schemaVersion = 1\n[settings]\nenterToSend = false\n")
                .expect("loads");
        let s = mgr.effective();
        assert!(s.auto_settle_on_merge);
        assert!(s.auto_settle_keep_pull_requests);
        assert!(s.pull_request_watch_wakes);
        assert!(!s.remove_agent_credits_on_merge);
        assert_eq!(s.pull_request_merge_method, PullRequestMergeMethod::Last);
    }

    /// ADR-0012: on unless the user switched it off, and a file that predates
    /// the key reads as on.
    #[test]
    fn agent_ui_navigation_is_on_by_default_and_read_from_the_file() {
        assert!(AppSettings::default().agent_ui_navigation);
        let (_dir, path) = tmp_config_path();
        let mgr = ConfigManager::from_raw(
            path,
            "schemaVersion = 1\n\n[settings]\nenterToSend = false\n",
        )
        .unwrap();
        assert!(mgr.effective().agent_ui_navigation);
        let (_dir, path) = tmp_config_path();
        let mgr = ConfigManager::from_raw(
            path,
            "schemaVersion = 1\n\n[settings]\nagentUiNavigation = false\n",
        )
        .unwrap();
        assert!(!mgr.effective().agent_ui_navigation);
    }

    /// ADR-0014: on unless the user switched it off, and a file that predates
    /// the key reads as on.
    #[test]
    fn agent_org_access_is_on_by_default_and_read_from_the_file() {
        assert!(AppSettings::default().agent_org_access);
        let (_dir, path) = tmp_config_path();
        let mgr = ConfigManager::from_raw(
            path,
            "schemaVersion = 1\n\n[settings]\nenterToSend = false\n",
        )
        .unwrap();
        assert!(mgr.effective().agent_org_access);
        let (_dir, path) = tmp_config_path();
        let mgr = ConfigManager::from_raw(
            path,
            "schemaVersion = 1\n\n[settings]\nagentOrgAccess = false\n",
        )
        .unwrap();
        assert!(!mgr.effective().agent_org_access);
    }

    /// ADR-0015: on unless the user switched it off, and a file that predates
    /// the key reads as on.
    #[test]
    fn agent_code_tools_is_on_by_default_and_read_from_the_file() {
        assert!(AppSettings::default().agent_code_tools);
        let (_dir, path) = tmp_config_path();
        let mgr = ConfigManager::from_raw(
            path,
            "schemaVersion = 1\n\n[settings]\nenterToSend = false\n",
        )
        .unwrap();
        assert!(mgr.effective().agent_code_tools);
        let (_dir, path) = tmp_config_path();
        let mgr = ConfigManager::from_raw(
            path,
            "schemaVersion = 1\n\n[settings]\nagentCodeTools = false\n",
        )
        .unwrap();
        assert!(!mgr.effective().agent_code_tools);
    }

    /// Files and diffs wrap unless the user switched it off; a file that
    /// predates the key reads as on, and the wrap buttons' patch turns it off.
    #[test]
    fn word_wrap_is_on_by_default_and_patched_off() {
        assert!(AppSettings::default().word_wrap);
        let (_dir, path) = tmp_config_path();
        let mgr = ConfigManager::from_raw(
            path,
            "schemaVersion = 1\n\n[settings]\nenterToSend = false\n",
        )
        .unwrap();
        assert!(mgr.effective().word_wrap);

        let (_dir, path) = tmp_config_path();
        let mgr =
            ConfigManager::from_raw(path, "schemaVersion = 1\n\n[settings]\nwordWrap = false\n")
                .unwrap();
        assert!(!mgr.effective().word_wrap);

        let patch: SettingsPatch = serde_json::from_str(r#"{ "wordWrap": false }"#).unwrap();
        let mut settings = AppSettings::default();
        patch.apply_to(&mut settings);
        assert!(!settings.word_wrap);
        let mut document = document_for(&AppSettings::default());
        patch.write_into(&mut document);
        assert_eq!(document["settings"]["wordWrap"].as_bool(), Some(false));
    }

    #[test]
    fn missing_keys_fall_back_to_defaults() {
        let (_dir, path) = tmp_config_path();
        let raw = "schemaVersion = 1\n\n[settings]\nenterToSend = false\n";
        let mgr = ConfigManager::from_raw(path, raw).expect("partial file parses");
        assert!(!mgr.effective().enter_to_send);
        // Every other field is absent from the file — must be the compiled default.
        assert_eq!(mgr.effective().theme_light, default_theme());
        assert_eq!(mgr.effective().theme_dark, default_theme());
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

        let patch = SettingsPatch {
            enter_to_send: Some(false),
            ..Default::default()
        };
        let outcome = mgr.apply_patch(&patch, None).expect("patch applies");
        match outcome {
            UpdateOutcome::Applied {
                settings,
                generation,
            } => {
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

        let patch = SettingsPatch {
            ui_scale: Some(99.0),
            ..Default::default()
        };
        let err = mgr
            .apply_patch(&patch, None)
            .expect_err("out-of-range scale must be rejected");
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

        let patch = SettingsPatch {
            enter_to_send: Some(false),
            ..Default::default()
        };
        let err = mgr
            .apply_patch(&patch, None)
            .expect_err("must refuse to write over a malformed file");
        assert!(matches!(err, ConfigError::Parse(_)));
        // In-memory last-known-good is untouched.
        assert!(mgr.effective().enter_to_send);
        // The malformed file was never overwritten by the rejected patch.
        assert_eq!(fs::read_to_string(&path).unwrap(), "not toml at all {{{");
        // But the status now reflects the on-disk file being broken.
        assert!(matches!(
            mgr.status(),
            ConfigStatus::UsingLastKnownGood { .. }
        ));
    }

    #[test]
    fn stale_generation_reports_conflict_without_writing() {
        let (_dir, path) = tmp_config_path();
        let raw = "schemaVersion = 1\n\n[settings]\nenterToSend = true\n";
        fs::write(&path, raw).unwrap();
        let mut mgr = ConfigManager::from_raw(path.clone(), raw).unwrap();

        let patch = SettingsPatch {
            enter_to_send: Some(false),
            ..Default::default()
        };
        let outcome = mgr
            .apply_patch(&patch, Some(mgr.generation() + 1))
            .expect("conflict is not an error");
        match outcome {
            UpdateOutcome::Conflict {
                settings,
                generation,
            } => {
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
        assert!(!mgr.reload_from_disk().unwrap());
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
        let has_backup = fs::read_dir(dir).unwrap().filter_map(Result::ok).any(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("config.toml.bak-")
        });
        assert!(
            has_backup,
            "reset() must back up the previous file before overwriting"
        );
    }

    #[test]
    fn unknown_config_theme_falls_back_in_memory_and_is_never_rewritten() {
        let (_dir, path) = tmp_config_path();
        let raw = "schemaVersion = 1\n\n[settings]\nthemeDark = \"from-a-newer-atlas\"\n";
        let manager = ConfigManager::from_raw(path.clone(), raw).expect("unknown id falls back");

        assert_eq!(manager.effective().theme_dark, default_theme());
        assert_eq!(manager.last_raw, raw, "a failed lookup rewrites nothing");

        // And through the cold-start path.
        fs::write(&path, raw).unwrap();
        let manager = ConfigManager::load_at(path.clone());
        assert_eq!(manager.effective().theme_dark, default_theme());
        assert_eq!(fs::read_to_string(&path).unwrap(), raw);
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
            preferred_editor: Some("zed".to_string()),
            ui_scale: Some(1.5),
            share_telemetry: Some(!defaults.share_telemetry),
            link_telemetry_to_account: Some(!defaults.link_telemetry_to_account),
            embedding_model_id: Some("another-model".to_string()),
            theme_light: Some("dracula".to_string()),
            theme_dark: Some("vesper".to_string()),
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
            agent_switch_behavior: Some(AgentSwitchBehavior::Handoff),
            remember_before_switch: Some(!defaults.remember_before_switch),
            git_blame_inline: Some(!defaults.git_blame_inline),
            git_auto_fetch: Some(!defaults.git_auto_fetch),
            keep_awake_while_running: Some(!defaults.keep_awake_while_running),
            auto_update: Some(!defaults.auto_update),
            curated_plugin_sync: Some(!defaults.curated_plugin_sync),
            instruction_sync: Some(!defaults.instruction_sync),
            updater_ignored_version: Some(Some("9.9.9".to_string())),
            enter_to_send: Some(!defaults.enter_to_send),
            agent_ui_navigation: Some(!defaults.agent_ui_navigation),
            agent_org_access: Some(!defaults.agent_org_access),
            agent_code_tools: Some(!defaults.agent_code_tools),
            memory_dreams: Some(!defaults.memory_dreams),
            memory_repo_mirror: Some(!defaults.memory_repo_mirror),
            atlas_only_memory: Some(!defaults.atlas_only_memory),
            terminal_notify_min_duration_ms: Some(defaults.terminal_notify_min_duration_ms + 1),
            notifications_enabled: Some(!defaults.notifications_enabled),
            notify_needs_you_native: Some(!defaults.notify_needs_you_native),
            notify_needs_you_sound: Some(!defaults.notify_needs_you_sound),
            notify_outcome_native: Some(!defaults.notify_outcome_native),
            notify_outcome_sound: Some(!defaults.notify_outcome_sound),
            notify_warning_native: Some(!defaults.notify_warning_native),
            notify_warning_sound: Some(!defaults.notify_warning_sound),
            notify_team_native: Some(!defaults.notify_team_native),
            notify_team_sound: Some(!defaults.notify_team_sound),
            notify_permission_actions: Some(!defaults.notify_permission_actions),
            notify_disabled_kinds: Some(vec![
                "terminal-done".to_string(),
                "git-behind".to_string(),
            ]),
            notify_agent_min_duration_ms: Some(defaults.notify_agent_min_duration_ms + 1),
            favorite_models: Some(vec!["claude-code:opus".to_string()]),
            confirm_delete_chat: Some(!defaults.confirm_delete_chat),
            confirm_quit_while_running: Some(!defaults.confirm_quit_while_running),
            continue_sessions_after_restart: Some(!defaults.continue_sessions_after_restart),
            new_session_uses_last_agent: Some(!defaults.new_session_uses_last_agent),
            default_agent: Some("claude-code".to_string()),
            chat_width: Some(ChatWidth::Wide),
            word_wrap: Some(!defaults.word_wrap),
            sidebar_sort: Some(SidebarSort::Created),
            auto_settle_after_days: Some(7),
            time_format: Some(TimeFormat::TwentyFourHour),
            ui_font_family: Some("Inter, sans-serif".to_string()),
            code_font_family: Some("JetBrains Mono".to_string()),
            composer_font_family: Some("Georgia".to_string()),
            terminal_font_family: Some("Menlo".to_string()),
            editor_font_size: Some(15),
            terminal_font_size: Some(14),
            diff_ignore_whitespace: Some(!defaults.diff_ignore_whitespace),
            diff_files_collapsed: Some(!defaults.diff_files_collapsed),
            diff_palette: Some(DiffPalette::BlueOrange),
            interface_contrast: Some(150),
            show_turn_rail: Some(!defaults.show_turn_rail),
            auto_settle_on_merge: Some(!defaults.auto_settle_on_merge),
            auto_settle_keep_pull_requests: Some(!defaults.auto_settle_keep_pull_requests),
            pull_request_watch_wakes: Some(!defaults.pull_request_watch_wakes),
            pull_request_links_open_in_app: Some(!defaults.pull_request_links_open_in_app),
            pull_request_merge_method: Some(PullRequestMergeMethod::Squash),
            remove_agent_credits_on_merge: Some(!defaults.remove_agent_credits_on_merge),
            pull_request_guide_enabled: Some(!defaults.pull_request_guide_enabled),
            pull_request_guide_agent: Some("claude-code".to_string()),
            pull_request_guide_model: Some("opus".to_string()),
            pull_request_guide_instructions: Some("Show contracts first.\nSkip tests.".to_string()),
            security_scan: Some(!defaults.security_scan),
        };
        let mut expected = defaults.clone();
        patch.apply_to(&mut expected);

        let expected_json = serde_json::to_value(&expected).unwrap();
        let default_json = serde_json::to_value(&defaults).unwrap();
        for (key, value) in expected_json.as_object().unwrap() {
            assert_ne!(
                default_json.get(key),
                Some(value),
                "the fixture leaves {key} at its default"
            );
        }

        let mut document = document_for(&defaults);
        patch.write_into(&mut document);
        let (_dir, path) = tmp_config_path();
        let reloaded =
            ConfigManager::from_raw(path, &document.to_string()).expect("a written patch reloads");
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
        assert_eq!(
            patch.theme_overrides.unwrap().keys["syntax.keyword"].color(),
            "#fff"
        );
    }

    // ── bootstrap_at (first run) ──────────────────────────

    #[test]
    fn bootstrap_writes_a_documented_file_on_first_run() {
        let (_dir, path) = tmp_config_path();
        let manager = bootstrap_at(path.clone());
        assert_eq!(manager.status(), &ConfigStatus::Ok);
        assert_eq!(manager.effective(), &AppSettings::default());
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            document_for(&AppSettings::default()).to_string()
        );
    }

    #[test]
    fn bootstrap_leaves_an_existing_config_untouched() {
        let (_dir, path) = tmp_config_path();
        let raw = "schemaVersion = 1\n\n[settings]\nenterToSend = false\n";
        fs::write(&path, raw).unwrap();
        let manager = bootstrap_at(path.clone());
        assert!(!manager.effective().enter_to_send);
        assert_eq!(fs::read_to_string(&path).unwrap(), raw);
    }

    /// A directory sitting where the file should be cannot be read; that is
    /// flagged rather than reported as a healthy, absent file.
    #[test]
    fn bootstrap_flags_an_unreadable_config() {
        let (_dir, path) = tmp_config_path();
        fs::create_dir_all(&path).unwrap();
        let manager = bootstrap_at(path);
        assert!(matches!(
            manager.status(),
            ConfigStatus::UsingDefaults { .. }
        ));
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
            assert!(
                CONFIGURATION_DOC.contains(key),
                "docs/reference/configuration.md is missing `{key}`"
            );
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
            serde_json::to_value(ConfigStatus::UsingDefaults {
                error: "boom".into()
            })
            .unwrap(),
            serde_json::json!({ "status": "usingDefaults", "error": "boom" })
        );
        assert_eq!(
            serde_json::to_value(ConfigStatus::UsingLastKnownGood {
                error: "boom".into()
            })
            .unwrap(),
            serde_json::json!({ "status": "usingLastKnownGood", "error": "boom" })
        );
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

        assert!(
            mgr.reload_from_disk().unwrap(),
            "a changed, valid file is adopted"
        );
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

        assert!(
            write_atomic(&path, "schemaVersion = 1\n").is_err(),
            "renaming onto a dir fails"
        );
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

    /// A comment line that misses its `\n\` continuation keeps the source's
    /// indentation, so the generated `config.toml` shows it pushed right of the
    /// rest. Valid TOML, so nothing else notices.
    #[test]
    fn every_settings_docs_line_starts_with_a_hash() {
        for (key, comment) in SETTINGS_DOCS {
            for line in comment.lines() {
                assert!(
                    line.starts_with('#'),
                    "`{key}` has a comment line not starting with `#`: {line:?}"
                );
            }
        }
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
        let named: Vec<_> = known_settings_keys()
            .filter(|key| SELF_CONFIGURE_SKILL.contains(*key))
            .collect();
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
        let settings = AppSettings {
            ui_scale: 1.25,
            enter_to_send: false,
            ..Default::default()
        };
        let rendered = document_for(&settings).to_string();

        let mgr = ConfigManager::from_raw(path, &rendered).expect("the generated file parses");
        assert_eq!(mgr.effective(), &settings);
        assert!(
            mgr.unknown_keys().is_empty(),
            "comments must not read as unknown keys"
        );
    }

    // ── The settings registry ────────────────────────────────────────────
    //
    // `src-tauri/settings-registry.toml` is the one hand-edited description of every
    // key. The comments in a generated file, the TS `AppSettings` type and its
    // defaults, and the docs tables are all generated from it
    // (`bun run settings:gen`). The one copy that cannot be generated is the
    // struct above, so these hold the struct to the registry instead: a field
    // added here without an entry there (or the reverse), a default changed on
    // one side, a bound or an enum value that disagrees — each one compiles,
    // ships, and shows the user a Settings row or a comment that lies.

    const SETTINGS_REGISTRY_TOML: &str = include_str!("../../settings-registry.toml");

    #[derive(Deserialize)]
    struct Registry {
        setting: Vec<RegistryEntry>,
    }

    #[derive(Deserialize)]
    struct RegistryEntry {
        key: String,
        #[serde(rename = "type")]
        kind: String,
        default: Option<toml::Value>,
        values: Option<Vec<String>>,
        min: Option<toml::Value>,
        max: Option<toml::Value>,
    }

    fn registry() -> Vec<RegistryEntry> {
        let parsed: Registry = toml::from_str(SETTINGS_REGISTRY_TOML)
            .expect("src-tauri/settings-registry.toml parses");
        assert!(
            parsed.setting.len() > 40,
            "floor guard: an empty registry makes every check below vacuous"
        );
        parsed.setting
    }

    /// The keys a default `AppSettings` writes, in the order it writes them.
    fn default_key_order() -> Vec<String> {
        let text = toml::to_string(&AppSettings::default()).expect("serializes");
        text.lines()
            .take_while(|line| !line.starts_with('['))
            .filter_map(|line| line.split_once(" = ").map(|(key, _)| key.to_string()))
            .collect()
    }

    fn parse_settings(body: &str) -> Result<AppSettings, toml::de::Error> {
        toml::from_str::<AtlasConfigFile>(&format!("schemaVersion = 1\n\n[settings]\n{body}\n"))
            .map(|file| file.settings)
    }

    #[test]
    fn the_settings_registry_matches_app_settings() {
        let entries = registry();

        // Same keys, same order. Absent-by-default keys (an unset Option, an
        // empty table) don't serialize, so they are checked below instead.
        let expected: Vec<String> = entries
            .iter()
            .filter(|entry| entry.default.is_some())
            .map(|entry| entry.key.clone())
            .collect();
        assert_eq!(
            default_key_order(),
            expected,
            "AppSettings and src-tauri/settings-registry.toml disagree on the keys or their order"
        );

        // Every field the frontend receives has an entry, and nothing extra.
        let wire = serde_json::to_value(AppSettings::default()).expect("serializes");
        let wire_keys: Vec<&String> = wire.as_object().expect("an object").keys().collect();
        for key in &wire_keys {
            assert!(
                entries.iter().any(|entry| &&entry.key == key),
                "`{key}` is an AppSettings field with no entry in src-tauri/settings-registry.toml"
            );
        }
        for entry in &entries {
            assert!(
                entry.default.is_some() || !default_key_order().contains(&entry.key),
                "`{}` has no registry default but serializes by default",
                entry.key
            );
        }

        // Same defaults.
        let defaults = toml::Value::try_from(AppSettings::default()).expect("serializes");
        for entry in &entries {
            let Some(default) = &entry.default else {
                continue;
            };
            assert_eq!(
                defaults.get(&entry.key),
                Some(default),
                "`{}`: the registry default differs from AppSettings::default()",
                entry.key
            );
        }

        // And SETTINGS_DOCS, generated from the registry, is in step with it.
        let documented: Vec<&str> = known_settings_keys().collect();
        let registered: Vec<&str> = entries.iter().map(|entry| entry.key.as_str()).collect();
        assert_eq!(documented, registered, "run `bun run settings:gen`");
    }

    /// An enum the UI offers a value for that serde then rejects is a
    /// Settings row that fails on click; the reverse is a value only
    /// hand-editing can reach.
    #[test]
    fn every_registry_enum_value_is_accepted_and_nothing_else_is() {
        for entry in registry().iter().filter(|entry| entry.kind == "enum") {
            let values = entry.values.as_ref().expect("an enum lists its values");
            for value in values {
                assert!(
                    parse_settings(&format!("{} = \"{value}\"", entry.key)).is_ok(),
                    "`{}` = \"{value}\" is in the registry but rejected",
                    entry.key
                );
            }
            assert!(
                parse_settings(&format!("{} = \"not-a-real-value\"", entry.key)).is_err(),
                "`{}` accepts a value the registry doesn't list",
                entry.key
            );
        }
    }

    /// The registry's bounds are what the UI clamps to and the docs print;
    /// `validate()` is what actually enforces them.
    #[test]
    fn registry_bounds_are_the_ones_validate_enforces() {
        let number = |value: &toml::Value| {
            value
                .as_float()
                .or_else(|| value.as_integer().map(|n| n as f64))
                .expect("a numeric bound")
        };
        let accepts = |key: &str, value: f64, integer: bool| {
            let literal = if integer {
                format!("{}", value as i64)
            } else {
                format!("{value:.3}")
            };
            parse_settings(&format!("{key} = {literal}"))
                .ok()
                .is_some_and(|settings| validate(&settings).is_ok())
        };
        for entry in registry() {
            let integer = entry.kind == "integer";
            let step = if integer { 1.0 } else { 0.01 };
            if let Some(max) = &entry.max {
                let max = number(max);
                assert!(
                    accepts(&entry.key, max, integer),
                    "`{}` rejects its max",
                    entry.key
                );
                assert!(
                    !accepts(&entry.key, max + step, integer),
                    "`{}` accepts more than its registry max",
                    entry.key
                );
            }
            if let Some(min) = &entry.min {
                let min = number(min);
                assert!(
                    accepts(&entry.key, min, integer),
                    "`{}` rejects its min",
                    entry.key
                );
                assert!(
                    !accepts(&entry.key, min - step, integer),
                    "`{}` accepts less than its registry min",
                    entry.key
                );
            }
        }
    }

    /// The whole file a fresh install gets, committed, so a change to what
    /// users see is a reviewable diff rather than something only a new user
    /// discovers. `ATLAS_BLESS=1 cargo test -p atlas config_default` rewrites
    /// it.
    #[test]
    fn config_default_file_matches_the_committed_copy() {
        let path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/reference/config.default.toml");
        let rendered = document_for(&AppSettings::default()).to_string();
        if std::env::var_os("ATLAS_BLESS").is_some() {
            fs::write(&path, &rendered).expect("writes the committed copy");
            return;
        }
        let committed = fs::read_to_string(&path).unwrap_or_default();
        assert!(
            committed == rendered,
            "docs/reference/config.default.toml is stale: run \
             `ATLAS_BLESS=1 cargo test -p atlas config_default` and review the diff"
        );
    }

    /// A key Atlas adds to a file it didn't generate — a setting introduced
    /// after the file was created, touched for the first time — arrives with
    /// the same comment a fresh file gives it, and the user's own comments on
    /// the keys already there are left exactly as they were.
    #[test]
    fn a_key_added_to_an_existing_file_arrives_documented() {
        let (_dir, path) = tmp_config_path();
        let raw = "schemaVersion = 1\n\n[settings]\n# mine, untouched\nenterToSend = true\n";
        fs::write(&path, raw).unwrap();
        let mut mgr = ConfigManager::from_raw(path.clone(), raw).unwrap();

        let patch = SettingsPatch {
            enter_to_send: Some(false),
            git_auto_fetch: Some(false),
            ..Default::default()
        };
        mgr.apply_patch(&patch, None).expect("patch applies");

        let on_disk = fs::read_to_string(&path).unwrap();
        assert!(on_disk.contains("# mine, untouched\nenterToSend = false"));
        let (_, comment) = SETTINGS_DOCS
            .iter()
            .find(|(key, _)| *key == "gitAutoFetch")
            .unwrap();
        assert!(
            on_disk.contains(&format!("{comment}\ngitAutoFetch = false")),
            "the new key has no comment:\n{on_disk}"
        );
        assert_eq!(
            on_disk.matches("# mine, untouched").count(),
            1,
            "an existing key's decor must not be rewritten"
        );
        ConfigManager::from_raw(path, &on_disk).expect("still a valid config");
    }
}
