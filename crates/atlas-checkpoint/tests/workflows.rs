//! Realistic developer workflows, driven against a real git repo.
//!
//! `linkage.rs` proves the link *rule*. This file asks a different question:
//! does a Checkpoint appear for the way people actually work?
//!
//! The link rule is asymmetric by design (see `checkpoint.rs`):
//!   * file existed in the parent commit → link on path alone (permissive)
//!   * file is new → link only if the committed blob matches what the agent wrote
//!
//! The second half is the interesting one. "Agent scaffolds a new file, I read
//! it and adjust a line before committing" is an extremely common loop, and
//! under the old exact-blob rule it produced **no Checkpoint at all** —
//! silently. The strict arm now measures how much of the agent's content
//! survived (see `sketch.rs`) instead of demanding all of it. These tests pin
//! which workflows produce a Checkpoint, so that regression stays fixed.

use std::path::Path;
use std::process::Command;

use atlas_checkpoint::model::WorkspaceMode;
use atlas_checkpoint::tools::{resolve_path, ToolName};
use atlas_checkpoint::{
    hash_written_content, walk_new_commits, Capture, FileWrite, SessionKey, Source, Store,
    ToolCallContent, ToolStatus,
};

struct Repo {
    dir: tempfile::TempDir,
}

impl Repo {
    fn new() -> Self {
        let r = Self { dir: tempfile::tempdir().unwrap() };
        r.git(&["init", "--initial-branch=main"]);
        r.git(&["config", "user.name", "Test Developer"]);
        r.git(&["config", "user.email", "dev@example.com"]);
        r
    }
    fn path(&self) -> &Path {
        self.dir.path()
    }
    fn id(&self) -> String {
        self.path().to_string_lossy().to_string()
    }
    fn git(&self, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(self.path())
            .args(args)
            .output()
            .expect("git runs");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }
    fn write(&self, rel: &str, content: &str) {
        let full = self.path().join(rel);
        if let Some(p) = full.parent() {
            std::fs::create_dir_all(p).unwrap();
        }
        std::fs::write(full, content).unwrap();
    }
    fn commit_all(&self, msg: &str) -> String {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-m", msg]);
        self.git(&["rev-parse", "HEAD"]).trim().to_string()
    }
    fn store(&self) -> Store {
        Store::open(self.path().join(".atlas")).expect("store opens")
    }
    fn walk(&self, store: &Store) -> atlas_checkpoint::WalkOutcome {
        walk_new_commits(store, &self.id(), self.path(), WorkspaceMode::Local).expect("walk")
    }
}

/// The agent writes `rel`. `content` is what it *wrote* — the committed file may
/// differ if the developer edits afterwards, which is the point of these tests.
fn agent_wrote(
    repo: &Repo,
    store: &mut Store,
    native_id: &str,
    plugin: &str,
    rel: &str,
    content: &str,
    existed_before: bool,
) -> String {
    repo.write(rel, content);
    let key = SessionKey {
        workspace_id: repo.id(),
        source: Source::Acp,
        native_session_id: native_id.to_string(),
    };
    let mut capture = Capture::new(store, WorkspaceMode::Local);
    let session_id = capture
        .record_prompt(&key, &format!("write {rel}"), 1, Some(plugin), Some("m"), Some(&repo.id()))
        .expect("prompt");
    let call = capture
        .record_tool_call(
            &session_id,
            ToolCallContent {
                turn_seq: 1,
                native_call_id: Some(&format!("{native_id}-{rel}")),
                tool_name: ToolName::Write,
                title: None,
                kind: Some("edit"),
                status: ToolStatus::Completed,
                locations: &serde_json::json!([]),
                arguments: None,
                result: None,
            },
        )
        .expect("tool call");
    let resolved = resolve_path(rel, repo.path());
    capture
        .record_file_write(
            &session_id,
            &call,
            1,
            FileWrite {
                path: &resolved,
                sha256_after: Some(hash_written_content(content.as_bytes())),
                sketch_after: atlas_checkpoint::sketch::sketch(content.as_bytes()),
                existed_before,
                deleted: false,
            },
        )
        .expect("file write");
    capture.finish_turn(&session_id, 1).expect("finish");
    session_id
}

fn checkpoints(store: &Store, sid: &str) -> usize {
    store.checkpoints_for_session(sid).expect("read").len()
}

// ── The workflows ────────────────────────────────────────────────────────────

/// Agent writes a brand-new file; developer commits it untouched.
#[test]
fn new_file_committed_verbatim_links() {
    let repo = Repo::new();
    repo.write("README.md", "seed\n");
    repo.commit_all("seed");
    let mut store = repo.store();
    repo.walk(&store);

    let sid = agent_wrote(&repo, &mut store, "s1", "claude-acp", "src/new.rs", "pub fn a() {}\n", false);
    repo.commit_all("add new.rs");
    repo.walk(&store);

    assert_eq!(checkpoints(&store, &sid), 1);
}

/// Agent edits a file that already existed; developer commits.
/// Permissive arm — links on path alone.
#[test]
fn existing_file_edited_links() {
    let repo = Repo::new();
    repo.write("src/existing.rs", "pub fn old() {}\n");
    repo.commit_all("seed with file");
    let mut store = repo.store();
    repo.walk(&store);

    let sid = agent_wrote(
        &repo,
        &mut store,
        "s2",
        "claude-acp",
        "src/existing.rs",
        "pub fn old() {}\npub fn added() {}\n",
        true,
    );
    repo.commit_all("extend existing.rs");
    repo.walk(&store);

    assert_eq!(checkpoints(&store, &sid), 1);
}

/// **The common loop.** Agent scaffolds a NEW file; the developer reads it and
/// tweaks one line before committing — a rename, a typo fix, an added comment.
///
/// Under the exact-blob rule for new files this links nothing. If this test
/// fails, that is the behaviour: real review-then-commit work produces no
/// Checkpoint, which reads to a user as "checkpoints aren't being created".
#[test]
fn new_file_tweaked_by_developer_before_commit_still_links() {
    let repo = Repo::new();
    repo.write("README.md", "seed\n");
    repo.commit_all("seed");
    let mut store = repo.store();
    repo.walk(&store);

    let sid = agent_wrote(
        &repo,
        &mut store,
        "s3",
        "claude-acp",
        "src/tweaked.rs",
        "pub fn generated() {}\n",
        false,
    );
    // Developer adjusts one line before committing — the normal review loop.
    repo.write("src/tweaked.rs", "pub fn generated() {}\n// reviewed\n");
    repo.commit_all("add tweaked.rs (reviewed)");
    repo.walk(&store);

    assert_eq!(
        checkpoints(&store, &sid),
        1,
        "agent-authored new file lost its Checkpoint because the developer \
         edited it before committing"
    );
}

/// Agent writes several files across a turn; developer commits them together.
#[test]
fn multi_file_turn_links_once() {
    let repo = Repo::new();
    repo.write("README.md", "seed\n");
    repo.commit_all("seed");
    let mut store = repo.store();
    repo.walk(&store);

    let sid = agent_wrote(&repo, &mut store, "s4", "claude-acp", "src/one.rs", "pub fn one() {}\n", false);
    // Same session, second file.
    {
        repo.write("src/two.rs", "pub fn two() {}\n");
        let mut capture = Capture::new(&mut store, WorkspaceMode::Local);
        let call = capture
            .record_tool_call(
                &sid,
                ToolCallContent {
                    turn_seq: 1,
                    native_call_id: Some("s4-two"),
                    tool_name: ToolName::Write,
                    title: None,
                    kind: Some("edit"),
                    status: ToolStatus::Completed,
                    locations: &serde_json::json!([]),
                    arguments: None,
                    result: None,
                },
            )
            .expect("tool call");
        let resolved = resolve_path("src/two.rs", repo.path());
        capture
            .record_file_write(
                &sid,
                &call,
                1,
                FileWrite {
                    path: &resolved,
                    sha256_after: Some(hash_written_content("pub fn two() {}\n".as_bytes())),
                    sketch_after: atlas_checkpoint::sketch::sketch("pub fn two() {}\n".as_bytes()),
                    existed_before: false,
                    deleted: false,
                },
            )
            .expect("write");
    }
    repo.commit_all("add both");
    repo.walk(&store);

    assert_eq!(checkpoints(&store, &sid), 1, "one commit should be one Checkpoint");
}

/// Developer commits in two steps: agent's file first, then unrelated work.
/// Only the first commit should be a Checkpoint (touches are consumed).
#[test]
fn touch_is_consumed_so_later_commits_do_not_relink() {
    let repo = Repo::new();
    repo.write("README.md", "seed\n");
    repo.commit_all("seed");
    let mut store = repo.store();
    repo.walk(&store);

    let sid = agent_wrote(&repo, &mut store, "s5", "claude-acp", "src/once.rs", "pub fn once() {}\n", false);
    repo.commit_all("agent work");
    repo.walk(&store);
    assert_eq!(checkpoints(&store, &sid), 1, "first commit links");

    // Later, purely human commit touching the same file.
    repo.write("src/once.rs", "pub fn once() {}\n// human\n");
    repo.commit_all("human follow-up");
    repo.walk(&store);

    assert_eq!(checkpoints(&store, &sid), 1, "the human follow-up must NOT relink");
}

/// Two agents, two files, one commit — both sessions should get a Checkpoint
/// for the commit that carried their work.
#[test]
fn two_agents_one_commit_both_link() {
    let repo = Repo::new();
    repo.write("README.md", "seed\n");
    repo.commit_all("seed");
    let mut store = repo.store();
    repo.walk(&store);

    let a = agent_wrote(&repo, &mut store, "sA", "claude-acp", "src/a.rs", "pub fn a() {}\n", false);
    let b = agent_wrote(&repo, &mut store, "sB", "codex-acp", "src/b.rs", "pub fn b() {}\n", false);
    repo.commit_all("both agents");
    repo.walk(&store);

    assert_eq!(checkpoints(&store, &a), 1, "claude session lost its Checkpoint");
    assert_eq!(checkpoints(&store, &b), 1, "codex session lost its Checkpoint");
}

/// Commit made while Atlas was closed, discovered by the open-time walk.
#[test]
fn commit_made_while_closed_is_recovered_on_next_walk() {
    let repo = Repo::new();
    repo.write("README.md", "seed\n");
    repo.commit_all("seed");
    let mut store = repo.store();
    repo.walk(&store);

    let sid = agent_wrote(&repo, &mut store, "s6", "claude-acp", "src/offline.rs", "pub fn off() {}\n", false);
    // Several commits happen with no walk in between (Atlas closed).
    repo.commit_all("agent work");
    repo.write("docs.md", "notes\n");
    repo.commit_all("unrelated");
    repo.write("more.md", "more\n");
    repo.commit_all("also unrelated");

    // Atlas reopens → single walk.
    repo.walk(&store);
    assert_eq!(checkpoints(&store, &sid), 1);
}
