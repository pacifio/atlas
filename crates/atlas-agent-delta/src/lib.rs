//! Projects the ported thread's events into the FROZEN `SessionDelta` wire.
//!
//! This is the load-bearing seam of the ACP port. Everything Atlas remembers
//! about what an agent did — the Timeline, the permanent checkpoint record,
//! analytics, transcripts, memory ingest — is downstream of these deltas, and
//! all of it pattern-matches concrete variants and fields. The shapes are
//! frozen (`docs/agents/delta-wire-contract.md`); this crate's job is to
//! reproduce them from a different source, not to redesign them.
//!
//! # Where the two models differ, and how the gap is closed
//!
//! The ported thread and the wire disagree about what a "message" is, and the
//! projection exists to reconcile that:
//!
//! - The thread keeps **one entry per assistant message**, with interleaved
//!   text and thought chunks inside it. The wire has **one message per
//!   contiguous run of one kind** (`mode: text` / `mode: thinking`). So an
//!   entry projects to as many wire messages as it has runs, and a chunk that
//!   switches kind opens a new one — which is exactly what the old stack did.
//! - The thread keeps **tool calls as their own entries**. The wire nests them
//!   in a message, so each tool call gets a synthetic message id of its own
//!   (`tool_call_upserted { message_id, tool_call }`), again as before.
//! - The thread reports **that** an entry changed (`EntryUpdated(ix)`); the
//!   wire wants the change itself. The projection keeps a mirror of what it has
//!   already emitted and sends the difference — a text suffix as a `text_chunk`,
//!   a grown tool result as a `tool_call_output_chunk`, anything else as a full
//!   snapshot.
//!
//! # Conventions the consumers rely on (research §C9 touchpoint #2)
//!
//! - **User messages never go on the wire.** The prompt reaches capture only
//!   through the send-path `note_prompt` hook, with the raw text before memory
//!   prefixing. A `UserMessage` entry is mirrored and emits nothing.
//! - **Turn start is a bare status flip.** There is no `turn_started` kind;
//!   `status: running` is the signal, and turn identity is stamped by the host
//!   ([`DeltaProjector::set_turn_seq`]), not carried by the thread.
//! - **Every delta reaches the pipeline losslessly and in order.** Per session,
//!   events are applied on one task in the order the thread emitted them, and
//!   each delta is handed to the host sink synchronously.
//!
//! # What the thread cannot tell us, and the host must
//!
//! Four deltas have no thread event behind them, so the host announces them:
//! [`DeltaProjector::note_turn_failed`] (the error text lives with whoever
//! awaited `prompt`), [`DeltaProjector::note_model_changed`],
//! [`DeltaProjector::note_compression_saved`] and
//! [`DeltaProjector::note_agent_disconnected`].

pub mod project;
pub mod projector;

pub use projector::{DeltaProjector, ElicitationKey, PermissionKey, ThreadObserver};

pub use atlas_agent_wire::{
    AgentId, DeltaSink, Message, MessageMode, MessageRole, PlanEntry, SessionDelta,
    SessionDeltaEnvelope, SessionStatus, ToolCall, ToolCallStatus, ToolContentBlock, Usage,
};
