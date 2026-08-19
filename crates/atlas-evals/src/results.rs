//! Run records — one JSONL line per (task, model, run). Append-only under
//! `evals/runs/<sweep>/results.jsonl` next to a `meta.json` describing the
//! sweep, so a killed sweep keeps everything it already measured.

use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::capture::HarnessTurn;
use crate::task::Bucket;

/// One completed (or failed) run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunRecord {
    pub sweep: String,
    pub task_id: String,
    pub bucket: Bucket,
    pub model: String,
    pub run_idx: u32,
    pub started_at: String,
    pub wall_clock_ms: u64,
    /// Stop reason from the final turn ("end_turn", "cancelled", …), absent
    /// when the run errored before producing one.
    pub stop: Option<String>,
    /// Infrastructure or provider error, if the run never finished cleanly.
    pub error: Option<String>,
    pub pass: bool,
    /// A "ghost run": the agent finished normally, but the
    /// verifier says the task is not done.
    pub ghost: bool,
    pub verify_exit: Option<i32>,
    pub verify_detail: String,
    /// Per-turn `atlas::harness` lines the run emitted (steering follow-ups
    /// make this >1).
    pub turns: Vec<HarnessTurn>,
    /// Cumulative provider-reported usage for the run's session.
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub cost: f64,
}

impl RunRecord {
    /// The ghost classification: a normal finish that failed verification.
    /// Errors and cancellations are failures but not ghosts — the agent
    /// never claimed to be done.
    pub fn classify_ghost(pass: bool, stop: Option<&str>, error: Option<&str>) -> bool {
        !pass && error.is_none() && stop == Some("end_turn")
    }

    pub fn edit_calls(&self) -> u64 {
        self.turns.iter().map(|t| t.edit_calls).sum()
    }

    pub fn edit_not_found(&self) -> u64 {
        self.turns.iter().map(|t| t.edit_not_found).sum()
    }

    /// Edit operations that only landed via a fallback ladder strategy
    /// (`edit_strategy_used` is a comma-joined list, one entry per
    /// non-exact-match operation).
    pub fn edit_fallbacks(&self) -> u64 {
        self.turns
            .iter()
            .filter(|t| !t.edit_strategy_used.is_empty())
            .map(|t| t.edit_strategy_used.split(',').count() as u64)
            .sum()
    }

    pub fn doom_loop_triggers(&self) -> u64 {
        self.turns.iter().map(|t| t.doom_loop_triggers).sum()
    }

    pub fn compaction_events(&self) -> u64 {
        self.turns.iter().map(|t| t.compaction_events).sum()
    }

    pub fn permission_asks(&self) -> u64 {
        self.turns.iter().map(|t| t.permission_asks).sum()
    }

    pub fn retries(&self) -> u64 {
        self.turns.iter().map(|t| t.retries).sum()
    }
}

/// Append one record to the sweep's JSONL file.
pub fn append(path: &Path, record: &RunRecord) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let line = serde_json::to_string(record).map_err(|e| format!("serialize record: {e}"))?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    writeln!(f, "{line}").map_err(|e| format!("write record: {e}"))
}

/// Load a results file. Corrupt lines are counted, not silently skipped.
pub fn load(path: &Path) -> Result<(Vec<RunRecord>, u64), String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut records = Vec::new();
    let mut corrupt = 0u64;
    for line in raw.lines().filter(|l| !l.trim().is_empty()) {
        match serde_json::from_str::<RunRecord>(line) {
            Ok(r) => records.push(r),
            Err(_) => corrupt += 1,
        }
    }
    Ok((records, corrupt))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn record(model: &str, bucket: Bucket, pass: bool, ghost: bool) -> RunRecord {
        RunRecord {
            sweep: "s1".into(),
            task_id: "t1".into(),
            bucket,
            model: model.into(),
            run_idx: 0,
            started_at: "2026-08-19T00:00:00Z".into(),
            wall_clock_ms: 1000,
            stop: Some("end_turn".into()),
            error: None,
            pass,
            ghost,
            verify_exit: Some(if pass { 0 } else { 1 }),
            verify_detail: String::new(),
            turns: vec![HarnessTurn { edit_calls: 4, edit_not_found: 1, tokens_in: 100, tokens_out: 10, ..Default::default() }],
            tokens_in: 100,
            tokens_out: 10,
            cost: 0.05,
        }
    }

    #[test]
    fn ghost_is_a_normal_finish_that_failed_verification() {
        assert!(RunRecord::classify_ghost(false, Some("end_turn"), None));
        assert!(!RunRecord::classify_ghost(true, Some("end_turn"), None));
        assert!(!RunRecord::classify_ghost(false, Some("cancelled"), None));
        assert!(!RunRecord::classify_ghost(false, Some("end_turn"), Some("HTTP 500")));
        assert!(!RunRecord::classify_ghost(false, None, None));
    }

    #[test]
    fn records_round_trip_through_jsonl_and_corrupt_lines_are_counted() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("runs/s1/results.jsonl");
        append(&path, &record("m1", Bucket::Edit, true, false)).unwrap();
        append(&path, &record("m2", Bucket::History, false, true)).unwrap();

        // A half-written line (killed sweep) must not poison the rest.
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .and_then(|mut f| writeln!(f, "{{\"sweep\": tru"))
            .unwrap();

        let (records, corrupt) = load(&path).unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(corrupt, 1);
        assert_eq!(records[1].model, "m2");
        assert!(records[1].ghost);
        assert_eq!(records[0].edit_not_found(), 1);
    }
}
