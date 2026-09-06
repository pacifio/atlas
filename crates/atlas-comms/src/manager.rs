//! The app-global orchestrator: one socket per active Organisation, the
//! authoritative state, and the policies that decide when to try again.
//!
//! ## The emission rule
//!
//! Steady state emits **granular** events. Bulk transitions — `hello`, a resume
//! replay, a cold sync — apply their frames **silently**, bump the epoch, and
//! emit one [`CommsEvent::Resync`]. A five-thousand-frame replay is one repaint
//! rather than five thousand events, and the renderer re-reads the snapshot
//! commands when the epoch moves.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{broadcast, mpsc};

use crate::conn::{self, ConnEvent, ExitReason};
use crate::error::Result;
use crate::CommsError;
use crate::events::{CommsEnvelope, CommsEvent, ConnReason, ConnectionState, WireMessage};
use crate::rest::RestClient;
use crate::state::{
    apply_frame, optimistic_id, ChatState, LocalMessage, MemberChange, PendingMap, PendingSend,
    SendStatus, StateDelta,
};
use crate::store::CommsStore;
use crate::wire::{ClientFrame, Message, ReactionRow, ServerFrame, CHAT_TYPING_INTERVAL_MS};
use crate::{chat_base, socket_url, OrgTarget, TokenSource};

const RECONNECT_BASE_MS: u64 = 1_000;
const RECONNECT_MAX_MS: u64 = 30_000;
const EVENT_CAPACITY: usize = 1_024;
/// A pending send with no ack this long after the last reconnect is presumed
/// lost. Frames carry no correlation id, so a timeout is the only honest signal
/// — see the spec's risk register before "fixing" this with a fabricated one.
const SEND_TIMEOUT_MS: i64 = 15_000;

#[derive(Debug, Clone)]
pub struct ConnectionInfo {
    pub state: ConnectionState,
    pub reason: Option<ConnReason>,
    pub epoch: u64,
    pub org_id: Option<String>,
}

/// One connection attempt's identity: the organisation it dials and the
/// generation it was spawned under.
///
/// Every side effect an attempt has on shared state — installing its socket,
/// writing connection state, bumping the epoch, persisting, adopting a REST
/// page — is checked against the CURRENT generation first, under the lock the
/// write takes. An attempt that a retarget has already replaced is therefore
/// inert rather than clobbering its successor. Before this, a stale attempt
/// returning from its token mint would install its socket over the new org's,
/// silence the new org's events behind its own quiet window, and write the old
/// org's conversations under the new org's row on disk — which is what made an
/// organisation switch fail at random.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Session {
    pub org_id: String,
    pub generation: u64,
}

struct Inner {
    // Lock order, where two are ever held together: `state` → `pending`,
    // `state` → `connection`, `target` → `connection`. NEVER hold `store`
    // together with `state`: `set_target` used to nest store→state while
    // `persist_snapshot` nested state→store — an ABBA deadlock waiting for the
    // right interleaving of a switch and a socket event.
    state: Mutex<ChatState>,
    pending: Mutex<PendingMap>,
    store: Mutex<CommsStore>,
    rest: RestClient,
    tokens: Arc<dyn TokenSource>,
    events: broadcast::Sender<CommsEnvelope>,
    target: Mutex<Option<OrgTarget>>,
    connection: Mutex<ConnectionInfo>,
    epoch: AtomicU64,
    /// Generation counter: a task whose generation is stale exits quietly
    /// rather than fighting the one that replaced it. Bumped under the
    /// `target` lock, so [`CommsManager::session`] reads a consistent pair.
    generation: AtomicU64,
    /// The live socket's sender, TAGGED with the generation that installed it.
    /// A stale attempt can neither install over the live one nor clear it on
    /// its way out — it only ever touches a slot carrying its own tag.
    outbound: Mutex<Option<(u64, mpsc::UnboundedSender<ClientFrame>)>>,
    /// Conversations the UI has open. Only these are refreshed on a cold sync;
    /// the rest page from REST when they are opened.
    windows: Mutex<HashSet<String>>,
    /// Conversations whose HISTORY page has been fetched this session.
    ///
    /// Deliberately not "has any messages": a resume replay delivers the events
    /// that happened while we were away, never the history before them. Using
    /// message-count as the gate meant one replayed frame — very often just our
    /// own last send, whose `ack` does not advance the watermark — convinced
    /// `open_conversation` the transcript was already loaded, and the channel
    /// rendered exactly that one message.
    hydrated: Mutex<HashSet<String>>,
    /// Last time we sent a `typing` per conversation, for the 1-per-3s throttle.
    typing_sent: Mutex<HashMap<String, i64>>,
    /// Uploads asked to stop. Checked between parts — a 32 MiB part in flight
    /// is allowed to finish rather than being torn out from under reqwest.
    cancelled_uploads: Mutex<HashSet<String>>,
    /// Completed uploads by file id, so an optimistic send can carry the
    /// attachment's real metadata.
    ///
    /// The sender is the ONE participant the server never tells about their
    /// own message: an `ack` carries `{client_msg_id, id, seq}` and nothing
    /// else, and `message.new` deliberately skips the sending socket. So the
    /// filename/type/size that everyone else receives has to come from here,
    /// or the author's own copy renders as a message with no attachment.
    uploaded: Mutex<HashMap<String, crate::wire::Attachment>>,
    /// The generation whose bulk transition is running (granular emission
    /// off), or `0` for none. Scoped to a generation rather than a bare flag
    /// so a replaced attempt entering its quiet window cannot silence the
    /// live one. `0` is a safe sentinel: the first `set_target` bumps the
    /// generation to 1 before any supervisor exists.
    quiet: AtomicU64,
    /// Whether anything actually changed while `quiet` was set. A reconnect
    /// whose replay carried zero frames used to end in the same full
    /// `Resync` → renderer-rehydrate as a five-thousand-frame one; this is
    /// what lets the empty case settle with two small events instead.
    quiet_dirty: AtomicBool,
}

#[derive(Clone)]
pub struct CommsManager {
    inner: Arc<Inner>,
}

impl CommsManager {
    pub fn new(store: CommsStore, tokens: Arc<dyn TokenSource>) -> Self {
        let (events, _) = broadcast::channel(EVENT_CAPACITY);
        Self {
            inner: Arc::new(Inner {
                state: Mutex::new(ChatState::default()),
                pending: Mutex::new(HashMap::new()),
                store: Mutex::new(store),
                rest: RestClient::new(chat_base(), tokens.clone()),
                tokens,
                events,
                target: Mutex::new(None),
                connection: Mutex::new(ConnectionInfo {
                    state: ConnectionState::Disconnected,
                    reason: None,
                    epoch: 0,
                    org_id: None,
                }),
                epoch: AtomicU64::new(0),
                generation: AtomicU64::new(0),
                outbound: Mutex::new(None),
                windows: Mutex::new(HashSet::new()),
                hydrated: Mutex::new(HashSet::new()),
                typing_sent: Mutex::new(HashMap::new()),
                cancelled_uploads: Mutex::new(HashSet::new()),
                uploaded: Mutex::new(HashMap::new()),
                quiet: AtomicU64::new(0),
                quiet_dirty: AtomicBool::new(false),
            }),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<CommsEnvelope> {
        self.inner.events.subscribe()
    }

    pub fn connection(&self) -> ConnectionInfo {
        self.inner.connection.lock().unwrap().clone()
    }

    pub fn with_state<T>(&self, f: impl FnOnce(&ChatState) -> T) -> T {
        f(&self.inner.state.lock().unwrap())
    }

    /// Connection info and chat state read under ONE critical section, so a
    /// snapshot cannot pair one org's connection with another org's lists
    /// (the window between a retarget's two writes).
    pub fn with_snapshot<T>(&self, f: impl FnOnce(&ConnectionInfo, &ChatState) -> T) -> T {
        let state = self.inner.state.lock().unwrap();
        let conn = self.inner.connection.lock().unwrap();
        f(&conn, &state)
    }

    /// The current attempt's identity, or `None` with no target.
    ///
    /// Read under the `target` lock, which is also where `set_target` bumps
    /// the generation — so the pair is always the one a single `set_target`
    /// produced. Commands that await REST and then adopt into state capture
    /// this first and hand it to the adopt, which refuses if it has gone stale.
    pub fn session(&self) -> Option<Session> {
        let target = self.inner.target.lock().unwrap();
        target.as_ref().map(|t| Session {
            org_id: t.org_id.clone(),
            generation: self.inner.generation.load(Ordering::SeqCst),
        })
    }

    /// Is this generation still the one that owns the shared state?
    fn live(&self, generation: u64) -> bool {
        self.inner.generation.load(Ordering::SeqCst) == generation
    }

    /// Install an attempt's socket sender — only if the attempt is still
    /// live, decided under the same lock the install takes.
    fn install_outbound(&self, generation: u64, tx: mpsc::UnboundedSender<ClientFrame>) -> bool {
        let mut out = self.inner.outbound.lock().unwrap();
        if !self.live(generation) {
            return false;
        }
        *out = Some((generation, tx));
        true
    }

    /// Clear the socket sender, but only the one this generation installed.
    fn release_outbound(&self, generation: u64) {
        let mut out = self.inner.outbound.lock().unwrap();
        if out.as_ref().is_some_and(|(tag, _)| *tag == generation) {
            *out = None;
        }
    }

    /// Open a bulk-transition window owned by `generation`. Harmless from a
    /// stale attempt: `emit_delta` compares against the CURRENT generation.
    fn begin_quiet(&self, generation: u64) {
        self.inner.quiet.store(generation, Ordering::SeqCst);
        self.inner.quiet_dirty.store(false, Ordering::SeqCst);
    }

    /// Close the window — only if it is still ours.
    fn end_quiet(&self, generation: u64) {
        let _ =
            self.inner
                .quiet
                .compare_exchange(generation, 0, Ordering::SeqCst, Ordering::SeqCst);
    }

    fn is_quiet(&self) -> bool {
        let owner = self.inner.quiet.load(Ordering::SeqCst);
        owner != 0 && owner == self.inner.generation.load(Ordering::SeqCst)
    }

    /// Point the socket at an Organisation, or at none.
    ///
    /// Idempotent and reconciling: the same target is a no-op, a different one
    /// tears down and reopens, and `None` closes. Every path that changes the
    /// active organisation — launch restore, sign-in, sign-out, an org switch —
    /// funnels through here, which is why there is no separate "open" call.
    pub fn set_target(&self, target: Option<OrgTarget>) {
        // Compare, bump and write under ONE lock: `session()` reads the pair
        // under the same lock, and no bump can land between "this target is
        // unchanged" and the write below.
        let generation = {
            let mut current = self.inner.target.lock().unwrap();
            if *current == target {
                // A supervisor stops for good on `unavailable` (a refusal that
                // retrying cannot fix), and — because `disconnect()` forgets
                // the target — `disconnected` alongside a target means nothing
                // is running either. Both must respawn rather than no-op: a
                // snapshot naming the SAME org used to keep a dead supervisor
                // dead for the whole session while everything claimed to be
                // configured correctly.
                let state = self.connection().state;
                let respawn = target.is_some()
                    && matches!(
                        state,
                        ConnectionState::Unavailable | ConnectionState::Disconnected
                    );
                if !respawn {
                    tracing::debug!(target: "atlas_comms", "set_target no-op: {target:?}");
                    return;
                }
                tracing::info!(
                    target: "atlas_comms",
                    "set_target unchanged ({target:?}) but {state:?} — respawning"
                );
            } else {
                tracing::info!(target: "atlas_comms", "set_target {:?} -> {:?}", *current, target);
            }
            // Bump the generation first: any task still running for the
            // previous target sees a stale generation and stops touching
            // shared state.
            let generation = self.inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
            *current = target.clone();
            generation
        };

        // Whatever the previous generation left behind goes now. A stale
        // attempt that has not noticed yet cannot put it back: every one of
        // these is re-checked against the generation before it is written.
        *self.inner.outbound.lock().unwrap() = None;
        self.inner.quiet.store(0, Ordering::SeqCst);
        self.inner.quiet_dirty.store(false, Ordering::SeqCst);

        // Clear state that belonged to the outgoing org — leaving it would show
        // one organisation's conversations under another's name.
        {
            let mut state = self.inner.state.lock().unwrap();
            *state = ChatState::default();
            self.inner.pending.lock().unwrap().clear();
            self.inner.windows.lock().unwrap().clear();
            self.inner.hydrated.lock().unwrap().clear();
            self.inner.typing_sent.lock().unwrap().clear();
        }

        match target {
            None => {
                self.set_connection(ConnectionState::Disconnected, None, None);
            }
            Some(target) => {
                // Paint from disk before the socket says anything. The store
                // guard is released BEFORE `state` is taken — the lock order
                // on `Inner`.
                let painted = self
                    .inner
                    .store
                    .lock()
                    .unwrap()
                    .snapshot(&target.org_id)
                    .ok();
                if let Some(snapshot) = painted {
                    let mut state = self.inner.state.lock().unwrap();
                    state.conversations = snapshot.conversations;
                    state.discoverable = snapshot.discoverable;
                    state.reads = snapshot
                        .reads
                        .into_iter()
                        .map(|r| (r.conv_id.clone(), r))
                        .collect();
                }
                self.spawn_supervisor(Session {
                    org_id: target.org_id,
                    generation,
                });
            }
        }
    }

    /// Re-announce the current state to whoever is listening now.
    ///
    /// Tauri window events are not buffered: anything emitted before the
    /// renderer attached its listener is gone, and on a cold launch the socket
    /// opens seconds *after* Rust starts but possibly *before* React has
    /// mounted. The renderer therefore subscribes first and then calls this,
    /// which closes the window in both directions — if the data already
    /// arrived, this replays it; if it has not, the listener is now in place to
    /// catch the real one.
    pub fn announce(&self) {
        let info = self.connection();
        self.set_connection(info.state, info.reason, info.org_id);
        self.emit(CommsEvent::Resync);
    }

    /// Close the socket AND forget the target. Used by the org-switch
    /// teardown, which reopens via the auth broadcast a moment later — and
    /// that reopen must always be a *change*. Keeping the target here meant a
    /// switch that resolved to the same org (an unsynced org falling back to
    /// the first server org, a B→C→B round trip) hit `set_target`'s no-op and
    /// left chat dead for the session.
    pub fn disconnect(&self) {
        self.set_target(None);
    }

    /// Flush everything that must survive a quit.
    pub fn shutdown(&self) {
        if let Some(session) = self.session() {
            self.persist_snapshot(&session);
        }
        self.inner.generation.fetch_add(1, Ordering::SeqCst);
        *self.inner.outbound.lock().unwrap() = None;
    }

    // -- connection lifecycle ------------------------------------------------

    fn spawn_supervisor(&self, session: Session) {
        let me = self.clone();
        tokio::spawn(async move {
            let mut attempt: u32 = 0;
            loop {
                // Every write of connection state is generation-checked, so a
                // `false` here is "we have been replaced": stop.
                if !me.set_connection_live(&session, ConnectionState::Connecting, None) {
                    return;
                }

                let reason = me.attempt_once(&session).await;

                if !me.live(session.generation) {
                    return;
                }

                match reason {
                    // Retrying cannot help. Stop, and wait for the next auth
                    // snapshot or a manual reconnect to change something.
                    ExitReason::Forbidden => {
                        me.set_connection_live(
                            &session,
                            ConnectionState::Unavailable,
                            Some(ConnReason::NotAMember),
                        );
                        return;
                    }
                    ExitReason::Evicted => {
                        me.set_connection_live(
                            &session,
                            ConnectionState::Unavailable,
                            Some(ConnReason::Evicted),
                        );
                        return;
                    }
                    ExitReason::Unauthorized => {
                        // One immediate re-mint: the JWT lives ten minutes and
                        // can expire between minting and dialling. A second
                        // refusal is a real auth problem.
                        if attempt == 0 {
                            attempt = 1;
                            continue;
                        }
                        me.set_connection_live(
                            &session,
                            ConnectionState::Unavailable,
                            Some(ConnReason::Auth),
                        );
                        return;
                    }
                    ExitReason::Closed | ExitReason::Transport(_) => {}
                }

                let delay = backoff_ms(attempt);
                attempt = attempt.saturating_add(1);
                if !me.set_connection_live(
                    &session,
                    ConnectionState::Backoff,
                    Some(ConnReason::Offline),
                ) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(delay)).await;
            }
        });
    }

    /// One dial, and everything that happens on it.
    ///
    /// Every step that touches shared state re-checks the generation: the
    /// mint is a network round trip, and a retarget during it must leave this
    /// attempt with nothing to do.
    async fn attempt_once(&self, session: &Session) -> ExitReason {
        let generation = session.generation;
        let token = match self.inner.tokens.mint().await {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!(target: "atlas_comms", "could not mint a token: {e}");
                return ExitReason::Unauthorized;
            }
        };
        if !self.live(generation) {
            return ExitReason::Closed;
        }

        let watermark = self
            .inner
            .store
            .lock()
            .unwrap()
            .watermark(&session.org_id)
            .unwrap_or(0);

        let (out_tx, out_rx) = mpsc::unbounded_channel::<ClientFrame>();
        let (ev_tx, mut ev_rx) = mpsc::unbounded_channel::<ConnEvent>();
        // Install BEFORE dialling, and only if still live: a stale attempt
        // must not open a socket to an organisation nobody is on any more.
        if !self.install_outbound(generation, out_tx.clone()) {
            return ExitReason::Closed;
        }

        let url = socket_url(&session.org_id);
        tokio::spawn(conn::run(url, token, watermark, out_rx, ev_tx));

        // The replay between `hello` and `resumed` is applied quietly.
        self.begin_quiet(generation);

        let exit = loop {
            // An idle socket delivers nothing, so a replaced attempt would
            // otherwise sit here holding the old org's socket open until the
            // server spoke. The tick bounds that to a second: dropping
            // `out_tx` on the way out is what closes the socket politely.
            let event = tokio::select! {
                event = ev_rx.recv() => event,
                _ = tokio::time::sleep(Duration::from_secs(1)) => {
                    if self.live(generation) {
                        continue;
                    }
                    None
                }
            };
            let Some(event) = event else {
                break ExitReason::Closed;
            };
            if !self.live(generation) {
                break ExitReason::Closed;
            }
            match event {
                ConnEvent::Frame(frame) => {
                    self.handle_frame(session, frame, &out_tx).await;
                }
                ConnEvent::Closed(reason) => break reason,
            }
        };

        self.end_quiet(generation);
        self.release_outbound(generation);
        self.persist_snapshot(session);
        exit
    }

    async fn handle_frame(
        &self,
        session: &Session,
        frame: ServerFrame,
        out_tx: &mpsc::UnboundedSender<ClientFrame>,
    ) {
        // A frame from a socket a retarget has already replaced belongs to
        // nobody: applying it would put one org's history under another's.
        if !self.live(session.generation) {
            return;
        }
        let now = now_ms();
        let journaled = crate::wire::is_journaled(&frame);
        let seq = crate::wire::frame_seq(&frame);

        let deltas = {
            let mut state = self.inner.state.lock().unwrap();
            let mut pending = self.inner.pending.lock().unwrap();
            if !self.live(session.generation) {
                return;
            }
            apply_frame(&mut state, frame, &mut pending, now)
        };

        // Only a journaled frame may move the watermark. Advancing from an
        // ephemeral one would skip real history on the next resume.
        if journaled {
            if let Some(seq) = seq {
                self.set_watermark_live(session, seq);
            }
        }

        for delta in deltas {
            match delta {
                StateDelta::TooOld { snapshot_from } => {
                    self.cold_sync(session, snapshot_from, out_tx).await;
                }
                StateDelta::Resumed { through } => {
                    // The terminator. Without it a client cannot tell "nothing
                    // happened while I was away" from "the replay has not
                    // started yet", so it is worth saying out loud.
                    tracing::info!(target: "atlas_comms", "resumed through {through}");
                    self.set_watermark_live(session, through);
                    // The replay is over. If it (or the hello before it)
                    // changed anything, one repaint and then granular events —
                    // but the COMMON reconnect replays nothing, and answering
                    // that with a Resync made every wobble of the link cost a
                    // full snapshot + per-tab window re-read in the renderer.
                    // The quiet window still refreshed reads and presence from
                    // the hello (they are snapshot-only on the wire), so the
                    // clean path forwards exactly those two, which are small.
                    let dirty = self.inner.quiet_dirty.swap(false, Ordering::SeqCst);
                    self.end_quiet(session.generation);
                    if !self.live(session.generation) {
                        return;
                    }
                    self.resend_unacked(out_tx);
                    self.bump_epoch(session.generation);
                    self.set_connection_live(session, ConnectionState::Open, None);
                    if dirty {
                        self.emit_for(session, CommsEvent::Resync);
                    } else {
                        let (reads, online) = {
                            let state = self.inner.state.lock().unwrap();
                            (
                                state.reads.values().cloned().collect::<Vec<_>>(),
                                state.online.clone(),
                            )
                        };
                        self.emit_for(session, CommsEvent::ReadsChanged { reads });
                        self.emit_for(session, CommsEvent::Presence { online });
                    }
                    self.persist_snapshot(session);
                }
                StateDelta::Hello => {
                    // Applied quietly; `resumed` is what announces it to the UI.
                    let (convs, disc) = {
                        let state = self.inner.state.lock().unwrap();
                        (state.conversations.len(), state.discoverable.len())
                    };
                    tracing::info!(
                        target: "atlas_comms",
                        "hello: {convs} conversations, {disc} discoverable"
                    );
                    self.persist_snapshot(session);
                }
                other => self.emit_delta(session, other),
            }
        }
    }

    /// Advance the watermark for the attempt's org — only while it is live. A
    /// stale attempt on a B→C→B round trip could otherwise move (or rewind)
    /// a row the live attempt is resuming from.
    fn set_watermark_live(&self, session: &Session, seq: i64) {
        let store = self.inner.store.lock().unwrap();
        if !self.live(session.generation) {
            return;
        }
        let _ = store.set_watermark(&session.org_id, seq);
    }

    /// The journal no longer reaches our watermark, so nothing was replayed and
    /// nothing will be. Rebuild from REST rather than pretending.
    ///
    /// Four round trips per open window, and a retarget can land in any of
    /// them — hence the re-check after EVERY await: the state this fills is
    /// shared, and the org it fetched for may no longer be the one on screen.
    async fn cold_sync(
        &self,
        session: &Session,
        snapshot_from: i64,
        out_tx: &mpsc::UnboundedSender<ClientFrame>,
    ) {
        let generation = session.generation;
        let org_id = &session.org_id;
        tracing::info!(target: "atlas_comms", "cold sync from {snapshot_from}");
        self.begin_quiet(generation);

        // `hello` already restated the lists, but refetching closes the race
        // and is cheap.
        if let Ok(list) = self.inner.rest.conversations(org_id).await {
            let mut state = self.inner.state.lock().unwrap();
            if !self.live(generation) {
                return;
            }
            state.conversations = list.conversations;
            state.discoverable = list.discoverable;
        }
        if !self.live(generation) {
            return;
        }

        // Only conversations the UI actually has open are refilled; the rest
        // page from REST when they are opened. Anything not refilled below has
        // its hydration dropped, so opening it fetches a fresh page rather than
        // trusting a tail that predates the gap we just failed to replay.
        self.inner.hydrated.lock().unwrap().clear();
        let windows: Vec<String> = self.inner.windows.lock().unwrap().iter().cloned().collect();
        for conv_id in windows {
            if let Ok(page) = self.inner.rest.messages(org_id, &conv_id, None, 50).await {
                let rows = page
                    .messages
                    .into_iter()
                    .map(LocalMessage::settled)
                    .collect::<Vec<_>>();
                {
                    let mut state = self.inner.state.lock().unwrap();
                    if !self.live(generation) {
                        return;
                    }
                    state.messages.insert(conv_id.clone(), rows);
                    for row in page.reactions {
                        state
                            .reactions
                            .entry(row.message_id.clone())
                            .or_default()
                            .push(row);
                    }
                }
                self.mark_hydrated(session, &conv_id);
            }
            if !self.live(generation) {
                return;
            }
            if let Ok(pins) = self.inner.rest.pins(org_id, &conv_id).await {
                let ids = pins.pins.iter().map(|p| p.message_id.clone()).collect();
                self.adopt_pins(session, &conv_id, ids);
            }
            if !self.live(generation) {
                return;
            }
            // Call history is REST-only here: the replay we just failed to get
            // was the sole other source, and the watermark is about to jump
            // past it for good.
            if let Ok(list) = self.inner.rest.calls(org_id, &conv_id).await {
                self.adopt_calls(session, list.calls);
            }
            if !self.live(generation) {
                return;
            }
        }

        // Anything we sent but never saw acknowledged goes again, with its
        // original id — idempotent, so if it landed the server returns the
        // original ack rather than posting twice.
        self.resend_unacked(out_tx);

        // Adopt the server's watermark exactly, rewind included, and persist it
        // now rather than on the usual debounce: a crash between here and the
        // next flush would ask for the same impossible resume again.
        {
            let store = self.inner.store.lock().unwrap();
            if !self.live(generation) {
                return;
            }
            let _ = store.reset_watermark(org_id, snapshot_from);
        }

        self.end_quiet(generation);
        self.bump_epoch(generation);
        self.set_connection_live(session, ConnectionState::Open, None);
        self.emit_for(session, CommsEvent::Resync);
        self.persist_snapshot(session);
    }

    fn resend_unacked(&self, out_tx: &mpsc::UnboundedSender<ClientFrame>) {
        let pending = self.inner.pending.lock().unwrap();
        for sent in pending.values() {
            let _ = out_tx.send(ClientFrame::Send {
                conv_id: sent.conv_id.clone(),
                client_msg_id: sent.client_msg_id.clone(),
                body: sent.body.clone(),
                reply_to_id: sent.reply_to_id.clone(),
                attachments: sent.attachments.clone(),
                code_refs: Vec::new(),
            });
        }
    }

    // -- outbound ------------------------------------------------------------

    /// Write a message. Returns the `client_msg_id` that identifies it.
    ///
    /// The optimistic row is created here, in Rust, because the `ack` carries
    /// only ids — the body has to be remembered somewhere, and splitting that
    /// memory across the bridge would mean two places that can disagree.
    ///
    /// Refused outright with no organisation connected. The alternative —
    /// queueing a pending row nobody will ever ack, under a target that does
    /// not exist — is a message that clears the composer and then silently
    /// vanishes, which is what a send in the middle of an org switch used to do.
    pub fn send(
        &self,
        conv_id: &str,
        body: String,
        reply_to_id: Option<String>,
        attachments: Vec<String>,
    ) -> Result<String> {
        if self.session().is_none() {
            return Err(CommsError::Protocol("no organisation is connected".into()));
        }
        let client_msg_id = uuid::Uuid::new_v4().to_string();
        let now = now_ms();
        let me = self
            .inner
            .state
            .lock()
            .unwrap()
            .me
            .clone()
            .unwrap_or_default();

        let provisional_seq = {
            let state = self.inner.state.lock().unwrap();
            state
                .messages(conv_id)
                .last()
                .map(|m| m.message.seq + 1)
                .unwrap_or(i64::MAX / 2)
        };

        let message = Message {
            id: optimistic_id(&client_msg_id),
            conv_id: conv_id.to_string(),
            seq: provisional_seq,
            author_id: me,
            body: body.clone(),
            reply_to_id: reply_to_id.clone(),
            edited_at: None,
            created_at: now,
            attachments: self.attachment_meta(&attachments),
            code_refs: Vec::new(),
            draft_id: None,
        };

        self.inner.pending.lock().unwrap().insert(
            client_msg_id.clone(),
            PendingSend {
                client_msg_id: client_msg_id.clone(),
                conv_id: conv_id.to_string(),
                body: body.clone(),
                reply_to_id: reply_to_id.clone(),
                attachments: attachments.clone(),
                sent_at: now,
            },
        );

        let row = LocalMessage {
            message,
            client_msg_id: Some(client_msg_id.clone()),
            status: SendStatus::Sending,
            deleted: false,
        };
        self.inner
            .state
            .lock()
            .unwrap()
            .messages
            .entry(conv_id.to_string())
            .or_default()
            .push(row.clone());

        self.emit(CommsEvent::MessageAppended {
            conv_id: conv_id.to_string(),
            message: to_wire(&row),
        });

        self.write(ClientFrame::Send {
            conv_id: conv_id.to_string(),
            client_msg_id: client_msg_id.clone(),
            body,
            reply_to_id,
            attachments,
            code_refs: Vec::new(),
        });

        Ok(client_msg_id)
    }

    // Edit, delete, react and pin are all OPTIMISTIC: the local state mutates
    // and the granular event goes out synchronously in the command path, and
    // only then is the frame written. The server's echo re-applies the same
    // fact, which the reducer already treats as a no-op (reactions dedupe on
    // (user, emoji), pins on rail membership), so nothing double-paints.
    //
    // This is the same shape sends have had from the start — the pixel changes
    // at click time, and the round trip becomes invisible. Offline semantics
    // follow from `write()` dropping frames with no socket: the optimistic
    // state shows, and truth is restated by the next page or cold-sync.

    pub fn edit(&self, message_id: &str, body: String) {
        let updated = {
            let mut state = self.inner.state.lock().unwrap();
            let mut found = None;
            for (conv_id, list) in state.messages.iter_mut() {
                if let Some(row) = list.iter_mut().find(|m| m.message.id == message_id) {
                    row.message.body = body.clone();
                    row.message.edited_at = Some(now_ms());
                    found = Some((conv_id.clone(), row.clone()));
                    break;
                }
            }
            found
        };
        if let Some((conv_id, row)) = updated {
            self.emit(CommsEvent::MessageUpdated {
                conv_id,
                replaced_id: None,
                message: to_wire(&row),
            });
        }
        self.write(ClientFrame::Edit {
            message_id: message_id.to_string(),
            body,
        });
    }

    pub fn delete(&self, message_id: &str) {
        let (updated, unpinned) = {
            let mut state = self.inner.state.lock().unwrap();
            let mut found = None;
            for (conv_id, list) in state.messages.iter_mut() {
                if let Some(row) = list.iter_mut().find(|m| m.message.id == message_id) {
                    row.deleted = true;
                    row.message.body.clear();
                    row.message.attachments.clear();
                    row.message.code_refs.clear();
                    found = Some((conv_id.clone(), row.clone()));
                    break;
                }
            }
            // A deleted message takes its pin with it, exactly as the server's
            // own `pin.removed` will confirm.
            let unpinned = found.as_ref().and_then(|(conv_id, _)| {
                let rail = state.pins.get_mut(conv_id)?;
                let before = rail.len();
                rail.retain(|m| m != message_id);
                (rail.len() != before).then(|| (conv_id.clone(), rail.clone()))
            });
            (found, unpinned)
        };
        if let Some((conv_id, row)) = updated {
            self.emit(CommsEvent::MessageUpdated {
                conv_id,
                replaced_id: None,
                message: to_wire(&row),
            });
        }
        if let Some((conv_id, rail)) = unpinned {
            self.emit(CommsEvent::PinsChanged {
                conv_id,
                pinned_message_ids: rail,
            });
        }
        self.write(ClientFrame::Delete {
            message_id: message_id.to_string(),
        });
    }

    /// `on` is explicit state, not a toggle — send what should be true. That is
    /// also what makes the optimism safe: an echoed or retried frame cannot
    /// flip the state back.
    pub fn react(&self, message_id: &str, emoji: &str, on: bool) -> Result<()> {
        if !crate::wire::is_allowed_reaction(emoji) {
            return Err(crate::CommsError::Refused {
                code: "bad_request".into(),
                message: "emoji is not in the allowlist".into(),
                detail: None,
            });
        }
        // Optimism needs to know who "we" are; before the first hello there is
        // no identity to attribute the row to, and no transcript to see it in.
        let rows = {
            let mut state = self.inner.state.lock().unwrap();
            state.me.clone().and_then(|me| {
                let bucket = state.reactions.entry(message_id.to_string()).or_default();
                let at = bucket
                    .iter()
                    .position(|r| r.user_id == me && r.emoji == emoji);
                let changed = match (on, at) {
                    (true, None) => {
                        bucket.push(ReactionRow {
                            message_id: message_id.to_string(),
                            user_id: me,
                            emoji: emoji.to_string(),
                        });
                        true
                    }
                    (false, Some(i)) => {
                        bucket.remove(i);
                        true
                    }
                    _ => false,
                };
                changed.then(|| bucket.clone())
            })
        };
        if let Some(rows) = rows {
            self.emit(CommsEvent::ReactionsChanged {
                message_id: message_id.to_string(),
                rows,
            });
        }
        self.write(ClientFrame::React {
            message_id: message_id.to_string(),
            emoji: emoji.to_string(),
            on,
        });
        Ok(())
    }

    pub fn pin(&self, message_id: &str, on: bool) {
        let rail = {
            let mut state = self.inner.state.lock().unwrap();
            // The rail is per conversation; find which one holds the message.
            let conv_id = state
                .messages
                .iter()
                .find(|(_, list)| list.iter().any(|m| m.message.id == message_id))
                .map(|(conv_id, _)| conv_id.clone());
            conv_id.and_then(|conv_id| {
                let rail = state.pins.entry(conv_id.clone()).or_default();
                let changed = if on {
                    if rail.contains(&message_id.to_string()) {
                        false
                    } else {
                        rail.insert(0, message_id.to_string());
                        true
                    }
                } else {
                    let before = rail.len();
                    rail.retain(|m| m != message_id);
                    rail.len() != before
                };
                changed.then(|| (conv_id, rail.clone()))
            })
        };
        if let Some((conv_id, rail)) = rail {
            self.emit(CommsEvent::PinsChanged {
                conv_id,
                pinned_message_ids: rail,
            });
        }
        self.write(ClientFrame::Pin {
            message_id: message_id.to_string(),
            on,
        });
    }

    pub fn read(&self, conv_id: &str, seq: i64) {
        self.write(ClientFrame::Read {
            conv_id: conv_id.to_string(),
            seq,
        });
    }

    /// Throttled to one per three seconds per conversation. The server drops
    /// excess **silently**, so throttling here is mandatory: there is no
    /// feedback to learn from.
    pub fn typing(&self, conv_id: &str) {
        let now = now_ms();
        {
            let mut sent = self.inner.typing_sent.lock().unwrap();
            if let Some(last) = sent.get(conv_id) {
                if now - last < CHAT_TYPING_INTERVAL_MS as i64 {
                    return;
                }
            }
            sent.insert(conv_id.to_string(), now);
        }
        self.write(ClientFrame::Typing {
            conv_id: conv_id.to_string(),
        });
    }

    /// Subscribe this socket to a draft. The renderer re-calls this on every
    /// reconnect — the subscription dies with the socket.
    pub fn draft_open(&self, draft_id: &str) {
        self.write(ClientFrame::DraftOpen {
            draft_id: draft_id.to_string(),
        });
    }

    /// Relay opaque Yjs bytes. NO retention here: a drop with no socket is
    /// recovered by the renderer's unsent buffer, which re-flushes after the
    /// `draft.opened` a reconnect produces — the same recovery the web
    /// client uses, so the two stay behaviourally identical.
    pub fn draft_update(&self, draft_id: &str, update: &str) {
        self.write(ClientFrame::DraftUpdate {
            draft_id: draft_id.to_string(),
            update: update.to_string(),
        });
    }

    /// Cursor state. Losing one is meaningless — the 5s heartbeat restates it.
    pub fn draft_awareness(&self, draft_id: &str, state: &str) {
        self.write(ClientFrame::DraftAwareness {
            draft_id: draft_id.to_string(),
            state: state.to_string(),
        });
    }

    fn write(&self, frame: ClientFrame) {
        let out = self.inner.outbound.lock().unwrap();
        // Whatever is installed is the live generation's by construction —
        // see `install_outbound` / `release_outbound`.
        match out.as_ref() {
            Some((_, tx)) => {
                let _ = tx.send(frame);
            }
            // No socket. A `send` is safe to drop here because it is held in
            // `pending` and goes again on reconnect; the rest are absolute-state
            // frames the next `hello` will restate anyway.
            None => tracing::debug!(target: "atlas_comms", "dropped a frame with no socket"),
        }
    }

    /// Mark sends that have waited too long. Frames carry no correlation id, so
    /// a timeout is the only honest signal a send was lost.
    pub fn expire_stale_sends(&self) {
        let now = now_ms();
        let stale: Vec<PendingSend> = {
            let pending = self.inner.pending.lock().unwrap();
            pending
                .values()
                .filter(|p| now - p.sent_at > SEND_TIMEOUT_MS)
                .cloned()
                .collect()
        };
        for sent in stale {
            let optimistic = optimistic_id(&sent.client_msg_id);
            let updated = {
                let mut state = self.inner.state.lock().unwrap();
                match state
                    .messages
                    .get_mut(&sent.conv_id)
                    .and_then(|l| l.iter_mut().find(|m| m.message.id == optimistic))
                {
                    Some(row) if row.status == SendStatus::Sending => {
                        row.status = SendStatus::Failed;
                        Some(row.clone())
                    }
                    _ => None,
                }
            };
            if let Some(row) = updated {
                self.emit(CommsEvent::MessageUpdated {
                    conv_id: sent.conv_id.clone(),
                    replaced_id: None,
                    message: to_wire(&row),
                });
            }
        }
    }

    // -- attachments ---------------------------------------------------------

    /// Upload one file and hand back its server file id.
    ///
    /// Streams the file in `part_bytes` chunks rather than reading it whole: an
    /// attachment may be up to 5 GiB, and the only reason to hold one in memory
    /// would be to run out of it. Progress is reported per completed part.
    ///
    /// Cancellation is cooperative — [`Self::cancel_upload`] flips a flag this
    /// loop checks between parts, then aborts the staged upload server-side so
    /// the abandoned bytes stop counting against the quota.
    pub async fn upload_attachment(
        &self,
        conv_id: &str,
        path: &std::path::Path,
        upload_id: &str,
    ) -> Result<String> {
        let org_id = self
            .org_id()
            .ok_or_else(|| CommsError::Protocol("no organisation is connected".into()))?;

        let filename = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "file".to_string());
        let meta = std::fs::metadata(path).map_err(|e| CommsError::Store(e.to_string()))?;
        let size = meta.len();
        if size == 0 {
            return Err(CommsError::Refused {
                code: "bad_request".into(),
                message: "That file is empty.".into(),
                detail: None,
            });
        }
        let content_type = guess_content_type(&filename);

        self.emit_upload(upload_id, 0, size, "uploading", None);

        // The intent is where quota is enforced, before any bytes move.
        let intent = self
            .inner
            .rest
            .create_upload(&org_id, conv_id, &filename, &content_type, size)
            .await
            .inspect_err(|e| {
                self.emit_upload(upload_id, 0, size, "failed", Some(e.to_string()));
            })?;

        // tokio::fs, not std: each part read is up to 32 MiB off disk, and a
        // blocking read inside this async fn parks a runtime worker for its
        // whole duration (tokio::fs routes through spawn_blocking internally).
        let mut file = tokio::fs::File::open(path)
            .await
            .map_err(|e| CommsError::Store(e.to_string()))?;
        let mut parts: Vec<crate::rest::UploadedPart> = Vec::new();
        let mut sent: u64 = 0;

        for part_number in 1..=intent.parts {
            if self.upload_cancelled(upload_id) {
                let _ = self.inner.rest.abort_upload(&org_id, &intent.file_id).await;
                self.finish_upload(upload_id);
                return Err(CommsError::Protocol("upload cancelled".into()));
            }

            // Every part but the last is exactly `part_bytes`; the last is
            // whatever remains, which `read` gives us by hitting EOF.
            let want = intent.part_bytes.min(size - sent) as usize;
            let mut buf = vec![0u8; want];
            read_exact_or_eof(&mut file, &mut buf)
                .await
                .map_err(|e| CommsError::Store(e.to_string()))?;

            let uploaded = match self
                .inner
                .rest
                .upload_part(&org_id, &intent.file_id, part_number, buf)
                .await
            {
                Ok(part) => part,
                Err(e) => {
                    let _ = self.inner.rest.abort_upload(&org_id, &intent.file_id).await;
                    self.emit_upload(upload_id, sent, size, "failed", Some(e.to_string()));
                    self.finish_upload(upload_id);
                    return Err(e);
                }
            };
            parts.push(uploaded);
            sent += want as u64;
            self.emit_upload(upload_id, sent, size, "uploading", None);
        }

        let file = match self
            .inner
            .rest
            .complete_upload(&org_id, &intent.file_id, parts)
            .await
        {
            Ok(file) => file,
            Err(e) => {
                self.emit_upload(upload_id, sent, size, "failed", Some(e.to_string()));
                self.finish_upload(upload_id);
                return Err(e);
            }
        };

        {
            let mut done = self.inner.uploaded.lock().unwrap();
            // Bounded: this only has to survive from upload to send, and an
            // unbounded map would hold every file of a long session.
            if done.len() > 256 {
                done.clear();
            }
            done.insert(file.id.clone(), file.clone());
        }

        self.emit_upload(upload_id, size, size, "complete", None);
        self.finish_upload(upload_id);
        Ok(file.id)
    }

    /// Ask a running upload to stop between parts.
    pub fn cancel_upload(&self, upload_id: &str) {
        self.inner
            .cancelled_uploads
            .lock()
            .unwrap()
            .insert(upload_id.to_string());
    }

    fn upload_cancelled(&self, upload_id: &str) -> bool {
        self.inner.cancelled_uploads.lock().unwrap().contains(upload_id)
    }

    /// Resolve file ids to the metadata their upload returned.
    ///
    /// A file id we never uploaded in this session (a resend after a restart)
    /// degrades to a generic entry rather than vanishing: the id is what the
    /// download needs, and a nameless card still opens.
    fn attachment_meta(&self, file_ids: &[String]) -> Vec<crate::wire::Attachment> {
        let done = self.inner.uploaded.lock().unwrap();
        file_ids
            .iter()
            .map(|id| {
                done.get(id).cloned().unwrap_or_else(|| crate::wire::Attachment {
                    id: id.clone(),
                    filename: "file".into(),
                    content_type: "application/octet-stream".into(),
                    bytes: 0,
                })
            })
            .collect()
    }

    fn finish_upload(&self, upload_id: &str) {
        self.inner.cancelled_uploads.lock().unwrap().remove(upload_id);
    }

    fn emit_upload(
        &self,
        upload_id: &str,
        sent_bytes: u64,
        total_bytes: u64,
        state: &'static str,
        error: Option<String>,
    ) {
        self.emit(CommsEvent::UploadProgress {
            upload_id: upload_id.to_string(),
            sent_bytes,
            total_bytes,
            state,
            error,
        });
    }

    /// Download an attachment, announcing progress under `download_id`.
    ///
    /// Chunk arrivals are throttled to one event per 256 KiB — a fast local
    /// link would otherwise flood the bridge with more frames than the ring
    /// has pixels — with `complete`/`failed` always sent.
    pub async fn download_attachment(&self, file_id: &str, download_id: &str) -> Result<Vec<u8>> {
        let org = self
            .org_id()
            .ok_or_else(|| CommsError::Protocol("no organisation is connected".into()))?;
        let progress = self.progress_reporter(download_id);
        let mut on_chunk = progress;
        let result = self
            .inner
            .rest
            .download_file_with(&org, file_id, &mut on_chunk)
            .await;
        self.finish_download(download_id, &result);
        result
    }

    /// Download a recording track from its short-lived absolute URL,
    /// announcing progress under `download_id`.
    pub async fn download_recording(&self, url: &str, download_id: &str) -> Result<Vec<u8>> {
        let progress = self.progress_reporter(download_id);
        let mut on_chunk = progress;
        let result = self.inner.rest.download_recording_with(url, &mut on_chunk).await;
        self.finish_download(download_id, &result);
        result
    }

    /// A throttled `(got, total)` → `DownloadProgress` closure.
    fn progress_reporter(&self, download_id: &str) -> impl FnMut(u64, u64) + Send + use<'_> {
        const STRIDE: u64 = 256 * 1024;
        let mgr = self.clone();
        let id = download_id.to_string();
        let mut last = 0u64;
        move |got, total| {
            if got < last + STRIDE && got != total {
                return;
            }
            last = got;
            mgr.emit_download(&id, got, total, "downloading", None);
        }
    }

    fn finish_download(&self, download_id: &str, result: &Result<Vec<u8>>) {
        match result {
            Ok(bytes) => {
                let n = bytes.len() as u64;
                self.emit_download(download_id, n, n, "complete", None);
            }
            Err(e) => {
                self.emit_download(download_id, 0, 0, "failed", Some(e.to_string()));
            }
        }
    }

    fn emit_download(
        &self,
        download_id: &str,
        got_bytes: u64,
        total_bytes: u64,
        state: &'static str,
        error: Option<String>,
    ) {
        self.emit(CommsEvent::DownloadProgress {
            download_id: download_id.to_string(),
            got_bytes,
            total_bytes,
            state,
            error,
        });
    }

    // -- windows -------------------------------------------------------------

    // Every adopt below takes the `Session` the caller captured BEFORE its
    // REST round trips and refuses if that generation has been replaced —
    // checked under the lock it writes, so a retarget cannot slip between
    // the check and the write. A command that fetched org A's page and adopts
    // it after the socket moved to org B would otherwise file A's messages
    // under B, in memory and (via `persist_snapshot`) on disk.

    pub fn open_window(&self, session: &Session, conv_id: &str) {
        let mut windows = self.inner.windows.lock().unwrap();
        if !self.live(session.generation) {
            return;
        }
        windows.insert(conv_id.to_string());
    }

    pub fn close_window(&self, conv_id: &str) {
        self.inner.windows.lock().unwrap().remove(conv_id);
    }

    /// Has this conversation's history page been fetched this session?
    pub fn is_hydrated(&self, conv_id: &str) -> bool {
        self.inner.hydrated.lock().unwrap().contains(conv_id)
    }

    pub fn mark_hydrated(&self, session: &Session, conv_id: &str) {
        let mut hydrated = self.inner.hydrated.lock().unwrap();
        if !self.live(session.generation) {
            return;
        }
        hydrated.insert(conv_id.to_string());
    }

    pub fn rest(&self) -> &RestClient {
        &self.inner.rest
    }

    /// The org the socket currently targets. Not a guard: a command that
    /// awaits after reading this must use [`Self::session`] instead.
    pub fn org_id(&self) -> Option<String> {
        self.inner
            .target
            .lock()
            .unwrap()
            .as_ref()
            .map(|t| t.org_id.clone())
    }

    /// Adopt a REST page into state, so an opened conversation paints and later
    /// live frames merge into the same list. `false` when the session is
    /// stale and nothing was adopted.
    pub fn adopt_page(
        &self,
        session: &Session,
        conv_id: &str,
        messages: Vec<Message>,
        prepend: bool,
    ) -> bool {
        let mut state = self.inner.state.lock().unwrap();
        if !self.live(session.generation) {
            return false;
        }
        let list = state.messages.entry(conv_id.to_string()).or_default();
        for message in messages {
            if list.iter().any(|m| m.message.id == message.id) {
                continue;
            }
            list.push(LocalMessage::settled(message));
        }
        list.sort_by_key(|m| m.message.seq);
        let _ = prepend;
        true
    }

    pub fn adopt_reactions(&self, session: &Session, rows: Vec<crate::wire::ReactionRow>) {
        let mut state = self.inner.state.lock().unwrap();
        if !self.live(session.generation) {
            return;
        }
        for row in rows {
            let bucket = state.reactions.entry(row.message_id.clone()).or_default();
            if !bucket
                .iter()
                .any(|r| r.user_id == row.user_id && r.emoji == row.emoji)
            {
                bucket.push(row);
            }
        }
    }

    pub fn adopt_pins(&self, session: &Session, conv_id: &str, ids: Vec<String>) {
        let mut state = self.inner.state.lock().unwrap();
        if !self.live(session.generation) {
            return;
        }
        state.pins.insert(conv_id.to_string(), ids);
    }

    /// Adopt REST call history (ATL-208), the way the web client does: merge
    /// **additively by id**, never overwriting a row the socket already
    /// delivered — a frame is always fresher than a page fetched before it.
    /// Announces each newly learned call so an already-hydrated renderer
    /// paints it without waiting for a snapshot.
    /// Start a call and adopt it optimistically — the row appears the moment
    /// the 201 lands rather than when the socket's `call.started` echo comes
    /// round. The echo then overwrites the same key harmlessly (the pins
    /// idempotent-echo rule).
    pub async fn start_call(
        &self,
        conv_id: &str,
        mode: &str,
        public: bool,
    ) -> Result<crate::wire::Call> {
        let session = self
            .session()
            .ok_or_else(|| CommsError::Token("no organisation is connected".into()))?;
        let call = self
            .inner
            .rest
            .start_call(&session.org_id, conv_id, mode, public)
            .await?;
        {
            let mut state = self.inner.state.lock().unwrap();
            if !self.live(session.generation) {
                return Err(CommsError::Protocol("organisation changed".into()));
            }
            state.calls.insert(call.id.clone(), call.clone());
        }
        self.emit_for(&session, CommsEvent::CallChanged { call: call.clone() });
        Ok(call)
    }

    /// A call's transcript, as CSV bytes.
    pub async fn download_transcript(&self, call_id: &str) -> Result<Vec<u8>> {
        let org = self
            .org_id()
            .ok_or_else(|| CommsError::Token("no organisation is connected".into()))?;
        self.inner.rest.download_transcript(&org, call_id).await
    }

    pub fn adopt_calls(&self, session: &Session, calls: Vec<crate::wire::Call>) {
        let mut fresh = Vec::new();
        {
            let mut state = self.inner.state.lock().unwrap();
            if !self.live(session.generation) {
                return;
            }
            for call in calls {
                if !state.calls.contains_key(&call.id) {
                    state.calls.insert(call.id.clone(), call.clone());
                    fresh.push(call);
                }
            }
        }
        for call in fresh {
            self.emit_for(session, CommsEvent::CallChanged { call });
        }
    }

    // -- emission ------------------------------------------------------------

    fn emit_delta(&self, session: &Session, delta: StateDelta) {
        // Bulk transitions apply silently and announce themselves once. The
        // window is the LIVE generation's: a stale attempt's window is ignored.
        if self.is_quiet() {
            // `Hello` fires on EVERY connect and is a restatement, not a
            // change: journaled history arrives as replay frames (which do
            // mark dirty), and the ephemeral snapshot it carries (reads,
            // presence) is exactly what the clean-reconnect path forwards.
            // Counting it would make every reconnect look dirty.
            if !matches!(delta, StateDelta::Hello) {
                self.inner.quiet_dirty.store(true, Ordering::SeqCst);
            }
            return;
        }
        let state = self.inner.state.lock().unwrap();
        let event = match delta {
            StateDelta::MessageAppended { conv_id, id } => state
                .messages(&conv_id)
                .iter()
                .find(|m| m.message.id == id)
                .map(|row| CommsEvent::MessageAppended {
                    conv_id: conv_id.clone(),
                    message: to_wire(row),
                }),
            StateDelta::MessageUpdated {
                conv_id,
                id,
                replaced_id,
            } => state
                .messages(&conv_id)
                .iter()
                .find(|m| m.message.id == id)
                .map(|row| CommsEvent::MessageUpdated {
                    conv_id: conv_id.clone(),
                    replaced_id,
                    message: to_wire(row),
                }),
            StateDelta::ConversationsChanged => Some(CommsEvent::ConversationsChanged {
                conversations: state.conversations.clone(),
                discoverable: state.discoverable.clone(),
            }),
            StateDelta::ReadsChanged { conv_id } => state
                .reads
                .get(&conv_id)
                .map(|read| CommsEvent::ReadChanged { read: read.clone() }),
            StateDelta::Presence => Some(CommsEvent::Presence {
                online: state.online.clone(),
            }),
            StateDelta::DraftOpened {
                draft_id,
                draft,
                snapshot,
                updates,
            } => Some(CommsEvent::DraftOpened {
                draft_id,
                draft,
                snapshot,
                updates,
            }),
            StateDelta::DraftUpdate { draft_id, update } => {
                Some(CommsEvent::DraftUpdate { draft_id, update })
            }
            StateDelta::DraftAwareness {
                draft_id,
                user_id,
                state: st,
            } => Some(CommsEvent::DraftAwareness {
                draft_id,
                user_id,
                state: st,
            }),
            StateDelta::Typing {
                conv_id,
                user_id,
                at_ms,
            } => Some(CommsEvent::Typing {
                conv_id,
                user_id,
                at_ms,
            }),
            StateDelta::ReactionsChanged { message_id } => Some(CommsEvent::ReactionsChanged {
                rows: state.reactions.get(&message_id).cloned().unwrap_or_default(),
                message_id,
            }),
            StateDelta::PinsChanged { conv_id } => Some(CommsEvent::PinsChanged {
                pinned_message_ids: state.pins.get(&conv_id).cloned().unwrap_or_default(),
                conv_id,
            }),
            StateDelta::CallChanged { call_id } => state
                .calls
                .get(&call_id)
                .map(|call| CommsEvent::CallChanged { call: call.clone() }),
            StateDelta::MemberChanged {
                conv_id,
                user_id,
                change,
            } => Some(CommsEvent::MemberChanged {
                conv_id,
                user_id,
                change: match change {
                    MemberChange::Joined => "joined",
                    MemberChange::Left => "left",
                    MemberChange::Evicted => "evicted",
                },
            }),
            StateDelta::Error { code, message } => Some(CommsEvent::Error {
                code,
                message,
                detail: None,
            }),
            StateDelta::Hello | StateDelta::Resumed { .. } | StateDelta::TooOld { .. } => None,
        };
        drop(state);
        if let Some(event) = event {
            self.emit_for(session, event);
        }
    }

    /// Emit under the CURRENT target. For the user's own verbs (send, edit,
    /// react, pin, uploads), which by definition act on the org on screen.
    fn emit(&self, ev: CommsEvent) {
        let Some(org) = self.org_id() else { return };
        let _ = self.inner.events.send(CommsEnvelope {
            org,
            epoch: self.inner.epoch.load(Ordering::SeqCst),
            ev,
        });
    }

    /// Emit on behalf of an attempt: stamped with THAT attempt's org, and
    /// dropped if the attempt has been replaced. Stamping with the current
    /// target instead (as `emit` does) relabelled a stale attempt's events
    /// with the new org, which defeated the renderer's only stale-org guard.
    fn emit_for(&self, session: &Session, ev: CommsEvent) {
        if !self.live(session.generation) {
            return;
        }
        let _ = self.inner.events.send(CommsEnvelope {
            org: session.org_id.clone(),
            epoch: self.inner.epoch.load(Ordering::SeqCst),
            ev,
        });
    }

    /// Advance the epoch for a live attempt. `None` — and no change — when
    /// the attempt is stale, checked under the connection lock.
    fn bump_epoch(&self, generation: u64) -> Option<u64> {
        let mut conn = self.inner.connection.lock().unwrap();
        if !self.live(generation) {
            return None;
        }
        let next = self.inner.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        conn.epoch = next;
        Some(next)
    }

    /// Connection state written by the manager itself, outside any attempt:
    /// `set_target(None)` and `announce()`.
    fn set_connection(
        &self,
        state: ConnectionState,
        reason: Option<ConnReason>,
        org_id: Option<String>,
    ) {
        {
            let mut conn = self.inner.connection.lock().unwrap();
            conn.state = state;
            conn.reason = reason;
            conn.org_id = org_id;
        }
        // Connection state is never quiet: it is what the UI uses to explain
        // itself while a bulk transition is running.
        if let Some(org) = self.org_id() {
            let _ = self.inner.events.send(CommsEnvelope {
                org,
                epoch: self.inner.epoch.load(Ordering::SeqCst),
                ev: CommsEvent::Connection {
                    state,
                    reason,
                    retry_at_ms: None,
                },
            });
        }
    }

    /// Connection state written on behalf of an attempt. A stale attempt
    /// writes nothing and emits nothing — decided UNDER the connection lock,
    /// so a retarget racing this call cannot slip a stale write in after a
    /// passed check. Returns whether the write happened.
    fn set_connection_live(
        &self,
        session: &Session,
        state: ConnectionState,
        reason: Option<ConnReason>,
    ) -> bool {
        {
            let mut conn = self.inner.connection.lock().unwrap();
            if !self.live(session.generation) {
                return false;
            }
            conn.state = state;
            conn.reason = reason;
            conn.org_id = Some(session.org_id.clone());
        }
        self.emit_for(
            session,
            CommsEvent::Connection {
                state,
                reason,
                retry_at_ms: None,
            },
        );
        true
    }

    /// Persist the attempt's org's lists — keyed by the ATTEMPT's org, and
    /// only while it is live. The check is made under the `state` lock, the
    /// same lock `set_target` clears state under, so a stale attempt can
    /// never write a just-emptied (or another org's) list under its row.
    fn persist_snapshot(&self, session: &Session) {
        let (conversations, discoverable, reads) = {
            let state = self.inner.state.lock().unwrap();
            if !self.live(session.generation) {
                return;
            }
            (
                state.conversations.clone(),
                state.discoverable.clone(),
                state.reads.values().cloned().collect::<Vec<_>>(),
            )
        };
        // `state` is released before `store` is taken — the lock order.
        let _ = self.inner.store.lock().unwrap().save_snapshot(
            &session.org_id,
            &conversations,
            &discoverable,
            &reads,
        );
    }
}

pub fn to_wire(row: &LocalMessage) -> WireMessage {
    WireMessage {
        id: row.message.id.clone(),
        conv_id: row.message.conv_id.clone(),
        seq: row.message.seq,
        author_id: row.message.author_id.clone(),
        body: row.message.body.clone(),
        reply_to_id: row.message.reply_to_id.clone(),
        edited_at: row.message.edited_at,
        created_at: row.message.created_at,
        attachments: row.message.attachments.clone(),
        code_refs: row.message.code_refs.clone(),
        draft_id: row.message.draft_id.clone(),
        client_msg_id: row.client_msg_id.clone(),
        status: match row.status {
            SendStatus::Sending => "sending",
            SendStatus::Failed => "failed",
            SendStatus::Settled => "sent",
        },
        deleted: row.deleted,
    }
}

/// 1s, doubling, capped at 30s — so a worker that is down does not get a
/// connection per second, and a laptop waking from an hour asleep is back
/// within half a minute.
fn backoff_ms(attempt: u32) -> u64 {
    RECONNECT_BASE_MS
        .saturating_mul(1u64 << attempt.min(6))
        .min(RECONNECT_MAX_MS)
}

/// Fill `buf`, tolerating a short final read at EOF.
async fn read_exact_or_eof(
    file: &mut tokio::fs::File,
    buf: &mut Vec<u8>,
) -> std::io::Result<()> {
    use tokio::io::AsyncReadExt;
    let mut filled = 0;
    while filled < buf.len() {
        let n = file.read(&mut buf[filled..]).await?;
        if n == 0 {
            buf.truncate(filled);
            break;
        }
        filled += n;
    }
    Ok(())
}

/// A content type from the extension.
///
/// The server pins `content_type` at the intent and serves it back on download,
/// so getting it wrong here is what makes an image render as a file chip
/// forever. Deliberately small: anything unrecognised is
/// `application/octet-stream`, which downloads correctly and simply does not
/// render inline.
fn guess_content_type(filename: &str) -> String {
    let ext = std::path::Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "heic" => "image/heic",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "txt" | "log" | "md" => "text/plain",
        "csv" => "text/csv",
        "html" => "text/html",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    };
    mime.to_string()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
impl CommsManager {
    /// Test-only access to the inner state, for seeding a hello-shaped world
    /// without a socket.
    pub fn test_mutate_state(&self, f: impl FnOnce(&mut ChatState)) {
        f(&mut self.inner.state.lock().unwrap());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::backoff_ms;

    struct NoToken;
    impl TokenSource for NoToken {
        fn mint(
            &self,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = crate::Result<String>> + Send + '_>>
        {
            Box::pin(async { Err(crate::CommsError::Token("test".into())) })
        }
    }

    /// Hydration means "we fetched this conversation's HISTORY", and leaving an
    /// organisation must drop it — another org's conversations were never
    /// fetched, and a stale `true` would suppress their first page.
    ///
    /// The bug this guards: `open_conversation` used to gate on message COUNT,
    /// so a single replayed frame — typically our own last send, whose `ack`
    /// never advances the watermark — looked like a loaded transcript and
    /// suppressed the fetch. The channel then rendered exactly that one
    /// message after a restart.
    /// One read receipt must ship one row. The bulk `ReadsChanged` used to
    /// carry the WHOLE read table per `read.updated` frame — the
    /// highest-frequency serialization in an active org.
    #[tokio::test]
    async fn a_read_delta_emits_a_single_row_event() {
        let store = CommsStore::open_in_memory().expect("store");
        let mgr = CommsManager::new(store, std::sync::Arc::new(NoToken));
        mgr.set_target(Some(OrgTarget {
            org_id: "org_a".into(),
        }));
        {
            let mut state = mgr.inner.state.lock().unwrap();
            for conv in ["c1", "c2", "c3"] {
                state.reads.insert(
                    conv.to_string(),
                    crate::wire::ReadState {
                        conv_id: conv.to_string(),
                        last_read_seq: 1,
                        unread: 2,
                        mentions: 0,
                    },
                );
            }
        }
        let mut rx = mgr.subscribe();
        let session = mgr.session().expect("targeted");
        mgr.emit_delta(
            &session,
            StateDelta::ReadsChanged {
                conv_id: "c2".into(),
            },
        );
        match rx.try_recv().expect("one event").ev {
            CommsEvent::ReadChanged { read } => assert_eq!(read.conv_id, "c2"),
            other => panic!("expected the single-row event, got {other:?}"),
        }
    }

    /// The quiet window's dirty bit: replay frames set it, `Hello` — which
    /// fires on EVERY connect and is a restatement — must not, or every clean
    /// reconnect would still cost the renderer a full re-hydrate.
    #[tokio::test]
    async fn hello_alone_does_not_dirty_a_quiet_window() {
        let store = CommsStore::open_in_memory().expect("store");
        let mgr = CommsManager::new(store, std::sync::Arc::new(NoToken));
        mgr.set_target(Some(OrgTarget {
            org_id: "org_a".into(),
        }));
        let session = mgr.session().expect("targeted");
        mgr.begin_quiet(session.generation);

        mgr.emit_delta(&session, StateDelta::Hello);
        assert!(
            !mgr.inner.quiet_dirty.load(Ordering::SeqCst),
            "a restatement must not look like history"
        );

        mgr.emit_delta(
            &session,
            StateDelta::MessageAppended {
                conv_id: "c1".into(),
                id: "m1".into(),
            },
        );
        assert!(
            mgr.inner.quiet_dirty.load(Ordering::SeqCst),
            "a real replay frame must mark the window dirty"
        );
    }

    fn target(org: &str) -> Option<OrgTarget> {
        Some(OrgTarget {
            org_id: org.into(),
        })
    }

    fn fresh() -> CommsManager {
        let store = CommsStore::open_in_memory().expect("store");
        CommsManager::new(store, std::sync::Arc::new(NoToken))
    }

    /// Let the spawned supervisor run to its (NoToken-forced) verdict.
    async fn settle() {
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
    }

    /// The org-switch dead end. `org-switch.ts` calls `comms_disconnect`
    /// and then `auth_set_active_org`; when the latter resolves to the org
    /// the socket was already on, `set_target` used to see "unchanged" and
    /// no-op — no supervisor, no socket, chat dead for the session.
    #[tokio::test]
    async fn disconnect_forgets_the_target_so_the_same_org_reconnects() {
        let mgr = fresh();
        mgr.set_target(target("org_a"));
        let before = mgr.session().expect("targeted");

        mgr.disconnect();
        assert!(mgr.session().is_none(), "disconnect must forget the target");
        assert_eq!(mgr.connection().state, ConnectionState::Disconnected);

        mgr.set_target(target("org_a"));
        let after = mgr.session().expect("re-targeted");
        assert!(
            after.generation > before.generation,
            "the same org after a disconnect is a NEW attempt"
        );
        settle().await;
        // NoToken makes every supervisor settle on `unavailable`: proof one ran.
        let info = mgr.connection();
        assert_eq!(info.state, ConnectionState::Unavailable);
        assert_eq!(info.org_id.as_deref(), Some("org_a"));
    }

    /// Belt and braces for the same dead end: even with the target held, a
    /// supervisor that is not running (`disconnected` OR `unavailable`) must
    /// be respawned by a snapshot naming the same org.
    #[tokio::test]
    async fn an_unchanged_target_with_nothing_running_respawns() {
        let mgr = fresh();
        mgr.set_target(target("org_a"));
        let before = mgr.session().expect("targeted");
        settle().await;
        assert_eq!(mgr.connection().state, ConnectionState::Unavailable);

        mgr.set_target(target("org_a"));
        let after = mgr.session().expect("targeted");
        assert!(after.generation > before.generation, "unavailable → respawn");

        mgr.set_connection(ConnectionState::Disconnected, None, Some("org_a".into()));
        mgr.set_target(target("org_a"));
        let again = mgr.session().expect("targeted");
        assert!(again.generation > after.generation, "disconnected → respawn");
    }

    /// A stale attempt returning from its token mint used to install its
    /// socket over the live one's, then clear the live one's on exit.
    #[tokio::test]
    async fn a_stale_generation_cannot_install_or_release_the_live_outbound() {
        let mgr = fresh();
        mgr.set_target(target("org_a"));
        let stale = mgr.session().expect("targeted");
        mgr.set_target(target("org_b"));
        let live = mgr.session().expect("targeted");

        let (stale_tx, mut stale_rx) = mpsc::unbounded_channel::<ClientFrame>();
        assert!(
            !mgr.install_outbound(stale.generation, stale_tx),
            "a replaced attempt must not install a socket"
        );
        mgr.write(ClientFrame::Read {
            conv_id: "c1".into(),
            seq: 1,
        });
        assert!(
            stale_rx.try_recv().is_err(),
            "nothing may reach a stale socket"
        );

        let (live_tx, mut live_rx) = mpsc::unbounded_channel::<ClientFrame>();
        assert!(mgr.install_outbound(live.generation, live_tx));
        // The stale attempt exiting must not take the live socket with it.
        mgr.release_outbound(stale.generation);
        mgr.write(ClientFrame::Read {
            conv_id: "c1".into(),
            seq: 2,
        });
        assert!(live_rx.try_recv().is_ok(), "the live socket survives a stale release");
        mgr.release_outbound(live.generation);
        assert!(mgr.inner.outbound.lock().unwrap().is_none());
    }

    /// A stale attempt's `Forbidden` used to write `unavailable` over the new
    /// org's connection, and its envelopes were stamped with the NEW org.
    #[tokio::test]
    async fn a_stale_generation_cannot_write_connection_state_or_epoch() {
        let mgr = fresh();
        mgr.set_target(target("org_a"));
        let stale = mgr.session().expect("targeted");
        mgr.set_target(target("org_b"));
        let live = mgr.session().expect("targeted");
        settle().await;
        let epoch = mgr.connection().epoch;
        let mut rx = mgr.subscribe();

        assert!(!mgr.set_connection_live(&stale, ConnectionState::Open, None));
        assert_eq!(mgr.connection().org_id.as_deref(), Some("org_b"));
        assert_eq!(mgr.bump_epoch(stale.generation), None);
        assert_eq!(mgr.connection().epoch, epoch);
        mgr.emit_for(&stale, CommsEvent::Resync);
        assert!(rx.try_recv().is_err(), "a stale attempt emits nothing");

        assert!(mgr.set_connection_live(&live, ConnectionState::Open, None));
        let env = rx.try_recv().expect("the live attempt's event");
        assert_eq!(env.org, "org_b", "stamped with the attempt's own org");
        assert_eq!(mgr.bump_epoch(live.generation), Some(epoch + 1));
    }

    /// The on-disk contamination: a stale attempt persisting after a switch
    /// wrote the (just-emptied, or the OTHER org's) lists under a row that
    /// the next switch painted from.
    #[tokio::test]
    async fn a_stale_generation_never_persists() {
        let mgr = fresh();
        mgr.set_target(target("org_a"));
        let a = mgr.session().expect("targeted");
        let conv = |id: &str| crate::wire::Conversation {
            id: id.into(),
            kind: crate::wire::ConversationKind::Channel,
            name: Some(id.into()),
            visibility: crate::wire::Visibility::PublicOrg,
            workspace_ref_ids: vec![],
            created_by: "u1".into(),
            created_at: 1,
            archived_at: None,
            seq: 1,
            member_ids: None,
            last_activity_seq: 1,
        };
        mgr.test_mutate_state(|s| s.conversations = vec![conv("a1")]);
        mgr.persist_snapshot(&a);
        assert_eq!(
            mgr.inner
                .store
                .lock()
                .unwrap()
                .snapshot("org_a")
                .unwrap()
                .conversations
                .len(),
            1
        );

        mgr.set_target(target("org_b"));
        mgr.test_mutate_state(|s| s.conversations = vec![conv("b1"), conv("b2")]);
        // The stale attempt exits and persists — under ITS org, and only if
        // live, which it is not: A's row keeps A's list.
        mgr.persist_snapshot(&a);
        let store = mgr.inner.store.lock().unwrap();
        assert_eq!(store.snapshot("org_a").unwrap().conversations.len(), 1);
        assert!(store.snapshot("org_b").unwrap().conversations.is_empty());
    }

    /// The quiet window is the LIVE generation's: a replaced attempt entering
    /// its own must not silence the new org's events.
    #[tokio::test]
    async fn quiet_is_scoped_to_its_generation() {
        let mgr = fresh();
        mgr.set_target(target("org_a"));
        let stale = mgr.session().expect("targeted");
        mgr.set_target(target("org_b"));
        let live = mgr.session().expect("targeted");
        mgr.test_mutate_state(|s| s.online = vec!["u1".into()]);
        let mut rx = mgr.subscribe();

        mgr.begin_quiet(stale.generation);
        mgr.emit_delta(&live, StateDelta::Presence);
        assert!(rx.try_recv().is_ok(), "a stale quiet window is no window");

        mgr.begin_quiet(live.generation);
        mgr.end_quiet(stale.generation);
        mgr.emit_delta(&live, StateDelta::Presence);
        assert!(rx.try_recv().is_err(), "the live window is still open");

        mgr.end_quiet(live.generation);
        mgr.emit_delta(&live, StateDelta::Presence);
        assert!(rx.try_recv().is_ok());
    }

    /// `comms_open_conversation` awaits four REST calls; the adopt at the end
    /// must refuse when the socket moved meanwhile.
    #[tokio::test]
    async fn adopting_from_a_stale_session_is_dropped() {
        let mgr = fresh();
        mgr.set_target(target("org_a"));
        let stale = mgr.session().expect("targeted");
        mgr.set_target(target("org_b"));
        let mut rx = mgr.subscribe();

        let message = Message {
            id: "m1".into(),
            conv_id: "c1".into(),
            seq: 1,
            author_id: "u1".into(),
            body: "from A".into(),
            reply_to_id: None,
            edited_at: None,
            created_at: 1,
            attachments: vec![],
            code_refs: vec![],
            draft_id: None,
        };
        assert!(!mgr.adopt_page(&stale, "c1", vec![message], false));
        assert!(mgr.with_state(|s| s.messages("c1").is_empty()));
        mgr.mark_hydrated(&stale, "c1");
        assert!(!mgr.is_hydrated("c1"));
        mgr.open_window(&stale, "c1");
        assert!(!mgr.inner.windows.lock().unwrap().contains("c1"));
        mgr.adopt_calls(
            &stale,
            vec![crate::wire::Call {
                id: "call_1".into(),
                conv_id: Some("c1".into()),
                mode: crate::wire::CallMode::Audio,
                started_by: "u1".into(),
                started_at: 1,
                ended_at: None,
                seq: 1,
                transcript_state: crate::wire::CallTranscriptState::None,
                join_slug: None,
                recording_state: crate::wire::CallRecordingState::Off,
            }],
        );
        assert!(mgr.with_state(|s| s.calls.is_empty()));
        assert!(rx.try_recv().is_err());
    }

    /// Mid-switch there is no target; a send then must fail loudly rather
    /// than queue a row nobody will ack under an org that does not exist.
    #[tokio::test]
    async fn send_without_a_target_is_an_error_with_no_side_effects() {
        let mgr = fresh();
        let mut rx = mgr.subscribe();
        assert!(mgr.send("c1", "hello".into(), None, vec![]).is_err());
        assert!(mgr.inner.pending.lock().unwrap().is_empty());
        assert!(mgr.with_state(|s| s.messages.is_empty()));
        assert!(rx.try_recv().is_err());
    }

    /// The lock-order rule on `Inner`: a switch and a persist from another
    /// task must never deadlock.
    #[tokio::test]
    async fn set_target_and_persist_do_not_deadlock() {
        let mgr = fresh();
        mgr.set_target(target("org_a"));
        let persister = {
            let mgr = mgr.clone();
            tokio::spawn(async move {
                for _ in 0..200 {
                    if let Some(s) = mgr.session() {
                        mgr.persist_snapshot(&s);
                    }
                    tokio::task::yield_now().await;
                }
            })
        };
        let switcher = {
            let mgr = mgr.clone();
            tokio::spawn(async move {
                for i in 0..200 {
                    mgr.set_target(target(if i % 2 == 0 { "org_b" } else { "org_a" }));
                    tokio::task::yield_now().await;
                }
            })
        };
        tokio::time::timeout(Duration::from_secs(5), async {
            persister.await.unwrap();
            switcher.await.unwrap();
        })
        .await
        .expect("no deadlock between set_target and persist_snapshot");
    }

    /// REST call history merges ADDITIVELY: a row the socket already
    /// delivered is never overwritten by a page fetched before the frame, and
    /// only genuinely new calls are announced.
    #[tokio::test]
    async fn adopt_calls_is_additive_and_announces_only_fresh_rows() {
        let store = CommsStore::open_in_memory().expect("store");
        let mgr = CommsManager::new(store, std::sync::Arc::new(NoToken));
        mgr.set_target(Some(OrgTarget {
            org_id: "org_a".into(),
        }));

        let call = |id: &str, ended: Option<i64>| crate::wire::Call {
            id: id.into(),
            conv_id: Some("c1".into()),
            mode: crate::wire::CallMode::Audio,
            started_by: "u1".into(),
            started_at: 1,
            ended_at: ended,
            seq: 10,
            transcript_state: crate::wire::CallTranscriptState::None,
            join_slug: None,
            recording_state: crate::wire::CallRecordingState::Off,
        };

        // A socket frame taught us the call is over…
        mgr.inner
            .state
            .lock()
            .unwrap()
            .calls
            .insert("call_1".into(), call("call_1", Some(99)));

        let mut rx = mgr.subscribe();
        let session = mgr.session().expect("targeted");
        // …and the REST page, fetched before that frame, still says live.
        mgr.adopt_calls(&session, vec![call("call_1", None), call("call_2", Some(50))]);

        // The frame's answer stands; the new row was learned.
        mgr.with_state(|state| {
            assert_eq!(state.calls["call_1"].ended_at, Some(99));
            assert_eq!(state.calls["call_2"].ended_at, Some(50));
        });

        // Exactly one announcement, for the fresh row only.
        let env = rx.try_recv().expect("one event");
        match env.ev {
            CommsEvent::CallChanged { call } => assert_eq!(call.id, "call_2"),
            other => panic!("unexpected event: {other:?}"),
        }
        assert!(rx.try_recv().is_err(), "call_1 must not be re-announced");
    }

    #[tokio::test]
    async fn hydration_is_tracked_and_cleared_when_leaving_an_org() {
        let store = CommsStore::open_in_memory().expect("store");
        let mgr = CommsManager::new(store, std::sync::Arc::new(NoToken));

        // Attach to an org. The supervisor cannot mint a token, so it settles
        // on `unavailable` without looping — enough for this invariant.
        mgr.set_target(Some(OrgTarget {
            org_id: "org_a".into(),
        }));

        assert!(!mgr.is_hydrated("c1"));
        let session = mgr.session().expect("targeted");
        mgr.mark_hydrated(&session, "c1");
        assert!(mgr.is_hydrated("c1"));

        // Detaching drops every per-org fact, hydration included.
        mgr.set_target(None);
        assert!(!mgr.is_hydrated("c1"), "hydration must not survive an org change");
    }

    /// The optimism contract: a `react` mutates local state and emits its
    /// event even with NO socket at all. That is the whole point — the pixel
    /// changes at click time; the wire catches up (or, offline, the next page
    /// restates truth).
    #[tokio::test]
    async fn react_applies_optimistically_without_a_socket() {
        let store = CommsStore::open_in_memory().expect("store");
        let mgr = CommsManager::new(store, std::sync::Arc::new(NoToken));
        mgr.set_target(Some(OrgTarget {
            org_id: "org_a".into(),
        }));
        let mut rx = mgr.subscribe();

        mgr.test_mutate_state(|state| {
            state.me = Some("u_me".into());
            state.messages.insert(
                "c1".into(),
                vec![crate::state::LocalMessage::settled(Message {
                    id: "m1".into(),
                    conv_id: "c1".into(),
                    seq: 1,
                    author_id: "u_other".into(),
                    body: "hi".into(),
                    reply_to_id: None,
                    edited_at: None,
                    created_at: 1,
                    attachments: vec![],
                    code_refs: vec![],
                    draft_id: None,
                })],
            );
        });

        mgr.react("m1", "\u{1F44D}", true).expect("allowed emoji");
        assert!(mgr.with_state(|s| s
            .reactions
            .get("m1")
            .is_some_and(|rows| rows.iter().any(|r| r.user_id == "u_me"))));

        // The granular event went out synchronously.
        let mut saw_reaction_event = false;
        while let Ok(envelope) = rx.try_recv() {
            if matches!(envelope.ev, CommsEvent::ReactionsChanged { ref message_id, .. } if message_id == "m1")
            {
                saw_reaction_event = true;
            }
        }
        assert!(saw_reaction_event, "optimistic ReactionsChanged must emit");

        // Explicit-state semantics: reacting off removes the row.
        mgr.react("m1", "\u{1F44D}", false).expect("allowed emoji");
        assert!(mgr.with_state(|s| s
            .reactions
            .get("m1")
            .is_none_or(|rows| rows.iter().all(|r| r.user_id != "u_me"))));
    }

    #[tokio::test]
    async fn delete_tombstones_optimistically_and_clears_the_pin() {
        let store = CommsStore::open_in_memory().expect("store");
        let mgr = CommsManager::new(store, std::sync::Arc::new(NoToken));
        mgr.set_target(Some(OrgTarget {
            org_id: "org_a".into(),
        }));

        mgr.test_mutate_state(|state| {
            state.me = Some("u_me".into());
            state.messages.insert(
                "c1".into(),
                vec![crate::state::LocalMessage::settled(Message {
                    id: "m1".into(),
                    conv_id: "c1".into(),
                    seq: 1,
                    author_id: "u_me".into(),
                    body: "regrettable".into(),
                    reply_to_id: None,
                    edited_at: None,
                    created_at: 1,
                    attachments: vec![],
                    code_refs: vec![],
                    draft_id: None,
                })],
            );
            state.pins.insert("c1".into(), vec!["m1".into()]);
        });

        mgr.delete("m1");
        mgr.with_state(|s| {
            let row = &s.messages("c1")[0];
            assert!(row.deleted);
            assert!(row.message.body.is_empty());
            // A rail must never point at something that is gone.
            assert!(s.pins.get("c1").is_none_or(Vec::is_empty));
        });
    }

    #[test]
    fn backoff_doubles_and_caps() {
        assert_eq!(backoff_ms(0), 1_000);
        assert_eq!(backoff_ms(1), 2_000);
        assert_eq!(backoff_ms(4), 16_000);
        // Capped, so a long outage does not become a long silence.
        assert_eq!(backoff_ms(10), 30_000);
    }
}
