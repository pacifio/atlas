use std::sync::Mutex;

use atlas_theme::{Theme, ThemeCatalogSummary};
use notify::RecommendedWatcher;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub const THEMES_CHANGED_EVENT: &str = "atlas:themes-changed";

pub struct ThemeWatcherState(Mutex<Option<RecommendedWatcher>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThemesChangedEvent {
    kind: &'static str,
}

#[tauri::command]
pub async fn list_themes() -> Result<ThemeCatalogSummary, String> {
    let catalog = tokio::task::spawn_blocking(atlas_theme::list_themes)
        .await
        .map_err(|error| format!("theme list task failed: {error}"))?
        .map_err(|error| error.to_string())?;
    // A file in `~/.config/atlas/themes/` that could not be loaded no longer
    // takes the catalog down with it. This line is for the log; the warnings
    // also ride back with the list, because the person who can fix a
    // half-typed TOML is the one in the theme picker, not the one in the log.
    for warning in &catalog.warnings {
        tracing::warn!(
            target: "atlas::themes",
            file = %warning.key,
            "skipped an unloadable user theme: {}",
            warning.message,
        );
    }
    Ok(catalog)
}

#[tauri::command]
pub async fn get_theme(id: String) -> Result<Theme, String> {
    tokio::task::spawn_blocking(move || atlas_theme::get_theme(&id))
        .await
        .map_err(|error| format!("theme load task failed: {error}"))?
        .map_err(|error| error.to_string())
}

/// Where a saved theme went.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedTheme {
    /// The id it was saved under, slugged; what `themeDark`/`themeLight`
    /// must name.
    pub id: String,
    pub path: String,
}

/// Write a theme from the theme editor to `~/.config/atlas/themes/<id>.toml`.
///
/// The editor sends only what the author set (ADR-0022); everything else is
/// derived when the theme loads. The theme goes through the TOML writer and
/// back through the parser before it is written, so a value the loader would
/// refuse is refused here instead of landing as a file that will not load. A
/// built-in's id is off limits: saving under it would shadow the built-in.
#[tauri::command]
pub async fn save_theme(theme: Theme) -> Result<SavedTheme, String> {
    tokio::task::spawn_blocking(move || {
        let mut theme = theme;
        // An id the writer already accepts is kept as it is: editing a
        // hand-written `my_theme` must save `my_theme.toml`, not a new
        // `my-theme.toml` beside it. Only an id it would refuse is slugged.
        if !atlas_theme::is_writable_id(&theme.id) {
            theme.id = atlas_theme::import::slug(&theme.id);
        }
        if theme.id.is_empty() {
            return Err("a theme name needs at least one letter or digit".to_string());
        }
        if atlas_theme::theme_origin(&theme.id) == atlas_theme::ThemeOrigin::BuiltIn {
            return Err(format!(
                "\"{}\" is a built-in theme; pick another name",
                theme.id
            ));
        }
        theme.warnings.clear();
        let rendered = atlas_theme::toml_writer::theme_to_toml(&theme);
        atlas_theme::parse_theme(&rendered, "theme editor").map_err(|error| error.to_string())?;
        atlas_theme::write_user_theme(&rendered)
            .map(|path| SavedTheme {
                id: theme.id.clone(),
                path: path.display().to_string(),
            })
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("theme save task failed: {error}"))?
}

pub fn start_watcher(app: &AppHandle) {
    let app_for_event = app.clone();
    let watcher = atlas_theme::watch_user_themes(move || {
        let _ = app_for_event.emit(
            THEMES_CHANGED_EVENT,
            ThemesChangedEvent {
                kind: "themes-changed",
            },
        );
    });
    match watcher {
        Ok(watcher) => {
            app.manage(ThemeWatcherState(Mutex::new(Some(watcher))));
        }
        Err(error) => {
            tracing::warn!(target: "atlas::themes", "failed to start theme watcher: {error}");
            app.manage(ThemeWatcherState(Mutex::new(None)));
        }
    }
}

impl Drop for ThemeWatcherState {
    fn drop(&mut self) {
        let _ = self.0.lock().map(|mut watcher| watcher.take());
    }
}
