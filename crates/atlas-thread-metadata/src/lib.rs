//! Atlas's session history: the app-owned thread-metadata store.
//!
//! # Why this crate exists
//!
//! Atlas's sidebar used to be built by reading each agent CLI's private
//! storage — Claude's project JSONL, Kilo's SQLite, Codex's state database —
//! merged with a live ACP `session/list` query. That coupled Atlas to formats
//! it does not own, needed a bespoke reader per agent (special treatment by
//! construction), and made history impossible for any agent nobody had written
//! a reader for. Zed, whose ACP stack Atlas is porting, never reads another
//! program's storage: it owns its history. So does Atlas now. See ADR-0001.
//!
//! # The shape
//!
//! A **thread** is one conversation as Atlas tracks it, keyed by an id Atlas
//! mints. It exists independently of any agent process: before its first
//! message it is a **draft** with no ACP session id at all, and it outlives an
//! agent forgetting the session afterwards.
//!
//! A row is **metadata only** — ids, agent, titles, timestamps, worktree paths,
//! archived flag. No message, no chunk, no tool call, no token. Replaying a
//! conversation is the agent's job, through `session/load`. This is the single
//! invariant the whole design rests on; anything that would put transcript
//! content in this crate is a design error, not a feature.
//!
//! Rows arrive from exactly two places: live conversation events
//! ([`ThreadMetadataStore::record_live_update`]) and ACP `session/list` import
//! ([`ThreadMetadataStore::save_all`]). Nothing else feeds it, and in
//! particular nothing reads anyone's files.
//!
//! # Provenance
//!
//! This is a port of Zed's `ThreadMetadataStore`
//! (`zed-ref/crates/agent_ui/src/thread_metadata_store.rs`), mechanism for
//! mechanism, with the Zed file:line cited at every ported decision.
//! Divergences are stated where they are made; there are three, all documented
//! at their site: no GPUI reactivity (a broadcast channel replaces `cx.notify`),
//! no `archived_git_worktrees` side tables (out of scope), and no `NULL`
//! encoding of the native agent's id (it would be an agent-identity branch).
//!
//! # Testing
//!
//! The crate is Tauri-free and GPUI-free on purpose. Its tests drive the public
//! API against a real temporary SQLite database, and assert persistence by
//! reopening the store — never by reading a row.

mod db;
mod error;
mod import;
mod model;
mod paths;
mod recorder;
mod schema;
mod store;

pub use error::{Error, Result};
pub use import::{collect_all_sessions, importable_threads};
pub use model::{ThreadFilter, ThreadId, ThreadMetadata, DEFAULT_THREAD_TITLE};
pub use paths::{LengthMismatch, PathList, SerializedPathList, WorktreePaths};
pub use recorder::{affects_thread_metadata, ThreadRecorder, ThreadSnapshot};
pub use schema::SCHEMA_VERSION;
pub use store::{LiveThreadUpdate, ThreadMetadataStore, ThreadProject, ThreadStoreEvent};

/// Where the store lives: one file beside the rest of Atlas's app-level state.
///
/// App-level, not per-workspace: the sidebar groups threads across every
/// project the user has worked in, which a per-workspace database cannot answer
/// without opening N of them (ADR-0001).
pub fn db_path(app_config_dir: impl AsRef<std::path::Path>) -> std::path::PathBuf {
    app_config_dir.as_ref().join("threads.db")
}
