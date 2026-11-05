//! IPC for icon themes (decisions 4, 11 and 12).
//!
//! Three read commands carry the lazy-loading contract that keeps 1 MB of
//! bundled SVGs off the startup path:
//!
//!   * `resolve_icons` takes a batch of paths and answers with definition ids.
//!   * `get_icon_theme_assets` takes a batch of ids and answers with bytes.
//!   * `get_icon_theme_fonts` is called only when a resolve returned a glyph.
//!
//! The frontend caches assets by id, so scrolling a project of TypeScript
//! files transfers a handful of icons rather than the theme.
//!
//! Three write commands cover Open VSX, which decision 11 leaves as the only
//! remote source (the `atlas-themes` community repo was dropped, so nothing
//! else fetches). Every one of them is explicitly invoked, time-bounded, and
//! reports its failure as a message the picker can show: **nothing here runs
//! at startup**, and being offline costs a search, not a launch.

use std::collections::BTreeMap;

use atlas_icon_theme::{
    Appearance, IconAsset, IconFontFace, IconRequest, IconThemeSummary, ResolvedIcon,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::open_vsx::{self, Contributes, OpenVsxExtension};

pub const ICON_THEMES_CHANGED_EVENT: &str = "atlas:icon-themes-changed";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct IconThemesChangedEvent {
    kind: &'static str,
}

fn notify(app: &AppHandle) {
    let _ = app.emit(
        ICON_THEMES_CHANGED_EVENT,
        IconThemesChangedEvent {
            kind: "icon-themes-changed",
        },
    );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_icon_themes() -> Result<Vec<IconThemeSummary>, String> {
    tokio::task::spawn_blocking(atlas_icon_theme::list)
        .await
        .map_err(|error| format!("icon theme list task failed: {error}"))
}

#[tauri::command]
pub async fn resolve_icons(
    theme_id: String,
    appearance: Appearance,
    requests: Vec<IconRequest>,
) -> Result<Vec<Option<ResolvedIcon>>, String> {
    tokio::task::spawn_blocking(move || {
        let theme = atlas_icon_theme::load(&theme_id).map_err(|error| error.to_string())?;
        Ok(atlas_icon_theme::resolve_icons(
            &theme, &requests, appearance,
        ))
    })
    .await
    .map_err(|error| format!("icon resolve task failed: {error}"))?
}

#[tauri::command]
pub async fn get_icon_theme_assets(
    theme_id: String,
    definitions: Vec<String>,
) -> Result<BTreeMap<String, IconAsset>, String> {
    tokio::task::spawn_blocking(move || {
        let theme = atlas_icon_theme::load(&theme_id).map_err(|error| error.to_string())?;
        Ok(atlas_icon_theme::icon_assets(&theme, &definitions))
    })
    .await
    .map_err(|error| format!("icon asset task failed: {error}"))?
}

#[tauri::command]
pub async fn get_icon_theme_fonts(theme_id: String) -> Result<Vec<IconFontFace>, String> {
    tokio::task::spawn_blocking(move || {
        let theme = atlas_icon_theme::load(&theme_id).map_err(|error| error.to_string())?;
        Ok(atlas_icon_theme::icon_fonts(&theme))
    })
    .await
    .map_err(|error| format!("icon font task failed: {error}"))?
}

// ---------------------------------------------------------------------------
// Open VSX
// ---------------------------------------------------------------------------

/// Search Open VSX for extensions that contribute an icon theme.
#[tauri::command]
pub async fn search_icon_themes(query: String) -> Result<Vec<OpenVsxExtension>, String> {
    let installed = tokio::task::spawn_blocking(atlas_icon_theme::list)
        .await
        .map_err(|error| format!("icon theme list task failed: {error}"))?
        .into_iter()
        .map(|theme| theme.id)
        .collect::<Vec<_>>();
    open_vsx::search(&query, Contributes::IconThemes, installed).await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallIconThemeArgs {
    pub namespace: String,
    pub name: String,
    /// Omitted installs the latest published version.
    #[serde(default)]
    pub version: Option<String>,
}

/// Download a `.vsix` from Open VSX and unpack it as an installed icon theme.
#[tauri::command]
pub async fn install_icon_theme(
    app: AppHandle,
    args: InstallIconThemeArgs,
) -> Result<IconThemeSummary, String> {
    let id = format!("{}.{}", args.namespace, args.name);
    if !atlas_icon_theme::is_valid_id(&id) {
        return Err(format!("\"{id}\" is not a usable extension id."));
    }
    if atlas_icon_theme::is_built_in(&id) {
        return Err(format!("\"{id}\" is built in and cannot be replaced."));
    }

    let bytes = open_vsx::download(&args.namespace, &args.name, args.version.as_deref())
        .await?
        .bytes;

    // Unzipping and writing a thousand small files is the blocking half.
    let summary = tokio::task::spawn_blocking(move || {
        atlas_icon_theme::install_vsix(&id, &bytes).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("icon theme install task failed: {error}"))??;
    notify(&app);
    Ok(summary)
}

#[tauri::command]
pub async fn remove_icon_theme(app: AppHandle, id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        atlas_icon_theme::remove(&id).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("icon theme removal task failed: {error}"))??;
    notify(&app);
    Ok(())
}
