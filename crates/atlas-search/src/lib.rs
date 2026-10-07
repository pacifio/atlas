//! In-process code search for Atlas: the ripgrep engine (`grep-searcher` +
//! `grep-regex` + `ignore`) for `grep`, globs and fuzzy matching for
//! `find_files`, and one compact, byte-budgeted output format for the
//! `atlas_code` tool server (docs/research/codeindex-search/05-rust-grep-stack.md).
//!
//! - **Bounded by construction.** Nothing outside the session root is read
//!   (paths are canonicalized, symlinks are not followed), secret files are
//!   hidden unless targeted explicitly, binary files are skipped, lines are
//!   clipped, and a search stops at its deadline or after 10,000 matches.
//! - **Fresh by construction.** Every call reads the working tree as it is
//!   now; there is no index to go stale.
//! - **Deterministic.** Results are collected from a parallel walk, then
//!   sorted with a total order (newest-modified first, then path).
//! - **Never memory-mapped.** A file truncated by an agent while mapped would
//!   SIGBUS the whole app (`MmapChoice::never()`).

pub mod compact;
pub mod format;

mod cancel;
mod candidates;
mod error;
mod find;
mod grep;
mod walk;

pub use cancel::CancelToken;
pub use candidates::{CandidateFilter, CandidateSource, FileStamp};
pub use error::SearchError;
pub use find::{find_files, FindMode, FindRequest, FindResult};
pub use grep::{grep, FileHit, GrepRequest, GrepResult, LineHit, OutputMode};
pub use walk::{is_atlas_dir, DEFAULT_DENY_GLOBS};

/// The default output budget of one tool reply, in bytes (about 4k tokens).
pub const DEFAULT_BUDGET_BYTES: usize = 16 * 1024;

/// Phase 2 implements this for grep hit annotation ("fn foo (12 callers)").
pub trait SymbolLocator: Send + Sync {
    fn enclosing(&self, rel_path: &str, line: u32) -> Option<EnclosingSymbol>;
}

/// The symbol a grep hit sits inside, as a [`SymbolLocator`] reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnclosingSymbol {
    pub qualified_name: String,
    /// "fn" | "method" | "struct" | "class" | ...
    pub kind: String,
    pub start_line: u32,
    pub end_line: u32,
    /// 0 until Phase 3 fills refs.
    pub callers: u32,
}
