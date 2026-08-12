//! AI code-review commands — the Tauri bridge over the `atlas-review` engine.
//!
//! The frontend calls `review_start` with a diff `source`; Rust resolves the
//! BYOK key + git diff and drives the Cersei-backed reviewer, which reviews each
//! changed file with its own agent then synthesizes an overall report + a
//! Mermaid architecture diagram. Progress streams over `atlas:review` events
//! (`file_started`, `file_done`, `delta`, `complete`, `error`) tagged by review
//! id. Completed reports are persisted to `<project>/.atlas/reviews.json`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use atlas_review::{
    run_report, CancellationToken, FileVerdict, ReviewEvent, ReviewOptions, ReviewReport,
    DEFAULT_MAX_INPUT_TOKENS,
};

use super::byok;

// ── State ───────────────────────────────────────────────────────────────────

/// Cancellation tokens for in-flight reviews, keyed by review id.
#[derive(Default)]
pub struct ReviewState {
    inflight: Mutex<HashMap<String, CancellationToken>>,
}

impl ReviewState {
    pub fn new() -> Self {
        Self::default()
    }
}

// ── Streaming events ─────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum ReviewEvt {
    FileStarted { path: String },
    FileDone { verdict: FileVerdict },
    /// A single file's review failed — non-fatal, the run continues.
    FileError { message: String },
    Delta { delta: String },
    Complete { record: ReviewRecord },
    /// The whole review failed.
    Error { message: String },
}

#[derive(Serialize, Clone)]
struct Envelope {
    id: String,
    #[serde(flatten)]
    event: ReviewEvt,
}

fn emit(app: &AppHandle, id: &str, event: ReviewEvt) {
    let _ = app.emit("atlas:review", Envelope { id: id.to_string(), event });
}

// ── Persisted record ─────────────────────────────────────────────────────────

/// A completed review, persisted under `.atlas/reviews.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRecord {
    pub id: String,
    pub title: String,
    pub provider: String,
    pub model: String,
    pub created_at: String,
    pub report: ReviewReport,
}

// ── Diff source ──────────────────────────────────────────────────────────────

/// Which diff to review, chosen in the UI.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ReviewSource {
    /// Uncommitted changes vs HEAD (working tree).
    Working,
    /// Staged changes only.
    Staged,
    /// A single commit.
    Commit { sha: String },
    /// A commit range `from..to`.
    Range { from: String, to: String },
    /// The whole branch vs its base (diff against the merge-base).
    Branch { base: Option<String> },
}

fn git(path: &str, args: &[&str]) -> Result<String, String> {
    // Read-only, every caller — `--no-optional-locks` keeps a review's diff
    // reads from taking `.git/index.lock` out from under a concurrent commit.
    // See the note on `git_read` in `commands/git.rs`.
    let out = Command::new("git")
        .arg("--no-optional-locks")
        .args(args)
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Best-guess base branch for a branch review: remote default → main → master.
fn detect_base(path: &str) -> Option<String> {
    if let Ok(s) = git(path, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]) {
        let s = s.trim();
        if !s.is_empty() {
            return Some(s.to_string());
        }
    }
    for cand in ["main", "master", "develop"] {
        let exists = git(path, &["rev-parse", "--verify", "--quiet", cand])
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        if exists {
            return Some(cand.to_string());
        }
    }
    None
}

/// Resolve `(raw_diff, human_title)` for a source. Blocking; call off-thread.
fn resolve_diff(path: &str, source: &ReviewSource) -> Result<(String, String), String> {
    match source {
        ReviewSource::Working => {
            let diff = git(path, &["diff", "--no-color", "HEAD"])?;
            Ok((diff, "Working tree changes".to_string()))
        }
        ReviewSource::Staged => {
            let diff = git(path, &["diff", "--no-color", "--cached"])?;
            Ok((diff, "Staged changes".to_string()))
        }
        ReviewSource::Commit { sha } => {
            let diff = git(path, &["show", "--no-color", "--format=", sha])?;
            let subject = git(path, &["show", "-s", "--format=%s", sha])
                .unwrap_or_default()
                .trim()
                .to_string();
            let short = sha.chars().take(7).collect::<String>();
            let title = if subject.is_empty() {
                format!("Commit {short}")
            } else {
                format!("{short} — {subject}")
            };
            Ok((diff, title))
        }
        ReviewSource::Range { from, to } => {
            let diff = git(path, &["diff", "--no-color", &format!("{from}..{to}")])?;
            Ok((diff, format!("{from}..{to}")))
        }
        ReviewSource::Branch { base } => {
            let base = base
                .clone()
                .filter(|b| !b.trim().is_empty())
                .or_else(|| detect_base(path))
                .ok_or_else(|| "could not determine a base branch".to_string())?;
            let merge_base = git(path, &["merge-base", &base, "HEAD"])?.trim().to_string();
            if merge_base.is_empty() {
                return Err(format!("no common ancestor with {base}"));
            }
            let diff = git(path, &["diff", "--no-color", &format!("{merge_base}..HEAD")])?;
            let branch = git(path, &["rev-parse", "--abbrev-ref", "HEAD"])
                .unwrap_or_default()
                .trim()
                .to_string();
            Ok((diff, format!("{base} … {branch}")))
        }
    }
}

// ── Persistence ──────────────────────────────────────────────────────────────

const MAX_PERSISTED: usize = 50;

fn store_path(project: &str) -> PathBuf {
    PathBuf::from(project).join(".atlas").join("reviews.json")
}

fn load_records(project: &str) -> Vec<ReviewRecord> {
    std::fs::read_to_string(store_path(project))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_record(project: &str, record: &ReviewRecord) {
    let mut records = load_records(project);
    records.retain(|r| r.id != record.id);
    records.insert(0, record.clone());
    records.truncate(MAX_PERSISTED);
    let path = store_path(project);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(&records) {
        let _ = std::fs::write(path, json);
    }
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// BYOK providers that both have a key configured AND the reviewer can drive.
#[tauri::command]
pub fn review_providers(app: AppHandle) -> Vec<String> {
    byok::byok_list(app)
        .into_iter()
        .map(|m| m.provider)
        .filter(|p| atlas_review::is_supported(p))
        .collect()
}

/// Candidate base branches + the detected default, for the Branch-mode picker.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseBranches {
    branches: Vec<String>,
    default: Option<String>,
}

#[tauri::command]
pub async fn review_base_branches(project: String) -> Result<BaseBranches, String> {
    tokio::task::spawn_blocking(move || {
        let mut branches: Vec<String> = git(&project, &["branch", "--format=%(refname:short)"])
            .unwrap_or_default()
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
        if let Ok(r) = git(&project, &["branch", "-r", "--format=%(refname:short)"]) {
            for l in r.lines() {
                let l = l.trim();
                if !l.is_empty() && !l.contains("->") {
                    branches.push(l.to_string());
                }
            }
        }
        branches.sort();
        branches.dedup();
        let default = detect_base(&project);
        Ok(BaseBranches { branches, default })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// List persisted reviews for a project, newest first.
#[tauri::command]
pub fn review_list(project: String) -> Vec<ReviewRecord> {
    load_records(&project)
}

/// Fetch one persisted review by id.
#[tauri::command]
pub fn review_get(project: String, id: String) -> Option<ReviewRecord> {
    load_records(&project).into_iter().find(|r| r.id == id)
}

/// Cancel an in-flight review.
#[tauri::command]
pub fn review_cancel(state: State<'_, ReviewState>, id: String) {
    if let Some(tok) = state.inflight.lock().get(&id) {
        tok.cancel();
    }
}

/// Start a review. Resolves the diff + key, streams `atlas:review` events, and
/// on success persists the report. Resolves when the review finishes.
#[tauri::command]
pub async fn review_start(
    app: AppHandle,
    state: State<'_, ReviewState>,
    id: String,
    project: String,
    provider: String,
    model: String,
    source: ReviewSource,
) -> Result<(), String> {
    let key = byok::byok_get(app.clone(), provider.clone())?
        .ok_or_else(|| format!("No API key configured for {provider}"))?;

    let (raw_diff, title) = {
        let project = project.clone();
        tokio::task::spawn_blocking(move || resolve_diff(&project, &source))
            .await
            .map_err(|e| e.to_string())??
    };
    if raw_diff.trim().is_empty() {
        return Err("Nothing to review for the selected source.".to_string());
    }

    let cancel = CancellationToken::new();
    state.inflight.lock().insert(id.clone(), cancel.clone());

    let on_event: Arc<dyn Fn(ReviewEvent) + Send + Sync> = {
        let app = app.clone();
        let id = id.clone();
        Arc::new(move |ev: ReviewEvent| match ev {
            ReviewEvent::FileStarted { path } => emit(&app, &id, ReviewEvt::FileStarted { path }),
            ReviewEvent::FileDone { verdict } => emit(&app, &id, ReviewEvt::FileDone { verdict }),
            ReviewEvent::Delta(d) => emit(&app, &id, ReviewEvt::Delta { delta: d }),
            ReviewEvent::Thinking(_) => {}
            // Engine `Error` events are per-file (non-fatal); the run continues.
            // A fatal failure surfaces as the `run_report` Err below.
            ReviewEvent::Error(e) => emit(&app, &id, ReviewEvt::FileError { message: e }),
        })
    };

    let opts = ReviewOptions {
        provider: provider.clone(),
        model: model.clone(),
        api_key: key,
        raw_diff,
        title: Some(title.clone()),
        language: None,
        max_input_tokens: DEFAULT_MAX_INPUT_TOKENS,
    };

    let result = run_report(opts, cancel.clone(), on_event).await;
    state.inflight.lock().remove(&id);

    match result {
        Ok(report) => {
            let record = ReviewRecord {
                id: id.clone(),
                title,
                provider,
                model,
                created_at: chrono::Utc::now().to_rfc3339(),
                report,
            };
            let project_for_save = project.clone();
            let record_for_save = record.clone();
            let _ = tokio::task::spawn_blocking(move || {
                save_record(&project_for_save, &record_for_save)
            })
            .await;
            app.state::<std::sync::Arc<crate::telemetry::TelemetryClient>>()
                .capture(
                    "code_review_completed",
                    serde_json::json!({ "provider": &record.provider, "model": &record.model }),
                );
            emit(&app, &id, ReviewEvt::Complete { record });
            Ok(())
        }
        Err(e) => {
            if cancel.is_cancelled() {
                Ok(())
            } else {
                emit(&app, &id, ReviewEvt::Error { message: e.clone() });
                Err(e)
            }
        }
    }
}
