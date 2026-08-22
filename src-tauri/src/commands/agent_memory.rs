//! Agent memory on disk — what each ACP agent persists for the
//! current project, read-only.
//!
//! Claude Code keeps a per-project *markdown* memory folder at
//! `~/.claude/projects/<encoded-cwd>/memory/` (a `MEMORY.md` index plus one
//! `.md` file per fact with YAML frontmatter), alongside the classic
//! `CLAUDE.md` instruction files. Codex has no per-project markdown memory —
//! it keeps session state in SQLite (`~/.codex/state_*.sqlite`, `threads`
//! table keyed by `cwd`) plus repo `AGENTS.md`. So we render Claude as
//! markdown and Codex as a table of its prior threads in this project.
//!
//! Everything here is best-effort and read-only: missing files / DBs degrade
//! to empty sections rather than erroring the whole command.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use tokio::process::Command as AsyncCommand;

/// App config dir holding `cersei-sessions/` — set once at startup
/// (`install_manager`) so the corpus reader can find native-agent transcripts
/// without threading an `AppHandle` through `collect_corpus`'s many callers.
static CERSEI_CONFIG_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Record where the native agent persists its sessions (called from startup).
pub fn set_cersei_config_dir(dir: PathBuf) {
    let _ = CERSEI_CONFIG_DIR.set(dir);
}

#[derive(Debug, Serialize)]
pub struct MemoryFile {
    /// Raw filename (e.g. `feedback_terminal.md`).
    name: String,
    /// Frontmatter `name:` if present, else the filename stem.
    title: String,
    /// Frontmatter `description:` (one-liner).
    description: String,
    /// Frontmatter `metadata.type` (user / feedback / project / reference).
    kind: String,
    /// Full file contents, frontmatter stripped — ready for markdown render.
    body: String,
    modified_ms: u64,
}

#[derive(Debug, Serialize)]
pub struct ClaudeMemory {
    /// Absolute path of the `memory/` dir (shown in the UI, may not exist).
    memory_dir: String,
    /// `MEMORY.md` index contents, if present.
    index: Option<String>,
    /// Individual memory fact files (excludes `MEMORY.md`), title-sorted.
    entries: Vec<MemoryFile>,
    /// Repo-local `CLAUDE.md`.
    project_md: Option<String>,
    /// Global `~/.claude/CLAUDE.md`.
    global_md: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct CodexThread {
    #[serde(default)]
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    first_user_message: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    git_branch: Option<String>,
    #[serde(default)]
    git_sha: Option<String>,
    #[serde(default)]
    approval_mode: String,
    #[serde(default)]
    tokens_used: i64,
    #[serde(default)]
    created_at: i64,
    #[serde(default)]
    updated_at: i64,
}

#[derive(Debug, Serialize)]
pub struct CodexMemory {
    /// The state DB we read, if one was found.
    db_path: Option<String>,
    /// Repo-local `AGENTS.md`.
    agents_md: Option<String>,
    /// Global `~/.codex/AGENTS.md`.
    global_agents_md: Option<String>,
    /// Prior Codex threads whose `cwd` matches this project, newest first.
    threads: Vec<CodexThread>,
}


/// History-list row for a Codex session, shaped to match `ClaudeSessionMeta`
/// so the chat sidebar can merge both agents' sessions uniformly. `id` is the
/// Codex thread id — the exact identifier the codex-acp adapter resolves to a
/// rollout file in `session/load`, so it doubles as the resume key. There's no
/// single editable transcript file to expose, so `file_path` is empty.
#[derive(Debug, Clone, Serialize)]
pub struct CodexSessionMeta {
    pub id: String,
    pub file_path: String,
    pub started_at: Option<String>,
    pub last_modified: Option<String>,
    pub message_count: usize,
    pub preview: String,
}

/// Unix-ms → RFC3339 string, matching the `last_modified` format the Claude
/// listing uses so the sidebar's lexical date sort orders both agents together.
fn ms_to_rfc3339(ms: i64) -> Option<String> {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms).map(|dt| dt.to_rfc3339())
}

/// List the current project's Codex sessions for the chat history sidebar.
/// Sourced from the same `~/.codex` SQLite `threads` table as the memory tab
/// (via `collect_codex_sessions`), filtered to this `cwd`.
#[tauri::command]
pub async fn list_codex_sessions(cwd: String) -> Result<Vec<CodexSessionMeta>, String> {
    let cwd = cwd.trim_end_matches('/').to_string();
    let sessions = collect_codex_sessions(&cwd).await;
    let rows: Vec<CodexSessionMeta> = sessions
        .into_iter()
        .map(|s| {
            // The threads table has no message count; treat any session with a
            // title/preview or recorded token use as non-empty so it survives
            // the sidebar's `message_count > 0` visibility filter.
            let message_count = if !s.title.trim().is_empty() || s.tokens > 0 {
                1
            } else {
                0
            };
            CodexSessionMeta {
                id: s.id,
                file_path: String::new(),
                started_at: ms_to_rfc3339(s.created_at_ms),
                last_modified: ms_to_rfc3339(s.updated_at_ms),
                message_count,
                preview: s.title,
            }
        })
        .collect();
    Ok(rows)
}

/// Archive (soft-delete) one Codex session so it leaves the history sidebar.
/// Codex keeps threads in `~/.codex/state_<n>.sqlite` with no per-session file
/// to remove, so we set `archived = 1` — the same flag `list_codex_sessions`
/// filters on — rather than hard-deleting the row (recoverable, mirrors how
/// Codex itself hides threads).
#[tauri::command]
pub async fn codex_delete_session(session_id: String) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("no home dir")?;
    let codex_dir = home.join(".codex");
    let db = newest_state_db(&codex_dir).ok_or("no Codex state DB found in ~/.codex")?;
    // sqlite3's CLI can't bind params, so inline the id with the standard
    // single-quote escape (double it). Thread ids are uuids, but be safe.
    let escaped = session_id.replace('\'', "''");
    let sql = format!("UPDATE threads SET archived = 1 WHERE id = '{escaped}';");
    let out = AsyncCommand::new("sqlite3")
        .arg(&db)
        .arg(&sql)
        .output()
        .await
        .map_err(|e| format!("failed to run sqlite3: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "sqlite3 archive failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

// ── Corpus collection (for the Graph / embeddings feature) ──────────────────

/// One embeddable memory document, flattened across the Claude + Codex sources.
/// Reused by `memory_graph` to embed + relate the whole memory system.
#[derive(Debug, Clone)]
pub struct MemoryDoc {
    /// Stable id, e.g. `claude:feedback_x.md`, `codex:<thread-id>`.
    pub id: String,
    pub title: String,
    /// Natural-language one-liner for display (frontmatter `description`, the
    /// thread's first message, or the first body sentence) — far more readable
    /// than the slug `title` in the tree view. Falls back to `title` when empty.
    pub summary: String,
    pub kind: String,
    pub source: String, // "claude" | "codex"
    /// Absolute path of the editable file this doc came from (memory `.md`,
    /// `CLAUDE.md`, `AGENTS.md`). `None` for non-file sources (Codex threads).
    /// Used by the policy editor to rewrite the exact text in place.
    pub file_path: Option<String>,
    /// Unix ms when this memory came into being (file mtime / thread created_at).
    /// 0 when unknown. Drives the temporal influence graph.
    pub timestamp_ms: i64,
    /// Text to embed (title is prepended by the caller if desired).
    pub text: String,
    /// Names this doc can be referenced by in `[[wikilinks]]` (slug + stem).
    pub aliases: Vec<String>,
    /// `[[wikilink]]` targets found in this doc's body.
    pub links: Vec<String>,
}

/// Flatten Claude markdown memory + Codex threads into embeddable documents.
pub async fn collect_corpus(project_path: &str) -> Vec<MemoryDoc> {
    let project_path = project_path.trim_end_matches('/').to_string();

    let pp = project_path.clone();
    let claude = tokio::task::spawn_blocking(move || read_claude(&pp))
        .await
        .unwrap_or_else(|_| ClaudeMemory {
            memory_dir: String::new(),
            index: None,
            entries: Vec::new(),
            project_md: None,
            global_md: None,
        });
    let codex = read_codex(&project_path).await;

    let home = dirs::home_dir().unwrap_or_default();
    let mem_dir = std::path::Path::new(&claude.memory_dir);
    let mut docs: Vec<MemoryDoc> = Vec::new();

    if let Some(idx) = &claude.index {
        docs.push(MemoryDoc {
            id: "claude:MEMORY.md".into(),
            title: "Memory Index".into(),
            summary: "Index of every project memory".into(),
            kind: "index".into(),
            source: "claude".into(),
            file_path: Some(mem_dir.join("MEMORY.md").to_string_lossy().to_string()),
            timestamp_ms: file_mtime_ms(&mem_dir.join("MEMORY.md")),
            text: idx.clone(),
            aliases: vec!["MEMORY".into(), "MEMORY.md".into()],
            links: extract_wikilinks(idx),
        });
    }
    for e in &claude.entries {
        let stem = e.name.trim_end_matches(".md").to_string();
        let title = if e.title.is_empty() { stem.clone() } else { e.title.clone() };
        let body = if e.description.is_empty() {
            e.body.clone()
        } else {
            format!("{}\n\n{}", e.description, e.body)
        };
        let summary = if !e.description.trim().is_empty() {
            short_title(e.description.trim())
        } else {
            first_sentence(&e.body)
        };
        docs.push(MemoryDoc {
            id: format!("claude:{}", e.name),
            title,
            summary,
            kind: if e.kind.is_empty() { "memory".into() } else { e.kind.clone() },
            source: "claude".into(),
            file_path: Some(mem_dir.join(&e.name).to_string_lossy().to_string()),
            timestamp_ms: e.modified_ms as i64,
            text: body,
            aliases: vec![e.title.clone(), stem],
            links: extract_wikilinks(&e.body),
        });
    }
    if let Some(md) = &claude.project_md {
        docs.push(MemoryDoc {
            id: "claude:CLAUDE.md".into(),
            title: "CLAUDE.md".into(),
            summary: "Project instructions for agents".into(),
            kind: "instruction".into(),
            source: "claude".into(),
            file_path: Some(
                std::path::Path::new(&project_path)
                    .join("CLAUDE.md")
                    .to_string_lossy()
                    .to_string(),
            ),
            timestamp_ms: file_mtime_ms(&std::path::Path::new(&project_path).join("CLAUDE.md")),
            text: md.clone(),
            aliases: vec![],
            links: vec![],
        });
    }
    if let Some(md) = &claude.global_md {
        docs.push(MemoryDoc {
            id: "claude:CLAUDE.md@global".into(),
            title: "CLAUDE.md (global)".into(),
            summary: "Global agent instructions".into(),
            kind: "instruction".into(),
            source: "claude".into(),
            file_path: Some(home.join(".claude").join("CLAUDE.md").to_string_lossy().to_string()),
            timestamp_ms: file_mtime_ms(&home.join(".claude").join("CLAUDE.md")),
            text: md.clone(),
            aliases: vec![],
            links: vec![],
        });
    }

    if let Some(md) = &codex.agents_md {
        docs.push(MemoryDoc {
            id: "codex:AGENTS.md".into(),
            title: "AGENTS.md".into(),
            summary: "Project instructions for Codex".into(),
            kind: "instruction".into(),
            source: "codex".into(),
            file_path: Some(
                std::path::Path::new(&project_path)
                    .join("AGENTS.md")
                    .to_string_lossy()
                    .to_string(),
            ),
            timestamp_ms: file_mtime_ms(&std::path::Path::new(&project_path).join("AGENTS.md")),
            text: md.clone(),
            aliases: vec![],
            links: vec![],
        });
    }
    for t in &codex.threads {
        let text = if t.first_user_message.trim().is_empty() {
            t.title.clone()
        } else {
            t.first_user_message.clone()
        };
        if text.trim().is_empty() {
            continue;
        }
        let raw_title = if t.title.trim().is_empty() { &t.first_user_message } else { &t.title };
        docs.push(MemoryDoc {
            id: format!("codex:{}", t.id),
            title: short_title(raw_title),
            summary: short_title(raw_title),
            kind: "thread".into(),
            source: "codex".into(),
            file_path: None, // Codex threads live in SQLite, not an editable file.
            timestamp_ms: t.created_at.saturating_mul(1000),
            text,
            aliases: vec![],
            links: vec![],
        });
    }

    // Fold in the codebase index (current source: per-file structure + optional
    // LLM summaries) so the chat is grounded in how the code works *now*, not just
    // stale agent memory. Cheap disk read — the expensive scan/summarize happens
    // in the separate `codebase_index_build` command.
    docs.extend(read_codebase_docs(&project_path));
    docs.extend(read_shared_memory_docs(&project_path));
    docs.extend(read_cersei_docs(&project_path));
    // Fold the knowledge base in (source "note") so KB notes are retrievable by
    // every agent through the same embedding + the `search_memory` tool — they
    // were previously reachable ONLY via manual `~`/`@note` mentions.
    docs.extend(read_knowledge_docs(&project_path));
    // Capture-backed sessions for every agent WITHOUT a dedicated reader above
    // (opencode / cursor / kilo / any future ACP plugin) — see the fn doc.
    let pp = project_path.clone();
    docs.extend(
        tokio::task::spawn_blocking(move || read_capture_docs(&pp))
            .await
            .unwrap_or_default(),
    );

    docs
}

/// Agents whose sessions are already indexed by a dedicated, richer reader —
/// the capture fallback must skip them or every Claude/Codex/cersei session
/// would enter the corpus twice under two different sources.
fn capture_covered_agent(agent: &str) -> bool {
    agent.starts_with("claude") || agent == "codex" || agent == "cersei"
}

/// Generic corpus reader over Atlas's OWN capture store (`.atlas/sessions.db`,
/// atlas-checkpoint). The capture middleware records EVERY agent's sessions +
/// redacted message bodies with the plugin id in the `agent` column, so this
/// one reader gives opencode / cursor / kilo — and any future ACP plugin —
/// memory-corpus coverage with zero per-agent code. `source` is the plugin id
/// verbatim (it becomes the Graph corpus + the Memory tab's agent grouping).
/// No-op when capture is disabled for the project — those agents then
/// contribute only via the promoted shared-memory events, same as before.
fn read_capture_docs(project_path: &str) -> Vec<MemoryDoc> {
    use atlas_agents::transcript::strip_injected_context;
    const TEXT_CAP: usize = 12 * 1024;

    let store = match crate::commands::capture::open_reader(project_path) {
        Ok(Some(s)) => s,
        _ => return Vec::new(),
    };
    let sessions = match store.sessions_for_workspace(project_path) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(target: "atlas::memory", "capture corpus read failed: {e}");
            return Vec::new();
        }
    };

    let mut out: Vec<MemoryDoc> = Vec::new();
    for s in sessions {
        let Some(agent) = s.agent.as_deref() else {
            continue;
        };
        if capture_covered_agent(agent) {
            continue;
        }
        let messages = store.messages_for_session(&s.id).unwrap_or_default();
        // Transcript text from the always-inline 2 KB previews (bounded, role
        // tagged, injection-stripped) — parity between Codex's title-only docs
        // and cersei's full transcripts without pulling spilled blobs.
        let mut text = String::new();
        let mut first_user = String::new();
        for m in &messages {
            let clean = strip_injected_context(&m.preview);
            let clean = clean.trim();
            if clean.is_empty() {
                continue;
            }
            if first_user.is_empty() && m.role == atlas_checkpoint::Role::User {
                first_user = clean.to_string();
            }
            if text.len() < TEXT_CAP {
                text.push_str(m.role.as_str());
                text.push_str(": ");
                let room = TEXT_CAP - text.len().min(TEXT_CAP);
                text.extend(clean.chars().take(room));
                text.push('\n');
            }
        }
        let title_raw = s
            .title
            .as_deref()
            .map(strip_injected_context)
            .unwrap_or_default();
        let title_raw = title_raw.trim().to_string();
        let title_src = if title_raw.is_empty() { &first_user } else { &title_raw };
        if title_src.trim().is_empty() && text.trim().is_empty() {
            continue; // nothing indexable (e.g. a bound-but-never-messaged session)
        }
        out.push(MemoryDoc {
            id: format!("{agent}:{}", s.native_session_id),
            title: short_title(title_src),
            summary: short_title(if first_user.is_empty() { title_src } else { &first_user }),
            kind: "thread".into(),
            source: agent.to_string(),
            file_path: None, // capture rows live in SQLite, not an editable file
            timestamp_ms: s.updated_at.timestamp_millis(),
            text: if text.trim().is_empty() { title_src.clone() } else { text },
            aliases: vec![],
            links: vec![],
        });
    }
    out
}

/// Fold the project knowledge base (`.atlas/knowledge/**/*.md`) into the corpus
/// so KB notes rank alongside code + memory in retrieval. Tagged `source:"note"`
/// so the Shared Context layer can weight / toggle them independently.
fn read_knowledge_docs(project_path: &str) -> Vec<MemoryDoc> {
    let entries = match crate::commands::knowledge::list_knowledge_sync(project_path) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    entries
        .into_iter()
        .filter(|e| !e.content.trim().is_empty())
        .map(|e| {
            let summary = e
                .content
                .lines()
                .map(|l| l.trim_start_matches('#').trim())
                .find(|l| !l.is_empty())
                .unwrap_or(&e.title)
                .chars()
                .take(200)
                .collect::<String>();
            let stem = e.id.rsplit('/').next().unwrap_or(&e.id).to_string();
            let mut aliases = vec![stem];
            if !e.title.is_empty() && !aliases.contains(&e.title) {
                aliases.push(e.title.clone());
            }
            let timestamp_ms = chrono::DateTime::parse_from_rfc3339(&e.updated_at)
                .map(|d| d.timestamp_millis())
                .unwrap_or(0);
            MemoryDoc {
                id: format!("kb:{}", e.id),
                title: e.title,
                summary,
                kind: "note".into(),
                source: "note".into(),
                file_path: Some(e.file_path),
                timestamp_ms,
                text: e.content,
                aliases,
                links: vec![],
            }
        })
        .collect()
}

/// Fold native Atlas (cersei) session transcripts into the corpus so the
/// agent's conversations are searchable in Memory ▸ Chat / Graph — parity with
/// Codex threads. Atlas-injected context (memory blocks, mention bodies) is
/// stripped so the index holds the user's actual words, not the scaffolding.
fn read_cersei_docs(project_path: &str) -> Vec<MemoryDoc> {
    use atlas_agents::transcript::strip_injected_context;
    let Some(config_dir) = CERSEI_CONFIG_DIR.get() else {
        return Vec::new();
    };
    let mut out: Vec<MemoryDoc> = Vec::new();
    for s in atlas_agents::cersei_corpus_sessions(config_dir, project_path) {
        let title_raw = strip_injected_context(&s.first_user);
        let title_raw = title_raw.trim();
        if title_raw.is_empty() {
            continue;
        }
        let body = strip_injected_context(&s.transcript);
        let ts = chrono::DateTime::parse_from_rfc3339(&s.updated_at)
            .map(|dt| dt.timestamp_millis())
            .unwrap_or(0);
        out.push(MemoryDoc {
            id: format!("cersei:{}", s.id),
            title: short_title(title_raw),
            summary: short_title(title_raw),
            kind: "thread".into(),
            source: "cersei".into(),
            file_path: None, // Native sessions live in cersei-sessions JSON, not an editable file.
            timestamp_ms: ts,
            text: if body.trim().is_empty() {
                title_raw.to_string()
            } else {
                body
            },
            aliases: vec![],
            links: vec![],
        });
    }
    out
}

/// v3 Write half — surface the project's Shared Cross-Agent Memory (working
/// memory) into the index corpus, so settled decisions/failures/architecture/
/// facts become embeddable + retrievable (Tier 2 read path), not just
/// live-injected. Only durable kinds are promoted; the live plan + churn are
/// skipped. Reads the folded shared state from `.atlas/shared-memory/`; an
/// absent/empty store is a no-op. Stable ids (`shared:<kind>:<seq>`) namespace
/// these apart from the claude/codex docs, so re-runs don't duplicate.
fn read_shared_memory_docs(project_path: &str) -> Vec<MemoryDoc> {
    let state = super::shared_memory::rebuild_state(project_path);
    let ts = state.updated_at;
    let mut docs = Vec::new();
    for d in &state.decisions {
        docs.extend(shared_doc(d.seq, &d.agent, "decision", &d.text, ts));
    }
    for f in &state.failures {
        docs.extend(shared_doc(f.seq, &f.agent, "failure", &f.text, ts));
    }
    for a in &state.architecture {
        docs.extend(shared_doc(a.seq, &a.agent, "architecture", &a.text, ts));
    }
    for f in &state.facts {
        docs.extend(shared_doc(f.seq, &f.agent, "fact", &f.text, ts));
    }
    docs
}

/// Build one promoted shared-memory [`MemoryDoc`]. `None` for empty text.
fn shared_doc(seq: u64, agent: &str, kind: &str, text: &str, ts: i64) -> Option<MemoryDoc> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    Some(MemoryDoc {
        id: format!("shared:{kind}:{seq}"),
        title: short_title(t),
        summary: short_title(t),
        kind: kind.to_string(),
        source: "shared".into(),
        file_path: None,
        timestamp_ms: ts,
        text: format!("[{agent}] {t}"),
        aliases: Vec::new(),
        links: Vec::new(),
    })
}

#[cfg(test)]
mod shared_promo_tests {
    use super::shared_doc;

    #[test]
    fn maps_kind_source_and_id() {
        let d = shared_doc(7, "codex", "decision", "Use RS256 for JWT", 100).unwrap();
        assert_eq!(d.id, "shared:decision:7");
        assert_eq!(d.kind, "decision");
        assert_eq!(d.source, "shared");
        assert!(d.text.contains("[codex]"));
        assert!(d.text.contains("RS256"));
    }

    #[test]
    fn empty_text_is_none() {
        assert!(shared_doc(1, "a", "fact", "   ", 0).is_none());
    }
}

/// Map the persisted codebase index (`.atlas/codebase-index/docs.json`) into
/// embeddable `MemoryDoc`s for the unified corpus.
fn read_codebase_docs(project_path: &str) -> Vec<MemoryDoc> {
    atlas_codeindex::load_index(project_path)
        .docs
        .into_iter()
        .map(|d| {
            let summary = if d.summary.trim().is_empty() {
                format!("{} · {} symbols", d.language, d.symbols.len())
            } else {
                d.summary.clone()
            };
            let aliases = atlas_codeindex::aliases(&d.rel, &d.symbols);
            MemoryDoc {
                id: format!("codebase:{}", d.rel),
                title: d.rel,
                summary,
                kind: "file".into(),
                source: "codebase".into(),
                file_path: Some(d.abs_path),
                timestamp_ms: d.mtime_ms,
                text: d.text,
                aliases,
                links: vec![],
            }
        })
        .collect()
}

/// A Codex session with its recorded git context — the strong agent→branch→
/// commit link for the timeline (Codex stamps `git_branch`/`git_sha` per run).
#[derive(Debug, Clone, Serialize)]
pub struct CodexSession {
    pub id: String,
    pub title: String,
    pub branch: Option<String>,
    pub sha: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub model: String,
    pub tokens: i64,
    pub approval_mode: String,
}

/// Codex sessions for a project (from the SQLite `threads` table), mapped to a
/// timeline-friendly shape.
pub async fn collect_codex_sessions(project_path: &str) -> Vec<CodexSession> {
    let codex = read_codex(project_path.trim_end_matches('/')).await;
    codex
        .threads
        .into_iter()
        .map(|t| CodexSession {
            title: short_title(if t.title.trim().is_empty() {
                &t.first_user_message
            } else {
                &t.title
            }),
            id: t.id,
            branch: t.git_branch.filter(|b| !b.is_empty()),
            sha: t.git_sha.filter(|s| !s.is_empty()),
            created_at_ms: t.created_at.saturating_mul(1000),
            updated_at_ms: t.updated_at.saturating_mul(1000),
            model: t.model,
            tokens: t.tokens_used,
            approval_mode: t.approval_mode,
        })
        .collect()
}

/// File mtime as unix ms, or 0 if unavailable.
fn file_mtime_ms(path: &std::path::Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// First meaningful line of a markdown body as a short NL summary (skips blank
/// lines, strips heading/list/quote markers). Used when a memory has no
/// frontmatter `description`.
fn first_sentence(s: &str) -> String {
    for line in s.lines() {
        let t = line
            .trim()
            .trim_start_matches('#')
            .trim_start_matches(['-', '*', '>', ' '])
            .trim();
        if !t.is_empty() {
            return short_title(t);
        }
    }
    String::new()
}

/// Strip the appended Atlas-context block, collapse whitespace, truncate.
fn short_title(s: &str) -> String {
    let cut = s.split("\n---\n").next().unwrap_or(s);
    let collapsed: String = cut.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > 80 {
        let head: String = collapsed.chars().take(80).collect();
        format!("{head}…")
    } else {
        collapsed
    }
}

/// Pull `[[name]]` (and `[[name|alias]]` → name) targets out of a body.
fn extract_wikilinks(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = s;
    while let Some(start) = rest.find("[[") {
        rest = &rest[start + 2..];
        if let Some(end) = rest.find("]]") {
            let inner = &rest[..end];
            let name = inner.split('|').next().unwrap_or(inner).trim();
            if !name.is_empty() {
                out.push(name.to_string());
            }
            rest = &rest[end + 2..];
        } else {
            break;
        }
    }
    out
}

/// `/Users/adib/Desktop/atlas` → `-Users-adib-Desktop-atlas` (Claude's
/// per-project dir naming: every `/` becomes `-`).
pub(crate) fn encode_project_dir(project_path: &str) -> String {
    project_path.replace('/', "-")
}

/// The per-project Claude memory dir (`~/.claude/projects/<encoded>/memory`) —
/// the bulk of the memory corpus, and therefore a directory the indexer's FS
/// watcher must cover (the project cwd alone never sees these writes).
pub(crate) fn claude_memory_dir(project_path: &str) -> std::path::PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".claude")
        .join("projects")
        .join(encode_project_dir(project_path))
        .join("memory")
}

fn read_claude(project_path: &str) -> ClaudeMemory {
    let home = dirs::home_dir().unwrap_or_default();
    let mem_dir = claude_memory_dir(project_path);

    let index = std::fs::read_to_string(mem_dir.join("MEMORY.md")).ok();

    let mut entries: Vec<MemoryFile> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&mem_dir) {
        for ent in rd.flatten() {
            let path = ent.path();
            let fname = ent.file_name().to_string_lossy().to_string();
            if fname == "MEMORY.md" {
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let Ok(raw) = std::fs::read_to_string(&path) else {
                continue;
            };
            let modified_ms = ent
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let (meta, body) = parse_frontmatter(&raw);
            let stem = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| fname.clone());
            entries.push(MemoryFile {
                name: fname,
                title: meta.name.unwrap_or(stem),
                description: meta.description.unwrap_or_default(),
                kind: meta.kind.unwrap_or_default(),
                body,
                modified_ms,
            });
        }
    }
    // Stable, human order: type then title.
    entries.sort_by(|a, b| a.kind.cmp(&b.kind).then(a.title.cmp(&b.title)));

    let project_md = std::fs::read_to_string(Path::new(project_path).join("CLAUDE.md")).ok();
    let global_md = std::fs::read_to_string(home.join(".claude").join("CLAUDE.md")).ok();

    ClaudeMemory {
        memory_dir: mem_dir.to_string_lossy().to_string(),
        index,
        entries,
        project_md,
        global_md,
    }
}

#[derive(Default)]
struct Frontmatter {
    name: Option<String>,
    description: Option<String>,
    kind: Option<String>,
}

/// Minimal YAML-frontmatter reader. We only need three scalar fields
/// (`name`, `description`, `metadata.type`), so a line scan beats pulling in
/// a YAML crate. Returns the parsed fields and the body with the frontmatter
/// block removed.
fn parse_frontmatter(raw: &str) -> (Frontmatter, String) {
    let mut fm = Frontmatter::default();
    let trimmed = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let lines: Vec<&str> = trimmed.lines().collect();
    if lines.first().map(|l| l.trim_end()) != Some("---") {
        return (fm, raw.to_string());
    }
    // Locate the closing fence (first "---" after line 0).
    let Some(close) = lines.iter().skip(1).position(|l| l.trim_end() == "---") else {
        return (fm, raw.to_string()); // unterminated → all body
    };
    let close = close + 1; // un-skip

    let mut in_metadata = false;
    for line in &lines[1..close] {
        let indented = line.starts_with(' ') || line.starts_with('\t');
        let kv = line.trim();
        if kv == "metadata:" {
            in_metadata = true;
            continue;
        }
        if let Some((k, v)) = kv.split_once(':') {
            let key = k.trim();
            let val = v.trim().trim_matches('"').trim_matches('\'').to_string();
            match key {
                "name" if !indented => fm.name = Some(val),
                "description" if !indented => fm.description = Some(val),
                "type" if in_metadata && indented => fm.kind = Some(val),
                _ => {}
            }
        }
    }

    let body = lines[close + 1..].join("\n");
    let body = body.trim_start_matches(['\n', '\r']).to_string();
    (fm, body)
}

async fn read_codex(project_path: &str) -> CodexMemory {
    let home = dirs::home_dir().unwrap_or_default();
    let codex_dir = home.join(".codex");

    let agents_md = tokio::fs::read_to_string(Path::new(project_path).join("AGENTS.md"))
        .await
        .ok();
    let global_agents_md = tokio::fs::read_to_string(codex_dir.join("AGENTS.md"))
        .await
        .ok();

    let db = newest_state_db(&codex_dir);
    let threads = match &db {
        Some(p) => query_codex_threads(p, project_path).await,
        None => Vec::new(),
    };

    CodexMemory {
        db_path: db.map(|p| p.to_string_lossy().to_string()),
        agents_md,
        global_agents_md,
        threads,
    }
}

/// Pick the highest-versioned `state_<n>.sqlite` in `~/.codex` (the schema is
/// versioned; the newest is the live one). Skips `-wal`/`-shm` sidecars.
fn newest_state_db(codex_dir: &Path) -> Option<PathBuf> {
    let rd = std::fs::read_dir(codex_dir).ok()?;
    let mut best: Option<(u64, PathBuf)> = None;
    for ent in rd.flatten() {
        let name = ent.file_name().to_string_lossy().to_string();
        let Some(rest) = name.strip_prefix("state_") else {
            continue;
        };
        let Some(num) = rest.strip_suffix(".sqlite") else {
            continue;
        };
        let ver: u64 = num.parse().unwrap_or(0);
        if best.as_ref().map(|(b, _)| ver > *b).unwrap_or(true) {
            best = Some((ver, ent.path()));
        }
    }
    best.map(|(_, p)| p)
}

async fn query_codex_threads(db: &Path, project_path: &str) -> Vec<CodexThread> {
    let db = db.to_path_buf();
    let project_path = project_path.to_string();

    // In-process read via rusqlite. The Codex DB is WAL, so a read-only
    // connection reads concurrently with the agent's writes WITHOUT blocking —
    // the old `sqlite3`-CLI read could land mid-`new_session` write, fail with
    // SQLITE_BUSY, and we'd return an empty Vec → the sidebar's Codex history
    // flickered to 0 on every switch (and the subprocess spawn added latency).
    // Bound parameter (no SQL string interpolation). rusqlite is blocking, so
    // it runs on the blocking pool.
    let result = tokio::task::spawn_blocking(move || -> rusqlite::Result<Vec<CodexThread>> {
        let conn = rusqlite::Connection::open_with_flags(
            &db,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        // Safety net for a brief WAL-checkpoint lock; WAL reads normally don't block.
        conn.busy_timeout(std::time::Duration::from_millis(3000))?;
        let mut stmt = conn.prepare(
            "SELECT id, title, first_user_message, model, git_branch, git_sha, \
             approval_mode, tokens_used, created_at, updated_at FROM threads \
             WHERE cwd = ?1 AND archived = 0 ORDER BY updated_at DESC LIMIT 300",
        )?;
        let rows = stmt.query_map([&project_path], |row| {
            Ok(CodexThread {
                id: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                first_user_message: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                model: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                git_branch: row.get::<_, Option<String>>(4)?,
                git_sha: row.get::<_, Option<String>>(5)?,
                approval_mode: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                tokens_used: row.get::<_, Option<i64>>(7)?.unwrap_or_default(),
                created_at: row.get::<_, Option<i64>>(8)?.unwrap_or_default(),
                updated_at: row.get::<_, Option<i64>>(9)?.unwrap_or_default(),
            })
        })?;
        rows.collect()
    })
    .await;

    let mut threads = match result {
        Ok(Ok(t)) => t,
        Ok(Err(e)) => {
            tracing::warn!(target: "atlas::history", "codex rusqlite read failed: {e}");
            return Vec::new();
        }
        Err(e) => {
            tracing::warn!(target: "atlas::history", "codex read task join failed: {e}");
            return Vec::new();
        }
    };
    // Strip Atlas-injected context blocks the agent recorded in the prompt, so
    // they never surface as a session preview/title (mirrors the Claude reader).
    for t in &mut threads {
        t.first_user_message =
            atlas_agents::transcript::strip_injected_context(&t.first_user_message);
    }
    threads
}
