//! Atlas theme schema, validation, built-in assets, and user-theme I/O.
//!
//! Rust owns theme files. Callers receive validated JSON-ready values and do
//! not need to know whether a theme came from `include_str!` or the user's
//! `~/.config/atlas/themes` directory.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use schemars::{schema_for, JsonSchema};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub mod color;
pub mod export;
pub mod import;
pub mod toml_writer;

pub const THEME_SCHEMA_VERSION: u32 = 1;
pub const DEFAULT_THEME_ID: &str = "atlas";

/// Generated from `crates/atlas-theme/keys.toml` by `bun run theme:keys`.
/// One key per line: the role name, a tab, and the one-line description that
/// becomes the author's hover text in the JSON Schema.
const THEME_KEYS: &str = include_str!("../theme-keys.txt");

/// Every theme key with its description, in registry order.
fn theme_key_docs() -> impl Iterator<Item = (&'static str, &'static str)> {
    THEME_KEYS
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| line.split_once('\t').unwrap_or((line, "")))
}

/// Every theme key Atlas knows, in registry order.
pub fn theme_keys() -> impl Iterator<Item = &'static str> {
    theme_key_docs().map(|(key, _)| key)
}

/// The shadcn base tokens, in the order `docs/reference/theme-keys.md` and the
/// built-in TOMLs list them. Public because the importers fill this exact set
/// and the TOML writer emits it in this exact order.
pub const BASE_TOKENS: &[&str] = &[
    "background",
    "foreground",
    "card",
    "card-foreground",
    "popover",
    "popover-foreground",
    "primary",
    "primary-foreground",
    "secondary",
    "secondary-foreground",
    "muted",
    "muted-foreground",
    "accent",
    "accent-foreground",
    "destructive",
    "destructive-foreground",
    "border",
    "input",
    "ring",
    "chart-1",
    "chart-2",
    "chart-3",
    "chart-4",
    "chart-5",
    "sidebar",
    "sidebar-foreground",
    "sidebar-primary",
    "sidebar-primary-foreground",
    "sidebar-accent",
    "sidebar-accent-foreground",
    "sidebar-border",
    "sidebar-ring",
    "radius",
    "font-sans",
    "font-serif",
    "font-mono",
    "tracking-normal",
    "spacing",
    "shadow-2xs",
    "shadow-xs",
    "shadow-sm",
    "shadow-md",
    "shadow-lg",
    "shadow-xl",
    "shadow-2xl",
];

/// Base tokens whose value is free text (a length, a font stack, a composed
/// shadow) rather than a colour, so the colour validator skips them — and
/// [`is_safe_css_value`] checks them instead.
pub const NON_COLOR_BASE_TOKENS: &[&str] = &[
    "radius",
    "font-sans",
    "font-serif",
    "font-mono",
    "tracking-normal",
    "spacing",
    "shadow-2xs",
    "shadow-xs",
    "shadow-sm",
    "shadow-md",
    "shadow-lg",
    "shadow-xl",
    "shadow-2xl",
];

/// The optional eight-colour palette, which 36 theme keys resolve through
/// (plus the four derived status fills on top of those).
pub const PALETTE_KEYS: &[&str] = &[
    "red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink",
];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Theme {
    pub schema: u32,
    pub id: String,
    pub name: String,
    pub author: String,
    pub license: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dark: Option<ThemeVariant>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub light: Option<ThemeVariant>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(skip)]
    pub warnings: Vec<ThemeWarning>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ThemeVariant {
    pub base: BTreeMap<String, String>,
    #[serde(default)]
    pub palette: BTreeMap<String, String>,
    #[serde(default)]
    pub keys: BTreeMap<String, ThemeKeyValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum ThemeKeyValue {
    Color(String),
    Styled(ThemeKeyStyle),
}

impl ThemeKeyValue {
    pub fn color(&self) -> &str {
        match self {
            Self::Color(color) => color,
            Self::Styled(style) => &style.color,
        }
    }
}

/// The table spelling of a theme key: `keyword = { color = "#c678dd" }`.
///
/// It carried a `font_style` too, which the schema accepted, the TS type
/// mirrored and *nothing* read — so `font_style = "italic"` parsed, validated,
/// shipped, and rendered upright. A theme author had no way to tell that from
/// a bug in their own file. Atlas has no path from a theme key to a font
/// style: CodeMirror, highlight.js and the markdown renderer each take a
/// colour from the resolved key and nothing else. Until all three can honour
/// one, the field is rejected at load with a message that says so, which is
/// the only answer that cannot be mistaken for the feature working.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ThemeKeyStyle {
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThemeWarning {
    pub key: String,
    pub message: String,
}

/// What the picker needs to draw itself: the themes on offer, and the user
/// theme files that never made it that far.
///
/// [`ThemeCatalog::warnings`] used to stop at a `tracing::warn!` line. A
/// skipped file is the one failure the *user* can fix, and they are not
/// reading the log — so it travels to the UI with the list it is about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThemeCatalogSummary {
    pub themes: Vec<ThemeSummary>,
    pub warnings: Vec<ThemeWarning>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThemeSummary {
    pub id: String,
    pub name: String,
    pub author: String,
    pub license: String,
    pub has_dark: bool,
    pub has_light: bool,
    pub built_in: bool,
    pub warnings: Vec<ThemeWarning>,
}

impl Theme {
    pub fn summary(&self, built_in: bool) -> ThemeSummary {
        ThemeSummary {
            id: self.id.clone(),
            name: self.name.clone(),
            author: self.author.clone(),
            license: self.license.clone(),
            has_dark: self.dark.is_some(),
            has_light: self.light.is_some(),
            built_in,
            warnings: self.warnings.clone(),
        }
    }
}

#[derive(Debug, Error)]
pub enum ThemeError {
    #[error("failed to read {path}: {source}")]
    Read {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("invalid TOML in {origin}: {source}")]
    Toml {
        origin: String,
        source: toml::de::Error,
    },
    #[error("invalid theme in {origin}: {message}")]
    Validation { origin: String, message: String },
    #[error("theme '{0}' was not found")]
    NotFound(String),
    #[error("theme watcher error: {0}")]
    Watch(#[from] notify::Error),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawTheme {
    schema: u32,
    id: String,
    name: String,
    author: String,
    license: String,
    #[serde(default)]
    dark: Option<toml::Value>,
    #[serde(default)]
    light: Option<toml::Value>,
}

const BUILT_INS: &[(&str, &str)] = &[
    ("atlas.toml", include_str!("../themes/atlas.toml")),
    ("atlas-mono.toml", include_str!("../themes/atlas-mono.toml")),
    ("chyral.toml", include_str!("../themes/chyral.toml")),
    ("mirage.toml", include_str!("../themes/mirage.toml")),
    ("rose-pine.toml", include_str!("../themes/rose-pine.toml")),
    (
        "rose-pine-moon.toml",
        include_str!("../themes/rose-pine-moon.toml"),
    ),
    ("one-dark.toml", include_str!("../themes/one-dark.toml")),
    ("phosphor.toml", include_str!("../themes/phosphor.toml")),
    ("dracula.toml", include_str!("../themes/dracula.toml")),
    ("monokai.toml", include_str!("../themes/monokai.toml")),
    (
        "tokyo-night.toml",
        include_str!("../themes/tokyo-night.toml"),
    ),
    (
        "catppuccin-frappe.toml",
        include_str!("../themes/catppuccin-frappe.toml"),
    ),
    (
        "catppuccin-macchiato.toml",
        include_str!("../themes/catppuccin-macchiato.toml"),
    ),
    (
        "catppuccin-mocha.toml",
        include_str!("../themes/catppuccin-mocha.toml"),
    ),
    ("vesper.toml", include_str!("../themes/vesper.toml")),
];

pub fn parse_theme(source: &str, origin: impl Into<String>) -> Result<Theme, ThemeError> {
    let origin = origin.into();
    let raw: RawTheme = toml::from_str(source).map_err(|source| ThemeError::Toml {
        origin: origin.clone(),
        source,
    })?;
    if raw.schema != THEME_SCHEMA_VERSION {
        return Err(validation(
            &origin,
            format!("unsupported schema {}; expected 1", raw.schema),
        ));
    }
    if raw.id.trim().is_empty() || raw.name.trim().is_empty() {
        return Err(validation(&origin, "id and name must not be empty"));
    }
    let dark = raw
        .dark
        .map(|value| parse_variant(value, &origin, "dark"))
        .transpose()?;
    let light = raw
        .light
        .map(|value| parse_variant(value, &origin, "light"))
        .transpose()?;
    if dark.is_none() && light.is_none() {
        return Err(validation(
            &origin,
            "at least one of [dark] or [light] is required",
        ));
    }
    let mut theme = Theme {
        schema: raw.schema,
        id: raw.id,
        name: raw.name,
        author: raw.author,
        license: raw.license,
        dark,
        light,
        warnings: Vec::new(),
    };
    collect_warnings(&mut theme);
    Ok(theme)
}

pub fn load_theme_file(path: &Path) -> Result<Theme, ThemeError> {
    let source = fs::read_to_string(path).map_err(|source| ThemeError::Read {
        path: path.to_path_buf(),
        source,
    })?;
    parse_theme(&source, path.display().to_string())
}

pub fn built_in_themes() -> Result<Vec<Theme>, ThemeError> {
    BUILT_INS
        .iter()
        .map(|(name, source)| parse_theme(source, *name))
        .collect()
}

/// `~/.config/atlas/themes` (or `$XDG_CONFIG_HOME/atlas/themes`).
///
/// No migration reads or moves an old `~/Library/Application Support/atlas/
/// themes` (the path a `dirs::config_dir()` bug used to resolve here on
/// macOS): this crate has never shipped past a version branch — `git log`
/// shows every commit that built it postdates the last release cut to
/// `main` — so there is no installed build that could have written a theme
/// there. A migration would add a permanent code path and test surface to
/// guard against a location no released Atlas ever used.
pub fn user_theme_dir() -> Option<PathBuf> {
    config_root().map(|dir| dir.join("themes"))
}

/// `~/.config/atlas/` (`atlas-dev/` under the dev profile, see
/// `atlas-profile`) — the same root `src-tauri/src/state/atlas_config.rs`
/// resolves for `config.toml`, **not** `dirs::config_dir()` (which on macOS is
/// `~/Library/Application Support`). `atlas-theme` sits below `src-tauri` in
/// the dependency graph — the app crate depends on this one, not the other
/// way round — so it cannot call that function directly without a cycle.
///
/// This is a deliberate, minimal copy of its logic (XDG override, `.config`
/// fallback), not an independent decision about where config lives — the same
/// copy `atlas-icon-theme` carries for its own `user_icon_theme_dir()`. Keep
/// all three in sync by hand: the `config_root` tests below run the exact
/// fixtures `atlas_config.rs`'s own `config_root_from` tests use (same inputs,
/// same expected paths), so an edit to any one of them that changes the
/// resolved path breaks a test right next to the copy that drifted.
fn config_root() -> Option<PathBuf> {
    let xdg = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from);
    let home = dirs::home_dir().or_else(|| std::env::var_os("HOME").map(PathBuf::from));
    config_root_from(xdg.as_deref(), home.as_deref())
}

/// The decision itself, taking its inputs rather than reading the
/// environment, so it can be tested without racing every other test in the
/// process over `set_var` — mirrors `config_root_from` in `atlas_config.rs`
/// exactly, including the same relative-XDG and no-home edge cases.
fn config_root_from(xdg: Option<&Path>, home: Option<&Path>) -> Option<PathBuf> {
    if let Some(xdg) = xdg {
        if xdg.is_absolute() {
            return Some(xdg.join(atlas_profile::config_dir_name()));
        }
    }
    home.map(|home| home.join(".config").join(atlas_profile::config_dir_name()))
}

/// Write a theme into `dir` as `<id>.toml`, returning the path.
///
/// The TOML is parsed first, and the id it declares is what names the file —
/// the caller's id is not trusted. Both matter: `id` reaches this from an
/// import UI where the user types it, so `../../../.zshrc` has to be
/// impossible, and a file whose name and declared id disagree loads under one
/// name and is overwritten under the other.
pub fn write_theme_to(dir: &Path, source: &str) -> Result<PathBuf, ThemeError> {
    let theme = parse_theme(source, "import")?;
    let id = theme.id.trim();
    if id.is_empty()
        || !id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err(validation(
            "import",
            format!("theme id '{id}' must be letters, digits, '-' or '_'"),
        ));
    }
    fs::create_dir_all(dir).map_err(|source| ThemeError::Read {
        path: dir.to_path_buf(),
        source,
    })?;
    let path = dir.join(format!("{id}.toml"));
    fs::write(&path, source).map_err(|source| ThemeError::Read {
        path: path.clone(),
        source,
    })?;
    Ok(path)
}

/// [`write_theme_to`] against `~/.config/atlas/themes`, where the watcher looks.
pub fn write_user_theme(source: &str) -> Result<PathBuf, ThemeError> {
    let dir = user_theme_dir()
        .ok_or_else(|| validation("import", "could not resolve the config directory"))?;
    write_theme_to(&dir, source)
}

/// Is there already a theme with this id? Distinguishes "you are about to
/// replace your own import" from "you are about to shadow a built-in".
pub fn theme_origin(id: &str) -> ThemeOrigin {
    if BUILT_INS
        .iter()
        .any(|(name, _)| *name == format!("{id}.toml"))
    {
        return ThemeOrigin::BuiltIn;
    }
    match user_theme_dir() {
        Some(dir) if dir.join(format!("{id}.toml")).exists() => ThemeOrigin::User,
        _ => ThemeOrigin::New,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ThemeOrigin {
    New,
    /// A user theme with this id exists and would be overwritten.
    User,
    /// A built-in with this id exists; a user theme of the same id shadows it.
    BuiltIn,
}

/// The themes on offer, plus whatever went wrong getting there.
///
/// One unreadable file in `~/.config/atlas/themes/` USED TO take the whole
/// catalog down: the loader collected into `Result`, so the first bad file
/// short-circuited `all_themes()` and even the `include_str!` built-ins never
/// reached the picker. A theme author with a half-typed TOML open in an editor
/// — exactly the person the hot-reload watcher exists for — lost every theme
/// in the app until they fixed it. A bad file is now skipped and reported as an
/// ordinary [`ThemeWarning`], the same shape an unknown theme key produces.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ThemeCatalog {
    /// Every loadable theme, sorted by id; `true` marks a built-in.
    pub themes: Vec<(Theme, bool)>,
    /// One entry per user theme file that could not be loaded, keyed by file
    /// name. Empty on a healthy install.
    pub warnings: Vec<ThemeWarning>,
}

/// User themes in `dir`, with the unloadable files reported rather than fatal.
///
/// Only a failure to *list* the directory is still an error: that is the whole
/// source being unavailable, not one file in it being wrong.
pub fn load_user_themes_from(dir: &Path) -> Result<(Vec<Theme>, Vec<ThemeWarning>), ThemeError> {
    if !dir.exists() {
        return Ok((Vec::new(), Vec::new()));
    }
    // An unlistable directory (permissions, a file where the directory should
    // be) costs the user themes, not the built-ins: it is reported the same way
    // one bad file is, and `get_theme("atlas")` keeps answering.
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(source) => {
            let error = ThemeError::Read {
                path: dir.to_path_buf(),
                source,
            };
            return Ok((
                Vec::new(),
                vec![ThemeWarning {
                    key: dir.display().to_string(),
                    message: error.to_string(),
                }],
            ));
        }
    };
    let mut paths = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("toml"))
        .collect::<Vec<_>>();
    paths.sort();
    let mut themes = Vec::with_capacity(paths.len());
    let mut warnings = Vec::new();
    for path in &paths {
        match load_theme_file(path) {
            Ok(theme) => themes.push(theme),
            Err(error) => warnings.push(ThemeWarning {
                key: path.file_name().map_or_else(
                    || path.display().to_string(),
                    |name| name.to_string_lossy().into_owned(),
                ),
                message: error.to_string(),
            }),
        }
    }
    Ok((themes, warnings))
}

pub fn all_themes() -> Result<ThemeCatalog, ThemeError> {
    let mut by_id = built_in_themes()?
        .into_iter()
        .map(|theme| (theme.id.clone(), (theme, true)))
        .collect::<BTreeMap<_, _>>();
    let mut warnings = Vec::new();
    if let Some(dir) = user_theme_dir() {
        let (themes, failures) = load_user_themes_from(&dir)?;
        for theme in themes {
            by_id.insert(theme.id.clone(), (theme, false));
        }
        warnings = failures;
    }
    Ok(ThemeCatalog {
        themes: by_id.into_values().collect(),
        warnings,
    })
}

pub fn list_themes() -> Result<ThemeCatalogSummary, ThemeError> {
    all_themes().map(|catalog| ThemeCatalogSummary {
        themes: catalog
            .themes
            .into_iter()
            .map(|(theme, built_in)| theme.summary(built_in))
            .collect(),
        warnings: catalog.warnings,
    })
}

pub fn get_theme(id: &str) -> Result<Theme, ThemeError> {
    all_themes()?
        .themes
        .into_iter()
        .map(|(theme, _)| theme)
        .find(|theme| theme.id == id)
        .ok_or_else(|| ThemeError::NotFound(id.to_string()))
}

/// How long the theme directory must be quiet before one change is reported —
/// the same window the `config.toml` watcher uses. An editor's save is a burst
/// (write a temp file, rename it over, touch metadata) and should repaint once.
const WATCH_DEBOUNCE: Duration = Duration::from_millis(200);

pub fn watch_user_themes<F>(on_change: F) -> Result<RecommendedWatcher, ThemeError>
where
    F: FnMut() + Send + 'static,
{
    let dir = user_theme_dir()
        .ok_or_else(|| validation("themes", "could not resolve config directory"))?;
    fs::create_dir_all(&dir).map_err(|source| ThemeError::Read {
        path: dir.clone(),
        source,
    })?;
    let (tx, rx) = mpsc::channel::<()>();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if event.is_ok_and(|event| is_theme_change(&event)) {
            let _ = tx.send(());
        }
    })?;
    watcher.watch(&dir, RecursiveMode::NonRecursive)?;
    // The sender lives in the watcher's callback, so dropping the watcher ends
    // this thread too.
    std::thread::Builder::new()
        .name("atlas-theme-watch".to_string())
        .spawn(move || debounce(&rx, WATCH_DEBOUNCE, on_change))
        .map_err(|source| ThemeError::Read {
            path: dir.clone(),
            source,
        })?;
    Ok(watcher)
}

/// Whether a filesystem event can have changed a theme.
///
/// Reads are not changes. On Linux inotify reports every `open` and `close`,
/// so without this the frontend's own reload — which opens each theme file —
/// fired the watcher again, which reloaded again, forever.
fn is_theme_change(event: &notify::Event) -> bool {
    !matches!(event.kind, EventKind::Access(_))
        && event
            .paths
            .iter()
            .any(|path| path.extension().and_then(|ext| ext.to_str()) == Some("toml"))
}

/// Call `on_change` once per burst: after a signal, wait until `window` passes
/// with no further signal. Returns when every sender is gone.
fn debounce(rx: &mpsc::Receiver<()>, window: Duration, mut on_change: impl FnMut()) {
    while rx.recv().is_ok() {
        loop {
            match rx.recv_timeout(window) {
                Ok(()) => continue,
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    on_change();
                    return;
                }
            }
        }
        on_change();
    }
}

/// The schema authors get through the `#:schema` comment at the top of a theme.
///
/// `schemars` describes the struct, which types `keys` as an open map of
/// strings — so it validates nothing and a misspelled key is silent until the
/// colour does not appear. The `keys` property is therefore replaced here with
/// the closed set from `theme-keys.txt`: a TOML editor then completes key names
/// and underlines a typo, with the description on hover.
///
/// `additionalProperties: false` is stricter than the loader, which keeps an
/// unknown key as a warning for forward compatibility. That is deliberate — the
/// editor should flag a key this build has never heard of.
pub fn json_schema() -> serde_json::Value {
    let mut schema =
        serde_json::to_value(schema_for!(Theme)).expect("Theme JSON schema serializes");
    let keys = schema
        .pointer_mut("/definitions/ThemeVariant/properties/keys")
        .and_then(serde_json::Value::as_object_mut)
        .expect("ThemeVariant has a keys property");
    keys.insert(
        "additionalProperties".to_string(),
        serde_json::Value::Bool(false),
    );
    keys.insert(
        "properties".to_string(),
        theme_key_docs()
            .map(|(key, description)| {
                // `$ref` beside other keywords is ignored under draft-07, so the
                // description rides an `allOf` wrapper to survive validation.
                let value = serde_json::json!({
                    "allOf": [{ "$ref": "#/definitions/ThemeKeyValue" }],
                    "description": description,
                });
                (key.to_string(), value)
            })
            .collect::<serde_json::Map<_, _>>()
            .into(),
    );
    schema
}

fn parse_variant(
    value: toml::Value,
    origin: &str,
    appearance: &str,
) -> Result<ThemeVariant, ThemeError> {
    let table = value
        .as_table()
        .ok_or_else(|| validation(origin, format!("[{appearance}] must be a table")))?;
    let unknown = table
        .keys()
        .filter(|key| !matches!(key.as_str(), "base" | "palette" | "keys"))
        .cloned()
        .collect::<Vec<_>>();
    if !unknown.is_empty() {
        return Err(validation(
            origin,
            format!("unknown {appearance} field(s): {}", unknown.join(", ")),
        ));
    }
    let base = flatten_string_table(table.get("base"), origin, &format!("{appearance}.base"))?;
    let palette = flatten_string_table(
        table.get("palette"),
        origin,
        &format!("{appearance}.palette"),
    )?;
    let keys = flatten_key_table(table.get("keys"), origin, &format!("{appearance}.keys"))?;
    validate_variant(&base, &palette, &keys, origin, appearance)?;
    Ok(ThemeVariant {
        base,
        palette,
        keys,
    })
}

fn flatten_string_table(
    value: Option<&toml::Value>,
    origin: &str,
    field: &str,
) -> Result<BTreeMap<String, String>, ThemeError> {
    let Some(value) = value else {
        return if field.ends_with(".base") {
            Err(validation(origin, format!("[{field}] is required")))
        } else {
            Ok(BTreeMap::new())
        };
    };
    let mut out = BTreeMap::new();
    flatten_strings(value, "", &mut out, origin, field)?;
    Ok(out)
}

fn flatten_key_table(
    value: Option<&toml::Value>,
    origin: &str,
    field: &str,
) -> Result<BTreeMap<String, ThemeKeyValue>, ThemeError> {
    let Some(value) = value else {
        return Ok(BTreeMap::new());
    };
    let mut out = BTreeMap::new();
    flatten_keys(value, "", &mut out, origin, field)?;
    Ok(out)
}

fn flatten_strings(
    value: &toml::Value,
    prefix: &str,
    out: &mut BTreeMap<String, String>,
    origin: &str,
    field: &str,
) -> Result<(), ThemeError> {
    let table = value
        .as_table()
        .ok_or_else(|| validation(origin, format!("[{field}] must contain string leaves")))?;
    for (key, value) in table {
        let dotted = if prefix.is_empty() {
            key.clone()
        } else {
            format!("{prefix}.{key}")
        };
        if let Some(string) = value.as_str() {
            insert_leaf(out, dotted, string.to_string(), origin)?;
        } else if value.is_table() {
            flatten_strings(value, &dotted, out, origin, field)?;
        } else {
            return Err(validation(
                origin,
                format!("{field}.{dotted} must be a string"),
            ));
        }
    }
    Ok(())
}

fn flatten_keys(
    value: &toml::Value,
    prefix: &str,
    out: &mut BTreeMap<String, ThemeKeyValue>,
    origin: &str,
    field: &str,
) -> Result<(), ThemeError> {
    let table = value
        .as_table()
        .ok_or_else(|| validation(origin, format!("[{field}] must be a table")))?;
    for (key, value) in table {
        let dotted = if prefix.is_empty() {
            key.clone()
        } else {
            format!("{prefix}.{key}")
        };
        if let Some(string) = value.as_str() {
            insert_leaf(
                out,
                dotted,
                ThemeKeyValue::Color(string.to_string()),
                origin,
            )?;
        } else if let Some(style) =
            parse_style(value, &dotted).map_err(|message| validation(origin, message))?
        {
            insert_leaf(out, dotted, ThemeKeyValue::Styled(style), origin)?;
        } else if value.is_table() {
            flatten_keys(value, &dotted, out, origin, field)?;
        } else {
            return Err(validation(
                origin,
                format!("{field}.{dotted} must be a colour or style"),
            ));
        }
    }
    Ok(())
}

/// `Ok(None)` means "not a style table" — the caller then tries to descend
/// into it as a nested group of keys. `Err` is reserved for a table that is
/// unmistakably meant as a style and cannot be honoured.
fn parse_style(value: &toml::Value, key: &str) -> Result<Option<ThemeKeyStyle>, String> {
    let Some(table) = value.as_table() else {
        return Ok(None);
    };
    let Some(color) = table.get("color").and_then(toml::Value::as_str) else {
        return Ok(None);
    };
    if table.contains_key("font_style") {
        return Err(format!(
            "{key} sets font_style, which Atlas does not apply — a theme key is a colour. \
             Remove it; leaving it in would silently render upright."
        ));
    }
    if table.keys().any(|key| key != "color") {
        return Ok(None);
    }
    Ok(Some(ThemeKeyStyle {
        color: color.to_string(),
    }))
}

fn insert_leaf<T>(
    out: &mut BTreeMap<String, T>,
    key: String,
    value: T,
    origin: &str,
) -> Result<(), ThemeError> {
    if out
        .keys()
        .any(|existing| is_leaf_prefix(existing, &key) || is_leaf_prefix(&key, existing))
    {
        return Err(validation(
            origin,
            format!("'{key}' is both a leaf and a prefix"),
        ));
    }
    out.insert(key, value);
    Ok(())
}

fn is_leaf_prefix(leaf: &str, key: &str) -> bool {
    key.strip_prefix(leaf)
        .is_some_and(|rest| rest.starts_with('.'))
}

fn validate_variant(
    base: &BTreeMap<String, String>,
    palette: &BTreeMap<String, String>,
    keys: &BTreeMap<String, ThemeKeyValue>,
    origin: &str,
    appearance: &str,
) -> Result<(), ThemeError> {
    let allowed_base = BASE_TOKENS.iter().copied().collect::<BTreeSet<_>>();
    if let Some(key) = base.keys().find(|key| !allowed_base.contains(key.as_str())) {
        return Err(validation(
            origin,
            format!("unknown base token '{key}' in {appearance}"),
        ));
    }
    let missing = BASE_TOKENS
        .iter()
        .filter(|key| !base.contains_key(**key))
        .copied()
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(validation(
            origin,
            format!(
                "missing base token(s) in {appearance}: {}",
                missing.join(", ")
            ),
        ));
    }
    let palette_keys = PALETTE_KEYS.iter().copied().collect::<BTreeSet<_>>();
    if let Some(key) = palette
        .keys()
        .find(|key| !palette_keys.contains(key.as_str()))
    {
        return Err(validation(
            origin,
            format!("unknown palette colour '{key}' in {appearance}"),
        ));
    }
    for (key, value) in base {
        if NON_COLOR_BASE_TOKENS.contains(&key.as_str()) {
            if !is_safe_css_value(value) {
                return Err(validation(
                    origin,
                    format!("{appearance}.base.{key} contains characters a CSS value cannot hold (such as ; {{ }} < \\)"),
                ));
            }
        } else if !is_css_color(value) {
            return Err(validation(
                origin,
                format!("{appearance}.base.{key} is not a CSS colour"),
            ));
        }
    }
    for (key, value) in palette {
        if !is_css_color(value) {
            return Err(validation(
                origin,
                format!("{appearance}.palette.{key} is not a CSS colour"),
            ));
        }
    }
    for (key, value) in keys {
        if !is_css_color(value.color()) {
            return Err(validation(
                origin,
                format!("{appearance}.keys.{key} is not a CSS colour"),
            ));
        }
    }
    Ok(())
}

fn collect_warnings(theme: &mut Theme) {
    let known = theme_keys().collect::<BTreeSet<_>>();
    for (appearance, variant) in [
        ("dark", theme.dark.as_ref()),
        ("light", theme.light.as_ref()),
    ] {
        if let Some(variant) = variant {
            for key in variant
                .keys
                .keys()
                .filter(|key| !known.contains(key.as_str()))
            {
                theme.warnings.push(ThemeWarning {
                    key: format!("{appearance}.keys.{key}"),
                    message: "unknown theme key; preserved for forward compatibility".to_string(),
                });
            }
        }
    }
}

/// `true` when `value` is acceptable for base token `key`: a CSS colour for a
/// colour token, and CSS-safe free text for the rest.
pub fn is_valid_base_value(key: &str, value: &str) -> bool {
    if NON_COLOR_BASE_TOKENS.contains(&key) {
        is_safe_css_value(value)
    } else {
        is_css_color(value)
    }
}

/// `true` when `value` can be written as a custom property's value inside the
/// `:root { … }` block the frontend builds, and stay one value.
///
/// A font stack or a shadow is free text, so this is a denylist: nothing that
/// ends the declaration or the block (`;` `{` `}`), opens markup (`<` `>`),
/// escapes (`\`), opens a comment, reaches the network (`url(`, `@import`),
/// breaks the line, or leaves a string open for the rest of the block to fall
/// into. Every value the built-ins ship — `"Segoe UI", sans-serif`,
/// `0 1px 3px 0 hsl(0 0% 0% / 0.1)` — passes.
pub fn is_safe_css_value(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    value.len() <= 512
        && !value
            .chars()
            .any(|c| matches!(c, ';' | '{' | '}' | '<' | '>' | '\\') || c.is_control())
        && !value.contains("/*")
        && !value.contains("*/")
        && !lower.contains("url(")
        && !lower.contains("image-set(")
        && !lower.contains("@import")
        && !lower.contains("expression(")
        && value.matches('"').count().is_multiple_of(2)
        && value.matches('\'').count().is_multiple_of(2)
}

pub fn is_css_color(value: &str) -> bool {
    let value = value.trim();
    if let Some(hex) = value.strip_prefix('#') {
        return matches!(hex.len(), 3 | 4 | 6 | 8)
            && hex.bytes().all(|byte| byte.is_ascii_hexdigit());
    }
    for name in ["rgb", "rgba", "hsl", "hsla", "oklch"] {
        if let Some(body) = value
            .strip_prefix(name)
            .and_then(|rest| rest.strip_prefix('('))
            .and_then(|rest| rest.strip_suffix(')'))
        {
            return validate_color_function(name, body);
        }
    }
    false
}

fn validate_color_function(name: &str, body: &str) -> bool {
    if body.trim().is_empty() || body.contains(['(', ')']) {
        return false;
    }
    let normalized = body.replace(',', " ").replace('/', " / ");
    let parts = normalized.split_whitespace().collect::<Vec<_>>();
    let slash = parts.iter().position(|part| *part == "/");
    // Both arms are a comparison and a length, so there is nothing to defer.
    let alpha_as_fourth_channel = matches!(name, "rgba" | "hsla") && parts.len() == 4;
    let channels = slash.unwrap_or(if alpha_as_fourth_channel {
        3
    } else {
        parts.len()
    });
    if channels != 3 || slash.is_some_and(|index| parts.len() != index + 2) {
        return false;
    }
    if !parts[..channels].iter().all(|part| parse_number(part)) {
        return false;
    }
    if let Some(index) = slash {
        if !parse_number(parts[index + 1]) {
            return false;
        }
    } else if matches!(name, "rgba" | "hsla") && parts.len() == 4 {
        return parse_number(parts[3]);
    } else if parts.len() != 3 {
        return false;
    }
    true
}

fn parse_number(value: &str) -> bool {
    let value = value
        .strip_suffix('%')
        .or_else(|| value.strip_suffix("deg"))
        .unwrap_or(value);
    value.parse::<f64>().is_ok_and(f64::is_finite)
}

pub(crate) fn validation(origin: &str, message: impl Into<String>) -> ThemeError {
    ThemeError::Validation {
        origin: origin.to_string(),
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_theme(extra: &str) -> String {
        let base = BASE_TOKENS
            .iter()
            .map(|key| {
                let value = if NON_COLOR_BASE_TOKENS.contains(key) {
                    "1rem"
                } else {
                    "#123456"
                };
                format!("\"{key}\" = \"{value}\"")
            })
            .collect::<Vec<_>>()
            .join("\n");
        format!(
            "schema = 1\nid = \"test\"\nname = \"Test\"\nauthor = \"Test\"\nlicense = \"MIT\"\n[dark.base]\n{base}\n{extra}\n"
        )
    }

    #[test]
    fn built_ins_load_and_have_unique_ids() {
        let themes = built_in_themes().unwrap();
        assert_eq!(themes.len(), BUILT_INS.len());
        let ids = themes
            .iter()
            .map(|theme| &theme.id)
            .collect::<BTreeSet<_>>();
        assert_eq!(ids.len(), themes.len());
    }

    #[test]
    fn flattens_nested_theme_keys() {
        let theme = parse_theme(
            &minimal_theme("[dark.keys.terminal.ansi]\nred = \"rgb(255 0 0)\""),
            "test",
        )
        .unwrap();
        assert_eq!(
            theme.dark.unwrap().keys["terminal.ansi.red"].color(),
            "rgb(255 0 0)"
        );
    }

    #[test]
    fn rejects_unknown_top_level_and_base_fields() {
        let top = minimal_theme("").replacen("[dark.base]", "mystery = true\n[dark.base]", 1);
        assert!(matches!(
            parse_theme(&top, "test"),
            Err(ThemeError::Toml { .. })
        ));
        let base =
            minimal_theme("").replacen("[dark.base]\n", "[dark.base]\nmystery = \"#fff\"\n", 1);
        assert!(parse_theme(&base, "test")
            .unwrap_err()
            .to_string()
            .contains("unknown base token"));
    }

    #[test]
    fn rejects_leaf_prefix_conflicts() {
        let source =
            minimal_theme("[dark.keys]\nsyntax = \"#fff\"\n[dark.keys.syntax]\nkeyword = \"#000\"");
        assert!(parse_theme(&source, "test").is_err());
    }

    /// Accepted-and-ignored is the worst of the three options: the author
    /// gets no error and no italics, and nothing tells them which it is.
    #[test]
    fn font_style_is_rejected_rather_than_silently_dropped() {
        let source = minimal_theme(
            "[dark.keys]\nsyntax.keyword = { color = \"#c678dd\", font_style = \"italic\" }",
        );
        let error = parse_theme(&source, "test").unwrap_err().to_string();
        assert!(error.contains("font_style"), "{error}");
        assert!(error.contains("syntax.keyword"), "{error}");

        // The table spelling itself stays valid without it.
        let plain = minimal_theme("[dark.keys]\nsyntax.keyword = { color = \"#c678dd\" }");
        assert_eq!(
            parse_theme(&plain, "test").unwrap().dark.unwrap().keys["syntax.keyword"].color(),
            "#c678dd"
        );
    }

    #[test]
    fn unknown_theme_keys_are_warnings() {
        let theme = parse_theme(&minimal_theme("[dark.keys]\nfuture = \"#fff\""), "test").unwrap();
        assert_eq!(theme.warnings.len(), 1);
    }

    #[test]
    fn validates_supported_css_colour_syntaxes() {
        for color in [
            "#abc",
            "#abcd",
            "#aabbcc",
            "#aabbccdd",
            "rgb(1 2 3 / 50%)",
            "rgba(1, 2, 3, 0.5)",
            "hsl(120 50% 50%)",
            "oklch(0.7 0.2 120 / .8)",
        ] {
            assert!(is_css_color(color), "{color}");
        }
        for color in ["red", "#12", "rgb()", "oklch(nope 1 2)"] {
            assert!(!is_css_color(color), "{color}");
        }
    }

    /// A theme author edits one file at a time. Before this, the first
    /// unparseable file in the directory short-circuited the whole catalog and
    /// took the built-ins with it — the picker went empty and the app had no
    /// theme to fall back to.
    #[test]
    fn one_bad_user_theme_is_skipped_and_the_rest_still_load() {
        let dir = tempfile::tempdir().unwrap();
        // Sorted first, so a short-circuit would drop both good files.
        fs::write(
            dir.path().join("0-broken.toml"),
            "schema = 1\nid = \"broken\"\n",
        )
        .unwrap();
        fs::write(dir.path().join("1-not-toml.toml"), "}{ this is not toml").unwrap();
        fs::write(
            dir.path().join("2-good.toml"),
            minimal_theme("").replace("id = \"test\"", "id = \"good\""),
        )
        .unwrap();
        fs::write(dir.path().join("ignored.txt"), "not a theme").unwrap();

        let (themes, warnings) = load_user_themes_from(dir.path()).unwrap();

        assert_eq!(
            themes
                .iter()
                .map(|theme| theme.id.as_str())
                .collect::<Vec<_>>(),
            ["good"]
        );
        assert_eq!(warnings.len(), 2, "{warnings:?}");
        assert_eq!(warnings[0].key, "0-broken.toml");
        assert_eq!(warnings[1].key, "1-not-toml.toml");
        assert!(warnings.iter().all(|warning| !warning.message.is_empty()));
    }

    // ── config_root (must track `config_root` in `atlas_config.rs`; #64 follow-up) ──

    /// The bug this whole fix exists for: `dirs::config_dir()` resolves to
    /// `~/Library/Application Support` on macOS, which contradicts every
    /// other place Atlas resolves its config root and the crate's own doc
    /// comments. Pin the resolved *theme* directory under `~/.config/atlas`
    /// and assert "Application Support" never appears in it.
    #[test]
    fn user_theme_dir_lives_under_dot_config_atlas_not_application_support() {
        let home = PathBuf::from("/Users/someone");
        let root = config_root_from(None, Some(&home)).expect("a home resolves a root");
        let themes = root.join("themes");

        assert_eq!(themes, PathBuf::from("/Users/someone/.config/atlas/themes"));
        assert!(!themes.to_string_lossy().contains("Application Support"));
        assert!(!themes.to_string_lossy().contains("Library"));
    }

    /// Same fixtures as `atlas_config.rs`'s `an_absolute_xdg_config_home_wins`
    /// — the two resolvers must agree on every input, and this is the input
    /// that most needs to be right, since it's how a user relocates config
    /// for every tool they run.
    #[test]
    fn an_absolute_xdg_config_home_wins() {
        let xdg = PathBuf::from("/elsewhere/cfg");
        let home = PathBuf::from("/Users/someone");

        let root = config_root_from(Some(&xdg), Some(&home)).unwrap();

        assert_eq!(root, PathBuf::from("/elsewhere/cfg/atlas"));
    }

    /// A relative `$XDG_CONFIG_HOME` is ignored rather than resolved against
    /// the cwd, matching `atlas_config.rs`'s `config_root_from` exactly.
    #[test]
    fn a_relative_xdg_config_home_is_ignored() {
        let xdg = PathBuf::from("relative/cfg");
        let home = PathBuf::from("/Users/someone");

        let root = config_root_from(Some(&xdg), Some(&home)).unwrap();

        assert_eq!(root, PathBuf::from("/Users/someone/.config/atlas"));
    }

    #[test]
    fn no_home_and_no_xdg_resolves_nothing() {
        assert_eq!(config_root_from(None, None), None);
        assert_eq!(config_root_from(Some(&PathBuf::from("rel")), None), None);
    }

    /// Free-text base tokens are written into a `:root { … }` style block, so
    /// a value that closes the block would be CSS injection from a theme file.
    #[test]
    fn free_text_base_tokens_cannot_break_out_of_the_style_block() {
        for bad in [
            "1rem; } body { display: none",
            "Inter</style><script>",
            "0 0 0 red\\3b",
            "Inter /* comment",
            "url(https://example.com/x)",
            "\"Inter",
            "Inter\nsans",
            "@import 'x'",
        ] {
            let source = minimal_theme("").replacen(
                "\"font-sans\" = \"1rem\"",
                &format!("\"font-sans\" = {bad:?}"),
                1,
            );
            assert_ne!(source, minimal_theme(""), "fixture replaced");
            let error = parse_theme(&source, "test").unwrap_err().to_string();
            assert!(error.contains("dark.base.font-sans"), "{bad:?}: {error}");
        }
        for good in [
            "\"Segoe UI\", ui-sans-serif, system-ui",
            "0 1px 3px 0 hsl(0 0% 0% / 0.1)",
            "0.625rem",
            "-0.01em",
        ] {
            assert!(is_safe_css_value(good), "{good:?}");
            assert!(is_valid_base_value("font-sans", good), "{good:?}");
        }
        assert!(!is_valid_base_value("background", "1rem"));
        assert!(is_valid_base_value("background", "#fff"));
    }

    #[test]
    fn an_unlistable_user_theme_dir_is_a_warning_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        // A file where the directory should be: `exists()` holds, `read_dir` fails.
        let not_a_dir = dir.path().join("themes");
        fs::write(&not_a_dir, "").unwrap();
        let (themes, warnings) = load_user_themes_from(&not_a_dir).unwrap();
        assert!(themes.is_empty());
        assert_eq!(warnings.len(), 1, "{warnings:?}");
    }

    #[test]
    fn reads_are_not_theme_changes() {
        use notify::event::{AccessKind, AccessMode, CreateKind, ModifyKind};
        let event = |kind| notify::Event::new(kind).add_path(PathBuf::from("/t/x.toml"));
        assert!(!is_theme_change(&event(EventKind::Access(
            AccessKind::Open(AccessMode::Read)
        ))));
        assert!(!is_theme_change(&event(EventKind::Access(
            AccessKind::Close(AccessMode::Read)
        ))));
        assert!(is_theme_change(&event(EventKind::Modify(ModifyKind::Any))));
        assert!(is_theme_change(&event(EventKind::Create(CreateKind::File))));
        let other = notify::Event::new(EventKind::Modify(ModifyKind::Any))
            .add_path(PathBuf::from("/t/x.txt"));
        assert!(!is_theme_change(&other));
    }

    #[test]
    fn a_burst_of_changes_is_reported_once() {
        let (tx, rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            debounce(&rx, Duration::from_millis(50), move || {
                done_tx.send(()).unwrap()
            })
        });
        for _ in 0..20 {
            tx.send(()).unwrap();
        }
        done_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("one change is reported");
        assert!(
            done_rx.recv_timeout(Duration::from_millis(200)).is_err(),
            "and only one"
        );
        tx.send(()).unwrap();
        done_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("a later change is reported again");
        drop(tx);
        worker.join().unwrap();
    }

    #[test]
    fn a_missing_user_theme_dir_is_not_a_failure() {
        let dir = tempfile::tempdir().unwrap();
        let (themes, warnings) = load_user_themes_from(&dir.path().join("nope")).unwrap();
        assert!(themes.is_empty() && warnings.is_empty());
    }

    /// `theme-keys.txt` is generated; a hand-edit that drops the tab or the
    /// description would silently empty the hovers in the schema.
    #[test]
    fn every_theme_key_carries_a_description() {
        let docs = theme_key_docs().collect::<Vec<_>>();
        // Floor guard only — the count is `keys.toml`'s to know, and the
        // 2026-09-18 key-set audit changed it once already.
        assert!(docs.len() > 50, "{} keys", docs.len());
        for (key, description) in &docs {
            assert!(!key.is_empty() && !key.contains(' '), "key {key:?}");
            assert!(
                description.ends_with('.'),
                "{key} description: {description:?}"
            );
        }
        assert_eq!(
            docs.iter()
                .map(|(key, _)| *key)
                .collect::<BTreeSet<_>>()
                .len(),
            docs.len()
        );
    }

    /// The point of the generated enum: an author's typo is an editor error
    /// rather than a colour that silently never appears.
    #[test]
    fn schema_closes_the_key_set() {
        let schema = json_schema();
        let keys = schema
            .pointer("/definitions/ThemeVariant/properties/keys")
            .unwrap();
        assert_eq!(keys["additionalProperties"], serde_json::Value::Bool(false));
        let properties = keys["properties"].as_object().unwrap();
        assert_eq!(properties.len(), theme_keys().count());
        let sample = &properties["terminal.ansi.red"];
        assert_eq!(sample["allOf"][0]["$ref"], "#/definitions/ThemeKeyValue");
        assert!(sample["description"].as_str().unwrap().contains("ANSI red"));
        assert!(!properties.contains_key("terminal.ansi.reddd"));
    }

    /// The id reaches `write_theme_to` from an import panel where the user
    /// types it, so the file name comes from the *parsed* theme and is checked
    /// rather than trusted. Without this, `../../../.zshrc` is a theme id.
    #[test]
    fn a_written_theme_is_named_by_its_own_id_and_cannot_escape_the_directory() {
        let dir = tempfile::tempdir().unwrap();
        let good = minimal_theme("").replace("id = \"test\"", "id = \"my-import_2\"");
        let path = write_theme_to(dir.path(), &good).unwrap();
        assert_eq!(path, dir.path().join("my-import_2.toml"));
        assert_eq!(load_theme_file(&path).unwrap().id, "my-import_2");

        for bad in ["../escape", "a/b", "", "with space"] {
            let source = minimal_theme("").replace("id = \"test\"", &format!("id = \"{bad}\""));
            assert!(
                write_theme_to(dir.path(), &source).is_err(),
                "accepted id {bad:?}"
            );
        }
        // Nothing else was created along the way.
        let written = fs::read_dir(dir.path()).unwrap().count();
        assert_eq!(written, 1);
    }

    /// Compared as parsed JSON, not text: `serde_json`'s `preserve_order` is
    /// enabled by sibling crates whenever the workspace is tested in one cargo
    /// invocation (`scripts/test-rust.sh`), which reorders object keys in the
    /// generated schema without changing it.
    #[test]
    fn generated_schema_is_current() {
        let committed: serde_json::Value =
            serde_json::from_str(include_str!("../schema/theme-v1.json")).unwrap();
        assert_eq!(committed, serde_json::to_value(json_schema()).unwrap());
    }

    #[test]
    fn browser_mock_snapshot_is_current() {
        let expected = serde_json::to_string_pretty(&built_in_themes().unwrap()).unwrap() + "\n";
        assert_eq!(
            include_str!("../../../src/dev/mock-backend/fixtures/builtin-themes.json"),
            expected
        );
    }

    /// The eight `[<variant>.palette]` names are *hues*, and everything
    /// derived from them — ANSI colours, diff tints, status colours, agent
    /// chips — trusts the name. The first port filled them by walking the old
    /// editor themes' *syntax* tokens instead (`red` took `regexp`, `yellow`
    /// took `type`, `blue` took `func`, …), which put One Dark's green in
    /// `red`, Dracula's cyan in `yellow` and Monokai's pink in `cyan`. Nothing
    /// failed to compile and every theme still rendered; it was only wrong.
    /// This pins each hue to its name so the same class of swap cannot return.
    #[test]
    fn palette_hues_match_the_names_they_are_filed_under() {
        /// Canonical hue angle, in degrees, for each palette name.
        const CANONICAL: &[(&str, f64)] = &[
            ("red", 0.0),
            ("orange", 30.0),
            ("yellow", 60.0),
            ("green", 120.0),
            ("cyan", 180.0),
            ("blue", 220.0),
            ("purple", 285.0),
            ("pink", 330.0),
        ];
        /// How far a hue may sit from its canonical angle. Generous on
        /// purpose: themes stretch their hues, and the bug this guards is a
        /// *swap* — 90°+ — not a stylistic lean.
        const TOLERANCE: f64 = 55.0;
        /// A theme is allowed to file a hue under a distant name when its
        /// upstream does. Each entry is (theme id, palette name, why).
        const EXCEPTIONS: &[(&str, &str, &str)] = &[
            (
                "rose-pine",
                "green",
                "Rosé Pine has no green; upstream's ANSI green is pine",
            ),
            ("rose-pine-moon", "green", "same as rose-pine"),
        ];

        /// Hue angle in degrees, and saturation, of a `#rrggbb` colour.
        fn hue_and_saturation(hex: &str) -> Option<(f64, f64)> {
            let hex = hex.strip_prefix('#').filter(|rest| rest.len() == 6)?;
            let channel = |index: usize| {
                u8::from_str_radix(&hex[index..index + 2], 16)
                    .ok()
                    .map(|v| f64::from(v) / 255.0)
            };
            let (r, g, b) = (channel(0)?, channel(2)?, channel(4)?);
            let max = r.max(g).max(b);
            let min = r.min(g).min(b);
            let delta = max - min;
            if delta == 0.0 {
                return Some((0.0, 0.0));
            }
            let hue = 60.0
                * if max == r {
                    ((g - b) / delta).rem_euclid(6.0)
                } else if max == g {
                    (b - r) / delta + 2.0
                } else {
                    (r - g) / delta + 4.0
                };
            let lightness = (max + min) / 2.0;
            Some((hue, delta / (1.0 - (2.0 * lightness - 1.0).abs())))
        }

        for theme in built_in_themes().unwrap() {
            for (appearance, variant) in [
                ("dark", theme.dark.as_ref()),
                ("light", theme.light.as_ref()),
            ] {
                let Some(variant) = variant else { continue };
                for (name, canonical) in CANONICAL {
                    let Some(value) = variant.palette.get(*name) else {
                        continue;
                    };
                    let (hue, saturation) =
                        hue_and_saturation(value).unwrap_or_else(|| panic!("{value} is #rrggbb"));
                    // A deliberately achromatic theme (Atlas Mono, Vesper's
                    // blue and purple) has no hue to be wrong about.
                    if saturation < 0.18 {
                        continue;
                    }
                    if EXCEPTIONS
                        .iter()
                        .any(|(id, key, _)| *id == theme.id && key == name)
                    {
                        continue;
                    }
                    let distance = (hue - canonical).abs().min(360.0 - (hue - canonical).abs());
                    assert!(
                        distance <= TOLERANCE,
                        "{}: {appearance}.palette.{name} = {value} is at hue {hue:.0}°, \
                         {distance:.0}° from the {canonical:.0}° that '{name}' names",
                        theme.id
                    );
                }
            }
        }
    }

    /// `chart-1..5` are five *series*, so the only thing they must do is stay
    /// tellable apart. Seven variants shipped with an outright repeated value
    /// (Rosé Pine drew `chart-1` and `chart-2` in the same pine), and three
    /// more were a couple of RGB steps apart — two tans in Chyral, a tan and a
    /// salmon in Atlas, an orange and a salmon in Mirage. Either way adjacent
    /// series render as one line. A plain RGB distance is crude, but it is
    /// blind to *how* two colours are close, which is the point: it catches a
    /// pair that differs only in lightness as readily as one that differs only
    /// in hue, and the latter is what red/green colour blindness collapses.
    #[test]
    fn chart_series_are_tellable_apart() {
        /// Below this Euclidean distance in 0–255 RGB, two series read as one.
        const FLOOR: f64 = 40.0;
        const CHART_KEYS: &[&str] = &["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"];

        fn rgb(hex: &str) -> [f64; 3] {
            let hex = hex.strip_prefix('#').expect("chart token is a hex colour");
            assert_eq!(hex.len(), 6, "chart token is #rrggbb, got {hex}");
            [0, 2, 4].map(|index| {
                f64::from(u8::from_str_radix(&hex[index..index + 2], 16).expect("hex digits"))
            })
        }

        for theme in built_in_themes().unwrap() {
            for (appearance, variant) in [
                ("dark", theme.dark.as_ref()),
                ("light", theme.light.as_ref()),
            ] {
                let Some(variant) = variant else { continue };
                for (index, key) in CHART_KEYS.iter().enumerate() {
                    for other in &CHART_KEYS[index + 1..] {
                        let (left, right) = (rgb(&variant.base[*key]), rgb(&variant.base[*other]));
                        let distance = left
                            .iter()
                            .zip(right.iter())
                            .map(|(a, b)| (a - b).powi(2))
                            .sum::<f64>()
                            .sqrt();
                        assert!(
                            distance >= FLOOR,
                            "{}: {appearance}.base.{key} ({}) and {other} ({}) are {distance:.0} \
                             apart; adjacent chart series will read as one",
                            theme.id,
                            variant.base[*key],
                            variant.base[*other],
                        );
                    }
                }
            }
        }
    }

    /// A light appearance that copies its shadow ramp byte-for-byte from
    /// dark renders pure-black halos on a light surface: dark's alphas run
    /// up to 0.9, which reads as a heavy ring rather than a soft lift once
    /// the surface itself is light (rose-pine.toml shipped exactly this
    /// bug). Every built-in theme that ships both appearances must give
    /// light its own ramp, and that ramp must actually be lighter.
    #[test]
    fn light_shadow_ramp_is_not_copied_from_dark() {
        const SHADOW_KEYS: &[&str] = &[
            "shadow-2xs",
            "shadow-xs",
            "shadow-sm",
            "shadow-md",
            "shadow-lg",
            "shadow-xl",
            "shadow-2xl",
        ];

        fn shadow_alpha(value: &str) -> f64 {
            let start = value.rfind(',').expect("shadow value has an alpha channel");
            let end = value.rfind(')').expect("shadow value is a function call");
            value[start + 1..end]
                .trim()
                .parse()
                .expect("alpha channel is numeric")
        }

        for theme in built_in_themes().unwrap() {
            let (Some(dark), Some(light)) = (&theme.dark, &theme.light) else {
                continue;
            };
            for key in SHADOW_KEYS {
                let dark_value = &dark.base[*key];
                let light_value = &light.base[*key];
                assert_ne!(
                    dark_value, light_value,
                    "{}: light.base.{key} is byte-identical to dark.base.{key}",
                    theme.id
                );
                let alpha = shadow_alpha(light_value);
                assert!(
                    alpha <= 0.5,
                    "{}: light.base.{key} alpha {alpha} reads as a heavy black halo on a light surface",
                    theme.id
                );
            }
        }
    }
}
