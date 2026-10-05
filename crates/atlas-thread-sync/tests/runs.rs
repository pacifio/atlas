//! Runs (ATL-405) through the crate's public API: each participant's agent
//! works in a Run worktree of its own, streams live, and merges back. The
//! agent is scripted — it writes files and emits deltas the way a real one
//! would through the agent connection — and the server is the in-process fake
//! that keeps the real one's rules (CAS on merge versions, relay-only Run
//! frames, Runs interrupted when their Runner's socket goes).

use std::path::PathBuf;
use std::time::Duration;

use atlas_thread_sync::doc::{random_client_id, FileDoc};
use atlas_thread_sync::wire::FrameKind;
use atlas_thread_sync::FakeStore;
use atlas_thread_sync::{
    run, ActiveRun, Command as SyncCommand, FakeThreadServer, FakeTransport, RunSpec, RunWorktree,
    SyncStatus, ThreadEvent, ThreadSession,
};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, watch};

mod common;
use common::*;

const QUIET: Duration = Duration::from_millis(50);

/// A scripted agent: what it writes in its worktree and what it says.
enum Step {
    Write(&'static str, &'static str),
    Say(&'static str),
}

async fn play(session: &mut ThreadSession<FakeTransport>, run: &ActiveRun, script: &[Step]) {
    for step in script {
        match step {
            Step::Write(path, content) => write(&run.worktree, path, content),
            Step::Say(text) => {
                let delta =
                    serde_json::json!({ "kind": "text_chunk", "message_id": "m1", "delta": text });
                session
                    .stream_run(
                        run.run_no,
                        FrameKind::RunStream,
                        delta.to_string().into_bytes(),
                    )
                    .await
                    .unwrap();
            }
        }
    }
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

fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

struct Pair {
    w: World,
    server: FakeThreadServer,
    joy: ThreadSession<FakeTransport>,
    monzim: ThreadSession<FakeTransport>,
    joy_runs: RunWorktree,
    monzim_runs: RunWorktree,
}

/// Joy shares her work; Monzim joins. Each has a Run worktree of their own.
async fn pair() -> Pair {
    let w = world();
    let server = FakeThreadServer::new();
    let mut joy = open(&server, &w.joy, &w.base, &w.replicas.join("joy"), "joy").await;
    joy.share_working_changes(&w.joy, &[]).await.unwrap();
    let mut monzim = open(
        &server,
        &w.monzim,
        &w.base,
        &w.replicas.join("monzim"),
        "monzim",
    )
    .await;
    monzim.pump(QUIET).await.unwrap();
    let joy_runs = RunWorktree::new(&w.joy, &w.base, &w.replicas.join("joy-run"));
    let monzim_runs = RunWorktree::new(&w.monzim, &w.base, &w.replicas.join("monzim-run"));
    Pair {
        w,
        server,
        joy,
        monzim,
        joy_runs,
        monzim_runs,
    }
}

const BANNER: &str = ".banner {\n  color: green;\n}\n";

#[tokio::test]
async fn two_runners_on_different_files_both_merge_and_the_next_fork_sees_it() {
    let Pair {
        w: _w,
        server,
        mut joy,
        mut monzim,
        joy_runs,
        monzim_runs,
    } = pair().await;
    let blobs = FakeStore::default();
    joy.set_store(Arc::new(blobs.clone()));
    monzim.set_store(Arc::new(blobs.clone()));

    let joy_run = joy.start_run(&joy_runs, spec("claude-code")).await.unwrap();
    let monzim_run = monzim.start_run(&monzim_runs, spec("codex")).await.unwrap();
    assert_ne!(joy_run.run_no, monzim_run.run_no);
    // Each worktree starts at canonical state, not at the bare Base.
    assert_eq!(read(&joy_run.worktree, "src/banner.css"), BANNER);
    assert_eq!(read(&monzim_run.worktree, "notes.md"), "todo: red?\n");

    play(
        &mut joy,
        &joy_run,
        &[Step::Write("README.md", "# Site\n\nBuilt by Joy.\n")],
    )
    .await;
    play(
        &mut monzim,
        &monzim_run,
        &[
            Step::Write("src/banner.css", ".banner {\n  color: red;\n}\n"),
            Step::Write("src/hero.ts", "export const hero = true;\n"),
        ],
    )
    .await;

    let joy_report = joy.finish_run(&joy_run, &joy_runs).await.unwrap();
    assert_eq!(joy_report.files, vec!["README.md".to_string()]);
    let monzim_report = monzim.finish_run(&monzim_run, &monzim_runs).await.unwrap();
    let mut files = monzim_report.files.clone();
    files.sort();
    assert_eq!(
        files,
        vec!["src/banner.css".to_string(), "src/hero.ts".to_string()]
    );
    assert_eq!(monzim_report.retries, 0, "different files never collide");

    joy.pump(QUIET).await.unwrap();
    monzim.pump(QUIET).await.unwrap();
    for session in [&joy, &monzim] {
        let replica = session.replica();
        assert_eq!(
            replica.text("README.md").unwrap(),
            "# Site\n\nBuilt by Joy.\n"
        );
        assert_eq!(
            replica.text("src/banner.css").unwrap(),
            ".banner {\n  color: red;\n}\n"
        );
        assert_eq!(
            replica.text("src/hero.ts").unwrap(),
            "export const hero = true;\n"
        );
    }
    // Both Runs are merged, each with a Thread Version, and the resulting
    // content was uploaded for it.
    let runs = server.runs();
    assert!(runs
        .iter()
        .all(|r| r.status == "merged" && r.merged_version.is_some()));
    assert_eq!(
        blobs
            .blob(&sha256_hex(".banner {\n  color: red;\n}\n"))
            .unwrap(),
        b".banner {\n  color: red;\n}\n"
    );
    // Three Version copies, and README's Base content: the Run brought that
    // file into the thread, so its Base was uploaded with it (ATL-402).
    assert!(blobs.blob(&sha256_hex("# Site\n")).is_some());
    assert_eq!(blobs.blobs(), 4);
    // Joy sees Monzim's Run and what it changed.
    let seen = joy.runs();
    let theirs = seen
        .iter()
        .find(|r| r.run.run_id == monzim_run.run_id)
        .unwrap();
    assert_eq!(theirs.run.status, "merged");
    let mut changed = theirs.files.clone();
    changed.sort();
    assert_eq!(changed, files);

    // Joy's next Run forks from canonical state with Monzim's merged work, in
    // the same worktree; ignored build output survives the reset, and a
    // leftover untracked file does not.
    write(&joy_run.worktree, "dist/cache.txt", "warm\n");
    write(&joy_run.worktree, "leftover.txt", "scratch\n");
    let next = joy.start_run(&joy_runs, spec("claude-code")).await.unwrap();
    assert_eq!(next.worktree, joy_run.worktree);
    assert_eq!(
        read(&next.worktree, "src/banner.css"),
        ".banner {\n  color: red;\n}\n"
    );
    assert_eq!(
        read(&next.worktree, "src/hero.ts"),
        "export const hero = true;\n"
    );
    assert_eq!(read(&next.worktree, "dist/cache.txt"), "warm\n");
    assert!(!next.worktree.join("leftover.txt").exists());
}

#[tokio::test]
async fn a_merge_that_already_arrived_is_merged_onto() {
    let Pair {
        w: _w,
        server,
        mut joy,
        mut monzim,
        joy_runs,
        monzim_runs,
    } = pair().await;
    let blobs = FakeStore::default();
    joy.set_store(Arc::new(blobs.clone()));
    monzim.set_store(Arc::new(blobs.clone()));
    let banner = monzim.replica().file_id("src/banner.css").unwrap();

    let joy_run = joy.start_run(&joy_runs, spec("claude-code")).await.unwrap();
    let monzim_run = monzim.start_run(&monzim_runs, spec("codex")).await.unwrap();
    play(
        &mut joy,
        &joy_run,
        &[Step::Write(
            "src/banner.css",
            ".hero {\n  color: green;\n}\n",
        )],
    )
    .await;
    play(
        &mut monzim,
        &monzim_run,
        &[Step::Write(
            "src/banner.css",
            ".banner {\n  color: green;\n}\n/* end */\n",
        )],
    )
    .await;

    joy.finish_run(&joy_run, &joy_runs).await.unwrap();
    assert_eq!(server.merge_version(banner), Some(1));
    // Joy's merge had reached Monzim's socket before his turn ended, so his
    // merge is planned onto it from the start and lands first time.
    let report = monzim.finish_run(&monzim_run, &monzim_runs).await.unwrap();
    assert_eq!(report.retries, 0);
    assert_eq!(server.merge_version(banner), Some(2));

    let merged = ".hero {\n  color: green;\n}\n/* end */\n";
    joy.pump(QUIET).await.unwrap();
    assert_eq!(joy.replica().text("src/banner.css").unwrap(), merged);
    assert_eq!(monzim.replica().text("src/banner.css").unwrap(), merged);
    assert_eq!(monzim.merge_version(banner), 2);
    assert!(blobs.blob(&sha256_hex(merged)).is_some());
}

#[tokio::test]
async fn a_rejected_submit_recomputes_against_the_newer_state_and_lands() {
    let Pair {
        w: _w,
        server,
        joy: _joy,
        mut monzim,
        joy_runs: _,
        monzim_runs,
    } = pair().await;
    let blobs = FakeStore::default();
    monzim.set_store(Arc::new(blobs.clone()));
    let banner = monzim.replica().file_id("src/banner.css").unwrap();
    let run = monzim.start_run(&monzim_runs, spec("codex")).await.unwrap();
    play(
        &mut monzim,
        &run,
        &[Step::Write(
            "src/banner.css",
            ".banner {\n  color: green;\n}\n/* end */\n",
        )],
    )
    .await;

    // Somebody else's merge reaches the server while Monzim's submit is on
    // its way: his submit names version 0, the file is at 1 by then.
    let theirs = FileDoc::from_snapshot(
        random_client_id(),
        &monzim.replica().snapshot(banner).unwrap(),
    )
    .unwrap()
    .set_content(".hero {\n  color: green;\n}\n")
    .remove(0);
    server.merge_before_next_submit(banner, theirs);

    let report = monzim.finish_run(&run, &monzim_runs).await.unwrap();
    assert_eq!(report.retries, 1);
    assert_eq!(server.merge_version(banner), Some(2));
    let merged = ".hero {\n  color: green;\n}\n/* end */\n";
    assert_eq!(monzim.replica().text("src/banner.css").unwrap(), merged);
    assert_eq!(monzim.merge_version(banner), 2);
    assert!(blobs.blob(&sha256_hex(merged)).is_some());
}

#[tokio::test]
async fn typing_during_a_run_never_touches_its_worktree_and_both_survive() {
    let Pair {
        w: _w,
        server: _server,
        mut joy,
        mut monzim,
        joy_runs,
        monzim_runs: _,
    } = pair().await;
    let blobs = FakeStore::default();
    joy.set_store(Arc::new(blobs.clone()));
    monzim.set_store(Arc::new(blobs.clone()));
    let readme_before = "# Site\n";

    let joy_run = joy.start_run(&joy_runs, spec("claude-code")).await.unwrap();
    // Monzim types in his replica while Joy's agent works.
    let root = monzim.materialize().await.unwrap();
    write(&root, "README.md", "# Site\n\nTyped by Monzim.\n");
    monzim.file_saved("README.md").await.unwrap();
    joy.pump(QUIET).await.unwrap();
    assert_eq!(
        joy.replica().text("README.md").unwrap(),
        "# Site\n\nTyped by Monzim.\n"
    );
    assert_eq!(read(&joy_run.worktree, "README.md"), readme_before);

    play(
        &mut joy,
        &joy_run,
        &[Step::Write(
            "src/banner.css",
            ".banner {\n  color: teal;\n}\n",
        )],
    )
    .await;
    joy.finish_run(&joy_run, &joy_runs).await.unwrap();
    monzim.pump(QUIET).await.unwrap();
    assert_eq!(
        monzim.replica().text("README.md").unwrap(),
        "# Site\n\nTyped by Monzim.\n"
    );
    assert_eq!(
        monzim.replica().text("src/banner.css").unwrap(),
        ".banner {\n  color: teal;\n}\n"
    );
    // His replica on disk took the merge too.
    assert_eq!(
        read(&root, "src/banner.css"),
        ".banner {\n  color: teal;\n}\n"
    );
}

#[tokio::test]
async fn live_frames_reach_the_other_desktop_and_are_never_stored() {
    let Pair {
        w: _w,
        server,
        mut joy,
        mut monzim,
        joy_runs,
        monzim_runs: _,
    } = pair().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    monzim.set_events(tx);
    let head = server.head();

    let joy_run = joy.start_run(&joy_runs, spec("claude-code")).await.unwrap();
    play(
        &mut joy,
        &joy_run,
        &[Step::Say("Looking at the banner…"), Step::Say(" done.")],
    )
    .await;
    monzim.pump(QUIET).await.unwrap();

    let mut texts = Vec::new();
    while let Ok(ThreadEvent::RunFrame {
        run_no,
        kind,
        payload,
    }) = rx.try_recv()
    {
        assert_eq!(run_no, joy_run.run_no);
        assert_eq!(kind, FrameKind::RunStream as u8);
        let delta: serde_json::Value = serde_json::from_slice(&payload).unwrap();
        texts.push(delta["delta"].as_str().unwrap().to_string());
    }
    assert_eq!(texts, vec!["Looking at the banner…", " done."]);
    assert_eq!(server.run_frames_relayed(), 2);
    assert_eq!(
        server.head(),
        head,
        "live frames are relayed, never journaled"
    );
    assert_eq!(monzim.runs()[0].run.status, "running");
}

#[tokio::test]
async fn overlapping_hunks_are_held_as_a_conflict_and_the_rest_lands() {
    let Pair {
        w: _w,
        server,
        mut joy,
        mut monzim,
        joy_runs,
        monzim_runs,
    } = pair().await;
    let blobs = FakeStore::default();
    joy.set_store(Arc::new(blobs.clone()));
    monzim.set_store(Arc::new(blobs.clone()));
    let joy_run = joy.start_run(&joy_runs, spec("claude-code")).await.unwrap();
    let monzim_run = monzim.start_run(&monzim_runs, spec("codex")).await.unwrap();
    play(
        &mut joy,
        &joy_run,
        &[Step::Write(
            "src/banner.css",
            ".banner {\n  color: gold;\n}\n",
        )],
    )
    .await;
    play(
        &mut monzim,
        &monzim_run,
        &[
            Step::Write("src/banner.css", ".banner {\n  color: navy;\n}\n"),
            Step::Write("src/brand-new.ts", "export {};\n"),
        ],
    )
    .await;

    joy.finish_run(&joy_run, &joy_runs).await.unwrap();
    let report = monzim.finish_run(&monzim_run, &monzim_runs).await.unwrap();
    // The overlap is held for somebody to resolve (ATL-410); his new file,
    // which overlaps nothing, lands.
    assert_eq!(report.conflicts.len(), 1);
    assert_eq!(report.files, vec!["src/brand-new.ts".to_string()]);
    joy.pump(QUIET).await.unwrap();
    assert!(joy.replica().file_id("src/brand-new.ts").is_some());
    assert_eq!(
        monzim.replica().text("src/banner.css").unwrap(),
        ".banner {\n  color: gold;\n}\n"
    );
    let held = &server.conflicts()[0];
    assert_eq!(held.canonical.as_deref(), Some("  color: gold;\n"));
    assert_eq!(held.run.as_deref(), Some("  color: navy;\n"));
    let status = |id: &str| {
        server
            .runs()
            .into_iter()
            .find(|r| r.run_id == id)
            .unwrap()
            .status
    };
    assert_eq!(status(&monzim_run.run_id), "merged");
    assert_eq!(status(&joy_run.run_id), "merged");
}

#[tokio::test]
async fn a_runner_that_vanishes_leaves_its_run_interrupted() {
    let Pair {
        w: _w,
        server,
        mut joy,
        mut monzim,
        joy_runs,
        monzim_runs: _,
    } = pair().await;
    let joy_run = joy.start_run(&joy_runs, spec("claude-code")).await.unwrap();
    drop(joy);
    monzim.pump(QUIET).await.unwrap();
    let theirs = monzim
        .runs()
        .into_iter()
        .find(|r| r.run.run_id == joy_run.run_id)
        .unwrap();
    assert_eq!(theirs.run.status, "interrupted");
    assert_eq!(server.runs()[0].status, "interrupted");
}

/// The app's path: the loop takes StartRun, live frames and FinishRun as
/// commands, and reports Runs in its status.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_run_loop_runs_streams_and_merges_on_command() {
    let Pair {
        w,
        server: _server,
        joy,
        mut monzim,
        joy_runs: _,
        monzim_runs: _,
    } = pair().await;
    let (events, mut heard) = mpsc::unbounded_channel();
    monzim.set_events(events);

    let (commands, rx) = mpsc::unbounded_channel();
    let (status_tx, mut status) = watch::channel(SyncStatus::default());
    let blobs = FakeStore::default();
    monzim.set_store(Arc::new(blobs.clone()));
    let mut joy = joy;
    joy.set_store(Arc::new(blobs.clone()));
    tokio::spawn(run(joy, rx, status_tx));

    let worktree: PathBuf = w.replicas.join("joy-run");
    let (reply, started) = oneshot::channel();
    commands
        .send(SyncCommand::StartRun {
            worktree: worktree.clone(),
            spec: spec("claude-code"),
            reply,
        })
        .unwrap();
    let started = started.await.unwrap().unwrap();
    assert_eq!(started.worktree, worktree);
    commands
        .send(SyncCommand::RunFrame {
            run_id: started.run_id.clone(),
            payload: br#"{"kind":"text_chunk","message_id":"m","delta":"hi"}"#.to_vec(),
        })
        .unwrap();
    write(&worktree, "README.md", "# Site\n\nFrom the loop.\n");
    let (reply, finished) = oneshot::channel();
    commands
        .send(SyncCommand::FinishRun {
            run_id: started.run_id.clone(),
            resolves: None,
            reply: Some(reply),
        })
        .unwrap();
    let report = finished.await.unwrap().unwrap();
    assert_eq!(report.files, vec!["README.md".to_string()]);
    // The Version copy, and README's Base content.
    assert_eq!(blobs.blobs(), 2);

    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if status
            .borrow()
            .runs
            .first()
            .is_some_and(|r| r.run.status == "merged")
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "status never showed the merged Run"
        );
        let _ = tokio::time::timeout(Duration::from_millis(200), status.changed()).await;
    }

    monzim.pump(QUIET).await.unwrap();
    // Among presence (ATL-407), the live Run frame arrived.
    let mut frames = 0;
    while let Ok(event) = heard.try_recv() {
        if matches!(event, ThreadEvent::RunFrame { .. }) {
            frames += 1;
        }
    }
    assert!(frames > 0);
    assert_eq!(
        monzim.replica().text("README.md").unwrap(),
        "# Site\n\nFrom the loop.\n"
    );
    commands.send(SyncCommand::Stop).unwrap();
}
