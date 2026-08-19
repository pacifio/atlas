//! Retrieval eval — the zero-download measurement rung.
//!
//! Runs the **lexical tier only** (FTS5/BM25 over AST chunks; no model
//! weights, no network) against hand-authored file-level labels: for each
//! query, did any expected file appear in the top-k results, and at what rank?
//! Reports hit@1, hit@k, and MRR.
//!
//! Labels are file-level on purpose — chunk-level ground truth would rot with
//! every refactor, while "this question is answered in this file" is stable.

use std::path::Path;

use anyhow::{Context, Result};
use serde::Deserialize;

/// One labelled query. `expected` is any-of: the query counts as hit when any
/// of these project-relative paths is retrieved.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Label {
    pub query: String,
    pub expected: Vec<String>,
    /// Optional rationale for the label (kept for the report, never matched).
    #[serde(default)]
    pub note: String,
}

/// Load labels from JSONL. Any malformed line fails the whole load — a silent
/// partial label set would misreport recall.
pub fn load_labels(path: &Path) -> Result<Vec<Label>> {
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("read labels {}", path.display()))?;
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let label: Label = serde_json::from_str(line)
            .with_context(|| format!("labels line {}: {line}", i + 1))?;
        if label.query.trim().is_empty() || label.expected.is_empty() {
            anyhow::bail!("labels line {}: empty query or expected", i + 1);
        }
        out.push(label);
    }
    if out.is_empty() {
        anyhow::bail!("no labels in {}", path.display());
    }
    Ok(out)
}

/// One query's outcome: the distinct files retrieved (in rank order) and the
/// rank (1-based) of the first expected file, if any.
#[derive(Debug, Clone)]
pub struct QueryOutcome {
    pub query: String,
    pub expected: Vec<String>,
    pub got: Vec<String>,
    pub first_hit_rank: Option<usize>,
}

#[derive(Debug, Clone)]
pub struct RetrievalReport {
    pub k: usize,
    pub chunks: u64,
    pub outcomes: Vec<QueryOutcome>,
}

impl RetrievalReport {
    pub fn hit_at_1(&self) -> f64 {
        self.frac(|r| r == 1)
    }
    pub fn hit_at_k(&self) -> f64 {
        self.frac(|r| r <= self.k)
    }
    /// Mean reciprocal rank (0 for a miss).
    pub fn mrr(&self) -> f64 {
        if self.outcomes.is_empty() {
            return 0.0;
        }
        self.outcomes
            .iter()
            .map(|o| o.first_hit_rank.map_or(0.0, |r| 1.0 / r as f64))
            .sum::<f64>()
            / self.outcomes.len() as f64
    }
    fn frac(&self, pred: impl Fn(usize) -> bool) -> f64 {
        if self.outcomes.is_empty() {
            return 0.0;
        }
        self.outcomes
            .iter()
            .filter(|o| o.first_hit_rank.is_some_and(&pred))
            .count() as f64
            / self.outcomes.len() as f64
    }
}

/// Build (incrementally) the project's lexical store and run every label
/// through it, lexical-only.
pub fn run(project: &Path, labels: &[Label], k: usize) -> Result<RetrievalReport> {
    let project_str = project.to_string_lossy().into_owned();
    let scanned = atlas_codeindex::scan(project, |p| {
        std::fs::metadata(p)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    });
    anyhow::ensure!(!scanned.is_empty(), "nothing to index under {project_str}");
    atlas_codeindex::lexical::build_lexical(&project_str, &scanned)?;
    let store = atlas_codeindex::lexical::LexicalStore::open(&project_str)?;
    let chunks = store.chunk_count()?;

    let mut outcomes = Vec::with_capacity(labels.len());
    for label in labels {
        // Over-fetch chunks, then collapse to distinct files in rank order.
        let hits = store.search(&label.query, k * 6)?;
        let mut got: Vec<String> = Vec::new();
        for h in hits {
            if !got.contains(&h.rel) {
                got.push(h.rel);
            }
            if got.len() >= k {
                break;
            }
        }
        let first_hit_rank = got
            .iter()
            .position(|rel| label.expected.iter().any(|e| e == rel))
            .map(|i| i + 1);
        outcomes.push(QueryOutcome {
            query: label.query.clone(),
            expected: label.expected.clone(),
            got,
            first_hit_rank,
        });
    }
    Ok(RetrievalReport { k, chunks, outcomes })
}

/// Human-readable report: aggregate line + a row per query, misses last.
pub fn render(report: &RetrievalReport) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "retrieval eval (lexical-only) — {} queries over {} chunks\n\
         hit@1 {:.0}%   hit@{} {:.0}%   MRR {:.2}\n\n",
        report.outcomes.len(),
        report.chunks,
        report.hit_at_1() * 100.0,
        report.k,
        report.hit_at_k() * 100.0,
        report.mrr(),
    ));
    let mut rows: Vec<&QueryOutcome> = report.outcomes.iter().collect();
    rows.sort_by_key(|o| o.first_hit_rank.unwrap_or(usize::MAX));
    for o in rows {
        match o.first_hit_rank {
            Some(rank) => out.push_str(&format!("  #{rank}  {}\n", o.query)),
            None => out.push_str(&format!(
                "  MISS {}\n       expected {:?}\n       got      {:?}\n",
                o.query, o.expected, o.got
            )),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "atlas-retrieval-eval-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn end_to_end_on_a_tiny_project() {
        let dir = scratch("e2e");
        std::fs::write(
            dir.join("auth.rs"),
            "pub fn verify_jwt_signature(token: &str) -> bool { !token.is_empty() }\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("render.rs"),
            "pub fn render_sidebar_widget() -> String { String::from(\"sidebar\") }\n",
        )
        .unwrap();
        let labels = vec![
            Label {
                query: "where do we verify jwt signatures".into(),
                expected: vec!["auth.rs".into()],
                note: String::new(),
            },
            Label {
                query: "sidebar widget rendering".into(),
                expected: vec!["render.rs".into()],
                note: String::new(),
            },
            Label {
                query: "database connection pooling".into(),
                expected: vec!["nowhere.rs".into()],
                note: String::new(),
            },
        ];
        let report = run(&dir, &labels, 5).unwrap();
        assert_eq!(report.outcomes.len(), 3);
        assert!(report.hit_at_k() >= 0.6, "{}", render(&report));
        assert!(report.outcomes[0].first_hit_rank.is_some());
        assert!(report.outcomes[2].first_hit_rank.is_none(), "unanswerable query must miss");
        let text = render(&report);
        assert!(text.contains("MISS"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn malformed_labels_fail_loudly() {
        let dir = scratch("labels");
        let path = dir.join("labels.jsonl");
        std::fs::write(&path, "{\"query\": \"x\", \"expected\": [\"a\"]}\n{\"bad\": true}\n").unwrap();
        assert!(load_labels(&path).is_err(), "unknown fields must fail the load");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
