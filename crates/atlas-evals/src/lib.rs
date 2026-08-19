//! M0 — the eval harness (`plans/cersei-harness-roadmap.md` §4.3, sequenced
//! by `plans/atlas-master-plan.md` Phase 1).
//!
//! Runs the native Cersei agent headlessly against a task suite and turns
//! every subsequent harness milestone from an argument into a measurement.
//! Three parts:
//!
//! - **Runner** — drives [`atlas_cersei::CerseiRuntime`] *in-process*, one
//!   git worktree per run, bypass-mode permissions inside the normal sandbox
//!   tier. The roadmap said "over ACP", but no ACP server exists for the
//!   native agent — `atlas-cersei` is an in-process runtime with an
//!   ACP-shaped API. Driving it directly is the same code path the app
//!   ships, with zero new protocol code (deviation recorded in
//!   `plans/atlas-master-plan.md` §6).
//! - **Metrics** — consumed from the `atlas::harness` tracing line the
//!   product already emits (decision 6: one telemetry schema, shared by
//!   product and evals), captured by a [`tracing_subscriber`] layer.
//! - **Harvest** (contract C4) — one session-log parser over Claude Code
//!   JSONL and Cersei session stores, producing harness baseline metrics
//!   and retrieval query/label candidates. Neither workstream writes its
//!   own.
//!
//! Data layout (repo root): tasks under `evals/tasks/<bucket>/<id>/`,
//! suites under `evals/suites/`, run output under `evals/runs/` and harvest
//! output under `evals/harvest/` (both gitignored — they carry real prompt
//! and command content that must stay local).

pub mod capture;
pub mod harvest;
pub mod report;
pub mod results;
pub mod runner;
pub mod task;
pub mod verify;
pub mod workspace;

pub use capture::{HarnessCapture, HarnessTurn};
pub use results::RunRecord;
pub use task::{Bucket, Task};
