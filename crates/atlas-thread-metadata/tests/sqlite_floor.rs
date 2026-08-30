//! The bundled SQLite must be new enough for the ported engine's state layer.
//!
//! Codex's `state` crate carries a compile-time assert pinning bundled SQLite
//! to **≥ 3.51.3**, citing the WAL-reset corruption fix (`codex-rs/state/
//! src/lib.rs:7-10`, recorded in `docs/research/codex-fork-seam.md` §5.2).
//! When the fork lands in-tree (#42) it and Atlas must share **one**
//! `libsqlite3-sys` — `links = "sqlite3"` allows no second one, and both sides
//! bundle vendored SQLite, so even two copies cargo tolerated would collide on
//! duplicate `sqlite3_*` symbols (integration §6, BLOCKER A).
//!
//! # Why this assertion lives here, and why it is only written once
//!
//! Three Atlas crates reach SQLite through `rusqlite` with `bundled`
//! (`atlas-thread-metadata`, `atlas-checkpoint`, `src-tauri`). Since the repo
//! became one cargo workspace (#38) they resolve a single `libsqlite3-sys`, so
//! the version any one of them links is the version all of them link — one
//! assertion covers the workspace. It sits in the app-owned thread-metadata
//! store (ADR-0001) because that is the crate whose data loss the corruption
//! fix would actually be about.
//!
//! This runs against the linked library rather than the lockfile, so it cannot
//! be satisfied by a manifest edit that fails to take effect.
//! `tests/cargo-deps-unification.test.ts` guards the resolution side.
//!
//! Issue #39, spec `docs/atlas-agent-codex-port-spec.md` D4 / Phase 0,
//! open question 6.

/// `3.51.3` in SQLite's `SQLITE_VERSION_NUMBER` encoding: `major*1_000_000 +
/// minor*1_000 + patch`.
const ENGINE_FLOOR: i32 = 3_051_003;

#[test]
fn bundled_sqlite_meets_the_engine_floor() {
    let linked = rusqlite::version_number();
    assert!(
        linked >= ENGINE_FLOOR,
        "bundled SQLite is {} ({}), below the ported engine's ≥ 3.51.3 floor \
         ({ENGINE_FLOOR}). Bump `rusqlite` in the three manifests that declare \
         it; see #39.",
        rusqlite::version(),
        linked,
    );
}
