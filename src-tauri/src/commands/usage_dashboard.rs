//! The Usage dashboard (Console → Usage): one command that folds every
//! tracked project's record into the rows the dashboard renders.
//!
//! # Where the numbers come from
//!
//! * **Agents** — every agent that ran through Atlas, from Atlas's own record
//!   (`commands::usage`, the checkpoint store): tokens, messages, and cost from
//!   the cached models.dev prices.
//! * **BYOK** — the direct-to-provider Chat tab, appended to
//!   `byok-usage.jsonl` by `modelchat.rs`.
//!
//! # How a session is dated
//!
//! The store keeps one cumulative token total per session AND, since schema
//! 10, a per-turn ledger of what each turn added (`usage_delta`). A session
//! with ledger rows is spread across the days its turns actually ran, one
//! bucket per (day, project, agent, model) — a model switch mid-conversation
//! lands each side on its own model. Whatever the stored total carries beyond
//! the ledger (usage recorded before the ledger existed, or an importer's
//! figure) is the *remainder*, and lands on the day the session was last
//! active, as every session did before the ledger. Messages are dated by the
//! turn they belong to.
//!
//! # One fold, four rollups
//!
//! `daily` is the only thing computed from the record. `projects`, `agents`,
//! `models` and `totals` are folded FROM `daily`, so the frontend can re-fold
//! the same rows after filtering by range or facet and get numbers that agree
//! with the unfiltered view — no refetch. The `sessions` count in every
//! rollup is distinct session ids, tracked per bucket until the rollups are
//! built.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;

use atlas_checkpoint::TokenTotals;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::models_pricing::ModelPrice;
use super::usage::{self, ProjectRecord};

/// Most-recent-first session rows are truncated to this many on the wire.
pub const SESSION_ROW_CAP: usize = 2000;
/// The pseudo project path BYOK rows are filed under.
pub const BYOK_PROJECT_PATH: &str = "byok";
/// The label for a missing agent or model.
pub const UNKNOWN: &str = "unknown";

// ── Wire shapes (camelCase; mirrored in src/features/usage/types.ts) ─────

/// The token/cost block every rollup shares.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    /// Informational: rides inside `output` for every provider that reports
    /// it. Never priced, never added to a total.
    pub reasoning: u64,
    pub cost: f64,
    pub messages: u64,
    /// Distinct sessions in this bucket.
    pub sessions: u64,
}

impl Metrics {
    fn add_split(&mut self, split: [u64; 5]) {
        self.input += split[0];
        self.output += split[1];
        self.cache_write += split[2];
        self.cache_read += split[3];
        self.reasoning += split[4];
    }

    /// Everything but `sessions`, which is a distinct count and cannot be
    /// summed.
    fn absorb(&mut self, other: &Metrics) {
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_write += other.cache_write;
        self.reasoning += other.reasoning;
        self.cost += other.cost;
        self.messages += other.messages;
    }

    fn tokens(&self) -> u64 {
        self.input + self.output + self.cache_read + self.cache_write
    }
}

/// One local day × project × agent × model.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyBucket {
    /// Local `YYYY-MM-DD`.
    pub date: String,
    pub project_path: String,
    pub agent: String,
    pub model: String,
    #[serde(flatten)]
    pub metrics: Metrics,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMetrics {
    pub project_path: String,
    pub project_name: String,
    pub first_activity_ms: Option<i64>,
    pub last_activity_ms: Option<i64>,
    #[serde(flatten)]
    pub metrics: Metrics,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMetrics {
    pub agent: String,
    #[serde(flatten)]
    pub metrics: Metrics,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelMetrics {
    pub model: String,
    #[serde(flatten)]
    pub metrics: Metrics,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    /// The agent's own id for the conversation.
    pub session_id: String,
    pub project_path: String,
    pub agent: String,
    pub model: String,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub reasoning: u64,
    pub messages: u64,
    pub cost: f64,
    pub started_ms: i64,
    pub last_activity_ms: Option<i64>,
    pub title: String,
    /// Day attribution came from the per-turn ledger (true) or the
    /// last-active day (false).
    pub ledgered: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ByokDay {
    pub date: String,
    pub provider: String,
    pub model: String,
    pub input: u64,
    pub output: u64,
    pub cost: f64,
    pub requests: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrandTotals {
    #[serde(flatten)]
    pub agents: Metrics,
    pub byok_input: u64,
    pub byok_output: u64,
    pub byok_cost: f64,
    pub byok_requests: u64,
    /// agents(in+out) + byok(in+out); cache and reasoning excluded.
    pub total_tokens: u64,
    pub total_cost_usd: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDashboard {
    pub totals: GrandTotals,
    pub projects: Vec<ProjectMetrics>,
    pub agents: Vec<AgentMetrics>,
    pub models: Vec<ModelMetrics>,
    pub daily: Vec<DailyBucket>,
    /// Most-recent first, capped at [`SESSION_ROW_CAP`].
    pub sessions: Vec<SessionRow>,
    pub sessions_total: u64,
    pub byok_daily: Vec<ByokDay>,
    pub byok_since: Option<String>,
    pub byok_project_path: &'static str,
    /// RFC 3339 of the earliest ledger row across every project, or `None`
    /// before any turn was ledgered.
    pub ledger_since: Option<String>,
    pub generated_at: String,
}

// ── The fold ───────────────────────────────────────────────────────────────

/// The bucket identity. Field order IS the `daily` sort order.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
struct DayKey {
    date: String,
    project_path: String,
    agent: String,
    model: String,
}

/// A bucket under construction: its sums plus the ids behind `sessions`.
#[derive(Debug, Default)]
struct Rollup {
    metrics: Metrics,
    ids: HashSet<String>,
}

impl Rollup {
    fn absorb(&mut self, other: &Rollup) {
        self.metrics.absorb(&other.metrics);
        self.ids.extend(other.ids.iter().cloned());
    }

    fn finish(self) -> Metrics {
        Metrics {
            sessions: self.ids.len() as u64,
            ..self.metrics
        }
    }
}

/// One project's record, folded.
pub(crate) struct ProjectFold {
    project_path: String,
    days: BTreeMap<DayKey, Rollup>,
    sessions: Vec<SessionRow>,
    first_activity_ms: Option<i64>,
    last_activity_ms: Option<i64>,
    ledger_since: Option<DateTime<Utc>>,
}

/// Fold one project's record into day buckets and session rows. Pure.
pub(crate) fn fold_project(
    project_path: &str,
    record: &ProjectRecord,
    prices: &BTreeMap<String, ModelPrice>,
) -> ProjectFold {
    let mut deltas_by_session: HashMap<&str, Vec<&atlas_checkpoint::UsageDeltaRow>> =
        HashMap::new();
    for row in &record.deltas {
        deltas_by_session
            .entry(row.session_id.as_str())
            .or_default()
            .push(row);
    }
    let mut turns_by_session: HashMap<&str, Vec<&atlas_checkpoint::TurnMessages>> = HashMap::new();
    for turn in &record.turn_messages {
        turns_by_session
            .entry(turn.session_id.as_str())
            .or_default()
            .push(turn);
    }

    let mut days: BTreeMap<DayKey, Rollup> = BTreeMap::new();
    let mut sessions: Vec<SessionRow> = Vec::with_capacity(record.sessions.len());
    let (mut first_activity_ms, mut last_activity_ms): (Option<i64>, Option<i64>) = (None, None);

    for session in &record.sessions {
        let agent = session.agent.clone().unwrap_or_else(|| UNKNOWN.to_string());
        let model_label = session.model.clone().unwrap_or_else(|| UNKNOWN.to_string());
        let started_ms = session.started_at.timestamp_millis();
        let last_ms = session
            .last_activity_at
            .unwrap_or(session.updated_at)
            .timestamp_millis();
        first_activity_ms = Some(first_activity_ms.map_or(started_ms, |f| f.min(started_ms)));
        last_activity_ms = Some(last_activity_ms.map_or(last_ms, |l| l.max(last_ms)));

        let rows = deltas_by_session
            .get(session.id.as_str())
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let ledger_sum = rows.iter().fold([0u64; 5], |mut acc, row| {
            for (a, b) in acc.iter_mut().zip(row.totals.split()) {
                *a += b;
            }
            acc
        });
        let stored = session.token_totals.split();
        let mut effective = [0u64; 5];
        let mut remainder = [0u64; 5];
        for i in 0..5 {
            effective[i] = stored[i].max(ledger_sum[i]);
            remainder[i] = effective[i] - ledger_sum[i];
        }
        let messages = record
            .message_counts
            .get(&session.id)
            .copied()
            .unwrap_or(0)
            .max(0) as u64;

        let mut cost = 0.0;

        // Ledger rows: each turn on the day it ran, at the model it ran on.
        for row in rows {
            let model = row.model.as_deref().or(session.model.as_deref());
            let c = usage::cost_usd(&row.totals, usage::price_for(model, prices));
            if let Some(b) = bucket_for(
                &mut days,
                project_path,
                &agent,
                &session.id,
                usage::local_day(row.recorded_at.timestamp_millis()),
                model,
            ) {
                b.metrics.add_split(row.totals.split());
                b.metrics.cost += c;
                cost += c;
            }
        }

        // The remainder: what the stored total carries beyond the ledger,
        // dated the way every session was before the ledger existed.
        if remainder.iter().any(|n| *n > 0) {
            let totals = TokenTotals::from_split(remainder, None, None);
            let model = session.model.as_deref();
            let c = usage::cost_usd(&totals, usage::price_for(model, prices));
            if let Some(b) = bucket_for(
                &mut days,
                project_path,
                &agent,
                &session.id,
                usage::local_day(last_ms),
                model,
            ) {
                b.metrics.add_split(remainder);
                b.metrics.cost += c;
                cost += c;
            }
        }

        // Messages: by the turn they belong to, at that turn's model.
        if let Some(turns) = turns_by_session.get(session.id.as_str()) {
            for turn in turns {
                let model = rows
                    .iter()
                    .find(|r| r.turn_seq == turn.turn_seq)
                    .and_then(|r| r.model.as_deref())
                    .or(session.model.as_deref());
                if let Some(b) = bucket_for(
                    &mut days,
                    project_path,
                    &agent,
                    &session.id,
                    usage::local_day(turn.first_at.timestamp_millis()),
                    model,
                ) {
                    b.metrics.messages += turn.messages;
                }
            }
        }

        sessions.push(SessionRow {
            session_id: session.native_session_id.clone(),
            project_path: project_path.to_string(),
            agent,
            model: model_label,
            input: effective[0],
            output: effective[1],
            cache_write: effective[2],
            cache_read: effective[3],
            reasoning: effective[4],
            messages,
            cost,
            started_ms,
            last_activity_ms: Some(last_ms),
            title: session.title.clone().unwrap_or_default(),
            ledgered: !rows.is_empty(),
        });
    }

    ProjectFold {
        project_path: project_path.to_string(),
        days,
        sessions,
        first_activity_ms,
        last_activity_ms,
        ledger_since: record.ledger_since,
    }
}

/// The bucket a (day, project, agent, model) lands in, with this session
/// counted in it. `None` when the day could not be resolved.
fn bucket_for<'a>(
    days: &'a mut BTreeMap<DayKey, Rollup>,
    project_path: &str,
    agent: &str,
    session_id: &str,
    date: Option<String>,
    model: Option<&str>,
) -> Option<&'a mut Rollup> {
    let key = DayKey {
        date: date?,
        project_path: project_path.to_string(),
        agent: agent.to_string(),
        model: model
            .map(str::to_string)
            .unwrap_or_else(|| UNKNOWN.to_string()),
    };
    let entry = days.entry(key).or_default();
    entry.ids.insert(session_id.to_string());
    Some(entry)
}

/// Everything the dashboard carries about agents, assembled from the per-
/// project folds. The rollups are folded from `daily`, not from the record.
struct Assembled {
    totals: Metrics,
    projects: Vec<ProjectMetrics>,
    agents: Vec<AgentMetrics>,
    models: Vec<ModelMetrics>,
    daily: Vec<DailyBucket>,
    /// Every session row, unsorted and uncapped.
    sessions: Vec<SessionRow>,
    ledger_since: Option<DateTime<Utc>>,
}

fn assemble(folds: Vec<ProjectFold>) -> Assembled {
    let mut days: BTreeMap<DayKey, Rollup> = BTreeMap::new();
    let mut sessions: Vec<SessionRow> = Vec::new();
    let mut ledger_since: Option<DateTime<Utc>> = None;
    let mut spans: Vec<(String, Option<i64>, Option<i64>)> = Vec::new();

    for fold in folds {
        for (key, rollup) in fold.days {
            days.entry(key).or_default().absorb(&rollup);
        }
        sessions.extend(fold.sessions);
        ledger_since = match (ledger_since, fold.ledger_since) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        spans.push((
            fold.project_path,
            fold.first_activity_ms,
            fold.last_activity_ms,
        ));
    }

    let mut totals = Rollup::default();
    let mut by_project: HashMap<&str, Rollup> = HashMap::new();
    let mut by_agent: BTreeMap<&str, Rollup> = BTreeMap::new();
    let mut by_model: BTreeMap<&str, Rollup> = BTreeMap::new();
    for (key, rollup) in &days {
        totals.absorb(rollup);
        by_project
            .entry(key.project_path.as_str())
            .or_default()
            .absorb(rollup);
        by_agent
            .entry(key.agent.as_str())
            .or_default()
            .absorb(rollup);
        by_model
            .entry(key.model.as_str())
            .or_default()
            .absorb(rollup);
    }

    let projects = spans
        .iter()
        .map(|(path, first, last)| ProjectMetrics {
            project_path: path.clone(),
            project_name: usage::project_name(path),
            first_activity_ms: *first,
            last_activity_ms: *last,
            metrics: by_project
                .remove(path.as_str())
                .unwrap_or_default()
                .finish(),
        })
        .collect();

    let mut agents: Vec<AgentMetrics> = by_agent
        .into_iter()
        .map(|(agent, r)| AgentMetrics {
            agent: agent.to_string(),
            metrics: r.finish(),
        })
        .collect();
    agents.sort_by(|a, b| by_cost_then_tokens(&a.metrics, &b.metrics));
    let mut models: Vec<ModelMetrics> = by_model
        .into_iter()
        .map(|(model, r)| ModelMetrics {
            model: model.to_string(),
            metrics: r.finish(),
        })
        .collect();
    models.sort_by(|a, b| by_cost_then_tokens(&a.metrics, &b.metrics));

    // `days` is a BTreeMap over DayKey, so this is already (date, project,
    // agent, model) order.
    let daily = days
        .into_iter()
        .map(|(key, r)| DailyBucket {
            date: key.date,
            project_path: key.project_path,
            agent: key.agent,
            model: key.model,
            metrics: r.finish(),
        })
        .collect();

    Assembled {
        totals: totals.finish(),
        projects,
        agents,
        models,
        daily,
        sessions,
        ledger_since,
    }
}

fn by_cost_then_tokens(a: &Metrics, b: &Metrics) -> std::cmp::Ordering {
    b.cost
        .partial_cmp(&a.cost)
        .unwrap_or(std::cmp::Ordering::Equal)
        .then_with(|| b.tokens().cmp(&a.tokens()))
}

/// Most-recent first, then truncated to [`SESSION_ROW_CAP`]. Returns the
/// count before truncation.
fn cap_sessions(mut rows: Vec<SessionRow>) -> (Vec<SessionRow>, u64) {
    rows.sort_by(|a, b| {
        b.last_activity_ms
            .cmp(&a.last_activity_ms)
            .then_with(|| b.started_ms.cmp(&a.started_ms))
    });
    let total = rows.len() as u64;
    rows.truncate(SESSION_ROW_CAP);
    (rows, total)
}

// ── BYOK ───────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ByokUsageEntry {
    ts: String,
    provider: Option<String>,
    model: Option<String>,
    input_tokens: u64,
    output_tokens: u64,
    cost_usd: Option<f64>,
}

#[derive(Default)]
struct ByokFold {
    daily: Vec<ByokDay>,
    since: Option<String>,
    input: u64,
    output: u64,
    cost: f64,
    requests: u64,
}

/// Fold the BYOK usage log, keyed by (local day, provider, model). A line
/// that does not parse is skipped rather than failing the whole read.
fn fold_byok_lines(raw: &str) -> ByokFold {
    let mut fold = ByokFold::default();
    let mut days: BTreeMap<(String, String, String), ByokDay> = BTreeMap::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(e) = serde_json::from_str::<ByokUsageEntry>(line) else {
            continue;
        };
        let cost = e.cost_usd.unwrap_or(0.0);
        fold.input += e.input_tokens;
        fold.output += e.output_tokens;
        fold.cost += cost;
        fold.requests += 1;
        if fold.since.is_none() {
            fold.since = Some(e.ts.clone());
        }
        let Some(day) = iso_local_day(&e.ts) else {
            continue;
        };
        let provider = e.provider.unwrap_or_else(|| UNKNOWN.to_string());
        let model = e.model.unwrap_or_else(|| UNKNOWN.to_string());
        let d = days
            .entry((day.clone(), provider.clone(), model.clone()))
            .or_insert(ByokDay {
                date: day,
                provider,
                model,
                ..Default::default()
            });
        d.input += e.input_tokens;
        d.output += e.output_tokens;
        d.cost += cost;
        d.requests += 1;
    }
    fold.daily = days.into_values().collect();
    fold
}

/// `<app_config_dir>/byok-usage.jsonl` — shared with modelchat.rs (writer).
pub(crate) fn byok_usage_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("byok-usage.jsonl"))
}

fn iso_local_day(s: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|dt| {
        dt.with_timezone(&chrono::Local)
            .format("%Y-%m-%d")
            .to_string()
    })
}

// ── Commands ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn usage_dashboard(
    app: AppHandle,
    project_paths: Vec<String>,
) -> Result<UsageDashboard, String> {
    let byok_path = byok_usage_path(&app);

    tokio::task::spawn_blocking(move || {
        let prices = usage::read_prices(&app);

        // One read per project. A project whose store is missing, never
        // enabled, or unreadable contributes nothing and must not blank the
        // other projects' figures.
        let folds: Vec<ProjectFold> = project_paths
            .iter()
            .filter_map(|path| match usage::project_record(path) {
                Ok(Some(record)) => Some(fold_project(path, &record, &prices)),
                Ok(None) => None,
                Err(e) => {
                    tracing::debug!(target: "atlas::usage", "skipping {path}: {e}");
                    None
                }
            })
            .collect();
        let assembled = assemble(folds);
        let (sessions, sessions_total) = cap_sessions(assembled.sessions);

        let byok = byok_path
            .and_then(|p| std::fs::read_to_string(p).ok())
            .map(|raw| fold_byok_lines(&raw))
            .unwrap_or_default();

        let totals = GrandTotals {
            total_tokens: assembled.totals.input
                + assembled.totals.output
                + byok.input
                + byok.output,
            total_cost_usd: assembled.totals.cost + byok.cost,
            byok_input: byok.input,
            byok_output: byok.output,
            byok_cost: byok.cost,
            byok_requests: byok.requests,
            agents: assembled.totals,
        };

        Ok(UsageDashboard {
            totals,
            projects: assembled.projects,
            agents: assembled.agents,
            models: assembled.models,
            daily: assembled.daily,
            sessions,
            sessions_total,
            byok_daily: byok.daily,
            byok_since: byok.since,
            byok_project_path: BYOK_PROJECT_PATH,
            ledger_since: assembled.ledger_since.map(|t| t.to_rfc3339()),
            generated_at: chrono::Local::now().to_rfc3339(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Export writers (no JS fs plugin; mirror knowledge_export.rs) ───────────

#[tauri::command]
pub async fn usage_export_markdown(target_path: String, markdown: String) -> Result<(), String> {
    crate::commands::save_guard::guard_save_dest(&target_path)?;
    tokio::task::spawn_blocking(move || {
        std::fs::write(&target_path, markdown).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn usage_write_file(target_path: String, bytes: Vec<u8>) -> Result<(), String> {
    crate::commands::save_guard::guard_save_dest(&target_path)?;
    tokio::task::spawn_blocking(move || {
        std::fs::write(&target_path, bytes).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use atlas_checkpoint::{Session, TurnMessages, UsageDeltaRow};
    use chrono::{TimeZone, Utc};

    fn price(input: f64, output: f64) -> ModelPrice {
        ModelPrice {
            input,
            output,
            cache_read: 0.0,
            cache_write: 0.0,
            ..ModelPrice::default()
        }
    }

    fn prices() -> BTreeMap<String, ModelPrice> {
        BTreeMap::from([
            ("claude-opus-4".to_string(), price(15.0, 75.0)),
            ("gpt-5".to_string(), price(1.25, 10.0)),
        ])
    }

    fn at(day: u32, hour: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 8, day, hour, 0, 0).unwrap()
    }

    fn day_of(t: DateTime<Utc>) -> String {
        usage::local_day(t.timestamp_millis()).unwrap()
    }

    fn totals(input: u64, output: u64) -> TokenTotals {
        TokenTotals {
            input_tokens: input,
            output_tokens: output,
            ..Default::default()
        }
    }

    fn session(id: &str, agent: &str, model: Option<&str>, totals: TokenTotals) -> Session {
        Session {
            id: format!("row-{id}"),
            workspace_id: "/tmp/atlas".into(),
            source: atlas_checkpoint::Source::Acp,
            native_session_id: id.into(),
            title: Some(format!("{id} title")),
            agent: Some(agent.into()),
            model: model.map(str::to_string),
            branch: None,
            cwd: Some("/tmp/atlas".into()),
            token_totals: totals,
            summary: None,
            started_at: at(20, 9),
            updated_at: at(20, 9),
            last_activity_at: Some(at(20, 9)),
            needs_attention: false,
            attention_reason: None,
            redaction_counts: serde_json::json!({}),
            sync_state: atlas_checkpoint::SyncState::Local,
        }
    }

    fn delta(
        session: &Session,
        turn_seq: i64,
        model: Option<&str>,
        at: DateTime<Utc>,
        t: TokenTotals,
    ) -> UsageDeltaRow {
        UsageDeltaRow {
            session_id: session.id.clone(),
            turn_seq,
            model: model.map(str::to_string),
            recorded_at: at,
            totals: t,
        }
    }

    fn turn(
        session: &Session,
        turn_seq: i64,
        messages: u64,
        first_at: DateTime<Utc>,
    ) -> TurnMessages {
        TurnMessages {
            session_id: session.id.clone(),
            turn_seq,
            messages,
            first_at,
        }
    }

    fn record(
        sessions: Vec<Session>,
        deltas: Vec<UsageDeltaRow>,
        turns: Vec<TurnMessages>,
    ) -> ProjectRecord {
        let message_counts = turns
            .iter()
            .fold(HashMap::<String, i64>::new(), |mut acc, t| {
                *acc.entry(t.session_id.clone()).or_default() += t.messages as i64;
                acc
            });
        ProjectRecord {
            sessions,
            message_counts,
            ledger_since: deltas.iter().map(|d| d.recorded_at).min(),
            deltas,
            turn_messages: turns,
        }
    }

    fn assembled(records: Vec<(&str, ProjectRecord)>) -> Assembled {
        let prices = prices();
        assemble(
            records
                .iter()
                .map(|(path, record)| fold_project(path, record, &prices))
                .collect(),
        )
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn ledger_rows_spread_a_session_across_the_days_its_turns_ran() {
        let mut s = session("s1", "claude-code", Some("gpt-5"), totals(300, 30));
        s.last_activity_at = Some(at(22, 9));
        let deltas = vec![
            delta(&s, 1, None, at(20, 10), totals(100, 10)),
            delta(&s, 2, None, at(21, 10), totals(200, 20)),
        ];
        let out = assembled(vec![("/p", record(vec![s], deltas, vec![]))]);

        assert_eq!(
            out.daily.len(),
            2,
            "no remainder: nothing lands on the last-active day"
        );
        assert_eq!(out.daily[0].date, day_of(at(20, 10)));
        assert_eq!(out.daily[0].metrics.input, 100);
        assert_eq!(out.daily[1].date, day_of(at(21, 10)));
        assert_eq!(out.daily[1].metrics.input, 200);
        assert!(out.sessions[0].ledgered);
        assert_eq!(out.sessions[0].input, 300);
    }

    #[test]
    fn a_session_without_ledger_rows_lands_on_its_last_active_day() {
        let mut s = session("s1", "claude-code", Some("gpt-5"), totals(1_000_000, 0));
        s.last_activity_at = Some(at(23, 15));
        let out = assembled(vec![("/p", record(vec![s], vec![], vec![]))]);

        assert_eq!(out.daily.len(), 1);
        assert_eq!(out.daily[0].date, day_of(at(23, 15)));
        assert_eq!(out.daily[0].metrics.input, 1_000_000);
        assert!(close(out.daily[0].metrics.cost, 1.25));
        assert!(!out.sessions[0].ledgered);
        assert!(close(out.sessions[0].cost, 1.25));
    }

    #[test]
    fn the_remainder_lands_on_the_last_active_day_and_daily_sums_to_the_session() {
        let mut s = session("s1", "claude-code", Some("gpt-5"), totals(500, 50));
        s.last_activity_at = Some(at(25, 9));
        let deltas = vec![delta(&s, 3, None, at(21, 10), totals(100, 10))];
        let out = assembled(vec![("/p", record(vec![s], deltas, vec![]))]);

        assert_eq!(out.daily.len(), 2);
        assert_eq!(out.daily[0].date, day_of(at(21, 10)));
        assert_eq!(out.daily[0].metrics.input, 100);
        assert_eq!(out.daily[1].date, day_of(at(25, 9)));
        assert_eq!(out.daily[1].metrics.input, 400);
        let daily_input: u64 = out.daily.iter().map(|d| d.metrics.input).sum();
        let session_input: u64 = out.sessions.iter().map(|s| s.input).sum();
        assert_eq!(daily_input, session_input);
        assert!(out.sessions[0].ledgered);
    }

    #[test]
    fn a_ledger_larger_than_the_stored_total_wins() {
        // The importer overwrote the total with a stale figure.
        let s = session("s1", "claude-code", Some("gpt-5"), totals(100, 10));
        let deltas = vec![
            delta(&s, 1, None, at(20, 10), totals(150, 15)),
            delta(&s, 2, None, at(20, 11), totals(100, 10)),
        ];
        let out = assembled(vec![("/p", record(vec![s], deltas, vec![]))]);

        assert_eq!(out.sessions[0].input, 250);
        assert_eq!(out.sessions[0].output, 25);
        assert_eq!(out.daily.iter().map(|d| d.metrics.input).sum::<u64>(), 250);
        assert_eq!(out.totals.input, 250);
    }

    #[test]
    fn a_model_switch_prices_each_side_at_its_own_model_and_sums_to_the_session() {
        let s = session("s1", "claude-code", Some("gpt-5"), totals(2_000_000, 0));
        let deltas = vec![
            delta(
                &s,
                1,
                Some("claude-opus-4"),
                at(20, 10),
                totals(1_000_000, 0),
            ),
            delta(&s, 2, Some("gpt-5"), at(20, 11), totals(1_000_000, 0)),
        ];
        let out = assembled(vec![("/p", record(vec![s], deltas, vec![]))]);

        assert_eq!(out.daily.len(), 2, "same day, two models, two rows");
        let by_model: HashMap<&str, f64> = out
            .daily
            .iter()
            .map(|d| (d.model.as_str(), d.metrics.cost))
            .collect();
        assert!(close(by_model["claude-opus-4"], 15.0));
        assert!(close(by_model["gpt-5"], 1.25));
        assert!(close(out.sessions[0].cost, 16.25));
        let daily_cost: f64 = out.daily.iter().map(|d| d.metrics.cost).sum();
        assert!(close(daily_cost, out.sessions[0].cost));
        let models: Vec<&str> = out.models.iter().map(|m| m.model.as_str()).collect();
        assert_eq!(models, vec!["claude-opus-4", "gpt-5"], "costliest first");
    }

    #[test]
    fn every_rollup_folds_from_the_same_daily_rows() {
        let a = session(
            "a",
            "claude-code",
            Some("claude-opus-4"),
            totals(1_000_000, 0),
        );
        let mut b = session("b", "codex", Some("gpt-5"), totals(1_000_000, 100_000));
        b.last_activity_at = Some(at(21, 9));
        let mut c = session("c", "codex", Some("gpt-5"), totals(400_000, 0));
        c.last_activity_at = Some(at(22, 9));
        let out = assembled(vec![
            ("/p1", record(vec![a], vec![], vec![])),
            ("/p2", record(vec![b, c], vec![], vec![])),
        ]);

        let sum = |v: &[f64]| v.iter().sum::<f64>();
        let daily = sum(&out.daily.iter().map(|d| d.metrics.cost).collect::<Vec<_>>());
        let projects = sum(&out
            .projects
            .iter()
            .map(|p| p.metrics.cost)
            .collect::<Vec<_>>());
        let agents = sum(&out
            .agents
            .iter()
            .map(|a| a.metrics.cost)
            .collect::<Vec<_>>());
        let models = sum(&out
            .models
            .iter()
            .map(|m| m.metrics.cost)
            .collect::<Vec<_>>());
        // 15 + (1.25 + 1.0) + 0.5
        assert!(close(daily, 17.75), "{daily}");
        assert!(close(projects, daily));
        assert!(close(agents, daily));
        assert!(close(models, daily));
        assert!(close(out.totals.cost, daily));

        assert_eq!(
            out.projects
                .iter()
                .map(|p| p.project_path.as_str())
                .collect::<Vec<_>>(),
            vec!["/p1", "/p2"],
            "input order"
        );
        assert_eq!(out.projects[1].metrics.sessions, 2, "distinct sessions");
        assert_eq!(out.totals.sessions, 3);
        let codex = out.agents.iter().find(|a| a.agent == "codex").unwrap();
        assert_eq!(codex.metrics.sessions, 2);
        assert_eq!(codex.metrics.input, 1_400_000);
        assert_eq!(
            out.projects[0].first_activity_ms,
            Some(at(20, 9).timestamp_millis())
        );
        assert_eq!(
            out.projects[1].last_activity_ms,
            Some(at(22, 9).timestamp_millis())
        );
    }

    #[test]
    fn messages_are_dated_by_the_turn_they_belong_to() {
        let mut s = session("s1", "claude-code", Some("gpt-5"), TokenTotals::default());
        s.last_activity_at = Some(at(28, 9));
        let turns = vec![turn(&s, 1, 2, at(20, 10)), turn(&s, 2, 4, at(24, 10))];
        let out = assembled(vec![("/p", record(vec![s], vec![], turns))]);

        assert_eq!(
            out.daily.len(),
            2,
            "no tokens, still a day of work per turn"
        );
        assert_eq!(out.daily[0].date, day_of(at(20, 10)));
        assert_eq!(out.daily[0].metrics.messages, 2);
        assert_eq!(out.daily[1].date, day_of(at(24, 10)));
        assert_eq!(out.daily[1].metrics.messages, 4);
        assert_eq!(out.sessions[0].messages, 6);
        assert_eq!(out.totals.messages, 6);
        assert_eq!(out.totals.sessions, 1);
    }

    #[test]
    fn a_session_that_recorded_nothing_contributes_no_day_rows() {
        let s = session("s1", "claude-code", None, TokenTotals::default());
        let out = assembled(vec![("/p", record(vec![s], vec![], vec![]))]);
        assert!(out.daily.is_empty());
        assert_eq!(out.sessions.len(), 1, "but it is still a session");
        assert_eq!(out.sessions[0].model, UNKNOWN);
    }

    #[test]
    fn session_rows_are_most_recent_first_and_capped_with_the_true_total_kept() {
        let sessions: Vec<Session> = (0..(SESSION_ROW_CAP as i64 + 1))
            .map(|i| {
                let mut s = session(&format!("s{i}"), "claude-code", Some("gpt-5"), totals(1, 0));
                s.last_activity_at = Some(at(20, 9) + chrono::Duration::seconds(i));
                s
            })
            .collect();
        let out = assembled(vec![("/p", record(sessions, vec![], vec![]))]);
        let (rows, total) = cap_sessions(out.sessions);

        assert_eq!(total, SESSION_ROW_CAP as u64 + 1);
        assert_eq!(rows.len(), SESSION_ROW_CAP);
        assert_eq!(
            rows[0].session_id,
            format!("s{SESSION_ROW_CAP}"),
            "newest first"
        );
        assert!(rows
            .windows(2)
            .all(|w| w[0].last_activity_ms >= w[1].last_activity_ms));
    }

    #[test]
    fn byok_lines_fold_by_day_provider_and_model_and_skip_what_does_not_parse() {
        let raw = concat!(
            r#"{"ts":"2026-08-20T10:00:00+00:00","provider":"openai","model":"gpt-5","inputTokens":100,"outputTokens":10,"costUsd":0.5}"#,
            "\n",
            "not json at all\n",
            r#"{"ts":"2026-08-20T11:00:00+00:00","provider":"openai","model":"gpt-5","inputTokens":50,"outputTokens":5,"costUsd":0.25}"#,
            "\n",
            r#"{"ts":"2026-08-20T12:00:00+00:00","provider":"openai","model":"gpt-4o","inputTokens":1,"outputTokens":1,"costUsd":null}"#,
            "\n",
            r#"{"ts":"2026-08-21T12:00:00+00:00","inputTokens":7,"outputTokens":7}"#,
            "\n",
        );
        let fold = fold_byok_lines(raw);

        assert_eq!(fold.since.as_deref(), Some("2026-08-20T10:00:00+00:00"));
        assert_eq!(fold.requests, 4, "the malformed line is not a request");
        assert_eq!(fold.input, 158);
        assert_eq!(fold.output, 23);
        assert!(close(fold.cost, 0.75));
        assert_eq!(fold.daily.len(), 3);
        let gpt5 = fold
            .daily
            .iter()
            .find(|d| d.model == "gpt-5" && d.provider == "openai")
            .unwrap();
        assert_eq!(gpt5.requests, 2);
        assert_eq!(gpt5.input, 150);
        assert!(close(gpt5.cost, 0.75));
        let unknown = fold.daily.iter().find(|d| d.provider == UNKNOWN).unwrap();
        assert_eq!(unknown.model, UNKNOWN);
        assert_eq!(unknown.input, 7);
    }
}
