//! Mission Control dashboard aggregator — one orchestrating command that folds
//! per-project usage across ALL tracked projects into the compact shape the
//! dashboard needs (stat-card totals + a daily time-series + per-project
//! metrics for charts/gantt). All the folding stays in Rust so the frontend
//! never ships megabytes of history.
//!
//! Data sources (honest about granularity):
//!  - Agents: **every** agent that ran through Atlas, from Atlas's own record
//!    (`commands::usage`) — input/output/cache tokens, turns, and cost from the
//!    cached models.dev prices. Bucketed by the day a session was last active,
//!    because the record keeps one token total per session rather than per
//!    message. Was Claude-only, scraped out of `~/.claude/projects` JSONL and
//!    priced from a table in the source, until ADR-0001 / issue #17.
//!  - BYOK: appended to `byok-usage.jsonl` going forward (see modelchat.rs).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use super::usage;

// ── Wire shapes (camelCase to the frontend) ───────────────────────────────

/// What Atlas's agents cost in one project — every agent, folded together.
///
/// One bucket rather than one per agent: which agent ran a session is data on
/// the session, and a dashboard that grew a column per agent would need Atlas
/// code for each new one.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentMetrics {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    /// Recorded messages — user and assistant rows in Atlas's own record.
    pub messages: u64,
    pub cost_usd: f64,
    pub sessions: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMetrics {
    pub project_path: String,
    pub project_name: String,
    pub agents: AgentMetrics,
    pub first_activity_ms: Option<i64>,
    pub last_activity_ms: Option<i64>,
    /// agents(in+out) — drives the consumption pie.
    pub total_tokens: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyBucket {
    pub date: String, // local "YYYY-MM-DD"
    pub project_path: String,
    pub agent_input: u64,
    pub agent_output: u64,
    pub agent_cost: f64,
    pub agent_messages: u64,
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
    pub agent_input: u64,
    pub agent_output: u64,
    pub agent_cache: u64,
    pub agent_cost: f64,
    pub agent_messages: u64,
    pub agent_sessions: u64,
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
    let byok_path = byok_usage_path(&app);

    tokio::task::spawn_blocking(move || {
        let prices = usage::read_prices(&app);
        let mut projects: Vec<ProjectMetrics> = Vec::new();
        let mut daily: Vec<DailyBucket> = Vec::new();
        let mut totals = GrandTotals::default();

        for path in project_paths.iter() {
            let name = usage::project_name(path);
            // One read per project, covering every agent that ran there. A
            // project whose store is missing or unreadable contributes nothing
            // and must not blank the other projects' figures.
            let recorded = usage::project_usage(path, &prices).unwrap_or_default();

            // Per-day map for this project.
            let mut days: BTreeMap<String, usage::DayUsage> = BTreeMap::new();
            for (date, day) in usage::day_buckets(&recorded.sessions) {
                days.insert(date, day);
            }
            // Both ends of the span: when the earliest session started, and
            // when the latest one last did work. Deriving both from the same
            // timestamp would collapse every project's Gantt bar to a point.
            let (mut agents_first, mut agents_last): (Option<i64>, Option<i64>) = (None, None);
            for session in &recorded.sessions {
                let started = session.started_ms;
                agents_first = Some(agents_first.map_or(started, |f: i64| f.min(started)));
                let last = session.last_activity_ms.unwrap_or(started);
                agents_last = Some(agents_last.map_or(last, |l: i64| l.max(last)));
            }
            // Emit this project's day buckets.
            for (date, d) in days {
                daily.push(DailyBucket {
                    date,
                    project_path: path.clone(),
                    agent_input: d.input_tokens,
                    agent_output: d.output_tokens,
                    agent_cost: d.cost_usd,
                    agent_messages: d.messages,
                });
            }

            let agents = AgentMetrics {
                input_tokens: recorded.totals.input_tokens,
                output_tokens: recorded.totals.output_tokens,
                cache_creation_tokens: recorded.totals.cache_creation_tokens,
                cache_read_tokens: recorded.totals.cache_read_tokens,
                messages: recorded.totals.messages,
                cost_usd: recorded.totals.total_cost_usd,
                sessions: recorded.totals.session_count,
            };
            let first_activity_ms = agents_first;
            let last_activity_ms = agents_last;
            let total_tokens = agents.input_tokens + agents.output_tokens;

            // Grand totals.
            totals.agent_input += agents.input_tokens;
            totals.agent_output += agents.output_tokens;
            totals.agent_cache += agents.cache_creation_tokens + agents.cache_read_tokens;
            totals.agent_cost += agents.cost_usd;
            totals.agent_messages += agents.messages;
            totals.agent_sessions += agents.sessions;
            totals.total_tokens += total_tokens;
            totals.total_cost_usd += agents.cost_usd;

            projects.push(ProjectMetrics {
                project_path: path.clone(),
                project_name: name,
                agents,
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
    crate::commands::save_guard::guard_save_dest(&target_path)?;
    tokio::task::spawn_blocking(move || std::fs::write(&target_path, bytes).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}
