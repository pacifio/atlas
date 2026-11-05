//! The debug tap.
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

/// A chatty agent must not grow this without bound.
const MAX_DEBUG_BACKLOG_MESSAGES: usize = 2000;

/// Total payload bytes the ring may retain, across every message in it.
///
/// A message cap alone does not bound memory, because a message is not a
/// bounded thing: Atlas's own `fs/read_text_file` response carries the whole
/// file, and `connection.rs` tees every outgoing line in here before the write.
/// An agent reading sixty 2 MB files — the ordinary behaviour of a coding
/// agent, not an attack — parked 120 MB in this ring, and at the 2000-message
/// cap the same workload reaches gigabytes.
pub const MAX_DEBUG_BACKLOG_BYTES: usize = 4 * 1024 * 1024;

/// The largest single payload kept verbatim. Anything longer is replaced by
/// [`elided_payload`], which keeps the shape of the conversation — direction,
/// method, id, and how big the body was — and drops the body itself.
///
/// Sized so an ordinary RPC is never touched and a file transfer always is.
pub const MAX_DEBUG_MESSAGE_BYTES: usize = 16 * 1024;

/// The fixed cost of an elided message: the marker object and the envelope
/// around it. Anything variable-length the message still carries — a method
/// name, an error's own message — is measured and added, so this is a floor
/// that is enforced rather than a number that is asserted.
const ELIDED_MESSAGE_BYTES: usize = 128;

/// How much of an error's `message` survives elision. An `acp::Error` message
/// is specified as "a concise single sentence", so this is generous for a
/// well-behaved agent and a bound on one that is not.
const MAX_ERROR_MESSAGE_BYTES: usize = 1024;

/// Cut `text` to at most `max` bytes, on a character boundary.
fn truncate_on_char_boundary(text: &mut String, max: usize) {
    if text.len() <= max {
        return;
    }
    let mut cut = max;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    text.truncate(cut);
}

/// What replaces a payload too big to keep. A marker object rather than `None`,
/// so a reader can tell "there was a body, it was 2 MB" from "there was no
/// body" — the two mean different things when reading a transcript.
fn elided_payload(bytes: usize) -> serde_json::Value {
    serde_json::json!({ "atlasElided": { "bytes": bytes } })
}

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
        let message = if let Some(method) = object.get("method").and_then(|method| method.as_str())
        {
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
        } else {
            let id = match parsed_id? {
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
        };

        Some(Self { direction, message })
    }

    /// Drop the body, keep the envelope, and report what is left.
    ///
    /// `original_bytes` is the wire length this message came from, kept in the
    /// marker so a reader can see what was dropped. Stderr is the exception:
    /// its text *is* the payload and [`AcpDebugLog::trailing_stderr`] is what
    /// explains an agent's death, so an over-long line is cut to a prefix
    /// rather than replaced — the reason an agent died is at the start of what
    /// it printed, not the end.
    fn elide_payload(&mut self, original_bytes: usize) -> usize {
        match &mut self.message {
            AcpDebugMessageContent::Request { method, params, .. }
            | AcpDebugMessageContent::Notification { method, params, .. } => {
                *params = Some(elided_payload(original_bytes));
                ELIDED_MESSAGE_BYTES + method.len()
            }
            AcpDebugMessageContent::Response { result, .. } => {
                // The error arm elides too. "An error carries a message, not a
                // body" was an assumption about output an agent controls, not
                // something enforced: `data` is an unbounded `Value`, and
                // `parse_value` puts the WHOLE error object in it as a string
                // when it fails to deserialize. An oversized error line would
                // have been kept verbatim while being charged as if elided,
                // which is the one shape that defeats the budget entirely.
                match result {
                    Ok(payload) => {
                        *payload = Some(elided_payload(original_bytes));
                        ELIDED_MESSAGE_BYTES
                    }
                    Err(err) => {
                        err.data = Some(elided_payload(original_bytes));
                        truncate_on_char_boundary(&mut err.message, MAX_ERROR_MESSAGE_BYTES);
                        ELIDED_MESSAGE_BYTES + err.message.len()
                    }
                }
            }
            AcpDebugMessageContent::Stderr { line } => {
                let mut text = line.to_string();
                truncate_on_char_boundary(&mut text, MAX_DEBUG_MESSAGE_BYTES);
                *line = Arc::from(format!("{text}… [{original_bytes} bytes]"));
                line.len()
            }
        }
    }
}

/// A message plus what it costs to keep, so eviction can be driven by bytes
/// without re-measuring the payload on every insert.
struct RetainedMessage {
    message: AcpDebugMessage,
    bytes: usize,
}

#[derive(Default)]
struct AcpDebugLogState {
    messages: VecDeque<RetainedMessage>,
    subscribers: Vec<tokio::sync::mpsc::UnboundedSender<AcpDebugMessage>>,
    /// Running sum of `messages[..].bytes`, maintained on both ends.
    retained_bytes: usize,
}

impl AcpDebugLogState {
    /// The only two ways the deque changes, so the running total cannot drift
    /// away from the messages it is counting.
    fn push_back(&mut self, retained: RetainedMessage) {
        self.retained_bytes = self.retained_bytes.saturating_add(retained.bytes);
        self.messages.push_back(retained);
    }

    fn pop_front(&mut self) {
        if let Some(retained) = self.messages.pop_front() {
            self.retained_bytes = self.retained_bytes.saturating_sub(retained.bytes);
        }
    }
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
        let backlog = state
            .messages
            .iter()
            .map(|retained| retained.message.clone())
            .collect();
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
        state.subscribers.push(sender);
        (backlog, receiver)
    }

    pub fn record_line(&self, direction: AcpDebugMessageDirection, line: &str) {
        let messages = AcpDebugMessage::parse_line(direction, line);
        if messages.is_empty() {
            return;
        }

        // The wire line is the honest measure of what this costs, and it is
        // already in hand — measuring the parsed payload would mean
        // re-serialising it. A line over the cap has its body dropped here,
        // before anything retains it, and reports what it shrank to.
        //
        // A batch line charges its full length to every message in it. That
        // over-counts, which is the safe direction: the budget binds sooner,
        // never later.
        let line_bytes = line.len();
        let retained = messages
            .into_iter()
            .map(|mut message| {
                let bytes = if line_bytes > MAX_DEBUG_MESSAGE_BYTES {
                    message.elide_payload(line_bytes)
                } else {
                    line_bytes
                };
                RetainedMessage { message, bytes }
            })
            .collect();

        self.record_messages(retained);
    }

    fn record_messages(&self, messages: Vec<RetainedMessage>) {
        let mut state = self.lock();

        state.subscribers.retain(|sender| !sender.is_closed());
        for retained in messages {
            let message = retained.message.clone();
            state.push_back(retained);

            // Two caps, both enforced from the front. The message cap bounds a
            // chatty agent; the byte cap bounds a verbose one, which the
            // message cap alone never could. `len() > 1` keeps the newest
            // message even if it alone is over budget, so the ring can never
            // answer "nothing happened" to something that just did.
            while state.messages.len() > MAX_DEBUG_BACKLOG_MESSAGES
                || (state.retained_bytes > MAX_DEBUG_BACKLOG_BYTES && state.messages.len() > 1)
            {
                state.pop_front();
            }

            for sender in &state.subscribers {
                let _ = sender.send(message.clone());
            }
        }
    }

    /// What the ring is charging itself for, which is what
    /// [`MAX_DEBUG_BACKLOG_BYTES`] bounds.
    ///
    /// An estimate, deliberately biased high: a batch line charges its whole
    /// length to each message in it. Read it as "the budget's own view of the
    /// ring", not as a measurement of heap.
    pub fn retained_bytes(&self) -> usize {
        self.lock().retained_bytes
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
            .map(|retained| &retained.message)
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

    /// The stderr that explains a child process exiting.
    ///
    /// Outbound traffic is deliberately transparent here. During startup the
    /// transport can accept a connection just long enough for Atlas to record
    /// an `initialize` request after the process has already printed its
    /// failure. That request cannot invalidate what the child said; an inbound
    /// message can, because it proves the agent spoke after an earlier warning.
    pub fn exit_stderr(&self) -> Option<String> {
        let state = self.lock();
        let mut lines = Vec::new();

        for message in state
            .messages
            .iter()
            .map(|retained| &retained.message)
            .rev()
        {
            match message.direction {
                AcpDebugMessageDirection::Stderr => {
                    if let AcpDebugMessageContent::Stderr { line } = &message.message {
                        if !line.is_empty() {
                            lines.push(line.as_ref());
                        }
                    }
                }
                AcpDebugMessageDirection::Incoming => break,
                AcpDebugMessageDirection::Outgoing => {}
            }
        }

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
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}
