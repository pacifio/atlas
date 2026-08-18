//! atlas-agents — multi-agent orchestration above `atlas-acp`.
//!
//! Rust owns per-session state. The UI is a thin event consumer: it fetches a
//! snapshot on tab activate and subscribes to a per-session delta stream.
//!
//! Layers:
//! - `plugin`     — descriptors for spawnable agents (claude / codex / opencode)
//! - `manager`    — multi-agent / multi-session registry, wraps `atlas_acp::AgentRegistry`
//! - `session`    — `SessionState` + serializable `SessionSnapshot`
//! - `actor`      — one single-owner tokio task per session; drives turns and
//!                  applies events in one FIFO so the idle/ordering race can't occur
//! - `handle`     — the per-session handle the manager holds (state + actor channels)
//! - `events`     — `SessionDelta` wire shape + `DeltaSink` trait
//! - `transcript` — JSONL replay (claude-code transcripts) for `load_session`

pub mod actor;
pub mod apply;
pub mod backend;
pub mod connection;
pub mod error;
pub mod events;
pub mod handle;
pub mod manager;
pub mod plugin;
pub mod session;
pub mod transcript;

pub use atlas_cersei::SessionMeta;
// Memory-RAG grounding seam for the native agent — the Tauri layer registers a
// retrieval backend; the agent gets a `search_memory` tool.
pub use atlas_cersei::{MemDoc, MemorySearchFn, ReplayItem, register_memory_search};
// Native-agent session transcripts for the memory corpus (Chat / Graph index).
pub use atlas_cersei::{corpus_sessions as cersei_corpus_sessions, CorpusSession as CerseiCorpusSession};
// On-disk cersei session dir (cwd-hashed) — used by the session file-watcher.
pub use atlas_cersei::project_sessions_dir as cersei_project_sessions_dir;
// The native agent's plugin id. Re-exported so a host that only sees a
// `SessionSnapshot` can tell the native agent from an ACP-hosted one without
// taking its own dependency on atlas-cersei — session capture needs the
// distinction because only the native agent reports a real token split.
pub use atlas_cersei::CERSEI_PLUGIN_ID;
/// What bounds the native agent in a workspace — see `cersei_enforcement`.
pub use atlas_cersei::Enforcement;
pub use atlas_agentkit::{
    AgentConnection, AuthFlow, CompressionCtl, EffortControl, ModelSelector, RunningTurn,
    SessionModes, TurnId,
};
pub use backend::{AcpBackend, AgentBackend, CerseiBackend};
pub use connection::BackendConnection;
pub use error::{Error, Result};
pub use atlas_bus::{EventBus, InboundMiddleware, InboundPipeline, OutboundMiddleware, OutboundPipeline};
pub use events::{DeltaSink, Emitter, SessionDelta, SessionDeltaEnvelope};
pub use manager::{AgentManager, SessionInit, SessionKey};
pub use plugin::{PluginSpec, TranscriptKind, builtin_plugins, find_plugin};
pub use session::{
    Message, MessageMode, MessageRole, PlanEntry, SessionSnapshot, SessionStatus, ToolCall,
    ToolCallStatus, Usage,
};

// Re-export common atlas-acp identifiers so the Tauri layer only needs to
// depend on this crate for the high-level surface.
pub use atlas_acp::{AgentId, AgentInfo, AuthMethodWire, PermissionDecision, SessionId, StopReason};
