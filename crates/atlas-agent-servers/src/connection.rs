//! The live connection to one external ACP agent — ported from
//! `zed-ref/crates/agent_servers/src/acp.rs`.
//!
//! This is where the reliability mechanics live. Each one exists because of a
//! specific failure, and the reason is recorded at the code rather than here.

use std::any::Any;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_client_protocol::schema::v1 as acp;
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{Agent, Client, ConnectionTo, Lines};
use anyhow::{anyhow, Context as _, Result};
use atlas_acp_thread::{
    AcpThread, AcpThreadEvent, AcpThreadHandle, AgentConnection, AgentId, AgentSessionConfigOptions,
    AgentSessionModes, AuthRequired, ElicitationStore, ElicitationStoreHandle, EventSink, LoadError,
    TerminalAuthCommand, build_terminal_auth_command,
};
use futures::future::BoxFuture;
use futures::{AsyncBufReadExt, FutureExt, StreamExt};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use crate::debug_log::{AcpDebugLog, AcpDebugMessage, AcpDebugMessageDirection};
use crate::handlers::{self, ClientContext};
use crate::session::{AcpSession, ConfigOptions, SessionDirectories, SessionRegistry};

/// Zed rejects anything below v1 outright rather than trying to degrade.
const MINIMUM_SUPPORTED_VERSION: ProtocolVersion = ProtocolVersion::V1;

/// How long to wait for the child's exit status after `initialize` fails.
///
/// An agent that dies during startup loses the initialize race by a hair: the
/// RPC fails first (the pipe closed) and the exit status lands a moment later.
/// Reporting the RPC error would tell the user "connection closed" when the
/// real answer — on stderr — is one tick away.
const INITIALIZE_EXIT_GRACE: Duration = Duration::from_millis(250);

/// What a session's `AcpThread` events are sent to.
///
/// Zed's threads are GPUI entities that the UI subscribes to directly. Here the
/// host supplies a sink per session, so routing deltas onto the outbound
/// pipeline stays the host's business and this crate stays leaf-level.
pub type ThreadEventSink =
    Arc<dyn Fn(&acp::SessionId) -> EventSink<AcpThreadEvent> + Send + Sync>;

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
    request_elicitations: ElicitationStoreHandle,
    defaults: AcpConnectionDefaults,
    thread_events: ThreadEventSink,
    debug_log: AcpDebugLog,
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
        client_name: &'static str,
        client_version: String,
    ) -> Result<Self> {
        let mut child_command = tokio::process::Command::new(&command.path);
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

        let mut child = child_command
            .spawn()
            .with_context(|| format!("failed to spawn agent server {:?}", command.path))?;

        let stdout = child.stdout.take().context("failed to take stdout")?;
        let stdin = child.stdin.take().context("failed to take stdin")?;
        let stderr = child.stderr.take().context("failed to take stderr")?;
        tracing::debug!(?command.path, args = ?command.args, "spawned external agent server");

        let debug_log = AcpDebugLog::new();
        let sessions = Arc::new(SessionRegistry::new());
        let request_elicitations: ElicitationStoreHandle =
            Arc::new(Mutex::new(ElicitationStore::default()));

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
        let mut status_fut = Box::pin(wait_for_exit(child, debug_log.clone()));
        let connection_rx = Box::pin(async move {
            connection_rx
                .await
                .context("failed to receive ACP connection handle")
        });
        let connection = match futures::future::select(connection_rx, status_fut).await {
            futures::future::Either::Left((connection, rest)) => {
                status_fut = rest;
                connection?
            }
            futures::future::Either::Right(((load_error, _child), _)) => {
                return Err(load_error.into())
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

        let (response, status_fut) = match futures::future::select(initialize, status_fut).await {
            futures::future::Either::Left((Ok(response), rest)) => (response, rest),
            futures::future::Either::Left((Err(error), rest)) => {
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
            futures::future::Either::Right(((load_error, _child), _)) => {
                return Err(load_error.into())
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
                        .unwrap_or_else(|p| p.into_inner())
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

        Ok(Self {
            id: agent_id,
            telemetry_id,
            agent_version,
            connection,
            sessions,
            auth_methods: response.auth_methods,
            agent_capabilities: response.agent_capabilities,
            request_elicitations,
            defaults,
            thread_events,
            debug_log,
            _io_task: io_task,
            _stderr_task: stderr_task,
            _wait_task: wait_task,
        })
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

    fn directories(&self, work_dirs: &[PathBuf]) -> Result<SessionDirectories> {
        SessionDirectories::from_work_dirs(
            work_dirs,
            self.agent_capabilities
                .session_capabilities
                .additional_directories
                .is_some(),
        )
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
        let thread = self.new_thread(session_id.clone(), work_dirs, title);

        self.sessions.pending_begin(session_id.clone());
        self.sessions.insert(
            session_id.clone(),
            AcpSession {
                thread: Arc::downgrade(&thread),
                suppress_abort_err: false,
                session_modes: None,
                config_options: None,
                ref_count: 1,
            },
        );

        let response = match rpc_call(self.connection.clone(), session_id.clone(), directories).await
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
            session.session_modes = response.modes.map(|modes| Arc::new(Mutex::new(modes)));
            session.config_options = response
                .config_options
                .map(|options| ConfigOptions::new(Arc::new(Mutex::new(options))));
            session.ref_count = ref_count;
        });
        if attached.is_none() {
            return Err(anyhow!("session was closed before load completed"));
        }

        Ok(thread)
    }
}

struct SessionConfigResponse {
    modes: Option<acp::SessionModeState>,
    config_options: Option<Vec<acp::SessionConfigOption>>,
}

/// Waits for the child and turns its exit into a `LoadError` carrying the
/// trailing stderr. The child is returned so the caller keeps owning it.
async fn wait_for_exit(
    mut child: tokio::process::Child,
    debug_log: AcpDebugLog,
) -> (LoadError, tokio::process::Child) {
    let status = child.wait().await;
    let error = LoadError::Exited {
        status: status.ok().and_then(|status| status.code()),
        stderr: debug_log
            .trailing_stderr()
            .map(Arc::from)
            .unwrap_or_else(|| Arc::from("")),
    };
    (error, child)
}

/// Builds the client with the full agent→client handler set.
///
/// Zed's equivalent forwards every handler onto a foreground dispatch queue and
/// polls the connection on a dedicated thread with extra stack, because GPUI
/// entities are `!Send` and the SDK requires `Send` handlers. Neither applies
/// here: the session table is a mutex and the handlers are ordinary async fns,
/// so they run directly on the tokio worker that received the message.
fn connect_client_future(
    name: &'static str,
    transport: impl agent_client_protocol::ConnectTo<Client> + 'static,
    ctx: ClientContext,
    connection_tx: futures::channel::oneshot::Sender<ConnectionTo<Agent>>,
) -> impl std::future::Future<Output = std::result::Result<(), acp::Error>> {
    macro_rules! on_request {
        ($handler:path) => {{
            let ctx = ctx.clone();
            async move |req, responder, _connection| {
                $handler(req, responder, ctx.clone()).await;
                Ok(())
            }
        }};
    }
    macro_rules! on_notification {
        ($handler:path) => {{
            let ctx = ctx.clone();
            async move |notif, _connection| {
                $handler(notif, ctx.clone()).await;
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

impl Drop for AcpConnection {
    fn drop(&mut self) {
        // Zed kills the child here (`acp.rs:1528-1534`). The child is owned by
        // the wait task, so aborting that task drops it — and the spawn set
        // `kill_on_drop`, which is what actually signals the process. Without
        // this the agent outlives the connection that started it: nothing else
        // holds a handle to kill it, and it sits there holding its model
        // subscription until the app exits.
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
            let response = self
                .connection
                .send_request(directories.into_new_session_request(Vec::new()))
                .block_task()
                .await
                .map_err(map_acp_error)?;

            let session_id = response.session_id.clone();
            let thread = self.new_thread(session_id.clone(), work_dirs, None);

            self.sessions.insert(
                session_id.clone(),
                AcpSession {
                    thread: Arc::downgrade(&thread),
                    suppress_abort_err: false,
                    session_modes: response.modes.map(|modes| Arc::new(Mutex::new(modes))),
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

    fn load_session(
        self: Arc<Self>,
        session_id: acp::SessionId,
        work_dirs: Vec<PathBuf>,
        title: Option<Arc<str>>,
    ) -> BoxFuture<'static, Result<AcpThreadHandle>> {
        async move {
            self.open_or_create_session(session_id, work_dirs, title, |conn, id, dirs| {
                async move {
                    let mut request = acp::LoadSessionRequest::new(id, dirs.cwd);
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
            self.open_or_create_session(session_id, work_dirs, title, |conn, id, dirs| {
                async move {
                    let mut request = acp::ResumeSessionRequest::new(id, dirs.cwd);
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
        }
        .boxed()
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
    /// Ported from Zed's `terminal_auth_task` (`acp.rs:1887-1920`) minus the
    /// `Terminal`-variant branch, which resolves the agent's own binary behind a
    /// beta flag Atlas has no equivalent of. What is left is Zed's
    /// `meta_terminal_auth_task`: read `_meta["terminal-auth"]`, which is what
    /// every adapter shipping a runnable login actually sends today
    /// (claude-agent-acp among them).
    ///
    /// Returning `None` means the agent did not tell us how to sign in. The
    /// host says exactly that rather than guessing a command — guessing is what
    /// the deleted `BUILTIN_AGENTS` login table did, and it could only ever
    /// know about a hardcoded list.
    fn terminal_auth_command(
        &self,
        method_id: &acp::AuthMethodId,
    ) -> Option<BoxFuture<'static, Result<TerminalAuthCommand>>> {
        let method = self
            .auth_methods
            .iter()
            .find(|method| method.id() == method_id)?;
        let command = meta_terminal_auth_command(&self.id, method_id, method)?;
        Some(async move { Ok(command) }.boxed())
    }

    fn authenticate(&self, method: acp::AuthMethodId) -> BoxFuture<'static, Result<()>> {
        let conn = self.connection.clone();
        async move {
            conn.send_request(acp::AuthenticateRequest::new(method))
                .block_task()
                .await?;
            Ok(())
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

        async move {
            let result = conn.send_request(params).block_task().await;

            // Consume the flag whatever the outcome, so a cancel cannot leak
            // into a later turn's error handling.
            let suppress_abort_err = sessions
                .with_session(&session_id, |session| {
                    let suppress = session.suppress_abort_err;
                    session.suppress_abort_err = false;
                    suppress
                })
                .unwrap_or(false);

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
            #[derive(serde::Deserialize)]
            #[serde(deny_unknown_fields)]
            struct ErrorDetails {
                details: Box<str>,
            }

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
        self.sessions.with_session(session_id, |session| {
            session.suppress_abort_err = true;
        });
        let _ = self
            .connection
            .send_notification(acp::CancelNotification::new(session_id.clone()));
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
            let mut modes = modes.lock().unwrap_or_else(|p| p.into_inner());
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

        if self
            .connection
            .send_request(acp::SetSessionModeRequest::new(
                session_id.clone(),
                default_mode,
            ))
            .block_task()
            .await
            .is_err()
        {
            modes.lock().unwrap_or_else(|p| p.into_inner()).current_mode_id = initial;
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
            .unwrap_or_else(|p| p.into_inner())
            .current_mode_id
            .clone()
    }

    fn all_modes(&self) -> Vec<acp::SessionMode> {
        self.modes
            .lock()
            .unwrap_or_else(|p| p.into_inner())
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
            .unwrap_or_else(|p| p.into_inner())
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
                        .unwrap_or_else(|p| p.into_inner())
                        .current_mode_id = previous;
                    Err(anyhow!(err))
                }
            }
        }
        .boxed()
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
            .unwrap_or_else(|p| p.into_inner())
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
                .unwrap_or_else(|p| p.into_inner()) = response.config_options.clone();
            options.notify();
            Ok(response.config_options)
        }
        .boxed()
    }

    fn watch(&self) -> Option<tokio::sync::watch::Receiver<()>> {
        Some(self.options.subscribe())
    }
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

    Some(build_terminal_auth_command(
        format!("external-agent-{}-{}-login", agent_id.as_str(), method_id.0),
        terminal_auth.label,
        terminal_auth.command,
        terminal_auth.args,
        terminal_auth.env.into_iter().collect(),
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
