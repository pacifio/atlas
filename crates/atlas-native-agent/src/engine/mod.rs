//! The vendored engine, behind the seam.
//!
//! This module used to be gated on the `ported-engine` feature — the
//! development-time switch of spec Phase 2, kept while the previous native path was
//! still shipping. The cutover happened: #54 deleted the feature and the
//! previous native path with it, so the engine is unconditional now and there is no
//! kill switch here. (The feature's deletion also caused the #54 auth outage
//! — four `#[cfg(feature = "ported-engine")]` blocks compiled to nothing —
//! which is why `unexpected_cfgs` is a workspace deny, #60.)
//!
//! The surface is ADR-0004's: the engine is driven **in-process at the
//! app-server layer**, through `atlas-engine-app-server-client`, and `src-tauri` sees
//! only the `AgentServer` / `AgentConnection` traits it already speaks.
//!
//! Layout mirrors the old native-path seam next door, so the two are readable
//! side by side:
//!
//! - [`auth`] — the D10 token provider (`ExternalAuth` over an Atlas access JWT)
//! - [`catalog_cache`] — the gateway's model catalogue, fetched and cached
//!   (ADR-0007); [`catalog`] projects one of its rows into the engine's record,
//!   because the gateway's own `/models` is shape-incompatible with the
//!   engine's fetch
//! - [`config`] — engine config assembly, which the spec puts *here* rather than
//!   in `src-tauri`: the seam is the only place that knows both Atlas's settings
//!   and the engine's shape
//! - [`approvals`] and [`questions`] — the two things the engine may ask the
//!   user mid-turn: tool permission, and a clarifying question (ADR-0013);
//!   [`tool_approvals`] is the permission for an outward action on one of
//!   Atlas's own tool servers (ADR-0014), which the engine asks as an MCP
//!   elicitation of its own

pub mod approvals;
pub mod auth;
pub mod catalog;
pub mod catalog_cache;
pub mod commands;
pub mod config;
pub mod connection;
pub mod mcp;
pub mod modes;
pub mod questions;
pub mod replay;
pub mod runtime;
pub mod server;
pub mod sink;
pub mod tool_approvals;

#[cfg(test)]
pub(crate) mod test_support;

pub use auth::{AtlasExternalAuth, AtlasTokenSource, Clock, SystemClock};
pub use catalog_cache::{
    CatalogueCache, CatalogueFetcher, CatalogueUnavailable, FetchError, GatewayCatalogueFetcher,
    ProjectedCatalogue,
};
// Re-exported so `src-tauri` names only this crate (the quarantine rule):
// the org source lives in the vendored API layer because that is where the
// header is attached, but the host registers it from Atlas's auth state.
pub use atlas_engine_api::atlas_chat::org::set_org_source;
pub use config::{EngineHome, EngineProvider, EngineSettings, WireDialect};
pub use connection::EngineConnection;
pub use runtime::{start_engine, ATLAS_CLIENT_NAME};
pub use server::EngineAgentServer;
