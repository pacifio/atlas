//! The **UI tool server**: Atlas Agent's way to act on the Atlas window
//! (ADR-0012). A second MCP service beside the memory tool server, on the
//! same loopback listener, behind the same token check and the same
//! per-session token — the token store binds one token per session, so a
//! second minted token would revoke the memory one.
//!
//! - **Offered only to a connection that carries UI control**
//!   ([`offers`]): today the in-process native connection. Never decided by
//!   agent identity.
//! - **Every call is one UI action** ([`bridge`]): emitted to the window as
//!   [`UI_ACTION_EVENT`], performed by the frontend through the app's own
//!   openers and store actions, answered by [`ui_action_respond`]. Rust
//!   forwards the frontend's JSON verbatim and mirrors no UI state — the
//!   frontend owns layout and focus (ARCHITECTURE.md). An action the window
//!   does not answer in time is a tool error, never a hung turn.
//! - **Gated by the user's navigation setting** ([`NavigationGate`]), at
//!   offer time and on every call.

mod bridge;
mod offers;
#[cfg(test)]
mod tests;
mod tools;

use std::sync::Arc;

use tauri::State;
use uuid::Uuid;

#[allow(unused_imports)]
pub use bridge::{UiBridge, UiEmitter, UiReply, UiRequest, UI_ACTION_TIMEOUT};
#[allow(unused_imports)]
pub use offers::{UiOffer, UiOfferDecision};
#[allow(unused_imports)]
pub use tools::{router, UiTools, INSTRUCTIONS};

/// The name the server goes by in the agent's MCP configuration; its tools
/// reach the model as `mcp__atlas_ui__<tool>`.
pub const UI_SERVER_NAME: &str = "atlas_ui";

/// Where the service is mounted on the tool-server listener.
pub const UI_PATH: &str = "/ui";

/// Rust → window: one UI action to perform. Answered by [`ui_action_respond`].
pub const UI_ACTION_EVENT: &str = "atlas:ui-action";

/// The window event one bridged request goes out on. The bridge is one
/// implementation for every call that crosses to the window: the UI tool
/// server's actions go out as [`UI_ACTION_EVENT`], and the organisation tool
/// server's window tools ([`WINDOW_TOOLS`], e.g. drawing on a Space page,
/// whose codec lives in the frontend) as [`ORG_WINDOW_ACTION_EVENT`], so each
/// half of the frontend hears only its own. Both are answered through
/// [`ui_action_respond`], on the same pending map.
///
/// [`WINDOW_TOOLS`]: crate::commands::org_server::WINDOW_TOOLS
/// [`ORG_WINDOW_ACTION_EVENT`]: crate::commands::org_server::ORG_WINDOW_ACTION_EVENT
pub fn action_event(request: &UiRequest) -> &'static str {
    if crate::commands::org_server::WINDOW_TOOLS.contains(&request.tool.as_str()) {
        crate::commands::org_server::ORG_WINDOW_ACTION_EVENT
    } else {
        UI_ACTION_EVENT
    }
}

/// Whether the user lets Atlas Agent act on the window (Settings → General →
/// "Let Atlas Agent navigate the app"). Checked when a session is offered the
/// server and on every call, so switching it off stops the agent at once.
pub type NavigationGate = Arc<dyn Fn() -> bool + Send + Sync>;

/// The window's answer to one UI action. An id nobody is waiting on — already
/// answered, timed out, or never issued — is a harmless no-op.
#[tauri::command]
pub fn ui_action_respond(request_id: Uuid, reply: UiReply, bridge: State<'_, Arc<UiBridge>>) -> Result<(), String> {
    bridge.respond(request_id, reply);
    Ok(())
}
