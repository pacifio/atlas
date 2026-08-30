//! `memory_timeline` — assemble a branch-aware timeline of git commits, agent
//! sessions, and memory events for a project, so a team can see how the agents
//! (Claude Code / Codex via Atlas) and recorded preferences are shaping the
//! codebase over time. Pure git + metadata; no embedding model needed.
//!
//! Branch attribution for commits is heuristic: each commit is claimed by the
//! first branch (current branch first, then most-recently-active) whose history
//! contains it, so shared history isn't duplicated across lanes.

use std::collections::HashSet;
use std::process::Command;

use serde::{Deserialize, Serialize};
use tauri::State;

use super::agent_host::AgentHost;

use super::agent_memory::collect_corpus;
use super::git::git_refs_compute;

/// Per-branch commit cap (keeps large repos snappy).
const PER_BRANCH_LIMIT: usize = 200;

#[derive(Debug, Serialize, Deserialize)]
pub struct TimelineBranch {
    name: String,
    is_current: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TimelineCommit {
    sha: String,
    short: String,
    message: String,
    branch: String,
    ts_ms: i64,
    refs: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TimelineSession {
    id: String,
    title: String,
    agent: String, // "codex" | "claude" | "cersei" | a capture plugin id ("opencode"/"cursor"/"kilo")
    branch: Option<String>,
    sha: Option<String>,
    ts_ms: i64,
    /// Session end (last activity); == ts_ms when unknown. Drives the Gantt bar.
    end_ms: i64,
    detail: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TimelineMemory {
    id: String,
    title: String,
    source: String,
    kind: String,
    ts_ms: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MemoryTimeline {
    branches: Vec<TimelineBranch>,
    commits: Vec<TimelineCommit>,
    sessions: Vec<TimelineSession>,
    memory: Vec<TimelineMemory>,
}

/// The timeline's session lane.
///
/// One source, not three. This used to merge a scrape of Claude's JSONL, a
/// scrape of Codex's state database, and the native agent's own list — the
/// same six-source pattern the sidebar had, with the same consequences: an
/// agent nobody had written a reader for was invisible here, and Atlas read
/// two other programs' private storage to draw its own UI. The
/// thread-metadata store knows every agent's sessions, whoever ran them
/// (ADR-0001).
///
/// What it does not know is how big a session was. The old rows carried
/// "N msgs" / "N tok" straight out of the files being scraped; the store holds
/// metadata only, by design. That detail is dropped rather than guessed at.
#[tauri::command]
pub async fn memory_timeline(
    project_path: String,
    host: State<'_, std::sync::Arc<AgentHost>>,
) -> Result<MemoryTimeline, String> {
    let pp = project_path.trim_end_matches('/').to_string();

    // Git (blocking) — branches + per-branch commits with real timestamps.
    let git_pp = pp.clone();
    let (branches, commits) = tokio::task::spawn_blocking(move || build_git(&git_pp))
        .await
        .map_err(|e| e.to_string())??;

    // Memory events.
    let docs = collect_corpus(&pp).await;

    // Every agent's sessions for this project, from Atlas's own record.
    let mut sessions: Vec<TimelineSession> = Vec::new();
    if let Some(history) = host.history() {
        let paths = atlas_thread_metadata::PathList::new(&[&pp]);
        for thread in history.store().threads_for_path(&paths) {
            let ts = thread
                .created_at
                .unwrap_or(thread.updated_at)
                .timestamp_millis();
            sessions.push(TimelineSession {
                id: thread
                    .session_id
                    .as_ref()
                    .map(|id| id.0.to_string())
                    .unwrap_or_else(|| thread.thread_id.to_string()),
                title: collapse(&thread.display_title()),
                agent: thread.agent_id.as_str().to_string(),
                // The store holds no git identity. Nothing did for Claude or
                // the native agent either; only the Codex scrape carried it,
                // and it went with the scrape.
                branch: None,
                sha: None,
                ts_ms: ts,
                end_ms: thread.updated_at.timestamp_millis().max(ts),
                detail: String::new(),
            });
        }
    }
    // A second pass over the native agent's own session files used to run here,
    // contributing the message/token detail the store does not hold. It is gone
    // with the Cersei runtime that wrote those files (#54): the engine keeps its
    // own working storage in a different shape, and reading it would recreate
    // the scrape-reader pattern ADR-0001 removed.
    //
    // The narrowing is D8's, and accepted: native rows still appear here, from
    // the thread-metadata store above, without the size detail. Where that
    // detail gets re-sourced from is spec open question 8.

    // Capture-backed agents (opencode/cursor/kilo/future plugins) — sessions
    // from Atlas's own capture store; skip agents that already have a dedicated
    // loop above so nothing lands twice.
    let cap_pp = pp.clone();
    let capture_sessions = tokio::task::spawn_blocking(move || {
        let store = match crate::commands::capture::open_reader(&cap_pp) {
            Ok(Some(s)) => s,
            _ => return Vec::new(),
        };
        store.sessions_for_workspace(&cap_pp).unwrap_or_default()
    })
    .await
    .unwrap_or_default();
    for s in capture_sessions {
        let Some(agent) = s.agent.clone() else { continue };
        if agent.starts_with("claude") || agent == "codex" || agent == "cersei" {
            continue;
        }
        let title = s
            .title
            .as_deref()
            .map(|t| collapse(&atlas_agent_transcript::strip_injected_context(t)))
            .unwrap_or_default();
        sessions.push(TimelineSession {
            id: s.native_session_id,
            title: if title.is_empty() { "Untitled session".into() } else { title },
            agent,
            branch: s.branch,
            sha: None,
            ts_ms: s.started_at.timestamp_millis(),
            end_ms: s.updated_at.timestamp_millis().max(s.started_at.timestamp_millis()),
            detail: s.model.unwrap_or_default(),
        });
    }
    sessions.retain(|s| s.ts_ms > 0);
    sessions.sort_by(|a, b| a.ts_ms.cmp(&b.ts_ms));

    let mut memory: Vec<TimelineMemory> = docs
        .into_iter()
        .filter(|d| d.timestamp_ms > 0)
        .map(|d| TimelineMemory {
            id: d.id,
            title: d.title,
            source: d.source,
            kind: d.kind,
            ts_ms: d.timestamp_ms,
        })
        .collect();
    memory.sort_by(|a, b| a.ts_ms.cmp(&b.ts_ms));

    let result = MemoryTimeline {
        branches,
        commits,
        sessions,
        memory,
    };
    // Persist so a fresh app launch can render instantly from disk while a
    // background refresh recomputes (optimistic UI).
    write_cache(&pp, &result);
    Ok(result)
}

fn cache_path(project_path: &str) -> std::path::PathBuf {
    std::path::Path::new(project_path)
        .join(".atlas")
        .join("memory-index")
        .join("timeline.json")
}

fn write_cache(project_path: &str, t: &MemoryTimeline) {
    let path = cache_path(project_path);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string(t) {
        let _ = std::fs::write(path, json);
    }
}

/// Read the last-persisted timeline for the project (instant; no git/sqlite),
/// so the UI can paint immediately and refresh in the background. `None` if
/// there's no cache yet.
#[tauri::command]
pub async fn memory_timeline_cached(project_path: String) -> Result<Option<MemoryTimeline>, String> {
    let pp = project_path.trim_end_matches('/').to_string();
    Ok(std::fs::read_to_string(cache_path(&pp))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok()))
}

fn build_git(path: &str) -> Result<(Vec<TimelineBranch>, Vec<TimelineCommit>), String> {
    let refs = git_refs_compute(path)?;
    let current = refs.head_ref.clone();

    // Local branches with their tip commit time (unix seconds), for ordering.
    let out = Command::new("git")
        .args([
            "for-each-ref",
            "--format=%(refname:short)\x1f%(committerdate:unix)",
            "refs/heads",
        ])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;
    let txt = String::from_utf8_lossy(&out.stdout);
    let mut ordered: Vec<(String, i64)> = txt
        .lines()
        .filter_map(|l| {
            let mut it = l.split('\x1f');
            let name = it.next()?.trim().to_string();
            if name.is_empty() {
                return None;
            }
            let ts = it.next().and_then(|s| s.trim().parse::<i64>().ok()).unwrap_or(0);
            Some((name, ts))
        })
        .collect();
    // Order for first-claiming attribution: the trunk must claim the shared
    // mainline FIRST, otherwise whatever branch goes first (e.g. the current
    // branch, which usually contains all of history) greedily claims every
    // ancestor and the other branches render empty. So: well-known trunk names
    // first, then the rest oldest-tip-first (bases before their descendants).
    // Each later branch then only claims commits unique to it.
    const TRUNK_PRIORITY: [&str; 4] = ["main", "master", "develop", "trunk"];
    let trunk_rank = |name: &str| TRUNK_PRIORITY.iter().position(|t| *t == name);
    ordered.sort_by(|a, b| match (trunk_rank(&a.0), trunk_rank(&b.0)) {
        (Some(x), Some(y)) => x.cmp(&y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.1.cmp(&b.1), // oldest tip first
    });

    let mut claimed: HashSet<String> = HashSet::new();
    let mut commits: Vec<TimelineCommit> = Vec::new();
    let mut branches: Vec<TimelineBranch> = Vec::new();

    for (name, _) in &ordered {
        branches.push(TimelineBranch {
            name: name.clone(),
            is_current: current.as_deref() == Some(name.as_str()),
        });

        let log = Command::new("git")
            .args([
                "log",
                &format!("-{PER_BRANCH_LIMIT}"),
                name,
                "--pretty=format:%H\x1f%ct\x1f%s\x1f%D",
            ])
            .current_dir(path)
            .output()
            .map_err(|e| e.to_string())?;
        let body = String::from_utf8_lossy(&log.stdout);
        for line in body.lines() {
            let parts: Vec<&str> = line.split('\x1f').collect();
            if parts.len() < 3 {
                continue;
            }
            let sha = parts[0].trim().to_string();
            if sha.is_empty() || claimed.contains(&sha) {
                continue;
            }
            claimed.insert(sha.clone());
            let ts_ms = parts[1].trim().parse::<i64>().map(|s| s * 1000).unwrap_or(0);
            let message = parts[2].to_string();
            let refs: Vec<String> = parts
                .get(3)
                .map(|d| {
                    d.split(',')
                        .map(|r| r.trim().trim_start_matches("HEAD -> ").to_string())
                        .filter(|r| !r.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            let short: String = sha.chars().take(7).collect();
            commits.push(TimelineCommit {
                sha,
                short,
                message,
                branch: name.clone(),
                ts_ms,
                refs,
            });
        }
    }

    Ok((branches, commits))
}

// `parse_iso_ms` lived here for the native-session pass removed in #54.

fn collapse(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}
