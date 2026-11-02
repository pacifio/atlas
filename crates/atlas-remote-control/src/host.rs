//! The host socket: one supervisor task per room, from dial to the room's end.
//!
//! # The stream
//!
//! The app registers a lossless tap on the delta pipeline and hands every
//! envelope to [`RoomHandle::offer`], which only enqueues (it runs on the emit
//! thread). The queue is bounded; when it overflows the envelope is dropped,
//! a flag is set, and the supervisor answers with `rc.resync { as_of_seq }`
//! and a fresh snapshot — never a silent gap (design review D2, §17 item 3).
//!
//! Join order, which is what makes "nothing twice, nothing missed" hold: the
//! tap is registered before this task starts; the first connect takes the
//! snapshot; every envelope at or below its `as_of_seq` is dropped, and the
//! stream continues from `as_of_seq + 1`. The same rule covers every later
//! snapshot, requested or forced.
//!
//! # The socket
//!
//! `/rc/host/ws?room=` on the artifacts handshake (`atlas.v1,
//! atlas.ticket.<jwt>`) — the room is the account's, so the ticket alone
//! names the host; keepalive 15 s ping / 45 s idle / 20 s dial (the
//! dead-host SLO, §2.1 — the artifacts default is 25/80/20). The ping is the
//! text frame `ping`: the object's runtime answers it with `pong` without
//! waking. Redial on a drop with a jittered backoff,
//! `random(0.5, 1.5) × min(1 s × 2^attempt, 30 s)`, and at once on
//! [`RoomHandle::nudge`] (a wake or a network change). Stop on `1008`
//! (revoked) and `4410` (room ended); on `4409` (a newer host socket from this
//! desktop superseded this one) stop this task only.
//!
//! # Commands
//!
//! A relayed `rc.command` is checked by [`crate::gate`] (epoch, driver,
//! capability, owner-only, widening, size), deduplicated on the last 256
//! `(from, commandId)` pairs, and run on its own task through the
//! [`SessionPort`]; its `rc.command_result` — with `fromId` — goes back within
//! 30 s whatever happens.
//!
//! # The seat
//!
//! The room's Driver arrives on the welcome and on every `rc.roster`, and is
//! reported on [`HostStatus::driver`] so the app can refuse the owner's local
//! composer while someone else drives. A visitor's `rc.control_request` is
//! kept on [`HostStatus::pending`] until it is answered or times out. The
//! owner's master powers — [`RoomHandle::take_over`],
//! [`RoomHandle::answer_control`], [`RoomHandle::grant_control`],
//! [`RoomHandle::kick`] — are control frames
//! sent on this socket (the object takes them from the host).

use std::future::Future;
use std::hash::{BuildHasher, Hasher};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use atlas_agent_wire::SessionDeltaEnvelope;
use atlas_artifacts::{Keepalive, TokenSource};
use futures_util::{Sink, SinkExt, StreamExt};
use serde::Serialize;
use tokio::sync::{mpsc, watch, Notify};
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::{Error as WsError, Message as WsMessage};

use crate::batch::{is_streamed_text, Coalescer, Pushed};
use crate::codec::snapshot_frames;
use crate::gate::{self, GateView, RecentCommands, Refusal};
use crate::rest::Scope;
use crate::wire::{
    Capability, Command, ControlRequest, ControlRequestStatus, DriverRef, EndReason, FromServer,
    Gate, Hello, HostCommand, HostCommandResult, HostHello, PrincipalRef, RefusalCode, Roster,
    ToServer, Wants, Welcome,
};
use crate::{RC_COMMAND_TIMEOUT_MS, RC_HOST_PING_MS, RC_HOST_SILENT_MS, RC_PROTOCOL_VERSION};

/// The host socket's keepalive (§7.4).
pub const HOST_KEEPALIVE: Keepalive = Keepalive {
    ping: Duration::from_millis(RC_HOST_PING_MS),
    idle: Duration::from_millis(RC_HOST_SILENT_MS),
    dial: Duration::from_secs(20),
};

/// How many envelopes may wait for the supervisor before the tap starts
/// dropping (and the room is resynced). Generous: a turn's burst while the
/// supervisor is mid-snapshot is a few hundred.
pub const QUEUE_CAPACITY: usize = 8192;

/// A command is answered well inside the object's 30 s relay timeout, so the
/// answer the remote sees is the desktop's, not "no answer".
const COMMAND_DEADLINE: Duration = Duration::from_millis(RC_COMMAND_TIMEOUT_MS - 5_000);

/// The longest a snapshot may take before the attempt is abandoned.
const SNAPSHOT_DEADLINE: Duration = Duration::from_secs(20);

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// A session snapshot: where in the stream it is, and the document.
#[derive(Debug, Clone)]
pub struct SnapshotDoc {
    pub as_of_seq: u64,
    pub document: serde_json::Value,
}

/// The session, as the room needs it. Implemented by the app over the agent
/// host's steering entry; the crate never sees Tauri.
pub trait SessionPort: Send + Sync + 'static {
    /// The session's snapshot, with `as_of_seq` and the pending prompts.
    fn snapshot(&self) -> BoxFuture<Result<SnapshotDoc, String>>;

    /// Run one command that passed the desktop's gates, as `from`.
    fn execute(&self, from: PrincipalRef, command: Command) -> BoxFuture<Result<(), Refusal>>;
}

/// The host socket's state, as the window shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkState {
    /// Dialling, or saying hello.
    Connecting,
    /// Welcomed: the room is streaming.
    Live,
    /// Dropped; redialling on the backoff.
    Offline,
    /// The room is over (closed, revoked, refused). The task has stopped.
    Ended,
}

/// What the supervisor reports on every change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    pub state: LinkState,
    /// The room's own view: is the owner's desktop (this one) connected.
    pub owner_online: bool,
    /// Distinct people watching, from the last roster.
    pub viewers: usize,
    pub driver_epoch: u64,
    /// Who holds the seat, from the last welcome or roster. `None` before the
    /// first welcome.
    pub driver: Option<DriverRef>,
    /// Control requests still open — visitors asking to drive.
    pub pending: Vec<ControlRequest>,
    /// The room's scope as the welcome named it; `None` for a solo room.
    pub scope: Option<Scope>,
    pub last_error: Option<String>,
    pub end_reason: Option<EndReason>,
}

impl HostStatus {
    /// Someone other than the owner holds the seat.
    pub fn driven_by_someone_else(&self, owner_user_id: &str) -> bool {
        self.driver.as_ref().is_some_and(|d| d.id != owner_user_id)
    }
}

impl Default for HostStatus {
    fn default() -> Self {
        Self {
            state: LinkState::Connecting,
            owner_online: false,
            viewers: 0,
            driver_epoch: 1,
            driver: None,
            pending: Vec::new(),
            scope: None,
            last_error: None,
            end_reason: None,
        }
    }
}

pub type StatusSink = Arc<dyn Fn(HostStatus) + Send + Sync>;

/// Everything one room's host needs.
#[derive(Clone)]
pub struct HostConfig {
    pub room_id: String,
    pub session_id: String,
    pub owner_user_id: String,
    /// This desktop's replica id — the one the room was created with.
    pub client_id: String,
    /// Held in memory for the room's life and never logged.
    pub host_secret: String,
    pub agent: String,
    pub model: Option<String>,
    pub capabilities: Vec<Capability>,
    /// `wss://…` (from [`atlas_artifacts::ws_base`] unless a test says otherwise).
    pub ws_base: String,
    pub keepalive: Keepalive,
    pub backoff_min: Duration,
    pub backoff_max: Duration,
    pub queue_capacity: usize,
}

impl std::fmt::Debug for HostConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostConfig")
            .field("room_id", &self.room_id)
            .field("session_id", &self.session_id)
            .field("client_id", &self.client_id)
            .field("host_secret", &"<redacted>")
            .finish_non_exhaustive()
    }
}

impl HostConfig {
    /// The defaults for production: the resolved ingest base, the RC
    /// keepalive, a 1 s – 30 s backoff.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        room_id: String,
        session_id: String,
        owner_user_id: String,
        client_id: String,
        host_secret: String,
        agent: String,
        model: Option<String>,
        capabilities: Vec<Capability>,
    ) -> Self {
        Self {
            room_id,
            session_id,
            owner_user_id,
            client_id,
            host_secret,
            agent,
            model,
            capabilities,
            ws_base: atlas_artifacts::ws_base(),
            keepalive: HOST_KEEPALIVE,
            backoff_min: Duration::from_secs(1),
            backoff_max: Duration::from_secs(30),
            queue_capacity: QUEUE_CAPACITY,
        }
    }

    fn url(&self) -> String {
        let base = format!("{}/rc/host/ws", self.ws_base.trim_end_matches('/'));
        match reqwest::Url::parse(&base) {
            Ok(mut url) => {
                url.query_pairs_mut().append_pair("room", &self.room_id);
                url.to_string()
            }
            Err(_) => format!("{base}?room={}", self.room_id),
        }
    }
}

struct Shared {
    overflowed: AtomicBool,
    overflow: Notify,
    nudge: Notify,
}

/// The app's side of one room's host task.
pub struct RoomHandle {
    session_id: String,
    queue: mpsc::Sender<SessionDeltaEnvelope>,
    shared: Arc<Shared>,
    stop: watch::Sender<bool>,
    status: Arc<Mutex<HostStatus>>,
    controls: mpsc::UnboundedSender<ToServer>,
}

impl RoomHandle {
    /// Hand the room one envelope. Never blocks: called on the emit thread.
    /// An envelope for another session is ignored; a full queue drops it and
    /// schedules a resync.
    pub fn offer(&self, envelope: &SessionDeltaEnvelope) {
        if envelope.session_id != self.session_id {
            return;
        }
        match self.queue.try_send(envelope.clone()) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(_)) => {
                if !self.shared.overflowed.swap(true, Ordering::SeqCst) {
                    self.shared.overflow.notify_one();
                }
            }
            // The task has ended; the app removes the tap when it hears so.
            Err(mpsc::error::TrySendError::Closed(_)) => {}
        }
    }

    /// Redial now if the socket is down (a wake, a network change).
    pub fn nudge(&self) {
        self.shared.nudge.notify_one();
    }

    /// End the task. The socket is closed politely; the room itself is ended
    /// by the REST close door, which the app calls.
    pub fn stop(&self) {
        let _ = self.stop.send(true);
    }

    /// The last status reported.
    pub fn status(&self) -> HostStatus {
        self.status
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Owner: take the seat back from whoever drives. A no-op at the object
    /// when the owner already holds it.
    pub fn take_over(&self) -> Result<(), String> {
        self.control(ToServer::TakeOver)
    }

    /// Owner (or the driver): answer a visitor's control request. Approving
    /// hands them the seat.
    pub fn answer_control(&self, request_id: &str, approve: bool) -> Result<(), String> {
        self.control(ToServer::ControlAnswer {
            request_id: request_id.to_owned(),
            approve,
        })
    }

    /// Owner: hand the seat to a connected principal who did not ask.
    pub fn grant_control(&self, target: &str) -> Result<(), String> {
        self.control(ToServer::GrantControl {
            target: target.to_owned(),
        })
    }

    /// Owner: cut a principal's sockets; a driver so kicked loses the seat.
    pub fn kick(&self, target: &str) -> Result<(), String> {
        self.control(ToServer::Kick {
            target: target.to_owned(),
        })
    }

    /// A control frame for the live socket. Refused while the socket is not
    /// live rather than queued: a take-over sent after a reconnect would be
    /// the answer to a seat that may have changed meanwhile.
    fn control(&self, frame: ToServer) -> Result<(), String> {
        if self.status().state != LinkState::Live {
            return Err("the room is not connected right now".into());
        }
        self.controls
            .send(frame)
            .map_err(|_| "the room has ended".to_string())
    }
}

/// A room whose queue exists but whose task has not started: what lets the
/// app register its tap *before* the first snapshot can be taken (the join
/// order in the module docs).
pub struct Unstarted {
    config: HostConfig,
    rx: mpsc::Receiver<SessionDeltaEnvelope>,
    shared: Arc<Shared>,
    stop_rx: watch::Receiver<bool>,
    status: Arc<Mutex<HostStatus>>,
    controls_rx: mpsc::UnboundedReceiver<ToServer>,
}

/// Make a room's handle and queue. Register the tap on the handle, then
/// [`Unstarted::start`] the task.
pub fn prepare(config: HostConfig) -> (RoomHandle, Unstarted) {
    let (queue, rx) = mpsc::channel(config.queue_capacity.max(1));
    let (stop, stop_rx) = watch::channel(false);
    let shared = Arc::new(Shared {
        overflowed: AtomicBool::new(false),
        overflow: Notify::new(),
        nudge: Notify::new(),
    });
    let status = Arc::new(Mutex::new(HostStatus::default()));
    let (controls, controls_rx) = mpsc::unbounded_channel();
    let handle = RoomHandle {
        session_id: config.session_id.clone(),
        queue,
        shared: shared.clone(),
        stop,
        status: status.clone(),
        controls,
    };
    (
        handle,
        Unstarted {
            config,
            rx,
            shared,
            stop_rx,
            status,
            controls_rx,
        },
    )
}

impl Unstarted {
    /// Start the host task on the current tokio runtime.
    pub fn start(
        self,
        tokens: Arc<dyn TokenSource>,
        port: Arc<dyn SessionPort>,
        on_status: StatusSink,
    ) {
        let (results_tx, results_rx) = mpsc::unbounded_channel();
        // One worker per room runs the commands that passed the gates, one
        // at a time, in the order the room relayed them: "run the tests" then
        // "now commit" must not swap, nor a stop and the submit after it. A
        // task per command would let the runtime pick their order. It ends
        // with the supervisor, which holds the only sender.
        let (commands_tx, mut commands_rx) = mpsc::unbounded_channel::<HostCommand>();
        let worker_port = port.clone();
        let worker_results = results_tx.clone();
        tokio::spawn(async move {
            while let Some(command) = commands_rx.recv().await {
                run_command(&worker_port, &worker_results, command).await;
            }
        });
        let supervisor = Supervisor {
            cfg: self.config,
            tokens,
            port,
            on_status,
            status: self.status,
            rx: self.rx,
            shared: self.shared,
            stop_rx: self.stop_rx,
            batch: Coalescer::default(),
            floor: None,
            needs_resync: false,
            recent: RecentCommands::default(),
            driver_epoch: 1,
            driver_id: String::new(),
            results_tx,
            results_rx,
            commands_tx,
            controls_rx: self.controls_rx,
        };
        tokio::spawn(supervisor.run());
    }
}

/// [`prepare`] then [`Unstarted::start`], for a caller with nothing to
/// register in between.
pub fn spawn(
    config: HostConfig,
    tokens: Arc<dyn TokenSource>,
    port: Arc<dyn SessionPort>,
    on_status: StatusSink,
) -> RoomHandle {
    let (handle, unstarted) = prepare(config);
    unstarted.start(tokens, port, on_status);
    handle
}

/// How one attempt ended.
enum Exit {
    /// The handle asked: stop without reporting an end.
    Stopped,
    /// The room is over, or this desktop may not host it: stop for good.
    Ended {
        reason: Option<EndReason>,
        error: Option<String>,
    },
    /// Another host socket from this desktop took over (`4409`): stop this
    /// task only.
    Superseded,
    /// The ticket was refused; worth one immediate re-mint.
    Unauthorized,
    /// Dropped; redial on the backoff. `live` says the attempt got as far as
    /// a welcome, which resets the backoff.
    Retry { live: bool, error: String },
}

struct Supervisor {
    cfg: HostConfig,
    tokens: Arc<dyn TokenSource>,
    port: Arc<dyn SessionPort>,
    on_status: StatusSink,
    status: Arc<Mutex<HostStatus>>,
    rx: mpsc::Receiver<SessionDeltaEnvelope>,
    shared: Arc<Shared>,
    stop_rx: watch::Receiver<bool>,
    batch: Coalescer,
    /// The newest seq the room has been given — by a delta frame or a
    /// snapshot's `as_of_seq`. `None` before the first sync.
    floor: Option<u64>,
    /// The stream lost an envelope (or one was too big to send): the next
    /// thing the room hears is `rc.resync` and a snapshot.
    needs_resync: bool,
    recent: RecentCommands,
    driver_epoch: u64,
    driver_id: String,
    results_tx: mpsc::UnboundedSender<HostCommandResult>,
    results_rx: mpsc::UnboundedReceiver<HostCommandResult>,
    /// The room's command worker: accepted commands, in relay order.
    commands_tx: mpsc::UnboundedSender<HostCommand>,
    /// The owner's control frames, from the handle.
    controls_rx: mpsc::UnboundedReceiver<ToServer>,
}

impl Supervisor {
    async fn run(mut self) {
        let mut attempt: u32 = 0;
        let mut reminted = false;
        loop {
            if *self.stop_rx.borrow() {
                return;
            }
            self.report(|s| {
                s.state = LinkState::Connecting;
            });
            let exit = match self.mint().await {
                Some(token) => self.attempt(token).await,
                None => Exit::Retry {
                    live: false,
                    error: "could not mint a token".into(),
                },
            };
            match exit {
                Exit::Stopped => return,
                Exit::Ended { reason, error } => {
                    tracing::info!(target: "atlas_rc", room = %self.cfg.room_id, ?reason, "room ended");
                    self.report(|s| {
                        s.state = LinkState::Ended;
                        s.owner_online = false;
                        s.end_reason = reason;
                        if error.is_some() {
                            s.last_error = error;
                        }
                    });
                    return;
                }
                Exit::Superseded => {
                    tracing::warn!(target: "atlas_rc", room = %self.cfg.room_id, "host socket superseded");
                    self.report(|s| {
                        s.state = LinkState::Offline;
                        s.owner_online = false;
                        s.last_error =
                            Some("another connection from this desktop took over".into());
                    });
                    return;
                }
                Exit::Unauthorized if !reminted => {
                    reminted = true;
                    continue;
                }
                Exit::Unauthorized => {
                    self.report(|s| {
                        s.state = LinkState::Offline;
                        s.owner_online = false;
                        s.last_error = Some("sign-in was refused".into());
                    });
                }
                Exit::Retry { live, error } => {
                    if live {
                        attempt = 0;
                        reminted = false;
                    }
                    tracing::info!(target: "atlas_rc", room = %self.cfg.room_id, %error, "host socket dropped");
                    self.report(|s| {
                        s.state = LinkState::Offline;
                        s.owner_online = false;
                        s.last_error = Some(error);
                    });
                }
            }
            let wait = backoff(attempt, self.cfg.backoff_min, self.cfg.backoff_max);
            attempt = attempt.saturating_add(1);
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = self.shared.nudge.notified() => { attempt = 0; }
                changed = self.stop_rx.changed() => {
                    if changed.is_err() || *self.stop_rx.borrow() { return; }
                }
            }
        }
    }

    async fn mint(&self) -> Option<String> {
        match self.tokens.mint().await {
            Ok(token) => Some(token),
            Err(e) => {
                tracing::debug!(target: "atlas_rc", "mint failed: {e}");
                None
            }
        }
    }

    fn report(&self, change: impl FnOnce(&mut HostStatus)) {
        let next = {
            let mut status = self
                .status
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let before = status.clone();
            change(&mut status);
            prune_expired(&mut status.pending, now_ms());
            if *status == before {
                return;
            }
            status.clone()
        };
        (self.on_status)(next);
    }

    /// One connection, from dial to drop.
    async fn attempt(&mut self, token: String) -> Exit {
        let request = match atlas_artifacts::ticket_request(self.cfg.url(), &token) {
            Ok(request) => request,
            Err(e) => {
                return Exit::Ended {
                    reason: None,
                    error: Some(format!("bad host socket address: {e}")),
                }
            }
        };
        let dialed = tokio::time::timeout(
            self.cfg.keepalive.dial,
            tokio_tungstenite::connect_async(request),
        )
        .await;
        let stream = match dialed {
            Ok(Ok((stream, _response))) => stream,
            // Never format the error itself: it can carry the request, and
            // the request carries the ticket.
            Ok(Err(err)) => return classify_handshake(&err),
            Err(_) => {
                return Exit::Retry {
                    live: false,
                    error: "the room did not answer".into(),
                }
            }
        };
        let (mut write, mut read) = stream.split();

        // What the room is told it has. A desktop that lost envelopes, or has
        // never synced, takes the snapshot first and says hello as of it.
        let lost = self.needs_resync || self.shared.overflowed.load(Ordering::SeqCst);
        let presync = if lost || self.floor.is_none() {
            match self.take_snapshot().await {
                Ok(snapshot) => Some(snapshot),
                Err(error) => return Exit::Retry { live: false, error },
            }
        } else {
            None
        };
        let as_of_seq = presync
            .as_ref()
            .map(|(as_of, _)| *as_of)
            .or(self.floor)
            .unwrap_or(0);
        let hello = ToServer::Hello(Hello::Host(HostHello {
            protocol: RC_PROTOCOL_VERSION,
            client_id: self.cfg.client_id.clone(),
            host_secret: Some(self.cfg.host_secret.clone()),
            as_of_seq,
            capabilities: self.cfg.capabilities.clone(),
            agent: self.cfg.agent.clone(),
            model: self.cfg.model.clone(),
        }));
        if let Err(e) = send_json(&mut write, &hello).await {
            return Exit::Retry {
                live: false,
                error: format!("hello: {e}"),
            };
        }

        // The welcome, within the dial window.
        let welcome =
            match tokio::time::timeout(self.cfg.keepalive.dial, next_welcome(&mut read)).await {
                Ok(Ok(welcome)) => welcome,
                Ok(Err(exit)) => return exit,
                Err(_) => {
                    return Exit::Retry {
                        live: false,
                        error: "no welcome from the room".into(),
                    }
                }
            };
        self.driver_epoch = welcome.driver_epoch;
        self.driver_id = welcome.driver.id.clone();
        let scope = welcome.org_id.clone().map(|org_id| Scope {
            org_id,
            workspace_id: welcome.workspace_id.clone(),
        });
        let driver = DriverRef {
            id: welcome.driver.id.clone(),
            kind: welcome.driver.kind,
            name: welcome.driver.name.clone(),
            lost: None,
        };

        let resync = match presync {
            Some(snapshot) => {
                if welcome.wants == Wants::Snapshot || snapshot.0 != welcome.head {
                    Some(snapshot)
                } else {
                    // The room already holds exactly this much.
                    self.floor = Some(snapshot.0);
                    self.needs_resync = false;
                    None
                }
            }
            None if welcome.wants == Wants::Snapshot => match self.take_snapshot().await {
                Ok(snapshot) => Some(snapshot),
                Err(error) => return Exit::Retry { live: false, error },
            },
            None => None,
        };
        if let Some((as_of, bytes)) = resync {
            if let Err(error) = self.send_resync(&mut write, as_of, &bytes).await {
                return Exit::Retry { live: false, error };
            }
        }
        // Stale control frames from before this attempt answer a seat that
        // may have changed: dropped, never replayed.
        while self.controls_rx.try_recv().is_ok() {}
        self.report(|s| {
            s.state = LinkState::Live;
            s.owner_online = true;
            s.driver_epoch = welcome.driver_epoch;
            s.driver = Some(driver);
            s.scope = scope;
            s.last_error = None;
        });
        tracing::info!(target: "atlas_rc", room = %self.cfg.room_id, head = welcome.head, "host socket live");

        self.live(&mut write, &mut read).await
    }

    /// The live loop: stream, commands, keepalive.
    async fn live<W, R>(&mut self, write: &mut W, read: &mut R) -> Exit
    where
        W: Sink<WsMessage, Error = WsError> + Unpin,
        R: futures_util::Stream<Item = Result<WsMessage, WsError>> + Unpin,
    {
        let keepalive = self.cfg.keepalive;
        let mut last_seen = Instant::now();
        let mut ping = tokio::time::interval_at(Instant::now() + keepalive.ping, keepalive.ping);
        ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            if self.needs_resync || self.shared.overflowed.load(Ordering::SeqCst) {
                if let Err(error) = self.resync_now(write).await {
                    return Exit::Retry { live: true, error };
                }
            }
            let deadline = self.batch.deadline();
            tokio::select! {
                biased;

                changed = self.stop_rx.changed() => {
                    if changed.is_err() || *self.stop_rx.borrow() {
                        let _ = write.send(WsMessage::Close(None)).await;
                        return Exit::Stopped;
                    }
                }

                _ = self.shared.overflow.notified() => {
                    // Picked up at the top of the loop.
                }

                incoming = read.next() => {
                    last_seen = Instant::now();
                    match incoming {
                        Some(Ok(WsMessage::Text(text))) => {
                            if let Some(exit) = self.on_text(write, text.as_str()).await {
                                return exit;
                            }
                        }
                        Some(Ok(WsMessage::Close(frame))) => {
                            return classify_close(frame.map(|f| u16::from(f.code)));
                        }
                        Some(Ok(_)) => {}
                        Some(Err(e)) => return Exit::Retry { live: true, error: transport(&e) },
                        None => return Exit::Retry { live: true, error: "the room closed the socket".into() },
                    }
                }

                result = self.results_rx.recv() => {
                    if let Some(result) = result {
                        if let Err(e) = send_json(write, &ToServer::CommandResult(result)).await {
                            return Exit::Retry { live: true, error: format!("command result: {e}") };
                        }
                    }
                }

                control = self.controls_rx.recv() => {
                    if let Some(frame) = control {
                        if let Err(e) = send_json(write, &frame).await {
                            return Exit::Retry { live: true, error: format!("control: {e}") };
                        }
                    }
                }

                envelope = self.rx.recv() => match envelope {
                    Some(envelope) => {
                        if let Err(error) = self.accept(write, envelope).await {
                            return Exit::Retry { live: true, error };
                        }
                    }
                    None => return Exit::Stopped,
                },

                _ = sleep_until_opt(deadline) => {
                    if let Err(error) = self.flush(write).await {
                        return Exit::Retry { live: true, error };
                    }
                }

                _ = ping.tick() => {
                    if last_seen.elapsed() >= keepalive.idle {
                        return Exit::Retry { live: true, error: "the room went quiet".into() };
                    }
                    if let Err(e) = write.send(WsMessage::Text("ping".into())).await {
                        return Exit::Retry { live: true, error: format!("ping: {}", transport(&e)) };
                    }
                }
            }
        }
    }

    /// One envelope from the tap.
    async fn accept<W>(
        &mut self,
        write: &mut W,
        envelope: SessionDeltaEnvelope,
    ) -> Result<(), String>
    where
        W: Sink<WsMessage, Error = WsError> + Unpin,
    {
        let covered = self.batch.last_seq().or(self.floor).unwrap_or(0);
        if envelope.seq <= covered {
            // Already in a snapshot the room has, or sent.
            return Ok(());
        }
        if envelope.seq != covered + 1 {
            tracing::warn!(target: "atlas_rc", expected = covered + 1, got = envelope.seq, "stream gap; resyncing");
            self.needs_resync = true;
            return Ok(());
        }
        let urgent = !is_streamed_text(&envelope.delta);
        let bytes = match serde_json::to_string(&envelope) {
            Ok(text) => atlas_redact::redact_json(&text).text.into_bytes(),
            Err(e) => {
                tracing::error!(target: "atlas_rc", "unserialisable envelope: {e}");
                self.needs_resync = true;
                return Ok(());
            }
        };
        if !Coalescer::fits_alone(envelope.seq, bytes.len()) {
            // Past the object's frame cap even alone: the snapshot carries it.
            self.needs_resync = true;
            return Ok(());
        }
        if self.batch.would_overflow(bytes.len()) {
            self.flush(write).await?;
        }
        if self
            .batch
            .push(envelope.seq, bytes, urgent, Instant::now().into_std())
            == Pushed::FlushNow
        {
            self.flush(write).await?;
        }
        Ok(())
    }

    async fn flush<W>(&mut self, write: &mut W) -> Result<(), String>
    where
        W: Sink<WsMessage, Error = WsError> + Unpin,
    {
        let Some((frame, last)) = self.batch.take() else {
            return Ok(());
        };
        write
            .send(WsMessage::Binary(frame.into()))
            .await
            .map_err(|e| format!("delta: {}", transport(&e)))?;
        self.floor = Some(last);
        Ok(())
    }

    /// A text frame from the room. `Some` ends the attempt.
    async fn on_text<W>(&mut self, write: &mut W, text: &str) -> Option<Exit>
    where
        W: Sink<WsMessage, Error = WsError> + Unpin,
    {
        if text == "pong" {
            return None;
        }
        let frame = match FromServer::decode(text) {
            Ok(frame) => frame,
            Err(e) => {
                tracing::debug!(target: "atlas_rc", "undecodable frame: {e}");
                return None;
            }
        };
        match frame {
            FromServer::Roster(Roster::Full(roster)) => {
                self.driver_epoch = roster.driver_epoch;
                self.driver_id = roster.driver.id.clone();
                let viewers = {
                    let mut ids: Vec<&str> = roster.peers.iter().map(|p| p.id.as_str()).collect();
                    ids.sort_unstable();
                    ids.dedup();
                    ids.len()
                };
                let driver = roster.driver.clone();
                self.report(|s| {
                    s.driver_epoch = roster.driver_epoch;
                    s.owner_online = roster.owner_online;
                    s.viewers = viewers;
                    s.driver = Some(driver);
                });
            }
            FromServer::ControlRequest { request } => {
                tracing::info!(target: "atlas_rc", request = %request.request_id, status = request.status.as_str(), "control request");
                self.report(|s| {
                    s.pending.retain(|r| r.request_id != request.request_id);
                    if request.status == ControlRequestStatus::Pending {
                        s.pending.push(request);
                    }
                });
            }
            FromServer::SnapshotRequest { reason } => {
                tracing::debug!(target: "atlas_rc", reason = reason.as_str(), "snapshot requested");
                if let Err(error) = self.snapshot_now(write).await {
                    return Some(Exit::Retry { live: true, error });
                }
            }
            FromServer::Command(command) => self.on_command(command),
            FromServer::Closed { reason } => {
                return Some(Exit::Ended {
                    reason: Some(reason),
                    error: None,
                });
            }
            FromServer::Refused { code, message, .. } => {
                if code == RefusalCode::SnapshotRequired || code == RefusalCode::SeqRegressed {
                    tracing::warn!(target: "atlas_rc", code = code.as_str(), %message, "the room refused a frame");
                    self.needs_resync = true;
                } else if code == RefusalCode::PayloadTooLarge {
                    // The only frames this host sends that can be too large
                    // are a snapshot part and a delta batch, and both are cut
                    // to the caps before they go — so this is a cap the two
                    // sides disagree on, and the room is now behind with no
                    // resync that would help. A failure to report, not a
                    // line to log.
                    tracing::error!(target: "atlas_rc", room = %self.cfg.room_id, %message, "the room refused a frame as too large; remote viewers are behind");
                } else {
                    tracing::warn!(target: "atlas_rc", code = code.as_str(), %message, "the room refused a frame");
                }
                let message = refusal_words(code, &message);
                self.report(|s| s.last_error = Some(message));
            }
            FromServer::Error { code, message } => {
                tracing::warn!(target: "atlas_rc", code = code.as_str(), %message, "room error");
                self.report(|s| s.last_error = Some(message));
            }
            // Everything else is for clients.
            _ => {}
        }
        None
    }

    fn on_command(&mut self, command: HostCommand) {
        if !self
            .recent
            .first_time(&command.from.id, &command.command_id)
        {
            tracing::debug!(target: "atlas_rc", command = %command.command_id, "repeated command ignored");
            return;
        }
        let view = GateView {
            owner_user_id: &self.cfg.owner_user_id,
            driver_epoch: self.driver_epoch,
            driver_id: &self.driver_id,
            capabilities: &self.cfg.capabilities,
        };
        if let Err(refusal) = gate::check(&view, &command) {
            let _ = self.results_tx.send(HostCommandResult::refused(
                &command.command_id,
                &command.from.id,
                refusal.gate,
                &refusal.code,
                &refusal.message,
            ));
            return;
        }
        // Run in relay order (`run_command`); each is bounded by
        // `COMMAND_DEADLINE`, so one slow command delays the next by at most
        // that.
        let _ = self.commands_tx.send(command);
    }

    /// A snapshot, redacted and fitted. Drains whatever the queue held first,
    /// so every drained envelope is at or below the snapshot's `as_of_seq`.
    async fn take_snapshot(&mut self) -> Result<(u64, Vec<u8>), String> {
        self.shared.overflowed.store(false, Ordering::SeqCst);
        while self.rx.try_recv().is_ok() {}
        let doc = tokio::time::timeout(SNAPSHOT_DEADLINE, self.port.snapshot())
            .await
            .map_err(|_| "the snapshot took too long".to_string())??;
        let as_of = doc.as_of_seq;
        let bytes = tokio::task::spawn_blocking(move || crate::snapshot::prepare(doc.document))
            .await
            .map_err(|e| format!("snapshot: {e}"))?;
        Ok((as_of, bytes))
    }

    /// `rc.resync { as_of_seq }` then the snapshot: everything the room holds
    /// past nothing is replaced.
    async fn resync_now<W>(&mut self, write: &mut W) -> Result<(), String>
    where
        W: Sink<WsMessage, Error = WsError> + Unpin,
    {
        self.batch.clear();
        let (as_of, bytes) = self.take_snapshot().await?;
        self.send_resync(write, as_of, &bytes).await
    }

    async fn send_resync<W>(
        &mut self,
        write: &mut W,
        as_of: u64,
        snapshot: &[u8],
    ) -> Result<(), String>
    where
        W: Sink<WsMessage, Error = WsError> + Unpin,
    {
        self.batch.clear();
        send_json(write, &ToServer::Resync { as_of_seq: as_of })
            .await
            .map_err(|e| format!("resync: {e}"))?;
        self.send_snapshot(write, as_of, snapshot).await?;
        self.needs_resync = false;
        Ok(())
    }

    /// A requested snapshot (a joiner, a gap, a checkpoint): flush first so
    /// it covers everything sent, then the parts. No resync — the room keeps
    /// its tail.
    async fn snapshot_now<W>(&mut self, write: &mut W) -> Result<(), String>
    where
        W: Sink<WsMessage, Error = WsError> + Unpin,
    {
        self.flush(write).await?;
        let (as_of, bytes) = self.take_snapshot().await?;
        self.send_snapshot(write, as_of, &bytes).await
    }

    async fn send_snapshot<W>(
        &mut self,
        write: &mut W,
        as_of: u64,
        snapshot: &[u8],
    ) -> Result<(), String>
    where
        W: Sink<WsMessage, Error = WsError> + Unpin,
    {
        let frames = snapshot_frames(as_of, snapshot).ok_or("snapshot seq out of range")?;
        for frame in frames {
            write
                .send(WsMessage::Binary(frame.into()))
                .await
                .map_err(|e| format!("snapshot: {}", transport(&e)))?;
        }
        self.floor = Some(self.floor.map_or(as_of, |floor| floor.max(as_of)));
        Ok(())
    }
}

async fn sleep_until_opt(deadline: Option<std::time::Instant>) {
    match deadline {
        Some(at) => tokio::time::sleep_until(Instant::from_std(at)).await,
        None => std::future::pending().await,
    }
}

async fn send_json<W>(write: &mut W, frame: &ToServer) -> Result<(), String>
where
    W: Sink<WsMessage, Error = WsError> + Unpin,
{
    let text = serde_json::to_string(frame).map_err(|e| e.to_string())?;
    write
        .send(WsMessage::Text(text.into()))
        .await
        .map_err(|e| transport(&e))
}

/// Read until the welcome. A refusal or an error frame before it ends the
/// attempt the way the close that follows it would.
async fn next_welcome<R>(read: &mut R) -> Result<crate::wire::HostWelcome, Exit>
where
    R: futures_util::Stream<Item = Result<WsMessage, WsError>> + Unpin,
{
    let mut refused: Option<String> = None;
    loop {
        match read.next().await {
            Some(Ok(WsMessage::Text(text))) => {
                if text.as_str() == "pong" {
                    continue;
                }
                match FromServer::decode(text.as_str()) {
                    Ok(FromServer::Welcome(Welcome::Host(welcome))) => return Ok(welcome),
                    Ok(FromServer::Refused { code, message, .. }) => {
                        tracing::warn!(target: "atlas_rc", code = code.as_str(), %message, "hello refused");
                        refused = Some(message);
                    }
                    Ok(FromServer::Error { message, .. }) => refused = Some(message),
                    _ => {}
                }
            }
            Some(Ok(WsMessage::Close(frame))) => {
                return Err(
                    match (classify_close(frame.map(|f| u16::from(f.code))), refused) {
                        (Exit::Ended { reason, .. }, Some(message)) => Exit::Ended {
                            reason,
                            error: Some(message),
                        },
                        (exit, _) => exit,
                    },
                );
            }
            Some(Ok(_)) => {}
            Some(Err(e)) => {
                return Err(Exit::Retry {
                    live: false,
                    error: transport(&e),
                })
            }
            None => {
                return Err(Exit::Retry {
                    live: false,
                    error: refused.unwrap_or_else(|| "closed before the welcome".into()),
                })
            }
        }
    }
}

/// Close codes (`RcCloseCode`).
fn classify_close(code: Option<u16>) -> Exit {
    match code {
        Some(1008) => Exit::Ended {
            reason: None,
            error: Some("access to this room was revoked".into()),
        },
        Some(4410) => Exit::Ended {
            reason: None,
            error: None,
        },
        Some(4409) => Exit::Superseded,
        Some(4403) => Exit::Ended {
            reason: None,
            error: Some("the room did not accept this desktop as its host".into()),
        },
        Some(4400) => Exit::Ended {
            reason: None,
            error: Some("the room speaks another protocol version; update Atlas".into()),
        },
        Some(code) => Exit::Retry {
            live: true,
            error: format!("closed ({code})"),
        },
        None => Exit::Retry {
            live: true,
            error: "closed".into(),
        },
    }
}

/// Handshake failures, by status only (the error can carry the ticket).
fn classify_handshake(err: &WsError) -> Exit {
    match err {
        WsError::Http(response) => match response.status().as_u16() {
            401 => Exit::Unauthorized,
            403 => Exit::Ended {
                reason: None,
                error: Some("remote control is turned off".into()),
            },
            404 => Exit::Ended {
                reason: None,
                error: Some("the room no longer exists".into()),
            },
            409 => Exit::Ended {
                reason: None,
                error: None,
            },
            other => Exit::Retry {
                live: false,
                error: format!("HTTP {other}"),
            },
        },
        other => Exit::Retry {
            live: false,
            error: transport(other),
        },
    }
}

/// A transport error, classified rather than formatted.
fn transport(err: &WsError) -> String {
    match err {
        WsError::Io(_) => "network error".into(),
        WsError::Tls(_) => "tls error".into(),
        WsError::Protocol(p) => format!("protocol: {p}"),
        WsError::ConnectionClosed | WsError::AlreadyClosed => "closed".into(),
        WsError::Http(r) => format!("HTTP {}", r.status().as_u16()),
        _ => "connection failed".into(),
    }
}

/// The words the window shows for a refusal. A too-large frame is named for
/// what it means to the user, not by the object's generic line.
fn refusal_words(code: RefusalCode, message: &str) -> String {
    match code {
        RefusalCode::PayloadTooLarge => format!(
            "the room refused the session snapshot as too large; remote viewers may be behind ({message})"
        ),
        _ => message.to_owned(),
    }
}

/// Drop the control requests whose `expires_at` (ms since the epoch, the
/// object's clock) has passed: the object times them out without always
/// telling the host, and a request left on the list is a card the owner can
/// still "approve" to no effect.
fn prune_expired(pending: &mut Vec<ControlRequest>, now_ms: u64) {
    pending.retain(|request| request.expires_at > now_ms);
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// `random(0.5, 1.5) × min(min × 2^attempt, max)`.
pub fn backoff(attempt: u32, min: Duration, max: Duration) -> Duration {
    let base = min
        .checked_mul(1u32.checked_shl(attempt.min(16)).unwrap_or(u32::MAX))
        .unwrap_or(max)
        .min(max);
    base.mul_f64(0.5 + unit_random())
}

/// A number in `[0, 1)`, from the std hasher's per-process random keys and the
/// clock — jitter, not cryptography, and no extra dependency for it.
fn unit_random() -> f64 {
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos()),
    );
    (hasher.finish() >> 11) as f64 / (1u64 << 53) as f64
}

/// Run one command that passed the gates, and report its result.
async fn run_command(
    port: &Arc<dyn SessionPort>,
    results: &mpsc::UnboundedSender<HostCommandResult>,
    command: HostCommand,
) {
    let HostCommand {
        command_id,
        from,
        command,
        ..
    } = command;
    let from_id = from.id.clone();
    let kind = command.kind();
    let outcome = tokio::time::timeout(COMMAND_DEADLINE, port.execute(from, command)).await;
    let result = match outcome {
        Ok(Ok(())) => HostCommandResult::accepted(&command_id, &from_id),
        // The words may be the agent's own error text, which can
        // quote what it was working on: scrubbed like every other
        // byte that leaves this desktop.
        Ok(Err(refusal)) => HostCommandResult::refused(
            &command_id,
            &from_id,
            refusal.gate,
            &refusal.code,
            &atlas_redact::redact(&refusal.message).text,
        ),
        Err(_) => HostCommandResult::refused(
            &command_id,
            &from_id,
            Gate::InFlight,
            "desktop_timeout",
            "the desktop is still working on it",
        ),
    };
    tracing::info!(target: "atlas_rc", kind = kind.as_str(), ok = result.ok, "remote command");
    let _ = results.send(result);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::PrincipalKind;

    #[test]
    fn the_backoff_is_jittered_and_capped() {
        let min = Duration::from_secs(1);
        let max = Duration::from_secs(30);
        for attempt in 0..40 {
            let wait = backoff(attempt, min, max);
            let base = (min * 2u32.saturating_pow(attempt.min(16))).min(max);
            assert!(
                wait >= base.mul_f64(0.5) && wait <= base.mul_f64(1.5),
                "{attempt}: {wait:?}"
            );
        }
    }

    #[test]
    fn a_revocation_or_an_ended_room_stops_and_a_drop_retries() {
        assert!(matches!(classify_close(Some(1008)), Exit::Ended { .. }));
        assert!(matches!(classify_close(Some(4410)), Exit::Ended { .. }));
        assert!(matches!(classify_close(Some(4409)), Exit::Superseded));
        assert!(matches!(classify_close(Some(1001)), Exit::Retry { .. }));
        assert!(matches!(classify_close(Some(1013)), Exit::Retry { .. }));
        assert!(matches!(classify_close(None), Exit::Retry { .. }));
    }

    #[test]
    fn the_host_url_names_the_room_and_no_org() {
        let mut cfg = HostConfig::new(
            "01ROOM".into(),
            "s".into(),
            "u".into(),
            "desk-0000".into(),
            "x".into(),
            "atlas-agent".into(),
            None,
            vec![],
        );
        cfg.ws_base = "ws://127.0.0.1:8788/".into();
        assert_eq!(cfg.url(), "ws://127.0.0.1:8788/rc/host/ws?room=01ROOM");
        assert!(!format!("{cfg:?}").contains("host_secret: \"x\""));
    }

    fn request(id: &str, expires_at: u64) -> ControlRequest {
        ControlRequest {
            request_id: id.into(),
            from: PrincipalRef {
                id: "user_member".into(),
                kind: PrincipalKind::User,
                name: None,
            },
            status: ControlRequestStatus::Pending,
            requested_at: expires_at.saturating_sub(60_000),
            expires_at,
            answered_at: None,
            reason: None,
        }
    }

    /// A request the object has already timed out does not stay on the
    /// owner's list.
    #[test]
    fn an_expired_control_request_is_pruned_on_report() {
        let mut pending = vec![
            request("old", 1_000),
            request("live", 10_000),
            request("edge", 5_000),
        ];
        prune_expired(&mut pending, 5_000);
        let ids: Vec<&str> = pending.iter().map(|r| r.request_id.as_str()).collect();
        assert_eq!(ids, ["live"], "expired at exactly now is expired");
        assert!(now_ms() > 1_700_000_000_000, "the clock is in ms");
    }

    #[test]
    fn a_too_large_refusal_is_worded_as_a_snapshot_failure() {
        let words = refusal_words(RefusalCode::PayloadTooLarge, "frame over 262144 bytes");
        assert!(words.contains("snapshot"), "{words}");
        assert!(words.contains("262144"), "the object's detail survives");
        assert_eq!(refusal_words(RefusalCode::RoomFull, "full"), "full");
    }

    #[test]
    fn someone_else_driving_is_read_off_the_seat() {
        let mut status = HostStatus::default();
        assert!(!status.driven_by_someone_else("user_owner"));
        status.driver = Some(DriverRef {
            id: "user_owner".into(),
            kind: PrincipalKind::User,
            name: None,
            lost: None,
        });
        assert!(!status.driven_by_someone_else("user_owner"));
        status.driver = Some(DriverRef {
            id: "user_member".into(),
            kind: PrincipalKind::User,
            name: Some("Ada".into()),
            lost: None,
        });
        assert!(status.driven_by_someone_else("user_owner"));
    }
}
