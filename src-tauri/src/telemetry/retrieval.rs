//! One structured line per retrieval call — the `atlas::retrieval` telemetry
//! discipline (master plan §2) — plus the PostHog `retrieval_invoked` counter.
//! Shape of usage only: bucketed counts and the fixed path *name* (never a
//! filesystem path), no query text — the push path already redacts for a
//! reason.

use std::sync::Arc;

use tauri::Manager;

use super::TelemetryClient;

/// Record one retrieval invocation.
///
/// `path` is one of the four fixed retrieval paths (`memory_retrieve` |
/// `memory_chat` | `memory_index_query` | `codebase_status`); `invoked_by` is
/// `push` | `tool` | `ui`. `skipped` names an early-return guard when the
/// call never reached a query — a skip is a data point, not a zero-result
/// (no silent drops).
#[allow(clippy::too_many_arguments)]
pub fn record(
    app: &tauri::AppHandle,
    path: &'static str,
    corpus_size: u64,
    n_results: u64,
    top_score: Option<f32>,
    latency_ms: u64,
    invoked_by: &'static str,
    skipped: Option<&'static str>,
) {
    tracing::info!(
        target: "atlas::retrieval",
        path,
        corpus_size,
        n_results,
        top_score = ?top_score,
        latency_ms,
        invoked_by,
        skipped = ?skipped,
        "retrieval"
    );
    if let Some(client) = app.try_state::<Arc<TelemetryClient>>() {
        client.capture(
            "retrieval_invoked",
            serde_json::json!({
                "path": path,
                "invoked_by": invoked_by,
                "n_results_bucket": bucket(n_results),
            }),
        );
    }
}

fn bucket(n: u64) -> &'static str {
    match n {
        0 => "0",
        1..=3 => "1-3",
        4..=10 => "4-10",
        _ => "11+",
    }
}
