//! Task suite loading. One task = one directory holding `task.json` (the
//! machine-readable spec), `prompt.md` (what the agent is told), and any
//! files the spec references (`mutate.patch`, `verify.patch`, `verify.sh`).
//! The directory name is the task id; the parent directory names the bucket.

use std::fmt;
use std::path::{Path, PathBuf};

use serde::Deserialize;

/// The three suite buckets of the harness plan: edit micro-bench,
/// history-derived repo tasks, multi-step feature tasks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Bucket {
    Edit,
    History,
    Feature,
}

impl fmt::Display for Bucket {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Bucket::Edit => "edit",
            Bucket::History => "history",
            Bucket::Feature => "feature",
        })
    }
}

/// Where the run's workspace comes from.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkspaceSpec {
    /// A detached git worktree of this repository at `rev`.
    Git { rev: String },
    /// A copy of a fixture directory (task-dir-relative or repo-relative),
    /// `git init`-ed so byte-exact verification and git-aware tools work.
    Fixture { path: String },
}

/// How a finished run is judged. All present checks must pass.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VerifySpec {
    /// Patch applied (`git apply --3way`) before the script runs — the
    /// history bucket injects the fix commit's tests this way.
    pub patch: Option<String>,
    /// Script run in the workspace root; exit 0 = pass.
    pub script: Option<String>,
    /// `git diff --exit-code` over tracked files — byte-exact restoration
    /// for the edit micro-bench.
    #[serde(default)]
    pub git_clean: bool,
    /// Seconds before the verify script is killed (default 600).
    pub timeout_secs: Option<u64>,
}

impl VerifySpec {
    pub fn is_empty(&self) -> bool {
        self.patch.is_none() && self.script.is_none() && !self.git_clean
    }
}

/// On-disk shape of `task.json`. `deny_unknown_fields` so a typo'd knob
/// fails loading instead of silently not applying.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct TaskFile {
    bucket: Bucket,
    workspace: WorkspaceSpec,
    /// Patch applied to the fresh workspace before the agent starts — the
    /// edit micro-bench introduces its mutation this way.
    setup_patch: Option<String>,
    verify: VerifySpec,
    /// Seconds before the run is cancelled (`cancel_turn`).
    timeout_secs: u64,
    /// Cap on model rounds within the prompt (the harness plan budgets
    /// repo tasks at 30).
    max_turns: Option<u32>,
}

/// A fully loaded, validated task.
#[derive(Debug, Clone)]
pub struct Task {
    pub id: String,
    pub bucket: Bucket,
    pub dir: PathBuf,
    pub prompt: String,
    pub workspace: WorkspaceSpec,
    pub setup_patch: Option<PathBuf>,
    pub verify: VerifySpec,
    pub timeout_secs: u64,
    pub max_turns: Option<u32>,
}

/// Load every task under `tasks_root` (`<root>/<bucket-dir>/<task-id>/`).
/// A malformed task is an error, not a skip — a suite that silently ran
/// fewer tasks than it claims is the "no silent drops" rule broken in the
/// tool that exists to measure it.
pub fn load_tasks(tasks_root: &Path) -> Result<Vec<Task>, String> {
    let mut tasks = Vec::new();
    let buckets = read_dir_sorted(tasks_root)
        .map_err(|e| format!("read tasks root {}: {e}", tasks_root.display()))?;
    for bucket_dir in buckets.iter().filter(|p| p.is_dir()) {
        for task_dir in read_dir_sorted(bucket_dir)
            .map_err(|e| format!("read bucket {}: {e}", bucket_dir.display()))?
            .iter()
            .filter(|p| p.is_dir())
        {
            tasks.push(load_task(task_dir)?);
        }
    }
    Ok(tasks)
}

/// Load and validate a single task directory.
pub fn load_task(dir: &Path) -> Result<Task, String> {
    let id = dir
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("task dir has no utf-8 name: {}", dir.display()))?
        .to_string();
    let ctx = |what: &str| format!("task {id}: {what}");

    let spec_path = dir.join("task.json");
    let raw = std::fs::read_to_string(&spec_path)
        .map_err(|e| ctx(&format!("read {}: {e}", spec_path.display())))?;
    let file: TaskFile =
        serde_json::from_str(&raw).map_err(|e| ctx(&format!("parse task.json: {e}")))?;

    let prompt = std::fs::read_to_string(dir.join("prompt.md"))
        .map_err(|e| ctx(&format!("read prompt.md: {e}")))?;
    if prompt.trim().is_empty() {
        return Err(ctx("prompt.md is empty"));
    }

    if let WorkspaceSpec::Git { rev } = &file.workspace {
        if rev.trim().is_empty() {
            return Err(ctx("workspace.rev is empty"));
        }
    }
    if file.verify.is_empty() {
        return Err(ctx("verify has no patch, script, or git_clean — nothing would be checked"));
    }
    if file.timeout_secs == 0 {
        return Err(ctx("timeout_secs must be > 0"));
    }

    let resolve = |name: &str| -> Result<PathBuf, String> {
        let p = dir.join(name);
        if p.is_file() {
            Ok(p)
        } else {
            Err(ctx(&format!("referenced file missing: {name}")))
        }
    };
    let setup_patch = file.setup_patch.as_deref().map(resolve).transpose()?;
    if let Some(p) = &file.verify.patch {
        resolve(p)?;
    }
    if let Some(s) = &file.verify.script {
        resolve(s)?;
    }

    Ok(Task {
        id,
        bucket: file.bucket,
        dir: dir.to_path_buf(),
        prompt,
        workspace: file.workspace,
        setup_patch,
        verify: file.verify,
        timeout_secs: file.timeout_secs,
        max_turns: file.max_turns,
    })
}

fn read_dir_sorted(dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| !n.starts_with('.'))
        })
        .collect();
    entries.sort();
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_task(dir: &Path, json: &str, prompt: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("task.json"), json).unwrap();
        std::fs::write(dir.join("prompt.md"), prompt).unwrap();
    }

    const OK_JSON: &str = r#"{
        "bucket": "edit",
        "workspace": {"kind": "git", "rev": "abc123"},
        "setup_patch": null,
        "verify": {"git_clean": true},
        "timeout_secs": 300,
        "max_turns": 10
    }"#;

    #[test]
    fn a_valid_task_loads_with_its_id_bucket_and_prompt() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("edit").join("edit-001");
        write_task(&dir, OK_JSON, "Restore the function.\n");
        let task = load_task(&dir).unwrap();
        assert_eq!(task.id, "edit-001");
        assert_eq!(task.bucket, Bucket::Edit);
        assert_eq!(task.prompt.trim(), "Restore the function.");
        assert_eq!(task.max_turns, Some(10));
        assert!(matches!(task.workspace, WorkspaceSpec::Git { ref rev } if rev == "abc123"));
    }

    #[test]
    fn a_task_with_no_verify_method_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("edit").join("edit-002");
        write_task(
            &dir,
            r#"{"bucket":"edit","workspace":{"kind":"git","rev":"x"},
                "setup_patch":null,"verify":{},"timeout_secs":300,"max_turns":null}"#,
            "p",
        );
        let err = load_task(&dir).unwrap_err();
        assert!(err.contains("nothing would be checked"), "{err}");
    }

    #[test]
    fn a_missing_referenced_file_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("history").join("h-001");
        write_task(
            &dir,
            r#"{"bucket":"history","workspace":{"kind":"git","rev":"x"},
                "setup_patch":null,
                "verify":{"patch":"verify.patch","script":"verify.sh"},
                "timeout_secs":900,"max_turns":30}"#,
            "p",
        );
        let err = load_task(&dir).unwrap_err();
        assert!(err.contains("referenced file missing"), "{err}");
    }

    #[test]
    fn an_unknown_field_in_task_json_is_rejected_not_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("edit").join("edit-003");
        write_task(
            &dir,
            r#"{"bucket":"edit","workspace":{"kind":"git","rev":"x"},
                "setup_patch":null,"verify":{"git_clean":true},
                "timeout_secs":300,"max_turns":null,"max_trns_typo":5}"#,
            "p",
        );
        assert!(load_task(&dir).is_err());
    }

    #[test]
    fn an_empty_prompt_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("edit").join("edit-004");
        write_task(&dir, OK_JSON, "  \n");
        let err = load_task(&dir).unwrap_err();
        assert!(err.contains("prompt.md is empty"), "{err}");
    }

    #[test]
    fn load_tasks_walks_buckets_in_sorted_order_and_fails_on_any_bad_task() {
        let tmp = tempfile::tempdir().unwrap();
        write_task(&tmp.path().join("edit").join("b-task"), OK_JSON, "p");
        write_task(&tmp.path().join("edit").join("a-task"), OK_JSON, "p");
        let tasks = load_tasks(tmp.path()).unwrap();
        assert_eq!(
            tasks.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            vec!["a-task", "b-task"]
        );

        // One malformed task fails the whole load — no silent drops.
        std::fs::create_dir_all(tmp.path().join("edit").join("c-broken")).unwrap();
        std::fs::write(
            tmp.path().join("edit").join("c-broken").join("task.json"),
            "{not json",
        )
        .unwrap();
        assert!(load_tasks(tmp.path()).is_err());
    }
}
