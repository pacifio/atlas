//! Per-project UI session persistence — `<project>/.atlas/session.json`.
//!
//! Holds whatever the frontend's session store needs to restore a project the
//! way the user left it (open tabs, layout, selection). Atlas writes it on
//! change and reads it during the boot cascade.
//!
//! Both commands are async + `spawn_blocking` for the same reason every other
//! fs-touching Tauri command here is: a sync handler runs on the NSApp main
//! thread and freezes the UI while the syscall blocks. `load_project_session`
//! is part of the boot cascade — its previous sync form was contributing to the
//! warm-start beachball.
//!
//! (These lived in `commands::research` until that module was deleted; they were
//! never research-specific.)

use std::fs;
use std::path::Path;

#[tauri::command]
pub async fn save_project_session(
    project_path: String,
    session_data: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let atlas_dir = Path::new(&project_path).join(".atlas");
        fs::create_dir_all(&atlas_dir).map_err(|e| e.to_string())?;
        let session_path = atlas_dir.join("session.json");
        fs::write(&session_path, &session_data).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn load_project_session(project_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let session_path = Path::new(&project_path).join(".atlas").join("session.json");
        if session_path.exists() {
            fs::read_to_string(&session_path).map_err(|e| e.to_string())
        } else {
            // A project with no saved session is the normal first-open case,
            // not an error — the frontend treats `{}` as "use defaults".
            Ok("{}".to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
