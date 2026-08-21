//! The debug tap — ported from `zed-ref/crates/agent_servers/src/acp.rs:49-250`.
//!
//! Every line in both directions, plus the agent's stderr, is recorded here.
//! Two jobs, and the second is the load-bearing one:
//!
//! 1. It backs a debug view of the live JSON-RPC conversation.
//! 2. It retains the agent's **trailing stderr**, which is what turns a bare
//!    "process exited" into a `LoadError::Exited` carrying the reason. An agent
//!    that dies on a missing binary or a bad API key says so on stderr and
//!    nowhere else; without this the user gets an exit code and no explanation.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::v1 as acp;

/// Zed's cap, kept as-is. A chatty agent must not grow this without bound.
const MAX_DEBUG_BACKLOG_MESSAGES: usize = 2000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AcpDebugMessageDirection {
    Incoming,
    Outgoing,
    Stderr,
}

#[derive(Clone, Debug)]
pub enum AcpDebugMessageContent {
    Request {
        id: acp::RequestId,
        method: Arc<str>,
        params: Option<serde_json::Value>,
    },
    Response {
        id: acp::RequestId,
        result: Result<Option<serde_json::Value>, acp::Error>,
    },
    Notification {
        method: Arc<str>,
        params: Option<serde_json::Value>,
    },
    Stderr {
        line: Arc<str>,
    },
}

#[derive(Clone, Debug)]
pub struct AcpDebugMessage {
    pub direction: AcpDebugMessageDirection,
    pub message: AcpDebugMessageContent,
}

impl AcpDebugMessage {
    fn parse_line(direction: AcpDebugMessageDirection, line: &str) -> Vec<Self> {
        if direction == AcpDebugMessageDirection::Stderr {
            return vec![Self {
                direction,
                message: AcpDebugMessageContent::Stderr {
                    line: Arc::from(line),
                },
            }];
        }

        let Ok(value) = serde_json::from_str(line) else {
            return Vec::new();
        };

        // A single line can carry a JSON-RPC batch.
        match value {
            serde_json::Value::Array(entries) => entries
                .into_iter()
                .filter_map(|entry| Self::parse_value(direction, entry))
                .collect(),
            value => Self::parse_value(direction, value).into_iter().collect(),
        }
    }

    fn parse_value(direction: AcpDebugMessageDirection, value: serde_json::Value) -> Option<Self> {
        let object = value.as_object()?;

        let parsed_id = object
            .get("id")
            .map(|raw| serde_json::from_value::<acp::RequestId>(raw.clone()));

        // `method` + `id` is a request; `method` alone is a notification;
        // `id` alone is a response.
        let message = if let Some(method) = object.get("method").and_then(|method| method.as_str()) {
            match parsed_id {
                Some(Ok(id)) => AcpDebugMessageContent::Request {
                    id,
                    method: method.into(),
                    params: object.get("params").cloned(),
                },
                Some(Err(err)) => {
                    tracing::warn!("skipping JSON-RPC message with unparsable id: {err}");
                    return None;
                }
                None => AcpDebugMessageContent::Notification {
                    method: method.into(),
                    params: object.get("params").cloned(),
                },
            }
        } else if let Some(parsed_id) = parsed_id {
            let id = match parsed_id {
                Ok(id) => id,
                Err(err) => {
                    tracing::warn!("skipping JSON-RPC response with unparsable id: {err}");
                    return None;
                }
            };

            if let Some(error) = object.get("error") {
                let acp_error =
                    serde_json::from_value::<acp::Error>(error.clone()).unwrap_or_else(|err| {
                        tracing::warn!("failed to deserialize ACP error: {err}");
                        acp::Error::internal_error().data(error.to_string())
                    });
                AcpDebugMessageContent::Response {
                    id,
                    result: Err(acp_error),
                }
            } else {
                AcpDebugMessageContent::Response {
                    id,
                    result: Ok(object.get("result").cloned()),
                }
            }
        } else {
            return None;
        };

        Some(Self { direction, message })
    }
}

#[derive(Default)]
struct AcpDebugLogState {
    messages: VecDeque<AcpDebugMessage>,
    subscribers: Vec<tokio::sync::mpsc::UnboundedSender<AcpDebugMessage>>,
}

#[derive(Clone, Default)]
pub struct AcpDebugLog {
    state: Arc<Mutex<AcpDebugLogState>>,
}

impl AcpDebugLog {
    pub fn new() -> Self {
        Self::default()
    }

    /// Hands back everything recorded so far plus a live feed, so a debug view
    /// opened mid-session still shows how the conversation got here.
    pub fn subscribe(
        &self,
    ) -> (
        Vec<AcpDebugMessage>,
        tokio::sync::mpsc::UnboundedReceiver<AcpDebugMessage>,
    ) {
        let mut state = self.lock();
        let backlog = state.messages.iter().cloned().collect();
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
        state.subscribers.push(sender);
        (backlog, receiver)
    }

    pub fn record_line(&self, direction: AcpDebugMessageDirection, line: &str) {
        let messages = AcpDebugMessage::parse_line(direction, line);
        if messages.is_empty() {
            return;
        }
        self.record_messages(messages);
    }

    fn record_messages(&self, messages: Vec<AcpDebugMessage>) {
        let mut state = self.lock();

        state.subscribers.retain(|sender| !sender.is_closed());
        for message in messages {
            if state.messages.len() == MAX_DEBUG_BACKLOG_MESSAGES {
                state.messages.pop_front();
            }
            state.messages.push_back(message.clone());

            for sender in &state.subscribers {
                let _ = sender.send(message.clone());
            }
        }
    }

    /// The run of stderr lines at the very end of the log.
    ///
    /// Deliberately only the *trailing* run: an agent that logged warnings
    /// early and then died has a final burst that explains the death, and
    /// splicing in the earlier noise would bury it.
    pub fn trailing_stderr(&self) -> Option<String> {
        let state = self.lock();
        let mut lines = state
            .messages
            .iter()
            .rev()
            .take_while(|message| matches!(&message.message, AcpDebugMessageContent::Stderr { .. }))
            .filter_map(|message| match &message.message {
                AcpDebugMessageContent::Stderr { line } if !line.is_empty() => Some(line.as_ref()),
                _ => None,
            })
            .collect::<Vec<_>>();

        if lines.is_empty() {
            return None;
        }

        lines.reverse();
        Some(lines.join("\n"))
    }

    /// A poisoned lock here means a panic while recording a debug line, which
    /// must not take the connection down with it.
    fn lock(&self) -> std::sync::MutexGuard<'_, AcpDebugLogState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}
