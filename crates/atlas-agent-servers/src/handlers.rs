//! The agent→client handler set — ported from
//! `zed-ref/crates/agent_servers/src/acp.rs:4551-5138`.
//!
//! These are the requests an agent makes *of us* mid-turn: ask the user for
//! permission, read and write files, run commands, elicit input. Zed routes
//! every one of them through a foreground dispatch queue; that queue is a GPUI
//! artifact and is not ported (see [`crate`]), so each handler here runs
//! directly on the tokio worker that received it.
//!
//! Two rules hold throughout, both ported:
//!
//! - **Every request gets exactly one response.** An unknown session is an
//!   error response, not a dropped request — an agent blocked on a request we
//!   silently discarded hangs forever.
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

pub async fn handle_request_permission(
    args: acp::RequestPermissionRequest,
    responder: Responder<acp::RequestPermissionResponse>,
    ctx: ClientContext,
) {
    let thread = match ctx.sessions.thread(&args.session_id) {
        Ok(thread) => thread,
        Err(err) => return respond_err(responder, err),
    };

    let cancellation = responder.cancellation();
    let tool_call_id = args.tool_call.tool_call_id.clone();

    // Take the waiter out under the lock, then await it outside — the prompt
    // can be open for as long as the user takes to answer.
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

    match cancellation.run_until_cancelled(async { Ok(waiter.await) }).await {
        Ok(outcome) => {
            let _ = responder.respond(acp::RequestPermissionResponse::new(outcome.into()));
        }
        Err(err) => {
            // The agent gave up on the turn; take the prompt down rather than
            // leaving the user staring at a question nobody is waiting on.
            if err.code == acp::ErrorCode::RequestCancelled {
                lock(&thread).cancel_tool_call_authorization(&tool_call_id);
            }
            respond_err(responder, err)
        }
    }
}

// ---------------------------------------------------------------- elicitation

pub async fn handle_create_elicitation(
    args: acp::CreateElicitationRequest,
    responder: Responder<acp::CreateElicitationResponse>,
    ctx: ClientContext,
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

    let cancellation = responder.cancellation();
    match cancellation.run_until_cancelled(async { Ok(waiter.await) }).await {
        Ok(response) => {
            let _ = responder.respond(response);
        }
        Err(err) => respond_err(responder, err),
    }
}

/// The agent telling us a URL elicitation finished out of band (the user
/// completed a device-code login in their browser).
///
/// Broadcast to every thread and to the connection store, because the id space
/// is the agent's and we do not know which one owns it.
pub async fn handle_complete_elicitation(
    args: acp::CompleteElicitationNotification,
    ctx: ClientContext,
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

pub async fn handle_write_text_file(
    args: acp::WriteTextFileRequest,
    responder: Responder<acp::WriteTextFileResponse>,
    ctx: ClientContext,
) {
    if let Err(err) = ctx.sessions.thread(&args.session_id) {
        return respond_err(responder, err);
    }

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
}

fn write_text_file(path: &Path, content: &str) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, content)?;
    Ok(())
}

pub async fn handle_read_text_file(
    args: acp::ReadTextFileRequest,
    responder: Responder<acp::ReadTextFileResponse>,
    ctx: ClientContext,
) {
    if let Err(err) = ctx.sessions.thread(&args.session_id) {
        return respond_err(responder, err);
    }

    let cancellation = responder.cancellation();
    let path = args.path.clone();
    let (line, limit) = (args.line, args.limit);

    let result = cancellation
        .run_until_cancelled(async move {
            tokio::task::spawn_blocking(move || read_text_file(&path, line, limit))
                .await
                .unwrap_or_else(|err| Err(anyhow::anyhow!("read task panicked: {err}")))
                .map_err(|err| acp::Error::internal_error().data(err.to_string()))
        })
        .await;

    respond_result(responder, result.map(acp::ReadTextFileResponse::new));
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

pub async fn handle_session_notification(
    notification: acp::SessionNotification,
    ctx: ClientContext,
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

    let applied = lock(&thread).handle_session_update(notification.update);
    if let Err(err) = applied {
        tracing::warn!("failed to apply session update: {err:?}");
    }
}

// ------------------------------------------------------------------- terminal

pub async fn handle_create_terminal(
    args: acp::CreateTerminalRequest,
    responder: Responder<acp::CreateTerminalResponse>,
    ctx: ClientContext,
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

    let spawned = {
        let command = args.command.clone();
        let cmd_args = args.args.clone();
        let cwd = cwd.clone();
        tokio::task::spawn_blocking(move || {
            CommandTerminal::spawn(&command, &cmd_args, &env, cwd.as_deref(), byte_limit)
        })
        .await
        .unwrap_or_else(|err| Err(anyhow::anyhow!("terminal spawn task panicked: {err}")))
    };

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
        terminal: terminal.clone(),
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
///   command — which is an exit, so the first condition fires.
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

pub async fn handle_kill_terminal(
    args: acp::KillTerminalRequest,
    responder: Responder<acp::KillTerminalResponse>,
    ctx: ClientContext,
) {
    match with_terminal(&ctx, &args.session_id, &args.terminal_id, |terminal| {
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
pub async fn handle_release_terminal(
    args: acp::ReleaseTerminalRequest,
    responder: Responder<acp::ReleaseTerminalResponse>,
    ctx: ClientContext,
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

pub async fn handle_terminal_output(
    args: acp::TerminalOutputRequest,
    responder: Responder<acp::TerminalOutputResponse>,
    ctx: ClientContext,
) {
    let result = with_terminal(&ctx, &args.session_id, &args.terminal_id, |terminal| {
        terminal.current_output()
    });
    respond_result(responder, result);
}

pub async fn handle_wait_for_terminal_exit(
    args: acp::WaitForTerminalExitRequest,
    responder: Responder<acp::WaitForTerminalExitResponse>,
    ctx: ClientContext,
) {
    // Clone the PTY handle out from under the lock: waiting for a build to
    // finish must not hold the thread mutex.
    let inner = match with_terminal(&ctx, &args.session_id, &args.terminal_id, |terminal| {
        terminal.inner().clone()
    }) {
        Ok(inner) => inner,
        Err(err) => return respond_err(responder, err),
    };

    let cancellation = responder.cancellation();
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
