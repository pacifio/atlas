//! Mission Control dashboard aggregator — one orchestrating command that folds
//! per-project usage across ALL tracked projects into the compact shape the
//! dashboard needs (stat-card totals + a daily time-series + per-project
//! metrics for charts/gantt). All heavy JSONL/sqlite parsing stays in Rust so
//! the frontend never ships megabytes of transcripts.
//!
//! Data sources (honest about granularity):
//!  - Claude: rich (input/output/cache, real cost, per-message day series).
//!  - Codex: total tokens only (no in/out, no cost) attributed to a thread's day.
//!  - BYOK: appended to `byok-usage.jsonl` going forward (see modelchat.rs).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use super::agent_memory::collect_codex_sessions;
use super::claude;

// ── Wire shapes (camelCase to the frontend) ───────────────────────────────

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeMetrics {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub requests: u64,
    pub cost_usd: f64,
    pub sessions: u64,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexMetrics {
    pub tokens: i64,
    pub sessions: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMetrics {
    pub project_path: String,
    pub project_name: String,
    pub claude: ClaudeMetrics,
    pub codex: CodexMetrics,
    pub first_activity_ms: Option<i64>,
    pub last_activity_ms: Option<i64>,
    /// claude(in+out) + codex — drives the consumption pie.
    pub total_tokens: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyBucket {
    pub date: String, // local "YYYY-MM-DD"
    pub project_path: String,
    pub claude_input: u64,
    pub claude_output: u64,
    pub claude_cost: f64,
    pub claude_requests: u64,
    pub codex_tokens: u64,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ByokDay {
    pub date: String,
    pub input: u64,
    pub output: u64,
    pub cost: f64,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GrandTotals {
    pub claude_input: u64,
    pub claude_output: u64,
    pub claude_cache: u64,
    pub claude_cost: f64,
    pub claude_requests: u64,
    pub claude_sessions: u64,
    pub codex_tokens: i64,
    pub codex_sessions: u32,
    pub byok_input: u64,
    pub byok_output: u64,
    pub byok_cost: f64,
    pub byok_requests: u64,
    pub total_tokens: u64,
    pub total_cost_usd: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionControlUsage {
    pub projects: Vec<ProjectMetrics>,
    pub daily: Vec<DailyBucket>,
    pub byok_daily: Vec<ByokDay>,
    pub totals: GrandTotals,
    pub byok_since: Option<String>,
    pub generated_at: String,
}

// ── Per-project day accumulator (claude + codex on one date) ───────────────

#[derive(Default)]
struct DayAll {
    c_in: u64,
    c_out: u64,
    c_cost: f64,
    c_req: u64,
    codex: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ByokUsageEntry {
    ts: String,
    #[allow(dead_code)]
    provider: Option<String>,
    #[allow(dead_code)]
    model: Option<String>,
    input_tokens: u64,
    output_tokens: u64,
    cost_usd: Option<f64>,
}

/// `<app_config_dir>/byok-usage.jsonl` — shared with modelchat.rs (writer).
pub(crate) fn byok_usage_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("byok-usage.jsonl"))
}

fn ms_local_day(ms: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
        .map(|dt| dt.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

fn iso_local_day(s: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string())
}

#[tauri::command]
pub async fn mission_control_usage(
    app: AppHandle,
    project_paths: Vec<String>,
) -> Result<MissionControlUsage, String> {
    // Codex is async (sqlite3 shell-out) — gather per project up front.
    let mut codex_by_project: Vec<Vec<super::agent_memory::CodexSession>> = Vec::new();
    for p in &project_paths {
        codex_by_project.push(collect_codex_sessions(p).await);
    }

    let byok_path = byok_usage_path(&app);

    tokio::task::spawn_blocking(move || {
        let mut projects: Vec<ProjectMetrics> = Vec::new();
        let mut daily: Vec<DailyBucket> = Vec::new();
        let mut totals = GrandTotals::default();

        for (i, path) in project_paths.iter().enumerate() {
            let name = path.rsplit('/').find(|s| !s.is_empty()).unwrap_or(path).to_string();
            let cagg = claude::claude_project_agg(path);
            let codex_sessions = &codex_by_project[i];

            // Per-day map combining both sources for this project.
            let mut days: BTreeMap<String, DayAll> = BTreeMap::new();
            for (date, d) in &cagg.days {
                let e = days.entry(date.clone()).or_default();
                e.c_in += d.input;
                e.c_out += d.output;
                e.c_cost += d.cost;
                e.c_req += d.requests;
            }
            // Codex — attribute the whole thread total to its updated day.
            let mut codex_tokens_total: i64 = 0;
            let (mut codex_first, mut codex_last): (Option<i64>, Option<i64>) = (None, None);
            for s in codex_sessions {
                codex_tokens_total += s.tokens;
                codex_first = Some(codex_first.map_or(s.created_at_ms, |f: i64| f.min(s.created_at_ms)));
                codex_last = Some(codex_last.map_or(s.updated_at_ms, |l: i64| l.max(s.updated_at_ms)));
                if s.tokens > 0 {
                    days.entry(ms_local_day(s.updated_at_ms)).or_default().codex += s.tokens as u64;
                }
            }

            // Emit this project's day buckets.
            for (date, d) in days {
                daily.push(DailyBucket {
                    date,
                    project_path: path.clone(),
                    claude_input: d.c_in,
                    claude_output: d.c_out,
                    claude_cost: d.c_cost,
                    claude_requests: d.c_req,
                    codex_tokens: d.codex,
                });
            }

            let claude = ClaudeMetrics {
                input_tokens: cagg.totals.input_tokens,
                output_tokens: cagg.totals.output_tokens,
                cache_creation_tokens: cagg.totals.cache_creation_tokens,
                cache_read_tokens: cagg.totals.cache_read_tokens,
                requests: cagg.totals.request_count,
                cost_usd: cagg.totals.total_cost_usd,
                sessions: cagg.totals.session_count,
            };
            let codex = CodexMetrics {
                tokens: codex_tokens_total,
                sessions: codex_sessions.len() as u32,
            };
            let first_activity_ms = [cagg.first_ms, codex_first]
                .into_iter()
                .flatten()
                .min();
            let last_activity_ms = [cagg.last_ms, codex_last]
                .into_iter()
                .flatten()
                .max();
            let total_tokens = claude.input_tokens
                + claude.output_tokens
                + codex.tokens.max(0) as u64;

            // Grand totals.
            totals.claude_input += claude.input_tokens;
            totals.claude_output += claude.output_tokens;
            totals.claude_cache += claude.cache_creation_tokens + claude.cache_read_tokens;
            totals.claude_cost += claude.cost_usd;
            totals.claude_requests += claude.requests;
            totals.claude_sessions += claude.sessions;
            totals.codex_tokens += codex.tokens;
            totals.codex_sessions += codex.sessions;
            totals.total_tokens += total_tokens;
            totals.total_cost_usd += claude.cost_usd;

            projects.push(ProjectMetrics {
                project_path: path.clone(),
                project_name: name,
                claude,
                codex,
                first_activity_ms,
                last_activity_ms,
                total_tokens,
            });
        }

        // BYOK history (accrues going forward; empty for old sessions).
        let mut byok_days: BTreeMap<String, ByokDay> = BTreeMap::new();
        let mut byok_since: Option<String> = None;
        if let Some(p) = byok_path {
            if let Ok(raw) = std::fs::read_to_string(&p) {
                for line in raw.lines() {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    let Ok(e) = serde_json::from_str::<ByokUsageEntry>(line) else {
                        continue;
                    };
                    totals.byok_input += e.input_tokens;
                    totals.byok_output += e.output_tokens;
                    totals.byok_cost += e.cost_usd.unwrap_or(0.0);
                    totals.byok_requests += 1;
                    totals.total_tokens += e.input_tokens + e.output_tokens;
                    totals.total_cost_usd += e.cost_usd.unwrap_or(0.0);
                    if byok_since.is_none() {
                        byok_since = Some(e.ts.clone());
                    }
                    if let Some(day) = iso_local_day(&e.ts) {
                        let d = byok_days.entry(day.clone()).or_insert(ByokDay {
                            date: day,
                            ..Default::default()
                        });
                        d.input += e.input_tokens;
                        d.output += e.output_tokens;
                        d.cost += e.cost_usd.unwrap_or(0.0);
                    }
                }
            }
        }

        daily.sort_by(|a, b| a.date.cmp(&b.date));
        let byok_daily: Vec<ByokDay> = byok_days.into_values().collect();

        Ok(MissionControlUsage {
            projects,
            daily,
            byok_daily,
            totals,
            byok_since,
            generated_at: chrono::Local::now().to_rfc3339(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Export writers (no JS fs plugin; mirror knowledge_export.rs) ───────────

#[tauri::command]
pub async fn mission_control_export_markdown(
    target_path: String,
    markdown: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || std::fs::write(&target_path, markdown).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mission_control_write_file(target_path: String, bytes: Vec<u8>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || std::fs::write(&target_path, bytes).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}
