//! Conflicts on the desktop (ATL-410), through the crate's public API: a Run's
//! hunks that overlap what canonical state took since the Run forked are held
//! and raised as Conflicts while the rest of the Run lands; two Runs racing on
//! the same lines never interleave; and every way of resolving one produces the
//! same file on every replica. The server is the in-process fake, which keeps
//! the real one's compare-and-set on merge versions.

use std::time::Duration;

use atlas_thread_sync::{
    ActiveRun, FakeThreadServer, FakeTransport, Resolve, RunSpec, RunWorktree, SessionError,
    ThreadSession,
};
use sha2::{Digest, Sha256};

mod common;
use common::*;

const QUIET: Duration = Duration::from_millis(50);

/// Twenty-five numbered lines, with `edits` (1-based line, text) applied.
fn lines_with(edits: &[(usize, &str)]) -> String {
    (1..=25)
        .map(|n| {
            let line = edits
                .iter()
                .find(|(at, _)| *at == n)
                .map_or_else(|| format!("line {n}"), |(_, t)| (*t).to_string());
            format!("{line}\n")
        })
        .collect()
}

fn spec(agent: &str) -> RunSpec {
    RunSpec {
        run_id: RunSpec::new_id(),
        agent: agent.into(),
        model: "test-model".into(),
        context_anchor: None,
        remote_request_id: None,
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

struct Thread {
    w: World,
    server: FakeThreadServer,
    joy: ThreadSession<FakeTransport>,
    monzim: ThreadSession<FakeTransport>,
    joy_runs: RunWorktree,
    monzim_runs: RunWorktree,
}

/// Joy shares a thread holding `src/app.ts` (25 lines); Monzim joins. Both
/// are checked out, and each has a Run worktree.
async fn thread() -> Thread {
    let w = world();
    let server = FakeThreadServer::new();
    let mut joy = open(&server, &w.joy, &w.base, &w.replicas.join("joy"), "joy").await;
    joy.share_working_changes(&w.joy, &[]).await.unwrap();
    let joy_root = joy.materialize().await.unwrap();
    write(&joy_root, "src/app.ts", &lines_with(&[]));
    joy.file_saved("src/app.ts").await.unwrap();
    let mut monzim = open(
        &server,
        &w.monzim,
        &w.base,
        &w.replicas.join("monzim"),
        "monzim",
    )
    .await;
    monzim.materialize().await.unwrap();
    monzim.pump(QUIET).await.unwrap();
    let joy_runs = RunWorktree::new(&w.joy, &w.base, &w.replicas.join("joy-run"));
    let monzim_runs = RunWorktree::new(&w.monzim, &w.base, &w.replicas.join("monzim-run"));
    Thread {
        w,
        server,
        joy,
        monzim,
        joy_runs,
        monzim_runs,
    }
}

/// Joy types `text` on 1-based `line` of `src/app.ts`, on top of whatever is there.
async fn joy_types(t: &mut Thread, line: usize, text: &str) {
    let root = t.joy.replica().root().to_path_buf();
    let mut lines: Vec<String> = read(&root, "src/app.ts")
        .lines()
        .map(String::from)
        .collect();
    lines[line - 1] = text.to_string();
    write(&root, "src/app.ts", &(lines.join("\n") + "\n"));
    t.joy.file_saved("src/app.ts").await.unwrap();
}

/// A Run of Monzim's that changes `edits` of `src/app.ts` (and makes a new
/// file), finished after Joy typed on line 19. One Conflict, on line 19.
async fn conflicted(t: &mut Thread) -> (ActiveRun, u64) {
    let run = t
        .monzim
        .start_run(&t.monzim_runs, spec("codex"))
        .await
        .unwrap();
    write(
        &run.worktree,
        "src/app.ts",
        &lines_with(&[(2, "run 2"), (19, "run 19")]),
    );
    write(&run.worktree, "src/new.ts", "export const fresh = true;\n");
    joy_types(t, 19, "joy 19").await;
    t.monzim.pump(QUIET).await.unwrap();
    let report = t.monzim.finish_run(&run, &t.monzim_runs).await.unwrap();
    assert_eq!(report.conflicts.len(), 1, "{report:?}");
    t.joy.pump(QUIET).await.unwrap();
    (run, report.conflicts[0])
}

fn app(session: &ThreadSession<FakeTransport>) -> String {
    read(session.replica().root(), "src/app.ts")
}

#[tokio::test]
async fn typing_on_a_runs_line_raises_a_conflict_and_the_rest_of_the_run_lands() {
    let mut t = thread().await;
    let (run, conflict_id) = conflicted(&mut t).await;

    // Line 2 and the new file landed; line 19 keeps Joy's typing — on both.
    let expected = lines_with(&[(2, "run 2"), (19, "joy 19")]);
    assert_eq!(app(&t.monzim), expected);
    assert_eq!(app(&t.joy), expected);
    assert_eq!(
        read(t.joy.replica().root(), "src/new.ts"),
        "export const fresh = true;\n"
    );

    let raised = t.server.conflicts();
    assert_eq!(raised.len(), 1);
    let c = &raised[0];
    assert_eq!(c.conflict_id, conflict_id);
    assert_eq!(c.path, "src/app.ts");
    assert_eq!((c.lines.unwrap().start, c.lines.unwrap().end), (18, 19));
    assert_eq!(c.base.as_deref(), Some("line 19\n"));
    assert_eq!(c.canonical.as_deref(), Some("joy 19\n"));
    assert_eq!(c.run.as_deref(), Some("run 19\n"));
    assert!(c.involved.people.contains(&"joy".to_string()));

    // The view: base, each side with who and which agent, and a proposal.
    for session in [&t.joy, &t.monzim] {
        let views = session.conflicts();
        assert_eq!(views.len(), 1);
        let v = &views[0];
        assert!(v.conflict.is_open());
        assert_eq!(v.run_by.as_deref(), Some("monzim"));
        assert_eq!(v.run_agent.as_deref(), Some("codex"));
        assert_eq!(v.canonical_by, vec!["joy".to_string()]);
        assert_eq!(v.proposed.as_deref(), Some("joy 19\nrun 19\n"));
        assert_eq!(session.open_conflicts(), 1);
    }
    let status = |id: &str| {
        t.server
            .runs()
            .into_iter()
            .find(|r| r.run_id == id)
            .unwrap()
            .status
    };
    assert_eq!(status(&run.run_id), "merged");
}

#[tokio::test]
async fn two_runs_racing_on_the_same_lines_never_interleave() {
    let mut t = thread().await;
    let joy_run = t
        .joy
        .start_run(&t.joy_runs, spec("claude-code"))
        .await
        .unwrap();
    let monzim_run = t
        .monzim
        .start_run(&t.monzim_runs, spec("codex"))
        .await
        .unwrap();
    write(
        &joy_run.worktree,
        "src/app.ts",
        &lines_with(&[(10, "joy's run 10"), (11, "joy's run 11")]),
    );
    write(
        &monzim_run.worktree,
        "src/app.ts",
        &lines_with(&[(10, "monzim's run 10"), (24, "monzim 24")]),
    );

    t.joy.finish_run(&joy_run, &t.joy_runs).await.unwrap();
    let report = t
        .monzim
        .finish_run(&monzim_run, &t.monzim_runs)
        .await
        .unwrap();
    assert_eq!(report.conflicts.len(), 1);
    t.joy.pump(QUIET).await.unwrap();

    // Joy's Run landed whole; Monzim's line 24 landed; line 10 is held.
    let expected = lines_with(&[
        (10, "joy's run 10"),
        (11, "joy's run 11"),
        (24, "monzim 24"),
    ]);
    assert_eq!(app(&t.joy), expected);
    assert_eq!(app(&t.monzim), expected);
    let c = &t.server.conflicts()[0];
    assert_eq!(c.canonical.as_deref(), Some("joy's run 10\njoy's run 11\n"));
    assert_eq!(c.run.as_deref(), Some("monzim's run 10\nline 11\n"));
}

#[tokio::test]
async fn a_merge_rejected_by_a_racing_one_is_recomputed_into_a_conflict() {
    let mut t = thread().await;
    let file = t.monzim.replica().file_id("src/app.ts").unwrap();
    let run = t
        .monzim
        .start_run(&t.monzim_runs, spec("codex"))
        .await
        .unwrap();
    write(
        &run.worktree,
        "src/app.ts",
        &lines_with(&[(5, "monzim 5"), (20, "monzim 20")]),
    );

    // Another Runner's merge on line 5 reaches the server just before his.
    let theirs = atlas_thread_sync::doc::FileDoc::from_snapshot(
        atlas_thread_sync::doc::random_client_id(),
        &t.monzim.replica().snapshot(file).unwrap(),
    )
    .unwrap()
    .set_content(&lines_with(&[(5, "racer 5")]))
    .remove(0);
    t.server.merge_before_next_submit(file, theirs);

    let report = t.monzim.finish_run(&run, &t.monzim_runs).await.unwrap();
    assert_eq!(report.retries, 1);
    assert_eq!(report.conflicts.len(), 1);
    assert_eq!(
        app(&t.monzim),
        lines_with(&[(5, "racer 5"), (20, "monzim 20")])
    );
    assert_eq!(t.server.conflicts()[0].run.as_deref(), Some("monzim 5\n"));
}

#[tokio::test]
async fn every_resolution_produces_the_same_file_on_every_replica() {
    let cases: Vec<(Resolve, &str)> = vec![
        (Resolve::Canonical, "joy 19\n"),
        (Resolve::Run, "run 19\n"),
        (Resolve::Both, "joy 19\nrun 19\n"),
        (
            Resolve::Edited("both of us, 19\n".into()),
            "both of us, 19\n",
        ),
    ];
    for (choice, hunk) in cases {
        let mut t = thread().await;
        let (_, conflict_id) = conflicted(&mut t).await;
        // Anyone may resolve: Joy, who did not run anything.
        let version = t
            .joy
            .resolve_conflict(conflict_id, choice.clone())
            .await
            .unwrap();
        assert!(version > 0);
        t.monzim.pump(QUIET).await.unwrap();
        let mut expected = lines_with(&[(2, "run 2")]);
        expected = expected.replace("line 19\n", hunk);
        assert_eq!(app(&t.joy), expected, "{choice:?}");
        assert_eq!(app(&t.monzim), expected, "{choice:?}");
        assert!(!t.server.conflicts()[0].is_open());
        assert_eq!(t.monzim.open_conflicts(), 0);
        // Resolved is resolved: a second answer is refused.
        let again = t.monzim.resolve_conflict(conflict_id, Resolve::Run).await;
        assert!(matches!(again, Err(SessionError::Refused { .. })));
    }
}

#[tokio::test]
async fn an_agent_resolves_a_conflict_in_a_run_of_its_own() {
    let mut t = thread().await;
    let (_, conflict_id) = conflicted(&mut t).await;
    let fixer = t
        .monzim
        .start_run(&t.monzim_runs, spec("claude-code"))
        .await
        .unwrap();
    // The agent rewrites the hunk — and nothing it does elsewhere is merged.
    let fork = read(&fixer.worktree, "src/app.ts");
    let rewritten = fork
        .replace("joy 19\n", "agent's 19\n")
        .replace("line 23\n", "stray 23\n");
    write(&fixer.worktree, "src/app.ts", &rewritten);
    t.monzim
        .resolve_with_run(&fixer, &t.monzim_runs, conflict_id)
        .await
        .unwrap();
    t.joy.pump(QUIET).await.unwrap();

    let expected = lines_with(&[(2, "run 2"), (19, "agent's 19")]);
    assert_eq!(app(&t.monzim), expected);
    assert_eq!(app(&t.joy), expected);
    let resolved = &t.server.conflicts()[0];
    let resolution = resolved.resolution.as_ref().unwrap();
    assert_eq!(resolution.text, "agent's 19\n");
    assert_eq!(
        resolution.side,
        atlas_thread_sync::wire::ConflictSide::Agent
    );
}

#[tokio::test]
async fn a_conflict_whose_lines_were_edited_since_is_left_for_a_person() {
    let mut t = thread().await;
    let (_, conflict_id) = conflicted(&mut t).await;
    joy_types(&mut t, 19, "joy 19, again").await;
    t.monzim.pump(QUIET).await.unwrap();
    let err = t
        .monzim
        .resolve_conflict(conflict_id, Resolve::Run)
        .await
        .unwrap_err();
    assert!(
        matches!(err, SessionError::ConflictMoved(ref p) if p == "src/app.ts"),
        "{err}"
    );
    // Typing elsewhere does not move it out of reach.
    let mut t = thread().await;
    let (_, conflict_id) = conflicted(&mut t).await;
    joy_types(&mut t, 1, "a new first line").await;
    t.monzim.pump(QUIET).await.unwrap();
    t.monzim
        .resolve_conflict(conflict_id, Resolve::Run)
        .await
        .unwrap();
    assert_eq!(
        app(&t.monzim),
        lines_with(&[(1, "a new first line"), (2, "run 2"), (19, "run 19")])
    );
}

#[tokio::test]
async fn a_binary_file_lands_whole_or_is_a_whole_file_conflict() {
    let mut t = thread().await;
    let logo_v1: Vec<u8> = b"\x89PNG\0\x01logo-one".to_vec();
    let joy_root = t.joy.replica().root().to_path_buf();
    std::fs::write(joy_root.join("logo.png"), &logo_v1).unwrap();
    t.joy.file_saved("logo.png").await.unwrap();
    t.monzim.pump(QUIET).await.unwrap();
    t.monzim.materialize().await.unwrap();
    let monzim_root = t.monzim.replica().root().to_path_buf();
    assert_eq!(
        std::fs::read(monzim_root.join("logo.png")).unwrap(),
        logo_v1
    );

    // Nobody else touched it: the Run's logo lands whole.
    let run = t
        .monzim
        .start_run(&t.monzim_runs, spec("codex"))
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(run.worktree.join("logo.png")).unwrap(),
        logo_v1
    );
    let logo_v2: Vec<u8> = b"\x89PNG\0\x02logo-two".to_vec();
    std::fs::write(run.worktree.join("logo.png"), &logo_v2).unwrap();
    let report = t.monzim.finish_run(&run, &t.monzim_runs).await.unwrap();
    assert!(report.conflicts.is_empty());
    assert!(report.files.contains(&"logo.png".to_string()));
    t.joy.pump(QUIET).await.unwrap();
    let blob_of = |server: &FakeThreadServer| {
        server
            .tree()
            .into_iter()
            .find(|e| e.path == "logo.png")
            .unwrap()
            .blob
            .unwrap()
    };
    assert_eq!(blob_of(&t.server), sha256_hex(&logo_v2));
    assert_eq!(std::fs::read(joy_root.join("logo.png")).unwrap(), logo_v2);

    // Joy changes it while another Run does: a whole-file Conflict.
    let run = t
        .monzim
        .start_run(&t.monzim_runs, spec("codex"))
        .await
        .unwrap();
    let logo_run: Vec<u8> = b"\x89PNG\0\x03logo-run".to_vec();
    std::fs::write(run.worktree.join("logo.png"), &logo_run).unwrap();
    let logo_joy: Vec<u8> = b"\x89PNG\0\x04logo-joy".to_vec();
    std::fs::write(joy_root.join("logo.png"), &logo_joy).unwrap();
    t.joy.file_saved("logo.png").await.unwrap();
    t.monzim.pump(QUIET).await.unwrap();
    let report = t.monzim.finish_run(&run, &t.monzim_runs).await.unwrap();
    assert_eq!(report.conflicts.len(), 1);
    let c = t.server.conflicts().pop().unwrap();
    assert!(c.binary && c.lines.is_none());
    assert_eq!(c.canonical.as_deref(), Some(sha256_hex(&logo_joy).as_str()));
    assert_eq!(c.run.as_deref(), Some(sha256_hex(&logo_run).as_str()));
    assert_eq!(blob_of(&t.server), sha256_hex(&logo_joy));

    // Only a side may be taken; Joy takes the Run's, and both disks follow.
    t.joy.pump(QUIET).await.unwrap();
    let both = t.joy.resolve_conflict(c.conflict_id, Resolve::Both).await;
    assert!(matches!(both, Err(SessionError::Refused { .. })));
    t.joy
        .resolve_conflict(c.conflict_id, Resolve::Run)
        .await
        .unwrap();
    t.monzim.pump(QUIET).await.unwrap();
    assert_eq!(blob_of(&t.server), sha256_hex(&logo_run));
    assert_eq!(std::fs::read(joy_root.join("logo.png")).unwrap(), logo_run);
    assert_eq!(
        std::fs::read(monzim_root.join("logo.png")).unwrap(),
        logo_run
    );
    let _ = &t.w;
}
