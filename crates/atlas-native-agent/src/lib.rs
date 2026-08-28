//! Atlas Agent — the native agent — on the `AgentConnection` seam.
//!
//! This is Atlas's answer to Zed's `NativeAgentServer` / `NativeAgentConnection`:
//! the native agent occupies the same slot an external ACP agent does, so the
//! manager, the thread model and the UI treat it identically. Everything
//! specific to it — reasoning effort, its own model list — hangs off
//! native-only sub-traits, which is Zed's pattern too.
//!
//! # One engine, no switch
//!
//! The Cersei runtime that used to back this seam is gone (#54). The ported
//! Codex engine in [`engine`] is the only implementation, and it is no longer
//! behind a cargo feature — the development-time switch existed so the Cersei
//! path could keep shipping while the port was proved, and there is no longer
//! a second path for it to select.
//!
//! What survived the deletion, deliberately:
//!
//! - **[`CERSEI_AGENT_ID`]** — the stored agent id, still the literal string
//!   `"cersei"`. It is a **storage key**, not a name: every recorded thread
//!   resolves through it, so changing it would orphan history that already
//!   exists. It outlives the retirement of the name (D7).
//! - **[`AgentSessionEffort`]** — the native-only control the app reaches for
//!   through a downcast.
//!
//! What did not: tool-output compression. It had no engine counterpart and is
//! a named casualty (D8), so the trait, its command and its toggle are gone
//! rather than left as a control that does nothing.
//!
//! # What the native agent does not implement, and why
//!
//! - **`AgentSessionTruncate`.** Rewinding to a user message needs a map from
//!   client message id to history index; the engine stores neither.
//! - **`auth_methods` / `authenticate`.** The native agent authenticates with
//!   the user's Atlas account through the D10 token provider, not with an ACP
//!   auth method. It advertises none, which is what makes the sign-in flow skip
//!   it.
//! - **Elicitations.** Nothing is asked of the user mid-turn except tool
//!   permission, which has its own path.

pub mod engine;

use anyhow::Result;

/// The native agent's stored id.
///
/// **Still `"cersei"`, and that is not an oversight.** The name is retired; the
/// id is a storage key that every recorded thread resolves through, and it is
/// deliberately stable across the engine swap so existing rows keep working
/// (D7, CONTEXT.md). Renaming it is a data migration, not a rename.
pub const CERSEI_AGENT_ID: &str = "cersei";

/// Per-session reasoning effort — a native-only control.
///
/// Reached by downcasting the connection, because it is not part of the ACP
/// surface every agent shares.
///
/// **Inert on the Atlas gateway.** The gateway's forwarded allowlist has no
/// reasoning parameter and names a thinking budget as its own example of a
/// rejected key, so the authored catalogue advertises no effort levels and the
/// picker offers none. The trait stays because the engine still accepts the
/// setting and a non-gateway provider would honour it.
pub trait AgentSessionEffort: Send + Sync {
    /// `None` clears the override and uses the model's own default.
    fn set_effort(&self, level: Option<String>) -> Result<()>;
}

pub use engine::EngineAgentServer;
pub use engine::connection::EngineConnection;
