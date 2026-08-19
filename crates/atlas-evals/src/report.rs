//! Aggregation and the `report` command's tables. Per-model (and
//! per-model-per-bucket) rows, with deltas against a pinned baseline sweep —
//! the numbers the roadmap's §4.6 gate table reads.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::results::RunRecord;

/// Aggregated metrics for one group of runs.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Aggregate {
    pub n: u64,
    pub passed: u64,
    pub ghosts: u64,
    pub errors: u64,
    pub edit_calls: u64,
    pub edit_not_found: u64,
    pub doom_loop_triggers: u64,
    pub compaction_events: u64,
    pub permission_asks: u64,
    pub retries: u64,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub cost: f64,
    pub wall_clock_ms: u64,
}

impl Aggregate {
    fn add(&mut self, r: &RunRecord) {
        self.n += 1;
        self.passed += u64::from(r.pass);
        self.ghosts += u64::from(r.ghost);
        self.errors += u64::from(r.error.is_some());
        self.edit_calls += r.edit_calls();
        self.edit_not_found += r.edit_not_found();
        self.doom_loop_triggers += r.doom_loop_triggers();
        self.compaction_events += r.compaction_events();
        self.permission_asks += r.permission_asks();
        self.retries += r.retries();
        self.tokens_in += r.tokens_in;
        self.tokens_out += r.tokens_out;
        self.cost += r.cost;
        self.wall_clock_ms += r.wall_clock_ms;
    }

    pub fn pass_rate(&self) -> f64 {
        ratio(self.passed, self.n)
    }

    pub fn ghost_rate(&self) -> f64 {
        ratio(self.ghosts, self.n)
    }

    /// The M6 gate's number: failed Edit resolutions over Edit calls.
    pub fn edit_fail_rate(&self) -> f64 {
        ratio(self.edit_not_found, self.edit_calls)
    }
}

fn ratio(num: u64, den: u64) -> f64 {
    if den == 0 {
        0.0
    } else {
        num as f64 / den as f64
    }
}

/// Group records per model, and per (model, bucket).
pub fn aggregate(
    records: &[RunRecord],
) -> (BTreeMap<String, Aggregate>, BTreeMap<(String, String), Aggregate>) {
    let mut by_model: BTreeMap<String, Aggregate> = BTreeMap::new();
    let mut by_model_bucket: BTreeMap<(String, String), Aggregate> = BTreeMap::new();
    for r in records {
        by_model.entry(r.model.clone()).or_default().add(r);
        by_model_bucket
            .entry((r.model.clone(), r.bucket.to_string()))
            .or_default()
            .add(r);
    }
    (by_model, by_model_bucket)
}

/// Render the report. With a baseline, each per-model row carries deltas on
/// the gate numbers (pass, ghost, edit-fail); models absent from the
/// baseline are marked new.
pub fn render(records: &[RunRecord], baseline: Option<&[RunRecord]>) -> String {
    let (by_model, by_bucket) = aggregate(records);
    let base_by_model = baseline.map(|b| aggregate(b).0);
    let mut out = String::new();

    out.push_str(&format!(
        "{:<32} {:>4} {:>6} {:>6} {:>9} {:>6} {:>10} {:>10} {:>8}\n",
        "model", "n", "pass%", "ghost%", "editfail%", "doom", "tokens_in", "tokens_out", "cost$"
    ));
    for (model, agg) in &by_model {
        out.push_str(&format!(
            "{:<32} {:>4} {:>6.1} {:>6.1} {:>9.1} {:>6} {:>10} {:>10} {:>8.2}",
            model,
            agg.n,
            agg.pass_rate() * 100.0,
            agg.ghost_rate() * 100.0,
            agg.edit_fail_rate() * 100.0,
            agg.doom_loop_triggers,
            agg.tokens_in,
            agg.tokens_out,
            agg.cost,
        ));
        if let Some(base) = &base_by_model {
            match base.get(model) {
                Some(b) => out.push_str(&format!(
                    "   Δpass {:+.1} Δghost {:+.1} Δeditfail {:+.1}",
                    (agg.pass_rate() - b.pass_rate()) * 100.0,
                    (agg.ghost_rate() - b.ghost_rate()) * 100.0,
                    (agg.edit_fail_rate() - b.edit_fail_rate()) * 100.0,
                )),
                None => out.push_str("   (not in baseline)"),
            }
        }
        out.push('\n');
    }

    out.push_str("\nper bucket:\n");
    for ((model, bucket), agg) in &by_bucket {
        out.push_str(&format!(
            "{:<32} {:<8} {:>4} {:>6.1} {:>6.1} {:>9.1}\n",
            model,
            bucket,
            agg.n,
            agg.pass_rate() * 100.0,
            agg.ghost_rate() * 100.0,
            agg.edit_fail_rate() * 100.0,
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::results::RunRecord;
    use crate::task::Bucket;

    fn rec(model: &str, bucket: Bucket, pass: bool, ghost: bool) -> RunRecord {
        crate::results::tests::record(model, bucket, pass, ghost)
    }

    #[test]
    fn aggregation_computes_the_three_gate_rates() {
        let records = vec![
            rec("m", Bucket::Edit, true, false),
            rec("m", Bucket::Edit, false, true),
            rec("m", Bucket::History, false, false),
            rec("m", Bucket::History, true, false),
        ];
        let (by_model, by_bucket) = aggregate(&records);
        let m = &by_model["m"];
        assert_eq!(m.n, 4);
        assert_eq!(m.pass_rate(), 0.5);
        assert_eq!(m.ghost_rate(), 0.25);
        // 4 runs × (1 not-found / 4 calls) from the stub turn.
        assert_eq!(m.edit_fail_rate(), 0.25);
        assert_eq!(by_bucket[&("m".to_string(), "edit".to_string())].n, 2);
    }

    #[test]
    fn an_empty_group_reports_zero_rates_rather_than_nan() {
        let agg = Aggregate::default();
        assert_eq!(agg.pass_rate(), 0.0);
        assert_eq!(agg.edit_fail_rate(), 0.0);
    }

    #[test]
    fn render_includes_deltas_against_a_baseline_and_marks_new_models() {
        let current = vec![
            rec("m1", Bucket::Edit, true, false),
            rec("m2", Bucket::Edit, true, false),
        ];
        let baseline = vec![rec("m1", Bucket::Edit, false, true)];
        let out = render(&current, Some(&baseline));
        assert!(out.contains("Δpass +100.0"), "{out}");
        assert!(out.contains("(not in baseline)"), "{out}");
    }
}
