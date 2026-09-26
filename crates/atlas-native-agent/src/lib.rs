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
//! The previous native runtime that used to back this seam is gone (#54). The ported
//! vendored engine in [`engine`] is the only implementation, and it is no longer
//! behind a cargo feature — the development-time switch existed so the previous
//! native path could keep shipping while the port was proved, and there is no
//! longer a second path for it to select.
//!
//! What survived the deletion, deliberately:
//!
//! - **[`ATLAS_AGENT_ID`]** — the stored agent id, the literal string
//!   `"atlas-agent"`. It is a **storage key**: every recorded thread resolves
//!   through it, so it is the one string the app and the store must agree on
//!   (ADR-0011).
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
//! - **Elicitations, bar one.** Nothing is asked of the user mid-turn except
//!   tool permission and a clarifying question (ADR-0013). Permission has its
//!   own path; the question is the engine's `request_user_input` tool, raised
//!   as an elicitation on the thread so the existing question card answers it
//!   ([`engine::questions`]). MCP servers' elicitations stay refused: a tool
//!   server returns candidates and the model asks. The one elicitation served
//!   is the engine's OWN — its approval before an outward action on one of
//!   Atlas's tool servers (ADR-0014), which is tool permission in an MCP
//!   envelope and goes to the approval card ([`engine::tool_approvals`]).

pub mod engine;

use anyhow::Result;

/// The native agent's stored id.
///
/// A storage key every recorded thread resolves through, so it must match the
/// frontend's `NATIVE_AGENT_ID` and the thread-metadata store's rows. It was
/// renamed from the retired id in ADR-0011; rows under the old id were dropped
/// by the store's V3 migration rather than aliased. Renaming it again is a data
/// migration, not a rename.
pub const ATLAS_AGENT_ID: &str = "atlas-agent";

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
