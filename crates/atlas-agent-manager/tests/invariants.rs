//! The invariants the manager's own suite could not fail on (ATL-231).
//!
//! Each test here pins one of the findings filed against this crate: the
//! connect-once guarantee under genuine concurrency (ATL-226), the sessions map
//! after every eviction path (ATL-227), a connect that is killed while it is
//! still running (ATL-228), a superseded turn's late reply (ATL-229), and the
//! two ATL-230 findings that have an observable consequence.
//!
//! What separates these from `tests/manager.rs` is that the doubles can be held
//! still: `tests/support` gives a connect the test parks mid-flight and
//! connections that report their own destruction.

mod support;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::LoadError;
use atlas_agent_manager::{Agent, AgentConnectionStatus, AgentManagerEvent};
use support::{
    custom, manager, settle, settle_tasks, wait_for, ConnectBehaviour, Gate, TestCatalog,
    TestServer,
};

fn text(body: &str) -> Vec<acp::ContentBlock> {
    vec![acp::ContentBlock::Text(acp::TextContent::new(
        body.to_string(),
    ))]
}

// ------------------------------------------------------- ATL-226: connect once

/// The guarantee three doc sites make, under the concurrency they describe.
///
/// The suite's original version of this called `request_connection` twice in a
/// row on one thread, so the first insert had already landed before the second
/// call began — it exercised the map lookup, not the join. Measured under real
/// concurrency the unfixed code hands out two entries 11–30% of the time, so a
/// round count in the hundreds turns that into a certainty rather than a flake.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_requests_for_one_agent_start_exactly_one_connection() {
    const ROUNDS: usize = 200;
    const CALLERS: usize = 4;

    for round in 0..ROUNDS {
        let catalog = TestCatalog::new(&[]);
        let server = TestServer::new("cersei");
        let manager = manager(catalog, server.clone());
        // The native agent, because `connect_to` resolves the server itself and
        // a custom one resolves to a `CustomAgentServer` that spawns a real
        // process. The window under test is the same either way: it is in the
        // entries map, not in which server backs the key.
        let key = Agent::Native;

        let callers: Vec<_> = (0..CALLERS)
            .map(|_| {
                let manager = manager.clone();
                let key = key.clone();
                tokio::spawn(async move { manager.connect_to(key) })
            })
            .collect();

        let mut entries = Vec::new();
        for caller in callers {
            entries.push(caller.await.expect("the caller task ran"));
        }

        assert_eq!(
            server.attempts(),
            1,
            "round {round}: {CALLERS} concurrent callers started {} connections",
            server.attempts()
        );
        for entry in &entries[1..] {
            assert!(
                Arc::ptr_eq(&entries[0], entry),
                "round {round}: the callers were handed different entries"
            );
        }
    }
}

/// The same race one layer down, where `request_connection` is called directly
/// with a server already resolved.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_request_connection_calls_join_one_attempt() {
    const ROUNDS: usize = 200;

    for round in 0..ROUNDS {
        let catalog = TestCatalog::new(&["claude-code"]);
        let server = TestServer::new("claude-code");
        let manager = manager(catalog, server.clone());
        let key = custom("claude-code");

        let a = {
            let (manager, key, server) = (manager.clone(), key.clone(), server.clone());
            tokio::spawn(async move { manager.request_connection(key, server) })
        };
        let b = {
            let (manager, key, server) = (manager.clone(), key.clone(), server.clone());
            tokio::spawn(async move { manager.request_connection(key, server) })
        };

        let (a, b) = (a.await.unwrap(), b.await.unwrap());
        assert_eq!(server.attempts(), 1, "round {round}: two connect attempts");
        assert!(Arc::ptr_eq(&a, &b), "round {round}: two entries");
    }
}

/// A restart racing a plain request must not abandon a connect. The
/// remove-then-insert in `restart_connection` was a third window onto the same
/// map, and what it produced was an attempt nothing owned: overwritten in the
/// map, so its watcher discarded the result, while the connect itself ran on to
/// spawn a process.
///
/// A restart may legitimately start a second attempt when the first has already
/// landed, so counting attempts proves nothing. What has to hold is that every
/// attempt ends somewhere the manager knows about: either it is cancelled, or
/// it produced the connection the map is holding. An abandoned one is in
/// neither column.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_restart_racing_a_request_abandons_no_connect() {
    const ROUNDS: usize = 100;

    for round in 0..ROUNDS {
        let catalog = TestCatalog::new(&["claude-code"]);
        // Parked, so both calls land while the connect is genuinely in flight —
        // which is the only window the bug lived in.
        let gate = Gate::shut();
        let server = TestServer::gated("claude-code", gate.clone());
        let manager = manager(catalog, server.clone());
        let key = custom("claude-code");

        let restart = {
            let (manager, key, server) = (manager.clone(), key.clone(), server.clone());
            tokio::spawn(async move { manager.restart_connection(key, server) })
        };
        let request = {
            let (manager, key, server) = (manager.clone(), key.clone(), server.clone());
            tokio::spawn(async move { manager.request_connection(key, server) })
        };
        let first = restart.await.unwrap();
        let second = request.await.unwrap();

        gate.open();
        let _ = settle(first).await;
        let _ = settle(second).await;
        settle_tasks().await;

        assert!(
            manager.entry(&key).is_some(),
            "round {round}: the map lost the entry"
        );
        // Parked, the connect can never resolve between the two calls, so
        // whichever wins the other must join it: a restart that finds an
        // attempt in flight is a no-op, and a request that finds one joins.
        // Two attempts here means the map was read and written across an
        // interleaving.
        assert_eq!(
            server.attempts(),
            1,
            "round {round}: a restart racing a request started {} connects",
            server.attempts()
        );
        assert_eq!(
            server.attempts(),
            server.live_connections() + server.connects_cancelled(),
            "round {round}: {} attempts, {} live, {} cancelled — one is unaccounted for",
            server.attempts(),
            server.live_connections(),
            server.connects_cancelled()
        );
    }
}

// ------------------------------------------- ATL-227: evictions free the agent

/// Connects `agent` through the test's own server, opens a session on it, and
/// hands back only the id — so the thread handle is dropped and the manager's
/// map is the only thing pinning the connection.
///
/// The connection is established explicitly because `new_session` would
/// otherwise resolve the server itself and build a real `CustomAgentServer`,
/// which resolves a command and spawns a process.
async fn open_session(
    manager: &Arc<atlas_agent_manager::AgentManager>,
    agent: Agent,
    server: Arc<TestServer>,
) -> acp::SessionId {
    settle(manager.request_connection(agent.clone(), server))
        .await
        .expect("the agent connects");
    let thread = manager
        .new_session(agent, vec![PathBuf::from("/tmp")])
        .await
        .expect("a session opens");
    let session_id = thread.lock().unwrap().session_id().clone();
    drop(thread);
    session_id
}

#[tokio::test(flavor = "multi_thread")]
async fn a_version_bump_forgets_the_sessions_it_orphans() {
    let catalog = TestCatalog::new(&["claude-code"]);
    let server = TestServer::new("claude-code");
    let manager = manager(catalog.clone(), server.clone());
    let key = custom("claude-code");

    open_session(&manager, key.clone(), server.clone()).await;
    assert_eq!(manager.sessions().len(), 1);
    assert_eq!(server.live_connections(), 1);

    catalog.announce_new_version("claude-code", "2.0.0");

    wait_for(|| manager.sessions().is_empty().then_some(()))
        .await
        .expect("a version bump forgets the sessions on the old connection");
    // The point of forgetting them: the session was the last thing pinning the
    // connection, and the old binary's process goes with it.
    wait_for(|| (server.live_connections() == 0).then_some(()))
        .await
        .expect("the old connection is released");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_uninstall_forgets_the_sessions_it_orphans() {
    let catalog = TestCatalog::new(&["claude-code"]);
    let server = TestServer::new("claude-code");
    let manager = manager(catalog.clone(), server.clone());
    let key = custom("claude-code");

    open_session(&manager, key.clone(), server.clone()).await;
    assert_eq!(manager.sessions().len(), 1);

    catalog.uninstall("claude-code");

    wait_for(|| manager.sessions().is_empty().then_some(()))
        .await
        .expect("an uninstall forgets the sessions on that agent");
    wait_for(|| (server.live_connections() == 0).then_some(()))
        .await
        .expect("the uninstalled agent's connection is released");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_restart_forgets_the_sessions_on_the_connection_it_replaces() {
    let catalog = TestCatalog::new(&["claude-code"]);
    let server = TestServer::new("claude-code");
    let manager = manager(catalog, server.clone());
    let key = custom("claude-code");

    open_session(&manager, key.clone(), server.clone()).await;
    wait_for(|| (manager.connection_status(&key) == AgentConnectionStatus::Connected).then_some(()))
        .await
        .expect("connected");
    assert_eq!(manager.sessions().len(), 1);

    settle(manager.restart_connection(key.clone(), server.clone()))
        .await
        .expect("reconnected");

    assert!(
        manager.sessions().is_empty(),
        "a session on the replaced connection is not reachable and must not pin it"
    );
}

/// Regression guard for the one eviction path that always did this. ATL-231's
/// acceptance criterion names it: removing the retain from `drop_connection`
/// has to fail a test.
#[tokio::test(flavor = "multi_thread")]
async fn dropping_a_connection_forgets_its_sessions() {
    let catalog = TestCatalog::new(&["claude-code"]);
    let server = TestServer::new("claude-code");
    let manager = manager(catalog, server.clone());
    let key = custom("claude-code");

    open_session(&manager, key.clone(), server.clone()).await;
    assert_eq!(manager.sessions().len(), 1);

    manager.drop_connection(&key);

    assert!(manager.sessions().is_empty());
    wait_for(|| (server.live_connections() == 0).then_some(()))
        .await
        .expect("the connection is released");
}

/// Shutdown has to reach connections the entries map no longer knows about,
/// because `process::exit` skips every `Drop` that would otherwise clean up.
#[tokio::test(flavor = "multi_thread")]
async fn shutdown_releases_connections_and_sessions_including_one_still_connecting() {
    let catalog = TestCatalog::new(&["claude-code", "other"]);
    let connected = TestServer::new("claude-code");
    let manager = manager(catalog, connected.clone());
    let key = custom("claude-code");

    open_session(&manager, key.clone(), connected.clone()).await;

    // A second agent parked mid-connect: invisible to `connections()`, which
    // yields only entries that reached `Connected`.
    let gate = Gate::shut();
    let connecting = TestServer::gated("other", gate.clone());
    manager.request_connection(custom("other"), connecting.clone());
    wait_for(|| (connecting.attempts() == 1).then_some(()))
        .await
        .expect("the second connect started");

    manager.shutdown();

    assert!(manager.sessions().is_empty(), "sessions are forgotten");
    assert!(manager.connections().is_empty(), "connections are dropped");
    wait_for(|| (connected.live_connections() == 0).then_some(()))
        .await
        .expect("the live connection is released");
    wait_for(|| (connecting.connects_cancelled() == 1).then_some(()))
        .await
        .expect("the in-flight connect is cancelled rather than left to finish");

    gate.open();
    settle_tasks().await;
    assert_eq!(
        connecting.live_connections(),
        0,
        "a connect cancelled at shutdown must not produce a process afterwards"
    );
}

// -------------------------------------- ATL-228: killing an in-flight connect

#[tokio::test(flavor = "multi_thread")]
async fn killing_an_agent_mid_connect_cancels_the_connect() {
    let catalog = TestCatalog::new(&["claude-code"]);
    let gate = Gate::shut();
    let server = TestServer::gated("claude-code", gate.clone());
    let manager = manager(catalog, server.clone());
    let key = custom("claude-code");

    manager.request_connection(key.clone(), server.clone());
    // Somebody is waiting on this connect, which is the whole reason it cannot
    // be cancelled by dropping the map's own handle on it.
    let waiter = {
        let (manager, key) = (manager.clone(), key.clone());
        tokio::spawn(async move { manager.connection(key).await })
    };
    wait_for(|| (server.attempts() == 1).then_some(()))
        .await
        .expect("the connect started");

    manager.drop_connection(&key);

    let outcome = tokio::time::timeout(Duration::from_secs(5), waiter)
        .await
        .expect("the waiter is released rather than left hanging")
        .expect("the waiter task ran");
    assert!(
        outcome.is_err(),
        "a connection killed while connecting must not be reported as connected"
    );
    wait_for(|| (server.connects_cancelled() == 1).then_some(()))
        .await
        .expect("the in-flight connect is dropped, not driven to completion");

    // Opening the gate afterwards proves the connect really is gone: nothing
    // downloads, spawns or hands back a process for an agent the user killed.
    gate.open();
    settle_tasks().await;
    assert_eq!(server.live_connections(), 0);
    assert_eq!(
        manager.connection_status(&key),
        AgentConnectionStatus::Disconnected
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn uninstalling_an_agent_mid_connect_cancels_the_connect() {
    let catalog = TestCatalog::new(&["claude-code"]);
    let gate = Gate::shut();
    let server = TestServer::gated("claude-code", gate.clone());
    let manager = manager(catalog.clone(), server.clone());

    manager.request_connection(custom("claude-code"), server.clone());
    wait_for(|| (server.attempts() == 1).then_some(()))
        .await
        .expect("the connect started");

    catalog.uninstall("claude-code");

    wait_for(|| (server.connects_cancelled() == 1).then_some(()))
        .await
        .expect("an uninstalled agent's in-flight install is cancelled");
    gate.open();
    settle_tasks().await;
    assert_eq!(server.live_connections(), 0);
}

/// A connect nobody killed still has to finish. The cancellation path must not
/// win a race against the ordinary one.
#[tokio::test(flavor = "multi_thread")]
async fn a_gated_connect_that_is_left_alone_still_connects() {
    let catalog = TestCatalog::new(&["claude-code"]);
    let gate = Gate::shut();
    let server = TestServer::gated("claude-code", gate.clone());
    let manager = manager(catalog, server.clone());
    let key = custom("claude-code");

    let entry = manager.request_connection(key.clone(), server.clone());
    wait_for(|| (server.attempts() == 1).then_some(()))
        .await
        .expect("the connect started");
    gate.open();

    settle(entry).await.expect("the connection comes up");
    wait_for(|| (manager.connection_status(&key) == AgentConnectionStatus::Connected).then_some(()))
        .await
        .expect("the entry reaches Connected");
    assert_eq!(server.connects_cancelled(), 0);
    assert_eq!(server.live_connections(), 1);
}

// ------------------------------------------------- ATL-229: turn identity

/// Turn A is superseded by turn B, then answers. It must close its own turn and
/// nothing else — the thread is still generating for B.
#[tokio::test(flavor = "multi_thread")]
async fn a_superseded_turns_late_reply_does_not_close_the_turn_that_superseded_it() {
    let catalog = TestCatalog::new(&[]);
    let server = TestServer::new("cersei");
    let manager = manager(catalog, server.clone());

    let thread = manager
        .new_session(Agent::Native, vec![PathBuf::from("/tmp")])
        .await
        .expect("a session opens");
    let session_id = thread.lock().unwrap().session_id().clone();

    let first_answer = server.queue_prompt();
    let second_answer = server.queue_prompt();

    let turn_a = {
        let (manager, session_id) = (manager.clone(), session_id.clone());
        tokio::spawn(async move { manager.send(&session_id, text("first")).await })
    };
    wait_for(|| (server.prompts_started() == 1).then_some(()))
        .await
        .expect("the first turn is in flight");

    let turn_b = {
        let (manager, session_id) = (manager.clone(), session_id.clone());
        tokio::spawn(async move { manager.send(&session_id, text("second")).await })
    };
    wait_for(|| (server.prompts_started() == 2).then_some(()))
        .await
        .expect("the second turn supersedes the first");

    // A's late reply lands. `begin_turn` already cancelled it, so this is the
    // cancelled turn reporting back — it must not close B's.
    first_answer.send(Ok(acp::StopReason::Cancelled)).unwrap();
    let stop = turn_a
        .await
        .expect("the first send task ran")
        .expect("the first send returns to its own caller");
    assert_eq!(
        stop,
        acp::StopReason::Cancelled,
        "the superseded caller still learns its turn was cancelled"
    );

    settle_tasks().await;
    assert!(
        thread.lock().unwrap().is_generating(),
        "the live turn is still running after the superseded one reported back"
    );

    second_answer.send(Ok(acp::StopReason::EndTurn)).unwrap();
    turn_b.await.unwrap().expect("the live turn finishes");
    assert!(
        !thread.lock().unwrap().is_generating(),
        "and closing the live turn does end the generating state"
    );
}

/// The same shape when the superseded turn fails rather than returning: its
/// error belongs to a turn that is already over.
#[tokio::test(flavor = "multi_thread")]
async fn a_superseded_turns_failure_does_not_mark_the_live_turn_as_errored() {
    let catalog = TestCatalog::new(&[]);
    let server = TestServer::new("cersei");
    let manager = manager(catalog, server.clone());

    let thread = manager
        .new_session(Agent::Native, vec![PathBuf::from("/tmp")])
        .await
        .expect("a session opens");
    let session_id = thread.lock().unwrap().session_id().clone();

    let first_answer = server.queue_prompt();
    let _second_answer = server.queue_prompt();

    let turn_a = {
        let (manager, session_id) = (manager.clone(), session_id.clone());
        tokio::spawn(async move { manager.send(&session_id, text("first")).await })
    };
    wait_for(|| (server.prompts_started() == 1).then_some(()))
        .await
        .expect("the first turn is in flight");

    let _turn_b = {
        let (manager, session_id) = (manager.clone(), session_id.clone());
        tokio::spawn(async move { manager.send(&session_id, text("second")).await })
    };
    wait_for(|| (server.prompts_started() == 2).then_some(()))
        .await
        .expect("the second turn supersedes the first");

    first_answer
        .send(Err(anyhow::anyhow!("the model refused")))
        .unwrap();
    turn_a
        .await
        .expect("the first send task ran")
        .expect_err("the superseded turn reports its own failure");

    settle_tasks().await;
    let thread = thread.lock().unwrap();
    assert!(
        thread.is_generating(),
        "the live turn survives the superseded turn's failure"
    );
    assert!(
        !thread.had_error(),
        "and the live turn is not marked as having failed"
    );
}

/// The guard has to let a CANCELLED turn through, and this is the case that
/// almost went out wrong: `cancel()` clears the running turn before the agent
/// answers, so the prompt returns `Cancelled` into a thread with no turn open.
/// A guard that demanded "this turn is running" would swallow the only
/// `Stopped` a cancelled turn ever emits — and `Stopped` is what produces
/// `TurnFinished` on the wire, which is what flushes analytics, the transcript,
/// and the turn's token usage into the next turn's footer.
#[tokio::test(flavor = "multi_thread")]
async fn a_cancelled_turn_still_closes_itself() {
    let catalog = TestCatalog::new(&[]);
    let server = TestServer::new("cersei");
    let manager = manager(catalog, server.clone());

    let thread = manager
        .new_session(Agent::Native, vec![PathBuf::from("/tmp")])
        .await
        .expect("a session opens");
    let session_id = thread.lock().unwrap().session_id().clone();

    let answer = server.queue_prompt();
    let turn = {
        let (manager, session_id) = (manager.clone(), session_id.clone());
        tokio::spawn(async move { manager.send(&session_id, text("hello")).await })
    };
    wait_for(|| (server.prompts_started() == 1).then_some(()))
        .await
        .expect("the turn is in flight");

    // The user presses stop. The thread's turn is cleared here, before the
    // agent has said anything.
    manager.cancel(&session_id);
    assert!(!thread.lock().unwrap().is_generating());

    // Everything announced up to here belongs to the cancel itself.
    server.drain_events(&session_id);

    // The agent then acknowledges, which is when the turn actually ends.
    answer.send(Ok(acp::StopReason::Cancelled)).unwrap();
    let stop = turn
        .await
        .expect("the send task ran")
        .expect("the cancelled turn returns to its caller");
    assert_eq!(stop, acp::StopReason::Cancelled);
    assert!(
        !thread.lock().unwrap().is_generating(),
        "and the thread is idle, not stuck generating"
    );

    // The assertion that matters: `Stopped` is what becomes `TurnFinished` on
    // the wire, and `TurnFinished` is what flushes analytics, the transcript
    // and this turn's token usage. Losing it leaves the next turn's footer
    // carrying the cancelled turn's tokens.
    let stopped: Vec<_> = server
        .drain_events(&session_id)
        .into_iter()
        .filter_map(|event| match event {
            atlas_acp_thread::AcpThreadEvent::Stopped(reason) => Some(reason),
            _ => None,
        })
        .collect();
    assert_eq!(
        stopped,
        vec![acp::StopReason::Cancelled],
        "a cancelled turn announces exactly one stop, carrying the agent's reason"
    );
}

/// An id two agents share cannot be closed by id alone, and saying so beats
/// reporting a success that closed nothing.
#[tokio::test(flavor = "multi_thread")]
async fn closing_an_ambiguous_session_id_is_an_error_not_a_silent_success() {
    let catalog = TestCatalog::new(&["one", "two"]);
    let first = TestServer::with_fixed_session_id("one", "ses-1");
    let second = TestServer::with_fixed_session_id("two", "ses-1");
    let manager = manager(catalog, first.clone());

    open_session(&manager, custom("one"), first).await;
    let session_id = open_session(&manager, custom("two"), second).await;
    assert_eq!(manager.sessions().len(), 2);

    manager
        .close_session(&session_id)
        .await
        .expect_err("an id that names two sessions cannot be closed by id alone");
    assert_eq!(
        manager.sessions().len(),
        2,
        "and nothing was closed behind the caller's back"
    );

    // An id that names nothing is still the idempotent case: a tab can close
    // twice, and an eviction may already have forgotten the session.
    manager
        .close_session(&acp::SessionId::new("never-existed"))
        .await
        .expect("closing an unknown session is a no-op");
}

/// The ordinary case still has to work: one turn, opened and closed by itself.
#[tokio::test(flavor = "multi_thread")]
async fn an_unsuperseded_turn_closes_itself() {
    let catalog = TestCatalog::new(&[]);
    let server = TestServer::new("cersei");
    let manager = manager(catalog, server.clone());

    let thread = manager
        .new_session(Agent::Native, vec![PathBuf::from("/tmp")])
        .await
        .expect("a session opens");
    let session_id = thread.lock().unwrap().session_id().clone();

    manager
        .send(&session_id, text("hello"))
        .await
        .expect("the turn runs");

    assert!(!thread.lock().unwrap().is_generating(), "the turn was closed");
}

// --------------------------------------------------------- ATL-230: minor

/// An agent uninstalled between resolving its server and starting the connect
/// used to be reported as "no command resolver for agent `x`", which describes
/// an internal fallback rather than what happened.
#[tokio::test(flavor = "multi_thread")]
async fn an_agent_uninstalled_mid_connect_reports_that_it_is_not_installed() {
    let catalog = TestCatalog::new(&["claude-code"]);
    let server = TestServer::new("claude-code");
    let manager = manager(catalog.clone(), server.clone());

    // The agent's command resolver is gone while it is still listed as
    // installed: exactly the window between `server_for` and
    // `start_connection`, and narrow enough that the uninstall watcher does not
    // fire and pre-empt the answer under test.
    catalog.hide_resolver("claude-code");
    let entry = manager.request_connection(custom("claude-code"), server.clone());

    let error = settle(entry).await.expect_err("there is nothing to connect to");
    assert!(
        matches!(&error, LoadError::Unsupported { message } if message.contains("not installed")),
        "the error should say the agent is not installed, not name an internal resolver: {error}"
    );
}

/// Two agents that mint the same session id are two sessions, not one. The map
/// used to be keyed by the agent-chosen id alone, so the second registration
/// silently evicted the first.
#[tokio::test(flavor = "multi_thread")]
async fn two_agents_minting_the_same_session_id_keep_both_sessions() {
    let catalog = TestCatalog::new(&["one", "two"]);
    let first = TestServer::with_fixed_session_id("one", "ses-1");
    let second = TestServer::with_fixed_session_id("two", "ses-1");
    let manager = manager(catalog, first.clone());

    settle(manager.request_connection(custom("one"), first.clone()))
        .await
        .expect("the first agent connects");
    settle(manager.request_connection(custom("two"), second.clone()))
        .await
        .expect("the second agent connects");

    let a = manager
        .new_session(custom("one"), vec![PathBuf::from("/tmp")])
        .await
        .expect("a session on the first agent");
    let b = manager
        .new_session(custom("two"), vec![PathBuf::from("/tmp")])
        .await
        .expect("a session on the second agent");
    assert_eq!(
        a.lock().unwrap().session_id(),
        b.lock().unwrap().session_id(),
        "the premise: both agents chose the same id"
    );

    assert_eq!(
        manager.sessions().len(),
        2,
        "one agent's session must not evict another's"
    );

    // And eviction stays exact: dropping one agent leaves the other's session.
    manager.drop_connection(&custom("one"));
    assert_eq!(manager.sessions().len(), 1);
}

// ---------------------------------------------- ATL-231: unobserved surface

/// `Connected` and `ConnectionFailed` are the two events the manager exists to
/// announce, and neither was asserted anywhere.
#[tokio::test(flavor = "multi_thread")]
async fn a_connection_announces_itself_and_its_failures() {
    let catalog = TestCatalog::new(&["claude-code"]);
    let server = TestServer::with_behaviour(
        "claude-code",
        ConnectBehaviour::Fails(LoadError::Exited {
            status: Some(1),
            stderr: "boom".into(),
        }),
    );
    let manager = manager(catalog, server.clone());
    let mut events = manager.subscribe();
    let key = custom("claude-code");

    settle(manager.request_connection(key.clone(), server.clone()))
        .await
        .expect_err("the scripted failure");

    let failure = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Ok(AgentManagerEvent::ConnectionFailed { agent, error }) = events.recv().await {
                return (agent, error);
            }
        }
    })
    .await
    .expect("the failure is announced");
    assert_eq!(failure.0, key);
    assert!(matches!(failure.1, LoadError::Exited { status: Some(1), .. }));

    server.set_behaviour(ConnectBehaviour::Immediate);
    settle(manager.request_connection(key.clone(), server.clone()))
        .await
        .expect("the retry connects");

    let connected = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Ok(AgentManagerEvent::Connected { agent }) = events.recv().await {
                return agent;
            }
        }
    })
    .await
    .expect("the connection is announced");
    assert_eq!(connected, key);
}

/// A failure leaves the caller holding an entry that can say why, even though
/// the map has already dropped it so the next request retries.
#[tokio::test(flavor = "multi_thread")]
async fn a_failed_entry_records_the_error_for_whoever_was_waiting() {
    let catalog = TestCatalog::new(&["claude-code"]);
    let server = TestServer::with_behaviour(
        "claude-code",
        ConnectBehaviour::Fails(LoadError::Exited {
            status: Some(2),
            stderr: "no".into(),
        }),
    );
    let manager = manager(catalog, server.clone());
    let key = custom("claude-code");

    let entry = manager.request_connection(key.clone(), server.clone());
    settle(entry.clone()).await.expect_err("the attempt fails");

    wait_for(|| manager.entry(&key).is_none().then_some(()))
        .await
        .expect("the failed entry is dropped from the table");

    // The waiter's own handle still answers with the error rather than with
    // "disconnected", which is all `connection_status` can say.
    let error = settle(entry)
        .await
        .expect_err("the entry the caller holds still carries the failure");
    assert!(matches!(error, LoadError::Exited { status: Some(2), .. }));
}

/// The `sessions` map is the state this crate added on top of Zed's store, and
/// nothing observed it through a whole session lifecycle.
#[tokio::test(flavor = "multi_thread")]
async fn closing_a_session_forgets_it_without_touching_the_connection() {
    let catalog = TestCatalog::new(&["claude-code"]);
    let server = TestServer::new("claude-code");
    let manager = manager(catalog, server.clone());
    let key = custom("claude-code");

    let session_id = open_session(&manager, key.clone(), server.clone()).await;
    assert_eq!(manager.sessions().len(), 1);

    manager
        .close_session(&session_id)
        .await
        .expect("the session closes");

    assert!(manager.sessions().is_empty());
    assert_eq!(
        manager.connection_status(&key),
        AgentConnectionStatus::Connected,
        "closing a session does not close the agent"
    );
    assert_eq!(server.live_connections(), 1);
}

/// Nothing asserted that a cancel reaches the thread at all.
#[tokio::test(flavor = "multi_thread")]
async fn cancelling_an_unknown_session_is_a_no_op() {
    let catalog = TestCatalog::new(&[]);
    let server = TestServer::new("cersei");
    let manager = manager(catalog, server);

    // No panic, no error: the id simply names nothing.
    manager.cancel(&acp::SessionId::new("nope"));
    assert!(manager.sessions().is_empty());
}

/// `connections()` is what shutdown iterates, and no test read it.
#[tokio::test(flavor = "multi_thread")]
async fn connections_lists_only_what_is_actually_up() {
    let catalog = TestCatalog::new(&["claude-code"]);
    let gate = Gate::shut();
    let server = TestServer::gated("claude-code", gate.clone());
    let manager = manager(catalog, server.clone());
    let key = custom("claude-code");

    let entry = manager.request_connection(key.clone(), server.clone());
    wait_for(|| (server.attempts() == 1).then_some(()))
        .await
        .expect("the connect started");
    assert!(
        manager.connections().is_empty(),
        "a connect still in flight is not a connection"
    );

    gate.open();
    settle(entry).await.expect("connected");
    wait_for(|| (manager.connections().len() == 1).then_some(()))
        .await
        .expect("and once it lands it is");

    let listed = manager.connections();
    assert_eq!(listed[0].0, key);
    assert_eq!(listed[0].1.agent_id().as_str(), "claude-code");
}

/// A counter the concurrency tests lean on: the harness really does report one
/// attempt per connect, so `attempts() == 1` means what the tests read it to.
#[tokio::test(flavor = "multi_thread")]
async fn the_harness_counts_one_attempt_per_connect() {
    let catalog = TestCatalog::new(&["claude-code"]);
    let server = TestServer::new("claude-code");
    let manager = manager(catalog, server.clone());
    let key = custom("claude-code");

    settle(manager.request_connection(key.clone(), server.clone()))
        .await
        .expect("connected");
    assert_eq!(server.attempts(), 1);

    manager.drop_connection(&key);
    settle(manager.request_connection(key, server.clone()))
        .await
        .expect("reconnected");
    assert_eq!(server.attempts(), 2);
}
