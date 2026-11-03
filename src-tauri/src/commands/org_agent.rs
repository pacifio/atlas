//! Atlas, the Organisation's agent: the bridge between
//! `atlas_comms::org_agent` and the renderer.
//!
//! The same trust boundary as team chat: only Rust holds the Bearer, so the
//! renderer can neither dial the agent's socket nor call its doors itself.
//! Frames go out on `atlas:org-agent` verbatim; the protocol's rules (seq
//! order, resume, the outbox) are the renderer's, as on the web.
//!
//! The socket follows team chat's Organisation (`comms_org_id`): the desktop's
//! explicit choice, never "the first one listed", and nothing for a local-only
//! Organisation.

use std::sync::Arc;

use atlas_comms::org_agent::{AgentConnState, OrgAgentManager};
use atlas_comms::{CommsError, TokenSource};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// The window event channel, one per subsystem like `atlas:comms`.
pub const ORG_AGENT_EVENT: &str = "atlas:org-agent";

pub struct OrgAgentState(pub OrgAgentManager);

fn manager(app: &AppHandle) -> Result<OrgAgentManager, String> {
    app.try_state::<OrgAgentState>()
        .map(|s| s.0.clone())
        .ok_or_else(|| err("unavailable", "The organisation agent is not ready."))
}

/// Every refusal as `{code, message}` JSON, the server's own envelope, so the
/// renderer can say why (`atlas_off`, `loops_max`, `not_a_poster` …) instead
/// of a flattened string.
fn err(code: &str, message: &str) -> String {
    serde_json::json!({ "code": code, "message": message }).to_string()
}

fn map_err(e: CommsError) -> String {
    match e {
        CommsError::Refused { code, message, .. } => err(&code, &message),
        CommsError::Unauthorized => err("unauthorized", "Sign in to continue."),
        CommsError::Forbidden => err("forbidden", "You do not have access to that."),
        CommsError::NotFound => err("not_found", "Not found."),
        CommsError::Token(_) => err("signed_out", "Sign in to an organisation to use the agent."),
        CommsError::Transport(m) => err("network", &format!("Could not reach Atlas ({m}).")),
        CommsError::Protocol(m) => err("bad_request", &m),
        CommsError::Store(m) => err("unavailable", &m),
    }
}

/// Stand the manager up and bridge its events onto the window channel. Called
/// from `comms::install`, with chat's token source.
pub fn install(app: &AppHandle, tokens: Arc<dyn TokenSource>) {
    let manager = {
        let handle = tauri::async_runtime::handle();
        let _guard = handle.inner().enter();
        OrgAgentManager::new(tokens)
    };
    app.manage(OrgAgentState(manager.clone()));
    let forward = app.clone();
    let mut rx = manager.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(envelope) => {
                    if let Err(e) = forward.emit(ORG_AGENT_EVENT, &envelope) {
                        tracing::error!(target: "atlas_comms::org_agent", "emit failed: {e}");
                    }
                }
                // Frames were dropped: tell the renderer to resume from what it
                // holds, which is exactly what a reconnect does.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(target: "atlas_comms::org_agent", "bridge lagged {n} frames");
                    let (org, epoch, _) = manager.status();
                    let _ = forward.emit(
                        ORG_AGENT_EVENT,
                        serde_json::json!({
                            "org": org.unwrap_or_default(),
                            "epoch": epoch,
                            "ev": { "kind": "connection", "state": "open" }
                        }),
                    );
                }
                Err(_) => break,
            }
        }
    });
}

/// Follow team chat's Organisation. Called from `comms::retarget`.
pub fn retarget(app: &AppHandle, org: Option<String>) {
    if let Some(state) = app.try_state::<OrgAgentState>() {
        state.0.set_target(org);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgAgentStatusDto {
    pub org_id: Option<String>,
    pub epoch: u64,
    pub state: AgentConnState,
}

/// Where the socket stands, for a renderer that mounted after the last event.
#[tauri::command]
pub fn org_agent_status(app: AppHandle) -> Result<OrgAgentStatusDto, String> {
    let (org_id, epoch, state) = manager(&app)?.status();
    Ok(OrgAgentStatusDto {
        org_id,
        epoch,
        state,
    })
}

/// Send one client frame (`ask.send`, `resume`, `approval.decide` …). Checked
/// to be a JSON object with a `t`; its fields are the server's to judge.
/// `false` when the socket is not open: the renderer's outbox keeps it.
#[tauri::command]
pub fn org_agent_send(app: AppHandle, frame: serde_json::Value) -> Result<bool, String> {
    let ok = frame
        .get("t")
        .and_then(|t| t.as_str())
        .is_some_and(|t| t.len() <= 40);
    if !ok {
        return Err(err("bad_request", "A frame needs a `t`."));
    }
    Ok(manager(&app)?.send(frame.to_string()))
}

/// Dial again now (Atlas switched back on, or the socket looks stale).
#[tauri::command]
pub fn org_agent_reconnect(app: AppHandle) -> Result<(), String> {
    manager(&app)?.reconnect();
    Ok(())
}

/// One REST door, as the member, in the socket's Organisation. `path` is the
/// door without `?org=` (`/asks/a1?after_seq=3`); unknown doors are refused
/// before anything is sent (`org_agent::door_allowed`).
#[tauri::command(async)]
pub async fn org_agent_rest(
    app: AppHandle,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    manager(&app)?
        .rest(&method.to_ascii_uppercase(), &path, body)
        .await
        .map_err(map_err)
}
