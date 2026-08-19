//! Post-run verification. The verifier is the hidden ground truth of every
//! task; the agent never sees it. Checks run in order — verify patch (the
//! history bucket's injected tests), script, `git_clean` — and every
//! present check must pass.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::task::Task;
use crate::workspace::run_git;

/// What verification concluded.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct VerifyOutcome {
    pub pass: bool,
    /// The verify script's exit code, if a script ran to completion.
    pub exit_code: Option<i32>,
    /// Failure detail (first check that failed), truncated for the record.
    pub detail: String,
}

impl VerifyOutcome {
    fn fail(detail: String) -> Self {
        let mut detail = detail;
        detail.truncate(2000);
        Self { pass: false, exit_code: None, detail }
    }
}

const DEFAULT_SCRIPT_TIMEOUT_SECS: u64 = 600;

/// Run the task's verification inside `ws_root`.
pub fn run_verify(task: &Task, ws_root: &Path) -> VerifyOutcome {
    if let Some(patch) = &task.verify.patch {
        let patch_path = task.dir.join(patch);
        let Some(patch_str) = patch_path.to_str() else {
            return VerifyOutcome::fail("non-utf8 verify patch path".into());
        };
        // --3way so the injected tests still land when the agent's edit
        // shifted surrounding context.
        if let Err(e) = run_git(ws_root, &["apply", "--3way", patch_str]) {
            return VerifyOutcome::fail(format!("verify patch: {e}"));
        }
    }

    let mut exit_code = None;
    if let Some(script) = &task.verify.script {
        let timeout = Duration::from_secs(
            task.verify.timeout_secs.unwrap_or(DEFAULT_SCRIPT_TIMEOUT_SECS),
        );
        match run_script(&task.dir.join(script), ws_root, timeout) {
            Ok((code, tail)) => {
                exit_code = Some(code);
                if code != 0 {
                    let mut out = VerifyOutcome::fail(format!("verify script exit {code}: {tail}"));
                    out.exit_code = exit_code;
                    return out;
                }
            }
            Err(e) => return VerifyOutcome::fail(format!("verify script: {e}")),
        }
    }

    if task.verify.git_clean {
        // Tracked files only: guarded tools may drop scratch files (e.g.
        // `.atlas/`) that byte-exact restoration shouldn't count against.
        if let Err(e) = run_git(ws_root, &["diff", "--exit-code"]) {
            let mut out = VerifyOutcome::fail(format!("workspace not byte-identical: {e}"));
            out.exit_code = exit_code;
            return out;
        }
    }

    VerifyOutcome { pass: true, exit_code, detail: String::new() }
}

/// Run a verify script with a hard timeout, returning (exit code, output
/// tail). Scripts run through `bash` in the workspace root.
fn run_script(script: &Path, cwd: &Path, timeout: Duration) -> Result<(i32, String), String> {
    let script = script.to_str().ok_or("non-utf8 script path")?;
    let mut child = Command::new("bash")
        .arg(script)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn bash {script}: {e}"))?;

    let started = Instant::now();
    loop {
        match child.try_wait().map_err(|e| format!("wait: {e}"))? {
            Some(status) => {
                let mut tail = String::new();
                if let Some(mut out) = child.stdout.take() {
                    use std::io::Read;
                    let _ = out.read_to_string(&mut tail);
                }
                if let Some(mut err) = child.stderr.take() {
                    use std::io::Read;
                    let _ = err.read_to_string(&mut tail);
                }
                let tail: String = tail.chars().rev().take(1500).collect::<Vec<_>>()
                    .into_iter().rev().collect();
                return Ok((status.code().unwrap_or(-1), tail));
            }
            None if started.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("timed out after {}s", timeout.as_secs()));
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task::{Bucket, Task, VerifySpec, WorkspaceSpec};

    fn task_with(dir: &Path, verify: VerifySpec) -> Task {
        Task {
            id: "t".into(),
            bucket: Bucket::Edit,
            dir: dir.to_path_buf(),
            prompt: "p".into(),
            workspace: WorkspaceSpec::Fixture { path: ".".into() },
            setup_patch: None,
            verify,
            timeout_secs: 60,
            max_turns: None,
        }
    }

    fn git_workspace() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        run_git(tmp.path(), &["init", "--quiet"]).unwrap();
        std::fs::write(tmp.path().join("f.txt"), "content\n").unwrap();
        run_git(tmp.path(), &["add", "-A"]).unwrap();
        run_git(tmp.path(), &["-c", "user.name=t", "-c", "user.email=t@invalid", "commit", "-q", "-m", "c"]).unwrap();
        tmp
    }

    #[test]
    fn a_zero_exit_script_passes_and_a_nonzero_one_fails_with_output_tail() {
        let dir = tempfile::tempdir().unwrap();
        let ws = git_workspace();
        std::fs::write(dir.path().join("ok.sh"), "exit 0\n").unwrap();
        std::fs::write(dir.path().join("bad.sh"), "echo boom >&2; exit 3\n").unwrap();

        let ok = task_with(dir.path(), VerifySpec { script: Some("ok.sh".into()), ..Default::default() });
        let out = run_verify(&ok, ws.path());
        assert!(out.pass);
        assert_eq!(out.exit_code, Some(0));

        let bad = task_with(dir.path(), VerifySpec { script: Some("bad.sh".into()), ..Default::default() });
        let out = run_verify(&bad, ws.path());
        assert!(!out.pass);
        assert_eq!(out.exit_code, Some(3));
        assert!(out.detail.contains("boom"), "{}", out.detail);
    }

    #[test]
    fn a_hung_script_is_killed_at_the_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let ws = git_workspace();
        std::fs::write(dir.path().join("hang.sh"), "sleep 60\n").unwrap();
        let task = task_with(
            dir.path(),
            VerifySpec { script: Some("hang.sh".into()), timeout_secs: Some(1), ..Default::default() },
        );
        let started = Instant::now();
        let out = run_verify(&task, ws.path());
        assert!(!out.pass);
        assert!(out.detail.contains("timed out"), "{}", out.detail);
        assert!(started.elapsed() < Duration::from_secs(20));
    }

    #[test]
    fn git_clean_passes_on_a_pristine_tree_and_fails_after_a_stray_edit() {
        let dir = tempfile::tempdir().unwrap();
        let ws = git_workspace();
        let task = task_with(dir.path(), VerifySpec { git_clean: true, ..Default::default() });
        assert!(run_verify(&task, ws.path()).pass);

        std::fs::write(ws.path().join("f.txt"), "drifted\n").unwrap();
        let out = run_verify(&task, ws.path());
        assert!(!out.pass);
        assert!(out.detail.contains("byte-identical"), "{}", out.detail);
    }

    #[test]
    fn a_verify_patch_lands_before_the_script_runs() {
        let dir = tempfile::tempdir().unwrap();
        let ws = git_workspace();
        std::fs::write(
            dir.path().join("verify.patch"),
            "--- a/f.txt\n+++ b/f.txt\n@@ -1 +1,2 @@\n content\n+injected test\n",
        )
        .unwrap();
        std::fs::write(dir.path().join("check.sh"), "grep -q 'injected test' f.txt\n").unwrap();
        let task = task_with(
            dir.path(),
            VerifySpec {
                patch: Some("verify.patch".into()),
                script: Some("check.sh".into()),
                ..Default::default()
            },
        );
        assert!(run_verify(&task, ws.path()).pass);
    }
}
