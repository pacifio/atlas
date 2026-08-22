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

use super::agent_memory::{collect_codex_sessions, collect_corpus};
use super::claude::{list_claude_sessions, ClaudeSessionIndex};
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

#[tauri::command]
pub async fn memory_timeline(
    project_path: String,
    claude_index: State<'_, ClaudeSessionIndex>,
    host: State<'_, std::sync::Arc<AgentHost>>,
) -> Result<MemoryTimeline, String> {
    let pp = project_path.trim_end_matches('/').to_string();

    // Git (blocking) — branches + per-branch commits with real timestamps.
    let git_pp = pp.clone();
    let (branches, commits) = tokio::task::spawn_blocking(move || build_git(&git_pp))
        .await
        .map_err(|e| e.to_string())??;

    // Codex sessions carry git_branch/git_sha directly.
    let codex = collect_codex_sessions(&pp).await;
    // Claude sessions (reuse the cached lister); time-only, no branch.
    let claude = list_claude_sessions(pp.clone(), claude_index)
        .await
        .unwrap_or_default();
    // Memory events.
    let docs = collect_corpus(&pp).await;

    let mut sessions: Vec<TimelineSession> = Vec::new();
    for c in codex {
        sessions.push(TimelineSession {
            id: c.id,
            title: c.title,
            agent: "codex".into(),
            branch: c.branch,
            sha: c.sha,
            ts_ms: c.created_at_ms,
            end_ms: c.updated_at_ms.max(c.created_at_ms),
            detail: format!("{} · {} tok · {}", c.model, c.tokens, c.approval_mode),
        });
    }
    for s in claude {
        let ts = parse_iso_ms(s.started_at.as_deref().or(s.last_modified.as_deref()));
        let end = parse_iso_ms(s.last_modified.as_deref()).max(ts);
        sessions.push(TimelineSession {
            id: s.id,
            title: collapse(&s.preview),
            agent: "claude".into(),
            branch: None,
            sha: None,
            ts_ms: ts,
            end_ms: end,
            detail: format!("{} msgs", s.message_count),
        });
    }
    // Native Atlas (cersei) sessions — time-only, like Claude. The preview is
    // already injected-context-stripped by `cersei_list_sessions`.
    for s in host.native_sessions(&pp) {
        let ts = parse_iso_ms(s.started_at.as_deref().or(s.last_modified.as_deref()));
        let end = parse_iso_ms(s.last_modified.as_deref()).max(ts);
        let detail = if s.total_tokens > 0 {
            format!("{} msgs · {} tok", s.message_count, s.total_tokens)
        } else {
            format!("{} msgs", s.message_count)
        };
        sessions.push(TimelineSession {
            id: s.id,
            title: collapse(&s.preview),
            agent: "cersei".into(),
            branch: None,
            sha: None,
            ts_ms: ts,
            end_ms: end,
            detail,
        });
    }
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

fn parse_iso_ms(s: Option<&str>) -> i64 {
    s.and_then(|x| chrono::DateTime::parse_from_rfc3339(x).ok())
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0)
}

fn collapse(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}
