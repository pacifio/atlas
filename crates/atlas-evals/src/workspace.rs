//! Per-run workspace preparation. Every run gets an isolated directory —
//! a detached `git worktree` of the repository for `git`-kind tasks, a
//! copied-and-`git init`-ed fixture for `fixture`-kind tasks — so runs can
//! never contaminate each other or the main checkout.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::task::{Task, WorkspaceSpec};

/// A prepared workspace. Call [`cleanup`] when the run is done.
#[derive(Debug)]
pub struct Workspace {
    pub root: PathBuf,
    kind: Kind,
}

#[derive(Debug)]
enum Kind {
    /// Registered worktree of `repo` — must be removed via git.
    GitWorktree { repo: PathBuf },
    Fixture,
}

/// Prepare the workspace for one run under `scratch/<slug>`, applying the
/// task's `setup_patch` if any.
pub fn prepare(task: &Task, repo_root: &Path, scratch: &Path, slug: &str) -> Result<Workspace, String> {
    let dest = scratch.join(slug);
    if dest.exists() {
        return Err(format!("workspace already exists: {}", dest.display()));
    }
    std::fs::create_dir_all(scratch).map_err(|e| format!("create scratch: {e}"))?;

    let ws = match &task.workspace {
        WorkspaceSpec::Git { rev } => {
            run_git(
                repo_root,
                &["worktree", "add", "--detach", dest.to_str().ok_or("non-utf8 dest")?, rev],
            )?;
            Workspace {
                root: dest,
                kind: Kind::GitWorktree { repo: repo_root.to_path_buf() },
            }
        }
        WorkspaceSpec::Fixture { path } => {
            let src = task.dir.join(path);
            let src = if src.is_dir() { src } else { repo_root.join(path) };
            if !src.is_dir() {
                return Err(format!("fixture dir not found: {path}"));
            }
            copy_dir(&src, &dest).map_err(|e| format!("copy fixture: {e}"))?;
            // A fixture becomes a real repo so `git_clean` verification and
            // git-aware agent behavior work the same as in worktrees.
            run_git(&dest, &["init", "--quiet"])?;
            run_git(&dest, &["add", "-A"])?;
            run_git(
                &dest,
                &["-c", "user.name=eval", "-c", "user.email=eval@invalid", "commit", "--quiet", "-m", "fixture"],
            )?;
            Workspace { root: dest, kind: Kind::Fixture }
        }
    };

    if let Some(patch) = &task.setup_patch {
        let patch = patch.to_str().ok_or("non-utf8 patch path")?;
        run_git(&ws.root, &["apply", patch]).map_err(|e| {
            let _ = cleanup(&ws);
            format!("setup patch failed: {e}")
        })?;
    }
    Ok(ws)
}

/// Tear the workspace down. Worktrees must be unregistered through git or
/// the main repository accumulates stale worktree entries.
pub fn cleanup(ws: &Workspace) -> Result<(), String> {
    match &ws.kind {
        Kind::GitWorktree { repo } => run_git(
            repo,
            &["worktree", "remove", "--force", ws.root.to_str().ok_or("non-utf8 root")?],
        )
        .map(|_| ()),
        Kind::Fixture => std::fs::remove_dir_all(&ws.root).map_err(|e| format!("remove fixture: {e}")),
    }
}

pub(crate) fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("spawn git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(format!(
            "git {} failed ({}): {}",
            args.join(" "),
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

fn copy_dir(src: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let to = dest.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task::{Bucket, VerifySpec};

    fn stub_task(dir: &Path, workspace: WorkspaceSpec) -> Task {
        Task {
            id: "t".into(),
            bucket: Bucket::Edit,
            dir: dir.to_path_buf(),
            prompt: "p".into(),
            workspace,
            setup_patch: None,
            verify: VerifySpec { git_clean: true, ..Default::default() },
            timeout_secs: 60,
            max_turns: None,
        }
    }

    /// A tiny real repository with two commits; returns (dir, first_rev).
    fn test_repo() -> (tempfile::TempDir, String) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        run_git(root, &["init", "--quiet"]).unwrap();
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        run_git(root, &["add", "-A"]).unwrap();
        run_git(root, &["-c", "user.name=t", "-c", "user.email=t@invalid", "commit", "-q", "-m", "c1"]).unwrap();
        let rev = run_git(root, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        std::fs::write(root.join("a.txt"), "two\n").unwrap();
        run_git(root, &["-c", "user.name=t", "-c", "user.email=t@invalid", "commit", "-q", "-am", "c2"]).unwrap();
        (tmp, rev)
    }

    #[test]
    fn a_git_workspace_is_a_detached_worktree_at_the_requested_rev() {
        let (repo, first_rev) = test_repo();
        let scratch = tempfile::tempdir().unwrap();
        let task_dir = tempfile::tempdir().unwrap();
        let task = stub_task(task_dir.path(), WorkspaceSpec::Git { rev: first_rev });

        let ws = prepare(&task, repo.path(), scratch.path(), "run-1").unwrap();
        assert_eq!(std::fs::read_to_string(ws.root.join("a.txt")).unwrap(), "one\n");

        cleanup(&ws).unwrap();
        assert!(!ws.root.exists());
        let list = run_git(repo.path(), &["worktree", "list"]).unwrap();
        assert!(!list.contains("run-1"), "worktree still registered: {list}");
    }

    #[test]
    fn a_setup_patch_is_applied_to_the_fresh_workspace() {
        let (repo, _) = test_repo();
        let scratch = tempfile::tempdir().unwrap();
        let task_dir = tempfile::tempdir().unwrap();
        let patch = "\
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-two
+mutated
";
        std::fs::write(task_dir.path().join("mutate.patch"), patch).unwrap();
        let mut task = stub_task(task_dir.path(), WorkspaceSpec::Git { rev: "HEAD".into() });
        task.setup_patch = Some(task_dir.path().join("mutate.patch"));

        let ws = prepare(&task, repo.path(), scratch.path(), "run-2").unwrap();
        assert_eq!(std::fs::read_to_string(ws.root.join("a.txt")).unwrap(), "mutated\n");
        cleanup(&ws).unwrap();
    }

    #[test]
    fn a_fixture_workspace_is_copied_and_git_initialised() {
        let scratch = tempfile::tempdir().unwrap();
        let task_dir = tempfile::tempdir().unwrap();
        let fixture = task_dir.path().join("proj");
        std::fs::create_dir_all(fixture.join("src")).unwrap();
        std::fs::write(fixture.join("src/main.txt"), "hello\n").unwrap();
        let task = stub_task(task_dir.path(), WorkspaceSpec::Fixture { path: "proj".into() });

        let ws = prepare(&task, Path::new("/nonexistent"), scratch.path(), "run-3").unwrap();
        assert_eq!(std::fs::read_to_string(ws.root.join("src/main.txt")).unwrap(), "hello\n");
        // git_clean-style verification works immediately after prepare.
        run_git(&ws.root, &["diff", "--exit-code"]).unwrap();
        cleanup(&ws).unwrap();
        assert!(!ws.root.exists());
    }

    #[test]
    fn a_bad_rev_fails_prepare_rather_than_leaving_a_half_workspace() {
        let (repo, _) = test_repo();
        let scratch = tempfile::tempdir().unwrap();
        let task_dir = tempfile::tempdir().unwrap();
        let task = stub_task(task_dir.path(), WorkspaceSpec::Git { rev: "no-such-rev".into() });
        assert!(prepare(&task, repo.path(), scratch.path(), "run-4").is_err());
    }
}
