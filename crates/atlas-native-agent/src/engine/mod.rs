//! The ported Codex engine, behind the seam.
//!
//! Everything in here is gated on the `ported-engine` feature — the
//! development-time switch of spec Phase 2. With the feature off this module
//! does not exist, the engine is not in the dependency graph, and the shipped
//! app is byte-for-byte the Cersei path it is today. That is deliberate: the
//! Cersei path keeps shipping until the acceptance bar is green (Cutover
//! Sequence, Phase 5), so the switch must not be able to leak the engine into
//! a release build by accident.
//!
//! The surface is ADR-0004's: the engine is driven **in-process at the
//! app-server layer**, through `codex-app-server-client`, and `src-tauri` sees
//! only the `AgentServer` / `AgentConnection` traits it already speaks.
//!
//! Layout mirrors the Cersei-path seam next door, so the two are readable
//! side by side:
//!
//! - [`auth`] — the D10 token provider (`ExternalAuth` over an Atlas access JWT)
//! - [`config`] — engine config assembly, which the spec puts *here* rather than
//!   in `src-tauri`: the seam is the only place that knows both Atlas's settings
//!   and the engine's shape

pub mod auth;
pub mod config;
pub mod connection;
pub mod runtime;
pub mod server;
pub mod sink;

#[cfg(test)]
pub(crate) mod test_support;

pub use auth::{AtlasExternalAuth, AtlasTokenSource, Clock, SystemClock};
pub use config::{EngineHome, EngineProvider, EngineSettings, WireDialect};
pub use connection::EngineConnection;
pub use runtime::{start_engine, ATLAS_CLIENT_NAME};
pub use server::EngineAgentServer;
