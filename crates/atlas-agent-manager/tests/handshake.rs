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

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::v1 as acp;
use anyhow::Result;
use atlas_acp_thread::AgentId;
use atlas_agent_manager::{AgentConnectionStatus, AgentManager};
use atlas_agent_servers::{AgentServerCommand, ExternalAgentServer};
use futures::future::BoxFuture;
use futures::FutureExt;
use support::{connect_options, custom, wait_for};
use tokio::sync::watch;

/// Answers `initialize` and `session/new`, then sits there. Writes its pid
/// first, so the test can ask the operating system whether it is still alive.
const FAKE_AGENT: &str = r#"
import sys, json, os
open(PID_FILE, "w").write(str(os.getpid()))
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        result = {
            "protocolVersion": 1,
            "agentCapabilities": {},
            "authMethods": [],
            "agentInfo": {"name": "fake-agent", "version": "9.9.9"},
        }
    elif method == "session/new":
        result = {"sessionId": "session-1"}
    else:
        continue
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}) + "\n")
    sys.stdout.flush()
"#;

fn python() -> Option<&'static str> {
    [
        "/usr/bin/python3",
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
    ]
    .into_iter()
    .find(|path| Path::new(path).exists())
}

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

/// Resolves the fake agent's command, the way the real store resolves an
/// installed agent's.
struct PythonResolver {
    python: &'static str,
    pid_file: PathBuf,
}

impl ExternalAgentServer for PythonResolver {
    fn get_command(
        &self,
        _extra_args: Vec<String>,
        _extra_env: HashMap<String, String>,
    ) -> BoxFuture<'static, Result<AgentServerCommand>> {
        let script = FAKE_AGENT.replace(
            "PID_FILE",
            &format!("{:?}", self.pid_file.display().to_string()),
        );
        let path = PathBuf::from(self.python);
        async move {
            Ok(AgentServerCommand {
                path,
                args: vec!["-c".to_string(), script],
                env: Some(HashMap::new()),
            })
        }
        .boxed()
    }
}

struct SpawningCatalog {
    id: AgentId,
    python: &'static str,
    pid_file: PathBuf,
}

impl atlas_agent_manager::AgentCatalog for SpawningCatalog {
    fn external_agents(&self) -> Vec<AgentId> {
        vec![self.id.clone()]
    }

    fn agent_server(&self, id: &AgentId) -> Option<Arc<dyn ExternalAgentServer>> {
        (id == &self.id).then(|| {
            Arc::new(PythonResolver {
                python: self.python,
                pid_file: self.pid_file.clone(),
            }) as Arc<dyn ExternalAgentServer>
        })
    }

    fn default_mode(&self, _id: &AgentId) -> Option<acp::SessionModeId> {
        None
    }

    fn watch_new_version(&self, _id: &AgentId) -> Option<watch::Receiver<Option<String>>> {
        None
    }

    fn watch_loading_status(&self, _id: &AgentId) -> Option<watch::Receiver<Option<String>>> {
        None
    }

    fn updates(&self) -> watch::Receiver<u64> {
        watch::channel(0).1
    }
}

/// Builds a manager whose one installed agent is a real process, and returns
/// the file that process writes its pid into.
fn spawning_manager(tag: &str) -> Option<(Arc<AgentManager>, PathBuf)> {
    let python = python()?;
    let pid_file = std::env::temp_dir().join(format!(
        "atlas-agent-manager-{tag}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&pid_file);

    let catalog = Arc::new(SpawningCatalog {
        id: AgentId::new("fake-agent"),
        python,
        pid_file: pid_file.clone(),
    });
    // The native server is never used here; every path goes through the
    // installed agent.
    let native: Arc<dyn atlas_agent_servers::AgentServer> = support::TestServer::new("unused");
    Some((
        AgentManager::new(catalog, native, connect_options()),
        pid_file,
    ))
}

async fn agent_pid(pid_file: &Path) -> Option<i32> {
    wait_for(|| {
        std::fs::read_to_string(pid_file)
            .ok()
            .and_then(|raw| raw.trim().parse::<i32>().ok())
    })
    .await
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
    wait_for(|| (manager.connection_status(&key) == AgentConnectionStatus::Connected).then_some(()))
        .await
        .expect("the entry reaches Connected");

    let pid = agent_pid(&pid_file).await.expect("the agent reported its pid");
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

    let pid = agent_pid(&pid_file).await.expect("the agent reported its pid");
    assert!(process_is_alive(pid));

    manager.shutdown();

    assert!(manager.sessions().is_empty());
    let died = wait_for(|| (!process_is_alive(pid)).then_some(())).await;
    let _ = std::fs::remove_file(&pid_file);
    died.expect("no ACP child outlives the app, session open or not");
}

/// Killing an agent mid-connect must not leave a process behind either. Here
/// the child is spawned inside the connect future, so the window is real.
#[tokio::test(flavor = "multi_thread")]
async fn an_agent_killed_during_its_connect_leaves_no_process() {
    let Some((manager, pid_file)) = spawning_manager("mid-connect") else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };
    let key = custom("fake-agent");

    let entry = manager.connect_to(key.clone());
    manager.drop_connection(&key);

    // Whichever side won, the outcome is the same: nothing is connected, and
    // any process that did get as far as starting is gone.
    let task = entry.lock().unwrap().wait_for_connection();
    let _ = tokio::time::timeout(Duration::from_secs(5), task).await;
    assert_eq!(
        manager.connection_status(&key),
        AgentConnectionStatus::Disconnected
    );

    if let Ok(raw) = std::fs::read_to_string(&pid_file) {
        if let Ok(pid) = raw.trim().parse::<i32>() {
            let died = wait_for(|| (!process_is_alive(pid)).then_some(())).await;
            let _ = std::fs::remove_file(&pid_file);
            died.expect("a connect that was killed must not leave a process running");
            return;
        }
    }
    let _ = std::fs::remove_file(&pid_file);
}
