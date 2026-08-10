//! Structured side-by-side git diff commands, backed by the `atlas-gitdiff`
//! engine (which vendors delta's word-diff). The frontend diff viewer + the
//! editor gutter consume these.

use atlas_gitdiff::{build_file_diff, line_status, FileDiff, LineStatus};
use std::process::Command;

/// Run `git diff` for one file and return the raw unified output. `staged`
/// selects the index-vs-HEAD diff; otherwise it's worktree-vs-HEAD. `context`
/// is the `-U` value (large → whole-file side-by-side). Falls back to
/// `--no-index` against /dev/null so brand-new / untracked files render as
/// all-added instead of an empty diff.
fn run_git_diff(
    path: &str,
    file: &str,
    staged: bool,
    context: u32,
    commit: Option<&str>,
) -> Result<String, String> {
    let ctx = format!("-U{context}");
    // Commit mode: the diff INTRODUCED by `commit` for this file. `git show`
    // diffs the commit against its parent (and against the empty tree for the
    // root commit), so it works uniformly.
    if let Some(sha) = commit {
        let output = Command::new("git")
            .args(["show", "--no-color", &ctx, "--format=", sha, "--", file])
            .current_dir(path)
            .output()
            .map_err(|e| e.to_string())?;
        return Ok(String::from_utf8_lossy(&output.stdout).to_string());
    }
    let mut args: Vec<&str> = vec!["diff", "--no-color", &ctx];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    args.push(file);

    let output = Command::new("git")
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
            let cached = Command::new("git")
                .args(["diff", "--no-color", &ctx, "--cached", "--", file])
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
    let no_index = Command::new("git")
        .args(["diff", "--no-color", &ctx, "--no-index", "--", nul, file])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&no_index.stdout).to_string())
}

/// Whether `file` is tracked by git (in the index). `git ls-files
/// --error-unmatch` exits 0 only for tracked paths.
fn is_tracked(path: &str, file: &str) -> bool {
    Command::new("git")
        .args(["ls-files", "--error-unmatch", "--", file])
        .current_dir(path)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Whether `file` exists in the HEAD commit. Distinguishes "tracked and
/// unchanged" from "newly created and staged", which `is_tracked` cannot.
fn exists_in_head(path: &str, file: &str) -> bool {
    Command::new("git")
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

/// Lowercased file extension (drives syntax highlighting on the frontend).
fn language_of(file: &str) -> String {
    file.rsplit('/')
        .next()
        .and_then(|n| n.rsplit_once('.'))
        .map(|(_, ext)| ext.to_lowercase())
        .unwrap_or_default()
}

/// Full side-by-side diff model for one file (whole-file context).
#[tauri::command]
pub async fn git_diff_structured(
    path: String,
    file: String,
    staged: bool,
    commit: Option<String>,
) -> Result<FileDiff, String> {
    tokio::task::spawn_blocking(move || {
        let diff = run_git_diff(&path, &file, staged, 100_000, commit.as_deref())?;
        Ok(build_file_diff(&diff, &file, &language_of(&file)))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Structured diff between two arbitrary TEXTS, with no repository involved.
///
/// This is what the agent chat's "Show changes" uses. A turn's edits are known
/// only as tool ARGUMENTS — the before/after strings the agent passed to
/// `Edit`/`Write` — and git cannot answer for them: the working tree reflects
/// the CURRENT state, not the state at that turn. A file created in turn 1,
/// edited in turn 2 and deleted in turn 3 has one git answer and three different
/// correct diffs, and only the tool arguments know which is which.
///
/// Rather than reimplement line diffing (no diff crate in the workspace, and the
/// vendored delta code does WORD-level spans within an already-diffed line), the
/// two texts go to git itself via `--no-index` over temp files. That yields a
/// real unified diff — hunks, line numbers, context — which `build_file_diff`
/// turns into the same `FileDiff` the repository path produces. One engine, one
/// renderer, two sources.
#[tauri::command]
pub async fn diff_structured_text(
    old_text: String,
    new_text: String,
    file: String,
) -> Result<FileDiff, String> {
    tokio::task::spawn_blocking(move || {
        let diff = run_text_diff(&old_text, &new_text, &file)?;
        Ok(build_file_diff(&diff, &file, &language_of(&file)))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `git diff --no-index` over two temp files holding the before/after text.
///
/// The temp files keep the original file's NAME under two parent dirs, so the
/// diff header carries a usable path.
fn run_text_diff(old_text: &str, new_text: &str, file: &str) -> Result<String, String> {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    let name = std::path::Path::new(file)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());

    // Unique per call: a turn's files diff concurrently.
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let base = std::env::temp_dir().join(format!("atlas-diff-{stamp}-{:p}", &name));
    let a_dir = base.join("a");
    let b_dir = base.join("b");
    fs::create_dir_all(&a_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&b_dir).map_err(|e| e.to_string())?;
    let a = a_dir.join(&name);
    let b = b_dir.join(&name);
    fs::write(&a, old_text).map_err(|e| e.to_string())?;
    fs::write(&b, new_text).map_err(|e| e.to_string())?;

    // `--no-index` exits 1 when the files differ, which is the normal case here,
    // so the status is ignored and stdout taken as-is.
    let output = Command::new("git")
        .args([
            "diff",
            "--no-color",
            "--no-index",
            "-U100000",
            "--",
            &a.to_string_lossy(),
            &b.to_string_lossy(),
        ])
        .output();

    // Best-effort cleanup — a leftover temp dir is harmless, a failed diff is not.
    let _ = fs::remove_dir_all(&base);

    Ok(String::from_utf8_lossy(&output.map_err(|e| e.to_string())?.stdout).to_string())
}

/// Serde-friendly changed-file entry (path + porcelain status letter).
#[derive(serde::Serialize)]
pub struct CommitFile {
    pub path: String,
    pub status: String,
}

/// Files changed by a single commit (name + status), for the diff viewer's
/// commit-browsing tree. `git show --name-status` against the commit.
#[tauri::command]
pub async fn git_commit_changed_files(
    path: String,
    sha: String,
) -> Result<Vec<CommitFile>, String> {
    tokio::task::spawn_blocking(move || {
        let output = Command::new("git")
            .args(["show", "--no-color", "--name-status", "--format=", &sha])
            .current_dir(&path)
            .output()
            .map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&output.stdout);
        let mut out = Vec::new();
        for line in text.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let mut parts = line.split('\t');
            let status = parts.next().unwrap_or("").to_string();
            // Renames are `R100\told\tnew` — take the last field (new path).
            let file = parts.last().unwrap_or("").to_string();
            if !file.is_empty() {
                out.push(CommitFile { path: file, status });
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
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
        let diff = run_git_diff(&path, &file, staged, 0, None)?;
        let fd = build_file_diff(&diff, &file, "");
        Ok(line_status(&fd))
    })
    .await
    .map_err(|e| e.to_string())?
}
