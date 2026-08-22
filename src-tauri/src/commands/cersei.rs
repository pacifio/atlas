//! Tauri commands specific to the native Cersei agent.
//!
//! The agent itself is driven entirely through the agent-agnostic `agents_*`
//! surface (spawn / new_session / send / set_mode / set_model / …). The only
//! extra surface it needs is listing its own persisted sessions for the chat
//! session sidebar — model/provider selection reuses the frontend's existing
//! BYOK catalog (`review-agents/lib/model-catalog.ts`) + `agents_set_model`
//! with a `"provider/model"` value.

use std::sync::Arc;

use atlas_cersei::{ReplayItem, SessionMeta};

use super::agent_host::AgentHost;
use tauri::State;

/// Stored native-agent sessions for `project_path`, newest first (sidebar).
///
/// The store walk reads every session file off disk, so it runs inside
/// `spawn_blocking` (mirrors `list_claude_sessions`) to keep the IPC thread free.
#[tauri::command]
pub async fn cersei_list_sessions(
    project_path: String,
    host: State<'_, Arc<AgentHost>>,
) -> Result<Vec<SessionMeta>, String> {
    let host = host.inner().clone();
    let rows = tokio::task::spawn_blocking(move || host.native_sessions(&project_path))
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
    host: State<'_, Arc<AgentHost>>,
) -> Result<(), String> {
    host.native_delete_session(&project_path, &session_id)
}

/// Full transcript (UI-neutral replay items) for one stored native-agent
/// session — drives the Memory tab's Atlas view (transcripts + plans).
#[tauri::command]
pub fn cersei_session_transcript(
    project_path: String,
    session_id: String,
    host: State<'_, Arc<AgentHost>>,
) -> Vec<ReplayItem> {
    host.native_transcript(&project_path, &session_id)
}
