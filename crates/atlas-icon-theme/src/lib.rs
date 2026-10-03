//! Icon themes: VS Code's `iconThemes` format, loaded, resolved and served.
//!
//! Atlas takes the format verbatim (decision 4), so a theme published for VS
//! Code installs here unchanged. This crate owns everything about that: the
//! document shape ([`format`]), the precedence rules ([`resolve`]), the
//! `.vsix` reader ([`vsix`]), and the catalog of what is installed.
//!
//! # The lazy part
//!
//! Material Icon Theme — the bundled default (decision 12) — is a 444 KB
//! document naming 1,251 SVGs that come to about 1 MB. None of that may reach
//! the webview at startup, so the API is split in three:
//!
//!   * [`resolve_icons`] answers *which* definition each visible path uses. The
//!     reply is one short id per row, and glyph definitions carry their
//!     character and colour inline because those are a few bytes each.
//!   * [`icon_assets`] fetches the SVG source for a batch of definition ids.
//!     The frontend asks only for ids it has not already cached, so a project
//!     of TypeScript files transfers a handful of icons, not a thousand.
//!   * [`icon_fonts`] fetches a glyph theme's web fonts, and is never called
//!     for a theme that has none.
//!
//! The document itself is parsed once per theme and cached in-process; the
//! cache is dropped when a theme is installed or removed.

use std::collections::BTreeMap;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub mod format;
pub mod resolve;
pub mod vsix;

pub use format::{
    Associations, DefinitionKind, IconDefinition, IconFont, IconFontSource, IconThemeDocument,
    IconThemeWarning,
};
pub use resolve::{Appearance, IconKind, IconRequest};

/// The id of the theme that renders Atlas's own lucide icons — the opt-out.
///
/// It is not a document: "minimal" means *no icon theme*, and the frontend
/// keeps rendering what it rendered before icon themes existed. Modelling it
/// as an empty theme instead would have meant inventing 1,200 lucide
/// associations to say "carry on".
pub const MINIMAL_ICON_THEME_ID: &str = "minimal";

/// The bundled default (decision 12).
pub const MATERIAL_ICON_THEME_ID: &str = "material-icon-theme";

/// What a fresh install selects.
pub const DEFAULT_ICON_THEME_ID: &str = MATERIAL_ICON_THEME_ID;

const MATERIAL_DOCUMENT: &str =
    include_str!("../vendor/material-icon-theme/dist/material-icons.json");
const MATERIAL_BLOB: &str = include_str!(concat!(env!("OUT_DIR"), "/material_icons_blob.txt"));
include!(concat!(env!("OUT_DIR"), "/material_icons_index.rs"));

#[derive(Debug, Error)]
pub enum IconThemeError {
    #[error("icon theme \"{id}\" is not installed")]
    NotFound { id: String },
    #[error("{origin}: {message}")]
    Parse { origin: String, message: String },
    #[error("{path}: {source}")]
    Io { path: PathBuf, source: io::Error },
    #[error("{message}")]
    Vsix { message: String },
    #[error("{message}")]
    Install { message: String },
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/// One row in the icon-theme picker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IconThemeSummary {
    pub id: String,
    pub name: String,
    pub author: String,
    pub license: String,
    /// `true` for `minimal` and the bundled Material theme — neither can be
    /// removed.
    pub built_in: bool,
    /// The theme asks the explorer to drop its twisty chevrons, because its
    /// folder icons already say open or closed.
    pub hides_explorer_arrows: bool,
    /// `true` when the theme has no document at all (`minimal`), so the
    /// frontend knows to use its own icons without asking for any.
    pub uses_fallback_icons: bool,
    /// Survivable problems found while loading. Never blocks the theme.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<IconThemeWarning>,
}

/// Where a theme's files come from.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Source {
    /// No document: Atlas's own icons.
    Fallback,
    /// Compiled into the binary. `doc_dir` is the document's directory inside
    /// the vendored tree, which is what relative `iconPath`s resolve against.
    Embedded { doc_dir: &'static str },
    /// An unpacked VS Code extension under the user's icon-theme directory.
    /// `root` is the extension directory: every file the theme names must
    /// resolve inside it, however many `..` its paths carry.
    Directory { root: PathBuf, document: PathBuf },
}

/// A theme with its document parsed, as the cache holds it.
#[derive(Debug)]
pub struct LoadedIconTheme {
    pub summary: IconThemeSummary,
    /// `None` only for `minimal`.
    pub document: Option<IconThemeDocument>,
    source: Source,
}

/// `~/.config/atlas/icon-themes` (or `$XDG_CONFIG_HOME/atlas/icon-themes`),
/// the sibling of `~/.config/atlas/themes`.
///
/// No migration reads or moves an old `~/Library/Application Support/atlas/
/// icon-themes` (the path a `dirs::config_dir()` bug used to resolve here on
/// macOS): this crate has never shipped past a version branch — `git
/// merge-base --is-ancestor main HEAD` on the branch that fixed this holds,
/// and `crates/atlas-icon-theme` does not exist on `main` at all yet — so
/// there is no installed build that could have written an icon theme there.
/// A migration would add a permanent code path and test surface to guard
/// against a location no released Atlas ever used.
pub fn user_icon_theme_dir() -> Option<PathBuf> {
    config_root().map(|dir| dir.join("icon-themes"))
}

/// `~/.config/atlas/` (`atlas-dev/` under the dev profile, see
/// `atlas-profile`) — the same root `src-tauri/src/state/atlas_config.rs`
/// resolves for `config.toml`, **not** `dirs::config_dir()` (which on macOS is
/// `~/Library/Application Support`). `atlas-icon-theme` sits below `src-tauri`
/// in the dependency graph — the app crate depends on this one, not the other
/// way round — so it cannot call that function directly without a cycle.
///
/// This is a deliberate, minimal copy of its logic (XDG override, `.config`
/// fallback), not an independent decision about where config lives — the same
/// copy `atlas-theme` carries for its own `user_theme_dir()`. Keep all three
/// in sync by hand: the `config_root` tests below run the exact fixtures
/// `atlas_config.rs`'s own `config_root_from` tests use (same inputs, same
/// expected paths), so an edit to any one of them that changes the resolved
/// path breaks a test right next to the copy that drifted.
fn config_root() -> Option<PathBuf> {
    let xdg = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from);
    let home = dirs::home_dir().or_else(|| std::env::var_os("HOME").map(PathBuf::from));
    config_root_from(xdg.as_deref(), home.as_deref())
}

/// The decision itself, taking its inputs rather than reading the
/// environment, so it can be tested without racing every other test in the
/// process over `set_var` — mirrors `config_root_from` in `atlas_config.rs`
/// (and its copy in `atlas-theme`) exactly, including the same
/// relative-XDG and no-home edge cases.
fn config_root_from(xdg: Option<&Path>, home: Option<&Path>) -> Option<PathBuf> {
    if let Some(xdg) = xdg {
        if xdg.is_absolute() {
            return Some(xdg.join(atlas_profile::config_dir_name()));
        }
    }
    home.map(|home| home.join(".config").join(atlas_profile::config_dir_name()))
}

fn minimal_summary() -> IconThemeSummary {
    IconThemeSummary {
        id: MINIMAL_ICON_THEME_ID.to_string(),
        name: "Minimal".to_string(),
        author: "Atlas".to_string(),
        license: "MIT".to_string(),
        built_in: true,
        hides_explorer_arrows: false,
        uses_fallback_icons: true,
        warnings: Vec::new(),
    }
}

/// The metadata Atlas reads out of an unpacked extension's `package.json`.
///
/// Everything else in a VS Code manifest — activation events, commands,
/// configuration — describes an extension host Atlas does not have, so it is
/// not modelled. `serde` ignores unknown fields, which is the whole point.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionManifest {
    #[serde(default)]
    name: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    publisher: Option<String>,
    #[serde(default)]
    license: Option<String>,
    #[serde(default)]
    contributes: Contributes,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contributes {
    #[serde(default)]
    icon_themes: Vec<IconThemeContribution>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IconThemeContribution {
    #[serde(default)]
    label: Option<String>,
    path: String,
}

impl ExtensionManifest {
    fn read(root: &Path) -> Result<Self, IconThemeError> {
        let path = root.join("package.json");
        let source = read_text_within(root, &path, MAX_DOCUMENT_BYTES)?;
        serde_json::from_str(&source).map_err(|error| IconThemeError::Parse {
            origin: path.display().to_string(),
            message: error.to_string(),
        })
    }
}

/// Read one unpacked VS Code extension directory as an icon theme.
///
/// `root` is the directory holding `package.json` — the `extension/` subtree of
/// a `.vsix`, unpacked. Public so a test can exercise a theme without one being
/// installed in the real config directory.
pub fn load_from_directory(id: &str, root: &Path) -> Result<LoadedIconTheme, IconThemeError> {
    let manifest = ExtensionManifest::read(root)?;
    let contribution =
        manifest
            .contributes
            .icon_themes
            .first()
            .ok_or_else(|| IconThemeError::Parse {
                origin: root.join("package.json").display().to_string(),
                message: "declares no `contributes.iconThemes`".to_string(),
            })?;
    let document_path =
        resolve_relative(root, root, &contribution.path).ok_or_else(|| IconThemeError::Parse {
            origin: root.join("package.json").display().to_string(),
            message: format!("`{}` points outside the extension", contribution.path),
        })?;
    let source = read_text_within(root, &document_path, MAX_DOCUMENT_BYTES)?;
    let document = IconThemeDocument::parse(&source, &document_path.display().to_string())?;
    let summary = IconThemeSummary {
        id: id.to_string(),
        name: contribution
            .label
            .clone()
            .or_else(|| manifest.display_name.clone())
            .unwrap_or_else(|| manifest.name.clone()),
        author: manifest
            .publisher
            .clone()
            .unwrap_or_else(|| "Unknown".to_string()),
        license: manifest
            .license
            .clone()
            .unwrap_or_else(|| "Unspecified".to_string()),
        built_in: false,
        hides_explorer_arrows: document.hides_explorer_arrows,
        uses_fallback_icons: false,
        warnings: document.warnings(),
    };
    Ok(LoadedIconTheme {
        summary,
        document: Some(document),
        source: Source::Directory {
            root: root.to_path_buf(),
            document: document_path,
        },
    })
}

fn load_material() -> Result<LoadedIconTheme, IconThemeError> {
    let document = IconThemeDocument::parse(MATERIAL_DOCUMENT, "material-icon-theme")?;
    let summary = IconThemeSummary {
        id: MATERIAL_ICON_THEME_ID.to_string(),
        name: "Material Icon Theme".to_string(),
        author: "Philipp Kief (Material Extensions)".to_string(),
        license: "MIT".to_string(),
        built_in: true,
        hides_explorer_arrows: document.hides_explorer_arrows,
        uses_fallback_icons: false,
        warnings: document.warnings(),
    };
    Ok(LoadedIconTheme {
        summary,
        document: Some(document),
        source: Source::Embedded { doc_dir: "dist" },
    })
}

/// Ceilings on what one file a theme names may weigh. A theme is a
/// third-party artifact, so an `iconPath` of `../../../../dev/zero` or a
/// 4 GB "font" has to fail as a missing icon rather than as the app running
/// out of memory. Material's document is 444 KB and its largest SVG 30 KB.
const MAX_DOCUMENT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ASSET_BYTES: u64 = 4 * 1024 * 1024;
const MAX_FONT_BYTES: u64 = 8 * 1024 * 1024;

/// Join a relative `iconPath` onto `base`, folding `.` and `..`, without ever
/// leaving `root`.
///
/// Material's paths look like `./../icons/git.svg` relative to `dist/`, so
/// this has to actually normalise rather than concatenate — and a `..` that
/// would climb above the extension directory is refused (`None`) rather than
/// followed, because the path is the theme's to choose and the directory it
/// escapes into is the user's.
fn resolve_relative(root: &Path, base: &Path, relative: &str) -> Option<PathBuf> {
    let mut segments: Vec<String> = base
        .strip_prefix(root)
        .ok()?
        .components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect();
    for segment in relative.replace('\\', "/").split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop()?;
            }
            // A drive prefix would make `push` replace the whole path.
            other if other.contains(':') => return None,
            other => segments.push(other.to_string()),
        }
    }
    let mut out = root.to_path_buf();
    out.extend(segments);
    Some(out)
}

/// Read a file the theme names, provided it is a regular file, inside `root`
/// once symlinks are resolved, and no larger than `cap`.
///
/// [`resolve_relative`] already keeps `..` inside the extension; this is the
/// second half, for a symlink that points out of it and for a device node or
/// FIFO that would never finish reading.
fn read_within(root: &Path, path: &Path, cap: u64) -> Result<Vec<u8>, IconThemeError> {
    let io_error = |source| IconThemeError::Io {
        path: path.to_path_buf(),
        source,
    };
    let canonical_root = root.canonicalize().map_err(io_error)?;
    let canonical = path.canonicalize().map_err(io_error)?;
    if !canonical.starts_with(&canonical_root) {
        return Err(IconThemeError::Parse {
            origin: path.display().to_string(),
            message: "resolves outside the extension directory".to_string(),
        });
    }
    let metadata = std::fs::metadata(&canonical).map_err(io_error)?;
    if !metadata.is_file() {
        return Err(IconThemeError::Parse {
            origin: path.display().to_string(),
            message: "is not a regular file".to_string(),
        });
    }
    if metadata.len() > cap {
        return Err(IconThemeError::Parse {
            origin: path.display().to_string(),
            message: format!("is {} bytes, past the {cap} accepted", metadata.len()),
        });
    }
    let file = std::fs::File::open(&canonical).map_err(io_error)?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    // `take` as well as the metadata check: a file can grow between the two.
    file.take(cap + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() as u64 > cap {
        return Err(IconThemeError::Parse {
            origin: path.display().to_string(),
            message: format!("grew past the {cap} bytes accepted while being read"),
        });
    }
    Ok(bytes)
}

fn read_text_within(root: &Path, path: &Path, cap: u64) -> Result<String, IconThemeError> {
    String::from_utf8(read_within(root, path, cap)?).map_err(|_| IconThemeError::Parse {
        origin: path.display().to_string(),
        message: "is not UTF-8 text".to_string(),
    })
}

/// The same, over the embedded tree's virtual paths.
fn resolve_relative_virtual(dir: &str, relative: &str) -> String {
    let mut out: Vec<String> = dir
        .split('/')
        .filter(|s| !s.is_empty() && *s != ".")
        .map(str::to_string)
        .collect();
    for segment in relative.replace('\\', "/").split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            other => out.push(other.to_string()),
        }
    }
    out.join("/")
}

fn embedded_asset(virtual_path: &str) -> Option<&'static str> {
    let name = virtual_path.strip_prefix("icons/")?;
    let at = MATERIAL_ICON_INDEX
        .binary_search_by(|(key, _, _)| (*key).cmp(name))
        .ok()?;
    let (_, start, end) = MATERIAL_ICON_INDEX[at];
    Some(&MATERIAL_BLOB[start..end])
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

type Cache = Mutex<BTreeMap<String, Arc<LoadedIconTheme>>>;

fn cache() -> &'static Cache {
    static CACHE: OnceLock<Cache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(BTreeMap::new()))
}

/// Forget every parsed document. Called after an install or a removal.
pub fn invalidate_cache() {
    if let Ok(mut cache) = cache().lock() {
        cache.clear();
    }
}

/// Load a theme by id, from cache when it is there.
pub fn load(id: &str) -> Result<Arc<LoadedIconTheme>, IconThemeError> {
    if let Ok(cache) = cache().lock() {
        if let Some(theme) = cache.get(id) {
            return Ok(Arc::clone(theme));
        }
    }
    let loaded = Arc::new(load_uncached(id)?);
    if let Ok(mut cache) = cache().lock() {
        cache.insert(id.to_string(), Arc::clone(&loaded));
    }
    Ok(loaded)
}

fn load_uncached(id: &str) -> Result<LoadedIconTheme, IconThemeError> {
    match id {
        MINIMAL_ICON_THEME_ID => Ok(LoadedIconTheme {
            summary: minimal_summary(),
            document: None,
            source: Source::Fallback,
        }),
        MATERIAL_ICON_THEME_ID => load_material(),
        other => {
            let root = user_icon_theme_dir().ok_or_else(|| IconThemeError::NotFound {
                id: other.to_string(),
            })?;
            let dir = installed_dir_in(&root, other)?;
            load_from_directory(other, &dir)
        }
    }
}

/// The directory an installed theme lives in, or `NotFound`.
///
/// `id` arrives over IPC, so it is checked twice: as a plain directory name
/// (no separator, no `..`, no leading dot), and then — after symlinks are
/// resolved — as a path that really is a child of the icon-theme directory.
/// Without both, `remove_icon_theme("..")` was `remove_dir_all` on
/// `~/.config/atlas`.
fn installed_dir_in(root: &Path, id: &str) -> Result<PathBuf, IconThemeError> {
    let not_found = || IconThemeError::NotFound { id: id.to_string() };
    if !is_valid_id(id) {
        return Err(not_found());
    }
    let canonical_root = root.canonicalize().map_err(|_| not_found())?;
    let dir = root.join(id).canonicalize().map_err(|_| not_found())?;
    if dir.parent() != Some(canonical_root.as_path()) || !dir.is_dir() {
        return Err(not_found());
    }
    Ok(dir)
}

/// Every installed theme, built-ins first.
///
/// A user theme that will not load is reported as a warning row rather than
/// taking the catalog down — the same posture `atlas-theme` settled on after a
/// half-typed file cost a user every colour theme in the app.
pub fn list() -> Vec<IconThemeSummary> {
    let mut out = vec![minimal_summary()];
    match load(MATERIAL_ICON_THEME_ID) {
        Ok(theme) => out.push(theme.summary.clone()),
        Err(error) => out.push(IconThemeSummary {
            id: MATERIAL_ICON_THEME_ID.to_string(),
            name: "Material Icon Theme".to_string(),
            author: "Philipp Kief (Material Extensions)".to_string(),
            license: "MIT".to_string(),
            built_in: true,
            hides_explorer_arrows: false,
            uses_fallback_icons: true,
            warnings: vec![IconThemeWarning {
                key: MATERIAL_ICON_THEME_ID.to_string(),
                message: error.to_string(),
            }],
        }),
    }
    let Some(dir) = user_icon_theme_dir() else {
        return out;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return out;
    };
    // A dot-directory is not a theme: `.<id>.installing` is an install's
    // staging copy, left behind if Atlas quit mid-unpack.
    let mut installed: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_dir()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(is_valid_id)
        })
        .collect();
    installed.sort();
    for path in installed {
        let Some(id) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        match load(id) {
            Ok(theme) => out.push(theme.summary.clone()),
            Err(error) => out.push(IconThemeSummary {
                id: id.to_string(),
                name: id.to_string(),
                author: "Unknown".to_string(),
                license: "Unspecified".to_string(),
                built_in: false,
                hides_explorer_arrows: false,
                uses_fallback_icons: true,
                warnings: vec![IconThemeWarning {
                    key: id.to_string(),
                    message: error.to_string(),
                }],
            }),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/// What the frontend draws for one path.
///
/// An image carries only its definition id, because the SVG is fetched in a
/// second, batched, deduplicated call. A glyph carries everything inline: the
/// payload is a character and two short strings, and a round trip per glyph
/// would cost more than the data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ResolvedIcon {
    #[serde(rename_all = "camelCase")]
    Image { definition: String },
    #[serde(rename_all = "camelCase")]
    Glyph {
        definition: String,
        /// The actual character, already decoded from the theme's `\E001`
        /// escape — the webview renders it as text, not as CSS `content`.
        character: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        color: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        size: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        font_id: Option<String>,
    },
}

/// `"\\E001"` (four characters after JSON decoding: `\`, `E`, `0`, `1`) is a
/// codepoint escape, not text. VS Code hands it to CSS `content:`, which reads
/// it that way; Atlas renders the glyph as a text node, so it is decoded here.
fn decode_font_character(raw: &str) -> String {
    let Some(hex) = raw.strip_prefix('\\') else {
        return raw.to_string();
    };
    let hex = hex.trim();
    match u32::from_str_radix(hex, 16).ok().and_then(char::from_u32) {
        Some(character) => character.to_string(),
        // Not a valid escape: hand back what the theme wrote rather than
        // silently drawing nothing.
        None => raw.to_string(),
    }
}

/// Resolve a batch of paths against a theme.
///
/// `None` at a position means "the theme has nothing for this" and the caller
/// should draw its own icon. `minimal` answers `None` for everything.
pub fn resolve_icons(
    theme: &LoadedIconTheme,
    requests: &[IconRequest],
    appearance: Appearance,
) -> Vec<Option<ResolvedIcon>> {
    let Some(document) = theme.document.as_ref() else {
        return vec![None; requests.len()];
    };
    requests
        .iter()
        .map(|request| {
            let id = resolve::resolve(document, request, appearance)?;
            let definition = document.icon_definitions.get(id)?;
            match definition.resolved() {
                DefinitionKind::Image { .. } => Some(ResolvedIcon::Image {
                    definition: id.to_string(),
                }),
                DefinitionKind::Glyph { character } => Some(ResolvedIcon::Glyph {
                    definition: id.to_string(),
                    character: decode_font_character(character),
                    color: definition.font_color.clone(),
                    size: definition.font_size.clone(),
                    font_id: definition.font_id.clone(),
                }),
                DefinitionKind::Empty => None,
            }
        })
        .collect()
}

/// One icon's bytes, in the form the webview can use directly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum IconAsset {
    /// SVG source, to be inlined. Inlining rather than a `data:` URL is what
    /// lets `currentColor` in a theme's SVG follow the colour theme.
    #[serde(rename_all = "camelCase")]
    Svg { source: String },
    /// Anything else (PNG), as a ready-made `data:` URL.
    #[serde(rename_all = "camelCase")]
    DataUrl { url: String },
}

/// Fetch the assets for a batch of definition ids.
///
/// Ids the theme does not define, or that are glyphs rather than images, are
/// simply absent from the reply — the caller asked for a set and gets back
/// what exists, which is cheaper to handle than a map full of nulls.
pub fn icon_assets(theme: &LoadedIconTheme, definitions: &[String]) -> BTreeMap<String, IconAsset> {
    let mut out = BTreeMap::new();
    let Some(document) = theme.document.as_ref() else {
        return out;
    };
    for id in definitions {
        let Some(definition) = document.icon_definitions.get(id) else {
            continue;
        };
        let DefinitionKind::Image { path } = definition.resolved() else {
            continue;
        };
        let Some(asset) = read_asset(theme, path) else {
            continue;
        };
        out.insert(id.clone(), asset);
    }
    out
}

fn read_asset(theme: &LoadedIconTheme, relative: &str) -> Option<IconAsset> {
    match &theme.source {
        Source::Fallback => None,
        Source::Embedded { doc_dir } => {
            let virtual_path = resolve_relative_virtual(doc_dir, relative);
            // The bundled theme is SVG-only, which the build script enforces by
            // packing nothing else.
            embedded_asset(&virtual_path).map(|source| IconAsset::Svg {
                source: source.to_string(),
            })
        }
        Source::Directory { root, document } => {
            let path = resolve_relative(root, document.parent()?, relative)?;
            let bytes = read_within(root, &path, MAX_ASSET_BYTES).ok()?;
            Some(asset_from_bytes(&path, bytes))
        }
    }
}

fn asset_from_bytes(path: &Path, bytes: Vec<u8>) -> IconAsset {
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_lowercase();
    if extension == "svg" {
        if let Ok(source) = String::from_utf8(bytes.clone()) {
            return IconAsset::Svg { source };
        }
    }
    let media_type = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    };
    IconAsset::DataUrl {
        url: format!("data:{media_type};base64,{}", base64_encode(&bytes)),
    }
}

/// A web font a glyph theme needs, with its files inlined.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IconFontFace {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weight: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<String>,
    pub src: Vec<IconFontData>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IconFontData {
    /// The CSS `format()` hint, as the theme wrote it (`woff`, `woff2`, …).
    pub format: String,
    /// A `data:` URL, so the webview needs no file access to load the font.
    pub url: String,
}

/// The theme's fonts, with each file read and inlined.
///
/// Empty for every SVG theme, which is why the frontend calls it only when a
/// resolved icon actually turns out to be a glyph.
pub fn icon_fonts(theme: &LoadedIconTheme) -> Vec<IconFontFace> {
    let Some(document) = theme.document.as_ref() else {
        return Vec::new();
    };
    document
        .fonts
        .iter()
        .map(|font| IconFontFace {
            id: font.id.clone(),
            weight: font.weight.clone(),
            style: font.style.clone(),
            size: font.size.clone(),
            src: font
                .src
                .iter()
                .filter_map(|source| {
                    let bytes = read_font_bytes(theme, &source.path)?;
                    let media_type = match source.format.as_str() {
                        "woff2" => "font/woff2",
                        "woff" => "font/woff",
                        "truetype" | "ttf" => "font/ttf",
                        "opentype" | "otf" => "font/otf",
                        _ => "application/octet-stream",
                    };
                    Some(IconFontData {
                        format: source.format.clone(),
                        url: format!("data:{media_type};base64,{}", base64_encode(&bytes)),
                    })
                })
                .collect(),
        })
        .collect()
}

fn read_font_bytes(theme: &LoadedIconTheme, relative: &str) -> Option<Vec<u8>> {
    match &theme.source {
        // The bundled theme has no fonts, and the build script packs SVG text
        // only — a font would have to be a directory theme.
        Source::Fallback | Source::Embedded { .. } => None,
        Source::Directory { root, document } => {
            let path = resolve_relative(root, document.parent()?, relative)?;
            read_within(root, &path, MAX_FONT_BYTES).ok()
        }
    }
}

/// Standard base64, written out here rather than taking a dependency for it:
/// the crate needs exactly this, and the alphabet has not changed since 1987.
fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let packed = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(ALPHABET[(packed >> 18) as usize & 63] as char);
        out.push(ALPHABET[(packed >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(packed >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[packed as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

// ---------------------------------------------------------------------------
// Install / remove
// ---------------------------------------------------------------------------

/// Install a `.vsix` payload as `id`, replacing any theme already under that
/// id. The bytes are whatever the caller downloaded; this does the unpacking.
pub fn install_vsix(id: &str, archive_bytes: &[u8]) -> Result<IconThemeSummary, IconThemeError> {
    if !is_valid_id(id) {
        return Err(IconThemeError::Install {
            message: format!("\"{id}\" is not a usable id"),
        });
    }
    if is_built_in(id) {
        return Err(IconThemeError::Install {
            message: format!("\"{id}\" is built in and cannot be replaced"),
        });
    }
    let dir = user_icon_theme_dir().ok_or_else(|| IconThemeError::Install {
        message: "no config directory on this system".to_string(),
    })?;
    let target = dir.join(id);
    // Unpack beside the target and swap, so a failed install never leaves a
    // half-written theme where the catalog can find it.
    let staging = dir.join(format!(".{id}.installing"));
    let _ = std::fs::remove_dir_all(&staging);
    vsix::unpack_extension(archive_bytes, &staging).inspect_err(|_| {
        let _ = std::fs::remove_dir_all(&staging);
    })?;
    // Fail before the swap if what was unpacked is not an icon theme at all.
    let check = load_from_directory(id, &staging);
    let summary = match check {
        Ok(theme) => theme.summary,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(error);
        }
    };
    let _ = std::fs::remove_dir_all(&target);
    std::fs::rename(&staging, &target).map_err(|source| IconThemeError::Io {
        path: target.clone(),
        source,
    })?;
    invalidate_cache();
    Ok(summary)
}

/// Remove an installed theme. Built-ins are refused.
pub fn remove(id: &str) -> Result<(), IconThemeError> {
    if is_built_in(id) {
        return Err(IconThemeError::Install {
            message: format!("\"{id}\" is built in and cannot be removed"),
        });
    }
    let root =
        user_icon_theme_dir().ok_or_else(|| IconThemeError::NotFound { id: id.to_string() })?;
    let dir = installed_dir_in(&root, id)?;
    std::fs::remove_dir_all(&dir).map_err(|source| IconThemeError::Io {
        path: dir.clone(),
        source,
    })?;
    invalidate_cache();
    Ok(())
}

pub fn is_built_in(id: &str) -> bool {
    id == MINIMAL_ICON_THEME_ID || id == MATERIAL_ICON_THEME_ID
}

/// An id is a single path segment used as a directory name, so a value with a
/// separator or a `..` in it would escape the icon-theme directory. A leading
/// dot is refused too: that namespace is the installer's staging directories,
/// and it covers `.` and `..` besides.
pub fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && !id.starts_with('.')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundled_material_theme_loads() {
        let theme = load_material().expect("the vendored theme parses");
        assert_eq!(theme.summary.id, MATERIAL_ICON_THEME_ID);
        assert_eq!(theme.summary.license, "MIT");
        let document = theme.document.as_ref().expect("has a document");
        assert!(document.icon_definitions.len() > 1000, "1,251 at 5.38.1");
        assert!(document.associations.file_extensions.len() > 1000);
        assert!(document.light.is_some(), "Material ships a light section");
    }

    #[test]
    fn the_bundled_theme_has_no_dangling_associations() {
        let theme = load_material().expect("parses");
        assert_eq!(
            theme.summary.warnings,
            Vec::new(),
            "a vendored theme with warnings means the extraction dropped files"
        );
    }

    #[test]
    fn every_bundled_image_definition_has_its_bytes() {
        // The failure this catches: vendoring `dist/material-icons.json`
        // without all 1,251 SVGs beside it. Every icon would resolve and none
        // would draw.
        let theme = load_material().expect("parses");
        let document = theme.document.as_ref().expect("document");
        let ids: Vec<String> = document.icon_definitions.keys().cloned().collect();
        let assets = icon_assets(&theme, &ids);
        let images = document
            .icon_definitions
            .iter()
            .filter(|(_, d)| matches!(d.resolved(), DefinitionKind::Image { .. }))
            .count();
        assert_eq!(
            assets.len(),
            images,
            "every image definition resolves to bytes"
        );
        assert!(images > 1000);
    }

    #[test]
    fn a_typescript_file_gets_the_typescript_icon_from_the_bundled_theme() {
        let theme = load_material().expect("parses");
        let requests = vec![
            IconRequest {
                path: "/p/src/main.ts".into(),
                kind: IconKind::File,
                language_id: None,
            },
            IconRequest {
                path: "/p/src".into(),
                kind: IconKind::Folder,
                language_id: None,
            },
            IconRequest {
                path: "/p/README.md".into(),
                kind: IconKind::File,
                language_id: None,
            },
        ];
        let resolved = resolve_icons(&theme, &requests, Appearance::Dark);
        let names: Vec<String> = resolved
            .into_iter()
            .map(|icon| match icon {
                Some(ResolvedIcon::Image { definition }) => definition,
                other => panic!("expected an image, got {other:?}"),
            })
            .collect();
        assert_eq!(names, vec!["typescript", "folder-src", "readme"]);
    }

    #[test]
    fn minimal_resolves_nothing_and_says_so() {
        let theme = load(MINIMAL_ICON_THEME_ID).expect("always available");
        assert!(theme.summary.uses_fallback_icons);
        let requests = vec![IconRequest {
            path: "a.ts".into(),
            kind: IconKind::File,
            language_id: None,
        }];
        assert_eq!(
            resolve_icons(&theme, &requests, Appearance::Dark),
            vec![None]
        );
        assert!(icon_fonts(&theme).is_empty());
    }

    #[test]
    fn the_catalog_always_offers_both_built_ins() {
        let ids: Vec<String> = list().into_iter().map(|theme| theme.id).collect();
        assert!(ids.contains(&MINIMAL_ICON_THEME_ID.to_string()));
        assert!(ids.contains(&MATERIAL_ICON_THEME_ID.to_string()));
    }

    #[test]
    fn built_ins_refuse_to_be_removed() {
        assert!(remove(MATERIAL_ICON_THEME_ID).is_err());
        assert!(remove(MINIMAL_ICON_THEME_ID).is_err());
    }

    #[test]
    fn an_id_that_would_escape_the_theme_directory_is_rejected() {
        assert!(is_valid_id("PKief.material-icon-theme"));
        assert!(!is_valid_id("../../etc"));
        assert!(!is_valid_id("a/b"));
        assert!(!is_valid_id(".."));
        assert!(!is_valid_id(""));
        assert!(!is_valid_id(".pub.theme.installing"));
        assert!(!is_valid_id("/etc"));
    }

    #[test]
    fn font_characters_are_decoded_to_the_codepoint() {
        assert_eq!(decode_font_character("\\E001"), "\u{E001}");
        assert_eq!(decode_font_character("\\f101"), "\u{f101}");
        assert_eq!(
            decode_font_character("x"),
            "x",
            "not an escape: passed through"
        );
        assert_eq!(
            decode_font_character("\\zzzz"),
            "\\zzzz",
            "invalid hex: passed through"
        );
    }

    #[test]
    fn relative_icon_paths_fold_dot_and_dotdot() {
        assert_eq!(
            resolve_relative_virtual("dist", "./../icons/git.svg"),
            "icons/git.svg"
        );
        assert_eq!(resolve_relative_virtual("", "./icons/a.svg"), "icons/a.svg");
        assert_eq!(
            resolve_relative(
                Path::new("/root"),
                Path::new("/root/dist"),
                "./../icons/a.svg"
            ),
            Some(PathBuf::from("/root/icons/a.svg"))
        );
    }

    #[test]
    fn a_relative_path_cannot_climb_above_the_extension_root() {
        let root = Path::new("/themes/x");
        let dist = Path::new("/themes/x/dist");
        assert_eq!(resolve_relative(root, dist, "../../../../dev/zero"), None);
        assert_eq!(resolve_relative(root, dist, "../../y/icons/a.svg"), None);
        assert_eq!(resolve_relative(root, root, ".."), None);
        assert_eq!(resolve_relative(root, dist, "C:/Windows/win.ini"), None);
        // A leading slash is still relative to the root, never the filesystem's.
        assert_eq!(
            resolve_relative(root, dist, "/etc/passwd"),
            Some(PathBuf::from("/themes/x/dist/etc/passwd"))
        );
    }

    /// The `.vsix` path escape: a theme whose `iconPath` walks out of its own
    /// directory, or through a symlink out of it, or at something that is not
    /// a regular file, gets no bytes — and a file past the cap is refused
    /// rather than inlined.
    #[test]
    fn asset_reads_stay_inside_the_theme_and_under_the_cap() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("theme");
        std::fs::create_dir_all(root.join("icons")).expect("mkdir");
        std::fs::write(dir.path().join("secret.svg"), "<svg>secret</svg>").expect("write");
        std::fs::write(root.join("icons/ok.svg"), "<svg/>").expect("write");
        std::fs::write(
            root.join("icons/big.svg"),
            vec![b' '; MAX_ASSET_BYTES as usize + 1],
        )
        .expect("write");
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.path().join("secret.svg"), root.join("icons/link.svg"))
            .expect("symlink");
        std::fs::write(
            root.join("package.json"),
            r#"{"name":"t","contributes":{"iconThemes":[{"path":"./theme.json"}]}}"#,
        )
        .expect("write");
        std::fs::write(
            root.join("theme.json"),
            r#"{"iconDefinitions":{
                "ok":{"iconPath":"./icons/ok.svg"},
                "escape":{"iconPath":"../secret.svg"},
                "link":{"iconPath":"./icons/link.svg"},
                "big":{"iconPath":"./icons/big.svg"},
                "dir":{"iconPath":"./icons"}
            },"file":"ok"}"#,
        )
        .expect("write");
        let theme = load_from_directory("t", &root).expect("loads");
        let ids: Vec<String> = ["ok", "escape", "link", "big", "dir"]
            .iter()
            .map(|id| id.to_string())
            .collect();
        let assets = icon_assets(&theme, &ids);
        assert_eq!(
            assets.keys().cloned().collect::<Vec<_>>(),
            vec!["ok".to_string()]
        );
    }

    #[test]
    fn a_manifest_pointing_outside_the_extension_does_not_load() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("theme");
        std::fs::create_dir_all(&root).expect("mkdir");
        std::fs::write(
            root.join("package.json"),
            r#"{"name":"t","contributes":{"iconThemes":[{"path":"../../outside.json"}]}}"#,
        )
        .expect("write");
        let error = load_from_directory("t", &root).unwrap_err();
        assert!(
            error.to_string().contains("outside the extension"),
            "{error}"
        );
    }

    /// `remove_icon_theme("..")` used to be `remove_dir_all(~/.config/atlas)`.
    #[test]
    fn an_installed_theme_dir_is_always_a_child_of_the_icon_theme_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("icon-themes");
        std::fs::create_dir_all(root.join("pub.theme")).expect("mkdir");
        std::fs::create_dir_all(root.join(".pub.theme.installing")).expect("mkdir");
        std::fs::create_dir_all(dir.path().join("elsewhere")).expect("mkdir");
        assert!(installed_dir_in(&root, "pub.theme").is_ok());
        for bad in [
            "..",
            ".",
            "",
            "../elsewhere",
            "/etc",
            "a/b",
            ".pub.theme.installing",
        ] {
            assert!(installed_dir_in(&root, bad).is_err(), "accepted {bad:?}");
        }
        let absolute = dir.path().join("elsewhere").display().to_string();
        assert!(
            installed_dir_in(&root, &absolute).is_err(),
            "accepted an absolute path"
        );
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.path().join("elsewhere"), root.join("sneaky"))
                .expect("symlink");
            assert!(
                installed_dir_in(&root, "sneaky").is_err(),
                "followed a symlink out"
            );
        }
        // And the public entry points refuse before touching anything.
        assert!(remove("..").is_err());
        assert!(remove("/").is_err());
        assert!(remove(&absolute).is_err());
        assert!(dir.path().join("elsewhere").is_dir());
        assert!(load("..").is_err());
        assert!(install_vsix("..", b"").is_err());
    }

    #[test]
    fn base64_matches_the_rfc_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    // ── config_root (must track `config_root` in `atlas_config.rs` and
    //    `atlas-theme`; #64 follow-up) ──

    /// The bug this whole fix exists for: `dirs::config_dir()` resolves to
    /// `~/Library/Application Support` on macOS, which contradicts every
    /// other place Atlas resolves its config root and this crate's own doc
    /// comments. Pin the resolved *icon-theme* directory under
    /// `~/.config/atlas` and assert "Application Support" and "Library"
    /// never appear in it.
    #[test]
    fn user_icon_theme_dir_lives_under_dot_config_atlas_not_application_support() {
        let home = PathBuf::from("/Users/someone");
        let root = config_root_from(None, Some(&home)).expect("a home resolves a root");
        let icon_themes = root.join("icon-themes");

        assert_eq!(
            icon_themes,
            PathBuf::from("/Users/someone/.config/atlas/icon-themes")
        );
        assert!(!icon_themes
            .to_string_lossy()
            .contains("Application Support"));
        assert!(!icon_themes.to_string_lossy().contains("Library"));
    }

    /// Same fixtures as `atlas_config.rs`'s `an_absolute_xdg_config_home_wins`
    /// (and `atlas-theme`'s copy of the same test) — all three resolvers must
    /// agree on every input, and this is the input that most needs to be
    /// right, since it's how a user relocates config for every tool they run.
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
}
