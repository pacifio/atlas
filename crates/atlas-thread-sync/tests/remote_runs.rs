//! Remote Runs on the desktop (ADR-0023, ATL-417) through the crate's public
//! API: Monzim asks Joy's desktop to run a prompt; Joy's replica hears the
//! request, approves or declines it, and executes an approved one exactly like
//! a Run of her own — Run worktree, live frames, merge — with Monzim recorded
//! as its prompter. The agent is scripted, and the server is the in-process
//! fake keeping the real one's rules for the object's gates, answers,
//! timeouts and auto-approve.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use atlas_thread_sync::wire::FrameKind;
use atlas_thread_sync::{
    FakeThreadServer, FakeTransport, RemoteRunStatus, Replica, RunSpec, RunWorktree, ThreadEvent,
    ThreadSession,
};
use tokio::sync::mpsc;

mod common;
use common::*;

const QUIET: Duration = Duration::from_millis(50);
const PROMPT: &str = "make the banner teal";

/// A replica on a desktop that runs Remote Runs with `agents`.
async fn open_offering(
    server: &FakeThreadServer,
    repo: &Path,
    base: &str,
    root: &Path,
    user: &str,
    agents: &[&str],
) -> ThreadSession<FakeTransport> {
    ThreadSession::connect_offering(
        server.connect(user),
        Replica::new(repo, base, root).unwrap(),
        &format!("{user}-{}", root.file_name().unwrap().to_string_lossy()),
        Arc::new(server.store()),
        agents.iter().map(ToString::to_string).collect(),
    )
    .await
    .unwrap()
}

struct Team {
    w: World,
    server: FakeThreadServer,
    /// The Runner: her desktop offers `claude-code`.
    joy: ThreadSession<FakeTransport>,
    joy_heard: mpsc::UnboundedReceiver<ThreadEvent>,
    joy_runs: RunWorktree,
    /// The asker, on an ordinary replica.
    monzim: ThreadSession<FakeTransport>,
    monzim_heard: mpsc::UnboundedReceiver<ThreadEvent>,
}

async fn team() -> Team {
    let w = world();
    let server = FakeThreadServer::new();
    let mut joy = open_offering(
        &server,
        &w.joy,
        &w.base,
        &w.replicas.join("joy"),
        "joy",
        &["claude-code"],
    )
    .await;
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
    let (tx, joy_heard) = mpsc::unbounded_channel();
    joy.set_events(tx);
    let (tx, monzim_heard) = mpsc::unbounded_channel();
    monzim.set_events(tx);
    let joy_runs = RunWorktree::new(&w.joy, &w.base, &w.replicas.join("joy-run"));
    Team {
        w,
        server,
        joy,
        joy_heard,
        joy_runs,
        monzim,
        monzim_heard,
    }
}

fn spec(remote: Option<&str>) -> RunSpec {
    RunSpec {
        run_id: RunSpec::new_id(),
        agent: "claude-code".into(),
        model: "test-model".into(),
        context_anchor: None,
        remote_request_id: remote.map(str::to_string),
    }
}

/// The Remote Run requests an event stream announced, in order.
fn requests_heard(heard: &mut mpsc::UnboundedReceiver<ThreadEvent>) -> Vec<(String, RemoteRunStatus)> {
    let mut seen = Vec::new();
    while let Ok(event) = heard.try_recv() {
        if let ThreadEvent::RemoteRun(r) = event {
            seen.push((r.request_id, r.status));
        }
    }
    seen
}

#[tokio::test]
async fn nobody_is_asked_until_the_runner_accepts_and_a_desktop_without_agents_cannot() {
    let mut t = team().await;
    assert_eq!(
        t.server.request_remote_run("monzim", "joy", PROMPT, "claude-code"),
        Err("runner_not_accepting")
    );
    assert!(!t.joy.remote().accept);

    t.joy.set_remote_settings(Some(true), None).await.unwrap();
    t.joy.pump(QUIET).await.unwrap();
    let remote = t.joy.remote();
    assert!(remote.accept);
    assert_eq!(remote.agents, vec!["claude-code".to_string()]);

    // An agent her desktop does not offer is nobody to ask for.
    assert_eq!(
        t.server.request_remote_run("monzim", "joy", PROMPT, "codex"),
        Err("runner_offline")
    );
    // Monzim's desktop runs no Remote Runs, so it cannot accept them.
    let refused = t.monzim.set_remote_settings(Some(true), None).await;
    assert!(
        matches!(&refused, Err(atlas_thread_sync::SessionError::Refused { code, .. }) if code == "remote_run_unsupported"),
        "{refused:?}"
    );
    assert_eq!(
        t.server.request_remote_run("joy", "monzim", PROMPT, "claude-code"),
        Err("runner_not_accepting")
    );
}

#[tokio::test]
async fn an_approved_request_runs_on_the_runner_streams_live_and_merges_as_the_askers() {
    let mut t = team().await;
    t.joy.set_remote_settings(Some(true), None).await.unwrap();
    let asked = t
        .server
        .request_remote_run("monzim", "joy", PROMPT, "claude-code")
        .unwrap();
    assert_eq!(asked.status, RemoteRunStatus::Pending);

    // Joy's replica hears exactly what will run, and who asks.
    t.joy.pump(QUIET).await.unwrap();
    let pending = t.joy.remote_request(&asked.request_id).cloned().unwrap();
    assert_eq!(
        (pending.requested_by.as_str(), pending.prompt.as_str(), pending.agent.as_str()),
        ("monzim", PROMPT, "claude-code")
    );
    assert_eq!(
        requests_heard(&mut t.joy_heard),
        vec![(asked.request_id.clone(), RemoteRunStatus::Pending)]
    );
    // Nothing runs before she answers.
    let early = t
        .joy
        .start_run(&t.joy_runs, spec(Some(&asked.request_id)))
        .await;
    assert!(early.is_err(), "{early:?}");

    assert_eq!(
        t.joy.answer_remote_run(&asked.request_id, true).await.unwrap(),
        RemoteRunStatus::Approved
    );
    t.monzim.pump(QUIET).await.unwrap();
    assert_eq!(
        requests_heard(&mut t.monzim_heard),
        vec![
            (asked.request_id.clone(), RemoteRunStatus::Pending),
            (asked.request_id.clone(), RemoteRunStatus::Approved)
        ]
    );

    // Executed exactly like a Run of her own.
    let run = t
        .joy
        .start_run(&t.joy_runs, spec(Some(&asked.request_id)))
        .await
        .unwrap();
    write(&run.worktree, "src/banner.css", ".banner {\n  color: teal;\n}\n");
    let said = serde_json::json!({ "kind": "text_chunk", "message_id": "m1", "delta": "Teal it is." });
    t.joy
        .stream_run(run.run_no, FrameKind::RunStream, said.to_string().into_bytes())
        .await
        .unwrap();
    let report = t.joy.finish_run(&run, &t.joy_runs).await.unwrap();
    assert!(report.version.is_some(), "{report:?}");

    // Everyone sees the live frame and the merge; Monzim prompted, Joy ran.
    t.monzim.pump(QUIET).await.unwrap();
    let mut live = 0;
    while let Ok(event) = t.monzim_heard.try_recv() {
        match event {
            ThreadEvent::RunFrame { run_no, .. } if run_no == run.run_no => live += 1,
            ThreadEvent::RemoteRun(r) => assert_eq!(r.status, RemoteRunStatus::Executed),
            _ => {}
        }
    }
    assert!(live >= 1, "Monzim saw none of the Run live");
    let view = t
        .monzim
        .runs()
        .into_iter()
        .find(|v| v.run.run_id == run.run_id)
        .unwrap();
    assert_eq!(
        (view.run.prompted_by.as_str(), view.run.runner_id.as_str(), view.run.status.as_str()),
        ("monzim", "joy", "merged")
    );
    assert_eq!(
        t.monzim.replica().text("src/banner.css").as_deref(),
        Some(".banner {\n  color: teal;\n}\n")
    );
    let done = &t.server.remote_runs()[0];
    assert_eq!(done.status, RemoteRunStatus::Executed);
    assert_eq!(done.run_id.as_deref(), Some(run.run_id.as_str()));
    // Executed once: it cannot start a second Run.
    assert!(t
        .joy
        .start_run(&t.joy_runs, spec(Some(&asked.request_id)))
        .await
        .is_err());
}

#[tokio::test]
async fn a_declined_or_timed_out_request_leaves_nothing_run() {
    let mut t = team().await;
    t.joy.set_remote_settings(Some(true), None).await.unwrap();

    let declined = t
        .server
        .request_remote_run("monzim", "joy", PROMPT, "claude-code")
        .unwrap();
    t.joy.pump(QUIET).await.unwrap();
    assert_eq!(
        t.joy.answer_remote_run(&declined.request_id, false).await.unwrap(),
        RemoteRunStatus::Declined
    );
    assert!(t
        .joy
        .start_run(&t.joy_runs, spec(Some(&declined.request_id)))
        .await
        .is_err());

    let ignored = t
        .server
        .request_remote_run("monzim", "joy", "and the footer", "claude-code")
        .unwrap();
    t.joy.pump(QUIET).await.unwrap();
    t.server.expire_remote_runs();
    t.joy.pump(QUIET).await.unwrap();
    t.monzim.pump(QUIET).await.unwrap();
    // A late answer changes nothing: it timed out.
    assert_eq!(
        t.joy.answer_remote_run(&ignored.request_id, true).await.unwrap(),
        RemoteRunStatus::TimedOut
    );
    assert!(t
        .joy
        .start_run(&t.joy_runs, spec(Some(&ignored.request_id)))
        .await
        .is_err());

    let asker: Vec<_> = t
        .monzim
        .remote()
        .requests
        .iter()
        .map(|r| (r.request_id.clone(), r.status))
        .collect();
    assert_eq!(
        asker,
        vec![
            (ignored.request_id.clone(), RemoteRunStatus::TimedOut),
            (declined.request_id.clone(), RemoteRunStatus::Declined)
        ]
    );
    assert!(t.server.runs().is_empty(), "something ran");
    assert_eq!(read(t.w.joy.as_path(), "src/banner.css"), ".banner {\n  color: green;\n}\n");
}

#[tokio::test]
async fn auto_approve_skips_the_question_for_that_one_person_only() {
    let mut t = team().await;
    let mut val = open(
        &t.server,
        &t.w.monzim,
        &t.w.base,
        &t.w.replicas.join("val"),
        "val",
    )
    .await;
    t.joy
        .set_remote_settings(Some(true), Some(Some("monzim".into())))
        .await
        .unwrap();
    t.joy.pump(QUIET).await.unwrap();
    assert_eq!(t.joy.remote().auto_approve.as_deref(), Some("monzim"));

    let monzims = t
        .server
        .request_remote_run("monzim", "joy", PROMPT, "claude-code")
        .unwrap();
    assert_eq!((monzims.status, monzims.auto), (RemoteRunStatus::Approved, true));
    let vals = t
        .server
        .request_remote_run("val", "joy", PROMPT, "claude-code")
        .unwrap();
    assert_eq!((vals.status, vals.auto), (RemoteRunStatus::Pending, false));
    val.pump(QUIET).await.unwrap();

    // Nobody may set auto-approve for themselves; clearing it asks again.
    assert!(t
        .joy
        .set_remote_settings(None, Some(Some("joy".into())))
        .await
        .is_err());
    t.joy.set_remote_settings(None, Some(None)).await.unwrap();
    let again = t
        .server
        .request_remote_run("monzim", "joy", PROMPT, "claude-code")
        .unwrap();
    assert_eq!(again.status, RemoteRunStatus::Pending);
}

#[tokio::test]
async fn a_runner_who_reconnects_hears_the_requests_still_waiting() {
    let mut t = team().await;
    t.joy.set_remote_settings(Some(true), None).await.unwrap();
    let asked = t
        .server
        .request_remote_run("monzim", "joy", PROMPT, "claude-code")
        .unwrap();
    // Another desktop of Joy's, opened afterwards, is asked too.
    let mut later = open_offering(
        &t.server,
        &t.w.joy,
        &t.w.base,
        &t.w.replicas.join("joy-2"),
        "joy",
        &["claude-code"],
    )
    .await;
    later.pump(QUIET).await.unwrap();
    let remote = later.remote();
    assert!(remote.accept);
    assert_eq!(remote.requests.len(), 1);
    assert_eq!(remote.requests[0].request_id, asked.request_id);
    assert_eq!(remote.requests[0].status, RemoteRunStatus::Pending);
}
