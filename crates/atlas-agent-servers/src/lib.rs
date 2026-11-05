//! The transport to an external ACP agent, and the launcher that starts one.
//!
//! This crate is where the ACP stack's reliability lives: `connection.rs` holds
//! the correctness mechanics. Each one is documented with the failure it
//! prevents, at the code:
//!
//! - **`initialize` raced against child exit**, with a 250 ms grace so a binary
//!   that dies on startup reports its stderr instead of hanging on "connecting".
//! - **Session pre-registration before the load RPC resolves**, so the
//!   `session/update` notifications that replay history during `session/load`
//!   find a thread instead of being dropped.
//! - **Ref-counted `close_session` with pending-load dedup**, so a second opener
//!   joins the in-flight load and the session is only really closed once the
//!   last handle goes.
//! - **[`session::CancelSignal`]**, which does two jobs a cancel needs and the
//!   wire notification cannot do alone. It turns an agent's "operation was
//!   aborted" internal error into a clean `StopReason::Cancelled` when we are
//!   the ones who cancelled — per turn, so a cancel cannot be spent on a turn
//!   it was not meant for. And it is the deadline: `cancel` is a notification
//!   with no response and no obligation, so an agent that ignores it left the
//!   prompt pending forever, and the chat could only be recovered by quitting.
//! - **`LoadError::Exited { status, stderr }` fanned out to every live session**,
//!   so an agent dying mid-turn surfaces in the conversation.
//!
//! # The dispatch queue is load-bearing
//!
//! Inbound requests and notifications go through a dispatch queue rather than
//! being awaited inline by the handlers. Awaiting them inline was tried and is
//! wrong: the SDK dispatches inbound messages serially and awaits each registered closure
//! to completion before parsing the next, so an inline-awaited permission
//! prompt froze every message behind it — tool results, text, other sessions'
//! work, and the `$/cancel` that would have ended the wait. The queue is what
//! keeps a handler's WAIT out of the pipeline while keeping its state mutation
//! in wire order. The full account is in the [`handlers`] module docs (#28).
//!
//! # Other design decisions
//!
//! - **No `model_sniff`.** Model selection is config-options-first
//!   (research §D12-4, DECIDED). Nothing here probes an agent for a model list.
//! - **`fs/*` is served from disk**, per the same decision documented in
//!   `atlas_acp_thread`. An agent reading a modified-but-unsaved file sees the
//!   on-disk version.
//! - **Host facts are parameters, not globals.** The release channel, app
//!   version, proxy settings and MCP server list arrive through [`server::ConnectOptions`] so this crate stays leaf-
//!   level and testable.
//! - **No remote/SSH command templating.** Atlas is local-only, so the spawn is
//!   never rewritten to run on another host.

pub mod connection;
pub mod debug_log;
pub mod handlers;
pub mod host_env;
pub mod server;
pub mod session;
pub mod session_list;
pub mod session_mcp;

pub use connection::{
    client_capabilities_for_agent, map_acp_error, AcpConnection, AcpConnectionDefaults,
    AgentServerCommand, ConnectionDeadlines, RequestElicitationSink, ThreadEventSink,
    INITIALIZE_TIMEOUT, REQUEST_TIMEOUT,
};
pub use debug_log::{
    AcpDebugLog, AcpDebugMessage, AcpDebugMessageContent, AcpDebugMessageDirection,
    MAX_DEBUG_BACKLOG_BYTES, MAX_DEBUG_MESSAGE_BYTES,
};
pub use handlers::ClientContext;
pub use host_env::sanitize_host_env;
pub use server::{
    atlas_only_memory, env_quirks, env_quirks_from, load_proxy_env, memory_quirks,
    set_atlas_only_memory, AgentServer, AgentServerDelegate, ConnectOptions, CustomAgentServer,
    ExternalAgentServer,
};
pub use session::{
    AcpSession, CancelProbe, CancelSignal, CancelWaiter, ConfigOptions, SessionDirectories,
    SessionRegistry,
};
pub use session_list::AcpSessionList;
pub use session_mcp::{
    AskFirst, CallDescription, CallToApprove, OutwardConsent, SessionMcpOffer, SessionMcpRequest,
    SessionMcpServers,
};
