//! IPC for per-project settings (`<project>/.atlas/config.toml`), and the one
//! helper every Rust reader of a per-project key goes through.
//!
//! The parsing, overlay and write live in `state::project_config`; this is
//! the command layer over it, as `commands::atlas_config` is for the global
//! file.

use std::path::Path;

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, State};

use crate::state::project_config::{self, ProjectConfigs, ProjectOverrides};
use crate::state::{AppSettings, AtlasConfigHandle};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettingsInfo {
    pub path: String,
    #[serde(flatten)]
    pub overrides: ProjectOverrides,
}

fn info(project_path: &str, overrides: ProjectOverrides) -> ProjectSettingsInfo {
    ProjectSettingsInfo {
        path: project_config::project_config_path(Path::new(project_path))
            .to_string_lossy()
            .into_owned(),
        overrides,
    }
}

/// The overrides a project's file holds, checked against the global settings.
#[tauri::command]
pub async fn get_project_settings(
    project_path: String,
    config: State<'_, AtlasConfigHandle>,
    configs: State<'_, ProjectConfigs>,
) -> Result<ProjectSettingsInfo, String> {
    let global = config.lock().effective().clone();
    let configs = configs.inner();
    let root = Path::new(&project_path);
    Ok(info(&project_path, configs.overrides(root, &global)))
}

/// Set overrides (a value) or remove them (`null`) in a project's file.
#[tauri::command]
pub async fn update_project_settings(
    project_path: String,
    patch: Map<String, Value>,
    app: AppHandle,
    config: State<'_, AtlasConfigHandle>,
) -> Result<ProjectSettingsInfo, String> {
    let global = config.lock().effective().clone();
    let root = project_path.clone();
    let overrides = tokio::task::spawn_blocking(move || {
        project_config::write_patch(Path::new(&root), &global, &patch)
    })
    .await
    .map_err(|e| e.to_string())??;
    app.state::<ProjectConfigs>()
        .invalidate(Path::new(&project_path));
    Ok(info(&project_path, overrides))
}

/// The settings in effect inside `project_root`: the global ones with the
/// project's overrides laid over them. `None` before setup has managed
/// either piece of state.
pub fn effective_settings_for(app: &AppHandle, project_root: &Path) -> Option<AppSettings> {
    let config = app.try_state::<AtlasConfigHandle>()?;
    let global = config.lock().effective().clone();
    let configs = app.try_state::<ProjectConfigs>()?;
    Some(configs.effective(project_root, &global))
}
