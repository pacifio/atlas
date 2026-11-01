//! Projects the thread's events into the `SessionDelta` wire.
//!
//! This is the load-bearing seam of the ACP stack. Everything Atlas remembers
//! about what an agent did — the Timeline, the permanent checkpoint record,
//! analytics, transcripts, memory ingest — is downstream of these deltas, and
//! all of it pattern-matches concrete variants and fields. The wire is
//! additive-only (`atlas-agent-wire/tests/contract.rs` is the authority); this
//! crate's job is to reproduce its shapes from the thread, not to redesign them.
//!
//! # Where the two models differ, and how the gap is closed
//!
//! The thread and the wire disagree about what a "message" is, and the
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
//! - **User messages go on the wire only when the host sent them.** A prompt
//!   sent through the host's steering entry is stamped with who sent it
//!   ([`DeltaProjector::stamp_user_message`]) and its thread entry is announced
//!   as `user_message { origin, client_message_id }`, so a remote viewer sees
//!   the prompt and the window can adopt its own optimistic row. Unstamped user
//!   entries — history replayed by `session/load` — stay silent, as all of
//!   them used to. Capture and transcripts still take the prompt from the
//!   send-path hook, not from this delta.
//! - **Every delta carries a per-session `seq`**, dense and in emit order, and
//!   [`DeltaProjector::snapshot`] says which `seq` it reflects, so a late
//!   joiner can take a snapshot and apply only the deltas above it.
//! - **Turn start is a bare status flip.** There is no `turn_started` kind;
//!   `status: running` is the signal, and turn identity is stamped by the host
//!   ([`DeltaProjector::set_turn_seq`]), not carried by the thread.
//! - **Every delta reaches the pipeline losslessly and in order.** Per session,
//!   events are applied on one task in the order the thread emitted them, and
//!   each delta is handed to the host sink synchronously.
//!
//! # What the thread cannot tell us, and the host must
//!
//! Some deltas have no thread event behind them, so the host announces them:
//! [`DeltaProjector::note_turn_failed`] (the error text lives with whoever
//! awaited `prompt`), [`DeltaProjector::note_model_changed`],
//! [`DeltaProjector::note_mode_changed`] (the native agent raises no event for
//! its own mode), [`DeltaProjector::note_compression_saved`],
//! [`DeltaProjector::note_agent_disconnected`], and the turn controller's
//! [`DeltaProjector::note_queue_changed`] and
//! [`DeltaProjector::note_hold_changed`].

pub mod project;
pub mod projector;

pub use projector::{
    elicitation_wire, DeltaProjector, ElicitationKey, ElicitationWire, PendingElicitation,
    PendingPermission, PermissionKey, ProjectedSnapshot, ThreadObserver,
};

pub use atlas_agent_wire::{
    AgentId, DeltaSink, Message, MessageMode, MessageRole, Origin, PlanEntry, QueuedPrompt,
    SessionDelta, SessionDeltaEnvelope, SessionStatus, Subagent, SubagentStatus, ToolCall,
    ToolCallStatus, ToolContentBlock, Usage,
};
