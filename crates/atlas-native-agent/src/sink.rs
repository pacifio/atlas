//! Rendering the runtime's events into a thread.
//!
//! The runtime emits `atlas_cersei::NativeEvent`; this is where those become
//! entries on an `AcpThread`. It is the native counterpart of
//! `atlas_agent_servers::handlers` — same job, no JSON-RPC in between.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::{
    AcpThread, AuthorizationKind, ContextCompactionId, ContextCompactionStatus, PermissionOptions,
    RequestPermissionOutcome, RetryStatus, SessionCost, TokenUsage,
};
use atlas_cersei::{
    AgentId as NativeAgentId, CerseiRuntime, NativeEvent, NativeEventSink, PermissionDecision,
    PermissionOptionKind, PermissionOptionSpec, PermissionToolCall, SessionId as NativeSessionId,
};

/// A native-agent-only event, for the things the thread model has no place for.
///
/// Only tool-output compression savings so far: an Atlas-specific statistic
/// with no protocol representation and no timeline entry. It reaches the host
/// here rather than being dropped.
#[derive(Debug, Clone)]
pub enum NativeSessionEvent {
    CompressionSaved {
        session_id: acp::SessionId,
        saved_tokens: u64,
    },
}

/// The threads a connection is serving, keyed by session id.
///
/// Weak, for the reason `atlas_agent_servers::AcpSession` gives: a thread the
/// host dropped must not stay alive because a session table still lists it.
#[derive(Default)]
pub struct NativeSessions {
    sessions: Mutex<HashMap<acp::SessionId, NativeSessionState>>,
}

pub struct NativeSessionState {
    pub thread: Weak<Mutex<AcpThread>>,
    pub cwd: String,
    /// The runtime's four permission modes, in the protocol's own shape.
    /// `None` if it reported a blob this protocol version cannot read.
    pub modes: Option<Arc<Mutex<acp::SessionModeState>>>,
    /// How many handles are open. The session is only really closed at zero,
    /// matching the external connection's `close_session`.
    pub ref_count: usize,
}

impl NativeSessions {
    pub fn insert(&self, session_id: acp::SessionId, state: NativeSessionState) {
        self.lock().insert(session_id, state);
    }

    pub fn thread(&self, session_id: &acp::SessionId) -> Option<Arc<Mutex<AcpThread>>> {
        self.lock()
            .get(session_id)
            .and_then(|state| state.thread.upgrade())
    }

    pub fn with_session<R>(
        &self,
        session_id: &acp::SessionId,
        f: impl FnOnce(&mut NativeSessionState) -> R,
    ) -> Option<R> {
        self.lock().get_mut(session_id).map(f)
    }

    /// Adds a handle to an already-open session, if there is one.
    pub fn acquire(&self, session_id: &acp::SessionId) -> Option<Arc<Mutex<AcpThread>>> {
        let mut sessions = self.lock();
        let state = sessions.get_mut(session_id)?;
        let thread = state.thread.upgrade()?;
        state.ref_count += 1;
        Some(thread)
    }

    /// `Some(remaining)` when the session is known, after decrementing.
    pub fn release(&self, session_id: &acp::SessionId) -> Option<usize> {
        let mut sessions = self.lock();
        let state = sessions.get_mut(session_id)?;
        state.ref_count = state.ref_count.saturating_sub(1);
        let remaining = state.ref_count;
        if remaining == 0 {
            sessions.remove(session_id);
        }
        Some(remaining)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<acp::SessionId, NativeSessionState>> {
        self.sessions.lock().unwrap_or_else(|p| p.into_inner())
    }
}

pub fn to_acp_session_id(id: &NativeSessionId) -> acp::SessionId {
    acp::SessionId::new(id.as_str())
}

pub fn to_native_session_id(id: &acp::SessionId) -> NativeSessionId {
    NativeSessionId::new(id.to_string())
}

fn to_acp_permission_option(option: &PermissionOptionSpec) -> acp::PermissionOption {
    let kind = match option.kind {
        PermissionOptionKind::AllowOnce => acp::PermissionOptionKind::AllowOnce,
        PermissionOptionKind::AllowAlways => acp::PermissionOptionKind::AllowAlways,
        PermissionOptionKind::RejectOnce => acp::PermissionOptionKind::RejectOnce,
    };
    acp::PermissionOption::new(option.id, option.name, kind)
}

/// The tool call a permission prompt is about, as the thread wants it.
pub fn to_acp_tool_call(call: &PermissionToolCall) -> acp::ToolCallUpdate {
    let v = serde_json::json!({
        "toolCallId": call.id,
        "title": call.title,
        "kind": call.kind,
        "status": "pending",
        "rawInput": call.raw_input,
    });
    serde_json::from_value(v).unwrap_or_else(|_| {
        acp::ToolCallUpdate::new(call.id.clone(), acp::ToolCallUpdateFields::default())
    })
}

/// How the user's answer goes back to the runtime.
///
/// Every outcome that is not an explicit choice — the turn moved on, the thread
/// went away, the user pressed stop — is `Cancelled`, which the runtime turns
/// into a denial. Nothing may leave the tool blocked.
fn to_native_decision(outcome: RequestPermissionOutcome) -> PermissionDecision {
    match outcome {
        RequestPermissionOutcome::Selected(selected) => PermissionDecision::Selected {
            option_id: selected.option_id.to_string(),
        },
        RequestPermissionOutcome::Cancelled
        | RequestPermissionOutcome::InterruptedByFollowUp => PermissionDecision::Cancelled,
    }
}

/// The sink the runtime is spawned with.
pub struct ThreadSink {
    pub sessions: Arc<NativeSessions>,
    pub runtime: CerseiRuntime,
    pub native_events: tokio::sync::broadcast::Sender<NativeSessionEvent>,
}

impl NativeEventSink for ThreadSink {
    fn emit(&self, agent_id: NativeAgentId, event: NativeEvent, _turn: Option<u64>) {
        // The turn stamp is the old stack's answer to out-of-order delivery
        // through a shared actor mailbox. Here every event is applied to the
        // thread synchronously on the turn's own task, in order, so there is no
        // window for a superseded turn's straggler to arrive late.
        match event {
            NativeEvent::SessionUpdate { session_id, update } => {
                let session_id = to_acp_session_id(&session_id);
                let Some(thread) = self.sessions.thread(&session_id) else {
                    return;
                };
                let update = match serde_json::from_value::<acp::SessionUpdate>(update) {
                    Ok(update) => update,
                    Err(e) => {
                        tracing::warn!(
                            target: "atlas_native_agent::sink",
                            "session update decode failed: {e}"
                        );
                        return;
                    }
                };
                let result = lock(&thread).handle_session_update(update);
                if let Err(e) = result {
                    tracing::warn!(
                        target: "atlas_native_agent::sink",
                        "session update rejected: {e}"
                    );
                }
            }
            NativeEvent::PermissionRequest {
                request_id,
                session_id,
                tool_call,
                options,
            } => {
                let session_id = to_acp_session_id(&session_id);
                let Some(thread) = self.sessions.thread(&session_id) else {
                    return;
                };
                let options = PermissionOptions::Flat(
                    options.iter().map(to_acp_permission_option).collect(),
                );

                // Take the waiter out under the lock, then await it on its own
                // task — the prompt stays open for as long as the user takes,
                // and this sink call must not block the turn's event loop.
                let waiter = lock(&thread).request_tool_call_authorization(
                    to_acp_tool_call(&tool_call),
                    options,
                    AuthorizationKind::PermissionGrant,
                );
                let waiter = match waiter {
                    Ok(waiter) => waiter,
                    Err(e) => {
                        tracing::warn!(
                            target: "atlas_native_agent::sink",
                            "permission request rejected: {e}"
                        );
                        // The runtime is blocked on this id; denying is the only
                        // safe answer we can still give.
                        let _ = self.runtime.respond_permission(
                            agent_id,
                            request_id,
                            PermissionDecision::Cancelled,
                        );
                        return;
                    }
                };

                let runtime = self.runtime.clone();
                tokio::spawn(async move {
                    let decision = to_native_decision(waiter.await);
                    let _ = runtime.respond_permission(agent_id, request_id, decision);
                });
            }
            NativeEvent::Usage {
                session_id,
                input_tokens,
                output_tokens,
                cost,
            } => {
                let session_id = to_acp_session_id(&session_id);
                let Some(thread) = self.sessions.thread(&session_id) else {
                    return;
                };
                let mut thread = lock(&thread);
                // `max_tokens` / `used_tokens` describe context pressure, which
                // the runtime does not report; leaving them zero is what keeps
                // the thread's `ratio()` out of the warning state rather than
                // inventing a window size.
                thread.update_token_usage(Some(TokenUsage {
                    input_tokens,
                    output_tokens,
                    ..Default::default()
                }));
                if let Some(amount) = cost {
                    thread.update_cost(Some(SessionCost {
                        amount,
                        currency: "USD".into(),
                    }));
                }
            }
            NativeEvent::Compaction { session_id, active } => {
                let session_id = to_acp_session_id(&session_id);
                let Some(thread) = self.sessions.thread(&session_id) else {
                    return;
                };
                // One entry per session: the runtime compacts a session's
                // context, and a second compaction updates the same row rather
                // than stacking a new one.
                let id = ContextCompactionId(session_id.to_string().into());
                let status = if active {
                    ContextCompactionStatus::InProgress
                } else {
                    ContextCompactionStatus::Completed
                };
                lock(&thread).upsert_context_compaction(id, status);
            }
            NativeEvent::CompressionSaved {
                session_id,
                saved_tokens,
            } => {
                // Broadcast, not a thread entry: it is a statistic about the
                // turn, not something that happened in the conversation. A
                // send with no subscribers is not an error.
                let _ = self.native_events.send(NativeSessionEvent::CompressionSaved {
                    session_id: to_acp_session_id(&session_id),
                    saved_tokens,
                });
            }
            NativeEvent::Retry {
                session_id,
                attempt,
                max_attempts,
                delay_ms,
                last_error,
            } => {
                let session_id = to_acp_session_id(&session_id);
                let Some(thread) = self.sessions.thread(&session_id) else {
                    return;
                };
                lock(&thread).report_retry(RetryStatus {
                    last_error: last_error.into(),
                    attempt: attempt as usize,
                    max_attempts: max_attempts as usize,
                    started_at: std::time::Instant::now(),
                    duration: std::time::Duration::from_millis(delay_ms),
                    meta: None,
                });
            }
        }
    }
}

pub(crate) fn lock(thread: &Arc<Mutex<AcpThread>>) -> std::sync::MutexGuard<'_, AcpThread> {
    thread.lock().unwrap_or_else(|p| p.into_inner())
}
