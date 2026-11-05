//! The bundled SQLite must be new enough for the engine's state layer.
//!
//! The engine's `atlas-engine-state` crate pins bundled SQLite to **≥ 3.51.3** with a
//! compile-time assert (`vendor/atlas-engine/state/src/lib.rs:7`), citing the
//! WAL-reset corruption fix. The engine is in-tree now (ADR-0003), so it and
//! Atlas share **one** `libsqlite3-sys`: `links = "sqlite3"` allows no second
//! one, and both sides bundle vendored SQLite, so even two copies cargo
//! tolerated would collide on duplicate `sqlite3_*` symbols.
//!
//! # Why this assertion lives here, and why it is only written once
//!
//! Four Atlas crates reach SQLite through `rusqlite` with `bundled`
//! (`atlas-thread-metadata`, `atlas-checkpoint`, `atlas-comms`, `src-tauri`),
//! and the engine reaches the same library through `libsqlite3-sys` directly.
//! The workspace resolves a single `libsqlite3-sys`, so the version any one of
//! them links is the version all of them link — one assertion covers the
//! workspace. It sits in the app-owned thread-metadata store (ADR-0001)
//! because that is the crate whose data loss the corruption fix would
//! actually be about.
//!
//! The engine's own compile-time assert already fails the build of any graph
//! that includes `atlas-engine-state`. This test is the runtime check against the
//! linked library, for the Atlas crates, and it cannot be satisfied by a
//! manifest edit that fails to take effect. `tests/cargo-workspace.test.ts`
//! guards the resolution side (one `rusqlite` requirement across every
//! manifest).
//!
//! Issue #39, spec `docs/archive/atlas-agent-codex-port-spec.md` D4 / Phase 0,
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
         ({ENGINE_FLOOR}). Bump `rusqlite` in the four manifests that declare \
         it; see #39.",
        rusqlite::version(),
        linked,
    );
}
