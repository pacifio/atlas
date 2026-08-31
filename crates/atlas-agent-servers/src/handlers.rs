//! The agent→client handler set — ported from
//! `zed-ref/crates/agent_servers/src/acp.rs:4551-5138`.
//!
//! These are the requests an agent makes *of us* mid-turn: ask the user for
//! permission, read and write files, run commands, elicit input.
//!
//! **The dispatch queue is load-bearing, and an earlier port learned that the
//! hard way.** The RPC crate dispatches inbound messages SERIALLY and awaits
//! each registered handler INLINE — the next message is not even parsed until
//! the previous handler's future resolves. Zed's registered closures therefore
//! enqueue a work item and return immediately; the queue drains in wire order,
//! each item does its state mutation synchronously and defers any long await
//! (a permission prompt, a command's exit) to a spawned task. This port first
//! dismissed that queue as "a GPUI artifact" and awaited handlers inline — so
//! an open permission prompt blocked EVERY message behind it: no tool results,
//! no text, no other session's work, and no way for a cancellation to ever
//! arrive (`$/cancel` is itself an inbound message). The queue is Zed's shape
//! again now: [`enqueue_request`]/[`enqueue_notification`] from the registered
//! closures, [`spawn_dispatch_queue`]'s drain running each handler's
//! synchronous phase in order, and `tokio::spawn` for the awaits (#28).
//!
//! Two rules hold throughout, both ported:
//!
//! - **Every request gets exactly one response.** An unknown session is an
//!   error response, not a dropped request — an agent blocked on a request we
//!   silently discarded hangs forever. On a normal close the drain still runs
//!   everything already buffered; `reject` exists for the enqueue that loses
//!   the race with the drain's death, so even that request gets an answer.
//! - **Cancellation is honoured.** Long-running requests (permission,
//!   `wait_for_exit`, `read_text_file`) race the responder's cancellation, and a
//!   cancelled permission prompt is taken down in the thread too, rather than
//!   left on screen asking about a turn that is over.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::v1 as acp;
use agent_client_protocol::{JsonRpcResponse, Responder};
use atlas_acp_thread::{
    AcpThread, AcpThreadHandle, AuthorizationKind, ElicitationStoreHandle, PermissionOptions,
    TerminalProviderEvent,
};
use atlas_terminal::command::{CommandTerminal, DEFAULT_OUTPUT_BYTE_LIMIT};

use crate::session::SessionRegistry;

/// Everything the handlers need. One clone per registered handler.
#[derive(Clone)]
pub struct ClientContext {
    pub sessions: Arc<SessionRegistry>,
    /// Request-scoped elicitations live here rather than on a thread, because
    /// they can arrive before any session exists — during authentication.
    pub request_elicitations: ElicitationStoreHandle,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ------------------------------------------------------------------- dispatch

/// One inbound message's handling, queued for the ordered drain.
///
/// Ported from Zed's `ForegroundWorkItem` (`acp.rs:296-360`), minus GPUI: the
/// drain is a tokio task rather than the foreground thread, and the deferred
/// awaits go through `tokio::spawn` rather than `cx.spawn`.
pub trait DispatchWorkItem: Send {
    fn run(self: Box<Self>, ctx: &ClientContext);
    /// The queue is gone (connection closed). A request must still be
    /// answered — an agent blocked on a silently-dropped request hangs.
    fn reject(self: Box<Self>);
}

pub type DispatchWork = Box<dyn DispatchWorkItem>;

/// The sending half of a connection's dispatch queue.
pub type DispatchTx = tokio::sync::mpsc::UnboundedSender<DispatchWork>;

struct RequestWork<Req, Res>
where
    Req: Send + 'static,
    Res: JsonRpcResponse + Send + 'static,
{
    request: Req,
    responder: Responder<Res>,
    handler: fn(Req, Responder<Res>, &ClientContext),
}

impl<Req, Res> DispatchWorkItem for RequestWork<Req, Res>
where
    Req: Send + 'static,
    Res: JsonRpcResponse + Send + 'static,
{
    fn run(self: Box<Self>, ctx: &ClientContext) {
        let Self { request, responder, handler } = *self;
        handler(request, responder, ctx);
    }

    fn reject(self: Box<Self>) {
        respond_err(self.responder, dispatch_queue_closed_error());
    }
}

struct NotificationWork<Notif>
where
    Notif: Send + 'static,
{
    notification: Notif,
    handler: fn(Notif, &ClientContext),
}

impl<Notif> DispatchWorkItem for NotificationWork<Notif>
where
    Notif: Send + 'static,
{
    fn run(self: Box<Self>, ctx: &ClientContext) {
        let Self { notification, handler } = *self;
        handler(notification, ctx);
    }

    fn reject(self: Box<Self>) {
        tracing::warn!("ACP dispatch queue closed while a notification was queued");
    }
}

fn dispatch_queue_closed_error() -> acp::Error {
    acp::Error::internal_error().data("ACP dispatch queue closed")
}

/// Queue a request for the ordered drain and return immediately.
///
/// Called from inside the RPC crate's serial inbound loop, so it must not
/// block: whatever it does happens before the NEXT message is parsed.
pub fn enqueue_request<Req, Res>(
    dispatch_tx: &DispatchTx,
    request: Req,
    responder: Responder<Res>,
    handler: fn(Req, Responder<Res>, &ClientContext),
) where
    Req: Send + 'static,
    Res: JsonRpcResponse + Send + 'static,
{
    let work: DispatchWork = Box::new(RequestWork { request, responder, handler });
    if let Err(err) = dispatch_tx.send(work) {
        err.0.reject();
    }
}

pub fn enqueue_notification<Notif>(
    dispatch_tx: &DispatchTx,
    notification: Notif,
    handler: fn(Notif, &ClientContext),
) where
    Notif: Send + 'static,
{
    let work: DispatchWork = Box::new(NotificationWork { notification, handler });
    if let Err(err) = dispatch_tx.send(work) {
        err.0.reject();
    }
}

/// Start one connection's ordered drain and hand back its sender.
///
/// The drain runs each work item's SYNCHRONOUS phase to completion, in wire
/// order — that is the whole guarantee. A handler that must wait (for the
/// user's permission answer, for a command to exit) spawns that wait and
/// returns, so the queue keeps moving. The task ends when the last sender is
/// dropped, which happens when the connection's handler closures are dropped.
pub fn spawn_dispatch_queue(ctx: ClientContext) -> DispatchTx {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<DispatchWork>();
    tokio::spawn(async move {
        while let Some(work) = rx.recv().await {
            // A panicking handler must not take the drain down with it: the
            // connection would look alive while every later request got
            // "queue closed" and every update was dropped. Zed cannot reach
            // this state (a foreground panic crashes the app); a tokio task
            // dying silently is a lobotomy, so the panic is contained and the
            // queue keeps draining.
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                work.run(&ctx);
            }));
            if let Err(panic) = outcome {
                tracing::error!("ACP dispatch handler panicked: {panic:?}");
            }
        }
    });
    tx
}

fn respond_err<T: JsonRpcResponse>(responder: Responder<T>, err: acp::Error) {
    // Log what we actually returned. Without this an agent hitting an error
    // path sees only the generic wire error and the client side has no trace of
    // why.
    tracing::warn!(
        method = responder.method(),
        "responding to ACP request with error: {err:?}"
    );
    let _ = responder.respond_with_error(err);
}

fn respond_result<T: JsonRpcResponse>(responder: Responder<T>, result: Result<T, acp::Error>) {
    match result {
        Ok(response) => {
            let _ = responder.respond(response);
        }
        Err(err) => respond_err(responder, err),
    }
}

// ------------------------------------------------------------------ permission

pub fn handle_request_permission(
    args: acp::RequestPermissionRequest,
    responder: Responder<acp::RequestPermissionResponse>,
    ctx: &ClientContext,
) {
    let thread = match ctx.sessions.thread(&args.session_id) {
        Ok(thread) => thread,
        Err(err) => return respond_err(responder, err),
    };

    let cancellation = responder.cancellation();
    let tool_call_id = args.tool_call.tool_call_id.clone();

    // The registration is the synchronous phase: once this returns, the prompt
    // exists and the drain can move on to whatever the agent said next.
    let waiter = {
        let mut thread = lock(&thread);
        thread.request_tool_call_authorization(
            args.tool_call,
            PermissionOptions::Flat(args.options),
            AuthorizationKind::PermissionGrant,
        )
    };
    let waiter = match waiter {
        Ok(waiter) => waiter,
        Err(err) => return respond_err(responder, err),
    };

    // The prompt can be open for as long as the user takes to answer — that
    // wait must not hold the dispatch queue.
    tokio::spawn(async move {
        match cancellation.run_until_cancelled(async { Ok(waiter.await) }).await {
            Ok(outcome) => {
                let _ = responder.respond(acp::RequestPermissionResponse::new(outcome.into()));
            }
            Err(err) => {
                // The agent gave up on the turn; take the prompt down rather
                // than leaving the user staring at a question nobody is
                // waiting on.
                if err.code == acp::ErrorCode::RequestCancelled {
                    lock(&thread).cancel_tool_call_authorization(&tool_call_id);
                }
                respond_err(responder, err)
            }
        }
    });
}

// ---------------------------------------------------------------- elicitation

pub fn handle_create_elicitation(
    args: acp::CreateElicitationRequest,
    responder: Responder<acp::CreateElicitationResponse>,
    ctx: &ClientContext,
) {
    // Session-scoped elicitations belong in that session's timeline;
    // request-scoped ones can predate every session, so they live on the
    // connection.
    let waiter = match args.scope() {
        acp::ElicitationScope::Session(scope) => {
            let session_id = scope.session_id.clone();
            let thread = match ctx.sessions.thread(&session_id) {
                Ok(thread) => thread,
                Err(err) => return respond_err(responder, err),
            };
            let result = lock(&thread).request_elicitation(args);
            match result {
                Ok((_id, waiter)) => Box::pin(waiter)
                    as std::pin::Pin<Box<dyn std::future::Future<Output = _> + Send>>,
                Err(err) => return respond_err(responder, err),
            }
        }
        _ => {
            let result = lock(&ctx.request_elicitations).request_elicitation(args);
            match result {
                Ok((_id, waiter)) => Box::pin(waiter)
                    as std::pin::Pin<Box<dyn std::future::Future<Output = _> + Send>>,
                Err(err) => return respond_err(responder, err),
            }
        }
    };

    // Registered above (the synchronous phase); the wait for the user's answer
    // is deferred so the queue keeps draining.
    let cancellation = responder.cancellation();
    tokio::spawn(async move {
        match cancellation.run_until_cancelled(async { Ok(waiter.await) }).await {
            Ok(response) => {
                let _ = responder.respond(response);
            }
            Err(err) => respond_err(responder, err),
        }
    });
}

/// The agent telling us a URL elicitation finished out of band (the user
/// completed a device-code login in their browser).
///
/// Broadcast to every thread and to the connection store, because the id space
/// is the agent's and we do not know which one owns it.
pub fn handle_complete_elicitation(
    args: acp::CompleteElicitationNotification,
    ctx: &ClientContext,
) {
    let elicitation_id = args.elicitation_id;
    for thread in ctx.sessions.all_threads() {
        lock(&thread).complete_url_elicitation(&elicitation_id);
    }
    lock(&ctx.request_elicitations).complete_url_elicitation(&elicitation_id);
}

// ------------------------------------------------------------------------- fs
//
// Served from disk, not from editor buffers — see the divergence note in
// `atlas_acp_thread`'s module docs. An agent reading a file the user has
// modified but not saved sees the on-disk version.

pub fn handle_write_text_file(
    args: acp::WriteTextFileRequest,
    responder: Responder<acp::WriteTextFileResponse>,
    ctx: &ClientContext,
) {
    if let Err(err) = ctx.sessions.thread(&args.session_id) {
        return respond_err(responder, err);
    }

    // Disk IO off the queue: a write to a slow volume must not stall the
    // messages behind it.
    tokio::spawn(async move {
        let path = args.path.clone();
        let result = tokio::task::spawn_blocking(move || write_text_file(&path, &args.content))
            .await
            .unwrap_or_else(|err| Err(anyhow::anyhow!("write task panicked: {err}")));

        match result {
            Ok(()) => {
                let _ = responder.respond(acp::WriteTextFileResponse::default());
            }
            Err(err) => respond_err(
                responder,
                acp::Error::internal_error().data(err.to_string()),
            ),
        }
    });
}

fn write_text_file(path: &Path, content: &str) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, content)?;
    Ok(())
}

pub fn handle_read_text_file(
    args: acp::ReadTextFileRequest,
    responder: Responder<acp::ReadTextFileResponse>,
    ctx: &ClientContext,
) {
    if let Err(err) = ctx.sessions.thread(&args.session_id) {
        return respond_err(responder, err);
    }

    let cancellation = responder.cancellation();
    let path = args.path.clone();
    let (line, limit) = (args.line, args.limit);

    tokio::spawn(async move {
        let result = cancellation
            .run_until_cancelled(async move {
                tokio::task::spawn_blocking(move || read_text_file(&path, line, limit))
                    .await
                    .unwrap_or_else(|err| Err(anyhow::anyhow!("read task panicked: {err}")))
                    .map_err(|err| acp::Error::internal_error().data(err.to_string()))
            })
            .await;

        respond_result(responder, result.map(acp::ReadTextFileResponse::new));
    });
}

/// `line` is 1-based and `limit` counts lines, matching the ACP field docs.
fn read_text_file(path: &Path, line: Option<u32>, limit: Option<u32>) -> anyhow::Result<String> {
    let content = std::fs::read_to_string(path)?;
    if line.is_none() && limit.is_none() {
        return Ok(content);
    }

    let skip = line.unwrap_or(1).saturating_sub(1) as usize;
    let take = limit.map(|limit| limit as usize).unwrap_or(usize::MAX);
    let selected: Vec<&str> = content.lines().skip(skip).take(take).collect();
    Ok(selected.join("\n"))
}

// ------------------------------------------------------------- session/update

pub fn handle_session_notification(
    notification: acp::SessionNotification,
    ctx: &ClientContext,
) {
    let Ok(thread) = ctx.sessions.thread(&notification.session_id) else {
        // Not an error to answer — notifications have no response — but worth
        // saying, because it means an update was dropped.
        tracing::warn!(
            "received session notification for unknown session: {:?}",
            notification.session_id
        );
        return;
    };

    // Mode and config-option updates are also mirrored onto the session so a
    // later snapshot read agrees with what the agent just told us.
    match &notification.update {
        acp::SessionUpdate::CurrentModeUpdate(update) => {
            let mode_id = update.current_mode_id.clone();
            ctx.sessions.with_session(&notification.session_id, |session| {
                if let Some(modes) = &session.session_modes {
                    lock(modes).current_mode_id = mode_id;
                }
            });
        }
        acp::SessionUpdate::ConfigOptionUpdate(update) => {
            let options = update.config_options.clone();
            ctx.sessions.with_session(&notification.session_id, |session| {
                if let Some(config) = &session.config_options {
                    *lock(&config.config_options) = options;
                    config.notify();
                }
            });
        }
        _ => {}
    }

    // Pre-handle: a `ToolCall` whose meta carries `terminal_info` announces a
    // terminal the AGENT is running itself. Registered before the update is
    // applied, so the call's own `Terminal` content resolves on first render.
    // Ported from zed-ref `acp.rs:4869-4904`; gated purely on the meta key —
    // the same key we advertise in `client_capabilities_for_agent`. Unlike in
    // Zed the order is a nicety, not load-bearing: the registry parks
    // out-of-order events and unknown terminal references, so no test pins it.
    if let acp::SessionUpdate::ToolCall(tool_call) = &notification.update {
        if let Some(info) = tool_call
            .meta
            .as_ref()
            .and_then(|meta| meta.get("terminal_info"))
        {
            if let Some(terminal_id) = info.get("terminal_id").and_then(|v| v.as_str()) {
                let cwd = info.get("cwd").and_then(|v| v.as_str()).map(PathBuf::from);
                lock(&thread).on_terminal_provider_event(TerminalProviderEvent::Created {
                    terminal_id: acp::TerminalId::new(terminal_id),
                    label: tool_call.title.clone(),
                    cwd,
                    output_byte_limit: None,
                    terminal: None,
                });
            }
        }
    }

    let applied = lock(&thread).handle_session_update(notification.update.clone());
    if let Err(err) = applied {
        tracing::warn!("failed to apply session update: {err:?}");
    }

    // Post-handle: `terminal_output` / `terminal_exit` on a `ToolCallUpdate`'s
    // meta stream into that terminal. After the update, so a first update that
    // both names the call and carries output renders the call before the
    // output lands. Out-of-order arrivals park in the registry's side-tables,
    // exactly as for client-created terminals. Ported from `acp.rs:4919-4969`.
    if let acp::SessionUpdate::ToolCallUpdate(update) = &notification.update {
        let meta = update.meta.as_ref();
        if let Some(output) = meta.and_then(|meta| meta.get("terminal_output")) {
            if let (Some(terminal_id), Some(data)) = (
                output.get("terminal_id").and_then(|v| v.as_str()),
                output.get("data").and_then(|v| v.as_str()),
            ) {
                lock(&thread).on_terminal_provider_event(TerminalProviderEvent::Output {
                    terminal_id: acp::TerminalId::new(terminal_id),
                    data: data.as_bytes().to_vec(),
                });
            }
        }
        if let Some(exit) = meta.and_then(|meta| meta.get("terminal_exit")) {
            if let Some(terminal_id) = exit.get("terminal_id").and_then(|v| v.as_str()) {
                let mut status = acp::TerminalExitStatus::new();
                status.exit_code = exit.get("exit_code").and_then(|v| v.as_u64()).map(|c| c as u32);
                status.signal = exit
                    .get("signal")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                lock(&thread).on_terminal_provider_event(TerminalProviderEvent::Exit {
                    terminal_id: acp::TerminalId::new(terminal_id),
                    status,
                });
            }
        }
    }
}

// ------------------------------------------------------------------- terminal

pub fn handle_create_terminal(
    args: acp::CreateTerminalRequest,
    responder: Responder<acp::CreateTerminalResponse>,
    ctx: &ClientContext,
) {
    let thread = match ctx.sessions.thread(&args.session_id) {
        Ok(thread) => thread,
        Err(err) => return respond_err(responder, err),
    };

    let label = if args.args.is_empty() {
        args.command.clone()
    } else {
        format!("{} {}", args.command, args.args.join(" "))
    };
    let env: Vec<(String, String)> = args
        .env
        .into_iter()
        .map(|env| (env.name, env.value))
        .collect();
    let cwd: Option<PathBuf> = args.cwd.clone();
    let byte_limit = args.output_byte_limit.unwrap_or(DEFAULT_OUTPUT_BYTE_LIMIT);

    // Synchronous on the drain, deliberately. The invariant is only
    // register-before-respond — the agent cannot name this terminal until the
    // response hands it the id — and Zed meets it with a deferred task. Doing
    // it inline instead buys the same invariant with no session-teardown race
    // mid-create, at the cost of the milliseconds a PTY open takes.
    let spawned = CommandTerminal::spawn(&args.command, &args.args, &env, cwd.as_deref(), byte_limit);

    let terminal = match spawned {
        Ok(terminal) => Arc::new(terminal),
        Err(err) => {
            return respond_err(
                responder,
                acp::Error::internal_error().data(err.to_string()),
            )
        }
    };

    let terminal_id = acp::TerminalId::new(uuid::Uuid::new_v4().to_string());
    lock(&thread).on_terminal_provider_event(TerminalProviderEvent::Created {
        terminal_id: terminal_id.clone(),
        label,
        cwd,
        output_byte_limit: args.output_byte_limit,
        terminal: Some(terminal.clone()),
    });
    follow_terminal_output(thread, terminal, terminal_id.clone());

    let _ = responder.respond(acp::CreateTerminalResponse::new(terminal_id));
}

/// Turn a running command's output into thread events for as long as it runs.
///
/// A terminal's output grows on the PTY reader thread; nothing about the thread
/// changes, so nothing re-projects the tool call that renders it, and the
/// output pane would show only what happened to be buffered when some unrelated
/// event last touched the entry.
///
/// Zed needs no such pump: its terminal is an entity the inline terminal view
/// holds, so `write_output` → `cx.notify()` re-renders the tool call directly
/// (`acp_thread.rs:4679-4687`). Atlas has no inline terminal view — output
/// reaches the UI through the tool call's own projection — so the link that
/// GPUI gives Zed for free is made here instead.
///
/// # What keeps this from leaking
///
/// The task holds the terminal STRONGLY — it has to read the buffer it is
/// reporting — and the thread only weakly, so a session that goes away does not
/// stay alive for its own terminal. It ends on any of three things, which
/// between them cover every way a terminal stops mattering:
///
/// - the command exits (checked after each wake);
/// - the thread is gone (the upgrade fails, checked before parking again);
/// - the terminal is released or the session torn down, both of which kill the
///   command — which is an exit, so the first condition fires. Release kills
///   explicitly, just below; teardown kills through `AcpTerminal`'s `Drop`,
///   which is the only thing covering an ABRUPT teardown — `close_session`
///   drops the thread handle without ever reaching this code.
pub fn follow_terminal_output(
    thread: AcpThreadHandle,
    terminal: Arc<CommandTerminal>,
    terminal_id: acp::TerminalId,
) {
    let thread = Arc::downgrade(&thread);
    tokio::spawn(async move {
        loop {
            // Nothing left to report to: stop before parking on a command whose
            // output no longer has a reader.
            let Some(alive) = thread.upgrade() else { return };
            drop(alive);

            terminal.output_changed().await;

            let Some(alive) = thread.upgrade() else { return };
            lock(&alive).note_terminal_output(&terminal_id);
            drop(alive);

            if terminal.exit_status().is_some() {
                // One last report AFTER the exit was observed: the final append
                // and the exit signal can arrive together, and the wake above
                // may have read the buffer a moment before the last write
                // landed.
                if let Some(alive) = thread.upgrade() {
                    lock(&alive).note_terminal_output(&terminal_id);
                }
                return;
            }
        }
    });
}

pub fn handle_kill_terminal(
    args: acp::KillTerminalRequest,
    responder: Responder<acp::KillTerminalResponse>,
    ctx: &ClientContext,
) {
    match with_terminal(ctx, &args.session_id, &args.terminal_id, |terminal| {
        // A display-only terminal has no process of ours to kill; Zed answers
        // this with a soft no-op rather than an error, and error-for-error
        // parity matters less than an agent not seeing a failure for a kill
        // that is, in effect, already done from the client's side.
        if terminal.inner().is_none() {
            return Ok(());
        }
        terminal
            .kill()
            .map_err(|err| acp::Error::internal_error().data(err.to_string()))
    }) {
        Ok(Ok(())) => {
            let _ = responder.respond(acp::KillTerminalResponse::default());
        }
        Ok(Err(err)) | Err(err) => respond_err(responder, err),
    }
}

/// Release drops our handle on the terminal. The command is killed first: a
/// released terminal has nobody left to read its output, so leaving the process
/// running would leak it for the lifetime of the connection.
pub fn handle_release_terminal(
    args: acp::ReleaseTerminalRequest,
    responder: Responder<acp::ReleaseTerminalResponse>,
    ctx: &ClientContext,
) {
    let thread = match ctx.sessions.thread(&args.session_id) {
        Ok(thread) => thread,
        Err(err) => return respond_err(responder, err),
    };

    let mut thread = lock(&thread);
    match thread.terminals_mut().remove(&args.terminal_id) {
        Some(terminal) => {
            let _ = terminal.kill();
            drop(thread);
            let _ = responder.respond(acp::ReleaseTerminalResponse::default());
        }
        None => {
            drop(thread);
            respond_err(responder, unknown_terminal(&args.terminal_id))
        }
    }
}

pub fn handle_terminal_output(
    args: acp::TerminalOutputRequest,
    responder: Responder<acp::TerminalOutputResponse>,
    ctx: &ClientContext,
) {
    let result = with_terminal(ctx, &args.session_id, &args.terminal_id, |terminal| {
        terminal.current_output()
    });
    respond_result(responder, result);
}

pub fn handle_wait_for_terminal_exit(
    args: acp::WaitForTerminalExitRequest,
    responder: Responder<acp::WaitForTerminalExitResponse>,
    ctx: &ClientContext,
) {
    // Clone the PTY handle out from under the lock: waiting for a build to
    // finish must not hold the thread mutex — or the dispatch queue. Agents
    // poll `terminal/output` WHILE waiting for the exit, and those polls
    // arrive on the same wire this wait used to block.
    let inner = match with_terminal(ctx, &args.session_id, &args.terminal_id, |terminal| {
        terminal.inner().cloned()
    }) {
        Ok(Some(inner)) => inner,
        // Display-only: the agent owns the process — it announced this
        // terminal through `terminal_info` meta and reports the exit the same
        // way. There is nothing on our side to await.
        Ok(None) => {
            return respond_err(
                responder,
                acp::Error::invalid_params().data(format!(
                    "terminal {} is agent-owned (display-only); its exit arrives as terminal_exit meta",
                    args.terminal_id
                )),
            )
        }
        Err(err) => return respond_err(responder, err),
    };

    let cancellation = responder.cancellation();
    tokio::spawn(async move {
        let result = cancellation
            .run_until_cancelled(async move {
                Ok(atlas_acp_thread::exit_status_from_command(
                    inner.wait_for_exit().await,
                ))
            })
            .await;

        respond_result(
            responder,
            result.map(acp::WaitForTerminalExitResponse::new),
        );
    });
}

fn unknown_terminal(terminal_id: &acp::TerminalId) -> acp::Error {
    acp::Error::internal_error().data(format!("unknown terminal: {terminal_id}"))
}

fn with_terminal<R>(
    ctx: &ClientContext,
    session_id: &acp::SessionId,
    terminal_id: &acp::TerminalId,
    f: impl FnOnce(&atlas_acp_thread::AcpTerminal) -> R,
) -> Result<R, acp::Error> {
    let thread: Arc<Mutex<AcpThread>> = ctx.sessions.thread(session_id)?;
    let thread = lock(&thread);
    let terminal = thread
        .terminal(terminal_id)
        .ok_or_else(|| unknown_terminal(terminal_id))?;
    Ok(f(terminal))
}
