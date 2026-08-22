//! Session-history readers against `~/.claude/projects/<encoded-cwd>/*.jsonl`.
//!
//! Both the legacy Claude Code CLI (no longer wired into Atlas) and the
//! canonical ACP agent (`@agentclientprotocol/claude-agent-acp`, which sits on top
//! of the Claude Agent SDK) write their session transcripts here, so the
//! sidebar's history browser keeps working against the ACP-driven flow.
//!
//! Anything related to *running* Claude — `claude_run`, `claude_stream`,
//! `claude_stop`, etc. — was removed once the ACP integration replaced it.

use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tauri::State;

/// Per-file metadata cache keyed by JSONL path. The cached entry is reused
/// when the file's mtime matches what we last saw — the same path with a
/// newer mtime is re-parsed in a single pass.
///
/// Process-lifetime; the file watcher invalidates *frontend* queries (which
/// causes a re-call into this function), but the cache stays warm for files
/// that didn't actually change. Net effect: rapid sidebar refreshes during a
/// streaming turn only re-parse the one file that's actually growing.
#[derive(Default)]
pub struct ClaudeSessionIndex {
    inner: Mutex<HashMap<PathBuf, CacheEntry>>,
}

impl ClaudeSessionIndex {
    pub fn new() -> Self {
        Self::default()
    }
}

struct CacheEntry {
    mtime: SystemTime,
    meta: ClaudeSessionMeta,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClaudeSessionMeta {
    pub id: String,
    pub file_path: String,
    pub started_at: Option<String>,
    pub last_modified: Option<String>,
    pub message_count: usize,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolCallDump {
    pub tool_name: String,
    pub input: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ClaudeSessionStats {
    pub session_id: String,
    pub model: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub request_count: u64,
    pub total_cost_usd: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatMessageDump {
    pub role: String, // "user" | "assistant"
    pub content: String,
    pub timestamp: Option<String>,
    pub tool_calls: Vec<ToolCallDump>,
}

// ───────────────────────── Session management ─────────────────────────

pub(crate) fn projects_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    Ok(home.join(".claude").join("projects"))
}

// `encode_cwd` (Claude's cwd→folder encoding) and `is_injected_user_text` live
// in the canonical transcript module in `atlas-agents` — reused here so the
// history reader and the live transcript parser agree.
use atlas_agent_transcript::{encode_cwd, is_injected_user_text, strip_injected_context};

fn extract_first_user_text(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    if v.get("type").and_then(|t| t.as_str()) != Some("user") {
        return None;
    }
    let content = v.get("message")?.get("content")?;
    let text = if let Some(s) = content.as_str() {
        s.to_string()
    } else if let Some(arr) = content.as_array() {
        arr.iter()
            .find_map(|b| {
                if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                    b.get("text").and_then(|t| t.as_str()).map(|s| s.to_string())
                } else {
                    None
                }
            })?
    } else {
        return None;
    };
    if is_injected_user_text(&text) {
        return None;
    }
    let cleaned = strip_injected_context(&text);
    if cleaned.is_empty() { None } else { Some(cleaned) }
}

fn extract_timestamp(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    v.get("timestamp").and_then(|t| t.as_str()).map(|s| s.to_string())
}

#[tauri::command]
pub async fn list_claude_sessions(
    cwd: String,
    index: State<'_, ClaudeSessionIndex>,
) -> Result<Vec<ClaudeSessionMeta>, String> {
    // `index` is the Tauri-managed cache. We snapshot the relevant entries
    // out of it before doing any blocking I/O, then re-acquire the lock to
    // store updated results, so the cache mutex is never held across the
    // disk walk.
    let cache_snapshot: HashMap<PathBuf, CacheEntry> = {
        let guard = index.inner.lock();
        guard
            .iter()
            .map(|(k, v)| {
                (
                    k.clone(),
                    CacheEntry {
                        mtime: v.mtime,
                        meta: v.meta.clone(),
                    },
                )
            })
            .collect()
    };

    let (out, fresh_entries) = tokio::task::spawn_blocking(
        move || -> Result<(Vec<ClaudeSessionMeta>, Vec<(PathBuf, SystemTime, ClaudeSessionMeta)>), String> {
            let folder = projects_dir()?.join(encode_cwd(&cwd));
            if !folder.exists() {
                return Ok((Vec::new(), Vec::new()));
            }

            let mut out: Vec<ClaudeSessionMeta> = Vec::new();
            let mut fresh: Vec<(PathBuf, SystemTime, ClaudeSessionMeta)> = Vec::new();

            for entry in std::fs::read_dir(&folder).map_err(|e| e.to_string())? {
                let entry = match entry {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }

                let id = match path.file_stem().and_then(|s| s.to_str()) {
                    Some(s) if !s.is_empty() => s.to_string(),
                    _ => continue,
                };
                // Skip Claude Code's internal sub-agent / warmup session files.
                if id.starts_with("agent-") {
                    continue;
                }

                let metadata = match entry.metadata() {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                let mtime = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);

                // Cache hit on unchanged mtime — reuse the parsed metadata
                // without re-reading the file. This is the win during a
                // streaming turn: only the one growing JSONL re-parses, all
                // the historical ones short-circuit here.
                if let Some(prev) = cache_snapshot.get(&path) {
                    if prev.mtime == mtime {
                        out.push(prev.meta.clone());
                        continue;
                    }
                }

                let Some(meta) = parse_session_file(&path, &id, mtime) else {
                    continue;
                };
                out.push(meta.clone());
                fresh.push((path, mtime, meta));
            }

            out.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
            Ok((out, fresh))
        },
    )
    .await
    .map_err(|e| e.to_string())??;

    // Stuff freshly-parsed entries back into the cache. Entries for files
    // that disappeared get pruned so stale rows don't linger forever.
    {
        let mut guard = index.inner.lock();
        let present_paths: std::collections::HashSet<PathBuf> = out
            .iter()
            .map(|m| PathBuf::from(&m.file_path))
            .collect();
        guard.retain(|k, _| present_paths.contains(k));
        for (path, mtime, meta) in fresh_entries {
            guard.insert(path, CacheEntry { mtime, meta });
        }
    }

    Ok(out)
}

/// Single-pass JSONL parse: started_at, preview, message_count, sidechain
/// detection all from one read of the file. Returns `None` if the file is a
/// sidechain-only transcript (skipped) or unreadable.
fn parse_session_file(
    path: &Path,
    id: &str,
    mtime: SystemTime,
) -> Option<ClaudeSessionMeta> {
    let file = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(file);

    let mut started_at: Option<String> = None;
    let mut preview: Option<String> = None;
    let mut message_count = 0usize;
    let mut saw_main = false;
    let mut saw_sidechain = false;
    let mut classified_lines = 0usize;

    for line in reader.lines().flatten() {
        // Sidechain detection samples the first ~30 records, matching the
        // pre-refactor `jsonl_is_sidechain` heuristic.
        if classified_lines < 30 {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                match v.get("isSidechain").and_then(|x| x.as_bool()) {
                    Some(true) => saw_sidechain = true,
                    Some(false) => saw_main = true,
                    None => {}
                }
                classified_lines += 1;
            }
        }
        if started_at.is_none() {
            started_at = extract_timestamp(&line);
        }
        if preview.is_none() {
            if let Some(p) = extract_first_user_text(&line) {
                let p = p.replace('\n', " ");
                let truncated: String = if p.chars().count() > 80 {
                    p.chars().take(80).collect::<String>() + "…"
                } else {
                    p
                };
                preview = Some(truncated);
            }
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
            let t = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if t == "user" || t == "assistant" {
                message_count += 1;
            }
        }
    }

    if saw_sidechain && !saw_main {
        return None;
    }

    let last_modified = {
        let dt: chrono::DateTime<chrono::Utc> = mtime.into();
        Some(dt.to_rfc3339())
    };

    Some(ClaudeSessionMeta {
        id: id.to_string(),
        file_path: path.to_string_lossy().to_string(),
        started_at,
        last_modified,
        message_count,
        preview: preview.unwrap_or_else(|| "(no user message)".to_string()),
    })
}

#[tauri::command]
pub async fn delete_claude_session(file_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let base = projects_dir()?;
        let p = Path::new(&file_path);
        if !p.starts_with(&base) {
            return Err("refusing to delete: path outside ~/.claude/projects".into());
        }
        std::fs::remove_file(p).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── The cost scrape, orphaned ─────────────────────────────────────────────
//
// Everything from here to the end of this file — `pricing_for`,
// `compute_session_stats`, the `claude_session_stats` and
// `project_usage_stats` commands, and `claude_project_agg` — lost its last
// consumer in #17. The usage widget, the usage panel and Mission Control now
// read Atlas's own record (`commands::usage`), priced from the models.dev map
// Atlas already caches, so they work for every agent rather than for Claude.
//
// The two commands are still registered in `lib.rs` and nothing invokes them.
// That is deliberate: the scrape readers are deleted as one staged change in
// #14, and keeping them compiling until then is what makes that a deletion
// rather than a rescue.

// Pricing per 1M tokens: (input, output, cache_write, cache_read)
// Approximate Anthropic public pricing.
pub(crate) fn pricing_for(model: &str) -> (f64, f64, f64, f64) {
    let m = model.to_lowercase();
    if m.contains("opus") {
        (15.0, 75.0, 18.75, 1.50)
    } else if m.contains("haiku") {
        (0.80, 4.0, 1.00, 0.08)
    } else if m.contains("sonnet") {
        (3.0, 15.0, 3.75, 0.30)
    } else {
        // Unknown — assume sonnet-class pricing as a safe default.
        (3.0, 15.0, 3.75, 0.30)
    }
}

/// Walk a session's JSONL and sum token usage + cost. Safe on a missing
/// file (returns zeroed stats). Shared by `claude_session_stats` and the
/// project-wide aggregate.
fn compute_session_stats(path: &Path, session_id: &str) -> ClaudeSessionStats {
    let mut stats = ClaudeSessionStats {
        session_id: session_id.to_string(),
        ..Default::default()
    };
    let Ok(file) = std::fs::File::open(path) else {
        return stats;
    };
    let reader = BufReader::new(file);

    for line in reader.lines().flatten() {
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        // Don't bill sub-agent warmup turns to the user-visible session.
        if v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true) {
            continue;
        }
        let msg = match v.get("message") {
            Some(m) => m,
            None => continue,
        };
        if let Some(model) = msg.get("model").and_then(|m| m.as_str()) {
            stats.model = Some(model.to_string());
        }
        let usage = match msg.get("usage") {
            Some(u) => u,
            None => continue,
        };
        stats.input_tokens += usage.get("input_tokens").and_then(|n| n.as_u64()).unwrap_or(0);
        stats.output_tokens += usage.get("output_tokens").and_then(|n| n.as_u64()).unwrap_or(0);
        stats.cache_creation_tokens += usage
            .get("cache_creation_input_tokens")
            .and_then(|n| n.as_u64())
            .unwrap_or(0);
        stats.cache_read_tokens += usage
            .get("cache_read_input_tokens")
            .and_then(|n| n.as_u64())
            .unwrap_or(0);
        stats.request_count += 1;
    }

    let model = stats.model.clone().unwrap_or_default();
    let (p_in, p_out, p_cw, p_cr) = pricing_for(&model);
    let m = 1_000_000.0;
    stats.total_cost_usd = (stats.input_tokens as f64 / m) * p_in
        + (stats.output_tokens as f64 / m) * p_out
        + (stats.cache_creation_tokens as f64 / m) * p_cw
        + (stats.cache_read_tokens as f64 / m) * p_cr;
    stats
}

#[tauri::command]
pub async fn claude_session_stats(
    cwd: String,
    session_id: String,
) -> Result<ClaudeSessionStats, String> {
    tokio::task::spawn_blocking(move || -> Result<ClaudeSessionStats, String> {
        let folder = projects_dir()?.join(encode_cwd(&cwd));
        let path = folder.join(format!("{}.jsonl", session_id));
        Ok(compute_session_stats(&path, &session_id))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ───────────────────────── Project-wide usage ─────────────────────────

#[derive(Debug, Serialize)]
pub struct SessionUsage {
    #[serde(flatten)]
    pub stats: ClaudeSessionStats,
    /// File mtime in epoch milliseconds (formatted client-side).
    pub last_modified: Option<u64>,
    pub preview: String,
}

#[derive(Debug, Serialize, Default)]
pub struct UsageTotals {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub request_count: u64,
    pub total_cost_usd: f64,
    pub session_count: u64,
}

#[derive(Debug, Serialize)]
pub struct ProjectUsage {
    pub totals: UsageTotals,
    pub sessions: Vec<SessionUsage>,
}

/// First non-injected user line of a session, truncated for a preview label.
fn session_preview(path: &Path) -> String {
    let Ok(file) = std::fs::File::open(path) else {
        return String::new();
    };
    for line in BufReader::new(file).lines().flatten() {
        if let Some(text) = extract_first_user_text(&line) {
            let t: String = text.chars().take(80).collect();
            return t;
        }
    }
    String::new()
}

/// Aggregate token/cost usage across every Claude Code session of `cwd`.
/// One batched call rather than N per-session round-trips.
#[tauri::command]
pub async fn project_usage_stats(cwd: String) -> Result<ProjectUsage, String> {
    tokio::task::spawn_blocking(move || -> Result<ProjectUsage, String> {
        let folder = projects_dir()?.join(encode_cwd(&cwd));
        let mut sessions: Vec<SessionUsage> = Vec::new();
        let mut totals = UsageTotals::default();

        let Ok(entries) = std::fs::read_dir(&folder) else {
            // No sessions yet for this project — empty report, not an error.
            return Ok(ProjectUsage { totals, sessions });
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let stats = compute_session_stats(&path, id);
            // Skip empty sessions (no assistant turns) to keep the report tidy.
            if stats.request_count == 0 {
                continue;
            }
            totals.input_tokens += stats.input_tokens;
            totals.output_tokens += stats.output_tokens;
            totals.cache_creation_tokens += stats.cache_creation_tokens;
            totals.cache_read_tokens += stats.cache_read_tokens;
            totals.request_count += stats.request_count;
            totals.total_cost_usd += stats.total_cost_usd;
            totals.session_count += 1;

            let last_modified = std::fs::metadata(&path)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64);

            sessions.push(SessionUsage {
                preview: session_preview(&path),
                last_modified,
                stats,
            });
        }

        sessions.sort_by(|a, b| {
            b.stats
                .total_cost_usd
                .partial_cmp(&a.stats.total_cost_usd)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        Ok(ProjectUsage { totals, sessions })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ───────────────────────── Daily time-series (Mission Control) ─────────────

/// Per-day Claude usage accumulator (one entry per local calendar day).
#[derive(Default, Clone)]
pub(crate) struct ClaudeDay {
    pub input: u64,
    pub output: u64,
    pub cache_creation: u64,
    pub cache_read: u64,
    pub requests: u64,
    pub cost: f64,
}

/// All-time Claude metrics for one project: lifetime totals + a per-day series
/// + first/last activity (epoch ms). Cost is priced PER assistant turn using
/// that turn's own model (more accurate than the session-level approximation in
/// `compute_session_stats`). Used by the Mission Control dashboard aggregator.
pub(crate) struct ClaudeAgg {
    pub totals: UsageTotals,
    pub days: std::collections::BTreeMap<String, ClaudeDay>,
    pub first_ms: Option<i64>,
    pub last_ms: Option<i64>,
}

/// Parse a top-level message `timestamp` (ISO-8601) into (local "YYYY-MM-DD",
/// epoch ms). Returns None if absent/unparseable.
#[allow(dead_code)] // orphaned in #17, deleted in #14 — see the note above
fn day_and_ms(ts: &str) -> Option<(String, i64)> {
    let dt = chrono::DateTime::parse_from_rfc3339(ts).ok()?;
    let local = dt.with_timezone(&chrono::Local);
    Some((local.format("%Y-%m-%d").to_string(), dt.timestamp_millis()))
}

/// Walk every session JSONL under a project and fold per-day Claude usage.
#[allow(dead_code)] // orphaned in #17, deleted in #14 — see the note above
pub(crate) fn claude_project_agg(cwd: &str) -> ClaudeAgg {
    let mut agg = ClaudeAgg {
        totals: UsageTotals::default(),
        days: std::collections::BTreeMap::new(),
        first_ms: None,
        last_ms: None,
    };
    let Ok(folder) = projects_dir().map(|d| d.join(encode_cwd(cwd))) else {
        return agg;
    };
    let Ok(entries) = std::fs::read_dir(&folder) else {
        return agg;
    };
    let m = 1_000_000.0;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        // Fallback day if a line has no timestamp = the file's mtime day.
        let mtime_ms = std::fs::metadata(&path)
            .ok()
            .and_then(|md| md.modified().ok())
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64);

        let Ok(file) = std::fs::File::open(&path) else {
            continue;
        };
        let mut session_had_turns = false;
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            let v: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
                continue;
            }
            if v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true) {
                continue;
            }
            let Some(msg) = v.get("message") else { continue };
            let Some(usage) = msg.get("usage") else { continue };

            let input = usage.get("input_tokens").and_then(|n| n.as_u64()).unwrap_or(0);
            let output = usage.get("output_tokens").and_then(|n| n.as_u64()).unwrap_or(0);
            let cw = usage.get("cache_creation_input_tokens").and_then(|n| n.as_u64()).unwrap_or(0);
            let cr = usage.get("cache_read_input_tokens").and_then(|n| n.as_u64()).unwrap_or(0);
            let model = msg.get("model").and_then(|m| m.as_str()).unwrap_or("");
            let (p_in, p_out, p_cw, p_cr) = pricing_for(model);
            let cost = (input as f64 / m) * p_in
                + (output as f64 / m) * p_out
                + (cw as f64 / m) * p_cw
                + (cr as f64 / m) * p_cr;

            let (day, ms) = v
                .get("timestamp")
                .and_then(|t| t.as_str())
                .and_then(day_and_ms)
                .or_else(|| mtime_ms.map(|ms| (ms_to_local_day(ms), ms)))
                .unwrap_or_else(|| ("unknown".to_string(), 0));

            let d = agg.days.entry(day).or_default();
            d.input += input;
            d.output += output;
            d.cache_creation += cw;
            d.cache_read += cr;
            d.requests += 1;
            d.cost += cost;

            agg.totals.input_tokens += input;
            agg.totals.output_tokens += output;
            agg.totals.cache_creation_tokens += cw;
            agg.totals.cache_read_tokens += cr;
            agg.totals.request_count += 1;
            agg.totals.total_cost_usd += cost;

            if ms > 0 {
                agg.first_ms = Some(agg.first_ms.map_or(ms, |f| f.min(ms)));
                agg.last_ms = Some(agg.last_ms.map_or(ms, |l| l.max(ms)));
            }
            session_had_turns = true;
        }
        if session_had_turns {
            agg.totals.session_count += 1;
        }
    }
    agg
}

#[allow(dead_code)] // orphaned in #17, deleted in #14 — see the note above
fn ms_to_local_day(ms: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
        .map(|dt| dt.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

#[tauri::command]
pub async fn read_claude_session(file_path: String) -> Result<Vec<ChatMessageDump>, String> {
    tokio::task::spawn_blocking(move || -> Result<Vec<ChatMessageDump>, String> {
        let base = projects_dir()?;
        let p = Path::new(&file_path);
        if !p.starts_with(&base) {
            return Err("refusing to read: path outside ~/.claude/projects".into());
        }
        let file = std::fs::File::open(p).map_err(|e| e.to_string())?;
        let reader = BufReader::new(file);

        let mut out: Vec<ChatMessageDump> = Vec::new();
        for line in reader.lines().flatten() {
            let v: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
            let ts = v.get("timestamp").and_then(|t| t.as_str()).map(|s| s.to_string());

            // Skip sub-agent traffic entirely.
            if v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true) {
                continue;
            }
            match kind {
                "user" => {
                    if let Some(text) = extract_user_message_text(&v) {
                        out.push(ChatMessageDump {
                            role: "user".into(),
                            content: text,
                            timestamp: ts,
                            tool_calls: Vec::new(),
                        });
                    }
                }
                "assistant" => {
                    let (text, tool_calls) = extract_assistant_blocks(&v);
                    if !text.trim().is_empty() || !tool_calls.is_empty() {
                        out.push(ChatMessageDump {
                            role: "assistant".into(),
                            content: text,
                            timestamp: ts,
                            tool_calls,
                        });
                    }
                }
                _ => {}
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn extract_user_message_text(v: &serde_json::Value) -> Option<String> {
    // Skip sub-agent / warmup user lines entirely.
    if v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true) {
        return None;
    }
    let content = v.get("message")?.get("content")?;
    if let Some(s) = content.as_str() {
        if is_injected_user_text(s) {
            return None;
        }
        let cleaned = strip_injected_context(s);
        return if cleaned.is_empty() { None } else { Some(cleaned) };
    }
    if let Some(arr) = content.as_array() {
        // Skip blocks that are tool_result (they're tool replies, not real user input)
        let has_tool_result = arr.iter().any(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result"));
        if has_tool_result {
            return None;
        }
        let text: String = arr
            .iter()
            .filter_map(|b| {
                if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                    b.get("text").and_then(|t| t.as_str()).map(|s| s.to_string())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        if is_injected_user_text(&text) {
            return None;
        }
        let cleaned = strip_injected_context(&text);
        return if cleaned.is_empty() { None } else { Some(cleaned) };
    }
    None
}

fn extract_assistant_blocks(v: &serde_json::Value) -> (String, Vec<ToolCallDump>) {
    let mut text_parts: Vec<String> = Vec::new();
    let mut tool_calls: Vec<ToolCallDump> = Vec::new();
    let content = match v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array()) {
        Some(c) => c,
        None => return (String::new(), tool_calls),
    };
    for block in content {
        let btype = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match btype {
            "text" => {
                if let Some(s) = block.get("text").and_then(|t| t.as_str()) {
                    text_parts.push(s.to_string());
                }
            }
            "tool_use" => {
                let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("tool").to_string();
                let input = block.get("input").cloned().unwrap_or(serde_json::json!({}));
                tool_calls.push(ToolCallDump { tool_name: name, input });
            }
            _ => {}
        }
    }
    (text_parts.join("\n"), tool_calls)
}
