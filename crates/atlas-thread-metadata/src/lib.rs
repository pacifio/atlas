//! Atlas's session history: the app-owned thread-metadata store.
//!
//! # Why this crate exists
//!
//! Atlas's sidebar used to be built by reading each agent CLI's private
//! storage — Claude's project JSONL, Kilo's SQLite, Codex's state database —
//! merged with a live ACP `session/list` query. That coupled Atlas to formats
//! it does not own, needed a bespoke reader per agent (special treatment by
//! construction), and made history impossible for any agent nobody had written
//! a reader for. Atlas now owns its history and never reads another program's
//! storage. See ADR-0001.
//!
//! # The shape
//!
//! A **thread** is one conversation as Atlas tracks it, keyed by an id Atlas
//! mints. It exists independently of any agent process: before its first
//! message it is a **draft** with no ACP session id at all, and it outlives an
//! agent forgetting the session afterwards.
//!
//! A row is **metadata only** — ids, agent, titles, timestamps, worktree paths,
//! the session's lifecycle (settled, pinned, snoozed, last viewed), and the
//! projects attached to it besides its own folder ([`AttachedProject`]), and
//! the pull requests linked to it ([`PullRequestLink`]). No message, no chunk, no tool call, no token. Replaying a
//! conversation is the agent's job, through `session/load`. This is the single
//! invariant the whole design rests on; anything that would put transcript
//! content in this crate is a design error, not a feature.
//!
//! Rows arrive from exactly two places: live conversation events
//! ([`ThreadMetadataStore::record_live_update`]) and ACP `session/list` import
//! ([`ThreadMetadataStore::save_all`]). Nothing else feeds it, and in
//! particular nothing reads anyone's files.
//!
//! # Design choices
//!
//! Three are documented at their site: change notification is a broadcast
//! channel, there are no archived-git-worktree side tables (out of scope), and
//! the native agent's id has no `NULL` encoding (it would be an agent-identity
//! branch).
//!
//! # Lifecycle
//!
//! A session is active, settled (done for now, on the sidebar's Settled
//! shelf), pinned (kept at the top, never auto-settled) or snoozed (out of the
//! way until a time, or until it raises its hand). Every rule between those
//! states lives in [`ThreadMetadataStore`], under its write lock, so the host
//! and the UI cannot get them subtly different. There is no archived state:
//! settling replaced it (the `threads_lifecycle` migration moved every
//! archived row to Settled).
//!
//! # Testing
//!
//! The crate is Tauri-free and UI-framework-free on purpose. Its tests drive the public
//! API against a real temporary SQLite database, and assert persistence by
//! reopening the store — never by reading a row.

mod db;
mod error;
mod import;
mod model;
mod paths;
mod projects;
mod pull_requests;
mod recorder;
mod schema;
mod store;

pub use error::{Error, Result};
pub use import::{collect_all_sessions, importable_threads};
pub use model::{ThreadId, ThreadMetadata, DEFAULT_THREAD_TITLE};
pub use paths::{LengthMismatch, PathList, SerializedPathList, WorktreePaths};
pub use projects::{AttachSource, AttachedProject, ProjectAccess};
pub use pull_requests::{
    visible as visible_pull_requests, PullRequestLink, PullRequestLinkSource, PullRequestSnapshot,
    PullRequestWatch, WatchSync,
};
pub use recorder::{
    affects_thread_metadata, lifecycle_signal, LifecycleSignal, ThreadRecorder, ThreadSnapshot,
};
pub use schema::{LEGACY_MAX, SCHEMA_EPOCH};
pub use store::{
    LiveThreadUpdate, MarkUnread, ThreadMetadataStore, ThreadProject, ThreadStoreEvent,
};

/// Where the store lives: one file beside the rest of Atlas's app-level state.
///
/// App-level, not per-project: the sidebar groups threads across every
/// project the user has worked in, which a per-project database cannot answer
/// without opening N of them (ADR-0001).
pub fn db_path(app_config_dir: impl AsRef<std::path::Path>) -> std::path::PathBuf {
    app_config_dir.as_ref().join("threads.db")
}
