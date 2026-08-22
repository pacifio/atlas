//! Atlas's port of Zed's `acp_thread` crate — the agent session model and the
//! `AgentConnection` seam every agent plugs into.
//!
//! Source of truth: `~/Codes/zed-ref/crates/acp_thread/src/`. This is a port of
//! the mechanism, not a rewrite: where Zed's behaviour is load-bearing (chunk
//! merging by `messageId`, permission prompts surviving concurrent status
//! updates, out-of-order terminal buffering, cancel semantics) the logic is
//! ported line-for-line and the Zed file:line is cited at the function.
//!
//! Nothing links this crate yet. It is stage 1 of
//! `plans/atlas-acp-zed-port-plan.md`; the old ACP stack is untouched and stays
//! on its own SDK version.
//!
//! # What is deliberately NOT ported
//!
//! Per the plan's "Dropped from the port":
//!
//! - **GPUI reactivity.** `Entity<T>` / `Context<T>` / `Task<T>` / `cx.emit` have
//!   no equivalent here. Mutations are plain `&mut self` methods, and what Zed
//!   emits through `cx.emit` is sent on a [`EventSink`] the host owns.
//! - **`mention.rs`.** Atlas has its own mention system. The visible consequence
//!   is that a `ResourceLink` renders as its bare URI rather than a mention link.
//! - **`StreamingTextBuffer`.** Zed drip-feeds streamed text into a markdown
//!   entity for a smooth typing effect; Atlas's frontend already coalesces
//!   chunks, so text is appended as it arrives.
//! - **Markdown entities and multibuffer diffs.** Text is `String`; a diff is
//!   its `{path, old_text, new_text}` payload. Rendering stays in the frontend.
//! - **Remote/SSH proxying and collab RPC.**
//! - **Zed's OS sandbox wrapper** (`SandboxWrap` and its `_meta` helpers), which
//!   depends on Zed's `sandbox` crate and is a feature of its own.
//!
//! # Divergence: `fs/*` is served from disk
//!
//! DECIDED 2026-08-21 (research §D12-6). Zed serves `fs/read_text_file` and
//! `fs/write_text_file` out of its project's open buffers, so an agent reads a
//! file including the user's unsaved edits, and every agent write is recorded
//! against the buffer in its `ActionLog`. Atlas has no buffer store: it serves
//! those methods from disk.
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
//! This is not Zed parity and must not be described as such.
//!
//! # Divergence: git checkpoints are not part of the thread
//!
//! Zed hangs a `GitStoreCheckpoint` off each `UserMessage` so it can restore the
//! working tree to a prior turn. Atlas's checkpointing is a different design:
//! commits are *observed* by a git watcher and linked to turns after the fact,
//! never intercepted (`docs/agents/timeline-gate.md`, touchpoint #5). The field
//! is therefore absent rather than stubbed.

use std::sync::{Arc, Mutex};

pub mod connection;
pub mod elicitation;
pub mod prompt;
pub mod terminal;
pub mod thread;

pub use connection::*;
pub use elicitation::*;
pub use terminal::*;
pub use thread::*;

/// Where a type sends what Zed would have emitted with `cx.emit`.
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

/// Zed hands out `Entity<AcpThread>`, a GPUI handle that is `Clone` and whose
/// updates are serialised by the foreground executor. The equivalent here is an
/// `Arc<Mutex<_>>`: thread methods are synchronous and never await while
/// mutating, so the lock is only ever held for the duration of one update.
pub type AcpThreadHandle = Arc<Mutex<thread::AcpThread>>;

pub type ElicitationStoreHandle = Arc<Mutex<elicitation::ElicitationStore>>;
