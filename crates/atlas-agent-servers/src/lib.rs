//! Atlas's port of Zed's `agent_servers` crate — the transport to an external
//! ACP agent, and the launcher that starts one.
//!
//! Source of truth: `~/Codes/zed-ref/crates/agent_servers/src/`. This crate is
//! where the port's reliability lives; Zed's research notes call `acp.rs` the
//! highest-value thing to port because all the correctness mechanics are in it.
//! Each one is ported with the failure it prevents recorded at the code:
//!
//! - **`initialize` raced against child exit**, with a 250 ms grace so a binary
//!   that dies on startup reports its stderr instead of hanging on "connecting".
//! - **Session pre-registration before the load RPC resolves**, so the
//!   `session/update` notifications that replay history during `session/load`
//!   find a thread instead of being dropped.
//! - **Ref-counted `close_session` with pending-load dedup**, so a second opener
//!   joins the in-flight load and the session is only really closed once the
//!   last handle goes.
//! - **`suppress_abort_err`**, which turns an agent's "operation was aborted"
//!   internal error into a clean `StopReason::Cancelled` when we are the ones
//!   who cancelled.
//! - **`LoadError::Exited { status, stderr }` fanned out to every live session**,
//!   so an agent dying mid-turn surfaces in the conversation.
//!
//! Nothing links this crate yet. It is stage 1 of
//! `plans/atlas-acp-zed-port-plan.md`.
//!
//! # The dispatch queue is not ported
//!
//! Zed's `acp.rs` carries a substantial machine — `ForegroundWork`,
//! `ClientContext` behind an `mpsc`, `enqueue_request` / `enqueue_notification`,
//! a foreground dispatch task, and a dedicated OS thread with extra stack for
//! polling the connection future. All of it exists for one reason: the SDK
//! requires handler closures to be `Send`, and GPUI entities are not, so every
//! inbound message has to be handed across to the foreground thread.
//!
//! Atlas has no such constraint. The session table is a mutex and the threads
//! are ordinary `Send` values, so handlers run directly on the tokio worker that
//! received the message. This is a deliberate omission of a workaround, not of a
//! mechanism — no behaviour is lost with it.
//!
//! # Other divergences
//!
//! - **No `model_sniff`.** Model selection is config-options-first, matching Zed
//!   (research §D12-4, DECIDED). Nothing here probes an agent for a model list.
//! - **`fs/*` is served from disk**, per the same decision documented in
//!   `atlas_acp_thread`. An agent reading a modified-but-unsaved file sees the
//!   on-disk version.
//! - **Host facts are parameters, not globals.** Zed reads its release channel,
//!   app version, proxy settings and MCP server list off GPUI globals; they
//!   arrive here through [`server::ConnectOptions`] so this crate stays leaf-
//!   level and testable.
//! - **Remote/SSH command templating is not ported** — Zed rewrites the spawn
//!   through its remote client when the project lives on another host. Atlas is
//!   local-only.

pub mod connection;
pub mod debug_log;
pub mod handlers;
pub mod host_env;
pub mod server;
pub mod session;
pub mod session_list;

pub use connection::{
    client_capabilities_for_agent, map_acp_error, AcpConnection, AcpConnectionDefaults,
    AgentServerCommand, ThreadEventSink,
};
pub use debug_log::{
    AcpDebugLog, AcpDebugMessage, AcpDebugMessageContent, AcpDebugMessageDirection,
};
pub use handlers::ClientContext;
pub use host_env::sanitize_host_env;
pub use server::{
    env_quirks, load_proxy_env, AgentServer, AgentServerDelegate, ConnectOptions,
    CustomAgentServer, ExternalAgentServer,
};
pub use session::{AcpSession, ConfigOptions, SessionDirectories, SessionRegistry};
pub use session_list::AcpSessionList;
