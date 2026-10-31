//! The Atlas Security Agent's scanner (ATL-985).
//!
//! A Checkpoint's commit goes in; a risk-ordered map of the change and the
//! findings of the local rules come out. Everything here is Tauri-free and
//! synchronous except the advisory refresh, so the whole pipeline is tested
//! against real git repositories and real stores. See
//! `docs/superpowers/specs/2026-10-31-security-agent-design.md` (local only).

pub mod clef;
pub mod deps;
pub mod diff;
pub mod eval;
pub mod finding;
pub mod map;
pub mod provenance;
pub mod repo;
pub mod rules;
pub mod scan;
pub mod tags;
