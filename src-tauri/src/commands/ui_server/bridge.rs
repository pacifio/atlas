//! One UI action's round trip: Rust asks the window, the window answers.
//!
//! The elicitation pattern (`atlas-acp-thread`'s `elicitation.rs`): a
//! one-shot reply parked under a request id, the request emitted to the
//! webview, the answer delivered by a command. Every way it can go wrong —
//! the emit fails, the window never answers, the reply is dropped — ends in
//! an error the model can read, so a tool call never hangs a turn.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::oneshot;
use uuid::Uuid;

/// How long the window has to answer. The frontend gives itself less, so a
/// slow action reports its own error before this one fires.
pub const UI_ACTION_TIMEOUT: Duration = Duration::from_secs(10);

/// One UI action, as the window receives it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiRequest {
    pub request_id: Uuid,
    /// The calling session; the window uses it to find the session's chat
    /// tab (who answers, which tab "my chat" means).
    pub session_id: String,
    pub agent: String,
    /// The session's working directory; relative paths resolve against it.
    pub cwd: String,
    pub tool: String,
    /// The tool's arguments exactly as the model sent them.
    pub args: Value,
}

/// The window's answer. `result` goes to the model verbatim.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiReply {
    pub ok: bool,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<String>,
}

/// Sends a request to the window; `Err` when it could not be sent. A seam, so
/// the bridge is tested without a Tauri app.
pub type UiEmitter = Arc<dyn Fn(&UiRequest) -> Result<(), String> + Send + Sync>;

pub struct UiBridge {
    pending: Mutex<HashMap<Uuid, oneshot::Sender<UiReply>>>,
    emit: UiEmitter,
    timeout: Duration,
}

impl UiBridge {
    pub fn new(emit: UiEmitter) -> Self {
        Self::with_timeout(emit, UI_ACTION_TIMEOUT)
    }

    pub fn with_timeout(emit: UiEmitter, timeout: Duration) -> Self {
        Self { pending: Mutex::new(HashMap::new()), emit, timeout }
    }

    /// Send `request` to the window and wait for its answer.
    pub async fn request(&self, request: UiRequest) -> Result<UiReply, String> {
        let id = request.request_id;
        let (tx, rx) = oneshot::channel();
        // Parked BEFORE the emit, so an answer that comes back synchronously
        // finds someone waiting.
        self.pending.lock().insert(id, tx);
        if let Err(e) = (self.emit)(&request) {
            self.pending.lock().remove(&id);
            return Err(format!("Atlas window unavailable: {e}"));
        }
        match tokio::time::timeout(self.timeout, rx).await {
            Ok(Ok(reply)) => Ok(reply),
            Ok(Err(_)) => Err("Atlas dropped the request".to_string()),
            Err(_) => {
                self.pending.lock().remove(&id);
                Err(format!("Atlas did not answer within {} s", self.timeout.as_secs_f32()))
            }
        }
    }

    /// Send `request` and read the answer as a tool reads it: the window's
    /// result, or the words the model is told — the window's own refusal, or
    /// why it never answered. The one reading both servers that cross to the
    /// window use (the UI tool server, and the organisation tool server's
    /// window tools), so a refusal reads the same from either.
    pub async fn perform(&self, request: UiRequest) -> Result<Value, String> {
        match self.request(request).await {
            Ok(reply) if reply.ok => Ok(reply.result.unwrap_or_else(|| Value::Object(Default::default()))),
            Ok(reply) => Err(reply.error.unwrap_or_else(|| "the Atlas window refused the action".to_string())),
            Err(e) => Err(e),
        }
    }

    /// Deliver the window's answer. `false` for an id nobody is waiting on.
    pub fn respond(&self, request_id: Uuid, reply: UiReply) -> bool {
        match self.pending.lock().remove(&request_id) {
            Some(tx) => tx.send(reply).is_ok(),
            None => false,
        }
    }

    #[cfg(test)]
    pub(super) fn pending_len(&self) -> usize {
        self.pending.lock().len()
    }
}
