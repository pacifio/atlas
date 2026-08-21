//! Connect-path tests, adapted from the mechanics in
//! `zed-ref/crates/agent_servers/src/acp.rs:957-1025`.
//!
//! These drive a real child process over real pipes. The fake agent is a small
//! python script rather than a mock transport, because what is under test is the
//! spawn-and-handshake path itself: the race between `initialize` and the child
//! dying is only meaningful against a process that can actually die.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::{event_channel, AgentId, LoadError};
use atlas_agent_servers::*;

/// Answers `initialize` and then sits there. Writes its pid to `PID_FILE`
/// first when one is given, so a test can check whether it is still alive.
const FAKE_AGENT: &str = r#"
import sys, json, os
pid_file = PID_FILE
if pid_file:
    open(pid_file, "w").write(str(os.getpid()))
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    if msg.get("method") == "initialize":
        sys.stdout.write(json.dumps({
            "jsonrpc": "2.0",
            "id": msg["id"],
            "result": {
                "protocolVersion": PROTOCOL_VERSION,
                "agentCapabilities": {},
                "authMethods": [],
                "agentInfo": {"name": "fake-agent", "version": "9.9.9"},
            },
        }) + "\n")
        sys.stdout.flush()
"#;

fn python() -> Option<&'static str> {
    ["/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"]
        .into_iter()
        .find(|path| std::path::Path::new(path).exists())
}

fn thread_events() -> ThreadEventSink {
    Arc::new(|_session_id: &acp::SessionId| {
        let (tx, rx) = event_channel();
        // Nothing consumes thread events in this crate; keep the receiver alive
        // so sends do not fail for a reason unrelated to the test.
        Box::leak(Box::new(rx));
        tx
    })
}

fn command(path: &str, args: &[&str]) -> AgentServerCommand {
    AgentServerCommand {
        path: PathBuf::from(path),
        args: args.iter().map(|arg| arg.to_string()).collect(),
        env: Some(HashMap::new()),
    }
}

async fn connect(command: AgentServerCommand) -> anyhow::Result<AcpConnection> {
    AcpConnection::stdio(
        AgentId::new("fake"),
        command,
        None,
        AcpConnectionDefaults::default(),
        thread_events(),
        "atlas",
        "0.0.0-test".to_string(),
    )
    .await
}

fn fake_agent_command(protocol_version: u16) -> Option<AgentServerCommand> {
    fake_agent_command_with_pid_file(protocol_version, None)
}

fn fake_agent_command_with_pid_file(
    protocol_version: u16,
    pid_file: Option<&std::path::Path>,
) -> Option<AgentServerCommand> {
    let python = python()?;
    let script = FAKE_AGENT
        .replace("PROTOCOL_VERSION", &protocol_version.to_string())
        .replace(
            "PID_FILE",
            &match pid_file {
                Some(path) => format!("{:?}", path.display().to_string()),
                None => "None".to_string(),
            },
        );
    Some(AgentServerCommand {
        path: PathBuf::from(python),
        args: vec!["-c".to_string(), script],
        env: Some(HashMap::new()),
    })
}

/// The happy path: spawn, handshake, and take the agent at its word about who
/// it is.
#[tokio::test]
async fn a_successful_handshake_reports_the_agents_own_name_and_version() {
    let Some(command) = fake_agent_command(1) else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };

    let connection = connect(command).await.expect("handshake failed");

    use atlas_acp_thread::AgentConnection as _;
    assert_eq!(
        connection.telemetry_id().as_ref(),
        "fake-agent",
        "the agent's own name wins over the id we know it by"
    );
    assert_eq!(
        connection.agent_version().as_deref(),
        Some("9.9.9")
    );
}

/// Adapted from the protocol-version guard (`acp.rs:1023-1025`). Zed rejects
/// anything below v1 outright rather than trying to degrade.
#[tokio::test]
async fn an_agent_below_protocol_v1_is_rejected() {
    let Some(command) = fake_agent_command(0) else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };

    let error = connect(command).await.expect_err("expected a rejection");
    let load_error = error
        .downcast_ref::<LoadError>()
        .expect("expected a LoadError");
    assert!(
        matches!(load_error, LoadError::Unsupported { .. }),
        "got {load_error:?}"
    );
}

/// The initialize-vs-exit race (`acp.rs:957-1021`). An agent that dies during
/// startup must surface as `Exited` with its status — before this, the connect
/// awaited a handle that would never arrive and the UI hung on "connecting".
#[tokio::test]
async fn an_agent_that_exits_immediately_reports_its_exit_status() {
    let error = connect(command("/bin/sh", &["-c", "exit 3"]))
        .await
        .expect_err("expected the connect to fail");

    let load_error = error
        .downcast_ref::<LoadError>()
        .expect("expected a LoadError, not a transport error");
    match load_error {
        LoadError::Exited { status, .. } => {
            assert_eq!(*status, Some(3), "the child's exit code must survive")
        }
        other => panic!("expected Exited, got {other:?}"),
    }
}

/// Same race, but the agent prints why before dying. The reason is on stderr and
/// nowhere else, so it has to reach the error.
#[tokio::test]
async fn a_dying_agent_reports_what_it_said_on_stderr() {
    let error = connect(command(
        "/bin/sh",
        &["-c", "echo 'cannot find module acp' >&2; sleep 0.2; exit 1"],
    ))
    .await
    .expect_err("expected the connect to fail");

    let load_error = error
        .downcast_ref::<LoadError>()
        .expect("expected a LoadError");
    match load_error {
        LoadError::Exited { stderr, .. } => assert!(
            stderr.contains("cannot find module acp"),
            "stderr did not reach the error: {stderr:?}"
        ),
        other => panic!("expected Exited, got {other:?}"),
    }
}

/// A binary that is not there at all fails at spawn rather than hanging.
#[tokio::test]
async fn a_missing_binary_fails_to_spawn() {
    let error = connect(command(
        "/nonexistent/definitely-not-an-agent",
        &[],
    ))
    .await
    .expect_err("expected the spawn to fail");

    assert!(
        error.to_string().contains("failed to spawn"),
        "unexpected error: {error}"
    );
}

/// An agent that never answers `initialize` must not hang the connect forever.
#[tokio::test]
async fn an_agent_that_never_answers_does_not_hang_forever() {
    let connect = connect(command("/bin/sh", &["-c", "sleep 30"]));
    let result = tokio::time::timeout(std::time::Duration::from_secs(2), connect).await;

    assert!(
        result.is_err(),
        "a silent agent is expected to leave the connect pending; \
         if this now resolves, a timeout was added and this test should assert it"
    );
}

/// Dropping the connection must take the agent process with it. Nothing else
/// holds a handle to kill it, so a leak here means an orphaned agent per
/// connection for the lifetime of the app.
#[tokio::test]
async fn dropping_the_connection_kills_the_agent_process() {
    let pid_file = std::env::temp_dir().join(format!(
        "atlas-agent-servers-pid-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&pid_file);

    let Some(command) = fake_agent_command_with_pid_file(1, Some(&pid_file)) else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };

    let connection = connect(command).await.expect("handshake failed");

    let pid: i32 = std::fs::read_to_string(&pid_file)
        .expect("agent did not report its pid")
        .trim()
        .parse()
        .expect("unparsable pid");
    assert!(process_is_alive(pid), "agent should be running");

    drop(connection);

    // The kill is asynchronous — the wait task has to be aborted and the child
    // dropped before the signal lands.
    for _ in 0..100 {
        if !process_is_alive(pid) {
            let _ = std::fs::remove_file(&pid_file);
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    let _ = std::fs::remove_file(&pid_file);
    panic!("agent process {pid} outlived its connection");
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
