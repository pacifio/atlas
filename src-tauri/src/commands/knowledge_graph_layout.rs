use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

/// Per-node {x, y} world coordinates from the last graph session, so
/// the layout survives tab switches AND full app restarts. Stored at
/// `.atlas/knowledge-graph-layout.json` so it lives next to the rest
/// of the per-project Atlas state.
#[derive(Debug, Serialize, Deserialize, Default)]
pub struct GraphLayout {
    pub positions: HashMap<String, Pos>,
}

#[derive(Debug, Serialize, Deserialize, Default, Clone, Copy)]
pub struct Pos {
    pub x: f64,
    pub y: f64,
}

fn layout_path(project_path: &str) -> std::path::PathBuf {
    atlas_profile::dir_in(Path::new(project_path)).join("knowledge-graph-layout.json")
}

#[tauri::command]
pub async fn knowledge_graph_layout_load(project_path: String) -> Result<GraphLayout, String> {
    tokio::task::spawn_blocking(move || -> Result<GraphLayout, String> {
        let p = layout_path(&project_path);
        if !p.exists() {
            return Ok(GraphLayout::default());
        }
        let raw = fs::read_to_string(&p).map_err(|e| e.to_string())?;
        serde_json::from_str::<GraphLayout>(&raw).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn knowledge_graph_layout_save(
    project_path: String,
    layout: GraphLayout,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let dir = atlas_profile::dir_in(Path::new(&project_path));
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let final_path = dir.join("knowledge-graph-layout.json");
        let tmp = dir.join("knowledge-graph-layout.json.tmp");
        let payload = serde_json::to_string(&layout).map_err(|e| e.to_string())?;
        fs::write(&tmp, &payload).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &final_path).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
