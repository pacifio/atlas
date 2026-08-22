//! Persistent history for the Memory-Chat (local RAG chat over a project's
//! indexed memory).
//!
//! Like model-chat, sessions are stored GLOBALLY as one JSON file per session
//! under `app_config_dir/memory-chat/<id>.json`. Mirrors the session-chat store
//! minus the provider/model fields (the model is always the local quantized one).

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryChatSession {
    pub id: String,
    pub title: String,
    /// The project this chat was about (for display only; retrieval uses the
    /// project that's open when a message is sent).
    #[serde(default)]
    pub project_path: String,
    /// "local" (default, on-device model) or "provider" (BYOK).
    #[serde(default)]
    pub mode: String,
    /// Provider id + model, when `mode == "provider"`.
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub messages: Vec<StoredMessage>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub id: String,
    pub title: String,
    pub updated_at: String,
}

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no app config dir: {e}"))?
        .join("memory-chat");
    fs::create_dir_all(&d).map_err(|e| format!("create memory-chat dir: {e}"))?;
    Ok(d)
}

fn session_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err("invalid session id".into());
    }
    Ok(dir(app)?.join(format!("{id}.json")))
}

#[tauri::command]
pub fn memory_chat_sessions_list(app: AppHandle) -> Result<Vec<SessionMeta>, String> {
    let d = dir(&app)?;
    let mut metas: Vec<SessionMeta> = Vec::new();
    if let Ok(entries) = fs::read_dir(&d) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Ok(raw) = fs::read_to_string(&path) {
                if let Ok(s) = serde_json::from_str::<MemoryChatSession>(&raw) {
                    metas.push(SessionMeta {
                        id: s.id,
                        title: s.title,
                        updated_at: s.updated_at,
                    });
                }
            }
        }
    }
    metas.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(metas)
}

#[tauri::command]
pub fn memory_chat_session_get(app: AppHandle, id: String) -> Result<MemoryChatSession, String> {
    let path = session_path(&app, &id)?;
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn memory_chat_session_save(app: AppHandle, session: MemoryChatSession) -> Result<(), String> {
    let path = session_path(&app, &session.id)?;
    let tmp = path.with_extension("json.tmp");
    let payload = serde_json::to_string_pretty(&session).map_err(|e| e.to_string())?;
    fs::write(&tmp, &payload).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn memory_chat_session_delete(app: AppHandle, id: String) -> Result<(), String> {
    let path = session_path(&app, &id)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
