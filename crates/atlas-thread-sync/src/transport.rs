//! How a session reaches the thread socket.
//!
//! A small trait rather than the WebSocket directly, so the session's whole
//! protocol can be driven in tests against [`FakeThreadServer`] — an
//! in-process stand-in that keeps the server's rules (journal, dense `seq`,
//! idempotent resend, relay to everyone else) — with no network and no worker.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use base64::Engine as _;

use crate::store::FakeStore;
use crate::wire::{
    self, BundleFailure, ClientControl, ConflictInvolved, ConflictResolution, FileKind,
    FileVersion, Frame, FrameKind, MergedFile, RaisedConflict, RemoteRun, RemoteRunStatus, Role,
    RunOutcome, ServerControl, ThreadConflict, ThreadRun, TreeEntry,
};

/// One message on the socket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Message {
    Text(String),
    Binary(Vec<u8>),
}

#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    #[error("the socket is closed")]
    Closed,
    #[error("websocket: {0}")]
    Ws(String),
}

pub trait Transport: Send {
    fn send(&mut self, message: Message)
        -> impl Future<Output = Result<(), TransportError>> + Send;
    /// The next message, or `None` once the socket has closed.
    fn recv(&mut self) -> impl Future<Output = Option<Message>> + Send;
    /// The close code the server sent, once it closed us: 1008 when access
    /// ended, 4403 or 4410 when the thread refuses us. `None` for a dropped
    /// connection, which is worth dialling again.
    fn close_code(&self) -> Option<u16> {
        None
    }
}

/// How the app's loop dials the thread again after a drop (ATL-404).
pub trait Connector: Send + Sync {
    type Transport: Transport;
    fn connect(&self) -> impl Future<Output = Result<Self::Transport, TransportError>> + Send;
    /// Whether a dropped socket is dialled again at all.
    fn reconnects(&self) -> bool {
        true
    }
}

/// A connector that never dials: the loop ends when the socket closes.
pub struct NoReconnect<T>(std::marker::PhantomData<fn() -> T>);

impl<T> Default for NoReconnect<T> {
    fn default() -> Self {
        Self(std::marker::PhantomData)
    }
}

impl<T: Transport> Connector for NoReconnect<T> {
    type Transport = T;
    async fn connect(&self) -> Result<T, TransportError> {
        Err(TransportError::Closed)
    }
    fn reconnects(&self) -> bool {
        false
    }
}

/// Why the server closed the socket for good, for the person — or `None` for
/// a close that dialling again can get past.
pub fn final_close(code: u16) -> Option<&'static str> {
    Some(match code {
        1008 => "Your access to this thread ended — you were removed from the organization or the project. Your replica is kept, but it no longer syncs.",
        4410 => "This thread was closed. Your replica is kept, but it no longer syncs.",
        4403 => "You can no longer open this thread. Your replica is kept, but it no longer syncs.",
        4400 => "This version of Atlas cannot talk to the thread. Update Atlas to keep syncing.",
        _ => return None,
    })
}

// ---------------------------------------------------------------------------
// The real socket
// ---------------------------------------------------------------------------

type Stream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// The thread socket at `{ws_base}/threads/ws?org=&workspace=&thread=`.
pub struct WsTransport {
    stream: Stream,
    /// The close code the server sent, if it closed us (1008 = access revoked).
    pub close_code: Option<u16>,
}

/// The socket URL for one thread, from the ingest base (`https://…` or
/// `wss://…`).
pub fn thread_socket_url(ingest_base: &str, org: &str, workspace: &str, thread: &str) -> String {
    let base = ingest_base.trim_end_matches('/');
    let base = base
        .strip_prefix("https://")
        .map(|rest| format!("wss://{rest}"))
        .or_else(|| {
            base.strip_prefix("http://")
                .map(|rest| format!("ws://{rest}"))
        })
        .unwrap_or_else(|| base.to_string());
    format!("{base}/threads/ws?org={org}&workspace={workspace}&thread={thread}")
}

impl WsTransport {
    /// Dial with the ticket in the subprotocol, the way every Atlas socket
    /// carries it (ADR-0005). The request is never logged: it holds the token.
    pub async fn connect(url: &str, token: &str) -> Result<Self, TransportError> {
        let mut request = url
            .into_client_request()
            .map_err(|e| TransportError::Ws(format!("bad url: {e}")))?;
        let protocols = format!("atlas.v1, atlas.ticket.{token}");
        request.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_str(&protocols)
                .map_err(|_| TransportError::Ws("token is not a header value".into()))?,
        );
        let (stream, _) = tokio_tungstenite::connect_async(request)
            .await
            .map_err(|e| TransportError::Ws(e.to_string()))?;
        Ok(Self {
            stream,
            close_code: None,
        })
    }
}

impl Transport for WsTransport {
    async fn send(&mut self, message: Message) -> Result<(), TransportError> {
        let message = match message {
            Message::Text(text) => WsMessage::Text(text.into()),
            Message::Binary(bytes) => WsMessage::Binary(bytes.into()),
        };
        self.stream
            .send(message)
            .await
            .map_err(|e| TransportError::Ws(e.to_string()))
    }

    async fn recv(&mut self) -> Option<Message> {
        loop {
            match self.stream.next().await? {
                Ok(WsMessage::Text(text)) => return Some(Message::Text(text.to_string())),
                Ok(WsMessage::Binary(bytes)) => return Some(Message::Binary(bytes.to_vec())),
                Ok(WsMessage::Close(frame)) => {
                    self.close_code = frame.map(|f| u16::from(f.code));
                    return None;
                }
                Ok(_) => continue,
                Err(_) => return None,
            }
        }
    }

    fn close_code(&self) -> Option<u16> {
        self.close_code
    }
}

// ---------------------------------------------------------------------------
// The fake server
// ---------------------------------------------------------------------------

struct Journaled {
    seq: u64,
    tree: Option<TreeEntry>,
    /// `None` once compacted into a snapshot (or for a tree change).
    frame: Option<Frame>,
    author: String,
    client: String,
    client_seq: u64,
}

#[derive(Default)]
struct Hub {
    journal: Vec<Journaled>,
    tree: Vec<TreeEntry>,
    next_conn: u64,
    conns: HashMap<u64, Conn>,
    /// Every binary frame any client sent, for tests that count echoes.
    received_updates: u64,
    runs: Vec<FakeRun>,
    /// Accepted merges by `(user, client, clientSeq)`, for idempotent resends.
    merges: HashMap<(String, String, u64), ServerControl>,
    /// Live Run frames relayed, for tests that check nothing was stored.
    run_frames_relayed: u64,
    /// Another Runner's merge to land just before the next submit is read.
    racing_merge: Option<(u64, Vec<u8>)>,
    /// The thread's object doors, shared with the tests.
    store: FakeStore,
    /// Open bundle requests: the id, and the connection that asked.
    bundle_requests: HashMap<String, u64>,
    next_request: u64,
    /// The plan's touched-files limit (`threads.shared`), when one is set.
    touched_files: Option<usize>,
    /// Everything up to here lives in snapshots, not the journal (ATL-397).
    compacted_through: u64,
    /// Users who cannot connect right now.
    offline: std::collections::HashSet<String>,
    /// Why the server closed each connection it closed.
    closed: HashMap<u64, u16>,
    /// The next canonical update relayed to this user is lost on the way.
    lose_next_to: Option<String>,
    /// Each person's role; a participant unless set (ATL-406).
    roles: HashMap<String, Role>,
    /// The thread's owner, who hears join requests.
    owner: Option<String>,
    /// Closed: every write is refused until it is reopened.
    thread_closed: bool,
    /// Conflicts merges held back (ATL-410), with who resolved each and by
    /// which frame, for idempotent resends.
    conflicts: Vec<(ThreadConflict, Option<Resolver>)>,
    /// Remote Run requests (ATL-417), oldest first.
    remote: Vec<RemoteRun>,
    /// Who accepts Remote Runs, and whose requests each auto-approves.
    accepts: std::collections::HashSet<String>,
    auto_approve: HashMap<String, String>,
}

/// Who resolved a Conflict, by which frame, and what they were answered.
type Resolver = (String, String, u64, ServerControl);

struct FakeRun {
    run: ThreadRun,
    runner_client: String,
}

struct Conn {
    user: String,
    client: Option<String>,
    tx: mpsc::UnboundedSender<Message>,
    /// Its latest awareness (ATL-400): kept with the connection, never stored.
    presence: Option<wire::AwarenessState>,
    /// The agents it runs Remote Runs with, when it declared `remote_run`.
    remote_agents: Vec<String>,
}

/// An in-process thread server with the real one's rules: everything is
/// journaled before it is acknowledged or relayed, `seq` is dense across tree
/// and text changes, `(user, client, clientSeq)` is stored once, and a hello
/// is answered with a welcome, the replay after `since`, and `synced`.
#[derive(Clone, Default)]
pub struct FakeThreadServer {
    hub: Arc<Mutex<Hub>>,
}

/// Dials a [`FakeThreadServer`] as one user — refused while they are offline.
#[derive(Clone)]
pub struct FakeConnector {
    server: FakeThreadServer,
    user: String,
}

impl Connector for FakeConnector {
    type Transport = FakeTransport;
    async fn connect(&self) -> Result<FakeTransport, TransportError> {
        let offline = self
            .server
            .hub
            .lock()
            .map_err(|_| TransportError::Closed)?
            .offline
            .contains(&self.user);
        if offline {
            return Err(TransportError::Ws("offline".into()));
        }
        Ok(self.server.connect(&self.user))
    }
}

/// One connection to a [`FakeThreadServer`].
pub struct FakeTransport {
    hub: Arc<Mutex<Hub>>,
    conn: u64,
    rx: mpsc::UnboundedReceiver<Message>,
}

impl FakeThreadServer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn connect(&self, user: &str) -> FakeTransport {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut hub = self.hub.lock().expect("hub");
        hub.next_conn += 1;
        let conn = hub.next_conn;
        hub.conns.insert(
            conn,
            Conn {
                user: user.to_string(),
                client: None,
                tx,
                presence: None,
                remote_agents: Vec::new(),
            },
        );
        FakeTransport {
            hub: self.hub.clone(),
            conn,
            rx,
        }
    }

    /// How many canonical updates clients have sent, resends included.
    pub fn updates_received(&self) -> u64 {
        self.hub.lock().expect("hub").received_updates
    }

    pub fn head(&self) -> u64 {
        self.hub.lock().expect("hub").journal.len() as u64
    }

    /// The Runs the server holds, by `runNo`.
    /// The Conflicts merges raised, oldest first.
    pub fn conflicts(&self) -> Vec<ThreadConflict> {
        self.hub
            .lock()
            .expect("hub")
            .conflicts
            .iter()
            .map(|(c, _)| c.clone())
            .collect()
    }

    pub fn runs(&self) -> Vec<ThreadRun> {
        self.hub
            .lock()
            .expect("hub")
            .runs
            .iter()
            .map(|r| r.run.clone())
            .collect()
    }

    /// A file's merge version.
    pub fn merge_version(&self, file_id: u64) -> Option<u64> {
        self.hub
            .lock()
            .expect("hub")
            .tree
            .iter()
            .find(|e| e.file_id == file_id)
            .and_then(|e| e.merge_version)
    }

    /// Land a merge of `update` on `file_id` the moment the next
    /// `merge.submit` arrives, ahead of it — the race a Runner loses when
    /// another merge reaches the server while its own submit is on the way.
    pub fn merge_before_next_submit(&self, file_id: u64, update: Vec<u8>) {
        self.hub.lock().expect("hub").racing_merge = Some((file_id, update));
    }

    /// A Restore to Version `from` by `author`, as `POST /restore` lands one
    /// (ATL-415): `update` (computed by the caller against canonical state)
    /// is journaled and relayed, the file's merge version moves on, and every
    /// socket hears `restored`. Answers the Thread Version it made.
    pub fn restore(&self, author: &str, from: u64, file_id: u64, update: Vec<u8>, blob: &str) -> u64 {
        let mut hub = self.hub.lock().expect("hub");
        let seq = hub.journal.len() as u64 + 1;
        let frame = Frame {
            seq,
            ..Frame::update(file_id, 0, update)
        };
        hub.journal.push(Journaled {
            seq,
            tree: None,
            frame: Some(frame.clone()),
            author: author.to_string(),
            client: format!("{author}#restore"),
            client_seq: seq,
        });
        let version = hub
            .tree
            .iter_mut()
            .find(|e| e.file_id == file_id)
            .map(|e| {
                let v = e.merge_version.unwrap_or(0) + 1;
                e.merge_version = Some(v);
                v
            })
            .unwrap_or(1);
        let bytes = wire::encode(&frame).expect("encode");
        for c in hub.conns.values() {
            if c.client.is_some() {
                let _ = c.tx.send(Message::Binary(bytes.clone()));
            }
        }
        hub.broadcast(&ServerControl::Restored {
            version: seq,
            from,
            author_id: author.to_string(),
            files: vec![MergedFile {
                file_id,
                version,
                blob: blob.to_string(),
            }],
        });
        seq
    }

    /// Live Run frames relayed so far. None of them is ever journaled.
    pub fn run_frames_relayed(&self) -> u64 {
        self.hub.lock().expect("hub").run_frames_relayed
    }

    /// Drop every connection `user` holds, as a network drop would: no
    /// close code, so their replicas dial again.
    pub fn cut(&self, user: &str) {
        let mut hub = self.hub.lock().expect("hub");
        let conns: Vec<u64> = hub
            .conns
            .iter()
            .filter(|(_, c)| c.user == user)
            .map(|(id, _)| *id)
            .collect();
        for conn in conns {
            hub.disconnect(conn);
        }
    }

    /// Close `user`'s connections with a code — 1008 when their access
    /// ended, 4410 when the thread closed.
    pub fn close(&self, user: &str, code: u16) {
        let mut hub = self.hub.lock().expect("hub");
        let conns: Vec<u64> = hub
            .conns
            .iter()
            .filter(|(_, c)| c.user == user)
            .map(|(id, _)| *id)
            .collect();
        for conn in conns {
            hub.closed.insert(conn, code);
            hub.disconnect(conn);
        }
    }

    /// `asker` asks `runner` for a Remote Run, as `POST /remote-runs` would
    /// once the door's three gates passed (ATL-417): the object's gates —
    /// the Runner accepting and an editor, the asker an editor, the Runner
    /// online on a desktop offering `agent` — then pending, or approved at
    /// once by the Runner's auto-approve. A refusal names the gate.
    pub fn request_remote_run(
        &self,
        asker: &str,
        runner: &str,
        prompt: &str,
        agent: &str,
    ) -> Result<RemoteRun, &'static str> {
        let mut hub = self.hub.lock().expect("hub");
        let editor = |hub: &Hub, user: &str| {
            !matches!(hub.roles.get(user), Some(Role::Viewer)) && !hub.thread_closed
        };
        if !hub.accepts.contains(runner) || !editor(&hub, runner) {
            return Err("runner_not_accepting");
        }
        if !editor(&hub, asker) {
            return Err("requester_not_participant");
        }
        let online = hub.conns.values().any(|c| {
            c.user == runner && c.client.is_some() && c.remote_agents.iter().any(|a| a == agent)
        });
        if !online {
            return Err("runner_offline");
        }
        let auto = hub.auto_approve.get(runner).map(String::as_str) == Some(asker);
        let at = hub.remote.len() as u64 + 1;
        let request = RemoteRun {
            request_id: format!("remote-{at:04}"),
            thread_id: "fake-thread".into(),
            requested_by: asker.to_string(),
            runner_id: runner.to_string(),
            prompt: prompt.to_string(),
            agent: agent.to_string(),
            model: None,
            status: if auto {
                RemoteRunStatus::Approved
            } else {
                RemoteRunStatus::Pending
            },
            auto,
            requested_at: at,
            expires_at: at + 60_000,
            answered_at: auto.then_some(at),
            run_id: None,
        };
        hub.remote.push(request.clone());
        hub.tell_remote(&request);
        Ok(request)
    }

    /// The alarm's sweep: every request still open times out, unanswered
    /// or approved and never started.
    pub fn expire_remote_runs(&self) {
        let mut hub = self.hub.lock().expect("hub");
        let mut told = Vec::new();
        for r in hub.remote.iter_mut().filter(|r| r.status.is_open()) {
            r.status = RemoteRunStatus::TimedOut;
            r.answered_at = Some(r.expires_at);
            told.push(r.clone());
        }
        for r in &told {
            hub.tell_remote(r);
        }
    }

    /// Every Remote Run request, oldest first.
    pub fn remote_runs(&self) -> Vec<RemoteRun> {
        self.hub.lock().expect("hub").remote.clone()
    }

    /// Set somebody's role, and tell every socket — as the owner's `PUT
    /// /participants/{user}` (approving is `participant`) or `DELETE` (a
    /// decline, or a demotion) would.
    pub fn set_role(&self, user: &str, role: Role) {
        let mut hub = self.hub.lock().expect("hub");
        hub.roles.insert(user.to_string(), role);
        hub.broadcast(&ServerControl::RoleChanged {
            user_id: user.to_string(),
            role,
        });
    }

    /// The thread's owner, who is sent join requests.
    pub fn set_owner(&self, user: &str) {
        let mut hub = self.hub.lock().expect("hub");
        hub.owner = Some(user.to_string());
        hub.roles.insert(user.to_string(), Role::Owner);
    }

    /// Somebody asked to join a thread that needs approval: the owner hears.
    pub fn request_join(&self, user: &str) {
        let hub = self.hub.lock().expect("hub");
        let text = serde_json::to_string(&ServerControl::JoinRequested {
            user_id: user.to_string(),
        })
        .expect("json");
        for c in hub.conns.values() {
            if c.client.is_some() && Some(&c.user) == hub.owner.as_ref() {
                let _ = c.tx.send(Message::Text(text.clone()));
            }
        }
    }

    /// Close (or reopen) the thread, telling every socket.
    pub fn set_closed(&self, closed: bool) {
        let mut hub = self.hub.lock().expect("hub");
        hub.thread_closed = closed;
        hub.broadcast(&ServerControl::Status {
            status: if closed {
                wire::ThreadStatus::Closed
            } else {
                wire::ThreadStatus::Open
            },
            closed_at: closed.then_some(1),
            purge_at: closed.then_some(2),
        });
    }

    /// While offline, `user` cannot connect at all.
    pub fn set_offline(&self, user: &str, offline: bool) {
        let mut hub = self.hub.lock().expect("hub");
        if offline {
            hub.offline.insert(user.to_string());
        } else {
            hub.offline.remove(user);
        }
    }

    /// A connector that dials this server as `user`.
    pub fn connector(&self, user: &str) -> FakeConnector {
        FakeConnector {
            server: self.clone(),
            user: user.to_string(),
        }
    }

    /// Lose the next canonical update on its way to `user`: their replica
    /// silently drifts, which only a checksum can tell.
    pub fn lose_next_update_to(&self, user: &str) {
        self.hub.lock().expect("hub").lose_next_to = Some(user.to_string());
    }

    /// Fold the whole journal into per-file snapshots, as the real server's
    /// compaction does: a replica behind it is caught up by snapshot plus
    /// tail.
    pub fn compact(&self) {
        let mut hub = self.hub.lock().expect("hub");
        let through = hub.head();
        let mut by_file: std::collections::BTreeMap<u64, Vec<Vec<u8>>> = Default::default();
        let file_ids: Vec<u64> = hub.tree.iter().map(|e| e.file_id).collect();
        for id in file_ids {
            if let Some(snapshot) = hub.store.snapshot(id) {
                by_file.entry(id).or_default().push(snapshot);
            }
        }
        for j in hub.journal.iter_mut().filter(|j| j.seq <= through) {
            if let Some(frame) = j.frame.take() {
                by_file
                    .entry(frame.file_id)
                    .or_default()
                    .push(frame.payload);
            }
        }
        for (file_id, updates) in by_file {
            let merged = yrs::merge_updates_v1(&updates).expect("journaled updates merge");
            hub.store.put_snapshot(file_id, merged);
        }
        hub.compacted_through = through;
    }

    /// Forget everything after `seq`, as a restore from an older backup
    /// would: a replica that saw more is now ahead of the thread.
    pub fn forget_after(&self, seq: u64) {
        let mut hub = self.hub.lock().expect("hub");
        hub.journal.retain(|j| j.seq <= seq);
        let live: std::collections::HashSet<u64> = hub
            .journal
            .iter()
            .filter_map(|j| j.tree.as_ref().map(|t| t.file_id))
            .collect();
        hub.tree.retain(|e| live.contains(&e.file_id));
    }

    /// The thread's object doors: what replicas upload, and download.
    pub fn store(&self) -> FakeStore {
        self.hub.lock().expect("hub").store.clone()
    }

    /// Every canonical update payload journaled, in `seq` order — to check
    /// what reached the thread.
    pub fn journaled_payloads(&self) -> Vec<Vec<u8>> {
        self.hub
            .lock()
            .expect("hub")
            .journal
            .iter()
            .filter_map(|j| j.frame.as_ref().map(|f| f.payload.clone()))
            .collect()
    }

    /// One file's canonical updates journaled, in `seq` order.
    pub fn journaled_for(&self, file_id: u64) -> Vec<Vec<u8>> {
        self.hub
            .lock()
            .expect("hub")
            .journal
            .iter()
            .filter_map(|j| j.frame.as_ref())
            .filter(|f| f.file_id == file_id)
            .map(|f| f.payload.clone())
            .collect()
    }

    /// The tree as the server holds it.
    pub fn tree(&self) -> Vec<TreeEntry> {
        self.hub.lock().expect("hub").tree.clone()
    }

    /// The Organisation's touched-files limit for the thread.
    pub fn set_touched_files_limit(&self, limit: Option<usize>) {
        self.hub.lock().expect("hub").touched_files = limit;
    }
}

impl Hub {
    fn reply(&self, conn: u64, frame: &ServerControl) {
        if let Some(c) = self.conns.get(&conn) {
            let _ =
                c.tx.send(Message::Text(serde_json::to_string(frame).expect("json")));
        }
    }

    fn broadcast(&self, frame: &ServerControl) {
        let text = serde_json::to_string(frame).expect("json");
        for c in self.conns.values() {
            if c.client.is_some() {
                let _ = c.tx.send(Message::Text(text.clone()));
            }
        }
    }

    fn nack(&self, conn: u64, client_seq: u64, code: &str) {
        self.reply(
            conn,
            &ServerControl::Nack {
                client_seq,
                code: code.into(),
                message: code.into(),
            },
        );
    }

    fn head(&self) -> u64 {
        self.journal.len() as u64
    }

    /// The runner's socket went away: its Runs are interrupted, as the real
    /// server's heartbeat sweep does.
    fn disconnect(&mut self, conn: u64) {
        let Some(c) = self.conns.remove(&conn) else {
            return;
        };
        let Some(client) = c.client else { return };
        self.relay(
            conn,
            Message::Text(
                serde_json::to_string(&ServerControl::PresenceLeft {
                    peer_id: client.clone(),
                    user_id: c.user.clone(),
                })
                .expect("json"),
            ),
        );
        let mut ended = Vec::new();
        for r in &mut self.runs {
            if r.run.status == "running" && r.run.runner_id == c.user && r.runner_client == client {
                r.run.status = "interrupted".into();
                r.run.ended_at = Some(2);
                ended.push(r.run.clone());
            }
        }
        for run in ended {
            self.broadcast(&ServerControl::Run { run });
        }
    }

    /// Journal `update` as somebody else's merge: advance the version, relay
    /// it to every socket, and say `merged` — in that order, as the real
    /// server does.
    fn land_racing_merge(&mut self, file_id: u64, update: Vec<u8>) {
        let seq = self.journal.len() as u64 + 1;
        let frame = Frame {
            seq,
            ..Frame::update(file_id, 0, update)
        };
        self.journal.push(Journaled {
            seq,
            tree: None,
            frame: Some(frame.clone()),
            author: "racer".into(),
            client: "racer#merge1".into(),
            client_seq: 1,
        });
        let Some(entry) = self.tree.iter_mut().find(|e| e.file_id == file_id) else {
            return;
        };
        let version = entry.merge_version.unwrap_or(0) + 1;
        entry.merge_version = Some(version);
        let bytes = wire::encode(&frame).expect("encode");
        for c in self.conns.values() {
            if c.client.is_some() {
                let _ = c.tx.send(Message::Binary(bytes.clone()));
            }
        }
        self.broadcast(&ServerControl::Merged {
            run_id: "run-racer".into(),
            version: seq,
            files: vec![MergedFile {
                file_id,
                version,
                blob: "0".repeat(64),
            }],
        });
    }

    /// Journal one change to a tree entry, ack it, and relay the entry as it
    /// is now — the real server's `treeChange`.
    fn tree_change(
        &mut self,
        conn: u64,
        user: String,
        client: String,
        client_seq: u64,
        file_id: u64,
        change: impl FnOnce(&mut TreeEntry),
    ) {
        if let Some(prior) = self.prior(&user, &client, client_seq) {
            let seq = prior.seq;
            return self.reply(
                conn,
                &ServerControl::Ack {
                    client_seq,
                    seq,
                    file_id: None,
                },
            );
        }
        let Some(entry) = self.tree.iter_mut().find(|e| e.file_id == file_id) else {
            return self.nack(conn, client_seq, "unknown_file");
        };
        change(entry);
        let entry = entry.clone();
        let seq = self.journal.len() as u64 + 1;
        self.journal.push(Journaled {
            seq,
            tree: Some(entry.clone()),
            frame: None,
            author: user,
            client,
            client_seq,
        });
        // Named on the ack, as for any `tree.ensure` — a revival is one.
        self.reply(
            conn,
            &ServerControl::Ack {
                client_seq,
                seq,
                file_id: Some(file_id),
            },
        );
        let relayed = ServerControl::Tree { seq, entry };
        self.relay(
            conn,
            Message::Text(serde_json::to_string(&relayed).expect("json")),
        );
    }

    /// A file's hash at `seq` `at`, rebuilt the way every replica builds it:
    /// its snapshot, then each journaled update up to `at`. Binary files are
    /// their blob's name.
    fn hash_at(&self, file_id: u64, at: u64) -> Option<String> {
        let entry = self.tree.iter().find(|e| e.file_id == file_id)?;
        if entry.kind == FileKind::Binary {
            return entry.blob.clone();
        }
        let doc = crate::doc::FileDoc::new(crate::doc::random_client_id());
        if let Some(snapshot) = self.store.snapshot(file_id) {
            doc.apply(&snapshot).ok()?;
        }
        for j in self.journal.iter().filter(|j| j.seq <= at) {
            if let Some(frame) = j.frame.as_ref().filter(|f| f.file_id == file_id) {
                doc.apply(&frame.payload).ok()?;
            }
        }
        Some(crate::bootstrap::sha256_hex(doc.content().as_bytes()))
    }

    /// Why `user` may not write now, as the real server's `mayWrite` says.
    fn write_refusal(&self, user: &str) -> Option<&'static str> {
        if self.thread_closed {
            return Some("thread_closed");
        }
        (self.roles.get(user) == Some(&Role::Viewer)).then_some("read_only")
    }

    fn live(&self, path: &str) -> Option<&TreeEntry> {
        self.tree.iter().find(|e| e.path == path && !e.deleted)
    }

    fn run_mut(&mut self, run_id: &str) -> Option<&mut FakeRun> {
        self.runs.iter_mut().find(|r| r.run.run_id == run_id)
    }

    fn relay(&self, from: u64, message: Message) {
        for (id, c) in &self.conns {
            if *id != from && c.client.is_some() {
                let _ = c.tx.send(message.clone());
            }
        }
    }

    /// Send to every greeted socket of `users`.
    fn tell_users(&self, users: &[&str], frame: &ServerControl) {
        let text = serde_json::to_string(frame).expect("json");
        for c in self.conns.values() {
            if c.client.is_some() && users.contains(&c.user.as_str()) {
                let _ = c.tx.send(Message::Text(text.clone()));
            }
        }
    }

    /// A request changed: its Runner and whoever asked hear it.
    fn tell_remote(&self, request: &RemoteRun) {
        self.tell_users(
            &[&request.runner_id, &request.requested_by],
            &ServerControl::RemoteRun {
                request: request.clone(),
            },
        );
    }

    fn remote_settings_of(&self, user: &str) -> ServerControl {
        ServerControl::RemoteSettings {
            accept: self.accepts.contains(user),
            auto_approve: self.auto_approve.get(user).cloned(),
        }
    }

    /// A connection as presence describes it, once it has said hello.
    fn peer(&self, conn: u64) -> Option<wire::Peer> {
        let c = self.conns.get(&conn)?;
        Some(wire::Peer {
            peer_id: c.client.clone()?,
            user_id: c.user.clone(),
            role: self
                .roles
                .get(&c.user)
                .copied()
                .unwrap_or(Role::Participant),
            surface: "desktop".into(),
            state: c.presence.clone(),
            at: 0,
        })
    }

    fn prior(&self, user: &str, client: &str, client_seq: u64) -> Option<&Journaled> {
        self.journal
            .iter()
            .find(|j| j.author == user && j.client == client && j.client_seq == client_seq)
    }

    fn handle(&mut self, conn: u64, message: Message) {
        let Some(c) = self.conns.get(&conn) else {
            return;
        };
        let (user, client) = (c.user.clone(), c.client.clone());
        match message {
            Message::Text(text) => {
                let parsed = serde_json::from_str::<ClientControl>(&text);
                if let Ok(frame) = &parsed {
                    let reads = matches!(
                        frame,
                        ClientControl::Hello { .. }
                            | ClientControl::Checksum { .. }
                            | ClientControl::Awareness { .. }
                    );
                    if !reads && client.is_some() {
                        if let Some(code) = self.write_refusal(&user) {
                            return self.nack(conn, frame.client_seq(), code);
                        }
                    }
                }
                self.control(conn, user, client, parsed);
            }
            Message::Binary(bytes) => self.binary(conn, user, client, bytes),
        }
    }

    fn control(
        &mut self,
        conn: u64,
        user: String,
        client: Option<String>,
        parsed: Result<ClientControl, serde_json::Error>,
    ) {
        match parsed {
            Ok(ClientControl::Hello {
                client_id,
                since,
                capabilities,
                agents,
                ..
            }) => {
                if let Some(c) = self.conns.get_mut(&conn) {
                    c.remote_agents = if capabilities
                        .iter()
                        .any(|c| c == wire::CAPABILITY_REMOTE_RUN)
                    {
                        agents
                    } else {
                        Vec::new()
                    };
                }
                if since > self.head() {
                    if let Some(c) = self.conns.get_mut(&conn) {
                        c.client = None;
                    }
                    return self.reply(
                        conn,
                        &ServerControl::ResyncRequired {
                            head: self.head(),
                            reason: "ahead".into(),
                        },
                    );
                }
                let last = self
                    .journal
                    .iter()
                    .filter(|j| j.author == user && j.client == client_id)
                    .map(|j| j.client_seq)
                    .max()
                    .unwrap_or(0);
                self.reply(
                    conn,
                    &ServerControl::Welcome {
                        protocol: wire::PROTOCOL_VERSION,
                        thread_id: "fake-thread".into(),
                        workspace_id: "fake-workspace".into(),
                        org_id: "fake-org".into(),
                        user_id: Some(user.clone()),
                        role: self.roles.get(&user).copied().unwrap_or(Role::Participant),
                        head: self.journal.len() as u64,
                        last_client_seq: last,
                    },
                );
                let tx = self.conns[&conn].tx.clone();
                // Behind a compaction: the snapshots, the tree, then the tail.
                let mut from = since;
                if since < self.compacted_through {
                    let files = self
                        .tree
                        .iter()
                        .filter_map(|e| {
                            self.store.snapshot(e.file_id).map(|s| wire::SnapshotFile {
                                file_id: e.file_id,
                                bytes: s.len() as u64,
                            })
                        })
                        .collect();
                    let _ = tx.send(Message::Text(
                        serde_json::to_string(&ServerControl::Snapshot {
                            through: self.compacted_through,
                            files,
                        })
                        .expect("json"),
                    ));
                    let mut sent = std::collections::HashSet::new();
                    for j in self
                        .journal
                        .iter()
                        .filter(|j| j.seq <= self.compacted_through)
                    {
                        let Some(entry) = &j.tree else { continue };
                        if !sent.insert(entry.file_id) {
                            continue;
                        }
                        let current = self
                            .tree
                            .iter()
                            .find(|e| e.file_id == entry.file_id)
                            .unwrap_or(entry)
                            .clone();
                        let _ = tx.send(Message::Text(
                            serde_json::to_string(&ServerControl::Tree {
                                seq: j.seq,
                                entry: current,
                            })
                            .expect("json"),
                        ));
                    }
                    from = self.compacted_through;
                }
                for j in self.journal.iter().filter(|j| j.seq > from) {
                    let message = match (&j.tree, &j.frame) {
                        (Some(entry), _) => Message::Text(
                            serde_json::to_string(&ServerControl::Tree {
                                seq: j.seq,
                                entry: self
                                    .tree
                                    .iter()
                                    .find(|e| e.file_id == entry.file_id)
                                    .unwrap_or(entry)
                                    .clone(),
                            })
                            .expect("json"),
                        ),
                        (None, Some(frame)) => {
                            Message::Binary(wire::encode(frame).expect("encode"))
                        }
                        _ => continue,
                    };
                    let _ = tx.send(message);
                }
                let _ = tx.send(Message::Text(
                    serde_json::to_string(&ServerControl::Synced {
                        head: self.journal.len() as u64,
                    })
                    .expect("json"),
                ));
                if let Some(c) = self.conns.get_mut(&conn) {
                    c.client = Some(client_id);
                    c.presence = None;
                }
                // Presence: the newcomer hears who else is here, and they hear it.
                let peers = self
                    .conns
                    .keys()
                    .filter(|id| **id != conn)
                    .filter_map(|id| self.peer(*id))
                    .collect();
                self.reply(conn, &ServerControl::PresenceSnapshot { peers });
                if let Some(peer) = self.peer(conn) {
                    self.relay(
                        conn,
                        Message::Text(
                            serde_json::to_string(&ServerControl::Presence { peer }).expect("json"),
                        ),
                    );
                }
                // Remote Runs (ATL-417): a capable desktop learns its own
                // settings, and anyone the requests still open they are in.
                if !self.conns[&conn].remote_agents.is_empty() {
                    self.reply(conn, &self.remote_settings_of(&user));
                }
                for r in self
                    .remote
                    .iter()
                    .filter(|r| r.status.is_open() && (r.runner_id == user || r.requested_by == user))
                {
                    self.reply(conn, &ServerControl::RemoteRun { request: r.clone() });
                }
            }
            Ok(ClientControl::RemoteSettings {
                client_seq,
                accept,
                auto_approve,
            }) => {
                if client.is_none() {
                    return;
                }
                if auto_approve.as_ref().and_then(Option::as_deref) == Some(user.as_str()) {
                    return self.nack(conn, client_seq, "bad_frame");
                }
                match accept {
                    Some(true) => {
                        self.accepts.insert(user.clone());
                    }
                    Some(false) => {
                        self.accepts.remove(&user);
                    }
                    None => {}
                }
                match auto_approve {
                    Some(Some(person)) => {
                        self.auto_approve.insert(user.clone(), person);
                    }
                    Some(None) => {
                        self.auto_approve.remove(&user);
                    }
                    None => {}
                }
                self.reply(
                    conn,
                    &ServerControl::Ack {
                        client_seq,
                        seq: self.head(),
                        file_id: None,
                    },
                );
                let settings = self.remote_settings_of(&user);
                self.tell_users(&[&user], &settings);
            }
            Ok(ClientControl::RemoteAnswer {
                client_seq,
                request_id,
                approve,
            }) => {
                if client.is_none() {
                    return;
                }
                let Some(r) = self
                    .remote
                    .iter_mut()
                    .find(|r| r.request_id == request_id && r.runner_id == user)
                else {
                    return self.nack(conn, client_seq, "remote_run_unknown");
                };
                let told = if r.status == RemoteRunStatus::Pending {
                    r.status = if approve {
                        RemoteRunStatus::Approved
                    } else {
                        RemoteRunStatus::Declined
                    };
                    r.answered_at = Some(r.requested_at + 1);
                    Some(r.clone())
                } else {
                    let unchanged = r.clone();
                    self.reply(conn, &ServerControl::RemoteRun { request: unchanged });
                    None
                };
                if let Some(told) = told {
                    self.tell_remote(&told);
                }
                self.reply(
                    conn,
                    &ServerControl::Ack {
                        client_seq,
                        seq: self.head(),
                        file_id: None,
                    },
                );
            }
            Ok(ClientControl::Awareness { state, .. }) => {
                if client.is_none() {
                    return;
                }
                if let Some(c) = self.conns.get_mut(&conn) {
                    c.presence = Some(state);
                }
                if let Some(peer) = self.peer(conn) {
                    self.relay(
                        conn,
                        Message::Text(
                            serde_json::to_string(&ServerControl::Presence { peer }).expect("json"),
                        ),
                    );
                }
            }
            Ok(ClientControl::Checksum {
                client_seq,
                at,
                files,
            }) => {
                if at > self.head() || at < self.compacted_through {
                    return self.reply(
                        conn,
                        &ServerControl::ChecksumResult {
                            client_seq,
                            at,
                            status: wire::ChecksumStatus::Unavailable,
                            mismatched: Vec::new(),
                            unverifiable: Vec::new(),
                        },
                    );
                }
                let mismatched: Vec<u64> = files
                    .iter()
                    .filter(|f| self.hash_at(f.file_id, at).as_deref() != Some(f.hash.as_str()))
                    .map(|f| f.file_id)
                    .collect();
                let status = if mismatched.is_empty() {
                    wire::ChecksumStatus::Match
                } else {
                    wire::ChecksumStatus::Mismatch
                };
                self.reply(
                    conn,
                    &ServerControl::ChecksumResult {
                        client_seq,
                        at,
                        status,
                        mismatched,
                        unverifiable: Vec::new(),
                    },
                );
            }
            Ok(ClientControl::BundleRequest { client_seq, have }) => {
                if client.is_none() {
                    return;
                }
                self.next_request += 1;
                let request_id = format!("request-{}", self.next_request);
                self.reply(
                    conn,
                    &ServerControl::BundlePending {
                        client_seq,
                        request_id: request_id.clone(),
                    },
                );
                let held: std::collections::HashSet<&String> = have.iter().collect();
                let cached = self
                    .store
                    .bundles()
                    .into_iter()
                    .find(|(_, b)| b.prerequisites.iter().all(|p| held.contains(p)));
                if let Some((sha, bundle)) = cached {
                    return self.reply(
                        conn,
                        &ServerControl::BundleAvailable {
                            request_id,
                            sha,
                            bytes: bundle.bytes.len() as u64,
                        },
                    );
                }
                let wanted = ServerControl::BundleWanted {
                    request_id: request_id.clone(),
                    have,
                };
                let builders: Vec<u64> = self
                    .conns
                    .iter()
                    .filter(|(id, c)| **id != conn && c.client.is_some())
                    .map(|(id, _)| *id)
                    .collect();
                if builders.is_empty() {
                    return self.reply(
                        conn,
                        &ServerControl::BundleUnavailable {
                            request_id,
                            reason: BundleFailure::NoReplicaOnline,
                            bytes: None,
                        },
                    );
                }
                self.bundle_requests.insert(request_id, conn);
                for b in builders {
                    self.reply(b, &wanted);
                }
            }
            Ok(ClientControl::BundleReady {
                client_seq,
                request_id,
                sha,
            }) => {
                let Some(bundle) = self.store.bundle(&sha) else {
                    return self.nack(conn, client_seq, "blob_missing");
                };
                self.reply(
                    conn,
                    &ServerControl::Ack {
                        client_seq,
                        seq: self.head(),
                        file_id: None,
                    },
                );
                if let Some(asker) = self.bundle_requests.remove(&request_id) {
                    self.reply(
                        asker,
                        &ServerControl::BundleAvailable {
                            request_id,
                            sha,
                            bytes: bundle.bytes.len() as u64,
                        },
                    );
                }
            }
            Ok(ClientControl::BundleFailed {
                client_seq,
                request_id,
                reason,
                bytes,
            }) => {
                self.reply(
                    conn,
                    &ServerControl::Ack {
                        client_seq,
                        seq: self.head(),
                        file_id: None,
                    },
                );
                if let Some(asker) = self.bundle_requests.remove(&request_id) {
                    self.reply(
                        asker,
                        &ServerControl::BundleUnavailable {
                            request_id,
                            reason,
                            bytes: Some(bytes),
                        },
                    );
                }
            }
            Ok(ClientControl::TreeEnsure {
                client_seq,
                path,
                kind,
                ..
            }) => {
                let Some(client) = client else { return };
                // A deleted file at this path comes back under its id.
                if self.live(&path).is_none() {
                    let gone = self
                        .tree
                        .iter()
                        .rev()
                        .find(|e| e.path == path && e.deleted && e.kind == kind)
                        .map(|e| e.file_id);
                    if let Some(file_id) = gone {
                        self.tree_change(conn, user, client, client_seq, file_id, |e| {
                            e.deleted = false;
                        });
                        return;
                    }
                }
                if let Some(existing) = self.live(&path) {
                    let seq = self
                        .journal
                        .iter()
                        .find(|j| j.tree.as_ref() == Some(existing))
                        .map_or(0, |j| j.seq);
                    let file_id = existing.file_id;
                    self.reply(
                        conn,
                        &ServerControl::Ack {
                            client_seq,
                            seq,
                            file_id: Some(file_id),
                        },
                    );
                    return;
                }
                if let Some(limit) = self.touched_files {
                    if self.tree.len() >= limit {
                        return self.reply(
                                conn,
                                &ServerControl::Nack {
                                    client_seq,
                                    code: "limit_reached".into(),
                                    message: format!(
                                        "This thread already touches {} files, the most your organisation's plan allows (touched files per thread: {limit}).",
                                        self.tree.len()
                                    ),
                                },
                            );
                    }
                }
                let seq = self.journal.len() as u64 + 1;
                let entry = TreeEntry {
                    file_id: self.tree.len() as u64 + 1,
                    path,
                    kind,
                    merge_version: Some(0),
                    blob: None,
                    deleted: false,
                    origin: None,
                };
                self.tree.push(entry.clone());
                self.journal.push(Journaled {
                    seq,
                    tree: Some(entry.clone()),
                    frame: None,
                    author: user,
                    client,
                    client_seq,
                });
                self.reply(
                    conn,
                    &ServerControl::Ack {
                        client_seq,
                        seq,
                        file_id: Some(entry.file_id),
                    },
                );
                let relayed = ServerControl::Tree { seq, entry };
                self.relay(
                    conn,
                    Message::Text(serde_json::to_string(&relayed).expect("json")),
                );
            }
            Ok(ClientControl::TreeRename {
                client_seq,
                file_id,
                path,
            }) => {
                let Some(client) = client else { return };
                if self.live(&path).is_some_and(|e| e.file_id != file_id) {
                    return self.nack(conn, client_seq, "path_taken");
                }
                if self.tree.iter().any(|e| e.file_id == file_id && e.deleted) {
                    return self.nack(conn, client_seq, "unknown_file");
                }
                self.tree_change(conn, user, client, client_seq, file_id, |e| {
                    if e.origin.is_none() {
                        e.origin = Some(e.path.clone());
                    }
                    e.path = path;
                    if e.origin.as_deref() == Some(e.path.as_str()) {
                        e.origin = None;
                    }
                });
            }
            Ok(ClientControl::TreeDelete {
                client_seq,
                file_id,
            }) => {
                let Some(client) = client else { return };
                self.tree_change(conn, user, client, client_seq, file_id, |e| {
                    e.deleted = true;
                });
            }
            Ok(ClientControl::BlobSet {
                client_seq,
                file_id,
                blob,
            }) => {
                let Some(client) = client else { return };
                match self.tree.iter().find(|e| e.file_id == file_id) {
                    Some(e) if e.kind != FileKind::Binary => {
                        return self.nack(conn, client_seq, "unsupported_kind")
                    }
                    Some(e) if e.deleted => return self.nack(conn, client_seq, "unknown_file"),
                    _ => {}
                }
                if self.store.blob(&blob).is_none() {
                    return self.nack(conn, client_seq, "blob_missing");
                }
                self.tree_change(conn, user, client, client_seq, file_id, |e| {
                    e.blob = Some(blob);
                });
            }
            Ok(ClientControl::RunStart {
                client_seq,
                run_id,
                agent,
                model,
                fork_seq,
                context_anchor,
                remote_request_id,
            }) => {
                let Some(client) = client else { return };
                // Executing a Remote Run: an approved request of this Runner's,
                // prompted by whoever asked.
                let mut prompted_by = user.clone();
                if let Some(id) = &remote_request_id {
                    let approved = self.remote.iter().find(|r| {
                        &r.request_id == id
                            && r.runner_id == user
                            && (r.status == RemoteRunStatus::Approved
                                || r.run_id.as_deref() == Some(run_id.as_str()))
                    });
                    match approved {
                        Some(r) => prompted_by = r.requested_by.clone(),
                        None => return self.nack(conn, client_seq, "remote_run_unknown"),
                    }
                }
                if let Some(existing) = self.runs.iter().find(|r| r.run.run_id == run_id) {
                    if existing.run.runner_id != user {
                        return self.nack(conn, client_seq, "run_conflict");
                    }
                    let run = existing.run.clone();
                    self.reply(
                        conn,
                        &ServerControl::Ack {
                            client_seq,
                            seq: self.head(),
                            file_id: None,
                        },
                    );
                    return self.reply(conn, &ServerControl::Run { run });
                }
                if let Some(id) = &remote_request_id {
                    let fresh = |r: &&mut RemoteRun| {
                        &r.request_id == id && r.status == RemoteRunStatus::Approved
                    };
                    if let Some(r) = self.remote.iter_mut().find(fresh) {
                        r.status = RemoteRunStatus::Executed;
                        r.run_id = Some(run_id.clone());
                        let told = r.clone();
                        self.tell_remote(&told);
                    }
                }
                let run = ThreadRun {
                    run_id,
                    run_no: self.runs.len() as u64 + 1,
                    prompted_by,
                    runner_id: user,
                    agent,
                    model,
                    fork_seq,
                    context_anchor,
                    status: "running".into(),
                    started_at: 1,
                    ended_at: None,
                    merged_version: None,
                };
                self.runs.push(FakeRun {
                    run: run.clone(),
                    runner_client: client,
                });
                self.reply(
                    conn,
                    &ServerControl::Ack {
                        client_seq,
                        seq: self.head(),
                        file_id: None,
                    },
                );
                self.broadcast(&ServerControl::Run { run });
            }
            Ok(ClientControl::RunEnd {
                client_seq,
                run_id,
                outcome,
            }) => {
                let head = self.head();
                let Some(r) = self.run_mut(&run_id) else {
                    return self.nack(conn, client_seq, "run_unknown");
                };
                if r.run.runner_id != user {
                    return self.nack(conn, client_seq, "not_runner");
                }
                if r.run.status == "running" {
                    r.run.status = match (outcome, r.run.merged_version) {
                        (RunOutcome::Interrupted, _) => "interrupted",
                        (RunOutcome::Completed, Some(_)) => "merged",
                        (RunOutcome::Completed, None) => "ended",
                    }
                    .into();
                    r.run.ended_at = Some(2);
                }
                let run = r.run.clone();
                self.reply(
                    conn,
                    &ServerControl::Ack {
                        client_seq,
                        seq: head,
                        file_id: None,
                    },
                );
                self.broadcast(&ServerControl::Run { run });
            }
            Ok(ClientControl::ConflictResolve {
                client_seq,
                conflict_id,
                base_version,
                update,
                blob: _,
                resolution,
                side,
            }) => {
                let Some(client) = client else { return };
                let Some(index) = self
                    .conflicts
                    .iter()
                    .position(|(c, _)| c.conflict_id == conflict_id)
                else {
                    return self.nack(conn, client_seq, "conflict_unknown");
                };
                if let Some((by, by_client, by_seq, answer)) = &self.conflicts[index].1 {
                    if *by == user && *by_client == client && *by_seq == client_seq {
                        let answer = answer.clone();
                        return self.reply(conn, &answer);
                    }
                    return self.nack(conn, client_seq, "conflict_unknown");
                }
                let file_id = self.conflicts[index].0.file_id;
                let current = self
                    .tree
                    .iter()
                    .find(|e| e.file_id == file_id)
                    .map(|e| e.merge_version.unwrap_or(0))
                    .unwrap_or(0);
                if current != base_version {
                    return self.reply(
                        conn,
                        &ServerControl::ConflictRejected {
                            client_seq,
                            conflict_id,
                            version: current,
                        },
                    );
                }
                let Ok(update) = base64::engine::general_purpose::STANDARD.decode(&update) else {
                    return self.nack(conn, client_seq, "bad_frame");
                };
                let seq = self.journal.len() as u64 + 1;
                let frame = Frame {
                    seq,
                    ..Frame::update(file_id, 0, update)
                };
                self.journal.push(Journaled {
                    seq,
                    tree: None,
                    frame: Some(frame.clone()),
                    author: user.clone(),
                    client: format!("{client}#resolve{client_seq}"),
                    client_seq: 1,
                });
                let entry = self
                    .tree
                    .iter_mut()
                    .find(|e| e.file_id == file_id)
                    .expect("a Conflict's file is in the tree");
                let version = entry.merge_version.unwrap_or(0) + 1;
                entry.merge_version = Some(version);
                let file_version = FileVersion { file_id, version };
                let conflict = &mut self.conflicts[index].0;
                conflict.status = wire::ConflictStatus::Resolved;
                conflict.resolution = Some(ConflictResolution {
                    text: resolution,
                    side,
                    resolved_by: user.clone(),
                    resolved_at: seq,
                    version: seq,
                });
                let resolved = conflict.clone();
                let accepted = ServerControl::ConflictAccepted {
                    client_seq,
                    conflict_id,
                    version: seq,
                    file_version,
                };
                self.conflicts[index].1 = Some((user, client, client_seq, accepted.clone()));
                self.reply(conn, &accepted);
                self.relay(conn, Message::Binary(wire::encode(&frame).expect("encode")));
                self.broadcast(&ServerControl::ConflictResolved {
                    conflict: resolved,
                    file_version,
                });
            }
            Ok(ClientControl::MergeSubmit {
                client_seq,
                run_id,
                files,
                conflicts,
            }) => {
                let Some(client) = client else { return };
                if let Some((file_id, update)) = self.racing_merge.take() {
                    self.land_racing_merge(file_id, update);
                }
                let key = (user.clone(), client.clone(), client_seq);
                if let Some(prior) = self.merges.get(&key) {
                    return self.reply(conn, &prior.clone());
                }
                match self.runs.iter().find(|r| r.run.run_id == run_id) {
                    None => return self.nack(conn, client_seq, "run_unknown"),
                    Some(r) if r.run.runner_id != user => {
                        return self.nack(conn, client_seq, "not_runner")
                    }
                    Some(r) if r.run.status != "running" => {
                        return self.nack(conn, client_seq, "run_unknown")
                    }
                    Some(_) => {}
                }
                let current = |id: u64| {
                    self.tree
                        .iter()
                        .find(|e| e.file_id == id)
                        .map(|e| e.merge_version.unwrap_or(0))
                };
                // Every file named — merged or held — is compared and set.
                let named: Vec<(u64, u64)> = files
                    .iter()
                    .map(|f| (f.file_id, f.base_version))
                    .chain(conflicts.iter().map(|c| (c.file_id, c.base_version)))
                    .collect();
                if named.iter().any(|(id, _)| current(*id).is_none()) {
                    return self.nack(conn, client_seq, "unknown_file");
                }
                if files.is_empty() && conflicts.is_empty() {
                    return self.nack(conn, client_seq, "bad_frame");
                }
                if named.iter().any(|(id, base)| current(*id) != Some(*base)) {
                    let mut versions: Vec<FileVersion> = named
                        .iter()
                        .map(|(id, _)| FileVersion {
                            file_id: *id,
                            version: current(*id).unwrap_or(0),
                        })
                        .collect();
                    versions.dedup();
                    return self.reply(
                        conn,
                        &ServerControl::MergeRejected {
                            client_seq,
                            run_id,
                            versions,
                        },
                    );
                }
                let mut stored = Vec::new();
                let mut landed = Vec::new();
                let merge_client = format!("{client}#merge{client_seq}");
                for (i, f) in files.iter().enumerate() {
                    let Ok(update) = base64::engine::general_purpose::STANDARD.decode(&f.update)
                    else {
                        return self.nack(conn, client_seq, "bad_frame");
                    };
                    let seq = self.journal.len() as u64 + 1;
                    let frame = Frame {
                        seq,
                        ..Frame::update(f.file_id, 0, update)
                    };
                    self.journal.push(Journaled {
                        seq,
                        tree: None,
                        frame: Some(frame.clone()),
                        author: user.clone(),
                        client: merge_client.clone(),
                        client_seq: i as u64 + 1,
                    });
                    let entry = self
                        .tree
                        .iter_mut()
                        .find(|e| e.file_id == f.file_id)
                        .expect("checked above");
                    let version = entry.merge_version.unwrap_or(0) + 1;
                    entry.merge_version = Some(version);
                    landed.push(FileVersion {
                        file_id: f.file_id,
                        version,
                    });
                    stored.push(frame);
                }
                let version = self.head();
                if !files.is_empty() {
                    if let Some(r) = self.run_mut(&run_id) {
                        r.run.merged_version = Some(version);
                    }
                }
                // The held hunks become Conflicts. Who is involved: the
                // Runner, and everybody who changed the file since the fork.
                let fork_seq = self
                    .runs
                    .iter()
                    .find(|r| r.run.run_id == run_id)
                    .map_or(0, |r| r.run.fork_seq);
                let mut raised = Vec::new();
                for hunk in &conflicts {
                    let mut people = vec![user.clone()];
                    for j in &self.journal {
                        let touches = j.frame.as_ref().is_some_and(|f| f.file_id == hunk.file_id)
                            || j.tree
                                .as_ref()
                                .is_some_and(|t| t.file_id == hunk.file_id && t.blob.is_some());
                        if j.seq > fork_seq && touches && !people.contains(&j.author) {
                            people.push(j.author.clone());
                        }
                    }
                    let conflict_id = self.conflicts.len() as u64 + 1;
                    let path = self
                        .tree
                        .iter()
                        .find(|e| e.file_id == hunk.file_id)
                        .map(|e| e.path.clone())
                        .unwrap_or_default();
                    self.conflicts.push((
                        ThreadConflict {
                            conflict_id,
                            file_id: hunk.file_id,
                            path,
                            run_id: run_id.clone(),
                            status: wire::ConflictStatus::Open,
                            lines: hunk.lines,
                            binary: hunk.binary,
                            base: hunk.base.clone(),
                            canonical: hunk.canonical.clone(),
                            run: hunk.run.clone(),
                            involved: ConflictInvolved {
                                runs: vec![run_id.clone()],
                                people,
                            },
                            raised_by: user.clone(),
                            raised_at: version,
                            resolution: None,
                        },
                        None,
                    ));
                    raised.push(RaisedConflict {
                        conflict_id,
                        file_id: hunk.file_id,
                    });
                }
                let accepted = ServerControl::MergeAccepted {
                    client_seq,
                    run_id: run_id.clone(),
                    version,
                    files: landed.clone(),
                    conflicts: raised.clone(),
                };
                self.merges.insert(key, accepted.clone());
                self.reply(conn, &accepted);
                for frame in &stored {
                    self.relay(conn, Message::Binary(wire::encode(frame).expect("encode")));
                }
                let merged = ServerControl::Merged {
                    run_id,
                    version,
                    files: landed
                        .iter()
                        .zip(&files)
                        .map(|(l, f)| MergedFile {
                            file_id: l.file_id,
                            version: l.version,
                            blob: f.blob.clone(),
                        })
                        .collect(),
                };
                if !landed.is_empty() {
                    self.relay(
                        conn,
                        Message::Text(serde_json::to_string(&merged).expect("json")),
                    );
                }
                for r in &raised {
                    let conflict = self
                        .conflicts
                        .iter()
                        .find(|(c, _)| c.conflict_id == r.conflict_id)
                        .map(|(c, _)| c.clone())
                        .expect("just raised");
                    self.broadcast(&ServerControl::ConflictRaised { conflict });
                }
            }
            Err(_) => {}
        }
    }

    fn binary(&mut self, conn: u64, user: String, client: Option<String>, bytes: Vec<u8>) {
        let Some(client) = client else { return };
        let Some(frame) = wire::decode(&bytes) else {
            return;
        };
        if frame.kind == FrameKind::RunStream as u8 || frame.kind == FrameKind::RunFile as u8 {
            let ours = self.runs.iter().any(|r| {
                r.run.run_no == frame.file_id
                    && r.run.status == "running"
                    && r.run.runner_id == user
                    && r.runner_client == client
            });
            if !ours {
                return self.nack(conn, frame.client_seq, "run_unknown");
            }
            self.run_frames_relayed += 1;
            let relayed = Frame {
                seq: 0,
                client_seq: 0,
                ..frame
            };
            return self.relay(
                conn,
                Message::Binary(wire::encode(&relayed).expect("encode")),
            );
        }
        if frame.kind != FrameKind::CanonicalUpdate as u8 {
            return;
        }
        if let Some(code) = self.write_refusal(&user) {
            return self.nack(conn, frame.client_seq, code);
        }
        if self
            .tree
            .iter()
            .any(|e| e.file_id == frame.file_id && e.kind != FileKind::Text)
        {
            return self.nack(conn, frame.client_seq, "unsupported_kind");
        }
        self.received_updates += 1;
        if let Some(prior) = self.prior(&user, &client, frame.client_seq) {
            let seq = prior.seq;
            self.reply(
                conn,
                &ServerControl::Ack {
                    client_seq: frame.client_seq,
                    seq,
                    file_id: None,
                },
            );
            return;
        }
        let seq = self.journal.len() as u64 + 1;
        let stored = Frame {
            seq,
            client_seq: 0,
            ..frame.clone()
        };
        self.journal.push(Journaled {
            seq,
            tree: None,
            frame: Some(stored.clone()),
            author: user,
            client,
            client_seq: frame.client_seq,
        });
        self.reply(
            conn,
            &ServerControl::Ack {
                client_seq: frame.client_seq,
                seq,
                file_id: None,
            },
        );
        let bytes = wire::encode(&stored).expect("encode");
        let lose = self.lose_next_to.take();
        for (id, c) in &self.conns {
            if *id == conn || c.client.is_none() {
                continue;
            }
            if lose.as_deref() == Some(c.user.as_str()) {
                continue;
            }
            let _ = c.tx.send(Message::Binary(bytes.clone()));
        }
    }
}

impl Transport for FakeTransport {
    async fn send(&mut self, message: Message) -> Result<(), TransportError> {
        let mut hub = self.hub.lock().map_err(|_| TransportError::Closed)?;
        if !hub.conns.contains_key(&self.conn) {
            return Err(TransportError::Closed);
        }
        hub.handle(self.conn, message);
        Ok(())
    }

    async fn recv(&mut self) -> Option<Message> {
        self.rx.recv().await
    }

    fn close_code(&self) -> Option<u16> {
        self.hub.lock().ok()?.closed.get(&self.conn).copied()
    }
}

impl Drop for FakeTransport {
    fn drop(&mut self) {
        if let Ok(mut hub) = self.hub.lock() {
            hub.disconnect(self.conn);
        }
    }
}
