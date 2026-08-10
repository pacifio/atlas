//! Conflict-resolution commands for the in-progress-operation flow
//! (merge / rebase / cherry-pick / revert).
//!
//! Ported from GitHub Desktop's model: conflicted paths come from porcelain
//! v2 `u` entries, per-file "N conflicts remaining" from `git diff --check`
//! (exit 2 = markers found, an expected code), and ours/theirs resolution is
//! `git checkout --ours|--theirs` + `git add` — unless the chosen side
//! DELETED the file, in which case it's `git rm` (stage.ts / rm.ts).

use atlas_git::{conflicts, status as gstatus, GitCommand, GitErrorPayload};
use serde::Serialize;
use std::path::Path;
use tauri::AppHandle;

use crate::commands::git_watcher::emit_synthetic_change;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    /// Leftover `<<<<<<<` markers. 0 = user already resolved in an editor
    /// (or the conflict is binary/deletion-shaped and has no markers).
    pub marker_count: u32,
    /// Unmerged XY code ("UU", "DU", "AA", …) for side-aware resolution.
    pub xy: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictState {
    pub files: Vec<ConflictFile>,
    /// Prepared commit message (`.git/MERGE_MSG`), if any.
    pub message: String,
}

fn join_err(e: tokio::task::JoinError) -> GitErrorPayload {
    GitErrorPayload::internal(e.to_string())
}

/// Conflicted files + marker counts + the prepared merge message.
#[tauri::command]
pub async fn git_conflict_state(path: String) -> Result<ConflictState, GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        let status = GitCommand::new(&path, &["status", "--porcelain=2", "-z"])
            .read_only()
            .run()?;
        let parsed = gstatus::parse(status.stdout.as_bytes());

        // Marker counts — only worth a spawn when something is unmerged.
        let unmerged: Vec<&gstatus::StatusEntry> =
            parsed.entries.iter().filter(|e| e.unmerged.is_some()).collect();
        let counts = if unmerged.is_empty() {
            Default::default()
        } else {
            let check = GitCommand::new(&path, &["diff", "--check"])
                .read_only()
                .success_codes(&[0, 2])
                .run()?;
            conflicts::parse_conflict_check(&check.stdout)
        };

        let files = unmerged
            .iter()
            .map(|e| ConflictFile {
                path: e.path.clone(),
                marker_count: counts.get(&e.path).copied().unwrap_or(0),
                xy: e.unmerged.clone().unwrap_or_else(|| "UU".into()),
            })
            .collect();

        let git_dir = GitCommand::new(&path, &["rev-parse", "--absolute-git-dir"])
            .read_only()
            .run()?
            .stdout
            .trim()
            .to_string();
        let message = ["MERGE_MSG", "SQUASH_MSG"]
            .iter()
            .find_map(|f| std::fs::read_to_string(Path::new(&git_dir).join(f)).ok())
            .map(|m| {
                // Strip git's `#` commentary lines.
                m.lines().filter(|l| !l.starts_with('#')).collect::<Vec<_>>().join("\n").trim().to_string()
            })
            .unwrap_or_default();

        Ok(ConflictState { files, message })
    })
    .await
    .map_err(join_err)?
}

/// Resolve one conflicted file. `resolution`: "ours" | "theirs" | "manual".
/// "manual" marks the user's on-disk state as resolved (`git add`).
#[tauri::command]
pub async fn git_resolve_file(
    path: String,
    file: String,
    resolution: String,
    app: AppHandle,
) -> Result<(), GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        if resolution == "ours" || resolution == "theirs" {
            // Side-aware: if the chosen side deleted the file, resolving to
            // it means removing the file, not checking it out.
            let status = GitCommand::new(&path, &["status", "--porcelain=2", "-z", "--", &file])
                .read_only()
                .run()?;
            let parsed = gstatus::parse(status.stdout.as_bytes());
            let xy = parsed
                .entries
                .iter()
                .find(|e| e.path == file)
                .and_then(|e| e.unmerged.clone())
                .unwrap_or_else(|| "UU".into());
            let (us, them) = conflicts::unmerged_sides(&xy);
            let chosen = if resolution == "ours" { us } else { them };

            if chosen == 'D' {
                GitCommand::new(&path, &["rm", "--force", "--", &file]).run()?;
                emit_synthetic_change(&app, Path::new(&path));
                return Ok(());
            }
            let flag = if resolution == "ours" { "--ours" } else { "--theirs" };
            GitCommand::new(&path, &["checkout", flag, "--", &file]).run()?;
        }
        GitCommand::new(&path, &["add", "--", &file]).run()?;
        emit_synthetic_change(&app, Path::new(&path));
        Ok(())
    })
    .await
    .map_err(join_err)?
}
