//! Atlas's record of what its agents did, and which commits it produced.
//!
//! # The problem
//!
//! Agent Sessions are ephemeral. They live in the sidebar until they scroll
//! away, and the reasoning behind a change is gone the moment the conversation
//! ends — so six weeks later nobody can answer "why was it written this way",
//! including the person who wrote it. In an Organisation it is worse: two
//! developers working the same repository cannot see what the other's agent did,
//! and every Session starts from zero.
//!
//! # The shape
//!
//! A Session is one agent conversation. Its Messages are the only place the
//! transcript lives. A **Checkpoint** is the slice of one Session whose work
//! landed in one git commit — identified by the `(Session, commit)` pair, and
//! carrying no transcript of its own.
//!
//! Everything is written to `.atlas/sessions.db`, a SQLite database in the
//! Project's already-gitignored state directory, with bodies over 64 KB
//! spilled to content-addressed files beside it. The tables mirror the eventual
//! server shape so syncing is a copy rather than a translation, and the outbox
//! is a `sync_state` column on each row rather than a separate queue — which is
//! what makes Local mode the same code path with draining switched off, instead
//! of a second thing to keep correct.
//!
//! # Three properties worth stating outright
//!
//! **Redaction runs before persistence.** Not before upload. An agent that reads
//! a `.env` puts its contents verbatim into the transcript, so the guarantee has
//! to hold at the point of writing or it does not hold at all. See
//! [`capture`] — it is the only module that may write agent content, and it
//! fails closed if scrubbing does not complete.
//!
//! **Nothing here touches the network.** Capture never waits on a connection, so
//! offline is the ordinary case rather than a degraded one, and a Project can
//! stay Local forever with the full timeline available.
//!
//! **Commits are observed, not intercepted.** No git hooks: they mutate the
//! user's repository, have to chain whatever else is installed, and — decisively
//! — cannot see a commit made before they existed. Watching refs move can, which
//! is what lets a commit made from a terminal, from another editor, or while
//! Atlas was closed still find its Session.
//!
//! # Testing
//!
//! The crate is Tauri-free on purpose. Its tests drive the public API against a
//! real temporary directory, a real SQLite database and a real git repository —
//! no mock traits, no assertions on internal call ordering. What is asserted is
//! what ends up in the store.

pub mod artifacts;
pub mod binding;
pub mod blobs;
pub mod capture;
pub mod checkpoint;
mod error;
pub mod git;
pub mod health;
pub mod import;
mod lock;
pub mod model;
mod schema;
pub mod sketch;
mod store;
pub mod sync;
pub mod timeline;
pub mod title;
pub mod tools;

pub use binding::{bind, detect, disable, enable, refresh_detection};
pub use blobs::{BlobStore, PREVIEW_BYTES, SPILL_THRESHOLD_BYTES};
pub use capture::{
    hash_written_content, Capture, FileWrite, SessionKey, ToolCallContent, TurnContent,
};
pub use checkpoint::{
    link_commits, reconcile_rewrites, walk_new_commits, ReconcileOutcome, WalkOutcome,
};
pub use error::{Error, Result};
pub use health::{evaluate as evaluate_health, CaptureHealth, HealthState, HostSignals};
pub use import::{
    import_all, preview as import_preview, ImportOutcome, ImportPreview, TranscriptSource,
};
pub use model::{
    AgentEdit, Binding, Checkpoint, FileTouch, LinkState, Message, Mode, ProjectDetection,
    ProjectMode, Role, Session, Source, SyncState, TokenTotals, ToolCall, ToolStatus, TurnMessages,
    TurnState, UsageDeltaRow,
};
pub use schema::{REQUIRED_INDEXES, SCHEMA_VERSION};
pub use store::{CheckpointInput, MessageInput, Store};
pub use sync::{
    connect_workspace, drain, list_workspaces, preselect, register_workspace, ConnectOutcome,
    ConnectRequest, DrainOutcome, DrainStatus, MatchReason, Preselection, Registration,
    RemoteWorkspace, SlugAvailability, SyncConfig, Visibility,
};
pub use timeline::{
    anchors as session_anchors, detail as session_detail, recent_checkpoints, session_summary,
    sessions as session_summaries, AnchorEntry, CheckpointRow, EntryCounts, EntryKind,
    SessionDetail, SessionSummary, TimelineEntry, ToolTally,
};
pub use tools::{canonical_name, ResolvedPath, ToolName};

/// The per-project state directory Atlas already uses, under a Project root:
/// `.atlas`, or `.atlas-dev` under the dev profile (`atlas-profile`).
///
/// Auto-gitignored, and a dozen features already write here — this crate is the
/// first to put a database in it.
pub fn atlas_dir(project_root: impl AsRef<std::path::Path>) -> std::path::PathBuf {
    atlas_profile::dir_in(project_root)
}
