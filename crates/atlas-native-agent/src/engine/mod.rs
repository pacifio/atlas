//! The ported Codex engine, behind the seam.
//!
//! This module used to be gated on the `ported-engine` feature — the
//! development-time switch of spec Phase 2, kept while the Cersei path was
//! still shipping. The cutover happened: #54 deleted the feature and the
//! Cersei path with it, so the engine is unconditional now and there is no
//! kill switch here. (The feature's deletion also caused the #54 auth outage
//! — four `#[cfg(feature = "ported-engine")]` blocks compiled to nothing —
//! which is why `unexpected_cfgs` is a workspace deny, #60.)
//!
//! The surface is ADR-0004's: the engine is driven **in-process at the
//! app-server layer**, through `codex-app-server-client`, and `src-tauri` sees
//! only the `AgentServer` / `AgentConnection` traits it already speaks.
//!
//! Layout mirrors the Cersei-path seam next door, so the two are readable
//! side by side:
//!
//! - [`auth`] — the D10 token provider (`ExternalAuth` over an Atlas access JWT)
//! - [`catalog`] — the Atlas-authored model catalogue (D3), because the
//!   gateway's own `/models` is shape-incompatible with the engine's fetch
//! - [`config`] — engine config assembly, which the spec puts *here* rather than
//!   in `src-tauri`: the seam is the only place that knows both Atlas's settings
//!   and the engine's shape

pub mod approvals;
pub mod auth;
pub mod catalog;
pub mod commands;
pub mod config;
pub mod connection;
pub mod memory;
pub mod modes;
pub mod replay;
pub mod runtime;
pub mod server;
pub mod sink;

#[cfg(test)]
pub(crate) mod test_support;

pub use auth::{AtlasExternalAuth, AtlasTokenSource, Clock, SystemClock};
pub use catalog::{atlas_catalog, DEFAULT_MODEL};
// Re-exported so `src-tauri` names only this crate (the quarantine rule):
// the org source lives in the vendored API layer because that is where the
// header is attached, but the host registers it from Atlas's auth state.
pub use codex_api::atlas_chat::org::set_org_source;
pub use config::{EngineHome, EngineProvider, EngineSettings, WireDialect};
pub use connection::EngineConnection;
pub use runtime::{start_engine, ATLAS_CLIENT_NAME};
pub use server::EngineAgentServer;
