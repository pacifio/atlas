//! Sparse n-gram prefilter for `atlas_search::grep` (Phase 5).
//!
//! A [`GrepIndex`] keeps a base snapshot of the git HEAD tree on disk
//! (`<root>/.atlas/code-index/grep/<tree-oid>/`) plus an in-memory overlay of files that differ
//! from it, and implements [`atlas_search::CandidateSource`]: for a pattern it returns the files
//! that may match, `grep` skips the rest unread, and every kept file is verified by the real
//! matcher. See `docs/research/codeindex-search/04-indexed-regex-search.md` §6.

mod build;
mod doc;
mod error;
mod exec;
mod format;
mod git;
pub mod gram;
mod index;
mod overlay;
pub mod plan;
mod varint;

pub use error::Error;
pub use index::{worktree_root, BuildOutcome, GrepIndex, HeadAction, IndexOptions, IndexStatus};
pub use plan::{plan_pattern, Query};
