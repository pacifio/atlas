//! The session-delta wire, re-exported from `atlas-agent-wire`.
//!
//! The shapes moved out of this crate so the ported stack can produce them too:
//! `atlas-agents` is on `agent-client-protocol` 1.3 and the ported crates are
//! on 2.0, and the two can never share a Cargo graph. Everything that said
//! `atlas_agents::{SessionDelta, SessionDeltaEnvelope, DeltaSink, Emitter}`
//! still resolves, and to the same types.

pub use atlas_agent_wire::{DeltaSink, Emitter, SessionDelta, SessionDeltaEnvelope};
