//! The agent session model and the `AgentConnection` seam every agent plugs
//! into.
//!
//! Several behaviours here are load-bearing and easy to get subtly wrong: chunk
//! merging by `messageId`, permission prompts surviving concurrent status
//! updates, out-of-order terminal buffering, and cancel semantics. Each is
//! documented at the function that implements it.
//!
//! This crate is the ACP stack now, not a staging area beside it. Seven
//! packages link it: `atlas-agent-manager`, `atlas-agent-servers`,
//! `atlas-agent-store`, `atlas-agent-delta`, `atlas-native-agent`,
//! `atlas-thread-metadata`, and `src-tauri`. Anything changed here is a change
//! to what ships — see `Cargo.toml` for what that means for the SDK pin.
//!
//! # Deliberately out of scope
//!
//! - **Entity-based reactivity.** There are no reactive entity handles or
//!   emit-on-change contexts. Mutations are plain `&mut self` methods, and
//!   change notifications are sent on an [`EventSink`] the host owns.
//! - **`mention.rs`.** Atlas has its own mention system. The visible consequence
//!   is that a `ResourceLink` renders as its bare URI rather than a mention link.
//! - **A streaming text buffer.** Drip-feeding streamed text for a smooth typing
//!   effect is not done here; Atlas's frontend already coalesces chunks, so text
//!   is appended as it arrives.
//! - **Markdown entities and multibuffer diffs.** Text is `String`; a diff is
//!   its `{path, old_text, new_text}` payload. Rendering stays in the frontend.
//! - **Remote/SSH proxying and collab RPC.**
//! - **An OS sandbox wrapper** around agent terminals (and its `_meta` helpers),
//!   which is a feature of its own.
//!
//! # Divergence: `fs/*` is served from disk
//!
//! DECIDED 2026-08-21 (research §D12-6). An editor-hosted client could serve
//! `fs/read_text_file` and `fs/write_text_file` out of its open buffers, so an
//! agent would read a file including the user's unsaved edits, and every agent
//! write would be recorded against the buffer in an action log. Atlas has no
//! buffer store: it serves those methods from disk.
//!
//! Two consequences follow, and neither is a bug to be fixed later without a
//! decision:
//!
//! 1. An agent reading a file the user has modified-but-not-saved sees the
//!    on-disk version, not what is on screen.
//! 2. There is no `ActionLog` equivalent, so "which edits in this buffer came
//!    from the agent" is not answerable from this crate. Atlas answers the
//!    related question — which files an agent wrote, and under which turn —
//!    from `atlas-checkpoint`, which samples the write set on the emit path.
//!
//! The disk-backed behaviour is the intended design, not a gap.
//!
//! # Divergence: git checkpoints are not part of the thread
//!
//! A design could hang a git checkpoint off each `UserMessage` so it can restore
//! the working tree to a prior turn. Atlas's checkpointing is different:
//! commits are *observed* by a git watcher and linked to turns after the fact,
//! never intercepted (`docs/agents/timeline-gate.md`, touchpoint #5). The field
//! is therefore absent rather than stubbed.

use std::sync::{Arc, Mutex};

pub mod connection;
pub mod elicitation;
pub mod prompt;
pub mod subagent;
pub mod terminal;
pub mod thread;

pub use connection::*;
pub use elicitation::*;
pub use terminal::*;
pub use thread::*;

/// Where a type sends its change notifications.
///
/// Unbounded because dropping an event is not an option: these carry entry
/// updates the UI's mirror depends on, and a dropped `EntryUpdated` leaves the
/// rendered thread permanently out of step with the model. Backpressure would be
/// worse than the memory — it would stall the streaming path.
pub type EventSink<T> = tokio::sync::mpsc::UnboundedSender<T>;
pub type EventStream<T> = tokio::sync::mpsc::UnboundedReceiver<T>;

pub fn event_channel<T>() -> (EventSink<T>, EventStream<T>) {
    tokio::sync::mpsc::unbounded_channel()
}

/// A shared, cloneable handle to a thread. It is an `Arc<Mutex<_>>`: thread
/// methods are synchronous and never await while mutating, so the lock is only
/// ever held for the duration of one update.
pub type AcpThreadHandle = Arc<Mutex<thread::AcpThread>>;

pub type ElicitationStoreHandle = Arc<Mutex<elicitation::ElicitationStore>>;
