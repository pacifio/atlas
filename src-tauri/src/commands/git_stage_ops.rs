//! Hunk / line-level staging (GitHub Desktop's partial-commit primitives).
//!
//! The UI sends the hunk it DISPLAYED (marker + text per line); we re-diff
//! the file fresh, find the content-identical hunk (line numbers may have
//! drifted since the diff was rendered), synthesize a minimal patch via
//! `atlas_git::patch`, and pipe it to `git apply`:
//!   stage    → `apply --cached`          (patch from worktree-vs-index)
//!   unstage  → `apply --cached --reverse` (patch from index-vs-HEAD)
//!   discard  → `apply --reverse`          (patch from worktree-vs-index)

use atlas_git::{patch, GitCommand, GitErrorPayload};
use serde::Deserialize;
use std::path::Path;
use tauri::AppHandle;

use crate::commands::git_watcher::emit_synthetic_change;

/// One diff line as the UI displayed it. `kind`: "context" | "add" | "del".
#[derive(Debug, Deserialize)]
pub struct DisplayedLine {
    pub kind: String,
    pub text: String,
}

fn to_body(lines: &[DisplayedLine]) -> Vec<(u8, String)> {
    lines
        .iter()
        .map(|l| {
            let marker = match l.kind.as_str() {
                "add" => b'+',
                "del" => b'-',
                _ => b' ',
            };
            (marker, l.text.clone())
        })
        .collect()
}

enum SelOp {
    Stage,
    Unstage,
    Discard,
}

fn selection_op(
    app: &AppHandle,
    path: &str,
    file: &str,
    displayed: &[DisplayedLine],
    selected: Option<&[usize]>,
    op: SelOp,
) -> Result<(), GitErrorPayload> {
    let diff_args: Vec<&str> = match op {
        SelOp::Stage | SelOp::Discard => vec!["diff", "--no-color", "--", file],
        SelOp::Unstage => vec!["diff", "--cached", "--no-color", "--", file],
    };
    let out = GitCommand::new(path, &diff_args).read_only().run()?;
    let parsed = patch::parse_file_diff(&out.stdout).ok_or_else(|| {
        GitErrorPayload::internal("No changes found for this file — it may already be staged. Refresh and try again.")
    })?;
    if parsed.binary {
        return Err(GitErrorPayload::internal(
            "Binary files can't be partially staged — stage the whole file instead.",
        ));
    }

    let body = to_body(displayed);
    let idx = patch::find_matching_hunk(&parsed, &body).ok_or_else(|| {
        GitErrorPayload::internal(
            "This hunk changed since the diff was shown. Refresh and try again.",
        )
    })?;

    let patch_text = patch::line_selection_patch(&parsed, idx, selected).ok_or_else(|| {
        GitErrorPayload::internal("The selection contains no changed lines.")
    })?;

    let apply_args: Vec<&str> = match op {
        SelOp::Stage => vec!["apply", "--cached", "--whitespace=nowarn", "-"],
        SelOp::Unstage => vec!["apply", "--cached", "--reverse", "--whitespace=nowarn", "-"],
        SelOp::Discard => vec!["apply", "--reverse", "--whitespace=nowarn", "-"],
    };
    GitCommand::new(path, &apply_args)
        .stdin(patch_text.into_bytes())
        .run()?;
    emit_synthetic_change(app, Path::new(path));
    Ok(())
}

/// Stage one displayed hunk (or, with `selected`, a subset of its changed
/// lines — indices into the displayed line list).
#[tauri::command]
pub async fn git_stage_hunk(
    path: String,
    file: String,
    lines: Vec<DisplayedLine>,
    selected: Option<Vec<usize>>,
    app: AppHandle,
) -> Result<(), GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        selection_op(&app, &path, &file, &lines, selected.as_deref(), SelOp::Stage)
    })
    .await
    .map_err(|e| GitErrorPayload::internal(e.to_string()))?
}

/// Unstage one displayed hunk (or selected lines) from the index.
#[tauri::command]
pub async fn git_unstage_hunk(
    path: String,
    file: String,
    lines: Vec<DisplayedLine>,
    selected: Option<Vec<usize>>,
    app: AppHandle,
) -> Result<(), GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        selection_op(&app, &path, &file, &lines, selected.as_deref(), SelOp::Unstage)
    })
    .await
    .map_err(|e| GitErrorPayload::internal(e.to_string()))?
}

/// Discard one displayed hunk (or selected lines) from the working tree.
/// Destructive — the UI confirms before calling.
#[tauri::command]
pub async fn git_discard_hunk(
    path: String,
    file: String,
    lines: Vec<DisplayedLine>,
    selected: Option<Vec<usize>>,
    app: AppHandle,
) -> Result<(), GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        selection_op(&app, &path, &file, &lines, selected.as_deref(), SelOp::Discard)
    })
    .await
    .map_err(|e| GitErrorPayload::internal(e.to_string()))?
}
