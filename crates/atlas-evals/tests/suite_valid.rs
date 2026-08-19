//! The committed task suite must always load and its workspaces must
//! prepare. This is the guard `evals/README.md` points task authors at —
//! a task with a bad rev, a missing referenced file, or a mutate patch
//! that no longer applies fails here, not mid-sweep.

use std::path::{Path, PathBuf};
use std::process::Command;

fn repo_root() -> PathBuf {
    // crates/atlas-evals → repo root.
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("repo root")
        .to_path_buf()
}

fn rev_available(repo: &Path, rev: &str) -> bool {
    Command::new("git")
        .args(["cat-file", "-e", &format!("{rev}^{{commit}}")])
        .current_dir(repo)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[test]
fn the_committed_suite_loads_and_names_every_smoke_task() {
    let repo = repo_root();
    let tasks = atlas_evals::task::load_tasks(&repo.join("evals/tasks")).expect("suite loads");
    assert!(tasks.len() >= 8, "seed suite shrank to {}", tasks.len());

    let raw = std::fs::read_to_string(repo.join("evals/suites/smoke.json")).unwrap();
    let suite: serde_json::Value = serde_json::from_str(&raw).unwrap();
    for id in suite["tasks"].as_array().unwrap() {
        let id = id.as_str().unwrap();
        assert!(
            tasks.iter().any(|t| t.id == id),
            "smoke suite names unknown task {id}"
        );
    }
}

#[test]
fn every_git_task_workspace_prepares_and_cleans_up() {
    let repo = repo_root();
    let tasks = atlas_evals::task::load_tasks(&repo.join("evals/tasks")).expect("suite loads");
    let scratch = tempfile::tempdir().unwrap();
    let mut skipped = 0usize;

    for task in &tasks {
        if let atlas_evals::task::WorkspaceSpec::Git { rev } = &task.workspace {
            // CI checkouts are shallow; a rev that isn't present locally is
            // a skip (counted, printed), not a failure.
            if !rev_available(&repo, rev) {
                eprintln!("skip {}: rev {rev} not in this checkout", task.id);
                skipped += 1;
                continue;
            }
        }
        let ws = atlas_evals::workspace::prepare(task, &repo, scratch.path(), &task.id)
            .unwrap_or_else(|e| panic!("{}: {e}", task.id));
        atlas_evals::workspace::cleanup(&ws).unwrap_or_else(|e| panic!("{}: cleanup: {e}", task.id));
    }
    eprintln!("validated {} tasks ({skipped} skipped)", tasks.len() - skipped);
}

#[test]
fn the_wordfreq_fixture_passes_its_own_tests_but_fails_the_hidden_verifier() {
    let repo = repo_root();
    let task_dir = repo.join("evals/tasks/feature/feature-wordfreq-top");
    let task = atlas_evals::task::load_task(&task_dir).unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let ws = atlas_evals::workspace::prepare(&task, &repo, scratch.path(), "wf").unwrap();

    // Pre-agent state: the feature is absent, so the verifier must fail —
    // a task that passes with no work done measures nothing.
    let out = atlas_evals::verify::run_verify(&task, &ws.root);
    assert!(!out.pass, "hidden verifier passed on the unmodified fixture");

    atlas_evals::workspace::cleanup(&ws).unwrap();
}
