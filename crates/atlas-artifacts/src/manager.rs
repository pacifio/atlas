//! Who is connected, to which Projects and Sessions, and what to do when one
//! drops.
//!
//! Shaped on `atlas_comms::manager`, with the two things that make an
//! org-switch safe carried over — and one lesson it had to learn twice:
//!
//! * **Identity is per connection, not per manager.** Every supervisor task
//!   carries the `epoch` of the registry slot it was started for, and may only
//!   touch a slot carrying that same epoch. A retarget that leaves a Project in
//!   the wanted set never disturbs its live socket; a retarget that drops one
//!   removes the slot, which is what stops the task. The first version used a
//!   single manager-wide generation instead, bumped on *every* retarget — so a
//!   socket opened at boot was stale by the third retarget (auth resolves, the
//!   Organisation list merges, StrictMode re-runs the effect), and exited for
//!   good on its first disconnect, leaving a slot that swallowed every later
//!   subscribe. Realtime comments "worked, then stopped" until reopened.
//! * **Eviction forgets everything** — a dropped Project's cache entry goes
//!   with its socket, so a stale row cannot outlive the connection that
//!   produced it.
//!
//! # Two kinds of socket
//!
//! The server holds **one** subscribed Session per socket, on the socket's own
//! attachment, and sends entry and comment frames only to sockets subscribed
//! to that Session. `session.summary` reaches every socket on the Project.
//!
//! So there are two kinds of slot, told apart by [`Slot::session`]:
//!
//! * A **board socket** (`session: None`) per Project this machine has bound to
//!   Cloud, from [`ArtifactsManager::retarget`]. It subscribes to nothing and
//!   exists to keep the board live.
//! * A **follower socket** (`session: Some`) per Session someone is looking
//!   at, from [`ArtifactsManager::follow`]. It subscribes to exactly that
//!   Session as its first frame, and it is dialled for *any* Project in the
//!   Organisation — a teammate's Session lives in a Project this machine never
//!   bound, and the server authorises the socket by membership, not by
//!   binding.
//!
//! The first version had one socket per Project carrying one desired Session.
//! That lost in two ways at once: a Session in an unbound Project waited for
//! a socket that was never going to open, and two surfaces on the same
//! Project (the Timeline and a chat tab) fought over the one subscription —
//! whichever unmounted last unsubscribed the other, for good.
//!
//! Followers are refcounted, so two surfaces on one Session share one socket,
//! and they are recorded before the Organisation is known: the first retarget
//! at boot runs before auth resolves and tears everything down, and a follow
//! issued in that window must still be dialled once an Organisation is named.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{broadcast, mpsc, watch};

use crate::board::{CloudBoard, ProjectKey};
use crate::socket::{self, ClientFrame, ConnEvent, ExitReason, Keepalive, ServerFrame};
use crate::{socket_url, socket_url_at, TokenSource};

/// Event fan-out capacity. A lagging subscriber drops rather than blocking the
/// producer; the host turns a lag into one resync rather than replaying.
const EVENT_CAPACITY: usize = 1024;

/// Every tunable, so the tests can run the real supervisor against a loopback
/// server in milliseconds rather than the seconds production wants.
#[derive(Debug, Clone)]
pub struct ManagerConfig {
    /// Reconnect backoff. Same shape as chat's: fast enough that a laptop
    /// waking reconnects before the developer notices, slow enough that a
    /// service outage is not a denial-of-service from every desktop at once.
    pub backoff_min: Duration,
    pub backoff_max: Duration,
    /// The pause before the one re-mint a `401` earns. Without it a server
    /// that keeps answering `401` to fresh tokens is dialled in a hot loop.
    pub remint_delay: Duration,
    pub keepalive: Keepalive,
    /// Override the socket base (`ws://127.0.0.1:port`). `None` uses the
    /// environment ladder in [`crate::socket_url`].
    pub ws_base: Option<String>,
}

impl Default for ManagerConfig {
    fn default() -> Self {
        Self {
            backoff_min: Duration::from_secs(1),
            backoff_max: Duration::from_secs(30),
            remint_delay: Duration::from_secs(1),
            keepalive: Keepalive::default(),
            ws_base: None,
        }
    }
}

/// What the host forwards to the renderer.
#[derive(Debug, Clone)]
pub enum ArtifactsEvent {
    /// A Project's remote board changed. The host re-emits the existing
    /// `atlas:capture-changed`, so the Timeline re-reads through the path it
    /// already has rather than growing a second refresh route.
    BoardChanged { key: ProjectKey },
    /// One timeline entry was inserted or updated in an open Session.
    EntryUpsert {
        key: ProjectKey,
        session_id: String,
        change: String,
        entry: serde_json::Value,
    },
    /// A comment was posted, edited, resolved or deleted.
    ///
    /// Boxed for the same reason `ConnEvent::Frame` is: a `Comment` dwarfs the
    /// other variants, and this is a broadcast channel with a 1024 backlog.
    CommentUpsert {
        key: ProjectKey,
        session_id: String,
        comment: Box<crate::model::Comment>,
    },
    /// Who else is looking at this Project.
    Presence {
        key: ProjectKey,
        online: Vec<String>,
    },
    /// Membership was revoked. Terminal — nothing reconnects after this.
    Revoked { key: ProjectKey },
    /// Local state has a gap it cannot see — a subscriber fell behind and
    /// frames were dropped, or a socket reconnected after carrying a
    /// subscription. Refetch rather than trusting what is held.
    Resync,
}

/// What one socket is for: a Project's board, or one Session inside it.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Slot {
    pub key: ProjectKey,
    /// `None` = board socket; `Some` = follower, subscribed to this Session.
    pub session: Option<String>,
}

impl Slot {
    fn board(key: ProjectKey) -> Self {
        Self { key, session: None }
    }

    fn follower(key: ProjectKey, session_id: &str) -> Self {
        Self {
            key,
            session: Some(session_id.to_string()),
        }
    }

    fn label(&self) -> String {
        match &self.session {
            Some(session) => format!("{}/{session}", self.key.1),
            None => self.key.1.clone(),
        }
    }
}

/// One live (or reconnecting) socket.
struct Connection {
    /// The supervisor's identity. Monotonic per manager; a supervisor may only
    /// mutate or remove the slot whose epoch equals its own.
    epoch: u64,
    /// Held for its `Drop`: the supervisor watches the receiving side and
    /// treats the sender going away as its stop signal. Removing the slot is
    /// the whole of "stop this socket".
    _stop: watch::Sender<()>,
    /// The current attempt's sender — installed before each dial, cleared
    /// after. `None` while minting or backing off.
    outbound: Option<mpsc::UnboundedSender<ClientFrame>>,
}

/// A Session someone is looking at: `(project_id, session_id)` → how many.
type FollowKey = (String, String);

/// Everything under one lock, so there is no lock order to get wrong.
#[derive(Default)]
struct Registry {
    connections: HashMap<Slot, Connection>,
    /// Who wants which Session, independent of any socket and of whether an
    /// Organisation is known yet. Pruned only by the last `unfollow`.
    followers: HashMap<FollowKey, usize>,
    /// The Organisation every socket is dialled under. `None` between a
    /// sign-out (or the boot retarget that precedes auth) and the next
    /// retarget that names one.
    active_org: Option<String>,
}

pub struct ArtifactsManager {
    tokens: Arc<dyn TokenSource>,
    board: Arc<CloudBoard>,
    events: broadcast::Sender<ArtifactsEvent>,
    registry: Mutex<Registry>,
    next_epoch: AtomicU64,
    config: ManagerConfig,
}

impl ArtifactsManager {
    pub fn new(tokens: Arc<dyn TokenSource>, board: Arc<CloudBoard>) -> Arc<Self> {
        Self::with_config(tokens, board, ManagerConfig::default())
    }

    pub fn with_config(
        tokens: Arc<dyn TokenSource>,
        board: Arc<CloudBoard>,
        config: ManagerConfig,
    ) -> Arc<Self> {
        let (events, _) = broadcast::channel(EVENT_CAPACITY);
        Arc::new(Self {
            tokens,
            board,
            events,
            registry: Mutex::new(Registry::default()),
            next_epoch: AtomicU64::new(0),
            config,
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ArtifactsEvent> {
        self.events.subscribe()
    }

    pub fn board(&self) -> Arc<CloudBoard> {
        Arc::clone(&self.board)
    }

    /// Name the Organisation and connect exactly this set of Projects' board
    /// sockets, and nothing else. Followers are left alone, except that any
    /// recorded before the Organisation was known are dialled now.
    ///
    /// Declarative rather than incremental: the caller states what should be
    /// live and this reconciles. A `connect`/`disconnect` pair would leave the
    /// set wrong the first time a caller forgot one half.
    ///
    /// **Idempotent for a socket already open.** Calling this with the same
    /// set is a no-op for every live socket, which matters because the host
    /// calls it on every auth, Organisation and binding change.
    pub fn retarget(self: &Arc<Self>, org_id: &str, project_ids: Vec<String>) {
        let (to_start, stopped) = {
            let Ok(mut registry) = self.registry.lock() else {
                return;
            };
            registry.active_org = Some(org_id.to_string());

            // Drop the board sockets no longer wanted, and their rows with them
            // — a Project we are not listening to cannot be kept current. A
            // follower under another Organisation goes too, without forgetting
            // anything: its rows belong to a board that was already cleared.
            let stale: Vec<Slot> = registry
                .connections
                .keys()
                .filter(|slot| match &slot.session {
                    None => slot.key.0 != org_id || !project_ids.contains(&slot.key.1),
                    Some(_) => slot.key.0 != org_id,
                })
                .cloned()
                .collect();
            for slot in &stale {
                registry.connections.remove(slot);
                if slot.session.is_none() {
                    self.board.forget_project(&slot.key);
                }
            }
            self.clear_orphaned_presence(&registry, stale.iter().map(|slot| &slot.key));

            let mut to_start: Vec<Slot> = project_ids
                .iter()
                .map(|id| Slot::board((org_id.to_string(), id.clone())))
                .filter(|slot| !registry.connections.contains_key(slot))
                .collect();
            for ((project_id, session_id), refs) in &registry.followers {
                if *refs == 0 {
                    continue;
                }
                let slot = Slot::follower((org_id.to_string(), project_id.clone()), session_id);
                if !registry.connections.contains_key(&slot) {
                    to_start.push(slot);
                }
            }
            (to_start, stale)
        };

        tracing::info!(
            target: "atlas_artifacts",
            "retarget: wanted={} started={:?} stopped={:?}",
            project_ids.len(),
            to_start.iter().map(Slot::label).collect::<Vec<_>>(),
            stopped.iter().map(Slot::label).collect::<Vec<_>>(),
        );

        for slot in to_start {
            self.start(slot);
        }
    }

    /// Drop every socket and every cached row. Called on sign-out and on an
    /// Organisation switch, so the incoming tenant inherits nothing. Who is
    /// following what is kept: the surfaces still hold their watches, and the
    /// next retarget that names an Organisation dials them again.
    pub fn shutdown(&self) {
        if let Ok(mut registry) = self.registry.lock() {
            let n = registry.connections.len();
            let dropped: Vec<ProjectKey> = registry
                .connections
                .keys()
                .map(|slot| slot.key.clone())
                .collect();
            registry.connections.clear();
            self.clear_orphaned_presence(&registry, dropped.iter());
            registry.active_org = None;
            tracing::info!(target: "atlas_artifacts", "shutdown: dropped {n} sockets");
        }
        self.board.clear();
    }

    /// Follow one Session's entries and comments.
    ///
    /// Opens a socket subscribed to that Session, or shares the one already
    /// open for it. Recorded whether or not an Organisation is known yet.
    pub fn follow(self: &Arc<Self>, project_id: &str, session_id: &str) {
        let to_start = {
            let Ok(mut registry) = self.registry.lock() else {
                return;
            };
            let refs = registry
                .followers
                .entry((project_id.to_string(), session_id.to_string()))
                .or_insert(0);
            *refs += 1;
            let refs = *refs;
            let org = registry.active_org.clone();
            let (verdict, slot) = match org {
                None => ("waiting for an organisation", None),
                Some(org) => {
                    let slot = Slot::follower((org, project_id.to_string()), session_id);
                    if registry.connections.contains_key(&slot) {
                        ("already open", None)
                    } else {
                        ("dialling", Some(slot))
                    }
                }
            };
            tracing::info!(
                target: "atlas_artifacts",
                "follow {session_id} on {project_id} (refs={refs}): {verdict}"
            );
            slot
        };
        if let Some(slot) = to_start {
            self.start(slot);
        }
    }

    /// Stop following a Session. The socket closes when nobody is left.
    pub fn unfollow(&self, project_id: &str, session_id: &str) {
        let Ok(mut registry) = self.registry.lock() else {
            return;
        };
        let key = (project_id.to_string(), session_id.to_string());
        let Some(refs) = registry.followers.get_mut(&key) else {
            return;
        };
        *refs = refs.saturating_sub(1);
        let remaining = *refs;
        if remaining == 0 {
            registry.followers.remove(&key);
            // Any Organisation: a follower that outlived an org switch has no
            // one left to serve either. Removing the slot ends its task, and
            // `run` sends Close when the outbound end goes away.
            let closing: Vec<ProjectKey> = registry
                .connections
                .keys()
                .filter(|slot| {
                    slot.key.1 == project_id && slot.session.as_deref() == Some(session_id)
                })
                .map(|slot| slot.key.clone())
                .collect();
            registry.connections.retain(|slot, _| {
                !(slot.key.1 == project_id && slot.session.as_deref() == Some(session_id))
            });
            self.clear_orphaned_presence(&registry, closing.iter());
        }
        tracing::info!(
            target: "atlas_artifacts",
            "unfollow {session_id} on {project_id}: {}",
            if remaining == 0 { "closing" } else { "still followed" }
        );
    }

    /// Announce an empty roster for every Project this machine no longer has
    /// any socket on.
    ///
    /// The server only says who is here while a socket is open, and it says
    /// nothing to a socket that has gone. Without this, the last roster a
    /// closed follower heard would stay on screen indefinitely — teammates
    /// "online" on a Project nobody here is listening to any more. A Project
    /// still served by another slot (its board socket, another follower) keeps
    /// its roster: that socket is still hearing the truth.
    fn clear_orphaned_presence<'a>(
        &self,
        registry: &Registry,
        keys: impl Iterator<Item = &'a ProjectKey>,
    ) {
        let mut seen: Vec<&ProjectKey> = Vec::new();
        for key in keys {
            if seen.contains(&key) {
                continue;
            }
            seen.push(key);
            if registry.connections.keys().any(|slot| &slot.key == key) {
                continue;
            }
            let _ = self.events.send(ArtifactsEvent::Presence {
                key: key.clone(),
                online: Vec::new(),
            });
        }
    }

    /// Empty a Project's roster while this slot's socket is down — unless
    /// another slot on the same Project is still there to hear it.
    ///
    /// Held under the registry lock, like [`Self::clear_orphaned_presence`]
    /// and the `presence` arm of [`Self::apply`], so a roster and its clearing
    /// can never be broadcast in the wrong order.
    fn clear_presence_while_down(&self, slot: &Slot, epoch: u64) {
        let Ok(registry) = self.registry.lock() else {
            return;
        };
        // A slot that has been replaced is somebody else's to speak for.
        if registry
            .connections
            .get(slot)
            .is_some_and(|conn| conn.epoch != epoch)
        {
            return;
        }
        if registry
            .connections
            .keys()
            .any(|other| other.key == slot.key && other != slot)
        {
            return;
        }
        let _ = self.events.send(ArtifactsEvent::Presence {
            key: slot.key.clone(),
            online: Vec::new(),
        });
    }

    /// Install the current attempt's sender — only if the slot is still ours.
    fn install_outbound(
        &self,
        slot: &Slot,
        epoch: u64,
        tx: mpsc::UnboundedSender<ClientFrame>,
    ) -> bool {
        let Ok(mut registry) = self.registry.lock() else {
            return false;
        };
        match registry.connections.get_mut(slot) {
            Some(conn) if conn.epoch == epoch => {
                conn.outbound = Some(tx);
                true
            }
            _ => false,
        }
    }

    /// Clear the attempt's sender, but only the one this epoch installed.
    fn release_outbound(&self, slot: &Slot, epoch: u64) {
        let Ok(mut registry) = self.registry.lock() else {
            return;
        };
        if let Some(conn) = registry.connections.get_mut(slot) {
            if conn.epoch == epoch {
                conn.outbound = None;
            }
        }
    }

    /// Remove the slot this epoch owns. A follower's refcount stays, so the
    /// next retarget dials it again.
    fn retire(&self, slot: &Slot, epoch: u64) {
        let Ok(mut registry) = self.registry.lock() else {
            return;
        };
        if registry
            .connections
            .get(slot)
            .is_some_and(|conn| conn.epoch == epoch)
        {
            registry.connections.remove(slot);
        }
    }

    /// Does a board socket exist for this Project? A follower defers to it for
    /// `session.summary`, or every summary would land twice.
    fn has_board_socket(&self, key: &ProjectKey) -> bool {
        self.registry
            .lock()
            .is_ok_and(|r| r.connections.contains_key(&Slot::board(key.clone())))
    }

    fn url_for(&self, key: &ProjectKey) -> String {
        match self.config.ws_base.as_deref() {
            Some(base) => socket_url_at(base, &key.0, &key.1),
            None => socket_url(&key.0, &key.1),
        }
    }

    #[cfg(test)]
    fn epoch_of(&self, slot: &Slot) -> Option<u64> {
        self.registry
            .lock()
            .ok()?
            .connections
            .get(slot)
            .map(|c| c.epoch)
    }

    #[cfg(test)]
    fn has_connection(&self, slot: &Slot) -> bool {
        self.registry
            .lock()
            .is_ok_and(|r| r.connections.contains_key(slot))
    }

    #[cfg(test)]
    fn refs(&self, project_id: &str, session_id: &str) -> usize {
        self.registry
            .lock()
            .ok()
            .and_then(|r| {
                r.followers
                    .get(&(project_id.to_string(), session_id.to_string()))
                    .copied()
            })
            .unwrap_or(0)
    }

    fn start(self: &Arc<Self>, slot: Slot) {
        let epoch = self.next_epoch.fetch_add(1, Ordering::SeqCst) + 1;
        let (stop_tx, mut stop_rx) = watch::channel(());
        if let Ok(mut registry) = self.registry.lock() {
            registry.connections.insert(
                slot.clone(),
                Connection {
                    epoch,
                    _stop: stop_tx,
                    outbound: None,
                },
            );
        }

        let manager = Arc::clone(self);
        tokio::spawn(async move {
            let cfg = manager.config.clone();
            let label = slot.label();
            let key = slot.key.clone();
            let mut backoff = cfg.backoff_min;
            // One re-mint per dial, not per lifetime: a JWT lives ten minutes
            // and can expire between minting and dialling, but a 401 that
            // survives a fresh token is a real refusal.
            let mut remint_used = false;
            let mut attempts: u32 = 0;

            loop {
                if stopped(&stop_rx) {
                    tracing::info!(target: "atlas_artifacts", "{label}: supervisor {epoch} stopped");
                    return;
                }

                let token = tokio::select! {
                    _ = stop_rx.changed() => return,
                    minted = manager.tokens.mint() => match minted {
                        Ok(token) => token,
                        Err(e) => {
                            // Could be "signed out" or "the auth service
                            // blinked", and the two are not distinguishable
                            // here — so back off rather than tearing the
                            // socket down.
                            tracing::debug!(target: "atlas_artifacts::manager", "mint failed: {e}");
                            if !sleep_or_stop(&mut stop_rx, backoff).await {
                                return;
                            }
                            backoff = (backoff * 2).min(cfg.backoff_max);
                            continue;
                        }
                    },
                };

                let (tx, rx) = mpsc::unbounded_channel();
                let (conn_tx, mut conn_rx) = mpsc::unbounded_channel();
                if !manager.install_outbound(&slot, epoch, tx.clone()) {
                    // The slot was replaced or removed while we were minting.
                    return;
                }
                // A follower announces its Session before the dial, so it is
                // the first frame on the wire after the 101: the server holds
                // the subscription per socket, and this socket has none yet.
                if let Some(session_id) = &slot.session {
                    let _ = tx.send(ClientFrame::SessionSubscribe {
                        session_id: session_id.clone(),
                    });
                }
                drop(tx);

                let dial = tokio::spawn(socket::run(
                    manager.url_for(&key),
                    token,
                    rx,
                    conn_tx,
                    cfg.keepalive,
                ));

                let mut exit = ExitReason::Closed;
                let mut stopping = false;
                let mut opened = false;
                loop {
                    tokio::select! {
                        _ = stop_rx.changed() => {
                            stopping = true;
                            break;
                        }
                        event = conn_rx.recv() => match event {
                            Some(ConnEvent::Frame(frame)) => {
                                if !opened {
                                    opened = true;
                                    if attempts > 0 && slot.session.is_some() {
                                        // Whatever the server said while we
                                        // were away is gone; the renderer must
                                        // re-read rather than carry the gap.
                                        tracing::info!(
                                            target: "atlas_artifacts",
                                            "{label}: reconnected with a subscription; asking for a resync"
                                        );
                                        let _ = manager.events.send(ArtifactsEvent::Resync);
                                    }
                                }
                                backoff = cfg.backoff_min;
                                remint_used = false;
                                manager.apply(&slot, epoch, *frame);
                            }
                            Some(ConnEvent::Closed(reason)) => {
                                exit = reason;
                                break;
                            }
                            None => break,
                        },
                    }
                }

                // Dropping the slot's sender is what makes a still-open socket
                // close politely: `run` sees its outbound end and sends Close.
                manager.release_outbound(&slot, epoch);
                let _ = dial.await;

                if stopping || stopped(&stop_rx) {
                    tracing::info!(target: "atlas_artifacts", "{label}: socket stopped");
                    return;
                }
                attempts += 1;
                // The socket dropped on its own (network, idle, refusal). Until
                // it is back, nothing here hears who comes or goes on this
                // Project, so the roster it last heard is no longer the truth.
                manager.clear_presence_while_down(&slot, epoch);

                match exit {
                    ExitReason::Revoked => {
                        manager.retire(&slot, epoch);
                        if slot.session.is_none() {
                            manager.board.forget_project(&key);
                        }
                        let _ = manager
                            .events
                            .send(ArtifactsEvent::Revoked { key: key.clone() });
                        return;
                    }
                    ExitReason::Forbidden => {
                        tracing::warn!(
                            target: "atlas_artifacts",
                            "{label}: not a member; retiring the socket until the next retarget"
                        );
                        manager.retire(&slot, epoch);
                        // A board socket's rows go with it. A follower's do
                        // not: a teammate's Project the board lists is still
                        // readable over HTTP.
                        if slot.session.is_none() {
                            manager.board.forget_project(&key);
                        }
                        return;
                    }
                    ExitReason::Unauthorized if !remint_used => {
                        // Round again with a fresh token, after a breath.
                        remint_used = true;
                        if !sleep_or_stop(&mut stop_rx, cfg.remint_delay).await {
                            return;
                        }
                        continue;
                    }
                    ExitReason::Transport(ref reason) if reason == socket::IDLE_EXIT => {
                        tracing::info!(target: "atlas_artifacts", "{label}: idle timeout; redialling");
                    }
                    _ => {}
                }

                if !sleep_or_stop(&mut stop_rx, backoff).await {
                    return;
                }
                backoff = (backoff * 2).min(cfg.backoff_max);
            }
        });
    }

    /// Fold one frame into the cache and announce what changed.
    fn apply(&self, slot: &Slot, epoch: u64, frame: ServerFrame) {
        let key = &slot.key;
        match frame {
            // Nothing to record: the roster arrives again as `presence`, and
            // the board is refreshed over HTTP rather than from the greeting.
            ServerFrame::Hello { .. } => {}
            ServerFrame::SessionSummary { mut summary } => {
                // Every socket on a Project gets the summary. The board socket
                // owns it when there is one; a follower only steps in for a
                // Project this machine has no board socket for.
                if slot.session.is_some() && self.has_board_socket(key) {
                    return;
                }
                // The board is keyed by (Project, Session). The socket is one
                // Project's, so a frame that omits its Project still belongs to it.
                if summary.workspace_id.is_empty() {
                    summary.workspace_id = key.1.clone();
                }
                self.board.upsert(&key.0, summary);
                let _ = self
                    .events
                    .send(ArtifactsEvent::BoardChanged { key: key.clone() });
            }
            ServerFrame::ArtifactUpsert {
                session_id,
                change,
                entry,
            } => {
                let _ = self.events.send(ArtifactsEvent::EntryUpsert {
                    key: key.clone(),
                    session_id,
                    change,
                    entry,
                });
            }
            ServerFrame::CommentUpsert {
                session_id,
                comment,
            } => {
                let _ = self.events.send(ArtifactsEvent::CommentUpsert {
                    key: key.clone(),
                    session_id,
                    comment: Box::new(comment),
                });
            }
            ServerFrame::Presence { online } => {
                // Only while this socket is still the slot's, and sent under the
                // registry lock: a frame read just as the slot was removed must
                // not land after the empty roster that removal announced, or a
                // teammate would stay "online" on a Project nobody here hears.
                let Ok(registry) = self.registry.lock() else {
                    return;
                };
                if !registry
                    .connections
                    .get(slot)
                    .is_some_and(|conn| conn.epoch == epoch)
                {
                    return;
                }
                let _ = self.events.send(ArtifactsEvent::Presence {
                    key: key.clone(),
                    online,
                });
            }
            ServerFrame::Unknown => {}
        }
    }
}

/// Has the slot this supervisor was started for been removed?
fn stopped(stop_rx: &watch::Receiver<()>) -> bool {
    stop_rx.has_changed().is_err()
}

/// Sleep, unless the slot goes away first. `false` means stop.
async fn sleep_or_stop(stop_rx: &mut watch::Receiver<()>, wait: Duration) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(wait) => true,
        _ = stop_rx.changed() => false,
    }
}

#[cfg(test)]
mod tests {
    //! The supervisor against a real loopback WebSocket server, so what is
    //! asserted is what reached the wire and what state the registry ended in.

    use std::future::Future;
    use std::pin::Pin;

    use futures_util::{SinkExt, StreamExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::time::timeout;
    use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
    use tokio_tungstenite::tungstenite::http::{HeaderValue, StatusCode};
    use tokio_tungstenite::tungstenite::Message as WsMessage;
    use tokio_tungstenite::WebSocketStream;

    use super::*;

    struct Tok;
    impl TokenSource for Tok {
        fn mint(&self) -> Pin<Box<dyn Future<Output = crate::Result<String>> + Send + '_>> {
            Box::pin(async { Ok("tok".to_string()) })
        }
    }

    #[derive(Clone, Copy)]
    enum Mode {
        /// Handshake, greet with `workspace.hello`, hand the socket over.
        Normal,
        /// Accept TCP and never answer the handshake.
        Silent,
        /// Refuse every handshake with 404.
        Reject404,
    }

    #[allow(clippy::large_enum_variant)]
    enum Accepted {
        Socket(WebSocketStream<TcpStream>),
        /// Held so the peer sees an open TCP connection that never answers.
        Raw(#[allow(dead_code)] TcpStream),
        Refused,
    }

    struct Loopback {
        base: String,
        accepted: mpsc::UnboundedReceiver<Accepted>,
    }

    impl Loopback {
        async fn start(mode: Mode) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0")
                .await
                .expect("bind loopback");
            let base = format!("ws://{}", listener.local_addr().unwrap());
            let (tx, rx) = mpsc::unbounded_channel();
            tokio::spawn(async move {
                loop {
                    let Ok((stream, _)) = listener.accept().await else {
                        break;
                    };
                    let tx = tx.clone();
                    tokio::spawn(async move {
                        match mode {
                            Mode::Silent => {
                                let _ = tx.send(Accepted::Raw(stream));
                            }
                            Mode::Reject404 => {
                                let _ = tokio_tungstenite::accept_hdr_async(
                                    stream,
                                    |_req: &Request, _res: Response| {
                                        let mut err =
                                            ErrorResponse::new(Some("no such workspace".into()));
                                        *err.status_mut() = StatusCode::NOT_FOUND;
                                        Err(err)
                                    },
                                )
                                .await;
                                let _ = tx.send(Accepted::Refused);
                            }
                            Mode::Normal => {
                                let accepted = tokio_tungstenite::accept_hdr_async(
                                    stream,
                                    |_req: &Request, mut res: Response| {
                                        res.headers_mut().insert(
                                            "Sec-WebSocket-Protocol",
                                            HeaderValue::from_static("atlas.v1"),
                                        );
                                        Ok(res)
                                    },
                                )
                                .await;
                                if let Ok(mut ws) = accepted {
                                    let _ = ws
                                        .send(WsMessage::Text(
                                            r#"{"t":"workspace.hello","online":[]}"#.into(),
                                        ))
                                        .await;
                                    let _ = tx.send(Accepted::Socket(ws));
                                }
                            }
                        }
                    });
                }
            });
            Self { base, accepted: rx }
        }

        async fn next(&mut self, within: Duration) -> Accepted {
            timeout(within, self.accepted.recv())
                .await
                .expect("an accept within the window")
                .expect("server alive")
        }

        async fn socket(&mut self, within: Duration) -> WebSocketStream<TcpStream> {
            match self.next(within).await {
                Accepted::Socket(ws) => ws,
                _ => panic!("expected a completed handshake"),
            }
        }

        async fn none(&mut self, within: Duration) {
            assert!(
                timeout(within, self.accepted.recv()).await.is_err(),
                "no accept was expected in this window"
            );
        }
    }

    /// The next text frame, skipping pings and pongs.
    async fn next_text(ws: &mut WebSocketStream<TcpStream>, within: Duration) -> serde_json::Value {
        let deadline = tokio::time::Instant::now() + within;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let msg = timeout(remaining, ws.next())
                .await
                .expect("a frame within the window");
            match msg {
                Some(Ok(WsMessage::Text(text))) => return serde_json::from_str(&text).unwrap(),
                Some(Ok(_)) => continue,
                other => panic!("socket ended: {other:?}"),
            }
        }
    }

    async fn next_ping(ws: &mut WebSocketStream<TcpStream>, within: Duration) {
        let deadline = tokio::time::Instant::now() + within;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let msg = timeout(remaining, ws.next())
                .await
                .expect("a ping within the window");
            match msg {
                Some(Ok(WsMessage::Ping(_))) => return,
                Some(Ok(_)) => continue,
                other => panic!("socket ended: {other:?}"),
            }
        }
    }

    fn config(base: &str) -> ManagerConfig {
        ManagerConfig {
            backoff_min: Duration::from_millis(50),
            backoff_max: Duration::from_millis(200),
            remint_delay: Duration::from_millis(50),
            keepalive: Keepalive {
                ping: Duration::from_millis(100),
                idle: Duration::from_millis(300),
                dial: Duration::from_millis(300),
            },
            ws_base: Some(base.to_string()),
        }
    }

    fn manager(base: &str) -> Arc<ArtifactsManager> {
        ArtifactsManager::with_config(Arc::new(Tok), Arc::new(CloudBoard::new()), config(base))
    }

    fn key() -> ProjectKey {
        ("org_1".to_string(), "ws_1".to_string())
    }

    fn board() -> Slot {
        Slot::board(key())
    }

    fn follower(session_id: &str) -> Slot {
        Slot::follower(key(), session_id)
    }

    /// Wait for the peer to close, skipping anything else it sends first.
    async fn expect_close(ws: &mut WebSocketStream<TcpStream>, within: Duration) {
        loop {
            match timeout(within, ws.next())
                .await
                .expect("a close within the window")
            {
                Some(Ok(WsMessage::Close(_))) | None => break,
                Some(Ok(_)) => continue,
                Some(Err(_)) => break,
            }
        }
    }

    const SOON: Duration = Duration::from_secs(2);

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn retarget_twice_with_the_same_set_keeps_the_socket_and_redials_after_a_close() {
        // The bug this crate shipped with: a second retarget with an unchanged
        // set made every live supervisor stale, so the first close was final.
        let mut server = Loopback::start(Mode::Normal).await;
        let manager = manager(&server.base);

        manager.retarget("org_1", vec!["ws_1".into()]);
        let mut first = server.socket(SOON).await;
        let epoch = manager.epoch_of(&board()).expect("connected");

        manager.retarget("org_1", vec!["ws_1".into()]);
        server.none(Duration::from_millis(200)).await;
        assert_eq!(
            manager.epoch_of(&board()),
            Some(epoch),
            "the live slot was replaced"
        );

        let _ = first.send(WsMessage::Close(None)).await;
        let _second = server.socket(SOON).await;
        assert_eq!(
            manager.epoch_of(&board()),
            Some(epoch),
            "the redial came from a new supervisor"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_follow_opens_its_own_socket_and_subscribes_first() {
        // No board socket at all: the Session lives in a Project this machine
        // never bound, which used to wait forever for a socket.
        let mut server = Loopback::start(Mode::Normal).await;
        let manager = manager(&server.base);

        manager.retarget("org_1", vec![]);
        manager.follow("ws_1", "ses_1");
        let mut ws = server.socket(SOON).await;
        let frame = next_text(&mut ws, SOON).await;
        assert_eq!(frame["t"], "session.subscribe");
        assert_eq!(frame["session_id"], "ses_1");
        assert!(manager.has_connection(&follower("ses_1")));
        assert!(!manager.has_connection(&board()));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_follow_before_the_organisation_is_known_is_dialled_by_the_next_retarget() {
        // Boot: the first retarget runs before auth resolves and names no
        // Organisation; a follow issued in that window must not be lost.
        let mut server = Loopback::start(Mode::Normal).await;
        let manager = manager(&server.base);

        manager.follow("ws_1", "ses_1");
        server.none(Duration::from_millis(200)).await;
        assert_eq!(manager.refs("ws_1", "ses_1"), 1);

        manager.retarget("org_1", vec![]);
        let mut ws = server.socket(SOON).await;
        assert_eq!(next_text(&mut ws, SOON).await["session_id"], "ses_1");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn two_follows_share_one_socket_and_the_last_unfollow_closes_it() {
        // The Timeline and a chat tab on the same Session. Under the old
        // one-subscription-per-Project rule, whichever unmounted last took the
        // other's subscription with it.
        let mut server = Loopback::start(Mode::Normal).await;
        let manager = manager(&server.base);

        manager.retarget("org_1", vec![]);
        manager.follow("ws_1", "ses_1");
        manager.follow("ws_1", "ses_1");
        let mut ws = server.socket(SOON).await;
        server.none(Duration::from_millis(200)).await;
        assert_eq!(manager.refs("ws_1", "ses_1"), 2);

        manager.unfollow("ws_1", "ses_1");
        assert!(
            manager.has_connection(&follower("ses_1")),
            "one watcher left"
        );
        manager.unfollow("ws_1", "ses_1");
        expect_close(&mut ws, SOON).await;
        server.none(Duration::from_millis(300)).await;
        assert!(!manager.has_connection(&follower("ses_1")));
        assert_eq!(manager.refs("ws_1", "ses_1"), 0);
    }

    /// The next `Presence` event for `key`, skipping everything else.
    async fn next_presence(
        events: &mut broadcast::Receiver<ArtifactsEvent>,
        key: &ProjectKey,
        within: Duration,
    ) -> Vec<String> {
        let deadline = tokio::time::Instant::now() + within;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            match timeout(remaining, events.recv())
                .await
                .expect("a presence event within the window")
            {
                Ok(ArtifactsEvent::Presence { key: k, online }) if &k == key => return online,
                Ok(_) => continue,
                Err(e) => panic!("event channel: {e}"),
            }
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_last_socket_on_a_project_closing_empties_its_roster() {
        // A roster heard on a follower must not outlive the follower: the
        // server never tells a closed socket that anybody left.
        let mut server = Loopback::start(Mode::Normal).await;
        let manager = manager(&server.base);
        let mut events = manager.subscribe();

        manager.retarget("org_1", vec![]);
        manager.follow("ws_1", "ses_1");
        let mut ws = server.socket(SOON).await;
        let _ = next_text(&mut ws, SOON).await; // the subscribe
        ws.send(WsMessage::Text(
            r#"{"t":"presence","online":["user_ada"]}"#.into(),
        ))
        .await
        .unwrap();
        assert_eq!(
            next_presence(&mut events, &key(), SOON).await,
            vec!["user_ada".to_string()]
        );

        manager.unfollow("ws_1", "ses_1");
        assert!(
            next_presence(&mut events, &key(), SOON).await.is_empty(),
            "closing the only socket on the Project clears who is on it"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_socket_that_drops_on_its_own_empties_its_roster_until_it_is_back() {
        // Reconnecting can take up to the backoff ceiling; the roster heard
        // before the drop must not stand in for the truth meanwhile.
        let mut server = Loopback::start(Mode::Normal).await;
        let manager = manager(&server.base);
        let mut events = manager.subscribe();

        manager.retarget("org_1", vec![]);
        manager.follow("ws_1", "ses_1");
        let mut ws = server.socket(SOON).await;
        let _ = next_text(&mut ws, SOON).await; // the subscribe
        ws.send(WsMessage::Text(
            r#"{"t":"presence","online":["user_ada"]}"#.into(),
        ))
        .await
        .unwrap();
        assert_eq!(
            next_presence(&mut events, &key(), SOON).await,
            vec!["user_ada".to_string()]
        );

        drop(ws);
        assert!(
            next_presence(&mut events, &key(), SOON).await.is_empty(),
            "a dropped socket hears nobody, so it claims nobody"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_project_still_on_a_board_socket_keeps_its_roster_when_a_follower_closes() {
        let mut server = Loopback::start(Mode::Normal).await;
        let manager = manager(&server.base);

        manager.retarget("org_1", vec!["ws_1".into()]);
        let _board = server.socket(SOON).await;
        manager.follow("ws_1", "ses_1");
        let _follower = server.socket(SOON).await;
        let mut events = manager.subscribe();

        manager.unfollow("ws_1", "ses_1");
        // Nothing to say: the board socket is still hearing the truth.
        let quiet = timeout(Duration::from_millis(200), async {
            loop {
                if let Ok(ArtifactsEvent::Presence { .. }) = events.recv().await {
                    return;
                }
            }
        })
        .await;
        assert!(
            quiet.is_err(),
            "no presence event while the board socket lives"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn retarget_never_touches_a_follower() {
        let mut server = Loopback::start(Mode::Normal).await;
        let manager = manager(&server.base);

        manager.retarget("org_1", vec!["ws_1".into()]);
        let mut board_ws = server.socket(SOON).await;
        manager.follow("ws_1", "ses_1");
        let mut follower_ws = server.socket(SOON).await;
        assert_eq!(
            next_text(&mut follower_ws, SOON).await["t"],
            "session.subscribe"
        );

        // The Project drops out of the bound set: its board socket closes, the
        // follower stays exactly as it was.
        let epoch = manager
            .epoch_of(&follower("ses_1"))
            .expect("follower connected");
        manager.retarget("org_1", vec![]);
        expect_close(&mut board_ws, SOON).await;
        server.none(Duration::from_millis(200)).await;
        assert_eq!(manager.epoch_of(&follower("ses_1")), Some(epoch));
        assert!(!manager.has_connection(&board()));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_comment_frame_on_a_follower_reaches_the_events() {
        let mut server = Loopback::start(Mode::Normal).await;
        let manager = manager(&server.base);
        let mut events = manager.subscribe();

        manager.retarget("org_1", vec![]);
        manager.follow("ws_1", "ses_1");
        let mut ws = server.socket(SOON).await;
        let _ = next_text(&mut ws, SOON).await;

        let frame = r#"{"t":"comment.upsert","session_id":"ses_1","comment":{"id":"c1","sessionId":"ses_1","anchorKind":"message","anchorId":"am-1","authorId":"u1","body":"hi","createdAt":"2026-09-26T00:00:00Z"}}"#;
        let _ = ws.send(WsMessage::Text(frame.into())).await;

        let event = timeout(SOON, events.recv())
            .await
            .expect("an event")
            .expect("channel open");
        match event {
            ArtifactsEvent::CommentUpsert {
                key: k,
                session_id,
                comment,
            } => {
                assert_eq!(k, key());
                assert_eq!(session_id, "ses_1");
                assert_eq!(comment.id, "c1");
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_dropped_follower_resubscribes_and_asks_for_a_resync() {
        let mut server = Loopback::start(Mode::Normal).await;
        let manager = manager(&server.base);
        let mut events = manager.subscribe();

        manager.retarget("org_1", vec![]);
        manager.follow("ws_1", "ses_1");
        let mut first = server.socket(SOON).await;
        assert_eq!(next_text(&mut first, SOON).await["t"], "session.subscribe");
        // A first open is not a reconnect: nothing was missed, nothing to reload.
        assert!(matches!(
            events.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));

        let _ = first.send(WsMessage::Close(None)).await;
        let mut second = server.socket(SOON).await;
        let frame = next_text(&mut second, SOON).await;
        assert_eq!(frame["t"], "session.subscribe");
        assert_eq!(frame["session_id"], "ses_1");

        // The drop itself empties the roster first: nobody was listening.
        let event = timeout(SOON, events.recv())
            .await
            .expect("an event")
            .expect("channel open");
        assert!(
            matches!(&event, ArtifactsEvent::Presence { online, .. } if online.is_empty()),
            "{event:?}"
        );
        let event = timeout(SOON, events.recv())
            .await
            .expect("an event")
            .expect("channel open");
        assert!(matches!(event, ArtifactsEvent::Resync), "{event:?}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shutdown_drops_sockets_but_keeps_followers_for_the_next_retarget() {
        let mut server = Loopback::start(Mode::Normal).await;
        let manager = manager(&server.base);

        manager.retarget("org_1", vec![]);
        manager.follow("ws_1", "ses_1");
        let mut ws = server.socket(SOON).await;
        let _ = next_text(&mut ws, SOON).await;

        manager.shutdown();
        expect_close(&mut ws, SOON).await;
        assert!(!manager.has_connection(&follower("ses_1")));
        assert_eq!(manager.refs("ws_1", "ses_1"), 1);

        manager.retarget("org_1", vec![]);
        let mut again = server.socket(SOON).await;
        assert_eq!(next_text(&mut again, SOON).await["session_id"], "ses_1");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_ping_goes_out_on_the_interval_and_a_mute_server_is_redialled() {
        let mut server = Loopback::start(Mode::Normal).await;
        let manager = manager(&server.base);

        manager.retarget("org_1", vec!["ws_1".into()]);
        let mut ws = server.socket(SOON).await;
        next_ping(&mut ws, Duration::from_millis(500)).await;

        // Stop polling the server side: no pong ever goes back. The client
        // must notice within `idle` and dial again.
        drop(ws);
        let _redial = server.socket(SOON).await;
        assert!(manager.has_connection(&board()));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_handshake_that_never_answers_is_cut_and_redialled() {
        let mut server = Loopback::start(Mode::Silent).await;
        let manager = manager(&server.base);

        manager.retarget("org_1", vec!["ws_1".into()]);
        let _first = server.next(SOON).await;
        let _second = server.next(SOON).await;
        assert!(manager.has_connection(&board()));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_404_handshake_retries_and_keeps_the_follower() {
        let mut server = Loopback::start(Mode::Reject404).await;
        let manager = manager(&server.base);

        manager.retarget("org_1", vec![]);
        manager.follow("ws_1", "ses_1");
        assert!(matches!(server.next(SOON).await, Accepted::Refused));
        assert!(matches!(server.next(SOON).await, Accepted::Refused));
        assert!(
            manager.has_connection(&follower("ses_1")),
            "a 404 retired the follower"
        );
        assert_eq!(manager.refs("ws_1", "ses_1"), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dropping_a_project_closes_its_socket_politely() {
        let mut server = Loopback::start(Mode::Normal).await;
        let manager = manager(&server.base);

        manager.retarget("org_1", vec!["ws_1".into()]);
        let mut ws = server.socket(SOON).await;
        manager.retarget("org_1", vec![]);
        expect_close(&mut ws, SOON).await;
        server.none(Duration::from_millis(300)).await;
        assert!(!manager.has_connection(&board()));
    }
}
