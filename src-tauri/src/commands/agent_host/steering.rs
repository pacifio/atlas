//! The steering entry and the turn controller.
//!
//! Everything that *changes* a session from outside the agent — a prompt, a
//! stop, an answer to a permission or an elicitation, a mode, a model, a
//! config knob — enters here, once, whoever asked. The window's IPC verbs in
//! `commands/agents.rs` are one-liners onto these methods, and a remote driver
//! (Universal RC) calls the same methods with a remote [`Origin`]. So a prompt
//! is captured, transcribed, recorded in history and registered for shared
//! memory the same way whether it was typed in the window or sent from a phone,
//! and a refusal ("mode can't change mid-turn") comes back to whichever caller
//! asked.
//!
//! Before this, the send's side effects lived in the `agents_send` command,
//! above the host: a caller that went straight to the host reached the agent
//! and skipped all four.
//!
//! # The turn controller
//!
//! Each session has a [`TurnControl`]: the prompt queue, whether a turn this
//! host dispatched is still in flight, and whether the window has paused
//! draining. It lives here, in Rust, because the session does — the queue used
//! to be React state, which a remote driver could not reach and a closed tab
//! took with it.
//!
//! - **Submit** either starts a turn now ([`SubmitPolicy::Now`] — the window's
//!   direct send, which supersedes a running turn exactly as it always has) or
//!   parks the prompt behind the running turn ([`SubmitPolicy::QueueIfBusy`] —
//!   what a remote driver gets).
//! - When a dispatched turn ends, the head of the queue goes next, unless the
//!   queue is paused (the window's send gates: a resume still loading, a
//!   session live elsewhere, no AI grant, an agent switch waiting on
//!   `/remember`).
//! - **Stop** discards the queue and cancels the turn.
//! - **Send now** takes one queued prompt and runs it next, interrupting the
//!   running turn but keeping the rest of the queue.
//!
//! Every change to a queue is announced as a whole-queue `queue_changed`
//! delta, and a snapshot carries the queue too, so the window's queued-message
//! strip and any remote view are mirrors of this one list. The queue is
//! bounded ([`QUEUE_MAX`]) and each item's text is cut to
//! [`QUEUE_WIRE_TEXT_MAX`] on the wire — the full prompt stays here and is
//! what the agent is sent.
//!
//! # The seat
//!
//! Universal RC has one Driver per room, and the owner is a person like any
//! other: once they hand the seat to Ada, *only Ada* prompts — from her phone
//! — until the owner takes it back. The room's host task tells this host who
//! drives ([`AgentHost::set_remote_driver`]); while that is someone else,
//! every **local** steering verb here — submit, enqueue, send-now, mode,
//! model, config, elicitation answers — is refused with a message the
//! composer shows ("Ada is driving — take over"). Two things stay the
//! owner's whoever drives: `stop` (the master's kill switch) and answering a
//! permission card on this machine (consent for an action that runs here).
//! Remote callers never hit this gate: the relay and the room's own gate
//! (`atlas-remote-control::gate`) decide for them.
//!
//! The seat is held by a *person*, and the queue follows it (R4, "only A can
//! prompt"): only the seated person's parked prompts drain — the owner's
//! (typed here, or sent from their own phone) while the owner holds the seat,
//! the driver's alone while someone else does — and the rest wait. When the
//! seat changes hands, prompts parked by a remote principal who no longer
//! drives (kicked, superseded, released) are discarded rather than run
//! under the next driver's name; the owner's own wait.

use std::collections::VecDeque;

use atlas_acp_thread::prompt::{self, ImageAttachment, ResourceLinkSpec};
use atlas_agent_wire::{Origin, QueuedPrompt};

use super::*;

/// One prompt, as a steering caller hands it to the host.
#[derive(Debug, Clone, Default)]
pub struct Prompt {
    /// What the agent is sent. The window may have expanded mentions and
    /// appended hidden directives to what the user typed; this is the result.
    pub text: String,
    /// What a queued-message chip shows for it, and what "edit" hands back to
    /// the composer — what the user typed. `None` means `text`.
    pub display: Option<String>,
    pub images: Vec<ImageAttachment>,
    pub resource_links: Vec<ResourceLinkSpec>,
    /// An id the sender minted, echoed on the prompt's `user_message` delta so
    /// a sender that already shows the prompt can match it.
    pub client_message_id: Option<String>,
}

impl Prompt {
    /// A prompt that is only text.
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            ..Self::default()
        }
    }

    fn display_text(&self) -> &str {
        self.display.as_deref().unwrap_or(&self.text)
    }
}

/// What to do with a prompt submitted while a turn is running.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubmitPolicy {
    /// Start a turn now, superseding any running one. The window's direct
    /// send: its composer already queues while a turn runs, so a direct send
    /// is one it decided to make.
    #[default]
    Now,
    /// Start now if the session is idle and nothing is queued ahead; otherwise
    /// park it at the back of the queue. What a remote driver's prompt gets.
    QueueIfBusy,
}

/// What became of a submitted prompt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Submitted {
    /// A turn started; its deltas carry this `turn_seq`.
    Started { turn_seq: u64 },
    /// Parked; `item_id` names it to `remove_queued` / `send_now`.
    Queued { item_id: String },
}

/// A prompt on its way to the agent, as the send-path side effects see it.
pub struct PromptSent<'a> {
    pub session_id: &'a str,
    pub cwd: &'a str,
    /// The durable plugin id (`atlas-agent` for the native agent) — what
    /// capture and transcripts label a session with, never the per-process
    /// `AgentId`.
    pub plugin_id: &'a str,
    pub model: Option<&'a str>,
    /// Exactly what the agent is sent.
    pub text: &'a str,
    pub origin: &'a Origin,
}

/// The side effects every prompt has on its way to the agent: session capture,
/// Atlas's own transcript, and the shared-memory session registration.
///
/// Installed by the app at startup (`install_manager`), the way
/// [`SessionLifecycle`] is; `None` in tests that do not care. Called on every
/// dispatch — a direct send, a drained queue item, a remote prompt — before
/// the turn opens, so capture binds the turn to its prompt first.
pub trait PromptHooks: Send + Sync {
    fn prompt_sent(&self, sent: &PromptSent<'_>);
}

/// A permission prompt still open, as a snapshot hands it out: the same three
/// fields its `permission_request` delta carried.
#[derive(Debug, Clone, Serialize)]
pub struct PendingPermissionWire {
    pub request_id: Uuid,
    pub tool_call: serde_json::Value,
    pub options: serde_json::Value,
}

/// An elicitation still waiting, in its `elicitation_requested` delta's fields.
#[derive(Debug, Clone, Serialize)]
pub struct PendingElicitationWire {
    pub request_id: Uuid,
    pub mode: String,
    pub message: String,
    pub requested_schema: Option<serde_json::Value>,
    pub url: Option<String>,
}

impl From<atlas_agent_delta::PendingPermission> for PendingPermissionWire {
    fn from(p: atlas_agent_delta::PendingPermission) -> Self {
        Self {
            request_id: p.request_id,
            tool_call: p.tool_call,
            options: p.options,
        }
    }
}

impl From<atlas_agent_delta::PendingElicitation> for PendingElicitationWire {
    fn from(p: atlas_agent_delta::PendingElicitation) -> Self {
        Self {
            request_id: p.request_id,
            mode: p.mode,
            message: p.message,
            requested_schema: p.requested_schema,
            url: p.url,
        }
    }
}

/// One session's turn controller state (see the module docs).
#[derive(Debug, Default)]
pub(super) struct TurnControl {
    queue: VecDeque<QueuedItem>,
    /// The window's send gate is closed: nothing drains until it opens.
    paused: bool,
    /// The `turn_seq` of the turn this host dispatched and has not yet seen
    /// come back. [`RESERVED`] while a drain is between popping an item and
    /// starting its turn, so a second drain cannot start another.
    running: Option<u64>,
    /// `send_now` asked for the head to run next: the next drain goes ahead
    /// even if paused, once.
    force_next: bool,
}

impl TurnControl {
    pub(super) fn has_queue(&self) -> bool {
        !self.queue.is_empty()
    }
}

/// `TurnControl::running` while a drain is dispatching.
const RESERVED: u64 = u64::MAX;

/// The most prompts one session parks. A remote driver's `submit` is refused
/// past this (the window's composer queues one at a time); without a bound,
/// every `queue_changed` delta — which carries the whole queue — grows with
/// each prompt a disconnected phone keeps sending.
pub const QUEUE_MAX: usize = 16;

/// The most of a queued prompt's text that travels on `queue_changed` and in
/// a snapshot. The whole prompt stays here and is what the agent gets; the
/// chip shows the head of it.
pub const QUEUE_WIRE_TEXT_MAX: usize = 2 * 1024;

#[derive(Debug, Clone)]
struct QueuedItem {
    id: String,
    prompt: Prompt,
    origin: Origin,
}

impl QueuedItem {
    fn wire(&self) -> QueuedPrompt {
        QueuedPrompt {
            id: self.id.clone(),
            text: head_of(self.prompt.display_text(), QUEUE_WIRE_TEXT_MAX),
            origin: self.origin.clone(),
        }
    }
}

/// The first `max_bytes` of `text`, cut on a character boundary.
fn head_of(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut end = max_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

/// Who holds a session's remote-control seat when it is not this desktop's
/// account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteDriver {
    pub id: String,
    /// A display name, for the refusal and the composer.
    pub name: Option<String>,
}

impl RemoteDriver {
    fn label(&self) -> &str {
        self.name.as_deref().unwrap_or("Someone else")
    }
}

/// A session's remote-control seat, as the steering entry keeps it: whose
/// account the room is, and who drives when that is not this desktop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Seat {
    owner_id: String,
    driver: Option<RemoteDriver>,
}

impl Seat {
    /// Whether a prompt from `origin` is the seated person's: the window's
    /// composer and the owner's own remote surfaces while the owner holds the
    /// seat; the driver's remote surfaces alone while someone else does.
    fn admits(&self, origin: &Origin) -> bool {
        match (&self.driver, origin) {
            (None, Origin::Local) => true,
            (None, Origin::Remote { id, .. }) => *id == self.owner_id,
            (Some(driver), Origin::Remote { id, .. }) => *id == driver.id,
            (Some(_), Origin::Local) => false,
        }
    }

    /// Whether a parked prompt survives the seat changing to this. The
    /// owner's own prompts, typed or from their phone, always wait their
    /// turn; another remote principal's go with their seat.
    fn keeps(&self, origin: &Origin) -> bool {
        match origin {
            Origin::Local => true,
            Origin::Remote { id, .. } => {
                *id == self.owner_id || self.driver.as_ref().is_some_and(|d| d.id == *id)
            }
        }
    }
}

/// Note who steered what. Remote steering is always worth a line; the window's
/// own clicks are not.
/// Which optional per-session controls an agent advertises
/// ([`AgentHost::session_controls`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionControls {
    pub modes: bool,
    pub models: bool,
    pub config: bool,
}

fn note_steer(verb: &str, session_id: &str, origin: &Origin) {
    match origin {
        Origin::Local => tracing::debug!(target: "atlas::steering", verb, session = session_id),
        Origin::Remote { id, .. } => {
            tracing::info!(target: "atlas::steering", verb, session = session_id, remote = %id);
        }
    }
}

impl AgentHost {
    /// Install the send-path side effects (see [`PromptHooks`]).
    pub fn set_prompt_hooks(&self, hooks: Arc<dyn PromptHooks>) {
        *lock(&self.prompt_hooks) = Some(hooks);
    }

    fn prompt_hooks(&self) -> Option<Arc<dyn PromptHooks>> {
        lock(&self.prompt_hooks).clone()
    }

    // ---- the seat --------------------------------------------------------

    /// Record who holds a session's remote-control seat: `owner_id` is the
    /// room's account (this desktop's), `driver` is `Some` while someone else
    /// holds the seat and `None` when the owner does (or the room is gone).
    /// Set by the room's host task from the roster, and on the room's end.
    ///
    /// The queue follows the seat (module docs): prompts parked by a remote
    /// principal who no longer drives are discarded and the queue announced,
    /// and the seat coming back to the owner lets the window's parked prompts
    /// drain.
    pub fn set_remote_driver(
        self: &Arc<Self>,
        session_id: &str,
        owner_id: &str,
        driver: Option<RemoteDriver>,
    ) {
        let seat = Seat {
            owner_id: owner_id.to_owned(),
            driver,
        };
        {
            let mut seats = lock(&self.seats);
            if seats.get(session_id) == Some(&seat) {
                return;
            }
            seats.insert(session_id.to_owned(), seat.clone());
        }
        let pruned = {
            let mut turns = lock(&self.turns);
            match turns.get_mut(session_id) {
                Some(control) => {
                    let before = control.queue.len();
                    control.queue.retain(|item| seat.keeps(&item.origin));
                    control.queue.len() != before
                }
                None => false,
            }
        };
        if pruned {
            tracing::info!(target: "atlas::steering", session = session_id, "a former driver's queued prompts were discarded");
            self.announce_queue(session_id);
        }
        self.maybe_drain(session_id);
    }

    /// Who drives the session remotely, if not this desktop's account.
    pub fn remote_driver(&self, session_id: &str) -> Option<RemoteDriver> {
        lock(&self.seats)
            .get(session_id)
            .and_then(|seat| seat.driver.clone())
    }

    fn seat_of(&self, session_id: &str) -> Option<Seat> {
        lock(&self.seats).get(session_id).cloned()
    }

    /// Refuse local steering while someone else holds the seat. Remote
    /// origins pass: the room's gate decided for them.
    pub(super) fn seat(&self, session_id: &str, origin: &Origin) -> Result<()> {
        if !matches!(origin, Origin::Local) {
            return Ok(());
        }
        match self.remote_driver(session_id) {
            None => Ok(()),
            Some(driver) => Err(HostError::new(
                format!(
                    "{} is driving this session from remote control. Take over to steer it from here.",
                    driver.label()
                ),
                ErrorClass::Fatal,
            )),
        }
    }

    // ---- prompts ---------------------------------------------------------

    /// Submit a prompt to a session — the one way a prompt reaches an agent.
    ///
    /// Returns as soon as the turn is running (or the prompt is parked): a turn
    /// runs for minutes, and its outcome travels on the wire, not back here.
    pub fn submit(
        self: &Arc<Self>,
        key: &SessionKey,
        prompt: Prompt,
        origin: Origin,
        policy: SubmitPolicy,
    ) -> Result<Submitted> {
        note_steer("submit", &key.session_id, &origin);
        self.seat(&key.session_id, &origin)?;
        match policy {
            SubmitPolicy::Now => self
                .dispatch(&key.session_id, prompt, origin)
                .map(|turn_seq| Submitted::Started { turn_seq }),
            SubmitPolicy::QueueIfBusy => {
                let item_id = self.park(&key.session_id, prompt, origin)?;
                match self.maybe_drain(&key.session_id) {
                    Some((started, turn_seq)) if started == item_id => {
                        Ok(Submitted::Started { turn_seq })
                    }
                    _ => Ok(Submitted::Queued { item_id }),
                }
            }
        }
    }

    /// Park a prompt at the back of the queue without draining it — the
    /// window's "queue this" (typed while a turn runs, or `/queue`). It goes
    /// when the running turn ends, or when the window releases the queue.
    pub fn enqueue(&self, key: &SessionKey, prompt: Prompt, origin: Origin) -> Result<String> {
        note_steer("enqueue", &key.session_id, &origin);
        self.seat(&key.session_id, &origin)?;
        self.park(&key.session_id, prompt, origin)
    }

    /// Take a parked prompt out of the queue. `false` when it is not there
    /// (already started, or never was).
    pub fn remove_queued(&self, key: &SessionKey, item_id: &str, origin: Origin) -> Result<bool> {
        note_steer("remove_queued", &key.session_id, &origin);
        self.known_session(&key.session_id)?;
        let removed = {
            let mut turns = lock(&self.turns);
            let Some(control) = turns.get_mut(&key.session_id) else {
                return Ok(false);
            };
            let before = control.queue.len();
            control.queue.retain(|item| item.id != item_id);
            control.queue.len() != before
        };
        if removed {
            self.announce_queue(&key.session_id);
        }
        Ok(removed)
    }

    /// Discard every parked prompt, leaving any running turn alone.
    pub fn clear_queue(&self, key: &SessionKey, origin: Origin) -> Result<()> {
        note_steer("clear_queue", &key.session_id, &origin);
        self.known_session(&key.session_id)?;
        self.discard_queue(&key.session_id);
        Ok(())
    }

    /// Close (`true`) or open the queue's drain gate. Opening it starts the
    /// head now if the session is idle.
    pub fn set_queue_paused(self: &Arc<Self>, key: &SessionKey, paused: bool) -> Result<()> {
        self.known_session(&key.session_id)?;
        lock(&self.turns)
            .entry(key.session_id.clone())
            .or_default()
            .paused = paused;
        if !paused {
            self.maybe_drain(&key.session_id);
        }
        Ok(())
    }

    /// Start the head of the queue if the session is idle and not paused.
    /// Answers the turn it started, if any. Safe to call any time: busy, empty
    /// or paused is simply nothing to do.
    pub fn drain_queue(self: &Arc<Self>, key: &SessionKey) -> Result<Option<u64>> {
        self.known_session(&key.session_id)?;
        Ok(self
            .maybe_drain(&key.session_id)
            .map(|(_, turn_seq)| turn_seq))
    }

    /// Run one parked prompt next: it moves to the head, and a running turn is
    /// interrupted (the rest of the queue stays). Idle, it starts at once.
    pub fn send_now(
        self: &Arc<Self>,
        key: &SessionKey,
        item_id: &str,
        origin: Origin,
    ) -> Result<Submitted> {
        note_steer("send_now", &key.session_id, &origin);
        self.seat(&key.session_id, &origin)?;
        self.known_session(&key.session_id)?;
        let busy = {
            let mut turns = lock(&self.turns);
            let control = turns.entry(key.session_id.clone()).or_default();
            let Some(at) = control.queue.iter().position(|item| item.id == item_id) else {
                return Err(HostError::new(
                    "that prompt is no longer queued",
                    ErrorClass::Fatal,
                ));
            };
            let item = control.queue.remove(at).expect("position is in range");
            control.queue.push_front(item);
            control.force_next = true;
            control.running.is_some()
        };
        self.announce_queue(&key.session_id);
        if busy {
            // The turn's end drains the head, which is now this prompt.
            self.cancel_turn(&key.session_id);
            return Ok(Submitted::Queued {
                item_id: item_id.to_string(),
            });
        }
        match self.maybe_drain(&key.session_id) {
            Some((started, turn_seq)) if started == item_id => Ok(Submitted::Started { turn_seq }),
            _ => Ok(Submitted::Queued {
                item_id: item_id.to_string(),
            }),
        }
    }

    /// The session's queue, as the wire shows it.
    pub fn queue_of(&self, session_id: &str) -> Vec<QueuedPrompt> {
        lock(&self.turns)
            .get(session_id)
            .map(|control| control.queue.iter().map(QueuedItem::wire).collect())
            .unwrap_or_default()
    }

    /// Stop the session: discard its queue and cancel the running turn. Safe
    /// when nothing is running.
    ///
    /// Discarding is what Stop has always meant in the window — a queued
    /// message was typed for the turn being stopped. A prompt submitted after
    /// this, while the cancelled turn winds down, queues and runs as usual.
    pub fn stop(&self, key: &SessionKey, origin: Origin) -> Result<()> {
        note_steer("stop", &key.session_id, &origin);
        self.discard_queue(&key.session_id);
        self.cancel_turn(&key.session_id);
        Ok(())
    }

    fn cancel_turn(&self, session_id: &str) {
        self.manager.cancel(&acp::SessionId::new(session_id));
    }

    fn discard_queue(&self, session_id: &str) {
        let had = {
            let mut turns = lock(&self.turns);
            match turns.get_mut(session_id) {
                Some(control) => {
                    control.force_next = false;
                    let had = !control.queue.is_empty();
                    control.queue.clear();
                    had
                }
                None => false,
            }
        };
        if had {
            self.announce_queue(session_id);
        }
    }

    fn park(&self, session_id: &str, prompt: Prompt, origin: Origin) -> Result<String> {
        self.known_session(session_id)?;
        let id = format!("q-{}", Uuid::new_v4().simple());
        {
            let mut turns = lock(&self.turns);
            let control = turns.entry(session_id.to_owned()).or_default();
            if control.queue.len() >= QUEUE_MAX {
                return Err(HostError::new(
                    format!("the queue is full ({QUEUE_MAX} prompts); wait for a turn to finish"),
                    ErrorClass::Fatal,
                ));
            }
            control.queue.push_back(QueuedItem {
                id: id.clone(),
                prompt,
                origin,
            });
        }
        self.announce_queue(session_id);
        Ok(id)
    }

    /// Open the queue's drain gate for a session the window let go while it
    /// was held: with no tab there is no send gate to honour, and a remote
    /// driver's parked prompts would otherwise wait for a tab that never
    /// comes back.
    pub(super) fn unpause_queue(self: &Arc<Self>, session_id: &str) {
        let was_paused = {
            let mut turns = lock(&self.turns);
            match turns.get_mut(session_id) {
                Some(control) => std::mem::replace(&mut control.paused, false),
                None => false,
            }
        };
        if was_paused {
            tracing::info!(target: "atlas::steering", session = session_id, "held session's queue released with its tab");
        }
        self.maybe_drain(session_id);
    }

    fn announce_queue(&self, session_id: &str) {
        let queue = self.queue_of(session_id);
        self.projector
            .note_queue_changed(&acp::SessionId::new(session_id), queue);
    }

    fn known_session(&self, session_id: &str) -> Result<()> {
        if lock(&self.sessions).contains_key(session_id) {
            Ok(())
        } else {
            Err(HostError::unknown_session())
        }
    }

    /// Start the first prompt the seat admits if nothing this host dispatched
    /// is running and the queue may drain; the rest stay parked. Answers the
    /// item started and its turn.
    fn maybe_drain(self: &Arc<Self>, session_id: &str) -> Option<(String, u64)> {
        // Read before the turns lock: the seat is written under its own lock
        // and never with the turns held.
        let seat = self.seat_of(session_id);
        let (item, at) = {
            let mut turns = lock(&self.turns);
            let control = turns.get_mut(session_id)?;
            if control.running.is_some() || (control.paused && !control.force_next) {
                return None;
            }
            let at = control
                .queue
                .iter()
                .position(|item| seat.as_ref().is_none_or(|seat| seat.admits(&item.origin)))?;
            let item = control.queue.remove(at).expect("position is in range");
            control.force_next = false;
            control.running = Some(RESERVED);
            (item, at)
        };
        self.announce_queue(session_id);
        match self.dispatch(session_id, item.prompt.clone(), item.origin.clone()) {
            Ok(turn_seq) => Some((item.id, turn_seq)),
            Err(e) => {
                // Put it back where it was: a prompt that could not start (the
                // agent went away) is still what the user asked for, and the
                // window's rebind drains it.
                tracing::warn!(target: "atlas::steering", session = session_id, "queued prompt did not start: {e}");
                {
                    let mut turns = lock(&self.turns);
                    let control = turns.entry(session_id.to_owned()).or_default();
                    if control.running == Some(RESERVED) {
                        control.running = None;
                    }
                    let at = at.min(control.queue.len());
                    control.queue.insert(at, item);
                }
                self.announce_queue(session_id);
                None
            }
        }
    }

    /// A turn this host dispatched came back. If it is still the one the
    /// controller is waiting on, the queue may move.
    fn turn_returned(self: &Arc<Self>, session_id: &str, turn_seq: u64) {
        {
            let mut turns = lock(&self.turns);
            let Some(control) = turns.get_mut(session_id) else {
                return;
            };
            if control.running != Some(turn_seq) {
                // Superseded by a newer dispatch: that one's return drains.
                return;
            }
            control.running = None;
        }
        self.maybe_drain(session_id);
    }

    /// What the send path records a prompt against: the session's plugin, its
    /// directory, and the model it runs on (the user's pick, else the agent's
    /// own default — the picker's value).
    fn send_meta(&self, session_id: &str) -> Result<(String, String, Option<String>)> {
        let (plugin_id, cwd, picked) = {
            let sessions = lock(&self.sessions);
            let record = sessions
                .get(session_id)
                .ok_or_else(HostError::unknown_session)?;
            (
                record.plugin_id.clone(),
                record.cwd.clone(),
                record.current_model.clone(),
            )
        };
        let model = picked.or_else(|| self.default_model(session_id));
        Ok((plugin_id, cwd, model))
    }

    /// Start a turn: the side effects, the turn's identity, the stamp that
    /// announces the prompt, then the turn itself on a task of its own.
    fn dispatch(self: &Arc<Self>, session_id: &str, prompt: Prompt, origin: Origin) -> Result<u64> {
        let (plugin_id, cwd, model) = self.send_meta(session_id)?;

        // The side effects, before the turn opens — capture binds the turn to
        // its prompt at `note_prompt`, and a delta-only recorder would see a
        // turn with no question (`user_message` is not what they record from).
        if let Some(hooks) = self.prompt_hooks() {
            hooks.prompt_sent(&PromptSent {
                session_id,
                cwd: &cwd,
                plugin_id: &plugin_id,
                model: model.as_deref(),
                text: &prompt.text,
                origin: &origin,
            });
        }
        // `interacted_at` is the one history field the thread's own events
        // cannot supply — a queued prompt counts when it is sent, not when it
        // is typed (Zed's `update_interacted_at`).
        if let Some(history) = self.history() {
            history.note_interaction(&acp::SessionId::new(session_id), Utc::now());
        }

        let content = prompt::with_resource_links(
            prompt::compose(prompt.text, prompt.images),
            prompt.resource_links,
        );
        let acp_id = acp::SessionId::new(session_id);
        let turn_seq = {
            let mut sessions = lock(&self.sessions);
            let record = sessions
                .get_mut(session_id)
                .ok_or_else(HostError::unknown_session)?;
            record.turn_seq = record.turn_seq.wrapping_add(1);
            record.turn_seq
        };
        // Every turn start, not only the bind: the user may have switched
        // branches since the session opened, and the row should name the
        // branch the latest work ran on.
        self.refresh_branch(&acp_id, &cwd);
        // Before the turn opens, so the `status: running` that `begin_turn`
        // emits already carries this turn's identity.
        self.projector.set_turn_seq(&acp_id, turn_seq);
        // Before the manager pushes the prompt onto the thread, so its entry
        // is announced as this sender's `user_message`.
        if !content.is_empty() {
            self.projector
                .stamp_user_message(&acp_id, origin, prompt.client_message_id);
        }
        // Before the agent can write a byte of this turn to its transcript, so
        // the session watcher never mistakes that write for another process.
        self.begin_atlas_turn(session_id);
        lock(&self.turns)
            .entry(session_id.to_owned())
            .or_default()
            .running = Some(turn_seq);

        let this = self.clone();
        let session_key = session_id.to_owned();
        tauri::async_runtime::spawn(async move {
            let sent = this.manager.send(&acp_id, content).await;
            // Every way out of the turn ends it, a superseded one included:
            // each send counted itself in, so each counts itself out.
            this.end_atlas_turn(&session_key);
            if let Err(e) = sent {
                // A send that was superseded reports back late, and its failure
                // belongs to a turn that is already over. Announcing it anyway
                // stamps the error with whatever turn is current — so the
                // cancelled turn's error lands on the live one, and the chat
                // shows a failure for a turn that is still streaming. Same
                // omission as the thread's own turn guard one layer down
                // (ATL-229).
                if this.is_current_turn(&session_key, turn_seq) {
                    let message = format!("{e:#}");
                    let class = classify_message(&message);
                    this.projector.note_turn_failed(
                        &acp_id,
                        message,
                        Some(class.wire_token().to_string()),
                    );
                } else {
                    tracing::debug!(
                        session = %acp_id,
                        turn_seq,
                        "dropping a superseded turn's failure: {e:#}"
                    );
                }
            }
            this.turn_returned(&session_key, turn_seq);
        });
        Ok(turn_seq)
    }

    // ---- answers ---------------------------------------------------------

    /// Answer a permission prompt by the `request_id` its delta carried.
    ///
    /// The first answer wins; a second (the window and a remote driver racing,
    /// or a prompt the agent already withdrew) gets "not pending".
    pub fn answer_permission(
        &self,
        session_id: &str,
        request_id: Uuid,
        decision: PermissionDecision,
        origin: Origin,
    ) -> Result<()> {
        note_steer("answer_permission", session_id, &origin);
        let key = self.projector.permission_key(&request_id).ok_or_else(|| {
            HostError::new("permission request is not pending", ErrorClass::Fatal)
        })?;
        let handle = self.thread(session_id)?;
        match decision {
            PermissionDecision::Selected { option_id } => {
                // The option's kind decides what the thread does with the tool
                // call, so it is read back off the pending request rather than
                // trusted from the caller.
                let kind = pending_option_kind(&handle, &key.tool_call_id, &option_id).ok_or_else(
                    || HostError::new("permission option is not offered", ErrorClass::Fatal),
                )?;
                lock_thread(&handle).authorize_tool_call(
                    key.tool_call_id,
                    SelectedPermissionOutcome::new(acp::PermissionOptionId::new(option_id), kind),
                );
            }
            PermissionDecision::Cancelled => {
                lock_thread(&handle).cancel_tool_call_authorization(&key.tool_call_id);
            }
        }
        Ok(())
    }

    /// Which session a pending permission prompt belongs to — what lets a
    /// room refuse an answer aimed at another session's prompt. `None` when
    /// nothing by that id is pending.
    pub fn permission_session(&self, request_id: Uuid) -> Option<String> {
        self.projector
            .permission_key(&request_id)
            .map(|key| key.session_id.to_string())
    }

    /// Which session a pending elicitation belongs to. `None` when nothing by
    /// that id is pending **or** it is request-scoped (a sign-in prompt,
    /// which belongs to no session and is the desktop's to answer).
    pub fn elicitation_session(&self, request_id: Uuid) -> Option<String> {
        self.projector
            .elicitation_key(&request_id)
            .map(|key| key.session_id.to_string())
    }

    /// The kind of one option on a pending permission prompt — what lets a
    /// remote gate tell a standing (`AllowAlways`) grant from a one-off before
    /// answering. `None` when the prompt or the option is not pending.
    pub fn permission_option_kind(
        &self,
        request_id: Uuid,
        option_id: &str,
    ) -> Option<acp::PermissionOptionKind> {
        let key = self.projector.permission_key(&request_id)?;
        let handle = self.thread(&key.session_id.to_string()).ok()?;
        pending_option_kind(&handle, &key.tool_call_id, option_id)
    }

    /// Answer an elicitation by the `request_id` its delta (or the sign-in
    /// event) carried. Unknown ids are a no-op: the user can answer a dialog
    /// whose agent already died.
    pub fn answer_elicitation(
        &self,
        request_id: Uuid,
        action: &str,
        content: Option<serde_json::Value>,
        origin: Origin,
    ) -> Result<()> {
        note_steer("answer_elicitation", &request_id.to_string(), &origin);
        // Connection-level first: these belong to no session, so the
        // projector has never heard of them.
        //
        // The lookup is its own statement so the `answered_by` guard is
        // DROPPED before anything else is locked. As an `if let` scrutinee it
        // would live to the end of the block, held across the manager's entry
        // mutexes and the elicitation store's — a lock order nothing else
        // takes, and one that would only ever be discovered by deadlocking.
        //
        // A request-scoped elicitation is a sign-in prompt, and sign-in stays
        // on the desktop (design review §4.4): a remote origin is refused
        // before the entry is taken, so the window can still answer it.
        let request_scoped = {
            let mut answered_by = self
                .request_elicitations
                .answered_by
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if answered_by.contains_key(&request_id) && !matches!(origin, Origin::Local) {
                return Err(HostError::new(
                    "this prompt is answered on the desktop",
                    ErrorClass::Fatal,
                ));
            }
            answered_by.remove(&request_id)
        };
        if let Some((agent_id, entry_id)) = request_scoped {
            let Some(connection) = self.manager.connection_by_agent_id(&agent_id) else {
                return Ok(());
            };
            let Some(store) = connection.request_elicitations() else {
                return Ok(());
            };
            let mut store = store
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            match elicitation_response(action, content)? {
                Some(response) => store.respond_to_elicitation(&entry_id, response),
                None => store.cancel_elicitation(&entry_id),
            }
            return Ok(());
        }
        let Some(key) = self.projector.elicitation_key(&request_id) else {
            return Ok(());
        };
        self.seat(&key.session_id.to_string(), &origin)?;
        let handle = self.thread(&key.session_id.to_string())?;
        let mut thread = lock_thread(&handle);
        match elicitation_response(action, content)? {
            Some(response) => thread.respond_to_elicitation(&key.entry_id, response),
            None => thread.cancel_elicitation(&key.entry_id),
        }
        Ok(())
    }

    // ---- per-session settings -------------------------------------------

    /// Switch the session's mode. Capability-gated on the agent advertising
    /// modes; refused mid-turn by the native agent (the running turn keeps
    /// the permissions it started with), which comes back to the caller.
    ///
    /// Announced as `mode_changed` by the host: the native agent records a
    /// mode on its connection and raises no event, so without this a mode set
    /// by one client never reached another. An ACP agent's own echo of the
    /// same mode is deduplicated by the projector.
    pub async fn set_mode(&self, key: &SessionKey, mode_id: String, origin: Origin) -> Result<()> {
        note_steer("set_mode", &key.session_id, &origin);
        self.seat(&key.session_id, &origin)?;
        let session_id = acp::SessionId::new(key.session_id.as_str());
        let connection = lock_thread(&self.thread(&key.session_id)?)
            .connection()
            .clone();
        let modes = connection
            .session_modes(&session_id)
            .ok_or_else(|| HostError::new("this agent has no session modes", ErrorClass::Fatal))?;
        modes
            .set_mode(acp::SessionModeId::new(mode_id.clone()))
            .await
            .map_err(HostError::from)?;
        self.projector
            .note_mode_changed(&session_id, mode_id, Some(origin));
        Ok(())
    }

    pub async fn set_model(
        &self,
        key: &SessionKey,
        model_id: String,
        origin: Origin,
    ) -> Result<()> {
        note_steer("set_model", &key.session_id, &origin);
        self.seat(&key.session_id, &origin)?;
        let session_id = acp::SessionId::new(key.session_id.as_str());
        let connection = lock_thread(&self.thread(&key.session_id)?)
            .connection()
            .clone();
        let selector = connection.model_selector(&session_id).ok_or_else(|| {
            HostError::new("this agent has no model selection", ErrorClass::Fatal)
        })?;
        selector
            .select_model(AgentModelId::new(model_id.clone()))
            .await
            .map_err(HostError::from)?;
        if let Some(record) = lock(&self.sessions).get_mut(&key.session_id) {
            record.current_model = Some(model_id.clone());
        }
        // The thread has no event for this, so the host announces it — with
        // who picked it, so the window's pill and a remote viewer can say so.
        self.projector
            .note_model_changed(&session_id, model_id, Some(origin));
        Ok(())
    }

    pub async fn set_config_option(
        &self,
        key: &SessionKey,
        config_id: String,
        value: serde_json::Value,
        origin: Origin,
    ) -> Result<()> {
        note_steer("set_config_option", &key.session_id, &origin);
        self.seat(&key.session_id, &origin)?;
        let session_id = acp::SessionId::new(key.session_id.as_str());
        let connection = lock_thread(&self.thread(&key.session_id)?)
            .connection()
            .clone();
        let options = connection
            .session_config_options(&session_id)
            .ok_or_else(|| HostError::new("this agent has no config options", ErrorClass::Fatal))?;
        // A bool maps to the wire's boolean form, anything else to the select
        // form — the same mapping the old stack made.
        let value = match value {
            serde_json::Value::Bool(on) => acp::SessionConfigOptionValue::boolean(on),
            // A string rides as-is; anything else is re-serialized so an agent
            // that advertised, say, a numeric option still gets its own value
            // back rather than a quoted JSON blob.
            other => acp::SessionConfigOptionValue::value_id(
                other
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| other.to_string()),
            ),
        };
        let confirmed = options
            .set_config_option(acp::SessionConfigId::new(config_id), value)
            .await
            .map_err(HostError::from)?;
        // The response is the authoritative echo — a follow-up notification is
        // optional, and most agents never send one. Discarding this list is
        // what made the effort pill snap back: the set WORKED on the agent and
        // nothing ever told the frontend (#32). Same shape as
        // `note_model_changed`, for the same reason.
        self.projector
            .note_config_options(&session_id, &confirmed, Some(origin));
        Ok(())
    }

    /// The semantic category the agent gave one of its config options —
    /// what lets a remote gate tell a thinking-level knob from a sandbox or
    /// approval switch before setting it (ADR-0002: the agent's own tag, not
    /// a table keyed by agent id). `None` when the agent lists no such option,
    /// or lists it with no category: either way it is one the gate cannot
    /// classify, and the gate treats it as owner-only.
    pub fn config_option_category(
        &self,
        key: &SessionKey,
        config_id: &str,
    ) -> Option<acp::SessionConfigOptionCategory> {
        let session_id = acp::SessionId::new(key.session_id.as_str());
        let connection = lock_thread(&self.thread(&key.session_id).ok()?)
            .connection()
            .clone();
        let options = connection.session_config_options(&session_id)?;
        options
            .config_options()
            .iter()
            .find(|option| option.id.0.as_ref() == config_id)
            .and_then(|option| option.category.clone())
    }

    /// Which per-session controls the agent advertises for `key` — the
    /// connection's word (`session_modes`, `model_selector`,
    /// `session_config_options` returning `Some`), not whether a list happens
    /// to be non-empty at this instant: a native session whose catalogue
    /// fetch failed at start still *has* model selection, and a room opened
    /// then should take a `set_model` once the catalogue is back.
    pub fn session_controls(&self, key: &SessionKey) -> Result<SessionControls> {
        let session_id = acp::SessionId::new(key.session_id.as_str());
        let connection = lock_thread(&self.thread(&key.session_id)?)
            .connection()
            .clone();
        Ok(SessionControls {
            modes: connection.session_modes(&session_id).is_some(),
            models: connection.model_selector(&session_id).is_some(),
            config: connection.session_config_options(&session_id).is_some(),
        })
    }

    // ---- holds -----------------------------------------------------------

    /// Keep a session running without needing its tab.
    ///
    /// While any hold is taken, the window dropping the session — its tab
    /// closing, its project discarded from the hot set — leaves it running:
    /// the turn goes on, the queue drains, and reopening the thread rebinds to
    /// the live session and hydrates from its snapshot. `holder` names who
    /// holds it (an RC session id, `"dev"`), so two holders release
    /// independently. Announced as `hold_changed` on the first hold.
    pub fn hold_session(&self, session_id: &str, holder: &str) -> Result<()> {
        let first = {
            let mut sessions = lock(&self.sessions);
            let record = sessions
                .get_mut(session_id)
                .ok_or_else(HostError::unknown_session)?;
            let first = record.holds.is_empty();
            record.holds.insert(holder.to_owned());
            first
        };
        if first {
            tracing::info!(target: "atlas::steering", session = session_id, holder, "session held");
            self.projector
                .note_hold_changed(&acp::SessionId::new(session_id), true);
        }
        Ok(())
    }

    /// Let go of a hold. The last one going is announced as `hold_changed`,
    /// and if the window had already let the session go meanwhile, the
    /// session is torn down now — what the window's drop would have done.
    /// Releasing a hold that is not taken, or on a session already gone, is a
    /// no-op.
    pub async fn release_session(&self, session_id: &str, holder: &str) -> Result<()> {
        let (last, window_gone) = {
            let mut sessions = lock(&self.sessions);
            let Some(record) = sessions.get_mut(session_id) else {
                return Ok(());
            };
            if !record.holds.remove(holder) {
                return Ok(());
            }
            (record.holds.is_empty(), record.released_by_window)
        };
        if !last {
            return Ok(());
        }
        tracing::info!(target: "atlas::steering", session = session_id, holder, window_gone, "session hold released");
        self.projector
            .note_hold_changed(&acp::SessionId::new(session_id), false);
        if window_gone {
            self.teardown_session(session_id).await?;
        }
        Ok(())
    }

    /// Whether any hold is keeping the session open.
    pub fn is_held(&self, session_id: &str) -> bool {
        lock(&self.sessions)
            .get(session_id)
            .is_some_and(|record| !record.holds.is_empty())
    }

    /// Held sessions with a turn this host dispatched in flight — what the
    /// sidebar shows as "working" for a held thread with no tab.
    pub(super) fn held_working_sessions(&self) -> std::collections::HashSet<String> {
        // Sessions first, then turns — the order every other reader takes.
        let sessions = lock(&self.sessions);
        let turns = lock(&self.turns);
        sessions
            .iter()
            .filter(|(_, record)| !record.holds.is_empty())
            .map(|(id, _)| id)
            .filter(|id| {
                turns
                    .get(*id)
                    .is_some_and(|control| control.running.is_some())
            })
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::fresh_host_with_native_and_sink;
    use super::*;
    use atlas_acp_thread::AgentConnection;
    use atlas_agent_servers::AgentServerDelegate;
    use atlas_agent_wire::{SessionDelta, SessionDeltaEnvelope};
    use futures::future::BoxFuture;
    use futures::FutureExt;
    use std::time::Duration;

    #[derive(Default)]
    struct Recorder(Mutex<Vec<SessionDeltaEnvelope>>);

    impl DeltaSink for Recorder {
        fn emit(&self, envelope: SessionDeltaEnvelope) {
            self.0.lock().unwrap().push(envelope);
        }
    }

    impl Recorder {
        fn deltas(&self) -> Vec<SessionDelta> {
            self.0
                .lock()
                .unwrap()
                .iter()
                .map(|e| e.delta.clone())
                .collect()
        }

        fn last_queue(&self) -> Option<Vec<String>> {
            self.deltas().into_iter().rev().find_map(|d| match d {
                SessionDelta::QueueChanged { queue } => {
                    Some(queue.into_iter().map(|q| q.text).collect())
                }
                _ => None,
            })
        }
    }

    /// A native agent whose turns run until released (or cancelled), and
    /// which remembers every prompt it was sent.
    struct GatedNative {
        session_id: &'static str,
        events: Mutex<Option<atlas_agent_servers::ThreadEventSink>>,
        prompts: Mutex<Vec<String>>,
        release: Arc<tokio::sync::Notify>,
    }

    impl GatedNative {
        fn new(session_id: &'static str) -> Arc<Self> {
            Arc::new(Self {
                session_id,
                events: Mutex::new(None),
                prompts: Mutex::new(Vec::new()),
                release: Arc::new(tokio::sync::Notify::new()),
            })
        }

        fn prompts(&self) -> Vec<String> {
            self.prompts.lock().unwrap().clone()
        }
    }

    impl AgentConnection for GatedNative {
        fn agent_id(&self) -> atlas_acp_thread::AgentId {
            atlas_acp_thread::AgentId::new(ATLAS_AGENT_ID)
        }

        fn telemetry_id(&self) -> Arc<str> {
            ATLAS_AGENT_ID.into()
        }

        fn new_session(
            self: Arc<Self>,
            work_dirs: Vec<PathBuf>,
        ) -> BoxFuture<'static, anyhow::Result<AcpThreadHandle>> {
            let session_id = acp::SessionId::new(self.session_id);
            let sink = self.events.lock().unwrap().clone().expect("connected");
            let thread = Arc::new(Mutex::new(AcpThread::new(
                session_id.clone(),
                self.clone() as Arc<dyn AgentConnection>,
                work_dirs,
                None,
                sink(&session_id),
            )));
            async move { Ok(thread) }.boxed()
        }

        fn auth_methods(&self) -> &[acp::AuthMethod] {
            &[]
        }

        fn authenticate(
            &self,
            _method: acp::AuthMethodId,
        ) -> BoxFuture<'static, anyhow::Result<()>> {
            async { Ok(()) }.boxed()
        }

        fn prompt(
            &self,
            params: acp::PromptRequest,
        ) -> BoxFuture<'static, anyhow::Result<acp::PromptResponse>> {
            self.prompts
                .lock()
                .unwrap()
                .push(prompt::flatten_text(&params.prompt));
            let release = self.release.clone();
            async move {
                release.notified().await;
                Ok(acp::PromptResponse::new(acp::StopReason::EndTurn))
            }
            .boxed()
        }

        fn cancel(&self, _session_id: &acp::SessionId) {
            self.release.notify_one();
        }

        fn into_any(self: Arc<Self>) -> Arc<dyn std::any::Any + Send + Sync> {
            self
        }
    }

    struct GatedServer(Arc<GatedNative>);

    impl AgentServer for GatedServer {
        fn agent_id(&self) -> atlas_acp_thread::AgentId {
            atlas_acp_thread::AgentId::new(ATLAS_AGENT_ID)
        }

        fn connect(
            &self,
            _delegate: AgentServerDelegate,
            options: ConnectOptions,
        ) -> BoxFuture<'static, anyhow::Result<Arc<dyn AgentConnection>>> {
            *self.0.events.lock().unwrap() = Some(options.thread_events);
            let connection = self.0.clone();
            async move { Ok(connection as Arc<dyn AgentConnection>) }.boxed()
        }

        fn into_any(self: Arc<Self>) -> Arc<dyn std::any::Any + Send + Sync> {
            self
        }
    }

    #[derive(Default)]
    struct SeenPrompts(Mutex<Vec<(String, String, Origin)>>);

    impl PromptHooks for SeenPrompts {
        fn prompt_sent(&self, sent: &PromptSent<'_>) {
            self.0.lock().unwrap().push((
                sent.plugin_id.to_string(),
                sent.text.to_string(),
                sent.origin.clone(),
            ));
        }
    }

    struct Fixture {
        host: Arc<AgentHost>,
        native: Arc<GatedNative>,
        recorder: Arc<Recorder>,
        key: SessionKey,
        dir: PathBuf,
    }

    async fn fixture(session_id: &'static str) -> Fixture {
        let native = GatedNative::new(session_id);
        let recorder = Arc::new(Recorder::default());
        let (host, dir) = fresh_host_with_native_and_sink(
            Arc::new(GatedServer(native.clone())),
            recorder.clone(),
        );
        let agent_id = host.spawn(ATLAS_AGENT_ID).await.expect("spawn").agent_id;
        let init = host
            .new_session(agent_id, dir.clone(), Vec::new())
            .await
            .expect("a session opens");
        Fixture {
            host,
            native,
            recorder,
            key: init.key,
            dir,
        }
    }

    async fn until(what: &str, check: impl Fn() -> bool) {
        for _ in 0..500 {
            if check() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("timed out waiting for {what}");
    }

    /// The room's account in these tests.
    const OWNER: &str = "user_owner";

    fn ada() -> Origin {
        Origin::Remote {
            id: "user_member".into(),
            name: Some("Ada".into()),
        }
    }

    fn ada_drives() -> Option<RemoteDriver> {
        Some(RemoteDriver {
            id: "user_member".into(),
            name: Some("Ada".into()),
        })
    }

    /// Wait for the cancelled or released turn to come back, so the next
    /// drain is the controller's and not the turn's tail.
    async fn idle(f: &Fixture) {
        let session_id = f.key.session_id.clone();
        let host = f.host.clone();
        until("the turn returned", move || {
            lock(&host.turns)
                .get(&session_id)
                .is_some_and(|c| c.running.is_none())
        })
        .await;
    }

    /// A driver who loses the seat — kicked, superseded, released — takes
    /// their parked prompts with them: nothing of theirs runs under the next
    /// driver's name, and the queue delta says so.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_former_drivers_queued_prompts_are_discarded_with_the_seat() {
        let f = fixture("s-kicked").await;
        f.host
            .set_remote_driver(&f.key.session_id, OWNER, ada_drives());
        f.host
            .submit(
                &f.key,
                Prompt::text("ada one"),
                ada(),
                SubmitPolicy::QueueIfBusy,
            )
            .expect("the driver prompts");
        until("turn one runs", || f.native.prompts().len() == 1).await;
        for text in ["ada two", "ada three"] {
            let queued = f
                .host
                .submit(&f.key, Prompt::text(text), ada(), SubmitPolicy::QueueIfBusy)
                .unwrap();
            assert!(matches!(queued, Submitted::Queued { .. }));
        }
        assert_eq!(
            f.recorder.last_queue(),
            Some(vec!["ada two".into(), "ada three".into()])
        );

        // The owner kicks Ada: the seat comes back to the owner.
        f.host.set_remote_driver(&f.key.session_id, OWNER, None);
        assert_eq!(f.recorder.last_queue(), Some(Vec::new()));
        assert!(f.host.snapshot_meta(&f.key).unwrap().queue.is_empty());

        f.native.release.notify_one();
        idle(&f).await;
        assert_eq!(f.native.prompts(), ["ada one"], "nothing of Ada's drained");
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    /// Only the seated person's prompts drain: the owner's parked prompt
    /// waits while Ada holds the seat, and goes when the seat returns. The
    /// owner's own phone counts as the owner.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_local_prompt_waits_while_a_remote_driver_holds_the_seat() {
        let f = fixture("s-wait").await;
        f.host
            .submit(
                &f.key,
                Prompt::text("one"),
                Origin::Local,
                SubmitPolicy::Now,
            )
            .unwrap();
        until("turn one runs", || f.native.prompts().len() == 1).await;
        f.host
            .enqueue(&f.key, Prompt::text("mine, later"), Origin::Local)
            .unwrap();
        // The owner's phone, while the owner drives: the owner's too.
        let owners_phone = Origin::Remote {
            id: OWNER.into(),
            name: None,
        };
        f.host
            .submit(
                &f.key,
                Prompt::text("from my phone"),
                owners_phone,
                SubmitPolicy::QueueIfBusy,
            )
            .unwrap();

        f.host
            .set_remote_driver(&f.key.session_id, OWNER, ada_drives());
        // The seat changing hands keeps the owner's prompts — typed and from
        // their phone alike — parked.
        assert_eq!(
            f.recorder.last_queue(),
            Some(vec!["mine, later".into(), "from my phone".into()])
        );
        f.host
            .submit(
                &f.key,
                Prompt::text("ada's"),
                ada(),
                SubmitPolicy::QueueIfBusy,
            )
            .unwrap();

        f.native.release.notify_one();
        until("ada's prompt ran next", || f.native.prompts().len() == 2).await;
        assert_eq!(f.native.prompts()[1], "ada's", "the driver's went first");
        f.native.release.notify_one();
        idle(&f).await;
        assert_eq!(
            f.native.prompts().len(),
            2,
            "the owner's prompts stay parked while Ada drives"
        );
        assert_eq!(
            f.recorder.last_queue(),
            Some(vec!["mine, later".into(), "from my phone".into()])
        );

        // The seat returns: the owner's prompts drain in order.
        f.host.set_remote_driver(&f.key.session_id, OWNER, None);
        until("the owner's first prompt ran", || {
            f.native.prompts().len() == 3
        })
        .await;
        assert_eq!(f.native.prompts()[2], "mine, later");
        f.native.release.notify_one();
        until("then the phone's", || f.native.prompts().len() == 4).await;
        assert_eq!(f.native.prompts()[3], "from my phone");
        f.native.release.notify_one();
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    /// The queue is bounded, and a prompt past the bound is refused in the
    /// words the room maps to `in_flight`.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_queue_is_capped() {
        let f = fixture("s-cap").await;
        f.host
            .submit(
                &f.key,
                Prompt::text("one"),
                Origin::Local,
                SubmitPolicy::Now,
            )
            .unwrap();
        until("turn one runs", || f.native.prompts().len() == 1).await;
        for n in 0..QUEUE_MAX {
            f.host
                .enqueue(&f.key, Prompt::text(format!("q{n}")), Origin::Local)
                .unwrap_or_else(|e| panic!("prompt {n} parks: {}", e.message));
        }
        let refused = f
            .host
            .submit(
                &f.key,
                Prompt::text("one too many"),
                ada(),
                SubmitPolicy::QueueIfBusy,
            )
            .unwrap_err();
        assert!(
            refused.message.contains("queue is full"),
            "{}",
            refused.message
        );
        assert_eq!(f.host.queue_of(&f.key.session_id).len(), QUEUE_MAX);
        f.host.stop(&f.key, Origin::Local).unwrap();
        idle(&f).await;
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    /// A long prompt travels whole to the agent and cut to the wire bound on
    /// `queue_changed` and in the snapshot.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_queued_prompts_text_is_cut_on_the_wire_but_sent_whole() {
        let f = fixture("s-long").await;
        f.host
            .submit(
                &f.key,
                Prompt::text("one"),
                Origin::Local,
                SubmitPolicy::Now,
            )
            .unwrap();
        until("turn one runs", || f.native.prompts().len() == 1).await;
        // Multi-byte, so the cut has a boundary to respect.
        let long = "é".repeat(QUEUE_WIRE_TEXT_MAX);
        assert!(long.len() > QUEUE_WIRE_TEXT_MAX);
        f.host
            .enqueue(&f.key, Prompt::text(long.clone()), Origin::Local)
            .unwrap();
        let on_wire = f.recorder.last_queue().unwrap().remove(0);
        assert!(on_wire.len() <= QUEUE_WIRE_TEXT_MAX, "{}", on_wire.len());
        assert!(long.starts_with(&on_wire));
        assert_eq!(
            f.host.snapshot_meta(&f.key).unwrap().queue[0].text,
            on_wire,
            "the snapshot shows the same head"
        );

        f.native.release.notify_one();
        until("the long prompt ran", || f.native.prompts().len() == 2).await;
        assert_eq!(f.native.prompts()[1], long, "the agent got all of it");
        f.native.release.notify_one();
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    #[test]
    fn the_head_of_a_text_is_cut_on_a_character_boundary() {
        assert_eq!(head_of("abc", 8), "abc");
        assert_eq!(head_of("abcdef", 3), "abc");
        // "é" is two bytes: a cut inside it steps back.
        assert_eq!(head_of("aéb", 2), "a");
        assert_eq!(head_of("aéb", 3), "aé");
    }

    /// A sign-in prompt belongs to no session and is answered on the desktop:
    /// a remote answer to one is refused and the entry stays for the window.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_request_scoped_elicitation_is_not_answerable_remotely() {
        let f = fixture("s-signin").await;
        let request_id = Uuid::new_v4();
        f.host
            .request_elicitations
            .answered_by
            .lock()
            .unwrap()
            .insert(
                request_id,
                (
                    ThreadAgentId::new(ATLAS_AGENT_ID),
                    ElicitationEntryId("e-1".into()),
                ),
            );
        assert_eq!(f.host.elicitation_session(request_id), None);
        let refused = f
            .host
            .answer_elicitation(request_id, "accept", None, ada())
            .unwrap_err();
        assert!(refused.message.contains("desktop"), "{}", refused.message);
        assert!(
            f.host
                .request_elicitations
                .answered_by
                .lock()
                .unwrap()
                .contains_key(&request_id),
            "still the window's to answer"
        );
        // The window's own answer takes it (a no-op here: no connection by
        // that agent id is open in this fixture).
        f.host
            .answer_elicitation(request_id, "accept", None, Origin::Local)
            .unwrap();
        assert!(!f
            .host
            .request_elicitations
            .answered_by
            .lock()
            .unwrap()
            .contains_key(&request_id));
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    /// A room ending — the account signed out, its credential rejected, the
    /// room closed from the web — releases the room's hold and nothing else:
    /// the session stays, and a turn in flight is not interrupted (CC-1: the
    /// remote session ends, the local one runs on).
    #[tokio::test(flavor = "multi_thread")]
    async fn ending_a_room_leaves_the_session_and_its_turn_running() {
        let f = fixture("s-room-ends").await;
        f.host.hold_session(&f.key.session_id, "rc:01ROOM").unwrap();
        f.host
            .set_remote_driver(&f.key.session_id, OWNER, ada_drives());
        f.host
            .submit(
                &f.key,
                Prompt::text("ada's"),
                ada(),
                SubmitPolicy::QueueIfBusy,
            )
            .unwrap();
        until("the turn runs", || f.native.prompts() == ["ada's"]).await;

        // What `rc::release` does when a room ends, in order.
        f.host.set_remote_driver(&f.key.session_id, OWNER, None);
        f.host
            .release_session(&f.key.session_id, "rc:01ROOM")
            .await
            .unwrap();

        assert!(
            f.host.snapshot_meta(&f.key).is_ok(),
            "the session is still here"
        );
        assert!(!f.host.is_held(&f.key.session_id));
        assert!(
            lock(&f.host.turns)
                .get(&f.key.session_id)
                .is_some_and(|c| c.running.is_some()),
            "the turn was not cancelled"
        );
        assert_eq!(f.host.remote_driver(&f.key.session_id), None);
        // The owner's composer is free again, and the agent's one prompt is
        // still the only one it got.
        f.host
            .enqueue(&f.key, Prompt::text("mine"), Origin::Local)
            .expect("the seat is the owner's");
        assert_eq!(f.native.prompts(), ["ada's"]);
        f.native.release.notify_one();
        until("then the owner's", || f.native.prompts().len() == 2).await;
        f.native.release.notify_one();
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    /// A held session the window let go has no send gate left to honour: its
    /// queue is released with the tab, so a remote driver's prompts run.
    #[tokio::test(flavor = "multi_thread")]
    async fn dropping_a_held_sessions_tab_releases_its_paused_queue() {
        let f = fixture("s-held-queue").await;
        f.host.hold_session(&f.key.session_id, "rc:room").unwrap();
        f.host.set_queue_paused(&f.key, true).unwrap();
        f.host
            .submit(
                &f.key,
                Prompt::text("ada's"),
                ada(),
                SubmitPolicy::QueueIfBusy,
            )
            .unwrap();
        assert!(f.native.prompts().is_empty(), "paused by the window's gate");

        f.host.drop_session(&f.key.session_id).await.unwrap();
        until("the parked prompt ran once the tab was gone", || {
            f.native.prompts() == ["ada's"]
        })
        .await;
        f.native.release.notify_one();
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    /// The side effects travel with the prompt into the host, whoever sent
    /// it: a remote prompt is recorded exactly like a local one.
    #[tokio::test(flavor = "multi_thread")]
    async fn every_prompt_runs_the_send_side_effects_and_is_announced() {
        let f = fixture("s-hooks").await;
        let seen = Arc::new(SeenPrompts::default());
        f.host.set_prompt_hooks(seen.clone());
        let remote = Origin::Remote {
            id: "guest:1".into(),
            name: Some("Sam".into()),
        };

        let submitted = f
            .host
            .submit(
                &f.key,
                Prompt {
                    client_message_id: Some("cm-1".into()),
                    ..Prompt::text("fix the build")
                },
                remote.clone(),
                SubmitPolicy::QueueIfBusy,
            )
            .expect("submit");
        assert!(
            matches!(submitted, Submitted::Started { .. }),
            "idle: starts now"
        );
        until("the agent got the prompt", || {
            f.native.prompts() == ["fix the build"]
        })
        .await;

        assert_eq!(
            seen.0.lock().unwrap().clone(),
            [(
                ATLAS_AGENT_ID.to_string(),
                "fix the build".to_string(),
                remote.clone()
            )]
        );
        until("the prompt is on the wire", || {
            f.recorder.deltas().iter().any(|d| {
                matches!(d, SessionDelta::UserMessage { origin, client_message_id, message }
                    if origin == &remote
                        && client_message_id.as_deref() == Some("cm-1")
                        && message.content == "fix the build")
            })
        })
        .await;
        f.native.release.notify_one();
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    /// While someone else holds the room's seat, the window's own steering is
    /// refused with their name; a remote prompt and the owner's stop still
    /// run; the seat coming back lifts the refusal.
    #[tokio::test(flavor = "multi_thread")]
    async fn local_steering_is_refused_while_a_remote_driver_holds_the_seat() {
        let f = fixture("s-seat").await;
        f.host.set_remote_driver(
            &f.key.session_id,
            OWNER,
            Some(RemoteDriver {
                id: "user_member".into(),
                name: Some("Ada".into()),
            }),
        );
        let refused = f
            .host
            .submit(
                &f.key,
                Prompt::text("mine"),
                Origin::Local,
                SubmitPolicy::Now,
            )
            .unwrap_err();
        assert!(
            refused.message.starts_with("Ada is driving"),
            "{}",
            refused.message
        );
        assert!(f
            .host
            .enqueue(&f.key, Prompt::text("later"), Origin::Local)
            .is_err());
        assert!(f
            .host
            .set_mode(&f.key, "plan".into(), Origin::Local)
            .await
            .is_err());
        assert!(f.native.prompts().is_empty(), "nothing reached the agent");

        // The driver's own prompt goes through the same entry and runs.
        f.host
            .submit(
                &f.key,
                Prompt::text("ada's"),
                Origin::Remote {
                    id: "user_member".into(),
                    name: Some("Ada".into()),
                },
                SubmitPolicy::QueueIfBusy,
            )
            .expect("the driver prompts");
        until("the agent got the driver's prompt", || {
            f.native.prompts() == ["ada's"]
        })
        .await;
        // The owner's master power is never seat-gated.
        f.host.stop(&f.key, Origin::Local).expect("stop");

        f.host.set_remote_driver(&f.key.session_id, OWNER, None);
        assert_eq!(f.host.remote_driver(&f.key.session_id), None);
        f.host
            .submit(
                &f.key,
                Prompt::text("mine"),
                Origin::Local,
                SubmitPolicy::QueueIfBusy,
            )
            .expect("the seat is back");
        until("the owner's prompt ran", || f.native.prompts().len() == 2).await;
        f.native.release.notify_one();
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    /// A prompt submitted while a turn runs waits for it, then goes next — on
    /// the wire as a queue, in Rust where a remote driver can reach it.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_prompt_submitted_mid_turn_queues_and_drains_when_it_ends() {
        let f = fixture("s-queue").await;
        f.host
            .submit(
                &f.key,
                Prompt::text("one"),
                Origin::Local,
                SubmitPolicy::Now,
            )
            .unwrap();
        until("turn one runs", || f.native.prompts().len() == 1).await;

        let queued = f
            .host
            .submit(
                &f.key,
                Prompt::text("two"),
                Origin::Local,
                SubmitPolicy::QueueIfBusy,
            )
            .unwrap();
        assert!(matches!(queued, Submitted::Queued { .. }));
        f.host
            .enqueue(&f.key, Prompt::text("three"), Origin::Local)
            .unwrap();
        assert_eq!(
            f.recorder.last_queue(),
            Some(vec!["two".into(), "three".into()])
        );
        assert_eq!(f.host.snapshot_meta(&f.key).unwrap().queue.len(), 2);

        f.native.release.notify_one();
        until("turn two runs", || f.native.prompts().len() == 2).await;
        assert_eq!(f.native.prompts()[1], "two");
        assert_eq!(f.recorder.last_queue(), Some(vec!["three".into()]));

        f.native.release.notify_one();
        until("turn three runs", || f.native.prompts().len() == 3).await;
        f.native.release.notify_one();
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    /// Stop discards the queue (the snapshot agrees with the window), and a
    /// paused queue does not drain until it is released.
    #[tokio::test(flavor = "multi_thread")]
    async fn stop_discards_the_queue_and_a_paused_queue_waits() {
        let f = fixture("s-stop").await;
        f.host
            .submit(
                &f.key,
                Prompt::text("one"),
                Origin::Local,
                SubmitPolicy::Now,
            )
            .unwrap();
        until("turn one runs", || f.native.prompts().len() == 1).await;
        for text in ["a", "b", "c"] {
            f.host
                .enqueue(&f.key, Prompt::text(text), Origin::Local)
                .unwrap();
        }
        f.host.stop(&f.key, Origin::Local).unwrap();
        assert_eq!(f.recorder.last_queue(), Some(Vec::new()));
        assert!(f.host.snapshot_meta(&f.key).unwrap().queue.is_empty());
        until("the cancelled turn returned", || {
            lock(&f.host.turns)
                .get("s-stop")
                .is_some_and(|c| c.running.is_none())
        })
        .await;
        assert_eq!(f.native.prompts().len(), 1, "nothing drained after Stop");

        f.host.set_queue_paused(&f.key, true).unwrap();
        f.host
            .enqueue(&f.key, Prompt::text("held"), Origin::Local)
            .unwrap();
        assert_eq!(f.host.drain_queue(&f.key).unwrap(), None, "paused");
        f.host.set_queue_paused(&f.key, false).unwrap();
        until("released, it runs", || f.native.prompts().len() == 2).await;
        f.native.release.notify_one();
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    /// Send-now interrupts the running turn and runs the chosen prompt next,
    /// keeping the rest of the queue.
    #[tokio::test(flavor = "multi_thread")]
    async fn send_now_runs_one_prompt_next_and_keeps_the_rest() {
        let f = fixture("s-now").await;
        f.host
            .submit(
                &f.key,
                Prompt::text("one"),
                Origin::Local,
                SubmitPolicy::Now,
            )
            .unwrap();
        until("turn one runs", || f.native.prompts().len() == 1).await;
        f.host
            .enqueue(&f.key, Prompt::text("later"), Origin::Local)
            .unwrap();
        let urgent = f
            .host
            .enqueue(&f.key, Prompt::text("urgent"), Origin::Local)
            .unwrap();

        f.host.send_now(&f.key, &urgent, Origin::Local).unwrap();
        until("the urgent prompt runs", || f.native.prompts().len() == 2).await;
        assert_eq!(f.native.prompts()[1], "urgent");
        assert_eq!(f.recorder.last_queue(), Some(vec!["later".into()]));
        f.native.release.notify_one();
        until("then the rest", || f.native.prompts().len() == 3).await;
        f.native.release.notify_one();
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    /// A held session survives the window dropping it; releasing the last
    /// hold finishes the drop.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_held_session_outlives_its_tab_until_released() {
        let f = fixture("s-hold").await;
        f.host.hold_session("s-hold", "dev").unwrap();
        assert!(f.host.snapshot_meta(&f.key).unwrap().held);

        f.host.drop_session("s-hold").await.unwrap();
        assert!(
            f.host.snapshot_meta(&f.key).is_ok(),
            "the tab closed, the session did not"
        );

        f.host.release_session("s-hold", "dev").await.unwrap();
        assert!(f.host.snapshot_meta(&f.key).is_err(), "now it is gone");
        let held: Vec<bool> = f
            .recorder
            .deltas()
            .into_iter()
            .filter_map(|d| match d {
                SessionDelta::HoldChanged { held } => Some(held),
                _ => None,
            })
            .collect();
        assert_eq!(held, [true, false]);
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    /// Reopening a held session after its tab closed claims it for the window
    /// again: releasing the hold later must not tear it down under the tab.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_reopened_held_session_is_the_windows_again() {
        let f = fixture("s-reopen").await;
        f.host.hold_session("s-reopen", "dev").unwrap();
        f.host.drop_session("s-reopen").await.unwrap();

        f.host
            .load_session(f.key.agent_id, "s-reopen".into(), f.dir.clone())
            .await
            .expect("rebinds to the live session");
        f.host.release_session("s-reopen", "dev").await.unwrap();
        assert!(
            f.host.snapshot_meta(&f.key).is_ok(),
            "still open in its tab"
        );
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    /// The snapshot's `as_of_seq` is the stream's position, and an open
    /// permission prompt comes back with it.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_snapshot_says_where_in_the_stream_it_is() {
        let f = fixture("s-seq").await;
        f.host
            .enqueue(&f.key, Prompt::text("x"), Origin::Local)
            .unwrap();
        let last_seq = f.recorder.0.lock().unwrap().last().map(|e| e.seq).unwrap();
        let snapshot = f.host.snapshot(&f.key).unwrap();
        assert!(snapshot.as_of_seq >= last_seq);
        assert!(snapshot.pending_permissions.is_empty());
        let _ = std::fs::remove_dir_all(&f.dir);
    }
}
