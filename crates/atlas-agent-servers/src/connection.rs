//! The live connection to one external ACP agent — ported from
//! `zed-ref/crates/agent_servers/src/acp.rs`.
//!
//! This is where the reliability mechanics live. Each one exists because of a
//! specific failure, and the reason is recorded at the code rather than here.

use std::any::Any;
use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_client_protocol::schema::v1 as acp;
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{Agent, Client, ConnectionTo, Lines};
use anyhow::{anyhow, Context as _, Result};
use atlas_acp_thread::{
    AcpThread, AcpThreadEvent, AcpThreadHandle, AgentConnection, AgentId, AgentModelId,
    AgentModelInfo, AgentModelList, AgentModelSelector, AgentSessionConfigOptions,
    AgentSessionModes, AuthRequired, ElicitationStore, ElicitationStoreEvent,
    ElicitationStoreHandle, EventSink, LoadError,
    TerminalAuthCommand, build_terminal_auth_command,
};
use futures::future::BoxFuture;
use futures::{AsyncBufReadExt, FutureExt, StreamExt};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use crate::debug_log::{AcpDebugLog, AcpDebugMessage, AcpDebugMessageDirection};
use crate::handlers::{self, ClientContext};
use crate::session::{
    AcpSession, CancelSignal, CancelWaiter, ConfigOptions, SessionDirectories, SessionRegistry,
};
use crate::session_list::AcpSessionList;
use crate::session_mcp::{self, SessionMcpRequest, SessionMcpServers};

/// Zed rejects anything below v1 outright rather than trying to degrade.
const MINIMUM_SUPPORTED_VERSION: ProtocolVersion = ProtocolVersion::V1;

/// How long to wait for the child's exit status after `initialize` fails.
///
/// An agent that dies during startup loses the initialize race by a hair: the
/// RPC fails first (the pipe closed) and the exit status lands a moment later.
/// Reporting the RPC error would tell the user "connection closed" when the
/// real answer — on stderr — is one tick away.
const INITIALIZE_EXIT_GRACE: Duration = Duration::from_millis(250);

/// How long the child gets to hand over its connection and to answer
/// `initialize`.
///
/// Before this the handshake was raced only against the child *dying*. A child
/// that is alive but silent — or whose grandchild `codex app-server` is wedged
/// — won that race forever, and the tab sat on "connecting" with nothing to
/// report. Generous: a cold `node` start on a slow disk is seconds, not a
/// minute, so expiry means the agent is not going to answer.
pub const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(60);

/// Maximum time the exit path waits for the stderr reader to reach EOF before
/// it builds the `Exited` error out of what was recorded. The reader normally
/// completes immediately; the bound covers descendants which retain stderr.
const STDERR_DRAIN_GRACE: Duration = Duration::from_secs(1);

/// How long a one-shot RPC on the connect/bind path may take: `session/new`,
/// `session/load`, `session/resume`, `authenticate`, `session/list`.
///
/// Longer than [`INITIALIZE_TIMEOUT`] because `session/load` replays history
/// and `session/new` may set a mode round-trip behind it. `session/prompt`
/// deliberately has no deadline — see [`CANCEL_GRACE`].
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// How long an agent gets to answer its own cancellation before the turn is
/// resolved locally.
///
/// `session/prompt` deliberately has no timeout — a legitimate turn runs for
/// minutes and a flat deadline would kill working sessions. The clock starts
/// only once the user has asked to stop, which is the point at which waiting
/// indefinitely stops being correct: they have said they do not want the
/// result, so the only question left is how long to be polite about it.
///
/// Long enough that a healthy agent always wins the race — acknowledging a
/// cancel is a wire round-trip plus whatever teardown the agent does, well
/// inside a second — and short enough to be a recovery rather than a second
/// wait. Losing the race costs the turn's real stop reason and token counts,
/// which is a fair price for a chat that unfreezes.
const CANCEL_GRACE: Duration = Duration::from_secs(5);

/// The clock above, held on the connection so a test can shorten it. The
/// default is the constant; nothing in the app changes it.
///
/// [`INITIALIZE_TIMEOUT`] is not in here: it runs out inside
/// [`AcpConnection::stdio`], before there is a connection to set it on, and a
/// test reaches it with a paused clock instead.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConnectionDeadlines {
    pub cancel_grace: Duration,
}

impl Default for ConnectionDeadlines {
    fn default() -> Self {
        Self {
            cancel_grace: CANCEL_GRACE,
        }
    }
}

/// What a session's `AcpThread` events are sent to.
///
/// Zed's threads are GPUI entities that the UI subscribes to directly. Here the
/// host supplies a sink per session, so routing deltas onto the outbound
/// pipeline stays the host's business and this crate stays leaf-level.
pub type ThreadEventSink =
    Arc<dyn Fn(&acp::SessionId) -> EventSink<AcpThreadEvent> + Send + Sync>;

/// Where a connection's request-scoped elicitations are announced, supplied by
/// the host the same way [`ThreadEventSink`] is. See `ConnectOptions`.
pub type RequestElicitationSink =
    Arc<dyn Fn(&AgentId) -> EventSink<ElicitationStoreEvent> + Send + Sync>;

/// Defaults applied to every new session on this connection.
///
/// Zed reads these from its `SettingsStore` and re-reads them on every settings
/// change. Atlas's settings live above this crate, so they are passed in at
/// connect time instead.
#[derive(Clone, Default)]
pub struct AcpConnectionDefaults {
    pub mode: Option<acp::SessionModeId>,
    pub config_options: HashMap<String, acp::SessionConfigOptionValue>,
}

pub struct AcpConnection {
    id: AgentId,
    telemetry_id: Arc<str>,
    agent_version: Option<Arc<str>>,
    connection: ConnectionTo<Agent>,
    sessions: Arc<SessionRegistry>,
    auth_methods: Vec<acp::AuthMethod>,
    agent_capabilities: acp::AgentCapabilities,
    /// Present only when the agent advertised `sessionCapabilities.list`. Its
    /// absence is what "this agent has no listable history" means, everywhere.
    session_list: Option<Arc<AcpSessionList>>,
    /// The command this connection was launched with. Kept because a typed
    /// `Terminal` auth method names only the ARGUMENTS that sign the agent in —
    /// the binary is the one Atlas already spawned.
    command: AgentServerCommand,
    request_elicitations: ElicitationStoreHandle,
    defaults: AcpConnectionDefaults,
    deadlines: Mutex<ConnectionDeadlines>,
    thread_events: ThreadEventSink,
    debug_log: AcpDebugLog,
    /// Decides the MCP servers each session request carries. `None` sends
    /// every session an empty list.
    session_mcp: Option<Arc<dyn SessionMcpServers>>,
    _io_task: tokio::task::JoinHandle<()>,
    _stderr_task: tokio::task::JoinHandle<()>,
    _wait_task: tokio::task::JoinHandle<()>,
}

/// What to run, and how. Ported from Zed's `AgentServerCommand`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentServerCommand {
    pub path: PathBuf,
    pub args: Vec<String>,
    pub env: Option<HashMap<String, String>>,
}

impl std::fmt::Debug for AcpConnection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AcpConnection")
            .field("id", &self.id)
            .field("agent_version", &self.agent_version)
            .finish_non_exhaustive()
    }
}

impl AcpConnection {
    #[allow(clippy::too_many_arguments)]
    pub async fn stdio(
        agent_id: AgentId,
        command: AgentServerCommand,
        root_dir: Option<PathBuf>,
        defaults: AcpConnectionDefaults,
        thread_events: ThreadEventSink,
        request_elicitation_events: RequestElicitationSink,
        client_name: &'static str,
        client_version: String,
    ) -> Result<Self> {
        let mut child_command = atlas_process::async_command(&command.path);
        child_command
            .args(&command.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // The agent is not attached to a tty and must never try to prompt.
            .kill_on_drop(true);
        if let Some(env) = &command.env {
            child_command.envs(env);
        }
        if let Some(cwd) = &root_dir {
            child_command.current_dir(cwd);
        }

        let mut child = AgentChild::spawn(&mut child_command)
            .with_context(|| format!("failed to spawn agent server {:?}", command.path))?;

        let stdout = child.inner.stdout.take().context("failed to take stdout")?;
        let stdin = child.inner.stdin.take().context("failed to take stdin")?;
        let stderr = child.inner.stderr.take().context("failed to take stderr")?;
        tracing::debug!(?command.path, args = ?command.args, "spawned external agent server");

        let debug_log = AcpDebugLog::new();
        let sessions = Arc::new(SessionRegistry::new());
        let request_elicitations: ElicitationStoreHandle = Arc::new(Mutex::new(
            ElicitationStore::new(request_elicitation_events(&agent_id)),
        ));

        // Both directions are tee'd into the debug log before they reach the
        // codec, so the log shows the bytes as they went over the wire.
        let incoming = futures::io::BufReader::new(stdout.compat()).lines().inspect({
            let debug_log = debug_log.clone();
            move |result| match result {
                Ok(line) => debug_log.record_line(AcpDebugMessageDirection::Incoming, line),
                Err(err) => tracing::warn!("ACP transport read error: {err}"),
            }
        });
        let outgoing = futures::sink::unfold(
            (Box::pin(stdin.compat_write()), debug_log.clone()),
            async move |(mut writer, debug_log), line: String| {
                use futures::AsyncWriteExt;
                debug_log.record_line(AcpDebugMessageDirection::Outgoing, &line);
                let mut bytes = line.into_bytes();
                bytes.push(b'\n');
                writer.write_all(&bytes).await?;
                Ok::<_, std::io::Error>((writer, debug_log))
            },
        );
        let transport = Lines::new(outgoing, incoming);

        let (stderr_drained_tx, stderr_drained_rx) = tokio::sync::oneshot::channel();
        let stderr_task = tokio::spawn({
            let debug_log = debug_log.clone();
            async move {
                use tokio::io::AsyncBufReadExt as _;
                let mut lines = tokio::io::BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let trimmed = line.trim_end_matches(['\n', '\r']);
                    tracing::warn!("agent stderr: {trimmed}");
                    debug_log.record_line(AcpDebugMessageDirection::Stderr, trimmed);
                }
                let _ = stderr_drained_tx.send(());
            }
        });

        let ctx = ClientContext {
            sessions: sessions.clone(),
            request_elicitations: request_elicitations.clone(),
        };
        let (connection_tx, connection_rx) = futures::channel::oneshot::channel();
        let connection_future = connect_client_future(client_name, transport, ctx, connection_tx);
        let io_task = tokio::spawn(async move {
            if let Err(err) = connection_future.await {
                tracing::error!("ACP connection error: {err}");
            }
        });

        // Race the handshake against the child dying. Without this a binary
        // that exits immediately leaves us awaiting a handle that will never
        // arrive, and the UI hangs on "connecting" forever.
        //
        // And against the clock. The child owns nothing but its pipes here, so
        // a child that neither dies nor answers used to hold this future — and
        // every caller joined on it — for good. On expiry the timeout drops
        // the select, the select drops `status_fut`, and `status_fut` drops
        // the child, whose `Drop` kills the whole process group. Nothing else
        // needs to reach in.
        let mut status_fut = Box::pin(wait_for_exit(
            child,
            debug_log.clone(),
            stderr_drained_rx,
        ));
        let connection_rx = Box::pin(async move {
            connection_rx
                .await
                .context("failed to receive ACP connection handle")
        });
        let connection = match tokio::time::timeout(
            INITIALIZE_TIMEOUT,
            futures::future::select(connection_rx, status_fut),
        )
        .await
        {
            Ok(futures::future::Either::Left((connection, rest))) => {
                status_fut = rest;
                connection?
            }
            Ok(futures::future::Either::Right(((load_error, _child), _))) => {
                return Err(load_error.into())
            }
            Err(_elapsed) => {
                return Err(timed_out(&agent_id, "handshake", INITIALIZE_TIMEOUT, &debug_log));
            }
        };

        let initialize = Box::pin(
            connection
                .send_request(
                    acp::InitializeRequest::new(ProtocolVersion::V1)
                        .client_capabilities(client_capabilities_for_agent(&agent_id))
                        .client_info(acp::Implementation::new(client_name, client_version)),
                )
                .block_task(),
        );

        // Same shape as above: expiry drops `status_fut`, which kills the tree.
        let (response, status_fut) = match tokio::time::timeout(
            INITIALIZE_TIMEOUT,
            futures::future::select(initialize, status_fut),
        )
        .await
        {
            Ok(futures::future::Either::Left((Ok(response), rest))) => (response, rest),
            Ok(futures::future::Either::Left((Err(error), rest))) => {
                // See INITIALIZE_EXIT_GRACE: prefer the exit status if it is
                // about to land, because it carries the stderr that explains it.
                let timer = Box::pin(tokio::time::sleep(INITIALIZE_EXIT_GRACE));
                if let futures::future::Either::Left(((load_error, _child), _)) =
                    futures::future::select(rest, timer).await
                {
                    return Err(load_error.into());
                }
                return Err(anyhow!(error));
            }
            Ok(futures::future::Either::Right(((load_error, _child), _))) => {
                return Err(load_error.into())
            }
            Err(_elapsed) => {
                return Err(timed_out(&agent_id, "initialize", INITIALIZE_TIMEOUT, &debug_log));
            }
        };

        if response.protocol_version < MINIMUM_SUPPORTED_VERSION {
            return Err(anyhow!(LoadError::Unsupported {
                message: "This agent speaks an ACP version Atlas no longer supports.".into(),
            }));
        }

        // From here on the child's death is a live-session event, not a
        // connect failure: every thread is told, so an agent that dies
        // mid-turn surfaces in the conversation instead of going quiet.
        let wait_task = tokio::spawn({
            let sessions = sessions.clone();
            async move {
                let (load_error, _child) = status_fut.await;
                for thread in sessions.all_threads() {
                    thread
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .emit_load_error(load_error.clone());
                }
            }
        });

        let agent_info = response.agent_info;
        let telemetry_id: Arc<str> = agent_info
            .as_ref()
            // The agent's own name when it gives one, else the id we know it by.
            .map(|info| Arc::from(info.name.as_str()))
            .unwrap_or_else(|| Arc::from(agent_id.as_str()));
        let agent_version = agent_info
            .and_then(|info| (!info.version.is_empty()).then(|| Arc::from(info.version.as_str())));

        // Built before the connection moves into the struct, and only when the
        // agent advertised `sessionCapabilities.list`.
        let session_list = AcpSessionList::for_capabilities(
            connection.clone(),
            agent_id.clone(),
            debug_log.clone(),
            &response.agent_capabilities,
        );

        Ok(Self {
            id: agent_id,
            telemetry_id,
            agent_version,
            connection,
            sessions,
            auth_methods: response.auth_methods,
            session_list,
            agent_capabilities: response.agent_capabilities,
            command,
            request_elicitations,
            defaults,
            deadlines: Mutex::new(ConnectionDeadlines::default()),
            thread_events,
            debug_log,
            session_mcp: None,
            _io_task: io_task,
            _stderr_task: stderr_task,
            _wait_task: wait_task,
        })
    }

    /// Hand each session the MCP servers `session_mcp` offers.
    pub fn with_session_mcp(mut self, session_mcp: Option<Arc<dyn SessionMcpServers>>) -> Self {
        self.session_mcp = session_mcp;
        self
    }

    pub fn subscribe_debug_messages(
        &self,
    ) -> (
        Vec<AcpDebugMessage>,
        tokio::sync::mpsc::UnboundedReceiver<AcpDebugMessage>,
    ) {
        self.debug_log.subscribe()
    }

    pub fn agent_capabilities(&self) -> &acp::AgentCapabilities {
        &self.agent_capabilities
    }

    /// Shorten the cancel grace. Test-facing: the default is seconds, and a
    /// test that waits it out proves nothing a shorter one would not. Applies
    /// to turns started after the call.
    pub fn set_deadlines(&self, deadlines: ConnectionDeadlines) {
        *self
            .deadlines
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = deadlines;
    }

    fn deadlines(&self) -> ConnectionDeadlines {
        *self
            .deadlines
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Runs one RPC on the connect/bind path under [`REQUEST_TIMEOUT`].
    ///
    /// Expiry becomes [`LoadError::TimedOut`] with the trailing stderr, so a
    /// `session/new` against a wedged app-server fails with a reason instead
    /// of parking the caller. Never used for `session/prompt`.
    fn request_deadline<'a, T: 'a>(
        &'a self,
        phase: &'static str,
        request: impl Future<Output = Result<T>> + 'a,
    ) -> impl Future<Output = Result<T>> + 'a {
        with_request_deadline(&self.id, phase, &self.debug_log, request)
    }

    fn directories(&self, work_dirs: &[PathBuf]) -> Result<SessionDirectories> {
        SessionDirectories::from_work_dirs(
            work_dirs,
            self.agent_capabilities
                .session_capabilities
                .additional_directories
                .is_some(),
        )
    }

    /// What the host offers the session about to be opened in `cwd`, and the
    /// part of it this agent may be sent — only the transports it advertised.
    fn mcp_offer(
        &self,
        cwd: &std::path::Path,
        session_id: Option<&acp::SessionId>,
    ) -> (session_mcp::SessionMcpOffer, Vec<acp::McpServer>) {
        let offer = session_mcp::offer_for(
            self.session_mcp.as_ref(),
            &SessionMcpRequest {
                agent_id: self.id.clone(),
                http_mcp: self.agent_capabilities.mcp_capabilities.http,
                // A subprocess: Atlas cannot vouch for what it does with the
                // window, so it is never offered the UI tool server.
                ui_control: false,
                // Likewise for the organisation: a binary Atlas does not own
                // is never handed the user's organisation (ADR-0014).
                org_access: false,
                cwd: cwd.to_path_buf(),
                session_id: session_id.cloned(),
            },
        );
        let servers = session_mcp::admissible(offer.servers(), &self.agent_capabilities.mcp_capabilities);
        (offer, servers)
    }

    fn new_thread(
        self: &Arc<Self>,
        session_id: acp::SessionId,
        work_dirs: Vec<PathBuf>,
        title: Option<Arc<str>>,
    ) -> AcpThreadHandle {
        let events = (self.thread_events)(&session_id);
        let mut thread = AcpThread::new(
            session_id,
            self.clone() as Arc<dyn AgentConnection>,
            work_dirs,
            title,
            events,
        );
        thread.set_prompt_capabilities(self.agent_capabilities.prompt_capabilities.clone());
        Arc::new(Mutex::new(thread))
    }

    /// The load/resume path. Ported from `open_or_create_session`
    /// (`acp.rs:1166-1294`).
    ///
    /// Two things here are load-bearing:
    ///
    /// 1. **The session is registered before the RPC resolves.** `session/load`
    ///    replays history as `session/update` notifications *while the call is
    ///    still in flight*; a session registered only on success drops every one
    ///    of them, and the thread comes back empty.
    /// 2. **Concurrent opens share one load.** A second caller joins the
    ///    in-flight attempt and bumps the pending ref count, so ref-counting
    ///    happens in one place and both callers see a fully loaded session.
    async fn open_or_create_session(
        self: Arc<Self>,
        session_id: acp::SessionId,
        work_dirs: Vec<PathBuf>,
        title: Option<Arc<str>>,
        rpc_call: impl FnOnce(
            ConnectionTo<Agent>,
            acp::SessionId,
            SessionDirectories,
            Vec<acp::McpServer>,
        ) -> BoxFuture<'static, Result<SessionConfigResponse>>,
    ) -> Result<AcpThreadHandle> {
        if self.sessions.pending_acquire(&session_id) {
            return Err(anyhow!(
                "a load for session {session_id} is already in flight"
            ));
        }
        if let Some(thread) = self.sessions.acquire(&session_id) {
            return Ok(thread);
        }

        let directories = self.directories(&work_dirs)?;
        // Offered only now that a request will really go out: a session that
        // is already open was acquired above and keeps the servers (and the
        // token) it was opened with. Dropped unbound on any failure below.
        let (mcp_offer, mcp_servers) = self.mcp_offer(&directories.cwd, Some(&session_id));
        let thread = self.new_thread(session_id.clone(), work_dirs, title);

        self.sessions.pending_begin(session_id.clone());
        self.sessions.insert(
            session_id.clone(),
            AcpSession {
                thread: Arc::downgrade(&thread),
                cancel_signal: CancelSignal::new(),
                session_modes: None,
                config_options: None,
                ref_count: 1,
            },
        );

        let response = match rpc_call(self.connection.clone(), session_id.clone(), directories, mcp_servers).await
        {
            Ok(response) => response,
            Err(err) => {
                self.sessions.remove(&session_id);
                self.sessions.pending_take(&session_id);
                return Err(err);
            }
        };

        let ref_count = self.sessions.pending_take(&session_id).unwrap_or(1);

        // `close_session` may have run to completion while the RPC was in
        // flight, taking the sessions entry with it. Handing back a thread with
        // no live session would produce one that silently receives nothing.
        let attached = self.sessions.with_session(&session_id, |session| {
            let modes = session_modes_of(response.modes, response.config_options.as_deref());
            session.session_modes = modes.map(|modes| Arc::new(Mutex::new(modes)));
            session.config_options = response
                .config_options
                .map(|options| ConfigOptions::new(Arc::new(Mutex::new(options))));
            session.ref_count = ref_count;
        });
        if attached.is_none() {
            return Err(anyhow!("session was closed before load completed"));
        }
        mcp_offer.bind(&session_id);

        Ok(thread)
    }
}

struct SessionConfigResponse {
    modes: Option<acp::SessionModeState>,
    config_options: Option<Vec<acp::SessionConfigOption>>,
}

/// The agent process, owned so that dropping it kills the whole tree.
///
/// Ported from the shape of Zed's `util::process::Child`
/// (`crates/util/src/process.rs`). The child is started in a session of its
/// own (`setsid` in `pre_exec`), so its pid is also its process-group id, and
/// the kill is `killpg(SIGKILL)` rather than `kill`: `codex-acp` is `node` →
/// `codex.js app-server` → a native `codex app-server`, and killing only
/// `node` orphaned the rest — which is how app-servers from a launch two days
/// earlier were still running. `kill_on_drop` stays on as the backstop for
/// the direct child, and tokio's orphan reaper still collects its status.
///
/// `setsid` also detaches the child from Atlas's controlling terminal, which
/// is right: the agent is on pipes and must never try to prompt.
struct AgentChild {
    inner: tokio::process::Child,
    /// The process group to signal. `None` where there is no such thing.
    pgid: Option<i32>,
}

impl AgentChild {
    fn spawn(command: &mut tokio::process::Command) -> std::io::Result<Self> {
        #[cfg(unix)]
        {
            // SAFETY: `setsid` is async-signal-safe and touches nothing the
            // parent shares with the child; it either succeeds or, if the
            // child somehow already leads a group, fails harmlessly.
            unsafe {
                command.pre_exec(|| {
                    libc::setsid();
                    Ok(())
                });
            }
        }
        let inner = command.spawn()?;
        #[cfg(unix)]
        let pgid = inner.id().map(|pid| pid as i32);
        #[cfg(not(unix))]
        let pgid = None;
        Ok(Self { inner, pgid })
    }

    /// Kill the child and everything it spawned. Idempotent; safe after the
    /// direct child has been reaped, because its grandchildren keep the group
    /// alive and `killpg` on an empty group is `ESRCH`, not a fault.
    fn kill_tree(&mut self) {
        #[cfg(unix)]
        if let Some(pgid) = self.pgid {
            // SAFETY: plain syscall on a pgid we created; no memory involved.
            unsafe {
                libc::killpg(pgid, libc::SIGKILL);
            }
        }
        // The backstop, and the whole of the non-unix path.
        let _ = self.inner.start_kill();
    }

    async fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        self.inner.wait().await
    }
}

impl Drop for AgentChild {
    fn drop(&mut self) {
        self.kill_tree();
    }
}

/// The error for a hop that ran past its deadline, carrying what the agent was
/// saying on stderr when it went quiet.
fn timed_out(
    agent: &AgentId,
    phase: &str,
    after: Duration,
    debug_log: &AcpDebugLog,
) -> anyhow::Error {
    anyhow!(LoadError::TimedOut {
        agent: Arc::from(agent.as_str()),
        phase: Arc::from(phase),
        after,
        stderr: debug_log
            .trailing_stderr()
            .filter(|stderr| !stderr.is_empty())
            .map(Arc::from),
    })
}

/// Runs a one-shot RPC on the connect/bind path under [`REQUEST_TIMEOUT`].
/// Free-standing so [`AcpSessionList`] can use it without a connection.
pub(crate) async fn with_request_deadline<T>(
    agent: &AgentId,
    phase: &str,
    debug_log: &AcpDebugLog,
    request: impl Future<Output = Result<T>>,
) -> Result<T> {
    match tokio::time::timeout(REQUEST_TIMEOUT, request).await {
        Ok(result) => result,
        Err(_elapsed) => Err(timed_out(agent, phase, REQUEST_TIMEOUT, debug_log)),
    }
}

/// Waits for the child and turns its exit into a `LoadError` carrying the
/// exit stderr. The child is returned so the caller keeps owning it — and
/// so that dropping it, whenever that happens, kills whatever it left behind.
async fn wait_for_exit(
    mut child: AgentChild,
    debug_log: AcpDebugLog,
    stderr_drained: tokio::sync::oneshot::Receiver<()>,
) -> (LoadError, AgentChild) {
    let status = child.wait().await;
    // The stderr reader is a separate task; under load it can still be a poll
    // behind the exit status, and the last line it has not recorded yet is
    // usually the one that says why the agent died. Wait for its EOF signal,
    // rather than merely sleeping, while bounding the case where a descendant
    // inherited the pipe and keeps it open.
    let _ = tokio::time::timeout(STDERR_DRAIN_GRACE, stderr_drained).await;
    let error = LoadError::Exited {
        status: status.ok().and_then(|status| status.code()),
        stderr: debug_log
            .exit_stderr()
            .map(Arc::from)
            .unwrap_or_else(|| Arc::from("")),
    };
    (error, child)
}

/// Builds the client with the full agent→client handler set.
///
/// The registered closures ENQUEUE AND RETURN — they never await handler work.
/// The RPC crate dispatches inbound messages serially and awaits each
/// registered closure inline, so anything a closure waits on blocks every
/// message behind it: Zed's dispatch queue is not a GPUI artifact but the
/// mechanism that keeps an open permission prompt (or a running command's
/// `wait_for_exit`) from freezing the whole inbound side of the connection.
/// See the module docs on [`handlers`] and #28.
fn connect_client_future(
    name: &'static str,
    transport: impl agent_client_protocol::ConnectTo<Client> + 'static,
    ctx: ClientContext,
    connection_tx: futures::channel::oneshot::Sender<ConnectionTo<Agent>>,
) -> impl std::future::Future<Output = std::result::Result<(), acp::Error>> {
    let dispatch_tx = handlers::spawn_dispatch_queue(ctx);
    macro_rules! on_request {
        ($handler:path) => {{
            let dispatch_tx = dispatch_tx.clone();
            async move |req, responder, _connection| {
                handlers::enqueue_request(&dispatch_tx, req, responder, $handler);
                Ok(())
            }
        }};
    }
    macro_rules! on_notification {
        ($handler:path) => {{
            let dispatch_tx = dispatch_tx.clone();
            async move |notif, _connection| {
                handlers::enqueue_notification(&dispatch_tx, notif, $handler);
                Ok(())
            }
        }};
    }

    Client
        .builder()
        .name(name)
        .on_receive_request(
            on_request!(handlers::handle_request_permission),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            on_request!(handlers::handle_write_text_file),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            on_request!(handlers::handle_read_text_file),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            on_request!(handlers::handle_create_terminal),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            on_request!(handlers::handle_kill_terminal),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            on_request!(handlers::handle_release_terminal),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            on_request!(handlers::handle_terminal_output),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            on_request!(handlers::handle_wait_for_terminal_exit),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            on_request!(handlers::handle_create_elicitation),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_notification(
            on_notification!(handlers::handle_session_notification),
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_notification(
            on_notification!(handlers::handle_complete_elicitation),
            agent_client_protocol::on_receive_notification!(),
        )
        .connect_with(transport, move |connection: ConnectionTo<Agent>| async move {
            if connection_tx.send(connection).is_err() {
                tracing::error!("failed to send ACP connection handle — receiver was dropped");
            }
            // Hold the connection open until the transport closes.
            futures::future::pending::<std::result::Result<(), acp::Error>>().await
        })
}

/// Ported from `client_capabilities_for_agent` (`acp.rs:767-795`).
///
/// Only what we actually serve is advertised — an agent that is told we can do
/// something we cannot will call it and get an error mid-turn.
pub fn client_capabilities_for_agent(_agent_id: &AgentId) -> acp::ClientCapabilities {
    let meta = acp::Meta::from_iter([
        ("terminal_output".into(), true.into()),
        ("terminal-auth".into(), true.into()),
    ]);

    acp::ClientCapabilities::new()
        .fs(acp::FileSystemCapabilities::new()
            .read_text_file(true)
            .write_text_file(true))
        .terminal(true)
        .auth(acp::AuthCapabilities::new().terminal(true))
        .session(
            acp::ClientSessionCapabilities::new().config_options(
                acp::SessionConfigOptionsCapabilities::new()
                    .boolean(acp::BooleanConfigOptionCapabilities::new()),
            ),
        )
        .elicitation(
            acp::ElicitationCapabilities::new()
                .form(acp::ElicitationFormCapabilities::new())
                .url(acp::ElicitationUrlCapabilities::new()),
        )
        .meta(meta)
}

/// Ported from `map_acp_error` (`acp.rs:2074-2086`).
///
/// `AuthRequired` has to survive as a typed error: the host matches on it to
/// route the user into sign-in, and a stringified version would just be another
/// failed turn.
pub fn map_acp_error(err: acp::Error) -> anyhow::Error {
    if err.code == acp::ErrorCode::AuthRequired {
        let mut error = AuthRequired::new();
        if err.message != acp::ErrorCode::AuthRequired.to_string() {
            error = error.with_description(err.message);
        }
        anyhow!(error)
    } else {
        anyhow!(err)
    }
}

/// The `data` the TypeScript ACP SDK attaches to an `InternalError`: a thrown
/// `Error`'s message, verbatim. Shared by `prompt` and `authenticate`, which
/// both want the words rather than `Internal error: { "details": … }`.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ErrorDetails {
    details: Box<str>,
}

/// What a rejected `authenticate` means for the sign-in that issued it.
///
/// A terminal method IS the sign-in: the host ran the agent's login CLI and
/// the agent re-reads the credentials on its next `session/new`. Several
/// adapters therefore do not implement `authenticate` for those methods at
/// all — claude-agent-acp throws `"Method not implemented."` (wrapped by its
/// SDK as `-32603` with `details`) for every id but its gateway ones. That
/// rejection is not a failed login, and treating it as one parked every
/// Claude Code user on an error after a login that had worked.
///
/// So for a terminal method an unimplemented `authenticate` is `Ok`: the
/// rebind that follows is the real check. For an `agent` method the RPC is
/// the whole login, so "not implemented" is a real failure — reported in the
/// agent's words rather than the SDK's envelope.
pub fn authenticate_outcome(err: acp::Error, method_is_terminal: bool) -> Result<()> {
    if err.code == acp::ErrorCode::AuthRequired {
        return Err(map_acp_error(err));
    }
    let details = match err.code {
        acp::ErrorCode::MethodNotFound => None,
        acp::ErrorCode::InternalError => match &err.data {
            Some(data) => match serde_json::from_value::<ErrorDetails>(data.clone()) {
                Ok(ErrorDetails { details }) => Some(details),
                Err(_) => return Err(anyhow!(err)),
            },
            None => return Err(anyhow!(err)),
        },
        _ => return Err(anyhow!(err)),
    };
    let unimplemented = details
        .as_deref()
        .is_none_or(|d| d.to_ascii_lowercase().contains("not implemented"));
    match (unimplemented, method_is_terminal, details) {
        (true, true, _) => {
            tracing::debug!("agent does not implement authenticate for a terminal method; the login CLI already ran");
            Ok(())
        }
        (true, false, _) => Err(anyhow!(
            "the agent does not support signing in this way (authenticate is not implemented for this method)"
        )),
        (false, _, Some(details)) => Err(anyhow!(details)),
        (false, _, None) => Err(anyhow!(err)),
    }
}

impl Drop for AcpConnection {
    fn drop(&mut self) {
        // Zed kills the child here (`acp.rs:1528-1534`). The child is owned by
        // the wait task, so aborting that task drops it — and `AgentChild`'s
        // `Drop` kills its process group, with `kill_on_drop` as the backstop.
        // Without this the agent outlives the connection that started it:
        // nothing else holds a handle to kill it, and it sits there holding
        // its model subscription until the app exits.
        self._wait_task.abort();
        self._io_task.abort();
        self._stderr_task.abort();
    }
}

impl AgentConnection for AcpConnection {
    fn agent_id(&self) -> AgentId {
        self.id.clone()
    }

    fn telemetry_id(&self) -> Arc<str> {
        self.telemetry_id.clone()
    }

    fn agent_version(&self) -> Option<Arc<str>> {
        self.agent_version.clone()
    }

    fn new_session(
        self: Arc<Self>,
        work_dirs: Vec<PathBuf>,
    ) -> BoxFuture<'static, Result<AcpThreadHandle>> {
        async move {
            let directories = self.directories(&work_dirs)?;
            // Offered before the id exists; bound to it once the agent answers,
            // and released (dropped unbound) if it never does.
            let (mcp_offer, mcp_servers) = self.mcp_offer(&directories.cwd, None);
            let response = self
                .request_deadline("session/new", async {
                    self.connection
                        .send_request(directories.into_new_session_request(mcp_servers))
                        .block_task()
                        .await
                        .map_err(map_acp_error)
                })
                .await?;

            let session_id = response.session_id.clone();
            mcp_offer.bind(&session_id);
            let thread = self.new_thread(session_id.clone(), work_dirs, None);
            let modes = session_modes_of(response.modes, response.config_options.as_deref());

            self.sessions.insert(
                session_id.clone(),
                AcpSession {
                    thread: Arc::downgrade(&thread),
                    cancel_signal: CancelSignal::new(),
                    session_modes: modes.map(|modes| Arc::new(Mutex::new(modes))),
                    config_options: response
                        .config_options
                        .map(|options| ConfigOptions::new(Arc::new(Mutex::new(options)))),
                    ref_count: 1,
                },
            );

            self.apply_default_mode(&session_id).await;

            Ok(thread)
        }
        .boxed()
    }

    fn supports_load_session(&self) -> bool {
        // A top-level capability in this schema, unlike the other session
        // capabilities which are nested.
        self.agent_capabilities.load_session
    }

    fn supports_http_mcp(&self) -> bool {
        self.agent_capabilities.mcp_capabilities.http
    }

    fn load_session(
        self: Arc<Self>,
        session_id: acp::SessionId,
        work_dirs: Vec<PathBuf>,
        title: Option<Arc<str>>,
    ) -> BoxFuture<'static, Result<AcpThreadHandle>> {
        async move {
            let this = self.clone();
            self.request_deadline("session/load", async move {
                this.open_or_create_session(session_id, work_dirs, title, |conn, id, dirs, mcp_servers| {
                    async move {
                        let mut request = acp::LoadSessionRequest::new(id, dirs.cwd);
                        request.mcp_servers = mcp_servers;
                        if !dirs.additional_directories.is_empty() {
                            request.additional_directories = dirs.additional_directories;
                        }
                        let response = conn
                            .send_request(request)
                            .block_task()
                            .await
                            .map_err(map_acp_error)?;
                        Ok(SessionConfigResponse {
                            modes: response.modes,
                            config_options: response.config_options,
                        })
                    }
                    .boxed()
                })
                .await
            })
            .await
        }
        .boxed()
    }

    fn supports_resume_session(&self) -> bool {
        self.agent_capabilities.session_capabilities.resume.is_some()
    }

    fn resume_session(
        self: Arc<Self>,
        session_id: acp::SessionId,
        work_dirs: Vec<PathBuf>,
        title: Option<Arc<str>>,
    ) -> BoxFuture<'static, Result<AcpThreadHandle>> {
        async move {
            let this = self.clone();
            self.request_deadline("session/resume", async move {
                this.open_or_create_session(session_id, work_dirs, title, |conn, id, dirs, mcp_servers| {
                    async move {
                        let mut request = acp::ResumeSessionRequest::new(id, dirs.cwd);
                        request.mcp_servers = mcp_servers;
                        if !dirs.additional_directories.is_empty() {
                            request.additional_directories = dirs.additional_directories;
                        }
                        let response = conn
                            .send_request(request)
                            .block_task()
                            .await
                            .map_err(map_acp_error)?;
                        Ok(SessionConfigResponse {
                            modes: response.modes,
                            config_options: response.config_options,
                        })
                    }
                    .boxed()
                })
                .await
            })
            .await
        }
        .boxed()
    }

    fn session_list(&self) -> Option<Arc<dyn atlas_acp_thread::AgentSessionList>> {
        self.session_list
            .clone()
            .map(|list| list as Arc<dyn atlas_acp_thread::AgentSessionList>)
    }

    fn supports_close_session(&self) -> bool {
        self.agent_capabilities.session_capabilities.close.is_some()
    }

    /// Ported from `close_session` (`acp.rs:1817-1881`).
    ///
    /// Ref-counted, and the pending table is consulted first: during a load the
    /// pending entry is the source of truth for how many handles exist, because
    /// the `sessions` entry was pre-registered to catch history replay and would
    /// otherwise be counted twice.
    fn close_session(
        self: Arc<Self>,
        session_id: acp::SessionId,
    ) -> BoxFuture<'static, Result<()>> {
        async move {
            if !self.supports_close_session() {
                return Err(anyhow!(LoadError::Other(
                    "Closing sessions is not supported by this agent.".into()
                )));
            }

            match self.sessions.pending_release(&session_id) {
                Some(0) => {
                    self.sessions.remove(&session_id);
                }
                // Another handle is still waiting on the load.
                Some(_) => return Ok(()),
                None => match self.sessions.release(&session_id) {
                    Some(0) => {}
                    Some(_) => return Ok(()),
                    None => return Ok(()),
                },
            }

            self.connection
                .send_request(acp::CloseSessionRequest::new(session_id))
                .block_task()
                .await?;
            Ok(())
        }
        .boxed()
    }

    fn supports_session_additional_directories(&self) -> bool {
        self.agent_capabilities
            .session_capabilities
            .additional_directories
            .is_some()
    }

    fn auth_methods(&self) -> &[acp::AuthMethod] {
        &self.auth_methods
    }

    /// The login command to run for an auth method, if the agent named one.
    ///
    /// Both of Zed's shapes — see [`terminal_auth_command_for`].
    fn terminal_auth_command(
        &self,
        method_id: &acp::AuthMethodId,
    ) -> Option<BoxFuture<'static, Result<TerminalAuthCommand>>> {
        let method = self
            .auth_methods
            .iter()
            .find(|method| method.id() == method_id)?;
        let command = terminal_auth_command_for(&self.id, method_id, method, &self.command)?;
        Some(async move { Ok(command) }.boxed())
    }

    fn authenticate(&self, method: acp::AuthMethodId) -> BoxFuture<'static, Result<()>> {
        let conn = self.connection.clone();
        let agent_id = self.id.clone();
        let debug_log = self.debug_log.clone();
        // Both of Zed's terminal shapes count — see `terminal_auth_command_for`.
        let method_is_terminal = self
            .auth_methods
            .iter()
            .find(|m| m.id() == &method)
            .is_some_and(|m| {
                matches!(m, acp::AuthMethod::Terminal(_))
                    || meta_terminal_auth_command(&self.id, &method, m).is_some()
            });
        async move {
            with_request_deadline(&agent_id, "authenticate", &debug_log, async {
                match conn
                    .send_request(acp::AuthenticateRequest::new(method))
                    .block_task()
                    .await
                {
                    Ok(_) => Ok(()),
                    Err(err) => authenticate_outcome(err, method_is_terminal),
                }
            })
            .await
        }
        .boxed()
    }

    fn supports_logout(&self) -> bool {
        self.agent_capabilities.auth.logout.is_some()
    }

    fn logout(&self) -> BoxFuture<'static, Result<()>> {
        let conn = self.connection.clone();
        async move {
            conn.send_request(acp::LogoutRequest::new())
                .block_task()
                .await?;
            Ok(())
        }
        .boxed()
    }

    /// Ported from `prompt` (`acp.rs:1952-2010`).
    fn prompt(
        &self,
        params: acp::PromptRequest,
    ) -> BoxFuture<'static, Result<acp::PromptResponse>> {
        let conn = self.connection.clone();
        let sessions = self.sessions.clone();
        let session_id = params.session_id.clone();
        // Taken before the request goes out, so a cancel that lands while we
        // are still sending is seen rather than missed. The probe is this
        // turn's own view of it: whether a cancel fired while THIS turn was
        // running, which is what decides an abort-shaped error's fate below.
        let cancel_waiter =
            sessions.with_session(&session_id, |session| session.cancel_signal.waiter());
        let cancel_probe = cancel_waiter.as_ref().map(CancelWaiter::probe);
        let cancel_grace = self.deadlines().cancel_grace;

        async move {
            let result = match cancel_waiter {
                Some(waiter) => {
                    let request = conn.send_request(params).block_task();
                    futures::pin_mut!(request);
                    let deadline = async move {
                        waiter.cancelled().await;
                        tokio::time::sleep(cancel_grace).await;
                    };
                    futures::pin_mut!(deadline);

                    match futures::future::select(request, deadline).await {
                        futures::future::Either::Left((result, _)) => result,
                        futures::future::Either::Right(((), _)) => {
                            // The agent was told to stop and did not answer, so
                            // answer for it.
                            //
                            // Dropping the request future is not merely giving
                            // up locally: the SDK's `SentRequestCancellation`
                            // has a `Drop` that sends a cancellation for the
                            // abandoned request id (`jsonrpc.rs:4742`), so the
                            // agent is told again, through the channel it
                            // ignored the first time. A reply that arrives
                            // after this has no waiter, which is what
                            // "cancelled" means.
                            tracing::warn!(
                                session = %session_id,
                                grace_ms = cancel_grace.as_millis(),
                                "agent did not acknowledge a cancel; resolving the turn locally"
                            );
                            return Ok(acp::PromptResponse::new(acp::StopReason::Cancelled));
                        }
                    }
                }
                // No session to hang a clock on. The request is still the right
                // thing to await; an unknown session id fails on its own.
                None => conn.send_request(params).block_task().await,
            };

            // Read, not consumed: this turn's own answer, so it cannot be
            // spent by a sibling turn or inherited by a later one.
            let suppress_abort_err = cancel_probe.is_some_and(|probe| probe.fired());

            let err = match result {
                Ok(response) => return Ok(response),
                Err(err) => err,
            };

            if err.code == acp::ErrorCode::AuthRequired {
                return Err(map_acp_error(err));
            }
            if err.code != acp::ErrorCode::InternalError {
                return Err(anyhow!(err));
            }
            let Some(data) = &err.data else {
                return Err(anyhow!(err));
            };

            // Some agents report a cancelled turn as an internal error whose
            // details say the operation was aborted. When we are the ones who
            // cancelled, that is a normal stop, not a failure to show the user.
            match serde_json::from_value::<ErrorDetails>(data.clone()) {
                Ok(ErrorDetails { details }) => {
                    if suppress_abort_err
                        && (details.contains("This operation was aborted")
                            || details.contains("The user aborted a request"))
                    {
                        Ok(acp::PromptResponse::new(acp::StopReason::Cancelled))
                    } else {
                        Err(anyhow!(details))
                    }
                }
                Err(_) => Err(anyhow!(err)),
            }
        }
        .boxed()
    }

    fn cancel(&self, session_id: &acp::SessionId) {
        let signal = self
            .sessions
            .with_session(session_id, |session| session.cancel_signal.clone());
        let _ = self
            .connection
            .send_notification(acp::CancelNotification::new(session_id.clone()));
        // After the notification, not before: a healthy agent should get the
        // whole grace period to answer it, and starting the clock first would
        // spend part of that on our own write.
        if let Some(signal) = signal {
            signal.fire();
        }
    }

    fn request_elicitations(&self) -> Option<ElicitationStoreHandle> {
        Some(self.request_elicitations.clone())
    }

    fn session_modes(
        &self,
        session_id: &acp::SessionId,
    ) -> Option<Arc<dyn AgentSessionModes>> {
        let modes = self
            .sessions
            .with_session(session_id, |session| session.session_modes.clone())??;
        Some(Arc::new(AcpSessionModes {
            connection: self.connection.clone(),
            session_id: session_id.clone(),
            modes,
        }))
    }

    /// An external agent has a model picker exactly when it advertises a
    /// `category: "model"` select among its session config options — see
    /// [`model_select_of`]. Nothing about which agent this is enters the
    /// decision (ADR-0002).
    fn model_selector(&self, session_id: &acp::SessionId) -> Option<Arc<dyn AgentModelSelector>> {
        let options = self
            .sessions
            .with_session(session_id, |session| session.config_options.clone())??;
        model_select_of(
            &options
                .config_options
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        )?;
        Some(Arc::new(AcpModelSelector {
            connection: self.connection.clone(),
            session_id: session_id.clone(),
            options,
        }))
    }

    fn session_config_options(
        &self,
        session_id: &acp::SessionId,
    ) -> Option<Arc<dyn AgentSessionConfigOptions>> {
        let options = self
            .sessions
            .with_session(session_id, |session| session.config_options.clone())??;
        Some(Arc::new(AcpSessionConfigOptions {
            connection: self.connection.clone(),
            session_id: session_id.clone(),
            options,
        }))
    }

    fn into_any(self: Arc<Self>) -> Arc<dyn Any + Send + Sync> {
        self
    }
}

impl AcpConnection {
    /// Applies the configured default mode, rolling back the local view if the
    /// agent rejects it — otherwise the UI shows a mode the agent is not in.
    async fn apply_default_mode(&self, session_id: &acp::SessionId) {
        let Some(default_mode) = self.defaults.mode.clone() else {
            return;
        };
        let Some(Some(modes)) = self
            .sessions
            .with_session(session_id, |session| session.session_modes.clone())
        else {
            return;
        };

        let initial = {
            let mut modes = modes.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if !modes
                .available_modes
                .iter()
                .any(|mode| mode.id == default_mode)
            {
                return;
            }
            let initial = modes.current_mode_id.clone();
            modes.current_mode_id = default_mode.clone();
            initial
        };

        // On the `session/new` path, so it gets the same deadline: a wedged
        // agent that answered `session/new` and then went quiet must not park
        // the bind here instead. Expiry is just "the mode did not take".
        let set_mode = self.connection.send_request(acp::SetSessionModeRequest::new(
            session_id.clone(),
            default_mode,
        ));
        if self
            .request_deadline("session/set_mode", async {
                set_mode.block_task().await.map_err(map_acp_error)
            })
            .await
            .is_err()
        {
            modes.lock().unwrap_or_else(std::sync::PoisonError::into_inner).current_mode_id = initial;
        }
    }
}

struct AcpSessionModes {
    connection: ConnectionTo<Agent>,
    session_id: acp::SessionId,
    modes: Arc<Mutex<acp::SessionModeState>>,
}

impl AgentSessionModes for AcpSessionModes {
    fn current_mode(&self) -> acp::SessionModeId {
        self.modes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .current_mode_id
            .clone()
    }

    fn all_modes(&self) -> Vec<acp::SessionMode> {
        self.modes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .available_modes
            .clone()
    }

    fn set_mode(&self, mode: acp::SessionModeId) -> BoxFuture<'static, Result<()>> {
        let conn = self.connection.clone();
        let session_id = self.session_id.clone();
        let modes = self.modes.clone();
        let previous = self.current_mode();
        modes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .current_mode_id = mode.clone();

        async move {
            match conn
                .send_request(acp::SetSessionModeRequest::new(session_id, mode))
                .block_task()
                .await
            {
                Ok(_) => Ok(()),
                Err(err) => {
                    modes
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .current_mode_id = previous;
                    Err(anyhow!(err))
                }
            }
        }
        .boxed()
    }
}

/// The session's modes, from whichever of the two wires the agent used.
///
/// ACP carries modes on a dedicated `modes` field of the `session/new` /
/// `session/load` / `session/resume` response, and that is what Claude and
/// Codex send. OpenCode sends none: its modes arrive ONLY as a `category:
/// "mode"` select among the session config options, the same way every agent
/// advertises its model picker. The two wires describe one setting, and the
/// composer's mode pill reads the `modes` state, so an agent that used the
/// other wire had a mode picker nowhere — the frontend hides the `mode` select
/// from the generic knobs precisely because the pill is meant to own it.
///
/// The `modes` field wins when present. The select is consulted only in its
/// absence, so an agent that sends both keeps its `modes` state untouched and
/// nothing but the `mode` category is ever lifted into the pill.
fn session_modes_of(
    modes: Option<acp::SessionModeState>,
    config_options: Option<&[acp::SessionConfigOption]>,
) -> Option<acp::SessionModeState> {
    modes.or_else(|| config_options.and_then(mode_select_of))
}

/// The `category: "mode"` select of a config-option list as a
/// [`acp::SessionModeState`]: each choice is a mode, the current value is the
/// current mode. Groups flatten, as in [`model_select_of`]. `None` when the
/// agent expresses no such select, or it is not a select, or it has no choices.
pub(crate) fn mode_select_of(
    options: &[acp::SessionConfigOption],
) -> Option<acp::SessionModeState> {
    options.iter().find_map(|option| {
        if !matches!(
            option.category,
            Some(acp::SessionConfigOptionCategory::Mode)
        ) {
            return None;
        }
        let acp::SessionConfigKind::Select(select) = &option.kind else {
            return None;
        };
        let choices: Vec<&acp::SessionConfigSelectOption> = match &select.options {
            acp::SessionConfigSelectOptions::Ungrouped(choices) => choices.iter().collect(),
            acp::SessionConfigSelectOptions::Grouped(groups) => {
                groups.iter().flat_map(|group| group.options.iter()).collect()
            }
            _ => return None,
        };
        if choices.is_empty() {
            return None;
        }
        let available_modes = choices
            .into_iter()
            .map(|choice| {
                let name = if choice.name.is_empty() {
                    choice.value.0.as_ref().to_string()
                } else {
                    choice.name.clone()
                };
                acp::SessionMode::new(acp::SessionModeId::new(choice.value.0.clone()), name)
                    .description(choice.description.clone())
            })
            .collect();
        Some(acp::SessionModeState::new(
            acp::SessionModeId::new(select.current_value.0.clone()),
            available_modes,
        ))
    })
}

/// The model picker an agent advertises, projected out of its config options.
///
/// ACP has no `models` field on a session: an agent that lets the client choose
/// a model says so with a `category: "model"` SELECT among its session config
/// options (schema 1.5.0, `SessionConfigOptionCategory::Model`). Atlas gives
/// that one option its own composer pill instead of rendering it as a generic
/// knob, which is why it is lifted out here into the port's model-selector
/// shape rather than left to `session_config_options`.
///
/// The old stack normalised this during `session/new`; the port dropped that
/// step, and with the frontend still filtering `category: "model"` out of the
/// generic knobs as "owned elsewhere", model selection disappeared from both
/// surfaces at once.
struct ModelSelect {
    config_id: acp::SessionConfigId,
    current: acp::SessionConfigValueId,
    models: Vec<AgentModelInfo>,
}

fn model_select_of(options: &[acp::SessionConfigOption]) -> Option<ModelSelect> {
    options.iter().find_map(|option| {
        if !matches!(
            option.category,
            Some(acp::SessionConfigOptionCategory::Model)
        ) {
            return None;
        }
        let acp::SessionConfigKind::Select(select) = &option.kind else {
            return None;
        };
        // Groups flatten, exactly as `build_snapshot` flattens a grouped
        // `AgentModelList`: the composer's picker is one list, and a nested
        // menu would be a new visual pattern.
        let choices: Vec<&acp::SessionConfigSelectOption> = match &select.options {
            acp::SessionConfigSelectOptions::Ungrouped(choices) => choices.iter().collect(),
            acp::SessionConfigSelectOptions::Grouped(groups) => {
                groups.iter().flat_map(|group| group.options.iter()).collect()
            }
            // `#[non_exhaustive]`: a shape this build does not know is not a
            // list we can render.
            _ => return None,
        };
        // A select with nothing to pick is a dead control.
        if choices.is_empty() {
            return None;
        }
        Some(ModelSelect {
            config_id: option.id.clone(),
            current: select.current_value.clone(),
            models: choices
                .into_iter()
                .map(|choice| AgentModelInfo {
                    id: AgentModelId::new(choice.value.0.as_ref()),
                    // An unnamed choice shows its id rather than a blank row —
                    // the same fallback the frontend's parser makes, so a list
                    // reads identically whichever path filled it.
                    name: if choice.name.is_empty() {
                        choice.value.0.as_ref().into()
                    } else {
                        choice.name.as_str().into()
                    },
                    description: choice.description.as_deref().map(Into::into),
                    icon: None,
                    is_latest: false,
                    cost: None,
                    disabled: None,
                })
                .collect(),
        })
    })
}

/// Model selection over the config-option wire. Selecting a model is
/// `session/set_config_option` on the model option's id — there is no separate
/// `session/set_model` in this protocol version.
struct AcpModelSelector {
    connection: ConnectionTo<Agent>,
    session_id: acp::SessionId,
    options: ConfigOptions,
}

impl AcpModelSelector {
    fn select(&self) -> Result<ModelSelect> {
        model_select_of(
            &self
                .options
                .config_options
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        )
        .ok_or_else(|| anyhow!("this agent no longer advertises a model selector"))
    }
}

impl AgentModelSelector for AcpModelSelector {
    fn list_models(&self) -> BoxFuture<'static, Result<AgentModelList>> {
        // Already in memory — the agent advertised the list up front and keeps
        // it current with `config_options_updated`, so this needs no round trip.
        let models = self.select().map(|select| AgentModelList::Flat(select.models));
        async move { models }.boxed()
    }

    fn selected_model(&self) -> BoxFuture<'static, Result<AgentModelInfo>> {
        let selected = self.select().and_then(|select| {
            select
                .models
                .into_iter()
                .find(|model| model.id.as_str() == select.current.0.as_ref())
                .ok_or_else(|| anyhow!("the agent's selected model is not in the list it offers"))
        });
        async move { selected }.boxed()
    }

    fn select_model(&self, model_id: AgentModelId) -> BoxFuture<'static, Result<()>> {
        let conn = self.connection.clone();
        let session_id = self.session_id.clone();
        let options = self.options.clone();
        let config_id = self.select().map(|select| select.config_id);

        async move {
            let response = conn
                .send_request(acp::SetSessionConfigOptionRequest::new(
                    session_id,
                    config_id?,
                    acp::SessionConfigOptionValue::ValueId {
                        value: acp::SessionConfigValueId::new(model_id.as_str()),
                    },
                ))
                .block_task()
                .await
                .map_err(map_acp_error)?;

            // The response carries the authoritative list, so the local view
            // does not have to guess that the pick took.
            *options
                .config_options
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = response.config_options;
            options.notify();
            Ok(())
        }
        .boxed()
    }

    fn watch(&self) -> Option<tokio::sync::watch::Receiver<()>> {
        Some(self.options.subscribe())
    }
}

struct AcpSessionConfigOptions {
    connection: ConnectionTo<Agent>,
    session_id: acp::SessionId,
    options: ConfigOptions,
}

impl AgentSessionConfigOptions for AcpSessionConfigOptions {
    fn config_options(&self) -> Vec<acp::SessionConfigOption> {
        self.options
            .config_options
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn set_config_option(
        &self,
        config_id: acp::SessionConfigId,
        value: acp::SessionConfigOptionValue,
    ) -> BoxFuture<'static, Result<Vec<acp::SessionConfigOption>>> {
        let conn = self.connection.clone();
        let session_id = self.session_id.clone();
        let options = self.options.clone();

        async move {
            let response = conn
                .send_request(acp::SetSessionConfigOptionRequest::new(
                    session_id, config_id, value,
                ))
                .block_task()
                .await
                .map_err(map_acp_error)?;

            *options
                .config_options
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = response.config_options.clone();
            options.notify();
            Ok(response.config_options)
        }
        .boxed()
    }

    fn watch(&self) -> Option<tokio::sync::watch::Receiver<()>> {
        Some(self.options.subscribe())
    }
}


/// The login command for an auth method, from whichever of the two shapes the
/// agent used. Ported from Zed's `terminal_auth_task` (`acp.rs:1887-1921`).
///
/// A typed `Terminal` method first, as Zed orders it: it names only the
/// ARGUMENTS that sign this agent in, because the program is the agent's own.
/// Atlas re-runs the binary it already spawned — same path, launch args then
/// auth args, and the SAME ENVIRONMENT with the method's own vars layered on
/// top. That env matters: it carries the proxy configuration and the spawn
/// quirks (`env_quirks`, which deliberately blanks `ANTHROPIC_API_KEY`), so a
/// login subprocess started without it reaches the network differently from
/// the agent it is signing in.
///
/// `_meta["terminal-auth"]` is the fallback — the pre-stabilization shape. It
/// names a whole command, which need not be the binary Atlas launched, so it
/// brings its own environment and nothing is layered under it.
///
/// `None` means the agent never said how to sign in. The honest answer is to
/// report that, not to guess: guessing is what the deleted `BUILTIN_AGENTS`
/// login table did, and it could only ever know a hardcoded list.
fn terminal_auth_command_for(
    agent_id: &AgentId,
    method_id: &acp::AuthMethodId,
    method: &acp::AuthMethod,
    own_command: &AgentServerCommand,
) -> Option<TerminalAuthCommand> {
    if let acp::AuthMethod::Terminal(terminal) = method {
        let mut args = own_command.args.clone();
        args.extend(terminal.args.iter().cloned());
        // Sorted: the source is a `HashMap`, and an unsorted list means the
        // command Atlas shows and copies is spelled differently on every call.
        let mut declared: Vec<(String, String)> = terminal
            .env
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        declared.sort();
        let mut env: HashMap<String, String> = own_command.env.clone().unwrap_or_default();
        env.extend(declared.iter().cloned());
        return Some(build_terminal_auth_command(
            terminal_auth_id(agent_id, method_id),
            method.name().to_string(),
            own_command.path.to_string_lossy().into_owned(),
            args,
            env.into_iter().collect(),
            declared,
        ));
    }
    meta_terminal_auth_command(agent_id, method_id, method)
}

/// Scopes a run to one agent+method, so two agents signing in at once cannot be
/// confused for one another.
fn terminal_auth_id(agent_id: &AgentId, method_id: &acp::AuthMethodId) -> String {
    format!("external-agent-{}-{}-login", agent_id.as_str(), method_id.0)
}

/// `_meta["terminal-auth"]` — the pre-stabilization way an adapter says how to
/// run its login CLI. Ported from Zed's `meta_terminal_auth_task`
/// (`acp.rs:1555-1586`).
fn meta_terminal_auth_command(
    agent_id: &AgentId,
    method_id: &acp::AuthMethodId,
    method: &acp::AuthMethod,
) -> Option<TerminalAuthCommand> {
    #[derive(serde::Deserialize)]
    struct MetaTerminalAuth {
        label: String,
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: HashMap<String, String>,
    }

    let meta = match method {
        acp::AuthMethod::EnvVar(env_var) => env_var.meta.as_ref(),
        acp::AuthMethod::Terminal(terminal) => terminal.meta.as_ref(),
        acp::AuthMethod::Agent(agent) => agent.meta.as_ref(),
        _ => None,
    }?;
    let terminal_auth =
        serde_json::from_value::<MetaTerminalAuth>(meta.get("terminal-auth")?.clone()).ok()?;

    // The `_meta` spec names its own environment and nothing is layered under
    // it, so what it declared IS what the login runs with.
    let mut env: Vec<(String, String)> = terminal_auth.env.into_iter().collect();
    env.sort();
    Some(build_terminal_auth_command(
        terminal_auth_id(agent_id, method_id),
        terminal_auth.label,
        terminal_auth.command,
        terminal_auth.args,
        env.clone(),
        env,
    ))
}

#[cfg(test)]
mod terminal_auth_tests {
    use super::*;

    fn method(meta: serde_json::Value) -> acp::AuthMethod {
        serde_json::from_value(serde_json::json!({
            "id": "claude-login",
            "name": "Subscription",
            "_meta": meta,
        }))
        .expect("an auth method this schema understands")
    }

    /// The shape claude-agent-acp actually ships: a fully resolved command the
    /// host can exec as-is. This is what replaces the deleted builtin login
    /// table — the agent names its own binary, so no hardcoded list is needed.
    #[test]
    fn a_meta_terminal_auth_spec_becomes_a_runnable_command() {
        let m = method(serde_json::json!({
            "terminal-auth": {
                "label": "Sign in",
                "command": "/usr/local/bin/node",
                "args": ["cli.js", "auth", "login"],
                "env": { "NO_COLOR": "1" },
            }
        }));
        let cmd = meta_terminal_auth_command(
            &AgentId::new("claude-code"),
            &acp::AuthMethodId::new("claude-login"),
            &m,
        )
        .expect("a runnable command");
        assert_eq!(cmd.command, "/usr/local/bin/node");
        assert_eq!(cmd.args, ["cli.js", "auth", "login"]);
        assert_eq!(cmd.label, "Sign in");
        assert_eq!(cmd.env, [("NO_COLOR".to_string(), "1".to_string())]);
        // The id scopes the run to this agent+method, so two agents signing in
        // at once cannot be confused for one another.
        assert_eq!(cmd.id, "external-agent-claude-code-claude-login-login");
    }

    /// `args` and `env` are optional; a spec with only a command still runs.
    #[test]
    fn a_bare_command_needs_no_args_or_env() {
        let m = method(serde_json::json!({
            "terminal-auth": { "label": "Log in", "command": "cursor-agent" }
        }));
        let cmd = meta_terminal_auth_command(
            &AgentId::new("cursor"),
            &acp::AuthMethodId::new("claude-login"),
            &m,
        )
        .expect("a runnable command");
        assert!(cmd.args.is_empty());
        assert!(cmd.env.is_empty());
    }

    fn own_command() -> AgentServerCommand {
        AgentServerCommand {
            path: PathBuf::from("/usr/local/bin/some-agent"),
            args: vec!["acp".to_string()],
            env: None,
        }
    }

    /// Zed's other branch (`acp.rs:1897-1918`): a typed `Terminal` method says
    /// only WHICH ARGUMENTS sign this agent in. The binary is the agent's own,
    /// so the host runs the same program it already launched — the agent never
    /// has to know or repeat its own path.
    #[test]
    fn a_typed_terminal_method_runs_the_agents_own_binary() {
        let m: acp::AuthMethod = serde_json::from_value(serde_json::json!({
            "id": "login",
            "name": "Log in",
            "type": "terminal",
            "args": ["auth", "login"],
            "env": { "NO_COLOR": "1" },
        }))
        .expect("a terminal auth method");
        let cmd = terminal_auth_command_for(
            &AgentId::new("some-agent"),
            &acp::AuthMethodId::new("login"),
            &m,
            &own_command(),
        )
        .expect("a runnable command");
        assert_eq!(cmd.command, "/usr/local/bin/some-agent");
        // The agent's own launch args come FIRST — dropping them would run a
        // different program than the one Atlas spawned.
        assert_eq!(cmd.args, ["acp", "auth", "login"]);
        assert_eq!(cmd.env, [("NO_COLOR".to_string(), "1".to_string())]);
    }

    /// The typed variant wins, as it does in Zed (`acp.rs:1897-1920`): an
    /// agent that advertises the stabilized shape should not be pinned to the
    /// pre-stabilization one forever just because it also ships `_meta` for
    /// older clients.
    #[test]
    fn the_typed_variant_beats_an_explicit_meta_spec() {
        let m: acp::AuthMethod = serde_json::from_value(serde_json::json!({
            "id": "login",
            "name": "Log in",
            "type": "terminal",
            "args": ["auth", "login"],
            "_meta": {
                "terminal-auth": { "label": "Sign in", "command": "/opt/login-helper" }
            },
        }))
        .expect("a terminal auth method with a meta spec");
        let cmd = terminal_auth_command_for(
            &AgentId::new("some-agent"),
            &acp::AuthMethodId::new("login"),
            &m,
            &own_command(),
        )
        .expect("a runnable command");
        assert_eq!(cmd.command, "/usr/local/bin/some-agent");
        assert_eq!(cmd.args, ["acp", "auth", "login"]);
    }

    /// The login subprocess inherits the agent's OWN environment, with the
    /// method's vars on top. Without it the login runs with no proxy config
    /// and with the API key `env_quirks` exists to blank — reaching the network
    /// differently from the agent it is signing in.
    #[test]
    fn a_typed_terminal_method_inherits_the_agents_environment() {
        let m: acp::AuthMethod = serde_json::from_value(serde_json::json!({
            "id": "login",
            "name": "Log in",
            "type": "terminal",
            "args": ["auth", "login"],
            "env": { "NO_COLOR": "1", "HTTPS_PROXY": "http://method" },
        }))
        .expect("a terminal auth method");
        let mut spawn_env = HashMap::new();
        spawn_env.insert("HTTPS_PROXY".to_string(), "http://spawn".to_string());
        spawn_env.insert("ANTHROPIC_API_KEY".to_string(), String::new());
        let cmd = terminal_auth_command_for(
            &AgentId::new("some-agent"),
            &acp::AuthMethodId::new("login"),
            &m,
            &AgentServerCommand {
                path: PathBuf::from("/usr/local/bin/some-agent"),
                args: vec!["acp".to_string()],
                env: Some(spawn_env),
            },
        )
        .expect("a runnable command");
        let env: HashMap<String, String> = cmd.env.into_iter().collect();
        assert_eq!(env.get("ANTHROPIC_API_KEY"), Some(&String::new()));
        assert_eq!(env.get("NO_COLOR"), Some(&"1".to_string()));
        // The method's own value wins where the two name the same var.
        assert_eq!(env.get("HTTPS_PROXY"), Some(&"http://method".to_string()));
    }

    /// The split that keeps the user's keys off their screen.
    ///
    /// `env` is what the login is SPAWNED with — the agent's whole inherited
    /// environment, which for Atlas carries the BYOK keys read out of the
    /// keychain. `declared_env` is only what the agent asked for. The wire
    /// carries the second, because it is displayed, copied to the clipboard and
    /// typed into a shell that records its history.
    #[test]
    fn only_what_the_agent_declared_is_safe_to_show() {
        let mut own = own_command();
        own.env = Some(HashMap::from([
            ("ANTHROPIC_API_KEY".to_string(), "sk-secret".to_string()),
            ("HTTPS_PROXY".to_string(), "http://proxy".to_string()),
        ]));
        let method: acp::AuthMethod = serde_json::from_value(serde_json::json!({
            "id": "login",
            "name": "Log in",
            "type": "terminal",
            "args": ["login"],
            "env": { "AGENT_LOGIN_MODE": "browser" },
        }))
        .expect("a typed terminal method");

        let cmd = terminal_auth_command_for(
            &AgentId::new("a"),
            &acp::AuthMethodId::new("login"),
            &method,
            &own,
        )
        .expect("a command");

        let spawn: HashMap<_, _> = cmd.env.iter().cloned().collect();
        assert_eq!(
            spawn.get("ANTHROPIC_API_KEY"),
            Some(&"sk-secret".to_string()),
            "the subprocess still gets the agent's real environment"
        );
        assert_eq!(spawn.get("AGENT_LOGIN_MODE"), Some(&"browser".to_string()));

        assert_eq!(
            cmd.declared_env,
            vec![("AGENT_LOGIN_MODE".to_string(), "browser".to_string())],
            "but only the agent's own declaration may be shown"
        );
    }

    /// The `_meta` spec brings its own environment and nothing is layered under
    /// it, so there is nothing inherited to withhold.
    #[test]
    fn a_meta_spec_declares_everything_it_runs_with() {
        let m = method(serde_json::json!({
            "terminal-auth": {
                "label": "Sign in",
                "command": "/bin/agent",
                "args": ["login"],
                "env": { "NO_COLOR": "1" },
            }
        }));
        let cmd = meta_terminal_auth_command(
            &AgentId::new("a"),
            &acp::AuthMethodId::new("claude-login"),
            &m,
        )
        .expect("a command");

        assert_eq!(cmd.env, cmd.declared_env);
        assert_eq!(
            cmd.declared_env,
            vec![("NO_COLOR".to_string(), "1".to_string())]
        );
    }

    /// No spec means the agent never told us how to sign in. The honest answer
    /// is nothing — the old stack guessed here from a hardcoded table, which
    /// could only ever cover agents someone had written down.
    #[test]
    fn an_agent_that_names_no_login_command_yields_none() {
        for meta in [
            serde_json::json!({}),
            serde_json::json!({ "api-key": { "provider": "openai" } }),
            // Malformed: no `command`, so there is nothing to exec.
            serde_json::json!({ "terminal-auth": { "label": "Sign in" } }),
        ] {
            assert!(meta_terminal_auth_command(
                &AgentId::new("a"),
                &acp::AuthMethodId::new("claude-login"),
                &method(meta),
            )
            .is_none());
        }
    }
}

#[cfg(test)]
mod model_select_tests {
    use super::*;

    fn option(value: serde_json::Value) -> acp::SessionConfigOption {
        serde_json::from_value(value).expect("an option this schema understands")
    }

    fn model_option() -> acp::SessionConfigOption {
        option(serde_json::json!({
            "id": "model",
            "name": "Model",
            "category": "model",
            "type": "select",
            "currentValue": "sonnet",
            "options": [
                { "value": "sonnet", "name": "Sonnet", "description": "Fast" },
                { "value": "opus", "name": "Opus" },
            ],
        }))
    }

    /// The whole mechanism: ACP has no `models` field, so an agent that lets the
    /// client pick a model says so with a `category: "model"` select. That is
    /// what fills the composer's model pill.
    #[test]
    fn a_model_category_select_becomes_the_model_list() {
        let select = model_select_of(&[model_option()]).expect("a model select");

        assert_eq!(select.config_id.0.as_ref(), "model");
        assert_eq!(select.current.0.as_ref(), "sonnet");
        let ids: Vec<_> = select
            .models
            .iter()
            .map(|model| model.id.as_str().to_string())
            .collect();
        assert_eq!(ids, vec!["sonnet".to_string(), "opus".to_string()]);
        assert_eq!(select.models[0].name.as_ref(), "Sonnet");
        assert_eq!(
            select.models[0].description.as_deref(),
            Some("Fast"),
            "the choice's description carries through to the picker row"
        );
        assert!(select.models[1].description.is_none());
    }

    /// Grouped lists flatten, exactly as `build_snapshot` already flattens
    /// [`AgentModelList::Grouped`]: the composer's picker is one list.
    #[test]
    fn a_grouped_model_select_flattens() {
        let select = model_select_of(&[option(serde_json::json!({
            "id": "model",
            "name": "Model",
            "category": "model",
            "type": "select",
            "currentValue": "gpt-5",
            "options": [
                { "group": "openai", "name": "OpenAI",
                  "options": [{ "value": "gpt-5", "name": "GPT-5" }] },
                { "group": "local", "name": "Local",
                  "options": [{ "value": "qwen", "name": "Qwen" }] },
            ],
        }))])
        .expect("a model select");

        let ids: Vec<_> = select
            .models
            .iter()
            .map(|model| model.id.as_str().to_string())
            .collect();
        assert_eq!(ids, vec!["gpt-5".to_string(), "qwen".to_string()]);
    }

    /// Gating is on the advertised category, never on who the agent is. An
    /// agent that advertises no model select has no model picker — and one that
    /// does gets it, whatever it is called (ADR-0002).
    #[test]
    fn only_a_model_category_select_counts() {
        // A select, but a different knob.
        let thought = option(serde_json::json!({
            "id": "thought",
            "name": "Thinking",
            "category": "thought_level",
            "type": "select",
            "currentValue": "low",
            "options": [{ "value": "low", "name": "Low" }],
        }));
        // The right category, but not a select — nothing to list.
        let boolean = option(serde_json::json!({
            "id": "model",
            "name": "Model",
            "category": "model",
            "type": "boolean",
            "currentValue": true,
        }));
        // A select with no category at all: unknowable, so not the model pill.
        let uncategorised = option(serde_json::json!({
            "id": "model",
            "name": "Model",
            "type": "select",
            "currentValue": "a",
            "options": [{ "value": "a", "name": "A" }],
        }));

        assert!(model_select_of(&[]).is_none());
        assert!(model_select_of(&[thought, boolean, uncategorised]).is_none());
    }

    /// A select whose option list is empty is a dead control — the picker would
    /// open onto nothing, so there is no model selection to report.
    #[test]
    fn an_empty_model_select_is_no_selector() {
        assert!(model_select_of(&[option(serde_json::json!({
            "id": "model",
            "name": "Model",
            "category": "model",
            "type": "select",
            "currentValue": "",
            "options": [],
        }))])
        .is_none());
    }
}

#[cfg(test)]
mod authenticate_tests {
    use super::*;

    /// What the TypeScript ACP SDK sends for a thrown `Error`: `-32603` with
    /// the message under `data.details`.
    fn internal(details: &str) -> acp::Error {
        acp::Error::internal_error().data(serde_json::json!({ "details": details }))
    }

    /// The Claude Code regression: the login CLI ran, the user confirmed, and
    /// claude-agent-acp answered `authenticate` with "Method not implemented."
    /// That is the adapter declining a courtesy, not a failed sign-in.
    #[test]
    fn an_unimplemented_authenticate_is_fine_for_a_terminal_method() {
        assert!(authenticate_outcome(internal("Method not implemented."), true).is_ok());
        assert!(authenticate_outcome(acp::Error::method_not_found(), true).is_ok());
    }

    /// For an `agent` method the RPC IS the login, so declining it is a real
    /// failure — and one the user needs to read as "this way in doesn't work".
    #[test]
    fn an_unimplemented_authenticate_fails_an_agent_method() {
        let err = authenticate_outcome(internal("Method not implemented."), false)
            .expect_err("no login happened");
        assert!(err.to_string().contains("does not support"), "{err}");
    }

    /// Any other internal error surfaces its own words, not the SDK envelope
    /// (`Internal error: { "details": … }`) — whichever method kind.
    #[test]
    fn other_internal_errors_surface_their_details() {
        for terminal in [true, false] {
            let err = authenticate_outcome(internal("browser could not be opened"), terminal)
                .expect_err("a real failure");
            assert_eq!(err.to_string(), "browser could not be opened");
        }
    }

    /// `AuthRequired` stays typed so the host can route into sign-in.
    #[test]
    fn auth_required_stays_typed() {
        let err = authenticate_outcome(acp::Error::auth_required(), true).expect_err("typed");
        assert!(err.downcast_ref::<AuthRequired>().is_some());
    }
}

#[cfg(test)]
mod deadline_tests {
    use super::*;

    /// A hop that runs past its deadline surfaces as a typed `TimedOut` naming
    /// the phase, so the manager and the UI can tell "never answered" from
    /// "answered with an error" — and the message reads like the exit path's.
    #[tokio::test(start_paused = true)]
    async fn an_expired_request_becomes_a_typed_timed_out_error() {
        let agent = AgentId::new("codex-acp");
        let debug_log = AcpDebugLog::new();
        debug_log.record_line(AcpDebugMessageDirection::Stderr, "app-server: waiting on lock");

        let result: Result<()> =
            with_request_deadline(&agent, "session/new", &debug_log, std::future::pending()).await;

        let error = result.expect_err("a request that never answers fails");
        let load_error = error
            .downcast_ref::<LoadError>()
            .expect("the failure is a LoadError the manager can carry");
        match load_error {
            LoadError::TimedOut {
                agent,
                phase,
                after,
                stderr,
            } => {
                assert_eq!(agent.as_ref(), "codex-acp");
                assert_eq!(phase.as_ref(), "session/new");
                assert_eq!(*after, REQUEST_TIMEOUT);
                assert!(
                    stderr.as_deref().is_some_and(|s| s.contains("waiting on lock")),
                    "the trailing stderr rides along: {stderr:?}"
                );
            }
            other => panic!("expected TimedOut, got {other:?}"),
        }
        assert_eq!(
            load_error.to_string(),
            "codex-acp did not answer `session/new` within 120s: app-server: waiting on lock"
        );
    }

    /// A request that answers in time is passed through untouched.
    #[tokio::test(start_paused = true)]
    async fn a_request_that_answers_in_time_is_untouched() {
        let agent = AgentId::new("codex-acp");
        let debug_log = AcpDebugLog::new();
        let value = with_request_deadline(&agent, "session/new", &debug_log, async { Ok(7) })
            .await
            .expect("answered");
        assert_eq!(value, 7);
    }

    /// Without stderr the message stops at the deadline; no dangling colon.
    #[test]
    fn a_timed_out_error_without_stderr_has_no_trailing_reason() {
        let error = LoadError::TimedOut {
            agent: "codex-acp".into(),
            phase: "initialize".into(),
            after: INITIALIZE_TIMEOUT,
            stderr: None,
        };
        assert_eq!(
            error.to_string(),
            "codex-acp did not answer `initialize` within 60s"
        );
    }
}

#[cfg(test)]
mod mode_select_tests {
    use super::*;

    fn options(v: serde_json::Value) -> Vec<acp::SessionConfigOption> {
        serde_json::from_value(v).expect("config options this schema understands")
    }

    /// OpenCode's shape: no `modes` on the session, one `category: "mode"`
    /// select carrying build/plan. It becomes the pill's mode state.
    #[test]
    fn a_mode_select_becomes_session_modes_when_the_agent_sends_none() {
        let opts = options(serde_json::json!([
            { "id": "model", "name": "Model", "category": "model", "type": "select",
              "currentValue": "anthropic/claude", "options": [ { "value": "anthropic/claude", "name": "Claude" } ] },
            { "id": "mode", "name": "Session Mode", "category": "mode", "type": "select",
              "currentValue": "plan",
              "options": [
                { "value": "build", "name": "Build", "description": "Edits files" },
                { "value": "plan", "name": "Plan" }
              ] },
            { "id": "effort", "name": "Effort", "category": "thought_level", "type": "select",
              "currentValue": "high", "options": [ { "value": "high", "name": "High" } ] }
        ]));
        let modes = session_modes_of(None, Some(&opts)).expect("modes from the select");
        assert_eq!(modes.current_mode_id.0.as_ref(), "plan");
        let ids: Vec<&str> = modes.available_modes.iter().map(|m| m.id.0.as_ref()).collect();
        assert_eq!(ids, ["build", "plan"]);
        assert_eq!(modes.available_modes[0].name, "Build");
        assert_eq!(modes.available_modes[0].description.as_deref(), Some("Edits files"));
        assert_eq!(modes.available_modes[1].description, None);
    }

    /// The dedicated `modes` wire wins: an agent that sends both keeps its own
    /// state, and the select never reaches the pill.
    #[test]
    fn the_modes_field_is_preferred_over_the_select() {
        let opts = options(serde_json::json!([
            { "id": "mode", "name": "Mode", "category": "mode", "type": "select",
              "currentValue": "b", "options": [ { "value": "b", "name": "B" } ] }
        ]));
        let own = acp::SessionModeState::new("default", vec![acp::SessionMode::new("default", "Default")]);
        let modes = session_modes_of(Some(own), Some(&opts)).expect("the agent's own modes");
        assert_eq!(modes.current_mode_id.0.as_ref(), "default");
    }

    /// Only the `mode` category is lifted. Model and effort selects, and a
    /// mode-category option that is not a select, leave the pill empty.
    #[test]
    fn other_categories_and_non_selects_are_not_modes() {
        let opts = options(serde_json::json!([
            { "id": "model", "name": "Model", "category": "model", "type": "select",
              "currentValue": "m", "options": [ { "value": "m", "name": "M" } ] },
            { "id": "effort", "name": "Effort", "category": "thought_level", "type": "select",
              "currentValue": "high", "options": [ { "value": "high", "name": "High" } ] },
            { "id": "yolo", "name": "Yolo", "category": "mode", "type": "boolean", "currentValue": true }
        ]));
        assert!(session_modes_of(None, Some(&opts)).is_none());
        assert!(session_modes_of(None, None).is_none());
    }

    /// A select with no choices is a dead control, not a mode list.
    #[test]
    fn an_empty_mode_select_is_not_modes() {
        let opts = options(serde_json::json!([
            { "id": "mode", "name": "Mode", "category": "mode", "type": "select",
              "currentValue": "", "options": [] }
        ]));
        assert!(mode_select_of(&opts).is_none());
    }
}
