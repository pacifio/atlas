//! The editor gutter's line classification, backed by the `atlas-gitdiff`
//! engine. The diff viewer reads `git_review` instead.

use atlas_gitdiff::{build_file_diff, line_status, LineStatus};

/// Run `git diff` for one file and return the raw unified output. `staged`
/// selects the index-vs-HEAD diff; otherwise it's worktree-vs-HEAD. `context`
/// is the `-U` value (large → whole-file side-by-side). Falls back to
/// `--no-index` against /dev/null so brand-new / untracked files render as
/// all-added instead of an empty diff. `ignore_ws` adds `-w`
/// (`diffIgnoreWhitespace`): a change that is only whitespace then reads as
/// no change, the same as a clean file.
fn run_git_diff(
    path: &str,
    file: &str,
    staged: bool,
    context: u32,
    commit: Option<&str>,
    ignore_ws: bool,
) -> Result<String, String> {
    let ctx = format!("-U{context}");
    let ws: &[&str] = if ignore_ws { &["-w"] } else { &[] };
    // Commit mode: the diff INTRODUCED by `commit` for this file. `git show`
    // diffs the commit against its parent (and against the empty tree for the
    // root commit), so it works uniformly. `-m --first-parent` makes a merge
    // show what it brought into its branch, matching `git_show` — without it a
    // merge prints a combined diff, empty for a clean merge.
    if let Some(sha) = commit {
        let output = atlas_process::command("git")
            .args(["show", "--no-color", &ctx])
            .args(ws)
            .args(["--format=", "-m", "--first-parent", sha, "--", file])
            .current_dir(path)
            .output()
            .map_err(|e| e.to_string())?;
        return Ok(String::from_utf8_lossy(&output.stdout).to_string());
    }
    let mut args: Vec<&str> = vec!["diff", "--no-color", &ctx];
    args.extend_from_slice(ws);
    if staged {
        args.push("--cached");
    }
    args.push("--");
    args.push(file);

    let output = atlas_process::command("git")
        .args(&args)
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    if !text.trim().is_empty() {
        return Ok(text);
    }

    // Empty diff. This is the COMMON case for a clean, tracked file — and it
    // genuinely means "no changes", so return empty. We must NOT fall back to
    // `--no-index` here: that would diff the file against /dev/null and report
    // EVERY line as added, which is what made the editor gutter mark all lines
    // until the first edit. Only an UNTRACKED file should render as all-added.
    if is_tracked(path, file) {
        // ...with one exception: a file that was CREATED and then staged is in
        // the index (so `is_tracked` says yes) while the worktree matches the
        // index (so the diff above is empty) — yet it is entirely new and has
        // every right to render as all-added. `git diff --cached` against HEAD
        // is the one that shows it.
        //
        // Narrowed to files absent from HEAD on purpose: for a file that DOES
        // exist in HEAD, an empty worktree diff really does mean "nothing
        // uncommitted here", and falling back to the staged diff would make the
        // editor gutter mark lines the user already staged and moved on from.
        if !staged && !exists_in_head(path, file) {
            let cached = atlas_process::command("git")
                .args(["diff", "--no-color", &ctx])
                .args(ws)
                .args(["--cached", "--", file])
                .current_dir(path)
                .output()
                .map_err(|e| e.to_string())?;
            let cached = String::from_utf8_lossy(&cached.stdout).to_string();
            if !cached.trim().is_empty() {
                return Ok(cached);
            }
        }
        return Ok(String::new());
    }

    // Untracked / brand-new file — diff against /dev/null so it shows as fully
    // added. `--no-index` exits non-zero by design, so ignore status; take stdout.
    let nul = devnull();
    let no_index = atlas_process::command("git")
        .args(["diff", "--no-color", &ctx, "--no-index", "--", nul, file])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&no_index.stdout).to_string())
}

/// Whether `file` is tracked by git (in the index). `git ls-files
/// --error-unmatch` exits 0 only for tracked paths.
fn is_tracked(path: &str, file: &str) -> bool {
    atlas_process::command("git")
        .args(["ls-files", "--error-unmatch", "--", file])
        .current_dir(path)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Whether `file` exists in the HEAD commit. Distinguishes "tracked and
/// unchanged" from "newly created and staged", which `is_tracked` cannot.
fn exists_in_head(path: &str, file: &str) -> bool {
    atlas_process::command("git")
        .args(["cat-file", "-e", &format!("HEAD:{file}")])
        .current_dir(path)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn devnull() -> &'static str {
    if cfg!(windows) {
        "NUL"
    } else {
        "/dev/null"
    }
}

/// New-file line classification for the editor gutter (added / changed /
/// deleted-before). Uses zero-context diff — cheap.
#[tauri::command]
pub async fn git_diff_line_status(
    path: String,
    file: String,
    staged: bool,
) -> Result<LineStatus, String> {
    tokio::task::spawn_blocking(move || {
        // The gutter marks every changed line, whitespace included.
        let diff = run_git_diff(&path, &file, staged, 0, None, false)?;
        let fd = build_file_diff(&diff, &file, "");
        Ok(line_status(&fd))
    })
    .await
    .map_err(|e| e.to_string())?
}
