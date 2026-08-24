//! Agent usage and cost, from Atlas's own record.
//!
//! # Why this replaced a JSONL scrape
//!
//! The status-bar widget, the usage panel and Mission Control's cost charts
//! used to parse `~/.claude/projects/**/*.jsonl` and price it with a table
//! hardcoded in `claude.rs`. That made three user-facing surfaces Claude-only
//! by construction, and coupled them to a file format Atlas does not own. They
//! now read what Atlas itself recorded — the checkpoint store's per-session
//! token totals — so every agent is counted the same way, and they price it
//! from the models.dev map Atlas already caches rather than a table in the
//! source (ADR-0001, issue #17).
//!
//! # What that costs, stated plainly
//!
//! * **Only sessions run through Atlas are counted.** A chat run in a terminal
//!   never reached the recorder, so it contributes nothing. This is the spec's
//!   accepted trade (issue #15: "Coverage narrows to Atlas-run sessions").
//! * **Day buckets are session-grained, not message-grained.** The store keeps
//!   one token total per session, not per message, so a session's usage lands
//!   on the day it was last active — the same attribution the Codex column
//!   already used.
//! * **Cache tokens are not priced.** models.dev publishes input and output
//!   prices only. Cache reads and writes are still counted and shown; they just
//!   do not move the dollar figure.
//! * A session whose model Atlas never recorded, or whose model is absent from
//!   the price map, contributes tokens and no cost. That is a gap in the price
//!   map, and inventing a fallback price would hide it.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use atlas_checkpoint::{Session, TokenTotals};
use serde::Serialize;
use tauri::AppHandle;

use super::models_pricing::ModelPrice;

/// One recorded session's usage.
///
/// Deliberately snake_case on the wire, like every other session-shaped
/// payload in this app (see `agent_transcript::AgentSessionMeta`'s note).
#[derive(Debug, Clone, Default, Serialize)]
pub struct SessionUsage {
    /// The agent's own id for the conversation — the ACP session id, and what
    /// the status bar looks a session up by.
    pub session_id: String,
    /// Which agent ran it. The whole point: this is data, not a code path.
    pub agent: Option<String>,
    pub model: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    /// Recorded messages — user and assistant rows in Atlas's own record.
    ///
    /// Not "requests", which is what the JSONL scrape counted: Atlas has no
    /// idea how many HTTP calls an agent made. Not "turns" either, which is a
    /// smaller number: one turn is a prompt and its answer.
    pub messages: u64,
    /// `0.0` when the model is unknown or unpriced — never a guess.
    pub total_cost_usd: f64,
    /// When the session started, epoch milliseconds.
    pub started_ms: i64,
    /// When the session last did work, epoch milliseconds.
    pub last_activity_ms: Option<i64>,
    pub title: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct UsageTotals {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub messages: u64,
    pub total_cost_usd: f64,
    pub session_count: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ProjectUsage {
    pub totals: UsageTotals,
    pub sessions: Vec<SessionUsage>,
}

/// One local day's usage in one project.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct DayUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
    pub messages: u64,
}

// ── Commands ──────────────────────────────────────────────────────────────

/// Usage for one live session, keyed by the agent's own session id.
///
/// Returns `None` rather than zeroes when the session was never recorded, so
/// the status bar can fall back to its live per-turn counters instead of
/// showing a confident zero.
#[tauri::command]
pub async fn agent_session_usage(
    project_path: String,
    session_id: String,
    app: AppHandle,
) -> Result<Option<SessionUsage>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let prices = read_prices(&app);
        Ok(project_usage(&project_path, &prices)?
            .sessions
            .into_iter()
            .find(|s| s.session_id == session_id))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Usage for every session Atlas recorded in one project, costliest first.
#[tauri::command]
pub async fn agent_project_usage(
    project_path: String,
    app: AppHandle,
) -> Result<ProjectUsage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let prices = read_prices(&app);
        project_usage(&project_path, &prices)
    })
        .await
        .map_err(|e| e.to_string())?
}

// ── The read, and the arithmetic on top of it ─────────────────────────────

/// The price map Atlas already caches from models.dev. Empty when it has never
/// been fetched — every cost then reads zero, which is honest.
///
/// Reads a file, so every caller runs it on the blocking pool.
pub(crate) fn read_prices(app: &AppHandle) -> BTreeMap<String, ModelPrice> {
    super::models_pricing::models_pricing_get(app.clone())
}

/// Every recorded session in one project, priced.
pub(crate) fn project_usage(
    project_path: &str,
    prices: &BTreeMap<String, ModelPrice>,
) -> Result<ProjectUsage, String> {
    let Some(store) = super::capture::open_reader(project_path)? else {
        return Ok(ProjectUsage::default());
    };
    let sessions = store
        .sessions_for_workspace(project_path)
        .map_err(|e| e.to_string())?;
    let message_counts = store
        .message_counts(project_path)
        .map_err(|e| e.to_string())?;
    Ok(summarize(&sessions, &message_counts, prices))
}

/// Fold recorded sessions into the shape the usage surfaces render.
pub(crate) fn summarize(
    sessions: &[Session],
    message_counts: &HashMap<String, i64>,
    prices: &BTreeMap<String, ModelPrice>,
) -> ProjectUsage {
    let mut out: Vec<SessionUsage> = sessions
        .iter()
        .map(|session| {
            let totals = &session.token_totals;
            SessionUsage {
                session_id: session.native_session_id.clone(),
                agent: session.agent.clone(),
                model: session.model.clone(),
                input_tokens: totals.input_tokens,
                output_tokens: totals.output_tokens,
                cache_creation_tokens: totals.cache_creation_tokens,
                cache_read_tokens: totals.cache_read_tokens,
                messages: message_counts.get(&session.id).copied().unwrap_or(0).max(0) as u64,
                total_cost_usd: cost_usd(totals, price_for(session.model.as_deref(), prices)),
                started_ms: session.started_at.timestamp_millis(),
                last_activity_ms: Some(
                    session
                        .last_activity_at
                        .unwrap_or(session.updated_at)
                        .timestamp_millis(),
                ),
                title: session.title.clone().unwrap_or_default(),
            }
        })
        .collect();

    let mut totals = UsageTotals {
        session_count: out.len() as u64,
        ..Default::default()
    };
    for session in &out {
        totals.input_tokens += session.input_tokens;
        totals.output_tokens += session.output_tokens;
        totals.cache_creation_tokens += session.cache_creation_tokens;
        totals.cache_read_tokens += session.cache_read_tokens;
        totals.messages += session.messages;
        totals.total_cost_usd += session.total_cost_usd;
    }

    // Costliest first, and by tokens where nothing is priced — the panel reads
    // top-down and the expensive work is what the user came to find.
    out.sort_by(|a, b| {
        b.total_cost_usd
            .partial_cmp(&a.total_cost_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| tokens(b).cmp(&tokens(a)))
            .then_with(|| b.last_activity_ms.cmp(&a.last_activity_ms))
    });
    ProjectUsage {
        totals,
        sessions: out,
    }
}

/// Usage bucketed by the local day each session was last active.
pub(crate) fn day_buckets(sessions: &[SessionUsage]) -> BTreeMap<String, DayUsage> {
    let mut days: BTreeMap<String, DayUsage> = BTreeMap::new();
    for session in sessions {
        // Nothing recorded at all — not even a message — is nothing to bucket.
        // A session with messages but no token report still belongs on its day:
        // dropping it would silently shorten the series.
        if session.input_tokens == 0 && session.output_tokens == 0 && session.messages == 0 {
            continue;
        }
        let Some(day) = session.last_activity_ms.and_then(local_day) else {
            continue;
        };
        let bucket = days.entry(day).or_default();
        bucket.input_tokens += session.input_tokens;
        bucket.output_tokens += session.output_tokens;
        bucket.cost_usd += session.total_cost_usd;
        bucket.messages += session.messages;
    }
    days
}

fn tokens(session: &SessionUsage) -> u64 {
    session.input_tokens
        + session.output_tokens
        + session.cache_creation_tokens
        + session.cache_read_tokens
}

/// What a session cost, from the cached models.dev prices (USD per 1M tokens).
///
/// Cache tokens are excluded because models.dev does not publish a price for
/// them; they are counted and shown, but never charged for here.
pub(crate) fn cost_usd(totals: &TokenTotals, price: Option<&ModelPrice>) -> f64 {
    let Some(price) = price else {
        return 0.0;
    };
    (totals.input_tokens as f64 * price.input + totals.output_tokens as f64 * price.output)
        / 1_000_000.0
}

/// Find a recorded model in the price map.
///
/// Three shapes have to hit the same entry, because what an agent reports and
/// what models.dev keys on are not the same string:
/// 1. exactly as recorded (`anthropic/claude-opus-4`, or a bare `gpt-5`),
/// 2. with a provider prefix stripped (`anthropic/claude-opus-4` → `claude-opus-4`),
/// 3. with a dated release suffix stripped (`claude-opus-4-20250514` → `claude-opus-4`).
///
/// A miss is a miss: the session shows its tokens with no cost rather than the
/// cost of some other model.
pub(crate) fn price_for<'a>(
    model: Option<&str>,
    prices: &'a BTreeMap<String, ModelPrice>,
) -> Option<&'a ModelPrice> {
    let model = model?.trim();
    if model.is_empty() {
        return None;
    }
    if let Some(price) = prices.get(model) {
        return Some(price);
    }
    let bare = model.rsplit('/').next().unwrap_or(model);
    if let Some(price) = prices.get(bare) {
        return Some(price);
    }
    prices.get(undated(bare))
}

/// `claude-opus-4-20250514` → `claude-opus-4`. Anything else is unchanged.
fn undated(model: &str) -> &str {
    match model.rsplit_once('-') {
        Some((head, tail)) if tail.len() == 8 && tail.bytes().all(|b| b.is_ascii_digit()) => head,
        _ => model,
    }
}

fn local_day(epoch_ms: i64) -> Option<String> {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(epoch_ms)
        .map(|dt| dt.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string())
}

/// The project's display name, for the surfaces that list several.
pub(crate) fn project_name(project_path: &str) -> String {
    Path::new(project_path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| project_path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};

    fn price(input: f64, output: f64) -> ModelPrice {
        ModelPrice { input, output }
    }

    fn prices() -> BTreeMap<String, ModelPrice> {
        BTreeMap::from([
            ("anthropic/claude-opus-4".to_string(), price(15.0, 75.0)),
            ("claude-opus-4".to_string(), price(15.0, 75.0)),
            ("gpt-5".to_string(), price(1.25, 10.0)),
        ])
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
            started_at: Utc.with_ymd_and_hms(2026, 8, 20, 9, 0, 0).unwrap(),
            updated_at: Utc.with_ymd_and_hms(2026, 8, 20, 9, 0, 0).unwrap(),
            last_activity_at: Some(Utc.with_ymd_and_hms(2026, 8, 20, 9, 0, 0).unwrap()),
            needs_attention: false,
            attention_reason: None,
            redaction_counts: serde_json::json!({}),
            sync_state: atlas_checkpoint::SyncState::Local,
        }
    }

    fn totals(input: u64, output: u64) -> TokenTotals {
        TokenTotals {
            input_tokens: input,
            output_tokens: output,
            ..Default::default()
        }
    }

    #[test]
    fn a_million_input_tokens_costs_the_models_input_price() {
        let prices = prices();
        let cost = cost_usd(
            &totals(1_000_000, 0),
            price_for(Some("claude-opus-4"), &prices),
        );
        assert!((cost - 15.0).abs() < 1e-9, "got {cost}");
    }

    #[test]
    fn a_dated_release_is_priced_as_the_model_it_is() {
        let prices = prices();
        assert!(price_for(Some("claude-opus-4-20250514"), &prices).is_some());
        assert!(price_for(Some("anthropic/claude-opus-4"), &prices).is_some());
    }

    #[test]
    fn an_unknown_model_costs_nothing_rather_than_something_invented() {
        let prices = prices();
        assert!(price_for(Some("some-local-llama"), &prices).is_none());
        assert!(price_for(None, &prices).is_none());
        assert_eq!(cost_usd(&totals(9_000_000, 9_000_000), None), 0.0);
    }

    #[test]
    fn cache_tokens_are_counted_but_not_charged_for() {
        let prices = prices();
        let heavy = TokenTotals {
            cache_creation_tokens: 5_000_000,
            cache_read_tokens: 5_000_000,
            ..totals(0, 0)
        };
        assert_eq!(cost_usd(&heavy, price_for(Some("gpt-5"), &prices)), 0.0);
    }

    #[test]
    fn every_agent_is_summarized_the_same_way() {
        let prices = prices();
        let sessions = vec![
            session("ses-1", "claude-code", Some("claude-opus-4"), totals(1_000_000, 0)),
            session("ses-2", "codex", Some("gpt-5"), totals(1_000_000, 0)),
            session("ses-3", "cersei", Some("gpt-5"), totals(0, 100_000)),
        ];
        let message_counts = HashMap::from([("row-ses-1".to_string(), 4i64), ("row-ses-2".to_string(), 2)]);

        let usage = summarize(&sessions, &message_counts, &prices);

        assert_eq!(usage.totals.session_count, 3);
        assert_eq!(usage.totals.input_tokens, 2_000_000);
        assert_eq!(usage.totals.output_tokens, 100_000);
        assert_eq!(usage.totals.messages, 6);
        // 15.00 (opus in) + 1.25 (gpt-5 in) + 1.00 (gpt-5 out)
        assert!((usage.totals.total_cost_usd - 17.25).abs() < 1e-9);
        // Costliest first, whichever agent ran it.
        assert_eq!(usage.sessions[0].session_id, "ses-1");
        assert_eq!(
            usage.sessions.iter().filter_map(|s| s.agent.clone()).count(),
            3,
            "every row says which agent produced it"
        );
    }

    #[test]
    fn a_sessions_usage_lands_on_the_day_it_was_last_active() {
        let prices = prices();
        let mut earlier = session("ses-1", "cersei", Some("gpt-5"), totals(1_000_000, 0));
        earlier.last_activity_at = Some(Utc.with_ymd_and_hms(2026, 8, 20, 12, 0, 0).unwrap());
        let mut later = session("ses-2", "claude-code", Some("gpt-5"), totals(2_000_000, 0));
        later.last_activity_at = Some(Utc.with_ymd_and_hms(2026, 8, 21, 12, 0, 0).unwrap());

        let usage = summarize(&[earlier, later], &HashMap::new(), &prices);
        let days = day_buckets(&usage.sessions);

        assert_eq!(days.len(), 2);
        assert_eq!(days.values().map(|d| d.input_tokens).sum::<u64>(), 3_000_000);
    }

    #[test]
    fn a_session_that_recorded_nothing_at_all_does_not_invent_a_day() {
        let prices = prices();
        let usage = summarize(
            &[session("ses-1", "cersei", None, TokenTotals::default())],
            &HashMap::new(),
            &prices,
        );
        assert!(day_buckets(&usage.sessions).is_empty());
    }

    #[test]
    fn a_session_whose_agent_reported_no_tokens_still_counts_as_a_day_of_work() {
        let prices = prices();
        let usage = summarize(
            &[session("ses-1", "some-agent", None, TokenTotals::default())],
            &HashMap::from([("row-ses-1".to_string(), 6i64)]),
            &prices,
        );
        let days = day_buckets(&usage.sessions);
        assert_eq!(days.len(), 1);
        assert_eq!(days.values().next().unwrap().messages, 6);
    }
}
