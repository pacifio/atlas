//! Git execution layer for Atlas.
//!
//! Everything shells out to the REAL git binary — never libgit2 — so the
//! user's hooks, config, credential helpers and LFS filters all behave
//! exactly as they do in a terminal. The modules here are pure (no Tauri,
//! no tokio) so `cargo test -p atlas-git` covers the parsing-heavy parts:
//!
//! - [`exec`]   — the single spawn chokepoint (`GitCommand`), buffered and
//!               streaming variants, ported from GitHub Desktop's `git()`.
//! - [`error`]  — stderr → [`error::GitErrorCode`] taxonomy + friendly
//!               messages (ported from dugite / Desktop's
//!               `getDescriptionForError`).
//! - [`status`] — `git status --porcelain=2 -z` parser (branch header,
//!               ahead/behind, renames, submodule codes, conflicts).

pub mod conflicts;
pub mod error;
pub mod exec;
pub mod patch;
pub mod progress;
pub mod status;

pub use error::{GitErrorCode, GitErrorPayload};
pub use exec::{GitCommand, GitOutput, OpSink, Stream};
