//! One path through the manager with a real child process on the end of it.
//!
//! Every other test in this crate stops at a fake `AgentServer`, so nothing
//! exercised the thing the manager exists to own: resolving a command, spawning
//! it, completing the `initialize` handshake, and — the half that matters for
//! ATL-227 and ATL-228 — making sure the process is gone afterwards. A fake
//! connection cannot fail to die.
//!
//! The agent is a small python script, the same fixture shape
//! `atlas-agent-servers/tests/connect.rs` uses, because what is under test is
//! the spawn-and-teardown path rather than any particular agent.

mod support;

use std::time::Duration;

use atlas_agent_manager::AgentConnectionStatus;
use support::spawning::{
    agent_pid, manager_advertising_capabilities, parked_manager, spawning_manager,
};
use support::{custom, wait_for};

/// `kill -0`: signal 0 checks for existence without delivering anything.
fn process_is_alive(pid: i32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[tokio::test(flavor = "multi_thread")]
async fn the_manager_spawns_a_real_agent_and_completes_the_handshake() {
    let Some((manager, pid_file)) = spawning_manager("handshake") else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };
    let key = custom("fake-agent");

    let connection = manager
        .connection(key.clone())
        .await
        .expect("the agent connects");

    // Taken from the agent's own `initialize` response, which is the only place
    // this string exists — nothing in Atlas hardcodes it.
    assert_eq!(connection.agent_version().as_deref(), Some("9.9.9"));
    // The entry reaches `Connected` on the watcher task, which the caller's own
    // await does not wait for.
    wait_for(|| {
        (manager.connection_status(&key) == AgentConnectionStatus::Connected).then_some(())
    })
    .await
    .expect("the entry reaches Connected");

    let pid = agent_pid(&pid_file)
        .await
        .expect("the agent reported its pid");
    assert!(process_is_alive(pid), "the agent process is running");

    drop(connection);
    manager.drop_connection(&key);

    let died = wait_for(|| (!process_is_alive(pid)).then_some(())).await;
    let _ = std::fs::remove_file(&pid_file);
    died.expect("the agent process is killed when its connection is dropped");
}

/// The ATL-227 leak, end to end: a session pins the connection, and an eviction
/// that forgets to release it leaves a real process running with nothing able
/// to reach it — including the shutdown sweep.
#[tokio::test(flavor = "multi_thread")]
async fn shutdown_kills_an_agent_that_still_has_a_session_open() {
    let Some((manager, pid_file)) = spawning_manager("shutdown") else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };
    let key = custom("fake-agent");

    let thread = manager
        .new_session(key.clone(), vec![std::env::temp_dir()])
        .await
        .expect("a session opens on the real agent");
    drop(thread);
    assert_eq!(manager.sessions().len(), 1);

    let pid = agent_pid(&pid_file)
        .await
        .expect("the agent reported its pid");
    assert!(process_is_alive(pid));

    manager.shutdown();

    assert!(manager.sessions().is_empty());
    let died = wait_for(|| (!process_is_alive(pid)).then_some(())).await;
    let _ = std::fs::remove_file(&pid_file);
    died.expect("no ACP child outlives the app, session open or not");
}

/// Killing an agent mid-connect must not leave a process behind. The child is
/// spawned inside the connect future, so this is the real window: the agent is
/// running and the handshake has not finished.
///
/// The agent parks after writing its pid rather than the test racing to catch
/// it, so the kill always lands with a live child rather than usually landing
/// before one exists.
#[tokio::test(flavor = "multi_thread")]
async fn an_agent_killed_during_its_connect_leaves_no_process() {
    let Some((manager, pid_file, go_file)) = parked_manager("mid-connect") else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };
    let key = custom("fake-agent");

    let entry = manager.connect_to(key.clone());
    let pid = agent_pid(&pid_file)
        .await
        .expect("the agent spawned and reported its pid");
    assert!(
        process_is_alive(pid),
        "the child is up and awaiting `initialize`"
    );

    manager.drop_connection(&key);

    // The waiter is released with a failure rather than a connection to a
    // process the user just killed.
    let task = entry.lock().unwrap().wait_for_connection();
    let outcome = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("the waiter is released rather than left hanging");
    assert!(outcome.is_err(), "a killed connect does not report success");
    assert_eq!(
        manager.connection_status(&key),
        AgentConnectionStatus::Disconnected
    );

    let died = wait_for(|| (!process_is_alive(pid)).then_some(())).await;
    let _ = std::fs::remove_file(&pid_file);
    let _ = std::fs::remove_file(&go_file);
    died.expect("a connect that was killed must not leave a process running");
}

/// Opens one session on an agent that answers `initialize` with `caps`, and
/// reports what the manager says about its HTTP MCP support.
async fn http_mcp_support_advertised_by(
    tag: &str,
    caps: serde_json::Value,
) -> Option<Option<bool>> {
    let (manager, pid_file) = manager_advertising_capabilities(tag, caps)?;
    let key = custom("fake-agent");
    assert_eq!(
        manager.supports_http_mcp(&key),
        None,
        "nothing is known about an agent that has not connected"
    );
    let thread = manager
        .new_session(key.clone(), vec![std::env::temp_dir()])
        .await
        .expect("a session opens on the real agent");
    // Capabilities are read off the `Connected` entry, which the watcher task
    // publishes after the connect future `new_session` awaited; wait for it so
    // the answer is about what the agent advertised.
    wait_for(|| {
        (manager.connection_status(&key) == AgentConnectionStatus::Connected).then_some(())
    })
    .await
    .expect("the entry reaches Connected");
    let supported = manager.supports_http_mcp(&key);
    drop(thread);
    manager.shutdown();
    let _ = std::fs::remove_file(&pid_file);
    Some(supported)
}

/// The memory tool server rides in `mcpServers` as an HTTP server, so whether
/// an agent can take it is exactly what it advertised at `initialize` — never
/// what Atlas believes about that agent by name.
#[tokio::test(flavor = "multi_thread")]
async fn an_agent_advertising_http_mcp_is_reported_as_supporting_it() {
    let Some(supported) = http_mcp_support_advertised_by(
        "http-mcp-on",
        serde_json::json!({ "mcpCapabilities": { "http": true } }),
    )
    .await
    else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };
    assert_eq!(supported, Some(true));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_omitting_http_mcp_is_reported_as_not_supporting_it() {
    let Some(supported) = http_mcp_support_advertised_by(
        "http-mcp-off",
        serde_json::json!({ "mcpCapabilities": { "sse": true } }),
    )
    .await
    else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };
    assert_eq!(supported, Some(false));
}

/// The agent dies after it connected, with no session open. The manager used
/// to keep the entry as `Connected`, so the next request was handed a
/// transport with nobody behind it and waited out a full request deadline
/// to learn so. The process exit must evict the entry.
#[tokio::test(flavor = "multi_thread")]
async fn an_agent_that_dies_after_connecting_is_dropped_from_the_table() {
    let Some((manager, pid_file)) = spawning_manager("dies-after-connect") else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };
    let key = custom("fake-agent");

    manager
        .connection(key.clone())
        .await
        .expect("the handshake completes");
    assert_eq!(
        manager.connection_status(&key),
        AgentConnectionStatus::Connected
    );
    let pid = agent_pid(&pid_file)
        .await
        .expect("the agent reported its pid");

    // The process goes away behind the manager's back.
    let killed = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status()
        .expect("kill runs");
    assert!(killed.success(), "the fake agent was killed");

    let evicted = wait_for(|| {
        (manager.connection_status(&key) == AgentConnectionStatus::Disconnected).then_some(())
    })
    .await;
    let _ = std::fs::remove_file(&pid_file);
    evicted.expect("a dead connection must not stay listed as connected");
    assert!(
        manager.connections().is_empty(),
        "nothing is up once the only agent has died"
    );
}
