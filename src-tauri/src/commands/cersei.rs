//! Tauri commands specific to the native Cersei agent.
//!
//! The agent itself is driven entirely through the agent-agnostic `agents_*`
//! surface (spawn / new_session / send / set_mode / set_model / …). The only
//! extra surface it needs is listing its own persisted sessions for the chat
//! session sidebar — model/provider selection reuses the frontend's existing
//! BYOK catalog (`settings/lib/model-catalog.ts`) + `agents_set_model`
//! with a `"provider/model"` value.

use atlas_agents::{AgentManager, SessionMeta};
use tauri::State;

/// Stored native-agent sessions for `project_path`, newest first (sidebar).
///
/// The store walk reads every session file off disk, so it runs inside
/// `spawn_blocking` (mirrors `list_claude_sessions`) to keep the IPC thread free.
#[tauri::command]
pub async fn cersei_list_sessions(
    project_path: String,
    manager: State<'_, AgentManager>,
) -> Result<Vec<SessionMeta>, String> {
    let mgr = (*manager).clone();
    let rows = tokio::task::spawn_blocking(move || mgr.cersei_list_sessions(&project_path))
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Delete one stored native-agent session's transcript (sidebar delete ✕).
/// Cersei transcripts live under the app config dir, NOT `~/.claude/projects`,
/// so they can't go through `delete_claude_session` (which guards that path).
#[tauri::command]
pub fn cersei_delete_session(
    project_path: String,
    session_id: String,
    manager: State<'_, AgentManager>,
) -> Result<(), String> {
    manager.cersei_delete_session(&project_path, &session_id)
}
