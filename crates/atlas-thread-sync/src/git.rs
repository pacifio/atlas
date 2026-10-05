//! The handful of git operations a replica needs, through the git CLI.
//!
//! The CLI rather than a library for the same reason `atlas-checkpoint` uses
//! it: it reads the person's own configuration (safe directories, object
//! alternates, worktrees) exactly as their terminal would. Atlas never runs a
//! command here that talks to a remote.

use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error("could not run git: {0}")]
    Spawn(#[from] std::io::Error),
    #[error("git {args} failed: {stderr}")]
    Failed { args: String, stderr: String },
}

fn run(repo: &Path, args: &[&str]) -> Result<Vec<u8>, GitError> {
    let output = atlas_process::command("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()?;
    if !output.status.success() {
        return Err(GitError::Failed {
            args: args.join(" "),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }
    Ok(output.stdout)
}

/// Is `sha` a full commit name — 40 (SHA-1) or 64 (SHA-256) lower-case hex?
///
/// Every commit id that reaches a git argument passes this first. A Base comes
/// from the server or a link, and a value starting with `-` would otherwise be
/// read by git as an option.
pub fn is_commit_sha(sha: &str) -> bool {
    matches!(sha.len(), 40 | 64)
        && sha
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn checked(sha: &str) -> Result<&str, GitError> {
    if is_commit_sha(sha) {
        Ok(sha)
    } else {
        Err(GitError::Failed {
            args: "(refused)".into(),
            stderr: format!("not a commit id: {sha:?}"),
        })
    }
}

/// The commit `HEAD` names — the Base a share starts from.
pub fn head_commit(repo: &Path) -> Result<String, GitError> {
    let out = run(repo, &["rev-parse", "--verify", "HEAD^{commit}"])?;
    Ok(String::from_utf8_lossy(&out).trim().to_string())
}

/// Does this repository already hold `sha` as a commit?
pub fn has_commit(repo: &Path, sha: &str) -> bool {
    is_commit_sha(sha) && run(repo, &["cat-file", "-e", &format!("{sha}^{{commit}}")]).is_ok()
}

/// A file's bytes at `sha`, or `None` when the commit has no such file.
pub fn blob_at(repo: &Path, sha: &str, path: &str) -> Result<Option<Vec<u8>>, GitError> {
    let spec = format!("{}:{path}", checked(sha)?);
    if run(repo, &["cat-file", "-e", &spec]).is_err() {
        return Ok(None);
    }
    run(repo, &["cat-file", "blob", &spec]).map(Some)
}

/// Check out `sha` into a new, detached worktree at `dest`, leaving the
/// person's own checkout and branches untouched.
pub fn add_worktree(repo: &Path, dest: &Path, sha: &str) -> Result<(), GitError> {
    let sha = checked(sha)?;
    let dest = dest.to_string_lossy();
    run(
        repo,
        &["worktree", "add", "--detach", "--quiet", "--", &dest, sha],
    )
    .map(|_| ())
}

/// One path the working tree differs from `HEAD` on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dirty {
    pub path: String,
    pub deleted: bool,
}

/// Every path whose working-tree state differs from `HEAD`: modified, added,
/// renamed and untracked files (ignored ones excluded), and deletions marked.
///
/// `-z` porcelain v1, parsed by hand: a rename or copy record carries its
/// source path as the next NUL-separated field, which belongs to it and is not
/// an entry of its own.
pub fn dirty_paths(repo: &Path) -> Result<Vec<Dirty>, GitError> {
    let out = run(
        repo,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    let mut fields = out.split(|b| *b == 0).filter(|f| !f.is_empty());
    let mut dirty = Vec::new();
    while let Some(field) = fields.next() {
        if field.len() < 4 {
            continue;
        }
        let (x, y) = (field[0], field[1]);
        let path = String::from_utf8_lossy(&field[3..]).into_owned();
        if x == b'R' || x == b'C' {
            fields.next();
        }
        dirty.push(Dirty {
            deleted: x == b'D' || y == b'D',
            path,
        });
    }
    Ok(dirty)
}

/// Put an existing worktree back at `sha`: tracked files reset, untracked ones
/// removed. **Ignored files survive** (`clean` without `-x`), so a Run
/// worktree keeps its `node_modules` and build output warm across Runs.
pub fn reset_worktree(root: &Path, sha: &str) -> Result<(), GitError> {
    let sha = checked(sha)?;
    run(root, &["reset", "--hard", "--quiet", sha])?;
    run(root, &["clean", "-d", "--force", "--quiet"]).map(|_| ())
}

// ---------------------------------------------------------------------------
// Bundles and the thread's own repository (ATL-402)
// ---------------------------------------------------------------------------

/// `run` with `stdin`, answering the exit code too: some commands
/// (`check-ignore`) report "nothing matched" as a failure status.
fn run_with_input(
    repo: &Path,
    config: &[String],
    args: &[&str],
    stdin: &[u8],
) -> Result<(Option<i32>, Vec<u8>, String), GitError> {
    use std::io::Write as _;
    let mut command = atlas_process::command("git");
    for c in config {
        command.arg("-c").arg(c);
    }
    let mut child = command
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()?;
    if let Some(mut input) = child.stdin.take() {
        input.write_all(stdin)?;
    }
    let output = child.wait_with_output()?;
    Ok((
        output.status.code(),
        output.stdout,
        String::from_utf8_lossy(&output.stderr).trim().to_string(),
    ))
}

/// The object directory of `repo` — the common one, for a worktree.
pub fn objects_dir(repo: &Path) -> Result<std::path::PathBuf, GitError> {
    let out = run(
        repo,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "objects",
        ],
    )?;
    Ok(std::path::PathBuf::from(
        String::from_utf8_lossy(&out).trim().to_string(),
    ))
}

/// A path inside `repo`'s git directory (the common one, for a worktree):
/// somewhere nothing is ever committed from.
pub fn git_path(repo: &Path, name: &str) -> Result<std::path::PathBuf, GitError> {
    let out = run(
        repo,
        &["rev-parse", "--path-format=absolute", "--git-path", name],
    )?;
    Ok(std::path::PathBuf::from(
        String::from_utf8_lossy(&out).trim().to_string(),
    ))
}

/// Create a bare repository at `dir` if there is none.
pub fn init_bare(dir: &Path) -> Result<(), GitError> {
    std::fs::create_dir_all(dir)?;
    if dir.join("HEAD").exists() {
        return Ok(());
    }
    run(dir, &["init", "--bare", "--quiet", "."]).map(|_| ())
}

/// Point a ref at a commit.
pub fn update_ref(repo: &Path, name: &str, sha: &str) -> Result<(), GitError> {
    let sha = checked(sha)?;
    run(repo, &["update-ref", name, sha]).map(|_| ())
}

/// The commit a ref names, if it exists.
pub fn resolve_ref(repo: &Path, name: &str) -> Option<String> {
    let out = run(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{name}^{{commit}}"),
        ],
    )
    .ok()?;
    Some(String::from_utf8_lossy(&out).trim().to_string())
}

/// The commits a joiner already holds, to ask for a thin bundle against: its
/// `HEAD` and the tips of its branches and remote-tracking branches, newest
/// first, at most `limit`.
pub fn have_commits(repo: &Path, limit: usize) -> Vec<String> {
    let mut have = Vec::new();
    if let Ok(head) = head_commit(repo) {
        have.push(head);
    }
    if let Ok(out) = run(
        repo,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(objectname) %(objecttype)",
            "refs/heads",
            "refs/remotes",
        ],
    ) {
        for line in String::from_utf8_lossy(&out).lines() {
            if let Some((sha, "commit")) = line.split_once(' ') {
                have.push(sha.to_string());
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    have.retain(|sha| is_commit_sha(sha) && seen.insert(sha.clone()));
    have.truncate(limit);
    have
}

/// The commits a bundle of `tip` built against `have` will require: the
/// boundary `rev-list` draws. `have` commits this repository does not hold are
/// left out — git would refuse to name them.
pub fn boundary(repo: &Path, tip: &str, have: &[String]) -> Result<Vec<String>, GitError> {
    let tip = checked(tip)?;
    let known: Vec<&str> = have
        .iter()
        .filter(|sha| has_commit(repo, sha))
        .map(String::as_str)
        .collect();
    let mut args = vec!["rev-list", "--boundary", tip];
    if !known.is_empty() {
        args.push("--not");
        args.extend(known.iter().copied());
    }
    let out = run(repo, &args)?;
    Ok(String::from_utf8_lossy(&out)
        .lines()
        .filter_map(|line| line.strip_prefix('-'))
        .map(str::to_string)
        .collect())
}

/// Write a bundle of `refname` to `file`, without the history `have` already
/// covers (only commits this repository holds are used).
pub fn bundle_create(
    repo: &Path,
    file: &Path,
    refname: &str,
    have: &[String],
) -> Result<(), GitError> {
    let file = file.to_string_lossy();
    let known: Vec<&str> = have
        .iter()
        .filter(|sha| has_commit(repo, sha))
        .map(String::as_str)
        .collect();
    let mut args = vec!["bundle", "create", "--quiet", file.as_ref(), refname];
    if !known.is_empty() {
        args.push("--not");
        args.extend(known.iter().copied());
    }
    run(repo, &args).map(|_| ())
}

/// Fetch `refname` out of the bundle at `file` into the same ref here. Fails
/// when the bundle needs history this repository (with its alternates) lacks.
pub fn fetch_bundle(repo: &Path, file: &Path, refname: &str) -> Result<(), GitError> {
    let file = file.to_string_lossy();
    let spec = format!("+{refname}:{refname}");
    run(
        repo,
        &["fetch", "--quiet", "--no-tags", "--", file.as_ref(), &spec],
    )
    .map(|_| ())
}

/// Which of `paths` git ignores in the working tree at `root` — `.gitignore`,
/// `.git/info/exclude` and the person's global excludes — and, when `extra`
/// is given, also the patterns in that file (`.atlas/shareignore`). Tracked
/// files are checked too: a file ignored for sharing is ignored even if it is
/// committed.
pub fn ignored(
    root: &Path,
    paths: &[String],
    extra: Option<&Path>,
) -> Result<std::collections::HashSet<String>, GitError> {
    let mut out = std::collections::HashSet::new();
    if paths.is_empty() {
        return Ok(out);
    }
    let mut input = Vec::new();
    for p in paths {
        input.extend_from_slice(p.as_bytes());
        input.push(0);
    }
    // The person's own excludes, then the share-only file. `core.excludesFile`
    // replaces the global file rather than adding to it, hence two passes.
    let mut passes = vec![Vec::new()];
    if let Some(extra) = extra.filter(|p| p.is_file()) {
        passes.push(vec![format!("core.excludesFile={}", extra.display())]);
    }
    for config in passes {
        let (code, stdout, stderr) = run_with_input(
            root,
            &config,
            &["check-ignore", "--no-index", "-z", "--stdin"],
            &input,
        )?;
        match code {
            Some(0) => {}
            // Nothing matched.
            Some(1) => continue,
            _ => {
                return Err(GitError::Failed {
                    args: "check-ignore".into(),
                    stderr,
                })
            }
        }
        for name in stdout.split(|b| *b == 0).filter(|n| !n.is_empty()) {
            out.insert(String::from_utf8_lossy(name).into_owned());
        }
    }
    Ok(out)
}

/// `rel` as a pathspec git takes literally: no globbing, no magic.
fn literal(rel: &str) -> String {
    format!(":(literal){rel}")
}

/// Which of `paths` differ from `HEAD` in the working tree or the index —
/// modified, staged, deleted or untracked (ignored ones excluded).
pub fn dirty_among(repo: &Path, paths: &[String]) -> Result<Vec<String>, GitError> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let specs: Vec<String> = paths.iter().map(|p| literal(p)).collect();
    let mut args = vec![
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--",
    ];
    args.extend(specs.iter().map(String::as_str));
    let out = run(repo, &args)?;
    let mut fields = out.split(|b| *b == 0).filter(|f| !f.is_empty());
    let mut dirty = Vec::new();
    while let Some(field) = fields.next() {
        if field.len() < 4 {
            continue;
        }
        if field[0] == b'R' || field[0] == b'C' {
            fields.next();
        }
        dirty.push(String::from_utf8_lossy(&field[3..]).into_owned());
    }
    dirty.sort();
    dirty.dedup();
    Ok(dirty)
}

/// Stash the person's uncommitted work on `paths` — and only there — under
/// `message`, untracked files included. `git stash pop` brings it back.
pub fn stash_paths(repo: &Path, paths: &[String], message: &str) -> Result<(), GitError> {
    let specs: Vec<String> = paths.iter().map(|p| literal(p)).collect();
    let mut args = vec![
        "stash",
        "push",
        "--include-untracked",
        "--message",
        message,
        "--",
    ];
    args.extend(specs.iter().map(String::as_str));
    run(repo, &args).map(|_| ())
}

/// A three-way merge of one file's contents, as `git merge-file` does it:
/// the result, and whether it holds conflict markers (labelled with
/// `labels` — ours, base, theirs).
pub fn merge_file(
    repo: &Path,
    ours: &[u8],
    base: &[u8],
    theirs: &[u8],
    labels: [&str; 3],
) -> Result<(Vec<u8>, bool), GitError> {
    // Three scratch files, removed however this returns.
    struct Scratch(std::path::PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let dir = Scratch(
        std::env::temp_dir().join(format!("atlas-merge-{}", uuid::Uuid::new_v4().simple())),
    );
    std::fs::create_dir_all(&dir.0)?;
    let files = [("ours", ours), ("base", base), ("theirs", theirs)];
    let mut paths = Vec::with_capacity(3);
    for (name, bytes) in files {
        let path = dir.0.join(name);
        std::fs::write(&path, bytes)?;
        paths.push(path.to_string_lossy().into_owned());
    }
    let output = atlas_process::command("git")
        .arg("-C")
        .arg(repo)
        .args([
            "merge-file",
            "-p",
            "-L",
            labels[0],
            "-L",
            labels[1],
            "-L",
            labels[2],
            "--",
        ])
        .args(&paths)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()?;
    // The exit status is the number of conflicts; negative is an error.
    match output.status.code() {
        Some(0) => Ok((output.stdout, false)),
        Some(n) if (1..=127).contains(&n) => Ok((output.stdout, true)),
        _ => Err(GitError::Failed {
            args: "merge-file".into(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        }),
    }
}
