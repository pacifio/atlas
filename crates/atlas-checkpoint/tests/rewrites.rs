//! Surviving rebase, amend and squash — against real repositories.
//!
//! Without this, the feature quietly stops being true for anyone with a
//! clean-history habit. Every rewrite changes every commit hash involved,
//! nothing errors, and "trace any change back to the Session that produced it"
//! becomes false without anyone noticing.

use std::path::Path;
use std::process::Command;

use atlas_checkpoint::model::WorkspaceMode;
use atlas_checkpoint::tools::{resolve_path, ToolName};
use atlas_checkpoint::{
    hash_written_content, reconcile_rewrites, walk_new_commits, Capture, FileWrite, LinkState,
    SessionKey, Source, Store, ToolCallContent, ToolStatus,
};

const WORKSPACE: &str = "ws-atlas";

struct Fixture {
    dir: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let fixture = Self { dir: tempfile::tempdir().unwrap() };
        fixture.git(&["init", "--initial-branch=main"]);
        fixture.git(&["config", "user.name", "Test Developer"]);
        fixture.git(&["config", "user.email", "dev@example.com"]);
        fixture
    }

    fn path(&self) -> &Path {
        self.dir.path()
    }

    fn git(&self, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(self.path())
            .args(args)
            .output()
            .expect("git runs");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    fn write(&self, path: &str, content: &str) {
        let full = self.path().join(path);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(full, content).unwrap();
    }

    fn commit_all(&self, message: &str) -> String {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-m", message]);
        self.git(&["rev-parse", "HEAD"]).trim().to_string()
    }

    fn store(&self) -> Store {
        Store::open(self.path().join(".atlas")).expect("store opens")
    }

    fn walk(&self, store: &Store) {
        walk_new_commits(store, WORKSPACE, self.path(), WorkspaceMode::Local).expect("walk");
    }

    fn reconcile(&self, store: &Store) -> atlas_checkpoint::ReconcileOutcome {
        reconcile_rewrites(store, WORKSPACE, self.path()).expect("reconcile")
    }
}

/// Record a Session that wrote `path`, then commit it — returning the Session id.
fn agent_commit(
    fixture: &Fixture,
    store: &mut Store,
    native_id: &str,
    path: &str,
    content: &str,
    message: &str,
) -> String {
    let session_id = {
        let mut capture = Capture::new(store, WorkspaceMode::Local);
        let key = SessionKey {
            workspace_id: WORKSPACE.to_string(),
            source: Source::Acp,
            native_session_id: native_id.to_string(),
        };
        let session_id = capture
            .record_prompt(&key, &format!("work on {path}"), 1, Some("claude-code"), None, None)
            .expect("prompt");

        let call = capture
            .record_tool_call(
                &session_id,
                ToolCallContent {
                    turn_seq: 1,
                    native_call_id: Some(&format!("{native_id}-call")),
                    tool_name: ToolName::Edit,
                    title: None,
                    kind: Some("edit"),
                    status: ToolStatus::Completed,
                    locations: &serde_json::json!([]),
                    arguments: None,
                    result: None,
                },
            )
            .expect("tool call");

        fixture.write(path, content);
        let resolved = resolve_path(path, fixture.path());
        capture
            .record_file_write(
                &session_id,
                &call,
                1,
                FileWrite {
                    path: &resolved,
                    sha256_after: Some(hash_written_content(content.as_bytes())),
                sketch_after: atlas_checkpoint::sketch::sketch(content.as_bytes()),
                    existed_before: true,
                    deleted: false,
                },
            )
            .expect("file touch");
        session_id
    };

    fixture.commit_all(message);
    fixture.walk(store);
    session_id
}

fn only_checkpoint(store: &Store, session: &str) -> atlas_checkpoint::Checkpoint {
    let checkpoints = store.checkpoints_for_session(session).unwrap();
    assert_eq!(checkpoints.len(), 1, "expected one Checkpoint, got {checkpoints:?}");
    checkpoints[0].clone()
}

// ── Amend ───────────────────────────────────────────────────────────────────

#[test]
fn an_amend_re_points_the_checkpoint_rather_than_orphaning_it() {
    let fixture = Fixture::new();
    fixture.write("src/lib.rs", "original\n");
    fixture.commit_all("initial");
    let mut store = fixture.store();
    fixture.walk(&store);

    let session = agent_commit(
        &fixture,
        &mut store,
        "s1",
        "src/lib.rs",
        "agent version\n",
        "agent change",
    );
    let before = only_checkpoint(&store, &session);

    // A routine fixup must not cost the link.
    fixture.git(&["commit", "--amend", "-m", "agent change, with a better message"]);
    let new_sha = fixture.git(&["rev-parse", "HEAD"]).trim().to_string();
    assert_ne!(before.commit_sha, new_sha);

    let outcome = fixture.reconcile(&store);
    assert_eq!(outcome.relinked, 1);
    assert_eq!(outcome.orphaned, 0);

    let after = only_checkpoint(&store, &session);
    assert_eq!(after.commit_sha, new_sha);
    assert_eq!(after.link_state, LinkState::Linked);
    assert_eq!(after.session_id, session, "the Session link is preserved");
}

// ── Rebase ──────────────────────────────────────────────────────────────────

#[test]
fn a_rebase_re_points_affected_checkpoints_and_the_developer_never_notices() {
    let fixture = Fixture::new();
    fixture.write("base.rs", "base\n");
    fixture.commit_all("initial");
    let mut store = fixture.store();
    fixture.walk(&store);

    fixture.git(&["checkout", "-b", "feature"]);
    let session = agent_commit(
        &fixture,
        &mut store,
        "s1",
        "src/lib.rs",
        "agent work\n",
        "agent work",
    );
    let before = only_checkpoint(&store, &session);

    // Main moves on, then the feature branch is rebased onto it.
    fixture.git(&["checkout", "main"]);
    fixture.write("other.rs", "other\n");
    fixture.commit_all("unrelated work on main");
    fixture.git(&["checkout", "feature"]);
    fixture.git(&["rebase", "main"]);

    let new_sha = fixture.git(&["rev-parse", "HEAD"]).trim().to_string();
    assert_ne!(before.commit_sha, new_sha, "rebase rewrote the commit");

    let outcome = fixture.reconcile(&store);
    assert_eq!(outcome.relinked, 1);

    let after = only_checkpoint(&store, &session);
    assert_eq!(after.commit_sha, new_sha);
    assert_eq!(after.link_state, LinkState::Linked);
}

#[test]
fn a_rewrite_performed_while_atlas_was_closed_is_reconciled_on_next_open() {
    let fixture = Fixture::new();
    fixture.write("src/lib.rs", "original\n");
    fixture.commit_all("initial");

    let session = {
        let mut store = fixture.store();
        fixture.walk(&store);
        agent_commit(&fixture, &mut store, "s1", "src/lib.rs", "agent\n", "agent change")
        // Store dropped — Atlas is closed.
    };

    fixture.git(&["commit", "--amend", "-m", "rewritten while Atlas was shut"]);
    let new_sha = fixture.git(&["rev-parse", "HEAD"]).trim().to_string();

    // This is what a git hook could never do: the rewrite happened when nothing
    // was listening.
    let store = fixture.store();
    assert_eq!(fixture.reconcile(&store).relinked, 1);
    assert_eq!(only_checkpoint(&store, &session).commit_sha, new_sha);
}

// ── Squash ──────────────────────────────────────────────────────────────────

#[test]
fn squashing_orphans_the_affected_checkpoints_rather_than_mis_attaching_them() {
    // Several patches collapse into one that matches none of them. Saying so is
    // the honest outcome; attaching all of them to the squashed commit would be
    // a confident lie.
    let fixture = Fixture::new();
    fixture.write("src/lib.rs", "original\n");
    fixture.commit_all("initial");
    let mut store = fixture.store();
    fixture.walk(&store);

    // Distinct files per Session, so each links to exactly one commit. Sharing a
    // path would make the first Session link to the second commit too — correct
    // under the permissive arm of the link rule, but it would obscure what this
    // test is about.
    let first = agent_commit(&fixture, &mut store, "s1", "src/one.rs", "step one\n", "one");
    let second = agent_commit(&fixture, &mut store, "s2", "src/two.rs", "step two\n", "two");

    // Squash the two agent commits into one.
    fixture.git(&["reset", "--soft", "HEAD~2"]);
    fixture.git(&["commit", "-m", "squashed"]);

    let outcome = fixture.reconcile(&store);
    assert_eq!(outcome.relinked, 0);
    assert_eq!(outcome.orphaned, 2);

    for session in [&first, &second] {
        let checkpoint = only_checkpoint(&store, session);
        assert_eq!(checkpoint.link_state, LinkState::Orphaned);
        // Never deleted, and the Session link is retained.
        assert_eq!(&checkpoint.session_id, session);
    }
}

#[test]
fn a_conflict_resolved_differently_orphans_rather_than_mis_matching() {
    let fixture = Fixture::new();
    fixture.write("src/lib.rs", "original\n");
    fixture.commit_all("initial");
    let mut store = fixture.store();
    fixture.walk(&store);

    let session = agent_commit(
        &fixture,
        &mut store,
        "s1",
        "src/lib.rs",
        "the agent's resolution\n",
        "agent change",
    );

    // The commit is rewritten with different content — the same intent, a
    // different diff, so a different patch-id.
    fixture.git(&["reset", "--hard", "HEAD~1"]);
    fixture.write("src/lib.rs", "a different resolution entirely\n");
    fixture.commit_all("resolved differently");

    let outcome = fixture.reconcile(&store);
    assert_eq!(outcome.orphaned, 1);
    assert_eq!(only_checkpoint(&store, &session).link_state, LinkState::Orphaned);
}

// ── Ambiguity ───────────────────────────────────────────────────────────────

#[test]
fn a_cherry_pick_collision_orphans_rather_than_picking_arbitrarily() {
    // The same diff reachable at two commits. A wrong link silently corrupts a
    // shared Organisation timeline; an orphan is honest and recoverable.
    let fixture = Fixture::new();
    fixture.write("src/lib.rs", "original\n");
    fixture.commit_all("initial");
    let mut store = fixture.store();
    fixture.walk(&store);

    fixture.git(&["checkout", "-b", "feature"]);
    let session = agent_commit(
        &fixture,
        &mut store,
        "s1",
        "src/lib.rs",
        "agent work\n",
        "agent work",
    );
    let original = only_checkpoint(&store, &session).commit_sha.clone();

    // Two branches each cherry-pick the same change. Each needs its own
    // preceding commit: without a differing parent, git produces a
    // *bit-identical* commit — same tree, message, author and timestamp — and
    // there is no collision to resolve at all.
    fixture.git(&["checkout", "main"]);
    fixture.write("main-only.rs", "main\n");
    fixture.commit_all("unrelated work on main");
    fixture.git(&["cherry-pick", &original]);

    fixture.git(&["checkout", "-b", "release", "main~1"]);
    fixture.write("release-only.rs", "release\n");
    fixture.commit_all("unrelated work on release");
    fixture.git(&["cherry-pick", &original]);

    // The branch the Checkpoint was recorded on is rewritten away, so the
    // recorded commit is gone and two commits with an identical patch-id remain.
    fixture.git(&["checkout", "main"]);
    fixture.git(&["branch", "-D", "feature"]);

    let outcome = fixture.reconcile(&store);
    assert_eq!(
        outcome.orphaned, 1,
        "ambiguous patch-id must orphan, never pick arbitrarily"
    );
    assert_eq!(outcome.relinked, 0);
    assert_eq!(
        only_checkpoint(&store, &session).link_state,
        LinkState::Orphaned
    );
}

#[test]
fn a_patch_id_collision_resolves_to_the_checkpoints_recorded_branch_when_it_can() {
    // The branch preference is what makes a cherry-pick recoverable rather than
    // always an orphan.
    let fixture = Fixture::new();
    fixture.write("src/lib.rs", "original\n");
    fixture.commit_all("initial");
    let mut store = fixture.store();
    fixture.walk(&store);

    fixture.git(&["checkout", "-b", "feature"]);
    let session = agent_commit(
        &fixture,
        &mut store,
        "s1",
        "src/lib.rs",
        "agent work\n",
        "agent work",
    );
    let original = only_checkpoint(&store, &session).commit_sha.clone();

    // The same change is cherry-picked to another branch…
    fixture.git(&["checkout", "-b", "release", "main"]);
    fixture.write("release-only.rs", "release\n");
    fixture.commit_all("unrelated work on release");
    fixture.git(&["cherry-pick", &original]);

    // …and the recorded branch is then rebased, rewriting its commit but
    // keeping the branch itself.
    fixture.git(&["checkout", "main"]);
    fixture.write("main-only.rs", "main\n");
    fixture.commit_all("unrelated work on main");
    fixture.git(&["checkout", "feature"]);
    fixture.git(&["rebase", "main"]);

    let outcome = fixture.reconcile(&store);
    assert_eq!(outcome.relinked, 1, "the recorded branch disambiguates");
    let after = only_checkpoint(&store, &session);
    assert_eq!(after.link_state, LinkState::Linked);
    assert_ne!(after.commit_sha, original, "re-pointed at the rewritten commit");
}

#[test]
fn an_empty_commit_never_participates_in_matching() {
    // The patch-id of an empty diff is a constant, so every empty commit would
    // "match" every other one.
    let fixture = Fixture::new();
    fixture.write("src/lib.rs", "original\n");
    fixture.commit_all("initial");
    let store = fixture.store();
    fixture.walk(&store);

    fixture.git(&["commit", "--allow-empty", "-m", "empty one"]);
    fixture.git(&["commit", "--allow-empty", "-m", "empty two"]);
    fixture.walk(&store);

    // No Checkpoint could form for an empty commit in the first place — there
    // are no changed paths — so reconciliation has nothing to confuse.
    let outcome = fixture.reconcile(&store);
    assert_eq!(outcome.relinked, 0);
    assert_eq!(outcome.orphaned, 0);
}

// ── Recovery, idempotency, and reporting ────────────────────────────────────

#[test]
fn an_orphan_whose_commit_becomes_reachable_again_is_re_linked() {
    // A reverted force-push.
    let fixture = Fixture::new();
    fixture.write("src/lib.rs", "original\n");
    fixture.commit_all("initial");
    let mut store = fixture.store();
    fixture.walk(&store);

    let session = agent_commit(&fixture, &mut store, "s1", "src/lib.rs", "agent\n", "agent change");
    let commit = only_checkpoint(&store, &session).commit_sha.clone();

    // Rewind past it, so the commit is unreachable and the Checkpoint orphans.
    fixture.git(&["reset", "--hard", "HEAD~1"]);
    assert_eq!(fixture.reconcile(&store).orphaned, 1);
    assert_eq!(only_checkpoint(&store, &session).link_state, LinkState::Orphaned);

    // The developer undoes the force-push.
    fixture.git(&["reset", "--hard", &commit]);
    let outcome = fixture.reconcile(&store);
    assert_eq!(outcome.recovered, 1);
    assert_eq!(only_checkpoint(&store, &session).link_state, LinkState::Linked);
}

#[test]
fn reconciliation_is_idempotent() {
    let fixture = Fixture::new();
    fixture.write("src/lib.rs", "original\n");
    fixture.commit_all("initial");
    let mut store = fixture.store();
    fixture.walk(&store);

    let session = agent_commit(&fixture, &mut store, "s1", "src/lib.rs", "agent\n", "agent change");
    fixture.git(&["commit", "--amend", "-m", "amended"]);

    let first = fixture.reconcile(&store);
    assert_eq!(first.relinked, 1);

    // Running it again changes nothing.
    for _ in 0..3 {
        let again = fixture.reconcile(&store);
        assert_eq!(again.relinked, 0);
        assert_eq!(again.orphaned, 0);
        assert_eq!(again.recovered, 0);
    }
    assert_eq!(only_checkpoint(&store, &session).link_state, LinkState::Linked);
}

#[test]
fn reconciliation_with_everything_reachable_does_nothing() {
    let fixture = Fixture::new();
    fixture.write("src/lib.rs", "original\n");
    fixture.commit_all("initial");
    let mut store = fixture.store();
    fixture.walk(&store);
    agent_commit(&fixture, &mut store, "s1", "src/lib.rs", "agent\n", "agent change");

    assert_eq!(
        fixture.reconcile(&store),
        atlas_checkpoint::ReconcileOutcome::default()
    );
}

#[test]
fn a_history_wide_rewrite_reports_a_single_mass_orphan_summary() {
    // Correct behaviour, but the developer should learn *why* their timeline
    // just changed, rather than discovering it link by link.
    let fixture = Fixture::new();
    fixture.write("seed.rs", "seed\n");
    fixture.commit_all("initial");
    let mut store = fixture.store();
    fixture.walk(&store);

    for i in 0..6 {
        agent_commit(
            &fixture,
            &mut store,
            &format!("s{i}"),
            "src/lib.rs",
            &format!("agent step {i}\n"),
            &format!("step {i}"),
        );
    }

    // Rewrite everything into one commit.
    fixture.git(&["reset", "--soft", "HEAD~6"]);
    fixture.git(&["commit", "-m", "one commit to rule them all"]);

    let outcome = fixture.reconcile(&store);
    assert!(
        outcome.is_mass_orphan(),
        "expected a mass-orphan summary, got {outcome:?}"
    );
    assert!(outcome.orphaned >= 5);
}

#[test]
fn reconciliation_mid_rebase_defers_rather_than_orphaning_prematurely() {
    // During a rebase the old commits are already detached and the new ones do
    // not exist yet. Orphaning in that window would be wrong, and orphaning is
    // not something to do speculatively.
    let fixture = Fixture::new();
    fixture.write("src/lib.rs", "original\n");
    fixture.commit_all("initial");
    let mut store = fixture.store();
    fixture.walk(&store);

    let session = agent_commit(&fixture, &mut store, "s1", "src/lib.rs", "agent\n", "agent change");

    // Simulate the transient state git leaves on disk mid-rebase.
    std::fs::create_dir_all(fixture.path().join(".git/rebase-merge")).unwrap();

    let outcome = fixture.reconcile(&store);
    assert!(outcome.deferred, "must defer while a rewrite is in progress");
    assert_eq!(outcome.orphaned, 0);
    assert_eq!(
        only_checkpoint(&store, &session).link_state,
        LinkState::Linked,
        "nothing may be orphaned mid-rewrite"
    );

    // Once the rewrite finishes, reconciliation runs normally.
    std::fs::remove_dir_all(fixture.path().join(".git/rebase-merge")).unwrap();
    assert!(!fixture.reconcile(&store).deferred);
}

#[test]
fn orphaned_is_a_queryable_state_that_retains_its_session_link() {
    let fixture = Fixture::new();
    fixture.write("src/lib.rs", "original\n");
    fixture.commit_all("initial");
    let mut store = fixture.store();
    fixture.walk(&store);

    let session = agent_commit(&fixture, &mut store, "s1", "src/lib.rs", "agent\n", "agent change");
    fixture.git(&["reset", "--hard", "HEAD~1"]);
    fixture.reconcile(&store);

    let orphaned: Vec<_> = store
        .checkpoints_for_workspace(WORKSPACE)
        .unwrap()
        .into_iter()
        .filter(|cp| cp.link_state == LinkState::Orphaned)
        .collect();
    assert_eq!(orphaned.len(), 1);
    assert_eq!(orphaned[0].session_id, session);
    // The Session is still there and still readable.
    assert!(store.session(&session).unwrap().is_some());
}

// ── The production sequence: walk, then reconcile ───────────────────────────
//
// The watcher job runs `walk_new_commits` first and `reconcile_rewrites`
// second on every git event. The tests above drive reconcile in isolation;
// these drive the sequence production actually uses, where the walk sees the
// rewritten commits *before* reconciliation looks at the stale rows — the
// ordering that used to wedge reconciliation on a UNIQUE collision (amend) and
// re-attach orphans to the squashed commit (squash).

/// One watcher event, as production orders it.
fn git_event(fixture: &Fixture, store: &Store) -> atlas_checkpoint::ReconcileOutcome {
    fixture.walk(store);
    fixture.reconcile(store)
}

#[test]
fn the_production_sequence_survives_an_amend() {
    let fixture = Fixture::new();
    fixture.write("src/lib.rs", "original\n");
    fixture.commit_all("initial");
    let mut store = fixture.store();
    fixture.walk(&store);

    let session = agent_commit(&fixture, &mut store, "s1", "src/lib.rs", "agent\n", "agent change");
    fixture.git(&["commit", "--amend", "-m", "amended"]);
    let new_sha = fixture.git(&["rev-parse", "HEAD"]).trim().to_string();

    let outcome = git_event(&fixture, &store);
    assert_eq!(outcome.relinked, 1);
    assert_eq!(outcome.orphaned, 0);
    assert_eq!(outcome.failed, 0);

    // Exactly one Checkpoint, Linked, at the new sha — no duplicate row from
    // the walk, no stale row wedged at the rewritten-away sha.
    let after = only_checkpoint(&store, &session);
    assert_eq!(after.commit_sha, new_sha);
    assert_eq!(after.link_state, LinkState::Linked);

    // And the next events are no-ops: the sequence is idempotent.
    for _ in 0..3 {
        let again = git_event(&fixture, &store);
        assert_eq!((again.relinked, again.orphaned, again.recovered, again.failed), (0, 0, 0, 0));
    }
    assert_eq!(only_checkpoint(&store, &session).commit_sha, new_sha);
}

#[test]
fn reconcile_before_walk_also_survives_an_amend() {
    // The other ordering must hold too — the fix cannot depend on which half
    // runs first.
    let fixture = Fixture::new();
    fixture.write("src/lib.rs", "original\n");
    fixture.commit_all("initial");
    let mut store = fixture.store();
    fixture.walk(&store);

    let session = agent_commit(&fixture, &mut store, "s1", "src/lib.rs", "agent\n", "agent change");
    fixture.git(&["commit", "--amend", "-m", "amended"]);
    let new_sha = fixture.git(&["rev-parse", "HEAD"]).trim().to_string();

    assert_eq!(fixture.reconcile(&store).relinked, 1);
    fixture.walk(&store);

    let after = only_checkpoint(&store, &session);
    assert_eq!(after.commit_sha, new_sha);
    assert_eq!(after.link_state, LinkState::Linked);
}

#[test]
fn the_production_sequence_survives_a_rebase() {
    let fixture = Fixture::new();
    fixture.write("base.rs", "base\n");
    fixture.commit_all("initial");
    let mut store = fixture.store();
    fixture.walk(&store);

    fixture.git(&["checkout", "-b", "feature"]);
    let session = agent_commit(&fixture, &mut store, "s1", "src/lib.rs", "agent\n", "agent work");

    fixture.git(&["checkout", "main"]);
    fixture.write("other.rs", "other\n");
    fixture.commit_all("unrelated work on main");
    fixture.git(&["checkout", "feature"]);
    fixture.git(&["rebase", "main"]);
    let new_sha = fixture.git(&["rev-parse", "HEAD"]).trim().to_string();

    let outcome = git_event(&fixture, &store);
    assert_eq!(outcome.relinked, 1);
    assert_eq!(outcome.failed, 0);

    let after = only_checkpoint(&store, &session);
    assert_eq!(after.commit_sha, new_sha);
    assert_eq!(after.link_state, LinkState::Linked);

    let again = git_event(&fixture, &store);
    assert_eq!((again.relinked, again.orphaned, again.recovered, again.failed), (0, 0, 0, 0));
    assert_eq!(only_checkpoint(&store, &session).commit_sha, new_sha);
}

#[test]
fn the_production_sequence_orphans_a_squash_without_reattaching() {
    // ATL-84: squashing marks the affected Checkpoints orphaned *rather than
    // attaching them all to the squashed commit*. The walk sees the squashed
    // commit first; touch consumption is what stops it from confidently
    // re-linking every Session whose paths the squash carries.
    let fixture = Fixture::new();
    fixture.write("src/lib.rs", "original\n");
    fixture.commit_all("initial");
    let mut store = fixture.store();
    fixture.walk(&store);

    let first = agent_commit(&fixture, &mut store, "s1", "src/one.rs", "step one\n", "one");
    let second = agent_commit(&fixture, &mut store, "s2", "src/two.rs", "step two\n", "two");

    fixture.git(&["reset", "--soft", "HEAD~2"]);
    fixture.git(&["commit", "-m", "squashed"]);
    let squashed = fixture.git(&["rev-parse", "HEAD"]).trim().to_string();

    let outcome = git_event(&fixture, &store);
    assert_eq!(outcome.relinked, 0);
    assert_eq!(outcome.orphaned, 2);
    assert_eq!(outcome.failed, 0);

    for session in [&first, &second] {
        let checkpoint = only_checkpoint(&store, session);
        assert_eq!(checkpoint.link_state, LinkState::Orphaned);
        assert_eq!(&checkpoint.session_id, session);
    }
    assert!(
        store.checkpoints_for_commit(&squashed).unwrap().is_empty(),
        "nothing may confidently attach to the squashed commit"
    );

    // Repeated events change nothing.
    let again = git_event(&fixture, &store);
    assert_eq!((again.relinked, again.orphaned, again.recovered, again.failed), (0, 0, 0, 0));
    assert!(store.checkpoints_for_commit(&squashed).unwrap().is_empty());
}

#[test]
fn a_commit_kept_alive_only_by_a_tag_is_not_orphaned() {
    // A tagged release whose branch moved on is permanently reachable — via
    // the tag. Orphaning it would be false.
    let fixture = Fixture::new();
    fixture.write("src/lib.rs", "original\n");
    fixture.commit_all("initial");
    let mut store = fixture.store();
    fixture.walk(&store);

    let session = agent_commit(&fixture, &mut store, "s1", "src/lib.rs", "agent\n", "agent change");
    fixture.git(&["tag", "v1.0"]);
    fixture.git(&["reset", "--hard", "HEAD~1"]);

    let outcome = git_event(&fixture, &store);
    assert_eq!(outcome.orphaned, 0);
    assert_eq!(only_checkpoint(&store, &session).link_state, LinkState::Linked);
}

#[test]
fn a_mass_orphan_writes_a_reconcile_note_and_a_clean_pass_zeroes_it() {
    // ATL-84: a history-wide rewrite surfaces one summary through the
    // capture-health signal — persisted, not just logged.
    let fixture = Fixture::new();
    fixture.write("seed.rs", "seed\n");
    fixture.commit_all("initial");
    let mut store = fixture.store();
    fixture.walk(&store);

    for i in 0..6 {
        agent_commit(
            &fixture,
            &mut store,
            &format!("s{i}"),
            "src/lib.rs",
            &format!("agent step {i}\n"),
            &format!("step {i}"),
        );
    }
    fixture.git(&["reset", "--soft", "HEAD~6"]);
    fixture.git(&["commit", "-m", "one commit to rule them all"]);

    let outcome = git_event(&fixture, &store);
    assert!(outcome.is_mass_orphan());

    let note = store.reconcile_note(WORKSPACE).unwrap().expect("a persisted note");
    let parsed: serde_json::Value = serde_json::from_str(&note).unwrap();
    assert_eq!(parsed["orphaned"], 6);
    assert_eq!(parsed["failed"], 0);
    assert!(parsed["at"].is_string());

    // The next, clean pass resets the note: the signal is current state, not
    // history — an alarm that never clears is an alarm nobody reads.
    let again = git_event(&fixture, &store);
    assert_eq!(again.orphaned, 0);
    let note = store.reconcile_note(WORKSPACE).unwrap().expect("still present, zeroed");
    let parsed: serde_json::Value = serde_json::from_str(&note).unwrap();
    assert_eq!(parsed["orphaned"], 0);
}

#[test]
fn reconciliation_does_not_noticeably_slow_a_repository_with_a_long_history() {
    let fixture = Fixture::new();
    fixture.write("seed.rs", "seed\n");
    fixture.commit_all("initial");
    let mut store = fixture.store();
    fixture.walk(&store);

    agent_commit(&fixture, &mut store, "s1", "src/lib.rs", "agent\n", "agent change");
    for i in 0..60 {
        fixture.write("filler.rs", &format!("filler {i}\n"));
        fixture.commit_all(&format!("filler {i}"));
    }
    fixture.walk(&store);

    let started = std::time::Instant::now();
    fixture.reconcile(&store);
    assert!(
        started.elapsed().as_secs() < 10,
        "reconciliation took {:?}",
        started.elapsed()
    );
}

