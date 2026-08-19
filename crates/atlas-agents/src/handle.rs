//! The per-session handle the manager holds.
//!
//! Every session is driven by a single-owner [`crate::actor::SessionActor`].
//! `SessionHandle` gives the manager (and the event-routing path) access to the
//! shared session state and a way to reach the actor — user intents go to its
//! control channel, inbound agent events to its stream channel.

use std::sync::Arc;

use agent_client_protocol::schema::v1::SessionId;
use atlas_acp::{AcpEvent, AgentId, ContentBlock, PermissionDecision};
use parking_lot::Mutex;
use uuid::Uuid;

use crate::actor::{ActorHandle, ActorMsg, Control};
use crate::error::{Error, Result};
use crate::session::SessionState;

pub struct SessionHandle {
    pub state: Arc<Mutex<SessionState>>,
    pub agent_id: AgentId,
    pub acp_session_id: SessionId,
    pub plugin_id: String,
    pub actor: ActorHandle,
}

impl SessionHandle {
    fn control(&self, c: Control) -> Result<()> {
        self.actor
            .control_tx
            .send(c)
            .map_err(|_| Error::WorkerGone)
    }

    pub fn send_prompt(&self, content: Vec<ContentBlock>) -> Result<()> {
        self.control(Control::Send(content))
    }

    pub fn set_mode(&self, mode_id: String) -> Result<()> {
        self.control(Control::SetMode(mode_id))
    }

    pub fn set_model(&self, model_id: String) -> Result<()> {
        self.control(Control::SetModel(model_id))
    }

    pub fn set_effort(&self, effort: String) -> Result<()> {
        self.control(Control::SetEffort(effort))
    }

    pub fn set_compress(&self, on: bool) -> Result<()> {
        self.control(Control::SetCompress(on))
    }

    pub fn cancel(&self) -> Result<()> {
        self.control(Control::Cancel)
    }

    pub fn respond_permission(&self, request_id: Uuid, decision: PermissionDecision) -> Result<()> {
        self.control(Control::RespondPermission {
            request_id,
            decision,
        })
    }

    /// Push an inbound agent event onto the actor's FIFO, where it is applied in
    /// wire order (ahead of the turn terminal). `turn` is the producing turn's
    /// stamp from the emitting backend (None = turn-agnostic, e.g. replay).
    pub fn route_event(&self, event: AcpEvent, turn: Option<u64>) {
        let _ = self.actor.stream_tx.send(ActorMsg::Acp { event, turn });
    }

    /// Post the agent-death terminal onto the actor's FIFO (ordered behind any
    /// in-flight content events). The actor fails the live turn and emits the
    /// AgentDisconnected delta itself (M5 — single terminal writer).
    pub fn route_disconnect(&self, reason: String) {
        let _ = self.actor.stream_tx.send(ActorMsg::Disconnect { reason });
    }
}
