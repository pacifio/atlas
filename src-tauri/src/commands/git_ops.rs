//! Extended git operations for the unified Source-Control manager.
//!
//! Mirrors the dugite-shaped CLI calls GitHub Desktop uses, executed through
//! the `atlas-git` chokepoint (real git binary, so hooks run; failures come
//! back as typed [`GitErrorPayload`]s with friendly messages instead of raw
//! stderr). `GIT_TERMINAL_PROMPT=0` is set by the executor so a missing
//! credential fails fast with a routable `auth-failed` error instead of
//! hanging on a tty prompt. Mutating commands emit `atlas:git-changed` via
//! the watcher helper so the UI refreshes live; long operations additionally
//! stream their output as `atlas:git:op` events (see [`git_commit_v2`]).

use atlas_git::{GitCommand, GitErrorCode, GitErrorPayload};
use serde::Serialize;
use std::path::Path;
use tauri::{AppHandle, Emitter};

use crate::commands::git_watcher::emit_synthetic_change;

const US: char = '\u{1f}'; // unit separator for --format parsing

/// Run git in `path`, returning stdout. Failures are classified into a
/// typed payload by the `atlas-git` executor.
fn git_out(path: &str, args: &[&str]) -> Result<String, GitErrorPayload> {
    Ok(GitCommand::new(path, args).run()?.stdout)
}

/// Run a mutating git command, then notify the watcher so listeners refresh.
fn git_mut(app: &AppHandle, path: &str, args: &[&str]) -> Result<String, GitErrorPayload> {
    let out = git_out(path, args)?;
    emit_synthetic_change(app, Path::new(path));
    Ok(out)
}

/// spawn_blocking join failure → internal payload (never a raw string).
fn join_err(e: tokio::task::JoinError) -> GitErrorPayload {
    GitErrorPayload::internal(e.to_string())
}

// ── Read models ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub is_current: bool,
    /// True for `refs/remotes/*` entries (e.g. `origin/main`). Local checkout
    /// of one should use the short name so git creates a tracking branch.
    pub is_remote: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub subject: String,
    pub date: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoteInfo {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct StashEntry {
    pub index: u32,
    pub message: String,
    pub branch: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub email: String,
    pub date: String,
    pub subject: String,
    pub body: String,
    pub diff: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InProgress {
    pub merge: bool,
    pub rebase: bool,
    pub cherry_pick: bool,
    pub revert: bool,
}

// ── Branches ─────────────────────────────────────────────────────────────

/// Parse git's `%(upstream:track)` ("[ahead 2, behind 1]" / "[gone]") into
/// (ahead, behind).
fn parse_track(track: &str) -> (u32, u32) {
    let mut ahead = 0;
    let mut behind = 0;
    let inner = track.trim_start_matches('[').trim_end_matches(']');
    for part in inner.split(',') {
        let part = part.trim();
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.trim().parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.trim().parse().unwrap_or(0);
        }
    }
    (ahead, behind)
}

#[tauri::command]
pub async fn git_branches_full(path: String) -> Result<Vec<BranchInfo>, GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        let fmt = format!(
            "%(refname:short){US}%(HEAD){US}%(upstream:short){US}%(upstream:track){US}%(contents:subject){US}%(committerdate:relative){US}%(refname)"
        );
        // Local heads AND remote-tracking branches, so the switcher can search
        // and check out e.g. `origin/feature-x` (parity with the Review panel).
        let out = git_out(
            &path,
            &[
                "for-each-ref",
                "--sort=-committerdate",
                &format!("--format={fmt}"),
                "refs/heads",
                "refs/remotes",
            ],
        )?;
        let branches = out
            .lines()
            .filter(|l| !l.is_empty())
            .filter_map(|line| {
                let p: Vec<&str> = line.split(US).collect();
                let name = p.first().copied().unwrap_or("").to_string();
                let full_ref = p.get(6).copied().unwrap_or("");
                // Drop the symbolic `refs/remotes/origin/HEAD` pointer (its short
                // name collapses to just `origin`, so filter on the full ref).
                if name.is_empty() || full_ref.ends_with("/HEAD") {
                    return None;
                }
                let is_remote = full_ref.starts_with("refs/remotes/");
                let track = p.get(3).copied().unwrap_or("");
                let (ahead, behind) = parse_track(track);
                let upstream = p.get(2).copied().unwrap_or("");
                Some(BranchInfo {
                    name,
                    is_current: p.get(1).is_some_and(|h| h.trim() == "*"),
                    is_remote,
                    upstream: if upstream.is_empty() {
                        None
                    } else {
                        Some(upstream.to_string())
                    },
                    ahead,
                    behind,
                    subject: p.get(4).copied().unwrap_or("").to_string(),
                    date: p.get(5).copied().unwrap_or("").to_string(),
                })
            })
            .collect();
        Ok(branches)
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub async fn git_rename_branch(
    path: String,
    old_name: String,
    new_name: String,
    app: AppHandle,
) -> Result<(), GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        git_mut(&app, &path, &["branch", "-m", &old_name, &new_name])?;
        Ok(())
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub async fn git_branch_delete(
    path: String,
    name: String,
    force: bool,
    app: AppHandle,
) -> Result<(), GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        let flag = if force { "-D" } else { "-d" };
        git_mut(&app, &path, &["branch", flag, &name])?;
        Ok(())
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub async fn git_merge_branch(path: String, branch: String, app: AppHandle) -> Result<String, GitErrorPayload> {
    tokio::task::spawn_blocking(move || git_mut(&app, &path, &["merge", "--no-edit", &branch]))
        .await
        .map_err(join_err)?
}

/// Dry-run preview of merging `branch` into the current branch — what GitHub
/// Desktop shows under the branch picker before you confirm. Read-only: runs
/// no mutating git, so it takes no `AppHandle` and emits no change event.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePreview {
    /// "clean" | "conflicts" | "uptodate" | "invalid" | "unsupported"
    ///   - clean:       merges with no conflicts
    ///   - conflicts:   would produce `conflicted_files` conflicts
    ///   - uptodate:    nothing to merge (0 commits)
    ///   - invalid:     unrelated histories (no merge base)
    ///   - unsupported: git too old for `merge-tree --write-tree` preview;
    ///                  the merge can still be attempted, we just can't
    ///                  predict conflicts ahead of time
    pub kind: String,
    /// Commits on `branch` not yet on the current branch (what merging brings in).
    pub commit_count: u32,
    /// Number of files that would conflict (only meaningful when kind == "conflicts").
    pub conflicted_files: u32,
}

fn merge_preview(path: &str, branch: &str) -> Result<MergePreview, GitErrorPayload> {
    let head = git_out(path, &["rev-parse", "HEAD"])?.trim().to_string();
    let theirs = git_out(path, &["rev-parse", "--verify", &format!("{branch}^{{commit}}")])
        .map_err(|_| GitErrorPayload::internal(format!("branch '{branch}' not found")))?
        .trim()
        .to_string();

    // Unrelated histories → no common ancestor → merge would refuse.
    // `merge-base` exits 1 on no ancestor — an accepted outcome, not an error.
    let base = GitCommand::new(path, &["merge-base", &head, &theirs])
        .read_only()
        .success_codes(&[0, 1])
        .run()?;
    if base.exit_code != 0 {
        return Ok(MergePreview { kind: "invalid".into(), commit_count: 0, conflicted_files: 0 });
    }

    // Commits that merging would bring in: on `branch` but not on HEAD.
    let commit_count = git_out(path, &["rev-list", "--count", &format!("{head}..{theirs}")])?
        .trim()
        .parse::<u32>()
        .unwrap_or(0);
    if commit_count == 0 {
        return Ok(MergePreview { kind: "uptodate".into(), commit_count: 0, conflicted_files: 0 });
    }

    // Conflict detection via `git merge-tree --write-tree` (git 2.38+, with
    // `--name-only` in 2.40+). Exit 1 = conflicts; usage errors (unsupported
    // flags on an older git) surface as other non-zero codes.
    let mt = GitCommand::new(
        path,
        &[
            "merge-tree",
            "--write-tree",
            "--name-only",
            "--no-messages",
            "-z",
            &head,
            &theirs,
        ],
    )
    .read_only()
    .success_codes(&[0, 1, 2, 128, 129])
    .run()?;

    if mt.exit_code == 0 {
        return Ok(MergePreview { kind: "clean".into(), commit_count, conflicted_files: 0 });
    }

    // Non-zero: conflicts (exit 1) OR the flags are unsupported on an older git
    // (usage error / exit 129). Degrade gracefully so the merge stays available.
    let stderr = &mt.stderr;
    if stderr.contains("usage:") || stderr.contains("unknown option") || stderr.contains("not a valid option") {
        return Ok(MergePreview { kind: "unsupported".into(), commit_count, conflicted_files: 0 });
    }

    // Conflict output (`-z`, `--name-only`): `<tree-oid>\0` then each conflicted
    // path `\0`-separated. Drop empties (section separators); first field is the
    // oid, the rest are the conflicted files.
    let mut fields = mt.stdout.split('\0').filter(|s| !s.is_empty());
    let _oid = fields.next();
    let conflicted_files = fields.count() as u32;
    Ok(MergePreview { kind: "conflicts".into(), commit_count, conflicted_files })
}

#[tauri::command]
pub async fn git_merge_preview(path: String, branch: String) -> Result<MergePreview, GitErrorPayload> {
    tokio::task::spawn_blocking(move || merge_preview(&path, &branch))
        .await
        .map_err(join_err)?
}

// ── Remote sync ──────────────────────────────────────────────────────────
//
// Network ops run `--progress` and stream through `atlas:git:op` when the
// caller supplies an `op_id` (percent parsed by `atlas_git::progress` with
// GitHub Desktop's weighted step tables); without one they run buffered,
// keeping older call sites working.

fn run_remote_op(
    app: &AppHandle,
    path: &str,
    kind: &'static str,
    op_id: Option<String>,
    args: &[&str],
) -> Result<String, GitErrorPayload> {
    let Some(id) = op_id else {
        return git_mut(app, path, args);
    };
    let emitter = OpEmitter::new(app.clone(), id, path.to_string(), kind);
    emitter.started();
    let sink = ProgressSink {
        emitter: &emitter,
        parser: std::sync::Mutex::new(atlas_git::progress::ProgressParser::new(
            &atlas_git::progress::steps_for(kind),
        )),
    };
    let result = GitCommand::new(path, args).run_streaming(&sink);
    emit_synthetic_change(app, Path::new(path));
    match result {
        Ok(o) => {
            emitter.done(None);
            Ok(o.stdout)
        }
        Err(e) => {
            emitter.done(Some(&e));
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn git_fetch(
    path: String,
    op_id: Option<String>,
    app: AppHandle,
) -> Result<String, GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        run_remote_op(&app, &path, "fetch", op_id, &["fetch", "--all", "--prune", "--progress"])
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub async fn git_pull(
    path: String,
    rebase: bool,
    remote: Option<String>,
    op_id: Option<String>,
    app: AppHandle,
) -> Result<String, GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        let mut args = vec!["pull", "--progress"];
        if rebase {
            args.push("--rebase");
        }
        if let Some(r) = remote.as_deref() {
            args.push(r);
        }
        run_remote_op(&app, &path, "pull", op_id, &args)
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub async fn git_push(
    path: String,
    force_with_lease: bool,
    follow_tags: bool,
    remote: Option<String>,
    op_id: Option<String>,
    app: AppHandle,
) -> Result<String, GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        let mut args = vec!["push", "--progress"];
        if force_with_lease {
            args.push("--force-with-lease");
        }
        if follow_tags {
            args.push("--follow-tags");
        }
        if let Some(r) = remote.as_deref() {
            args.push(r);
        }
        run_remote_op(&app, &path, "push", op_id, &args)
    })
    .await
    .map_err(join_err)?
}

/// Push the current branch to a remote (default `origin`) and set upstream.
#[tauri::command]
pub async fn git_publish_branch(
    path: String,
    remote: Option<String>,
    op_id: Option<String>,
    app: AppHandle,
) -> Result<String, GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        let r = remote.unwrap_or_else(|| "origin".into());
        run_remote_op(&app, &path, "push", op_id, &["push", "--progress", "-u", &r, "HEAD"])
    })
    .await
    .map_err(join_err)?
}

/// Rebase the current branch onto `base`, streaming output (`Rebasing
/// (n/m)` lines land in the live strip). Conflicts pause the rebase — the
/// in-progress banner + conflicts view take over, and continue/abort go
/// through `git_op_control` as usual. Previously only `pull --rebase`
/// existed; a real branch rebase was missing entirely.
#[tauri::command]
pub async fn git_rebase(
    path: String,
    base: String,
    op_id: Option<String>,
    app: AppHandle,
) -> Result<String, GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        run_remote_op(&app, &path, "rebase", op_id, &["rebase", &base])
    })
    .await
    .map_err(join_err)?
}

/// Undo the last commit (`reset --soft HEAD~1` — changes return to the
/// index). Refused when the commit is already on the upstream: rewriting
/// pushed history needs an explicit force-push decision, not an "undo".
#[tauri::command]
pub async fn git_undo_commit(path: String, app: AppHandle) -> Result<(), GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        // HEAD must have a parent.
        GitCommand::new(&path, &["rev-parse", "--verify", "HEAD~1"])
            .read_only()
            .run()
            .map_err(|_| GitErrorPayload::internal("The first commit of a repository can't be undone."))?;
        // Not already pushed: with an upstream, ahead must be ≥ 1.
        let ahead = GitCommand::new(&path, &["rev-list", "--count", "@{upstream}..HEAD"])
            .read_only()
            .success_codes(&[0, 128])
            .run()?;
        if ahead.exit_code == 0 && ahead.stdout.trim().parse::<u32>().unwrap_or(0) == 0 {
            return Err(GitErrorPayload::internal(
                "This commit is already pushed. Revert it instead of undoing it.",
            ));
        }
        git_mut(&app, &path, &["reset", "--soft", "HEAD~1"])?;
        Ok(())
    })
    .await
    .map_err(join_err)?
}

/// Squash the last `count` commits into one with `message`. Implemented as
/// `reset --soft HEAD~N` + a fresh commit — equivalent to an interactive
/// tail squash, without the todo-file machinery. Refused when the range
/// reaches into pushed history (same guard as undo).
#[tauri::command]
pub async fn git_squash_last(
    path: String,
    count: u32,
    summary: String,
    description: Option<String>,
    app: AppHandle,
) -> Result<(), GitErrorPayload> {
    if count < 2 {
        return Err(GitErrorPayload::internal("Squash needs at least 2 commits."));
    }
    tokio::task::spawn_blocking(move || {
        GitCommand::new(&path, &["rev-parse", "--verify", &format!("HEAD~{count}")])
            .read_only()
            .run()
            .map_err(|_| GitErrorPayload::internal("Not enough commits to squash."))?;
        let ahead = GitCommand::new(&path, &["rev-list", "--count", "@{upstream}..HEAD"])
            .read_only()
            .success_codes(&[0, 128])
            .run()?;
        if ahead.exit_code == 0 && ahead.stdout.trim().parse::<u32>().unwrap_or(0) < count {
            return Err(GitErrorPayload::internal(
                "Some of these commits are already pushed — squashing would rewrite shared history.",
            ));
        }

        GitCommand::new(&path, &["reset", "--soft", &format!("HEAD~{count}")]).run()?;
        let mut message = summary.trim().to_string();
        if let Some(d) = description.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
            message.push_str("\n\n");
            message.push_str(d);
        }
        message.push('\n');
        let commit = GitCommand::new(&path, &["commit", "-F", "-"])
            .stdin(message.into_bytes())
            .run();
        emit_synthetic_change(&app, Path::new(&path));
        commit?;
        Ok(())
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub async fn git_remotes(path: String) -> Result<Vec<RemoteInfo>, GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        let out = git_out(&path, &["remote", "-v"])?;
        let mut seen = std::collections::HashSet::new();
        let mut remotes = Vec::new();
        for line in out.lines() {
            // "origin\turl (fetch)"
            let mut it = line.split_whitespace();
            let (Some(name), Some(url)) = (it.next(), it.next()) else {
                continue;
            };
            if seen.insert(name.to_string()) {
                remotes.push(RemoteInfo {
                    name: name.to_string(),
                    url: url.to_string(),
                });
            }
        }
        Ok(remotes)
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub async fn git_remote_add(
    path: String,
    name: String,
    url: String,
    app: AppHandle,
) -> Result<(), GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        git_mut(&app, &path, &["remote", "add", &name, &url])?;
        Ok(())
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub async fn git_remote_remove(path: String, name: String, app: AppHandle) -> Result<(), GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        git_mut(&app, &path, &["remote", "remove", &name])?;
        Ok(())
    })
    .await
    .map_err(join_err)?
}

// ── Stash ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn git_stash_list(path: String) -> Result<Vec<StashEntry>, GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        let out = git_out(
            &path,
            &["stash", "list", &format!("--format=%gd{US}%gs")],
        )?;
        let stashes = out
            .lines()
            .filter(|l| !l.is_empty())
            .enumerate()
            .map(|(i, line)| {
                let p: Vec<&str> = line.split(US).collect();
                let gs = p.get(1).copied().unwrap_or("");
                // "WIP on main: abc1234 message" → branch = "main"
                let branch = gs
                    .strip_prefix("WIP on ")
                    .or_else(|| gs.strip_prefix("On "))
                    .and_then(|s| s.split(':').next())
                    .unwrap_or("")
                    .to_string();
                StashEntry {
                    index: i as u32,
                    message: gs.to_string(),
                    branch,
                }
            })
            .collect();
        Ok(stashes)
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub async fn git_stash_push(
    path: String,
    message: Option<String>,
    app: AppHandle,
) -> Result<(), GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        let mut args = vec!["stash".to_string(), "push".to_string()];
        if let Some(m) = message.filter(|m| !m.trim().is_empty()) {
            args.push("-m".into());
            args.push(m);
        }
        let argv: Vec<&str> = args.iter().map(std::string::String::as_str).collect();
        git_mut(&app, &path, &argv)?;
        Ok(())
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub async fn git_stash_apply(path: String, index: u32, app: AppHandle) -> Result<(), GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        git_mut(&app, &path, &["stash", "apply", &format!("stash@{{{index}}}")])?;
        Ok(())
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub async fn git_stash_pop(path: String, index: u32, app: AppHandle) -> Result<(), GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        git_mut(&app, &path, &["stash", "pop", &format!("stash@{{{index}}}")])?;
        Ok(())
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub async fn git_stash_drop(path: String, index: u32, app: AppHandle) -> Result<(), GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        git_mut(&app, &path, &["stash", "drop", &format!("stash@{{{index}}}")])?;
        Ok(())
    })
    .await
    .map_err(join_err)?
}

// ── Working tree / history ops ───────────────────────────────────────────

/// Discard tracked changes (staged + worktree) for `files`, back to HEAD.
/// Untracked files are left alone (deleting them is destructive).
#[tauri::command]
pub async fn git_discard(path: String, files: Vec<String>, app: AppHandle) -> Result<(), GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        let mut args = vec![
            "restore".to_string(),
            "--staged".to_string(),
            "--worktree".to_string(),
            "--".to_string(),
        ];
        args.extend(files);
        let argv: Vec<&str> = args.iter().map(std::string::String::as_str).collect();
        git_mut(&app, &path, &argv)?;
        Ok(())
    })
    .await
    .map_err(join_err)?
}

/// "Revert" ADDED files (new / untracked). There's no HEAD version to restore,
/// so `git restore` fails — reverting an addition means removing it. Drops any
/// staged index entry (`--cached --ignore-unmatch`, so untracked files are a
/// no-op rather than an error) and deletes the working-tree copy. Used by the
/// Source Control revert button for added files (incl. binaries like `.png`
/// that have no diff and can only be reverted by deletion).
#[tauri::command]
pub async fn git_delete_added(
    path: String,
    files: Vec<String>,
    app: AppHandle,
) -> Result<(), GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        // Remove from the index if it was staged-new; ignore untracked ones.
        let mut args = vec![
            "rm".to_string(),
            "-f".to_string(),
            "--cached".to_string(),
            "--ignore-unmatch".to_string(),
            "--".to_string(),
        ];
        args.extend(files.clone());
        let argv: Vec<&str> = args.iter().map(std::string::String::as_str).collect();
        let _ = git_mut(&app, &path, &argv);
        // Delete the working-tree copies.
        for f in &files {
            let abs = Path::new(&path).join(f);
            if abs.exists() {
                std::fs::remove_file(&abs).map_err(|e| GitErrorPayload::internal(format!("Failed to delete {f}: {e}")))?;
            }
        }
        Ok(())
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub async fn git_reset(
    path: String,
    target: String,
    mode: String,
    app: AppHandle,
) -> Result<(), GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        let flag = match mode.as_str() {
            "soft" => "--soft",
            "hard" => "--hard",
            _ => "--mixed",
        };
        git_mut(&app, &path, &["reset", flag, &target])?;
        Ok(())
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub async fn git_revert(path: String, sha: String, app: AppHandle) -> Result<String, GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        // Plain revert first; merge commits need a parent (-m 1).
        match git_mut(&app, &path, &["revert", "--no-edit", &sha]) {
            Ok(o) => Ok(o),
            Err(e)
                if e.raw_stderr.contains("is a merge") || e.raw_stderr.contains("mainline") =>
            {
                git_mut(&app, &path, &["revert", "--no-edit", "-m", "1", &sha])
            }
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub async fn git_cherry_pick(path: String, sha: String, app: AppHandle) -> Result<String, GitErrorPayload> {
    tokio::task::spawn_blocking(move || git_mut(&app, &path, &["cherry-pick", &sha]))
        .await
        .map_err(join_err)?
}

// ── Tags ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn git_tags(path: String) -> Result<Vec<String>, GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        let out = git_out(&path, &["tag", "--sort=-creatordate"])?;
        Ok(out.lines().filter(|l| !l.is_empty()).map(String::from).collect())
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub async fn git_create_tag(
    path: String,
    name: String,
    target: Option<String>,
    message: Option<String>,
    app: AppHandle,
) -> Result<(), GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        let mut args = vec!["tag".to_string(), "-a".to_string(), name];
        args.push("-m".into());
        args.push(message.unwrap_or_default());
        if let Some(t) = target.filter(|t| !t.is_empty()) {
            args.push(t);
        }
        let argv: Vec<&str> = args.iter().map(std::string::String::as_str).collect();
        git_mut(&app, &path, &argv)?;
        Ok(())
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub async fn git_delete_tag(path: String, name: String, app: AppHandle) -> Result<(), GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        git_mut(&app, &path, &["tag", "-d", &name])?;
        Ok(())
    })
    .await
    .map_err(join_err)?
}

// ── Commit detail (history view) ─────────────────────────────────────────

#[tauri::command]
pub async fn git_show(path: String, sha: String) -> Result<CommitDetail, GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        let fmt = format!("%H{US}%h{US}%an{US}%ae{US}%ad{US}%s{US}%b");
        let meta = git_out(
            &path,
            &["log", "-1", "--date=format:%Y-%m-%d %H:%M", &format!("--format={fmt}"), &sha],
        )?;
        let p: Vec<&str> = meta.trim_end().split(US).collect();
        // Diff only (empty --format suppresses the header).
        let diff = git_out(&path, &["show", "--no-color", "--format=", &sha])?;
        Ok(CommitDetail {
            hash: p.first().copied().unwrap_or("").to_string(),
            short_hash: p.get(1).copied().unwrap_or("").to_string(),
            author: p.get(2).copied().unwrap_or("").to_string(),
            email: p.get(3).copied().unwrap_or("").to_string(),
            date: p.get(4).copied().unwrap_or("").to_string(),
            subject: p.get(5).copied().unwrap_or("").to_string(),
            body: p.get(6).copied().unwrap_or("").trim().to_string(),
            diff,
        })
    })
    .await
    .map_err(join_err)?
}

// ── In-progress operation detection (conflict banner) ────────────────────

#[tauri::command]
pub async fn git_inprogress(path: String) -> Result<InProgress, GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        let git_dir = git_out(&path, &["rev-parse", "--absolute-git-dir"])?
            .trim()
            .to_string();
        let exists = |p: &str| Path::new(&git_dir).join(p).exists();
        Ok(InProgress {
            merge: exists("MERGE_HEAD"),
            rebase: exists("rebase-merge") || exists("rebase-apply"),
            cherry_pick: exists("CHERRY_PICK_HEAD"),
            revert: exists("REVERT_HEAD"),
        })
    })
    .await
    .map_err(join_err)?
}

// ── Streaming operations (`atlas:git:op`) ────────────────────────────────
//
// Long-running git commands (commit with hooks today; push/pull/clone with
// progress in later phases) stream their output live so the UI can show a
// busy state with real feedback instead of appearing hung. One event name,
// discriminated by `phase`:
//   started → output* → done{ok, error?}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitOpEventPayload<'a> {
    op_id: &'a str,
    repo: &'a str,
    kind: &'a str,
    phase: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ok: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a GitErrorPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    percent: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<&'a str>,
}

/// Emits `atlas:git:op` events for one operation; also the `OpSink` handed
/// to the streaming executor, so child output forwards line by line.
pub(crate) struct OpEmitter {
    app: AppHandle,
    op_id: String,
    repo: String,
    kind: &'static str,
}

impl OpEmitter {
    pub(crate) fn new(app: AppHandle, op_id: String, repo: String, kind: &'static str) -> Self {
        OpEmitter { app, op_id, repo, kind }
    }

    #[allow(clippy::too_many_arguments)]
    fn emit(
        &self,
        phase: &str,
        stream: Option<&str>,
        line: Option<&str>,
        ok: Option<bool>,
        error: Option<&GitErrorPayload>,
        percent: Option<f32>,
        title: Option<&str>,
    ) {
        let _ = self.app.emit(
            "atlas:git:op",
            GitOpEventPayload {
                op_id: &self.op_id,
                repo: &self.repo,
                kind: self.kind,
                phase,
                stream,
                line,
                ok,
                error,
                percent,
                title,
            },
        );
    }

    pub(crate) fn started(&self) {
        self.emit("started", None, None, None, None, None, None);
    }

    pub(crate) fn done(&self, error: Option<&GitErrorPayload>) {
        self.emit("done", None, None, Some(error.is_none()), error, None, None);
    }

    pub(crate) fn progress(&self, fraction: f32, title: &str) {
        self.emit("progress", None, None, None, None, Some(fraction * 100.0), Some(title));
    }
}

/// Sink that forwards output lines AND feeds them through a weighted
/// progress parser, emitting `progress` phases as percent advances.
struct ProgressSink<'a> {
    emitter: &'a OpEmitter,
    parser: std::sync::Mutex<atlas_git::progress::ProgressParser>,
}

impl atlas_git::OpSink for ProgressSink<'_> {
    fn output(&self, stream: atlas_git::Stream, line: &str) {
        atlas_git::OpSink::output(self.emitter, stream, line);
        if let Ok(mut parser) = self.parser.lock() {
            if let Some((fraction, title)) = parser.advance(line) {
                self.emitter.progress(fraction, &title);
            }
        }
    }
}

impl atlas_git::OpSink for OpEmitter {
    fn output(&self, stream: atlas_git::Stream, line: &str) {
        let name = match stream {
            atlas_git::Stream::Stdout => "stdout",
            atlas_git::Stream::Stderr => "stderr",
        };
        self.emit("output", Some(name), Some(line), None, None, None, None);
    }
}

#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}
#[cfg(not(unix))]
fn is_executable(_p: &Path) -> bool {
    true
}

/// Does this repo have any commit-phase hooks? Used to classify an
/// otherwise-unrecognized commit failure as `hook-failed` — git prints no
/// stable marker when a hook rejects, but if hooks exist and the commit
/// died unclassified, the hook is by far the likeliest cause.
fn commit_hooks_present(path: &str) -> bool {
    let configured = GitCommand::new(path, &["config", "--get", "core.hooksPath"])
        .read_only()
        .success_codes(&[0, 1])
        .run()
        .ok()
        .filter(|o| o.exit_code == 0 && !o.stdout.trim().is_empty())
        .map(|o| o.stdout.trim().to_string());
    let hooks_dir = match configured {
        Some(d) => d,
        None => match GitCommand::new(path, &["rev-parse", "--git-path", "hooks"]).read_only().run() {
            Ok(o) => o.stdout.trim().to_string(),
            Err(_) => return false,
        },
    };
    if hooks_dir.is_empty() {
        return false;
    }
    let base = Path::new(&hooks_dir);
    let base = if base.is_absolute() {
        base.to_path_buf()
    } else {
        Path::new(path).join(base)
    };
    ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"]
        .iter()
        .any(|h| {
            let hp = base.join(h);
            hp.is_file() && is_executable(&hp)
        })
}

/// Streaming commit (v2): message via `commit -F -` stdin (multiline-safe),
/// live hook output as `atlas:git:op` events, and typed errors. Hooks run —
/// we shell out to the real git binary and never pass `--no-verify` — and
/// their stdout/stderr streams to the UI instead of being swallowed.
///
/// `co_authors` ("Name <email>" strings) are merged as `Co-authored-by`
/// trailers via `git interpret-trailers`, matching GitHub Desktop's
/// attribution format. Amending with an EMPTY summary keeps the original
/// message (`--amend --no-edit`) — previously amend always demanded a new
/// one.
#[tauri::command]
pub async fn git_commit_v2(
    path: String,
    summary: String,
    description: Option<String>,
    amend: bool,
    co_authors: Option<Vec<String>>,
    op_id: String,
    app: AppHandle,
) -> Result<(), GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        let emitter = OpEmitter::new(app.clone(), op_id, path.clone(), "commit");
        emitter.started();

        let keep_message = amend && summary.trim().is_empty();

        let result = if keep_message {
            GitCommand::new(&path, &["commit", "--amend", "--no-edit"]).run_streaming(&emitter)
        } else {
            let mut message = summary.trim().to_string();
            if let Some(d) = description.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
                message.push_str("\n\n");
                message.push_str(d);
            }
            message.push('\n');

            let authors: Vec<String> = co_authors
                .unwrap_or_default()
                .into_iter()
                .map(|a| a.trim().to_string())
                .filter(|a| !a.is_empty())
                .collect();
            if !authors.is_empty() {
                // interpret-trailers handles placement + dedup against any
                // trailers the user already typed in the description.
                let mut targs: Vec<String> =
                    vec!["interpret-trailers".into(), "--no-divider".into()];
                for a in &authors {
                    targs.push("--trailer".into());
                    targs.push(format!("Co-authored-by={a}"));
                }
                message = GitCommand::new_owned(&path, targs)
                    .stdin(message.into_bytes())
                    .run()?
                    .stdout;
            }

            let mut args = vec!["commit", "-F", "-"];
            if amend {
                args.push("--amend");
            }
            GitCommand::new(&path, &args)
                .stdin(message.into_bytes())
                .run_streaming(&emitter)
        };

        // The index/HEAD may have moved even on failure (e.g. a post-commit
        // hook failing after the commit landed) — always refresh listeners.
        emit_synthetic_change(&app, Path::new(&path));

        match result {
            Ok(_) => {
                emitter.done(None);
                Ok(())
            }
            Err(mut e) => {
                if e.code == GitErrorCode::Generic && commit_hooks_present(&path) {
                    e.code = GitErrorCode::HookFailed;
                    e.message = atlas_git::error::friendly_message(GitErrorCode::HookFailed, &[], None);
                }
                emitter.done(Some(&e));
                Err(e)
            }
        }
    })
    .await
    .map_err(join_err)?
}

/// Abort or continue an in-progress merge/rebase/cherry-pick/revert.
#[tauri::command]
pub async fn git_op_control(
    path: String,
    kind: String,
    action: String, // "abort" | "continue"
    app: AppHandle,
) -> Result<String, GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        let flag = if action == "continue" {
            "--continue"
        } else {
            "--abort"
        };
        // A merge has no `--continue`; finishing it is a no-edit commit.
        if kind == "merge" && action == "continue" {
            return git_mut(&app, &path, &["commit", "--no-edit"]);
        }
        git_mut(&app, &path, &[kind.as_str(), flag])
    })
    .await
    .map_err(join_err)?
}
