//! One connection to one Shared Thread, driving a [`Replica`].
//!
//! The session speaks wire v1: `hello`, the catch-up replay until `synced`,
//! `tree.ensure` for files this replica introduces, and canonical updates both
//! ways. Every frame it sends carries the next `client_seq`, so a resend after
//! a lost ack is recognised by the server and stored once.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use tokio::sync::mpsc;

use crate::apply::{self as applying, ApplyError, ApplyOutcome, ThreadChange};
use crate::bootstrap::{self, BootstrapError, ThreadRepo};
use crate::digest::{
    line_stats, DigestConflict, DigestFile, DigestInput, DigestRun, DigestScope, FileChange,
    RunTranscript,
};
use crate::doc::{LineSpan, RangeAnchor};
use crate::git;
use crate::merge::{self, MergeError};
use crate::replica::{kind_of, EditorEdit, LocalChange, Replica, ReplicaError};
use crate::runs::{ActiveRun, Fork, ForkBinary, RunReport, RunSpec, RunWorktree};
use crate::secrets::{secret_reason, SecretReason};
use crate::share::{self, ShareKind};
use crate::store::{NoStore, ObjectStore, StoreError};
use crate::transport::{Message, Transport, TransportError};
use crate::versions::{self, FileDiff, Side, VersionFiles};
use crate::wire::{
    self, AwarenessState, BundleFailure, ChecksumStatus, ClientControl, ConflictHunk, ConflictSide,
    Cursor, FileHash, FileKind, FileVersion, Frame, FrameKind, LineRange, MergeFile, Peer,
    RemoteRun, RemoteRunStatus, Role, RunAt, RunOutcome, ServerControl, SyncState, ThreadConflict,
    ThreadRun, ThreadStatus,
};

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error(transparent)]
    Replica(#[from] ReplicaError),
    #[error(transparent)]
    Transport(#[from] TransportError),
    #[error("the server refused: {code}: {message}")]
    Refused { code: String, message: String },
    #[error("the socket closed before the thread was synced")]
    ClosedEarly,
    #[error("timed out waiting for the server")]
    Timeout,
    /// A Conflict's hunk is no longer where it was raised: somebody edited
    /// those very lines since. Resolve it by editing the file instead.
    #[error("the lines of that Conflict have changed since it was raised; edit {0} directly")]
    ConflictMoved(String),
    #[error("the merge was rejected {0} times in a row; try again")]
    MergeStarved(u32),
    #[error(transparent)]
    Bootstrap(#[from] BootstrapError),
    #[error(transparent)]
    Store(#[from] StoreError),
    /// This replica may only watch, and why — said to the person as is.
    #[error("{0}")]
    ReadOnly(String),
    #[error(transparent)]
    Apply(#[from] ApplyError),
}

/// How joining went for a machine without the Base (ATL-402).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Bootstrapped {
    /// The Base is here: the replica can be checked out and edited.
    Ready,
    /// It is not, and will not be for now; the replica follows the thread
    /// read-only. The reason is for the person.
    WatchOnly(String),
}

/// Somebody else needs the Base; this replica may be able to build it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundleWant {
    pub request_id: String,
    pub have: Vec<String>,
}

/// The answer a `bundle.request` is waiting for.
#[derive(Debug, Clone, PartialEq, Eq)]
enum BundleAnswer {
    Available {
        sha: String,
    },
    Unavailable {
        reason: BundleFailure,
        bytes: Option<u64>,
    },
}

/// What the app hears about besides status: other people's live Run frames,
/// and — for the owner — join requests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ThreadEvent {
    /// Somebody is waiting for the owner's approval to join (ATL-406).
    JoinRequested { user_id: String },
    /// A live Run frame — a `SessionDelta` (kind 3) or a Run file (kind 4).
    /// Never stored; the durable copy is the Runner's Session.
    RunFrame {
        run_no: u64,
        kind: u8,
        payload: Vec<u8>,
    },
    /// Who is here and what they are doing changed (ATL-407).
    Presence(Vec<PeerView>),
    /// A file open in the Atlas editor changed: apply `update` to the
    /// editor's copy of its document (ATL-407). It may hold changes the
    /// editor already has, which Yjs ignores.
    DocUpdate { file_id: u64, update: Vec<u8> },
    /// A Remote Run request this person asked or must run changed (ATL-417):
    /// `pending` for the Runner is a request to approve or decline, and
    /// `approved` is the Runner's cue to run it.
    RemoteRun(RemoteRun),
    /// The thread's Thread Versions changed — a merge, a resolution, a
    /// Restore or a mark (ATL-419): read the list again.
    VersionsChanged,
}

/// Remote Runs as this replica knows them (ATL-417).
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteView {
    /// Who this replica is on the thread: the Runner of requests naming it.
    pub user_id: Option<String>,
    /// The agents this desktop offers for Remote Runs; empty when it does not
    /// run them at all.
    pub agents: Vec<String>,
    /// "Accept Remote Runs" in this thread, as the server last said.
    pub accept: bool,
    /// The one person whose requests here are approved without asking.
    pub auto_approve: Option<String>,
    /// Requests this person asked or must run, newest first.
    pub requests: Vec<RemoteRun>,
}

/// A peer as the app shows it: its awareness with file ids turned into paths.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerView {
    pub peer_id: String,
    pub user_id: String,
    pub role: Role,
    pub surface: String,
    /// The file it is typing in.
    pub typing: Option<String>,
    pub cursors: Vec<PeerCursor>,
    /// Its Runs in flight and the file each is touching.
    pub runs: Vec<PeerRun>,
    pub sync: Option<SyncState>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerCursor {
    pub file_id: u64,
    pub path: Option<String>,
    pub anchor: u64,
    pub head: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerRun {
    pub run_id: String,
    pub path: Option<String>,
}

/// What a file opened in the Atlas editor starts from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenedDoc {
    pub file_id: u64,
    /// The whole document, as one Yjs update.
    pub state: Vec<u8>,
}

/// A Run as the app shows it: the server's view plus the files its merge
/// changed, by path.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunView {
    #[serde(flatten)]
    pub run: ThreadRun,
    pub files: Vec<String>,
    /// The file it is touching now, as its Runner says (ATL-407).
    pub current_file: Option<String>,
}

/// Bundle requests kept while the person has not agreed to send history.
const MAX_WANTED: usize = 16;

/// The least time between two bundles this replica builds.
pub const BUNDLE_COOLDOWN: Duration = Duration::from_secs(60);

/// The most files one `checksum` names (the server's cap).
const MAX_CHECKSUM_FILES: usize = 2000;

/// How many times a rejected merge is recomputed before giving up.
const MERGE_ATTEMPTS: u32 = 8;

/// Runs kept for display; the server has the full list.
const RUNS_KEPT: usize = 50;

/// Remote Run requests kept for display once they are over.
const REMOTE_KEPT: usize = 20;

/// What the server answered to one frame this session is waiting on.
#[derive(Debug)]
enum Answer {
    Ack,
    Nack {
        code: String,
        message: String,
    },
    Accepted {
        version: u64,
        files: Vec<FileVersion>,
        conflicts: Vec<u64>,
    },
    Resolved {
        version: u64,
        file_version: FileVersion,
    },
    ResolveRejected {
        version: u64,
    },
    Rejected {
        versions: Vec<FileVersion>,
    },
    Checksum {
        status: ChecksumStatus,
        mismatched: Vec<u64>,
    },
}

/// Why a replica rebuilds itself from the thread.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Rebuild {
    /// The thread is behind this replica: it lost history this replica
    /// holds, so every difference is the person's to keep.
    Resync,
    /// This replica drifted: only work not yet sent is the person's.
    Repair,
}

/// What checking this replica against the thread found (ATL-404).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verification {
    /// Every file matches canonical state.
    Match,
    /// These files had drifted; the replica rebuilt itself from the thread.
    Repaired(Vec<String>),
    /// Not checked now — offline, or changes still on their way — and why.
    Skipped(&'static str),
    /// The server could not check this point in history (compacted, or a
    /// moment too new); ask again later.
    Unavailable,
}

/// How long to wait for the server's answer to something we asked.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(15);

/// How long a joiner waits for somebody to build and upload a bundle. Large
/// histories take a while to pack.
const BUNDLE_TIMEOUT: Duration = Duration::from_secs(600);

/// What sharing the sharer's working changes did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ShareReport {
    /// Paths that became canonical changes.
    pub shared: Vec<String>,
    /// Paths held back because they look like secrets, and why.
    pub blocked: Vec<(String, SecretReason)>,
}

pub struct ThreadSession<T: Transport> {
    transport: T,
    replica: Replica,
    /// This replica's stable id on the wire, said in every `hello`.
    client_id: String,
    /// Whether the socket is up. While it is down, saves wait in `offline`
    /// and updates sent but not acknowledged wait in `unacked` (ATL-404).
    connected: bool,
    /// Canonical updates sent and not yet acknowledged, by `client_seq`, as
    /// sent: resent after a reconnect, the server storing each once.
    unacked: BTreeMap<u64, Vec<u8>>,
    /// Paths saved while disconnected, handled once the socket is back.
    offline: std::collections::BTreeSet<String>,
    /// Files whose compacted history arrives as a snapshot (ATL-397).
    pending_snapshots: HashSet<u64>,
    role: Option<Role>,
    head: u64,
    next_client_seq: u64,
    /// `tree.ensure` frames awaiting their ack, by `client_seq`.
    pending_tree: HashMap<u64, (String, FileKind)>,
    /// Files gone from disk, not yet known to be deleted rather than moved
    /// (ATL-403). Settled by [`ThreadSession::settle_removals`].
    missing: Vec<u64>,
    gaps: u64,
    updates_sent: u64,
    last_nack: Option<(String, String)>,
    /// Each file's merge version, as last heard (ADR-0022).
    versions: HashMap<u64, u64>,
    runs: BTreeMap<String, RunView>,
    /// What each Run said, by `run_no`, as this replica heard it live or
    /// streamed it (ATL-411): the context digest's source.
    transcripts: BTreeMap<u64, RunTranscript>,
    /// Conflicts heard of (ATL-410), by id: raised live, or seeded from the
    /// thread's REST read when the app opens it.
    conflicts: BTreeMap<u64, ThreadConflict>,
    /// Everybody else on the socket, by peer id (ATL-407).
    peers: BTreeMap<String, Peer>,
    /// What this replica says about itself, and what it last said.
    awareness: AwarenessState,
    said: Option<AwarenessState>,
    /// Files open in the Atlas editor, with the state vector it was last sent.
    open_docs: HashMap<u64, Vec<u8>>,
    /// `client_seq`s whose answer a caller is waiting for, and the answers.
    awaiting: HashSet<u64>,
    answers: HashMap<u64, Answer>,
    events: Option<mpsc::UnboundedSender<ThreadEvent>>,
    /// The thread's object doors.
    store: Arc<dyn ObjectStore>,
    /// This machine's bare repository for the thread, where bundles are built
    /// and fetched (ATL-402).
    thread_repo: Option<ThreadRepo>,
    /// Our own `bundle.request`: its `client_seq`, the id the server gave it,
    /// and the answer once it came.
    bundle_request: Option<(u64, Option<String>)>,
    bundle_answer: Option<BundleAnswer>,
    /// Requests from others this replica has not served yet.
    wanted: Vec<BundleWant>,
    /// Has the person agreed to send this repository's history to teammates
    /// who lack the Base? A bundle is the whole history behind the Base, so
    /// nothing is built until they say yes (ATL-402).
    serve_bundles: bool,
    /// When this replica last built a bundle: builds are rate-limited, so a
    /// stream of requests cannot keep it packing history.
    last_bundle_built: Option<tokio::time::Instant>,
    /// Blocked paths the person included anyway in this share: their Base
    /// content may be published too.
    included: HashSet<String>,
    /// Why this replica can only watch, when it can.
    watch_only: Option<String>,
    /// Things done on the person's behalf they should hear about — a file of
    /// theirs moved aside, a replica repaired — newest last.
    notices: Vec<String>,
    /// Who the server knows this socket as (from `welcome`).
    user_id: Option<String>,
    /// The thread was closed: nothing changes until it is reopened (ATL-406).
    closed: bool,
    /// Joined under "approval required" and not approved yet.
    awaiting_approval: bool,
    /// New files saved while this replica could not change the thread, to
    /// introduce once it can.
    unsent_new: std::collections::BTreeSet<String>,
    /// The agents this desktop runs Remote Runs with, said at every `hello`;
    /// empty when it does not run them (ATL-417).
    remote_agents: Vec<String>,
    /// The Runner's own choices here, as the server last said.
    remote_accept: bool,
    remote_auto: Option<String>,
    /// Remote Run requests this person asked or must run, by id.
    remote_requests: BTreeMap<String, RemoteRun>,
}

impl<T: Transport> ThreadSession<T> {
    /// Say hello as `client_id` and apply the thread's journal until `synced`.
    ///
    /// `client_id` should be stable for this replica across reconnects: the
    /// server's welcome then says which of our frames it already stored.
    pub async fn open(
        transport: T,
        replica: Replica,
        client_id: &str,
    ) -> Result<Self, SessionError> {
        Self::connect(transport, replica, client_id, Arc::new(NoStore)).await
    }

    /// [`ThreadSession::open`] with the thread's object doors from the start:
    /// a thread behind a compaction hands a new replica snapshots to fetch
    /// before it is synced (ATL-397).
    pub async fn connect(
        transport: T,
        replica: Replica,
        client_id: &str,
        store: Arc<dyn ObjectStore>,
    ) -> Result<Self, SessionError> {
        Self::connect_offering(transport, replica, client_id, store, Vec::new()).await
    }

    /// [`ThreadSession::connect`] as a desktop that runs Remote Runs with
    /// `agents` (ATL-417): it says so at every `hello`, hears requests made of
    /// it, and may be asked by teammates once the person accepts. With no
    /// agents it is an ordinary replica.
    pub async fn connect_offering(
        transport: T,
        replica: Replica,
        client_id: &str,
        store: Arc<dyn ObjectStore>,
        agents: Vec<String>,
    ) -> Result<Self, SessionError> {
        let mut session = Self {
            transport,
            replica,
            client_id: client_id.to_string(),
            connected: true,
            unacked: BTreeMap::new(),
            offline: std::collections::BTreeSet::new(),
            pending_snapshots: HashSet::new(),
            role: None,
            head: 0,
            next_client_seq: 1,
            pending_tree: HashMap::new(),
            missing: Vec::new(),
            gaps: 0,
            updates_sent: 0,
            last_nack: None,
            versions: HashMap::new(),
            runs: BTreeMap::new(),
            transcripts: BTreeMap::new(),
            conflicts: BTreeMap::new(),
            peers: BTreeMap::new(),
            awareness: AwarenessState::default(),
            said: None,
            open_docs: HashMap::new(),
            awaiting: HashSet::new(),
            answers: HashMap::new(),
            events: None,
            store,
            thread_repo: None,
            bundle_request: None,
            bundle_answer: None,
            wanted: Vec::new(),
            serve_bundles: false,
            last_bundle_built: None,
            included: HashSet::new(),
            watch_only: None,
            notices: Vec::new(),
            user_id: None,
            closed: false,
            awaiting_approval: false,
            unsent_new: std::collections::BTreeSet::new(),
            remote_agents: agents,
            remote_accept: false,
            remote_auto: None,
            remote_requests: BTreeMap::new(),
        };
        if session.greet(0).await? {
            // Nothing can be ahead of a thread from 0.
            return Err(SessionError::Refused {
                code: "resync-required".into(),
                message: "the thread asked a fresh replica to start over".into(),
            });
        }
        Ok(session)
    }

    /// Say hello from `since` and handle the catch-up until `synced`. Answers
    /// `true` when the server says this replica is ahead of it instead.
    async fn greet(&mut self, since: u64) -> Result<bool, SessionError> {
        // A new socket: presence starts over, and this replica says its piece again.
        self.peers.clear();
        self.said = None;
        let offers = !self.remote_agents.is_empty();
        let hello = ClientControl::Hello {
            protocol: wire::PROTOCOL_VERSION,
            client_id: self.client_id.clone(),
            since,
            capabilities: if offers {
                vec![wire::CAPABILITY_REMOTE_RUN.to_string()]
            } else {
                Vec::new()
            },
            agents: self.remote_agents.clone(),
        };
        self.send_control(&hello).await?;
        loop {
            let message = tokio::time::timeout(ANSWER_TIMEOUT, self.transport.recv())
                .await
                .map_err(|_| SessionError::Timeout)?
                .ok_or(SessionError::ClosedEarly)?;
            match self.handle(message).await? {
                Handled::Synced => return Ok(false),
                Handled::Resync => return Ok(true),
                Handled::Other => {}
            }
        }
    }

    // -----------------------------------------------------------------------
    // Reconnecting, offline saves, and repair (ATL-404)
    // -----------------------------------------------------------------------

    pub fn is_connected(&self) -> bool {
        self.connected
    }

    /// The socket dropped: from now on saves wait for [`Self::reconnect`].
    pub fn mark_disconnected(&mut self) {
        self.connected = false;
    }

    /// The close code the server sent, if it closed us.
    pub fn close_code(&self) -> Option<u16> {
        self.transport.close_code()
    }

    /// Saves made while disconnected, waiting to go.
    pub fn offline_saves(&self) -> usize {
        self.offline.len()
    }

    /// Carry on over a new socket: ask from the last `seq` this replica holds
    /// and apply the tail — or snapshot plus tail, behind a compaction. Saves
    /// the person made meanwhile are folded in as that arrives, updates the
    /// server never acknowledged are resent (it stores each once), and saves
    /// made while offline then go out. When the server says this replica is
    /// ahead of it, the replica rebuilds itself from the thread.
    pub async fn reconnect(&mut self, transport: T) -> Result<(), SessionError> {
        self.transport = transport;
        self.connected = true;
        // Nothing asked on the old socket will be answered on this one.
        self.awaiting.clear();
        self.answers.clear();
        self.pending_tree.clear();
        self.bundle_request = None;
        self.bundle_answer = None;
        if self.greet(self.head).await? {
            self.rebuild(Rebuild::Resync).await?;
        }
        let resend: Vec<Vec<u8>> = self.unacked.values().cloned().collect();
        for bytes in resend {
            self.transport.send(Message::Binary(bytes)).await?;
        }
        self.flush_offline().await
    }

    /// Discard this replica's documents and build them again from the
    /// thread — snapshot plus tail from `seq` 0 — then write canonical state
    /// over the replica worktree. Never touches the person's own checkout.
    async fn rebuild(&mut self, why: Rebuild) -> Result<(), SessionError> {
        // The person's work the thread may not have: saves not read yet
        // (offline ones included) and edits sent but never acknowledged —
        // and after a resync, everything: the thread lost history this
        // replica holds. It must survive the rebuild, since canonical state
        // is written over the worktree at its end.
        let unacked_files: HashSet<u64> = self
            .unacked
            .values()
            .filter_map(|bytes| wire::decode(bytes).map(|f| f.file_id))
            .collect();
        let mine = self
            .replica
            .unsynced_work(&unacked_files, why == Rebuild::Resync);

        self.replica.begin_rebuild();
        self.head = 0;
        self.versions.clear();
        self.pending_snapshots.clear();
        self.unacked.clear();
        let result = self.greet(0).await;

        // Where the rebuilt file is what the person's edit was made against,
        // their bytes stay and go out as a save; anywhere else they are kept
        // beside it, and the person is told.
        let mut keep = HashSet::new();
        for work in &mine {
            let canonical = self.replica.text(&work.path);
            if canonical.as_deref() == Some(work.content.as_str()) {
                continue;
            }
            if canonical.as_deref() == Some(work.before.as_str()) {
                keep.insert(work.path.clone());
            } else {
                let aside = self
                    .replica
                    .keep_copy(&work.path, work.content.as_bytes())?;
                self.notice(match why {
                    Rebuild::Resync => format!(
                        "The thread lost recent changes to {}; your copy is in {}.",
                        work.path, aside
                    ),
                    Rebuild::Repair => format!(
                        "{} changed in the thread while your edit to it was on its way; your version is in {}.",
                        work.path, aside
                    ),
                });
            }
        }
        self.replica.finish_rebuild(&keep)?;
        if result? {
            return Err(SessionError::Refused {
                code: "resync-required".into(),
                message: "the thread asked for a resync twice".into(),
            });
        }
        for (file_id, sha) in self.replica.blobs_to_fetch() {
            self.fetch_blob(file_id, sha).await?;
        }
        for path in keep {
            self.offline.insert(path);
        }
        Ok(())
    }

    /// Read and send the saves waiting since the socket dropped (or a
    /// rebuild kept).
    async fn flush_offline(&mut self) -> Result<(), SessionError> {
        for path in std::mem::take(&mut self.offline) {
            if let Err(e) = self.file_saved(&path).await {
                tracing::warn!(target: "atlas_thread_sync", %path, "offline save: {e}");
                self.offline.insert(path);
                return Err(e);
            }
        }
        Ok(())
    }

    /// Check every file against canonical state at this replica's head, and
    /// repair the replica if any has drifted — said in a notice. Run at each
    /// Run's end and periodically by the app's loop.
    pub async fn verify(&mut self) -> Result<Verification, SessionError> {
        if !self.connected {
            return Ok(Verification::Skipped("offline"));
        }
        // A save the watcher has not reported yet must go out before any
        // repair could write canonical state over it.
        if self.replica.is_materialized() && self.read_only().is_none() {
            let paths: Vec<String> = self.replica.files().map(|(_, p)| p.to_string()).collect();
            for path in paths {
                self.file_saved(&path).await?;
            }
        }
        if !self.unacked.is_empty()
            || !self.offline.is_empty()
            || !self.missing.is_empty()
            || !self.unsent().is_empty()
        {
            return Ok(Verification::Skipped("changes are still on their way"));
        }
        let files: Vec<FileHash> = self
            .replica
            .hashes()
            .into_iter()
            .take(MAX_CHECKSUM_FILES)
            .map(|(file_id, hash)| FileHash { file_id, hash })
            .collect();
        if files.is_empty() {
            return Ok(Verification::Match);
        }
        let client_seq = self.take_client_seq();
        let check = ClientControl::Checksum {
            client_seq,
            at: self.head,
            files,
        };
        let (status, mismatched) = match self.ask(client_seq, &check).await? {
            Answer::Checksum { status, mismatched } => (status, mismatched),
            Answer::Nack { code, message } => return Err(SessionError::Refused { code, message }),
            other => return Err(unexpected(&other)),
        };
        match status {
            ChecksumStatus::Match => Ok(Verification::Match),
            ChecksumStatus::Unavailable => Ok(Verification::Unavailable),
            ChecksumStatus::Mismatch => {
                let mut paths: Vec<String> = mismatched
                    .iter()
                    .filter_map(|id| self.replica.path_of(*id))
                    .collect();
                paths.sort();
                tracing::warn!(target: "atlas_thread_sync", ?paths, "replica drifted; rebuilding");
                self.rebuild(Rebuild::Repair).await?;
                self.flush_offline().await?;
                self.notice(format!(
                    "Repaired {} {} that had drifted from the thread: {}.",
                    paths.len(),
                    if paths.len() == 1 { "file" } else { "files" },
                    paths.join(", ")
                ));
                Ok(Verification::Repaired(paths))
            }
        }
    }

    pub fn replica(&self) -> &Replica {
        &self.replica
    }

    pub fn role(&self) -> Option<Role> {
        self.role
    }

    /// The newest `seq` this replica has seen.
    pub fn head(&self) -> u64 {
        self.head
    }

    /// How many times `seq` jumped — a frame this replica never received.
    pub fn gaps(&self) -> u64 {
        self.gaps
    }

    /// Canonical updates this session has sent. A remote write that echoed back
    /// would show up here.
    pub fn updates_sent(&self) -> u64 {
        self.updates_sent
    }

    pub fn last_nack(&self) -> Option<&(String, String)> {
        self.last_nack.as_ref()
    }

    /// Where other people's live Run frames go.
    pub fn set_events(&mut self, events: mpsc::UnboundedSender<ThreadEvent>) {
        self.events = Some(events);
    }

    /// The thread's object doors: blobs, bundles and snapshots.
    pub fn set_store(&mut self, store: Arc<dyn ObjectStore>) {
        self.store = store;
    }

    /// This machine's bare repository for the thread (ATL-402).
    pub fn set_thread_repo(&mut self, repo: ThreadRepo) {
        self.thread_repo = Some(repo);
    }

    /// What was done on the person's behalf, newest last (at most a few).
    pub fn notices(&self) -> &[String] {
        &self.notices
    }

    fn notice(&mut self, text: String) {
        const KEPT: usize = 5;
        self.notices.push(text);
        if self.notices.len() > KEPT {
            self.notices.remove(0);
        }
    }

    /// Why this replica may not change the thread, or `None` when it may.
    pub fn read_only(&self) -> Option<String> {
        if let Some(why) = &self.watch_only {
            return Some(why.clone());
        }
        if !self.replica.has_base() {
            return Some("This machine does not have the thread's starting commit yet.".into());
        }
        if self.closed {
            return Some(
                "This thread is closed: nothing changes until the owner reopens it. Your edits stay on this machine."
                    .into(),
            );
        }
        if self.role == Some(Role::Viewer) {
            return Some(if self.awaiting_approval {
                "Waiting for the owner to approve you. Until then you can watch; your edits stay on this machine and are sent once you are in.".into()
            } else {
                "You are a viewer in this thread: your edits stay on this machine and are not shared.".into()
            });
        }
        None
    }

    /// The person joined a thread that needs the owner's approval, and is
    /// waiting for it (the app learns this from `POST /join`).
    pub fn set_awaiting_approval(&mut self, waiting: bool) {
        self.awaiting_approval = waiting;
    }

    /// Whether the thread is closed.
    pub fn is_closed(&self) -> bool {
        self.closed
    }

    /// Who the server knows this replica's person as.
    pub fn user_id(&self) -> Option<&str> {
        self.user_id.as_deref()
    }

    /// Saves held on this machine because it may not change the thread:
    /// edited files, and new ones.
    pub fn unsent(&self) -> Vec<String> {
        let mut all = self.replica.unsent_files();
        all.extend(self.unsent_new.iter().cloned());
        all.sort();
        all.dedup();
        all
    }

    /// Tell the replica whether saves may go, after anything that changes it.
    fn refresh_read_only(&mut self) {
        let read_only = self.read_only().is_some();
        self.replica.set_read_only(read_only);
    }

    /// Are there held saves that may go now?
    pub fn wants_flush(&self) -> bool {
        self.read_only().is_none()
            && self.connected
            && (!self.unsent_new.is_empty()
                || !self.replica.unsent_files().is_empty()
                || !self.missing.is_empty())
    }

    /// Send the saves held while this replica could not change the thread —
    /// each merged with what the thread did meanwhile. The app's loop calls
    /// this once it may (a viewer promoted, a thread reopened).
    pub async fn flush_unsent(&mut self) -> Result<(), SessionError> {
        if self.read_only().is_some() {
            return Ok(());
        }
        let mut paths = self.replica.unsent_files();
        paths.extend(std::mem::take(&mut self.unsent_new));
        for path in paths {
            self.file_saved(&path).await?;
        }
        self.settle_removals().await?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Bootstrap without a shared Base (ATL-402)
    // -----------------------------------------------------------------------

    /// Bring the Base onto this machine if it lacks it: report the commits
    /// `own_repo` (the person's repository, if they have one) holds, wait for
    /// a replica that has the Base to build and upload a bundle of the rest,
    /// fetch it into the thread repository, and attach that to the replica.
    ///
    /// Answers [`Bootstrapped::WatchOnly`] — never an error — when no bundle
    /// can come: nobody holding the Base is online, or the history is over
    /// the Organisation's bundle limit. The replica then follows the thread
    /// read-only and says why.
    pub async fn bootstrap(
        &mut self,
        own_repo: Option<&Path>,
    ) -> Result<Bootstrapped, SessionError> {
        if self.replica.has_base() {
            return Ok(Bootstrapped::Ready);
        }
        let repo = self
            .thread_repo
            .clone()
            .ok_or_else(|| SessionError::ReadOnly("no thread repository to fetch into".into()))?;
        repo.ensure(own_repo)?;
        if repo.has(self.replica.base()) {
            self.replica.attach_repo(repo.path())?;
            self.watch_only = None;
            self.refresh_read_only();
            return Ok(Bootstrapped::Ready);
        }
        if self.role == Some(Role::Viewer) {
            return Ok(self.watch_only_because(
                "Viewers follow the thread without its repository history.".into(),
            ));
        }
        let have = own_repo.map_or_else(Vec::new, |r| git::have_commits(r, bootstrap::MAX_HAVE));
        let client_seq = self.take_client_seq();
        self.bundle_request = Some((client_seq, None));
        self.bundle_answer = None;
        self.awaiting.insert(client_seq);
        let sent = self
            .send_control(&ClientControl::BundleRequest { client_seq, have })
            .await;
        let answer = match sent {
            Ok(()) => self.await_bundle(client_seq).await,
            Err(e) => Err(e),
        };
        self.awaiting.remove(&client_seq);
        self.bundle_request = None;
        let answer = match answer? {
            Some(answer) => answer,
            None => {
                return Ok(self.watch_only_because(
                    "Nobody who has this thread's starting commit sent it in time. You can watch; join again to edit."
                        .into(),
                ))
            }
        };
        let sha = match answer {
            BundleAnswer::Available { sha } => sha,
            BundleAnswer::Unavailable {
                reason: BundleFailure::TooLarge,
                bytes,
            } => {
                let size = bytes.map_or_else(String::new, |b| format!(" ({} MB)", b.div_ceil(1024 * 1024)));
                return Ok(self.watch_only_because(format!(
                    "The repository history this thread needs{size} is over your organisation's Base bundle limit, so you can watch but not edit. Fetch the commit yourself and join again to edit."
                )));
            }
            BundleAnswer::Unavailable { .. } => {
                return Ok(self.watch_only_because(
                    "Nobody who has this thread's starting commit is online to send it. You can watch; join again later to edit."
                        .into(),
                ))
            }
        };
        let bytes = self.store.get_bundle(sha.clone()).await?;
        let base = self.replica.base().to_string();
        repo.install(&base, &sha, &bytes)?;
        self.replica.attach_repo(repo.path())?;
        self.watch_only = None;
        self.refresh_read_only();
        Ok(Bootstrapped::Ready)
    }

    fn watch_only_because(&mut self, why: String) -> Bootstrapped {
        self.watch_only = Some(why.clone());
        self.refresh_read_only();
        Bootstrapped::WatchOnly(why)
    }

    /// Handle messages until our bundle request is answered, or give up after
    /// [`BUNDLE_TIMEOUT`] (`None`).
    async fn await_bundle(
        &mut self,
        client_seq: u64,
    ) -> Result<Option<BundleAnswer>, SessionError> {
        let deadline = tokio::time::Instant::now() + BUNDLE_TIMEOUT;
        loop {
            if let Some(answer) = self.bundle_answer.take() {
                return Ok(Some(answer));
            }
            if let Some(Answer::Nack { code, message }) = self.answers.remove(&client_seq) {
                return Err(SessionError::Refused { code, message });
            }
            match tokio::time::timeout_at(deadline, self.transport.recv()).await {
                Err(_) => return Ok(None),
                Ok(None) => return Err(SessionError::ClosedEarly),
                Ok(Some(message)) => {
                    self.handle(message).await?;
                }
            }
        }
    }

    /// Let this replica send the repository's history — everything behind the
    /// Base — to teammates who lack it. Off until the person turns it on;
    /// requests heard meanwhile wait, and are served once it is.
    pub fn set_serve_bundles(&mut self, on: bool) {
        self.serve_bundles = on;
    }

    pub fn serves_bundles(&self) -> bool {
        self.serve_bundles
    }

    /// Bundle requests waiting for the person to agree to send history.
    pub fn bundles_wanted(&self) -> usize {
        if self.serve_bundles {
            0
        } else {
            self.wanted.len()
        }
    }

    /// Bundle requests from others to serve now — every one waiting, to be
    /// answered by a single build ([`ThreadSession::serve_bundles`]). None
    /// until the person has agreed to send history
    /// ([`ThreadSession::set_serve_bundles`]), and none within
    /// [`BUNDLE_COOLDOWN`] of the last build: packing history is heavy, so a
    /// stream of requests is answered a minute at a time — all of them, so
    /// none is starved by newer ones.
    pub fn take_bundle_wants(&mut self) -> Vec<BundleWant> {
        if !self.serve_bundles || self.wanted.is_empty() {
            return Vec::new();
        }
        if self
            .last_bundle_built
            .is_some_and(|at| at.elapsed() < BUNDLE_COOLDOWN)
        {
            return Vec::new();
        }
        std::mem::take(&mut self.wanted)
    }

    /// Build the bundle somebody asked for, upload it and say so — or, when it
    /// is over the Organisation's limit, say that instead so they stop
    /// waiting. A replica without the Base, or without a thread repository,
    /// leaves the request to somebody else.
    pub async fn serve_bundle(&mut self, want: BundleWant) -> Result<(), SessionError> {
        self.serve_bundles(vec![want]).await
    }

    /// Answer every request in `wants` with one build: a thin bundle against
    /// the one requester's history, or — for several — a full bundle, which
    /// fits them all.
    pub async fn serve_bundles(&mut self, wants: Vec<BundleWant>) -> Result<(), SessionError> {
        if wants.is_empty() {
            return Ok(());
        }
        let (Some(own), Some(repo)) = (
            self.replica.repo().map(Path::to_path_buf),
            self.thread_repo.clone(),
        ) else {
            return Ok(());
        };
        repo.ensure(Some(&own))?;
        self.last_bundle_built = Some(tokio::time::Instant::now());
        let have: &[String] = match wants.as_slice() {
            [one] => &one.have,
            _ => &[],
        };
        let bundle = repo.build(self.replica.base(), have)?;
        let size = bundle.bytes.len() as u64;
        let put = self
            .store
            .put_bundle(bundle.sha256.clone(), bundle.bytes, bundle.prerequisites)
            .await;
        let too_large = match put {
            Ok(()) => false,
            Err(StoreError::Refused { code, .. }) if code == "limit_reached" => true,
            Err(e) => return Err(e.into()),
        };
        for want in wants {
            let client_seq = self.take_client_seq();
            let frame = if too_large {
                ClientControl::BundleFailed {
                    client_seq,
                    request_id: want.request_id,
                    reason: BundleFailure::TooLarge,
                    bytes: size,
                }
            } else {
                ClientControl::BundleReady {
                    client_seq,
                    request_id: want.request_id,
                    sha: bundle.sha256.clone(),
                }
            };
            self.expect_ack(client_seq, &frame).await?;
        }
        Ok(())
    }

    async fn send_control(&mut self, frame: &ClientControl) -> Result<(), SessionError> {
        self.transport
            .send(Message::Text(
                serde_json::to_string(frame).expect("control frames are JSON"),
            ))
            .await?;
        Ok(())
    }

    /// The Runs this session has heard of, newest first.
    pub fn runs(&self) -> Vec<RunView> {
        let at: HashMap<&str, Option<u64>> = self
            .peers
            .values()
            .filter_map(|p| p.state.as_ref())
            .chain(std::iter::once(&self.awareness))
            .flat_map(|s| s.runs.iter().map(|r| (r.run_id.as_str(), r.file_id)))
            .collect();
        let mut runs: Vec<RunView> = self
            .runs
            .values()
            .cloned()
            .map(|mut view| {
                view.current_file = at
                    .get(view.run.run_id.as_str())
                    .copied()
                    .flatten()
                    .filter(|_| view.run.status == "running")
                    .and_then(|id| self.replica.path_of(id));
                view
            })
            .collect();
        runs.sort_by_key(|r| std::cmp::Reverse(r.run.run_no));
        runs
    }

    /// A file's merge version as this session last heard it.
    pub fn merge_version(&self, file_id: u64) -> u64 {
        self.versions.get(&file_id).copied().unwrap_or(0)
    }

    // -----------------------------------------------------------------------
    // Thread Versions (ATL-419)
    // -----------------------------------------------------------------------

    /// Each file as canonical state holds it now: absent once deleted.
    fn sides_now(&self) -> Vec<(u64, String, String, Side)> {
        self.replica
            .file_states()
            .into_iter()
            .map(|(id, f)| {
                let now = if f.deleted {
                    Side::Absent
                } else if f.kind == FileKind::Text {
                    Side::Text(f.text.unwrap_or_default())
                } else {
                    Side::Binary(f.blob)
                };
                (id, f.path, f.origin, now)
            })
            .collect()
    }

    /// The thread's files against its Base: what canonical state changed,
    /// each file compared with what its first path held at the Base.
    pub fn diff_against_base(&self) -> Vec<FileDiff> {
        let has_base = self.replica.has_base();
        let mut diffs: Vec<FileDiff> = self
            .sides_now()
            .into_iter()
            .filter_map(|(id, path, origin, now)| {
                let base = if !has_base {
                    Side::Unavailable
                } else {
                    match self.replica.base_bytes(&origin) {
                        Ok(None) => Side::Absent,
                        Ok(Some(bytes)) if crate::replica::looks_textual(&bytes) => {
                            Side::Text(String::from_utf8_lossy(&bytes).into_owned())
                        }
                        Ok(Some(_)) => Side::Binary(None),
                        Err(_) => Side::Unavailable,
                    }
                };
                versions::compare(id, &path, &base, &now, false)
            })
            .collect();
        diffs.sort_by(|a, b| a.path.cmp(&b.path));
        diffs
    }

    /// The thread's files against Thread Version `at` (ATL-419): each file
    /// as the server captured it then — text fetched by its blob from the
    /// thread's store — against canonical state now. A file whose content
    /// cannot be read says so rather than failing the rest.
    pub async fn diff_against_version(&self, at: &VersionFiles) -> Vec<FileDiff> {
        let mut then: HashMap<u64, Side> = HashMap::new();
        for f in &at.files {
            let side = match (f.kind, &f.blob) {
                (FileKind::Text, Some(sha)) => match self.store.get_blob(sha.clone()).await {
                    Ok(bytes) => Side::Text(String::from_utf8_lossy(&bytes).into_owned()),
                    Err(e) => {
                        tracing::debug!(target: "atlas_thread_sync", "Version {} blob {sha}: {e}", at.version);
                        Side::Unavailable
                    }
                },
                (FileKind::Text, None) => Side::Unavailable,
                (FileKind::Binary, blob) => Side::Binary(blob.clone()),
            };
            then.insert(f.file_id, side);
        }
        let mut diffs = Vec::new();
        for (id, path, _, now) in self.sides_now() {
            let base = then.remove(&id).unwrap_or(Side::Absent);
            diffs.extend(versions::compare(id, &path, &base, &now, true));
        }
        // Files the Version had that this replica has never heard of.
        for f in &at.files {
            if let Some(base) = then.remove(&f.file_id) {
                diffs.extend(versions::compare(f.file_id, &f.path, &base, &Side::Absent, true));
            }
        }
        diffs.sort_by(|a, b| a.path.cmp(&b.path));
        diffs
    }

    // -----------------------------------------------------------------------
    // Line comments (ATL-413, ATL-416)
    // -----------------------------------------------------------------------

    /// Anchor lines `span` of the text file at `path`: its id and the range
    /// a `thread_range` comment carries. `None` for a path the thread does
    /// not hold as text, or lines it does not have.
    pub fn anchor_range(&self, path: &str, span: LineSpan) -> Option<(u64, RangeAnchor)> {
        self.anchor_range_of(self.replica.file_id(path)?, span)
    }

    /// [`ThreadSession::anchor_range`] for a file named by its id — what an
    /// editor bound to the file holds.
    pub fn anchor_range_of(&self, file_id: u64, span: LineSpan) -> Option<(u64, RangeAnchor)> {
        let anchor = self.replica.doc_of(file_id)?.anchor_lines(span)?;
        Some((file_id, anchor))
    }

    /// Where each comment's range is now: its lines in the file's text as
    /// this replica holds it, or `None` when that text is gone (outdated) or
    /// the file is.
    pub fn resolve_ranges(&self, ranges: &[(u64, String, String)]) -> Vec<Option<LineSpan>> {
        ranges
            .iter()
            .map(|(file_id, start, end)| self.replica.doc_of(*file_id)?.resolve_lines(start, end))
            .collect()
    }

    fn tell_versions(&self) {
        if let Some(events) = &self.events {
            let _ = events.send(ThreadEvent::VersionsChanged);
        }
    }

    // -----------------------------------------------------------------------
    // Runs (ADR-0022, ATL-405)
    // -----------------------------------------------------------------------

    /// The Run worktree at `root`, of this replica's repository and Base.
    /// Refused while this machine lacks the Base.
    pub fn run_worktree(&self, root: &Path) -> Result<RunWorktree, SessionError> {
        let repo = self
            .replica
            .repo()
            .ok_or_else(|| ReplicaError::BaseMissing(self.replica.base().to_string()))?;
        Ok(RunWorktree::new(repo, self.replica.base(), root))
    }

    /// Reset the Run worktree to canonical state now, creating it if needed.
    /// A Run started later resets it again at its own fork.
    pub fn prepare_run(&self, worktree: &RunWorktree) -> Result<(), SessionError> {
        Ok(worktree.reset(&self.fork()?)?)
    }

    /// Canonical state as this replica holds it now, as a Run forks it.
    fn fork(&self) -> Result<Fork, SessionError> {
        let mut binaries = BTreeMap::new();
        for (file_id, path) in self.replica.files() {
            if self.replica.kind(file_id) != Some(FileKind::Binary)
                || self.replica.is_deleted(file_id)
            {
                continue;
            }
            let blob = self.replica.blob(file_id).map(str::to_string);
            // The canonical bytes, when this machine has them on disk; the
            // worktree keeps the Base's otherwise, and says so.
            let bytes = match (&blob, self.replica.is_materialized()) {
                (Some(sha), true) => self
                    .replica
                    .read_bytes(path)
                    .ok()
                    .filter(|b| bootstrap::sha256_hex(b) == *sha),
                _ => None,
            };
            let start = match &bytes {
                Some(b) => Some(bootstrap::sha256_hex(b)),
                None => self
                    .replica
                    .base_bytes(path)?
                    .map(|b| bootstrap::sha256_hex(&b)),
            };
            binaries.insert(
                file_id,
                ForkBinary {
                    path: path.to_string(),
                    blob,
                    bytes,
                    start,
                },
            );
        }
        Ok(Fork {
            seq: self.head,
            files: self.replica.fork_files(),
            removed: self.replica.removed_paths(),
            binaries,
        })
    }

    /// Start a Run: fork canonical state as this replica holds it now, reset
    /// the Run worktree to it, and tell the thread. Refused by the server over
    /// the concurrent-Runs limit, for a viewer, or on a closed thread.
    pub async fn start_run(
        &mut self,
        worktree: &RunWorktree,
        spec: RunSpec,
    ) -> Result<ActiveRun, SessionError> {
        if let Some(id) = &spec.remote_request_id {
            self.runnable_remote(id)?;
        }
        let fork = self.fork()?;
        worktree.reset(&fork)?;
        let client_seq = self.take_client_seq();
        let start = ClientControl::RunStart {
            client_seq,
            run_id: spec.run_id.clone(),
            agent: spec.agent,
            model: spec.model,
            fork_seq: fork.seq,
            context_anchor: spec.context_anchor,
            remote_request_id: spec.remote_request_id,
        };
        match self.ask(client_seq, &start).await? {
            Answer::Ack => {}
            Answer::Nack { code, message } => return Err(SessionError::Refused { code, message }),
            other => return Err(unexpected(&other)),
        }
        // The `run` frame that names its number follows the ack.
        let run_no = loop {
            if let Some(view) = self.runs.get(&spec.run_id) {
                break view.run.run_no;
            }
            self.receive_one().await?;
        };
        Ok(ActiveRun {
            run_id: spec.run_id,
            run_no,
            fork,
            worktree: worktree.root().to_path_buf(),
        })
    }

    /// Stream one live Run frame (a serialized `SessionDelta`, say) to
    /// everyone else. Live frames are a view, not a record: one too large for
    /// a frame is dropped, since the Session drain carries the durable copy.
    pub async fn stream_run(
        &mut self,
        run_no: u64,
        kind: FrameKind,
        payload: Vec<u8>,
    ) -> Result<(), SessionError> {
        if payload.len() > wire::MAX_PAYLOAD_BYTES {
            tracing::debug!(target: "atlas_thread_sync", bytes = payload.len(), "live Run frame too large; skipped");
            return Ok(());
        }
        if kind == FrameKind::RunStream {
            self.note_transcript(run_no, &payload);
        }
        let client_seq = self.take_client_seq();
        let bytes =
            wire::encode(&Frame::run(kind, run_no, client_seq, payload)).expect("small numbers");
        self.transport.send(Message::Binary(bytes)).await?;
        Ok(())
    }

    /// The turn is over: merge what the Run left in its worktree into
    /// canonical state — three-way against the fork and canonical state now,
    /// submitted with each file's merge version and recomputed whenever
    /// another merge got there first — then upload the resulting blobs for the
    /// Thread Version and end the Run.
    ///
    /// Hunks that overlap changes made since the fork are held as Conflicts
    /// and submitted with the clean ones, which land at once (ATL-410). A
    /// binary file the Run changed lands whole, unless somebody changed it
    /// since: then it is a whole-file Conflict.
    pub async fn finish_run(
        &mut self,
        run: &ActiveRun,
        worktree: &RunWorktree,
    ) -> Result<RunReport, SessionError> {
        let changes = worktree.changes(&run.fork)?;
        let (texts, binaries): (Vec<_>, Vec<_>) = changes.iter().partition(|c| c.binary.is_none());
        let mut report = RunReport::default();
        // Binary results the merge carries: (file id, path, blob, bytes) to
        // land whole, and whole-file Conflicts.
        let mut landing: Vec<Landing> = Vec::new();
        for _ in 0..MERGE_ATTEMPTS {
            // Plan on the newest state the socket has delivered: what already
            // arrived is handled first, so an overlap with it is found before
            // anything — a new file's tree entry included — reaches the thread.
            self.drain_ready().await?;
            let mut planned = Vec::new();
            for change in &texts {
                // A file the Run created forks from its Base content (or
                // nothing), even if somebody else created it meanwhile; it
                // gets a tree entry only once the whole merge is known to go
                // ahead, so a refused merge leaves the thread as it was.
                let file_id = change
                    .file_id
                    .or_else(|| self.replica.file_id(&change.path));
                let fork = match change.file_id {
                    Some(id) => run.fork.files[&id].snapshot.clone(),
                    None => self.replica.seed_snapshot(&change.path)?,
                };
                let canonical = match file_id {
                    Some(id) => self
                        .replica
                        .snapshot(id)
                        .ok_or(ReplicaError::UnknownFile(id))?,
                    None => fork.clone(),
                };
                // The version this merge is computed against, read now: an
                // answer handled later (an `ensure_file` below) may move it,
                // and submitting the newer one would pass the compare-and-set
                // with a merge computed against the older state.
                let base_version = file_id.map_or(0, |id| self.merge_version(id));
                match merge::three_way(&fork, &change.content, &canonical) {
                    Ok(Some(merged)) => {
                        planned.push((file_id, base_version, change.path.clone(), merged))
                    }
                    Ok(None) => {}
                    Err(MergeError::Doc(e)) => return Err(ReplicaError::Doc(e).into()),
                }
            }
            // Binary files: whole, or a whole-file Conflict.
            landing.clear();
            let mut held_binaries = Vec::new();
            for change in &binaries {
                let bytes = change.binary.clone().expect("partitioned on it");
                let sha = bootstrap::sha256_hex(&bytes);
                let file_id = change
                    .file_id
                    .or_else(|| self.replica.file_id(&change.path));
                let forked = change
                    .file_id
                    .and_then(|id| run.fork.binaries.get(&id))
                    .and_then(|f| f.blob.clone().or_else(|| f.start.clone()));
                let now = file_id.and_then(|id| self.replica.blob(id).map(str::to_string));
                let canonical_now = match (file_id, &now) {
                    (Some(_), Some(blob)) => Some(blob.clone()),
                    // Still at its Base content, or not in the thread yet.
                    (Some(_), None) => forked.clone(),
                    (None, _) => None,
                };
                if canonical_now.as_deref() == Some(sha.as_str()) {
                    continue;
                }
                let unchanged = match file_id {
                    None => true,
                    Some(_) => change.file_id.is_some() && canonical_now == forked,
                };
                if unchanged {
                    landing.push(Landing {
                        file_id,
                        path: change.path.clone(),
                        sha,
                        bytes,
                        seen: now,
                        forked,
                    });
                } else {
                    let id = file_id.expect("a changed binary is in the thread");
                    held_binaries.push((
                        id,
                        self.merge_version(id),
                        forked,
                        canonical_now,
                        sha,
                        bytes,
                    ));
                }
            }
            if planned.is_empty() && landing.is_empty() && held_binaries.is_empty() {
                self.end_run(&run.run_id, RunOutcome::Completed).await?;
                return Ok(report);
            }
            let held_count: usize = planned
                .iter()
                .map(|(_, _, _, m)| m.held.len())
                .sum::<usize>()
                + held_binaries.len();
            let held_bytes: usize = planned
                .iter()
                .flat_map(|(_, _, _, m)| &m.held)
                .map(|h| h.base.len() + h.canonical.len() + h.run.len())
                .sum();
            let total: usize = planned
                .iter()
                .filter_map(|(_, _, _, m)| m.update.as_ref().map(Vec::len))
                .sum::<usize>()
                + held_bytes;
            let oversized_hunk = planned.iter().flat_map(|(_, _, _, m)| &m.held).any(|h| {
                [&h.base, &h.canonical, &h.run]
                    .iter()
                    .any(|t| t.len() > MAX_CONFLICT_TEXT)
            });
            if total > MAX_MERGE_BYTES
                || held_count > MAX_CONFLICTS_PER_MERGE
                || oversized_hunk
                || planned.iter().any(|(_, _, _, m)| {
                    m.update
                        .as_ref()
                        .is_some_and(|u| u.len() > wire::MAX_PAYLOAD_BYTES)
                })
            {
                // Splitting a merge across submits is not this slice's. Nothing
                // merged, so the Run did not complete: it was interrupted, and
                // its result stays in the worktree.
                self.end_run(&run.run_id, RunOutcome::Interrupted).await?;
                return Err(SessionError::Refused {
                    code: "payload_too_large".into(),
                    message: format!(
                        "the Run's merge is {total} bytes and {held_count} Conflicts, over what one merge carries"
                    ),
                });
            }
            let mut ready = Vec::with_capacity(planned.len());
            for (file_id, base_version, path, merged) in planned {
                let file_id = match file_id {
                    Some(id) => id,
                    None => self.ensure_file(&path, true, FileKind::Text).await?,
                };
                ready.push((file_id, base_version, path, merged));
            }
            let planned = ready;
            // A Conflict's Run side must be fetchable by whoever resolves it.
            for (_, _, _, _, sha, bytes) in &held_binaries {
                self.store.put_blob(sha.clone(), bytes.clone()).await?;
            }
            let files: Vec<MergeFile> = planned
                .iter()
                .filter_map(|(file_id, base_version, _, m)| {
                    m.update.as_ref().map(|update| MergeFile {
                        file_id: *file_id,
                        base_version: *base_version,
                        update: base64::engine::general_purpose::STANDARD.encode(update),
                        blob: bootstrap::sha256_hex(m.content.as_bytes()),
                    })
                })
                .collect();
            let mut conflicts: Vec<ConflictHunk> = planned
                .iter()
                .flat_map(|(file_id, base_version, _, m)| {
                    m.held.iter().map(move |h| ConflictHunk {
                        file_id: *file_id,
                        base_version: *base_version,
                        binary: false,
                        lines: Some(LineRange {
                            start: h.lines.start as u64,
                            end: h.lines.end as u64,
                        }),
                        base: Some(h.base.clone()),
                        canonical: Some(h.canonical.clone()),
                        run: Some(h.run.clone()),
                    })
                })
                .collect();
            conflicts.extend(held_binaries.iter().map(
                |(file_id, base_version, base, canonical, sha, _)| ConflictHunk {
                    file_id: *file_id,
                    base_version: *base_version,
                    binary: true,
                    lines: None,
                    base: base.clone(),
                    canonical: canonical.clone(),
                    run: Some(sha.clone()),
                },
            ));
            let accepted = if files.is_empty() && conflicts.is_empty() {
                // Only binary files to land: nothing to compare-and-set.
                Some((self.head, Vec::new(), Vec::new()))
            } else {
                let client_seq = self.take_client_seq();
                let submit = ClientControl::MergeSubmit {
                    client_seq,
                    run_id: run.run_id.clone(),
                    files: files.clone(),
                    conflicts,
                };
                match self.ask(client_seq, &submit).await? {
                    Answer::Accepted {
                        version,
                        files: landed,
                        conflicts,
                    } => Some((version, landed, conflicts)),
                    Answer::Rejected { versions } => {
                        // Another merge landed on one of these files; its
                        // changes arrived ahead of this answer, so recomputing
                        // against the replica now merges onto them — and finds
                        // where two Runs overlap.
                        for v in versions {
                            self.versions.insert(v.file_id, v.version);
                        }
                        report.retries += 1;
                        None
                    }
                    Answer::Nack { code, message } => {
                        return Err(SessionError::Refused { code, message })
                    }
                    other => return Err(unexpected(&other)),
                }
            };
            let Some((version, landed, raised)) = accepted else {
                continue;
            };
            for (file_id, _, _, merged) in &planned {
                // The server relays the merge to everybody else; this replica
                // applies it itself. A save made meanwhile is folded in and
                // goes out as its own change.
                if let Some(update) = &merged.update {
                    let local = self.replica.apply_remote(*file_id, update)?;
                    self.send_updates(*file_id, local).await?;
                }
            }
            for v in landed {
                self.versions.insert(v.file_id, v.version);
            }
            self.head = self.head.max(version);
            report.conflicts = raised;
            report.files = planned
                .iter()
                .filter(|(_, _, _, m)| m.update.is_some())
                .map(|(_, _, path, _)| path.clone())
                .collect();
            if !files.is_empty() {
                report.version = Some(version);
            }
            for ((_, _, path, merged), file) in planned
                .iter()
                .filter(|(_, _, _, m)| m.update.is_some())
                .zip(&files)
            {
                let put = self
                    .store
                    .put_blob(file.blob.clone(), merged.content.clone().into_bytes())
                    .await;
                if let Err(e) = put {
                    tracing::warn!(target: "atlas_thread_sync", %path, "Thread Version blob upload failed: {e}");
                    report.unuploaded.push(path.clone());
                }
            }
            // Binary results nobody else touched land whole. `blob.set` has
            // no compare-and-set, so each is checked again against what has
            // arrived since the plan: a file another Run or person changed
            // meanwhile becomes a whole-file Conflict instead of being
            // overwritten.
            for l in std::mem::take(&mut landing) {
                self.drain_ready().await?;
                let current = l.file_id.or_else(|| self.replica.file_id(&l.path));
                let moved = match (l.file_id, current) {
                    (None, Some(_)) => true,
                    (Some(id), _) => self.replica.blob(id).map(str::to_string) != l.seen,
                    (None, None) => false,
                };
                if moved {
                    let id = current.expect("moved means it is in the thread");
                    let canonical = self
                        .replica
                        .blob(id)
                        .map(str::to_string)
                        .or(l.forked.clone());
                    if canonical.as_deref() != Some(l.sha.as_str()) {
                        let raised = self
                            .hold_binary(run, id, l.forked, canonical, l.sha, l.bytes)
                            .await?;
                        report.conflicts.extend(raised);
                    }
                    continue;
                }
                let file_id = match current {
                    Some(id) => id,
                    None => self.ensure_file(&l.path, true, FileKind::Binary).await?,
                };
                self.set_blob(file_id, &l.sha, l.bytes.clone()).await?;
                if self.replica.is_materialized() {
                    self.replica.write_blob(file_id, &l.bytes)?;
                }
                report.files.push(l.path);
            }
            if let Some(view) = self.runs.get_mut(&run.run_id) {
                view.files.clone_from(&report.files);
            }
            self.end_run(&run.run_id, RunOutcome::Completed).await?;
            return Ok(report);
        }
        // Starved: nothing merged; not a completed Run.
        self.end_run(&run.run_id, RunOutcome::Interrupted).await?;
        Err(SessionError::MergeStarved(MERGE_ATTEMPTS))
    }

    /// Raise a whole-file Conflict for a Run's binary result on its own:
    /// the Run's blob uploaded so anyone can take it, then a merge carrying
    /// only that held hunk, through the usual compare-and-set.
    async fn hold_binary(
        &mut self,
        run: &ActiveRun,
        file_id: u64,
        base: Option<String>,
        canonical: Option<String>,
        sha: String,
        bytes: Vec<u8>,
    ) -> Result<Vec<u64>, SessionError> {
        self.store.put_blob(sha.clone(), bytes).await?;
        for _ in 0..MERGE_ATTEMPTS {
            let client_seq = self.take_client_seq();
            let submit = ClientControl::MergeSubmit {
                client_seq,
                run_id: run.run_id.clone(),
                files: Vec::new(),
                conflicts: vec![ConflictHunk {
                    file_id,
                    base_version: self.merge_version(file_id),
                    binary: true,
                    lines: None,
                    base: base.clone(),
                    canonical: canonical.clone(),
                    run: Some(sha.clone()),
                }],
            };
            match self.ask(client_seq, &submit).await? {
                Answer::Accepted { conflicts, .. } => return Ok(conflicts),
                Answer::Rejected { versions } => {
                    for v in versions {
                        self.versions.insert(v.file_id, v.version);
                    }
                }
                Answer::Nack { code, message } => {
                    return Err(SessionError::Refused { code, message })
                }
                other => return Err(unexpected(&other)),
            }
        }
        Err(SessionError::MergeStarved(MERGE_ATTEMPTS))
    }

    // -----------------------------------------------------------------------
    // Conflicts (ADR-0022, ATL-410)
    // -----------------------------------------------------------------------

    /// The Conflicts this session knows of, open ones first, newest first.
    pub fn conflicts(&self) -> Vec<ConflictView> {
        let mut views: Vec<ConflictView> = self
            .conflicts
            .values()
            .map(|c| self.conflict_view(c))
            .collect();
        views.sort_by_key(|v| {
            (
                !v.conflict.is_open(),
                std::cmp::Reverse(v.conflict.conflict_id),
            )
        });
        views
    }

    /// Open Conflicts: what blocks Apply (ATL-408).
    pub fn open_conflicts(&self) -> usize {
        self.conflicts.values().filter(|c| c.is_open()).count()
    }

    /// Conflicts read over REST (`GET …/conflicts?status=open`) when the app
    /// opens the thread; live frames keep them current after that.
    pub fn seed_conflicts(&mut self, conflicts: Vec<ThreadConflict>) {
        for c in conflicts {
            self.conflicts.entry(c.conflict_id).or_insert(c);
        }
    }

    fn conflict_view(&self, c: &ThreadConflict) -> ConflictView {
        let run = self.runs.get(&c.run_id).map(|v| &v.run);
        let runner = run.map(|r| r.runner_id.clone());
        let canonical_agents = c
            .involved
            .runs
            .iter()
            .filter(|id| **id != c.run_id)
            .filter_map(|id| self.runs.get(id).map(|v| v.run.agent.clone()))
            .collect();
        ConflictView {
            proposed: (!c.binary).then(|| {
                merge::proposal(
                    c.base.as_deref().unwrap_or(""),
                    c.canonical.as_deref().unwrap_or(""),
                    c.run.as_deref().unwrap_or(""),
                )
            }),
            canonical_by: c
                .involved
                .people
                .iter()
                .filter(|p| Some(*p) != runner.as_ref())
                .cloned()
                .collect(),
            canonical_agents,
            run_by: runner,
            run_agent: run.map(|r| r.agent.clone()),
            conflict: c.clone(),
        }
    }

    /// Resolve an open Conflict on every replica: the chosen text replaces
    /// canonical state's version of the hunk, through the same
    /// compare-and-set a merge uses — recomputed if a merge got there first.
    /// Answers the Thread Version the resolution recorded.
    pub async fn resolve_conflict(
        &mut self,
        conflict_id: u64,
        choice: Resolve,
    ) -> Result<u64, SessionError> {
        for _ in 0..MERGE_ATTEMPTS {
            self.drain_ready().await?;
            let conflict = self
                .conflicts
                .get(&conflict_id)
                .filter(|c| c.is_open())
                .cloned()
                .ok_or_else(|| SessionError::Refused {
                    code: "conflict_unknown".into(),
                    message: format!("Conflict {conflict_id} is not open"),
                })?;
            let file_id = conflict.file_id;
            let side = choice.side();
            let (update, content, resolution) = if conflict.binary {
                self.binary_resolution(&conflict, &choice).await?
            } else {
                self.text_resolution(&conflict, &choice)?
            };
            let base_version = self.merge_version(file_id);
            // A binary file's content hash is the chosen blob's own name.
            let blob = if conflict.binary {
                resolution.clone()
            } else {
                bootstrap::sha256_hex(&content)
            };
            let client_seq = self.take_client_seq();
            let frame = ClientControl::ConflictResolve {
                client_seq,
                conflict_id,
                base_version,
                update: base64::engine::general_purpose::STANDARD.encode(&update),
                blob: blob.clone(),
                resolution,
                side,
            };
            match self.ask(client_seq, &frame).await? {
                Answer::Resolved {
                    version,
                    file_version,
                } => {
                    if !conflict.binary {
                        let local = self.replica.apply_remote(file_id, &update)?;
                        self.send_updates(file_id, local).await?;
                        // The resolution's Thread Version holds the file's
                        // content now; best effort, like a merge's.
                        if let Err(e) = self.store.put_blob(blob, content).await {
                            tracing::warn!(target: "atlas_thread_sync", "resolution blob upload failed: {e}");
                        }
                    }
                    self.versions
                        .insert(file_version.file_id, file_version.version);
                    self.head = self.head.max(version);
                    if let Some(c) = self.conflicts.get_mut(&conflict_id) {
                        c.status = wire::ConflictStatus::Resolved;
                    }
                    return Ok(version);
                }
                Answer::ResolveRejected { version } => {
                    self.versions.insert(file_id, version);
                }
                Answer::Nack { code, message } => {
                    return Err(SessionError::Refused { code, message })
                }
                other => return Err(unexpected(&other)),
            }
        }
        Err(SessionError::MergeStarved(MERGE_ATTEMPTS))
    }

    /// The update that turns canonical's hunk into the chosen text, the
    /// file's content afterwards, and the resolution's text.
    fn text_resolution(
        &self,
        conflict: &ThreadConflict,
        choice: &Resolve,
    ) -> Result<(Vec<u8>, Vec<u8>, String), SessionError> {
        let file_id = conflict.file_id;
        let canonical = conflict.canonical.clone().unwrap_or_default();
        let run = conflict.run.clone().unwrap_or_default();
        let text = match choice {
            Resolve::Canonical => canonical.clone(),
            Resolve::Run => run,
            Resolve::Both => merge::join_hunks(&canonical, &run),
            Resolve::Edited(t) | Resolve::Agent(t) => t.clone(),
        };
        let snapshot = self
            .replica
            .snapshot(file_id)
            .ok_or(ReplicaError::UnknownFile(file_id))?;
        let doc = crate::doc::FileDoc::from_snapshot(crate::doc::random_client_id(), &snapshot)
            .map_err(ReplicaError::Doc)?;
        let current = doc.content();
        if matches!(choice, Resolve::Canonical) || text == canonical {
            return Ok((
                crate::doc::FileDoc::empty_update(),
                current.into_bytes(),
                text,
            ));
        }
        let near = conflict.lines.map_or(0, |l| l.start as usize);
        let range = merge::locate(&current, &canonical, near)
            .ok_or_else(|| SessionError::ConflictMoved(conflict.path.clone()))?;
        let hunk = merge::Hunk {
            old: range,
            new: 0..merge::lines(&text).len(),
        };
        let update = doc
            .replace_lines(&current, &[hunk], &text)
            .unwrap_or_else(crate::doc::FileDoc::empty_update);
        Ok((update, doc.content().into_bytes(), text))
    }

    /// A binary Conflict is resolved by making the chosen blob canonical
    /// (`blob.set`) and then closing it with an empty update.
    async fn binary_resolution(
        &mut self,
        conflict: &ThreadConflict,
        choice: &Resolve,
    ) -> Result<(Vec<u8>, Vec<u8>, String), SessionError> {
        let chosen = match choice {
            Resolve::Canonical => conflict.canonical.clone(),
            Resolve::Run => conflict.run.clone(),
            _ => {
                return Err(SessionError::Refused {
                    code: "bad_choice".into(),
                    message: "a binary file's Conflict takes one side or the other".into(),
                })
            }
        };
        let Some(sha) = chosen else {
            return Err(SessionError::Refused {
                code: "bad_choice".into(),
                message: "that side has no content to keep".into(),
            });
        };
        if self.replica.blob(conflict.file_id) != Some(sha.as_str()) {
            let client_seq = self.take_client_seq();
            let set = ClientControl::BlobSet {
                client_seq,
                file_id: conflict.file_id,
                blob: sha.clone(),
            };
            self.expect_ack(client_seq, &set).await?;
            self.replica.set_blob(conflict.file_id, &sha)?;
            if self.replica.is_materialized() {
                self.fetch_blob(conflict.file_id, sha.clone()).await?;
            }
        }
        // The content hash is the blob's own.
        Ok((crate::doc::FileDoc::empty_update(), Vec::new(), sha))
    }

    // -----------------------------------------------------------------------
    // Presence, the Atlas editor and sync state (ATL-407)
    // -----------------------------------------------------------------------

    /// Remote Runs here, as this replica knows them (ATL-417).
    pub fn remote(&self) -> RemoteView {
        let mut requests: Vec<RemoteRun> = self.remote_requests.values().cloned().collect();
        requests.sort_by(|a, b| {
            b.requested_at
                .cmp(&a.requested_at)
                .then_with(|| b.request_id.cmp(&a.request_id))
        });
        RemoteView {
            user_id: self.user_id.clone(),
            agents: self.remote_agents.clone(),
            accept: self.remote_accept,
            auto_approve: self.remote_auto.clone(),
            requests,
        }
    }

    /// One Remote Run request this replica has heard of.
    pub fn remote_request(&self, request_id: &str) -> Option<&RemoteRun> {
        self.remote_requests.get(request_id)
    }

    fn note_remote(&mut self, request: RemoteRun) {
        self.remote_requests
            .insert(request.request_id.clone(), request.clone());
        // Keep every open request, and the newest of the rest.
        let mut over: Vec<(u64, String)> = self
            .remote_requests
            .values()
            .filter(|r| !r.status.is_open())
            .map(|r| (r.requested_at, r.request_id.clone()))
            .collect();
        if over.len() > REMOTE_KEPT {
            over.sort();
            for (_, id) in &over[..over.len() - REMOTE_KEPT] {
                self.remote_requests.remove(id);
            }
        }
        if let Some(events) = &self.events {
            let _ = events.send(ThreadEvent::RemoteRun(request));
        }
    }

    /// Is `request_id` an approved Remote Run this person is to run? What a
    /// Run executing it must be.
    fn runnable_remote(&self, request_id: &str) -> Result<&RemoteRun, SessionError> {
        let request = self
            .remote_requests
            .get(request_id)
            .filter(|r| Some(r.runner_id.as_str()) == self.user_id.as_deref())
            .ok_or_else(|| SessionError::Refused {
                code: "remote_run_unknown".into(),
                message: "no Remote Run of yours by that id".into(),
            })?;
        if request.status != RemoteRunStatus::Approved {
            return Err(SessionError::Refused {
                code: "remote_run_unknown".into(),
                message: "that Remote Run is not approved".into(),
            });
        }
        Ok(request)
    }

    /// Change this Runner's own Remote Run choices here (ATL-417): accept
    /// Remote Runs or not, and whose requests to approve without asking —
    /// `Some(None)` clears that. `None` keeps what is there.
    pub async fn set_remote_settings(
        &mut self,
        accept: Option<bool>,
        auto_approve: Option<Option<String>>,
    ) -> Result<(), SessionError> {
        if self.remote_agents.is_empty() {
            return Err(SessionError::Refused {
                code: "remote_run_unsupported".into(),
                message: "this desktop does not run Remote Runs".into(),
            });
        }
        let client_seq = self.take_client_seq();
        let frame = ClientControl::RemoteSettings {
            client_seq,
            accept,
            auto_approve: auto_approve.clone(),
        };
        match self.ask(client_seq, &frame).await? {
            Answer::Ack => {}
            Answer::Nack { code, message } => return Err(SessionError::Refused { code, message }),
            other => return Err(unexpected(&other)),
        }
        // The server's `remote.settings` follows the ack; until it does, what
        // was asked is what is.
        if let Some(accept) = accept {
            self.remote_accept = accept;
        }
        if let Some(auto) = auto_approve {
            self.remote_auto = auto;
        }
        Ok(())
    }

    /// Approve or decline a Remote Run this person was asked to run. The
    /// server answers whatever the request is now — a request that timed out
    /// meanwhile stays timed out — and says so on `remote.run`.
    pub async fn answer_remote_run(
        &mut self,
        request_id: &str,
        approve: bool,
    ) -> Result<RemoteRunStatus, SessionError> {
        let client_seq = self.take_client_seq();
        let frame = ClientControl::RemoteAnswer {
            client_seq,
            request_id: request_id.to_string(),
            approve,
        };
        match self.ask(client_seq, &frame).await? {
            Answer::Ack => {}
            Answer::Nack { code, message } => return Err(SessionError::Refused { code, message }),
            other => return Err(unexpected(&other)),
        }
        // The `remote.run` saying where it stands came before the ack.
        Ok(self
            .remote_requests
            .get(request_id)
            .map_or(RemoteRunStatus::Declined, |r| r.status))
    }

    /// Everybody else here now, with paths for the files they point at.
    pub fn peers(&self) -> Vec<PeerView> {
        self.peers.values().map(|p| self.peer_view(p)).collect()
    }

    fn peer_view(&self, p: &Peer) -> PeerView {
        let state = p.state.clone().unwrap_or_default();
        PeerView {
            peer_id: p.peer_id.clone(),
            user_id: p.user_id.clone(),
            role: p.role,
            surface: p.surface.clone(),
            typing: state.typing.and_then(|id| self.replica.path_of(id)),
            cursors: state
                .cursors
                .iter()
                .map(|c| PeerCursor {
                    file_id: c.file_id,
                    path: self.replica.path_of(c.file_id),
                    anchor: c.anchor,
                    head: c.head,
                })
                .collect(),
            runs: state
                .runs
                .iter()
                .map(|r| PeerRun {
                    run_id: r.run_id.clone(),
                    path: r.file_id.and_then(|id| self.replica.path_of(id)),
                })
                .collect(),
            sync: state.sync,
        }
    }

    fn tell_presence(&self) {
        if let Some(events) = &self.events {
            let _ = events.send(ThreadEvent::Presence(self.peers()));
        }
    }

    /// How far this replica is from the thread, as it says of itself:
    /// `behind` while offline, `syncing` while its own changes are not all
    /// acknowledged (or saves made offline wait to go), `current` otherwise.
    pub fn sync_state(&self) -> SyncState {
        if !self.is_connected() {
            SyncState::Behind
        } else if !self.unacked.is_empty()
            || !self.offline.is_empty()
            || !self.pending_snapshots.is_empty()
        {
            SyncState::Syncing
        } else {
            SyncState::Current
        }
    }

    /// The person's selections in one file of the Atlas editor (at most
    /// eight are kept across files); an empty list clears that file's.
    pub fn set_cursors(&mut self, file_id: u64, cursors: Vec<(u64, u64)>) {
        self.awareness.cursors.retain(|c| c.file_id != file_id);
        let room = 8usize.saturating_sub(self.awareness.cursors.len());
        self.awareness
            .cursors
            .extend(cursors.into_iter().take(room).map(|(anchor, head)| Cursor {
                file_id,
                anchor,
                head,
            }));
    }

    /// The file the person is typing in, or `None` once they stop.
    pub fn set_typing(&mut self, file_id: Option<u64>) {
        self.awareness.typing = file_id;
    }

    /// The file one of this replica's Runs is touching now, by its path in
    /// the Run worktree; `None` between files. A Run that ends drops out.
    pub fn set_run_file(&mut self, run_id: &str, path: Option<&str>) {
        let file_id = path.and_then(|p| self.replica.file_id(p));
        let runs = &mut self.awareness.runs;
        match runs.iter().position(|r| r.run_id == run_id) {
            Some(i) => runs[i].file_id = file_id,
            None if runs.len() < 8 => runs.push(RunAt {
                run_id: run_id.to_string(),
                file_id,
            }),
            None => {}
        }
    }

    /// Say what changed about this replica since it last said anything —
    /// its sync state included. Never acked, so nothing waits on it.
    pub async fn flush_awareness(&mut self) -> Result<(), SessionError> {
        if !self.is_connected() {
            return Ok(());
        }
        let running: HashSet<String> = self
            .runs
            .values()
            .filter(|v| v.run.status == "running")
            .map(|v| v.run.run_id.clone())
            .collect();
        self.awareness.runs.retain(|r| running.contains(&r.run_id));
        let mut state = self.awareness.clone();
        state.sync = Some(self.sync_state());
        if self.said.as_ref() == Some(&state) {
            return Ok(());
        }
        let client_seq = self.take_client_seq();
        self.send_control(&ClientControl::Awareness {
            client_seq,
            state: state.clone(),
        })
        .await?;
        self.said = Some(state);
        Ok(())
    }

    /// Open `path` in the Atlas editor: its document as it is now. Changes
    /// from anywhere then arrive as [`ThreadEvent::DocUpdate`]. `None` for a
    /// path the thread does not hold as text.
    pub fn open_doc(&mut self, path: &str) -> Option<OpenedDoc> {
        let file_id = self.replica.file_id(path)?;
        let (state, vector) = self.replica.doc_state(file_id)?;
        self.open_docs.insert(file_id, vector);
        Some(OpenedDoc { file_id, state })
    }

    pub fn close_doc(&mut self, file_id: u64) {
        self.open_docs.remove(&file_id);
        self.awareness.cursors.retain(|c| c.file_id != file_id);
        if self.awareness.typing == Some(file_id) {
            self.awareness.typing = None;
        }
    }

    /// Keystrokes from the Atlas editor, batched into one Yjs update: applied
    /// to the replica, written to disk, and sent. An error says why they may
    /// not sync — the editor then saves to disk instead, and the usual rules
    /// for a save take over.
    pub async fn editor_update(
        &mut self,
        file_id: u64,
        update: Vec<u8>,
    ) -> Result<(), SessionError> {
        if let Some(why) = self.read_only() {
            return Err(SessionError::ReadOnly(why));
        }
        if update.len() > wire::MAX_PAYLOAD_BYTES {
            return Err(SessionError::Refused {
                code: "payload_too_large".into(),
                message: "that edit is too large to send as keystrokes".into(),
            });
        }
        match self.replica.apply_editor(file_id, &update)? {
            EditorEdit::Refused { why, pending } => {
                self.send_updates(file_id, pending).await?;
                Err(SessionError::ReadOnly(why))
            }
            EditorEdit::Applied(pending) => {
                self.send_updates(file_id, pending).await?;
                self.send_updates(file_id, vec![update]).await
            }
        }
    }

    /// What each file open in the Atlas editor gained since it was last sent
    /// anything, as events. Called after every message and command.
    pub fn flush_docs(&mut self) {
        let Some(events) = &self.events else {
            return;
        };
        for (file_id, vector) in self.open_docs.iter_mut() {
            if let Some((update, now)) = self.replica.doc_diff(*file_id, vector) {
                *vector = now;
                let _ = events.send(ThreadEvent::DocUpdate {
                    file_id: *file_id,
                    update,
                });
            }
        }
    }

    // -----------------------------------------------------------------------
    // Apply (ATL-408)
    // -----------------------------------------------------------------------

    /// Write the thread's changes since the Base into `checkout` — the
    /// person's own repository — as uncommitted changes, three-way onto
    /// whatever commit it is at. Refused while Conflicts are open, and when
    /// uncommitted edits touch the same files unless `stash` says to stash
    /// those first. Never commits, never touches a remote, never closes the
    /// thread; any participant may Apply any number of times.
    pub async fn apply_to(
        &mut self,
        checkout: &Path,
        stash: bool,
    ) -> Result<ApplyOutcome, SessionError> {
        self.drain_ready().await?;
        let open = self.open_conflicts();
        if open > 0 {
            return Ok(ApplyOutcome::ConflictsOpen { count: open });
        }
        let base = self.replica.base().to_string();
        let mut changes = Vec::new();
        for f in self.replica.thread_files() {
            let origin = (f.origin != f.path).then(|| f.origin.clone());
            let content = if f.deleted {
                None
            } else if let Some(text) = f.text {
                Some(text.into_bytes())
            } else {
                match f.blob {
                    Some(sha) => {
                        // Written into the person's own checkout: only bytes
                        // that are the blob the thread names.
                        let bytes = self.store.get_blob(sha.clone()).await?;
                        if bootstrap::sha256_hex(&bytes) != sha {
                            return Err(SessionError::Refused {
                                code: "digest_mismatch".into(),
                                message: format!("{} did not download intact; try again", f.path),
                            });
                        }
                        Some(bytes)
                    }
                    // Still its Base content: only a move changes anything.
                    None if origin.is_none() => continue,
                    None => git::blob_at(checkout, &base, &f.origin).map_err(ApplyError::from)?,
                }
            };
            changes.push(ThreadChange {
                path: f.path,
                origin,
                content,
            });
        }
        let message = "atlas: your edits, set aside to apply a Shared Thread";
        // git and the file system: off the async runtime (ARCHITECTURE.md).
        let target = checkout.to_path_buf();
        let applied = tokio::task::spawn_blocking(move || {
            applying::apply(&target, &base, &changes, stash.then_some(message))
        })
        .await
        .map_err(|e| SessionError::Refused {
            code: "apply_failed".into(),
            message: e.to_string(),
        })?;
        match applied {
            Ok(applied) => Ok(ApplyOutcome::Applied(applied)),
            Err(ApplyError::Dirty(files)) => Ok(ApplyOutcome::Dirty { files }),
            Err(e) => Err(e.into()),
        }
    }

    /// Resolve a Conflict with what an agent wrote in a Run of its own: the
    /// Run's text for the hunk's lines becomes the resolution, and the Run
    /// ends without merging anything else.
    pub async fn resolve_with_run(
        &mut self,
        run: &ActiveRun,
        worktree: &RunWorktree,
        conflict_id: u64,
    ) -> Result<u64, SessionError> {
        let conflict = self.conflicts.get(&conflict_id).cloned();
        let text = match conflict.as_ref().filter(|c| !c.binary) {
            Some(c) => {
                let fork = run.fork.files.get(&c.file_id).map(|f| f.content.clone());
                let after = crate::path::resolve(worktree.root(), &c.path)
                    .ok()
                    .and_then(|p| std::fs::read_to_string(p).ok());
                match (fork, after) {
                    (Some(fork), Some(after)) => {
                        let near = c.lines.map_or(0, |l| l.start as usize);
                        merge::locate(&fork, c.canonical.as_deref().unwrap_or(""), near)
                            .map(|region| merge::region_after(&fork, &after, region))
                    }
                    _ => None,
                }
            }
            None => None,
        };
        self.end_run(&run.run_id, RunOutcome::Completed).await?;
        let text = text.ok_or_else(|| SessionError::Refused {
            code: "conflict_unknown".into(),
            message: format!("Conflict {conflict_id} could not be read back from the agent's work"),
        })?;
        self.resolve_conflict(conflict_id, Resolve::Agent(text))
            .await
    }

    /// The Run will not finish (the agent failed or was cancelled): mark it
    /// interrupted, merging nothing.
    pub async fn interrupt_run(&mut self, run_id: &str) -> Result<(), SessionError> {
        self.end_run(run_id, RunOutcome::Interrupted).await
    }

    async fn end_run(&mut self, run_id: &str, outcome: RunOutcome) -> Result<(), SessionError> {
        let client_seq = self.take_client_seq();
        let end = ClientControl::RunEnd {
            client_seq,
            run_id: run_id.to_string(),
            outcome,
        };
        // Its badge goes with it (ATL-407).
        self.awareness.runs.retain(|r| r.run_id != run_id);
        match self.ask(client_seq, &end).await? {
            Answer::Ack => Ok(()),
            Answer::Nack { code, message } => Err(SessionError::Refused { code, message }),
            other => Err(unexpected(&other)),
        }
    }

    /// Send a control frame and handle whatever arrives until it is answered.
    async fn ask(
        &mut self,
        client_seq: u64,
        frame: &ClientControl,
    ) -> Result<Answer, SessionError> {
        self.awaiting.insert(client_seq);
        if let Err(e) = self.send_control(frame).await {
            self.awaiting.remove(&client_seq);
            return Err(e);
        }
        let answer = loop {
            if let Some(answer) = self.answers.remove(&client_seq) {
                break Ok(answer);
            }
            if let Err(e) = self.receive_one().await {
                break Err(e);
            }
        };
        self.awaiting.remove(&client_seq);
        answer
    }

    /// Handle every message that has already arrived, without waiting for more.
    async fn drain_ready(&mut self) -> Result<(), SessionError> {
        while let Ok(next) = tokio::time::timeout(Duration::ZERO, self.transport.recv()).await {
            let message = next.ok_or(SessionError::ClosedEarly)?;
            self.handle(message).await?;
        }
        Ok(())
    }

    async fn receive_one(&mut self) -> Result<(), SessionError> {
        let message = tokio::time::timeout(ANSWER_TIMEOUT, self.transport.recv())
            .await
            .map_err(|_| SessionError::Timeout)?
            .ok_or(SessionError::ClosedEarly)?;
        self.handle(message).await.map(|_| ())
    }

    fn answer(&mut self, client_seq: u64, answer: Answer) {
        if self.awaiting.contains(&client_seq) {
            self.answers.insert(client_seq, answer);
        }
    }

    fn note_transcript(&mut self, run_no: u64, payload: &[u8]) {
        self.transcripts.entry(run_no).or_default().fold(payload);
        while self.transcripts.len() > RUNS_KEPT {
            self.transcripts.pop_first();
        }
    }

    /// What a Run's context digest is built from (ATL-411): the Runs in
    /// `scope`, oldest first, with whatever this replica heard them say; the
    /// files the thread changed against its Base; and the open Conflicts. The
    /// caller adds the thread's goal and its unresolved comments, which this
    /// session does not hold.
    pub fn digest_input(&self, goal: &str, scope: DigestScope) -> DigestInput {
        // A Run that started before this session's last one but ended after
        // it forked is work that Run never saw.
        let forked_at = match scope {
            DigestScope::Since(Some(last)) => self
                .runs
                .values()
                .find(|v| v.run.run_no == last)
                .map(|v| v.run.started_at),
            _ => None,
        };
        let mut runs: Vec<&RunView> = self
            .runs
            .values()
            .filter(|v| match scope {
                DigestScope::Since(None) => true,
                DigestScope::Since(Some(last)) => {
                    v.run.run_no > last
                        || (v.run.run_no != last
                            && forked_at.is_some_and(|at| v.run.ended_at.is_some_and(|e| e > at)))
                }
                DigestScope::UpTo(anchor) => v.run.run_no <= anchor,
            })
            .filter(|v| v.run.status != "declined")
            .collect();
        runs.sort_by_key(|v| v.run.run_no);
        let runs = runs
            .into_iter()
            .map(|v| DigestRun {
                run_no: v.run.run_no,
                runner_id: v.run.runner_id.clone(),
                prompted_by: v.run.prompted_by.clone(),
                agent: v.run.agent.clone(),
                model: v.run.model.clone(),
                status: v.run.status.clone(),
                transcript: self.transcripts.get(&v.run.run_no).cloned(),
                files: v.files.clone(),
            })
            .collect();

        let mut files = Vec::new();
        for f in self.replica.thread_files() {
            let base = self.replica.base_bytes(&f.origin).ok().flatten();
            let change = if f.deleted {
                base.is_some().then_some(FileChange::Deleted)
            } else {
                match f.kind {
                    FileKind::Binary => {
                        (f.blob.is_some() || base.is_none()).then_some(FileChange::Binary)
                    }
                    FileKind::Text => {
                        let before = base
                            .map(|b| String::from_utf8_lossy(&b).into_owned())
                            .unwrap_or_default();
                        let after = f.text.unwrap_or_default();
                        (before != after || f.path != f.origin).then(|| {
                            let (added, removed) = line_stats(&before, &after);
                            FileChange::Lines { added, removed }
                        })
                    }
                }
            };
            if let Some(change) = change {
                files.push(DigestFile {
                    path: f.path,
                    change,
                });
            }
        }

        let conflicts = self
            .conflicts
            .values()
            .filter(|c| c.is_open())
            .map(|c| DigestConflict {
                path: c.path.clone(),
                lines: c.lines.map(|l| (l.start + 1, l.end.max(l.start + 1))),
                people: c.involved.people.clone(),
            })
            .collect();

        DigestInput {
            goal: goal.to_string(),
            scope,
            runs,
            files,
            conflicts,
            comments: Vec::new(),
        }
    }

    fn note_run(&mut self, run: ThreadRun) {
        match self.runs.get_mut(&run.run_id) {
            Some(view) => view.run = run,
            None => {
                self.runs.insert(
                    run.run_id.clone(),
                    RunView {
                        run,
                        files: Vec::new(),
                        current_file: None,
                    },
                );
            }
        }
        while self.runs.len() > RUNS_KEPT {
            let oldest = self
                .runs
                .iter()
                .min_by_key(|(_, v)| v.run.run_no)
                .map(|(k, _)| k.clone());
            match oldest {
                Some(k) => self.runs.remove(&k),
                None => break,
            };
        }
    }

    /// Check the worktree out (lazily, once) and write the canonical state on
    /// it — binary files fetched from the thread. Called when the person first
    /// opens a file or prompts.
    pub async fn materialize(&mut self) -> Result<PathBuf, SessionError> {
        let root = self.replica.materialize()?.to_path_buf();
        for (file_id, sha) in self.replica.blobs_to_fetch() {
            self.fetch_blob(file_id, sha).await?;
        }
        Ok(root)
    }

    /// Fetch a binary file's canonical blob and write it.
    async fn fetch_blob(&mut self, file_id: u64, sha: String) -> Result<(), SessionError> {
        let bytes = self.store.get_blob(sha).await?;
        Ok(self.replica.write_blob(file_id, &bytes)?)
    }

    /// Receive and apply whatever arrives, until nothing has for `idle`.
    pub async fn pump(&mut self, idle: Duration) -> Result<usize, SessionError> {
        let mut handled = 0;
        while let Ok(next) = tokio::time::timeout(idle, self.transport.recv()).await {
            let Some(message) = next else {
                return Err(SessionError::ClosedEarly);
            };
            self.handle(message).await?;
            handled += 1;
        }
        Ok(handled)
    }

    /// Apply one message from the server.
    pub async fn receive(&mut self, message: Message) -> Result<(), SessionError> {
        self.handle(message).await.map(|_| ())
    }

    /// The next message from the server, for a caller running its own loop.
    pub async fn next_message(&mut self) -> Option<Message> {
        self.transport.recv().await
    }

    /// The person saved `rel` in the replica worktree, from any editor.
    /// Answers what it amounted to; an [`LocalChange::Echo`] sent nothing.
    pub async fn file_saved(&mut self, rel: &str) -> Result<LocalChange, SessionError> {
        if self.read_only().is_some() {
            // Kept on this machine, and said so: an edited file is held (its
            // next save once the thread takes changes merges it); a new one
            // waits to be introduced.
            if self.replica.is_materialized() {
                match self.replica.local_change(rel)? {
                    LocalChange::NewFile { path } => {
                        if !self.ignores(&path)? {
                            self.unsent_new.insert(path);
                        }
                    }
                    // Settled — sent as a deletion — once it may be.
                    LocalChange::Missing { file_id } if !self.missing.contains(&file_id) => {
                        self.missing.push(file_id);
                    }
                    _ => {}
                }
            }
            return Ok(LocalChange::Ignored);
        }
        // Disk is the buffer: the save is read when the socket is back.
        if !self.connected {
            self.offline.insert(rel.to_string());
            return Ok(LocalChange::Buffered);
        }
        match self.save(rel).await {
            // The socket went while this was on its way: whatever was sent
            // and not acknowledged is resent, and the save is read again,
            // once it is back.
            Err(SessionError::Transport(_) | SessionError::ClosedEarly) => {
                self.connected = false;
                self.offline.insert(rel.to_string());
                Ok(LocalChange::Buffered)
            }
            other => other,
        }
    }

    async fn save(&mut self, rel: &str) -> Result<LocalChange, SessionError> {
        match self.replica.local_change(rel)? {
            LocalChange::Update { file_id, updates } => {
                self.send_updates(file_id, updates).await?;
                Ok(LocalChange::Update {
                    file_id,
                    updates: Vec::new(),
                })
            }
            LocalChange::Blob {
                file_id,
                sha256,
                bytes,
            } => {
                // A binary file is judged by its name, at every save: one moved
                // to a credential's name (`cert.p12`) stays home.
                if let Some(reason) = secret_reason(rel, "") {
                    tracing::info!(target: "atlas_thread_sync", ?reason, "holding a binary file that looks secret");
                    return Ok(LocalChange::Ignored);
                }
                self.set_blob(file_id, &sha256, bytes).await?;
                Ok(LocalChange::Blob {
                    file_id,
                    sha256,
                    bytes: Vec::new(),
                })
            }
            LocalChange::Missing { file_id } => {
                // Deleted, or moved: which is known once the new path is seen
                // (or is not, by the time removals are settled).
                if !self.missing.contains(&file_id) {
                    self.missing.push(file_id);
                }
                Ok(LocalChange::Missing { file_id })
            }
            LocalChange::Renamed { file_id, from, to } => {
                // Moved somewhere that does not sync — ignored, or a name that
                // holds credentials (`.env`): the thread sees a deletion, and
                // the file stays on this machine.
                let secret = match self.replica.kind(file_id) {
                    Some(FileKind::Text) => {
                        let content =
                            String::from_utf8_lossy(&self.replica.read_bytes(&to)?).into_owned();
                        secret_reason(&to, &content).is_some()
                    }
                    _ => secret_reason(&to, "").is_some(),
                };
                if secret || self.ignores(&to)? {
                    if !self.missing.contains(&file_id) {
                        self.missing.push(file_id);
                    }
                    return Ok(LocalChange::Ignored);
                }
                let client_seq = self.take_client_seq();
                let rename = ClientControl::TreeRename {
                    client_seq,
                    file_id,
                    path: to.clone(),
                };
                self.expect_ack(client_seq, &rename).await?;
                self.replica.rename(file_id, &to)?;
                self.missing.retain(|id| *id != file_id);
                Ok(LocalChange::Renamed { file_id, from, to })
            }
            LocalChange::NewFile { path } => {
                // Build output, dependencies and whatever `.atlas/shareignore`
                // names never sync, wherever they are written.
                if self.ignores(&path)? {
                    return Ok(LocalChange::Ignored);
                }
                let bytes = self.replica.read_bytes(&path)?;
                let kind = kind_of(&bytes);
                // A credential created in the replica stays on this machine,
                // for the same reason it is held back at share time. Binary
                // content is judged by its name.
                let content = match kind {
                    FileKind::Text => String::from_utf8_lossy(&bytes).into_owned(),
                    FileKind::Binary => String::new(),
                };
                if let Some(reason) = secret_reason(&path, &content) {
                    tracing::info!(target: "atlas_thread_sync", ?reason, "holding back a new file that looks secret");
                    return Ok(LocalChange::Ignored);
                }
                let file_id = self.ensure_file(&path, true, kind).await?;
                match kind {
                    FileKind::Text => {
                        if let LocalChange::Update { updates, .. } =
                            self.replica.local_change(&path)?
                        {
                            self.send_updates(file_id, updates).await?;
                        }
                    }
                    FileKind::Binary => {
                        let sha = bootstrap::sha256_hex(&bytes);
                        self.replica.saw_bytes(file_id, &bytes);
                        self.set_blob(file_id, &sha, bytes).await?;
                    }
                }
                Ok(LocalChange::NewFile { path })
            }
            other => Ok(other),
        }
    }

    /// Files that went missing and did not turn up elsewhere are deleted in
    /// the thread. The app's loop calls this once saves have been quiet for a
    /// moment, so a move — reported as a removal and a creation, in either
    /// order — is seen as the rename it is.
    pub async fn settle_removals(&mut self) -> Result<Vec<String>, SessionError> {
        // Kept until this replica may change the thread again.
        if self.read_only().is_some() {
            return Ok(Vec::new());
        }
        let mut deleted = Vec::new();
        for file_id in std::mem::take(&mut self.missing) {
            if !self.replica.is_missing(file_id) {
                continue;
            }
            let path = self
                .replica
                .files()
                .find(|(id, _)| *id == file_id)
                .map(|(_, p)| p.to_string());
            let client_seq = self.take_client_seq();
            self.expect_ack(
                client_seq,
                &ClientControl::TreeDelete {
                    client_seq,
                    file_id,
                },
            )
            .await?;
            self.replica.delete(file_id)?;
            deleted.extend(path);
        }
        Ok(deleted)
    }

    /// Are removals waiting to be settled?
    pub fn removals_pending(&self) -> bool {
        !self.missing.is_empty()
    }

    /// Upload a binary file's bytes and make them canonical (ATL-403).
    async fn set_blob(
        &mut self,
        file_id: u64,
        sha: &str,
        bytes: Vec<u8>,
    ) -> Result<(), SessionError> {
        self.store.put_blob(sha.to_string(), bytes).await?;
        let client_seq = self.take_client_seq();
        let set = ClientControl::BlobSet {
            client_seq,
            file_id,
            blob: sha.to_string(),
        };
        self.expect_ack(client_seq, &set).await?;
        Ok(self.replica.set_blob(file_id, sha)?)
    }

    /// Send a frame the server answers with a plain ack.
    async fn expect_ack(
        &mut self,
        client_seq: u64,
        frame: &ClientControl,
    ) -> Result<(), SessionError> {
        match self.ask(client_seq, frame).await? {
            Answer::Ack => Ok(()),
            Answer::Nack { code, message } => Err(SessionError::Refused { code, message }),
            other => Err(unexpected(&other)),
        }
    }

    /// Make the sharer's uncommitted work the thread's first canonical changes:
    /// exactly what [`share::preview`] lists for `checkout` — ignored and
    /// `.atlas/shareignore`d files never appear — except files that look like
    /// secrets, which are held back and reported unless named in `include`
    /// ("include anyway"). The person's checkout is only read.
    pub async fn share_working_changes(
        &mut self,
        checkout: &Path,
        include: &[String],
    ) -> Result<ShareReport, SessionError> {
        let preview = share::preview(checkout)?;
        self.included = include.iter().cloned().collect();
        let mut report = ShareReport::default();
        for held in preview.held(include) {
            if let Some(reason) = &held.blocked {
                report.blocked.push((held.path.clone(), reason.clone()));
            }
        }
        for file in preview.uploads(include) {
            if file.deleted {
                // Deleted since the Base: the thread holds it, deleted, so
                // every replica removes the Base's copy too.
                let Some(base) = self.replica.base_bytes(&file.path)? else {
                    continue;
                };
                let file_id = self.ensure_file(&file.path, true, kind_of(&base)).await?;
                let client_seq = self.take_client_seq();
                self.expect_ack(
                    client_seq,
                    &ClientControl::TreeDelete {
                        client_seq,
                        file_id,
                    },
                )
                .await?;
                self.replica.delete(file_id)?;
                report.shared.push(file.path.clone());
                continue;
            }
            let target = crate::path::resolve(checkout, &file.path).map_err(ReplicaError::from)?;
            let Ok(bytes) = std::fs::read(&target) else {
                continue;
            };
            match file.kind {
                ShareKind::Text => {
                    let content = String::from_utf8_lossy(&bytes);
                    let file_id = self.ensure_file(&file.path, true, FileKind::Text).await?;
                    let updates = self.replica.set_text(file_id, &content)?;
                    self.send_updates(file_id, updates).await?;
                }
                ShareKind::Binary => {
                    let file_id = self.ensure_file(&file.path, true, FileKind::Binary).await?;
                    let sha = bootstrap::sha256_hex(&bytes);
                    self.set_blob(file_id, &sha, bytes).await?;
                }
            }
            report.shared.push(file.path.clone());
        }
        Ok(report)
    }

    /// Does git, or the thread's `.atlas/shareignore`, ignore `path` in the
    /// replica worktree?
    fn ignores(&self, path: &str) -> Result<bool, SessionError> {
        let root = self.replica.root();
        let ignored = git::ignored(
            root,
            &[path.to_string()],
            Some(&root.join(share::SHAREIGNORE)),
        )
        .map_err(ReplicaError::from)?;
        Ok(ignored.contains(path))
    }

    /// Upload a file's Base content under the thread before its tree entry
    /// names it, so a reader without git can show the file's diff (ATL-402).
    /// `Some(None)` for a file the Base does not have; `None` when it could
    /// not be said — the upload failed, or this machine lacks the Base.
    async fn upload_base(&self, path: &str) -> Option<Option<String>> {
        if !self.replica.has_base() {
            return None;
        }
        match self.replica.base_bytes(path) {
            Ok(None) => Some(None),
            Ok(Some(bytes)) => {
                let sha = bootstrap::sha256_hex(&bytes);
                match self.store.put_blob(sha.clone(), bytes).await {
                    Ok(()) => Some(Some(sha)),
                    Err(e) => {
                        tracing::warn!(target: "atlas_thread_sync", %path, "Base blob upload failed: {e}");
                        None
                    }
                }
            }
            Err(e) => {
                tracing::warn!(target: "atlas_thread_sync", %path, "Base content unreadable: {e}");
                None
            }
        }
    }

    /// The file's id in this thread, asking the server for an entry if it has
    /// none. When `introduced`, this replica also publishes the file's Base
    /// seed: harmless if another replica already did, since seeds are
    /// byte-identical everywhere, and it lets a replica without the Base
    /// rebuild the file from the journal alone.
    async fn ensure_file(
        &mut self,
        path: &str,
        introduced: bool,
        kind: FileKind,
    ) -> Result<u64, SessionError> {
        if let Some(id) = self.replica.file_id(path) {
            return Ok(id);
        }
        // A file whose Base content looks like a secret — a key the person
        // has since removed, say — keeps that content home: no Base blob, no
        // seed on the wire. Unless they included the file anyway.
        let publish_base = introduced && !self.base_is_secret(path);
        let base_blob = if publish_base {
            self.upload_base(path).await
        } else {
            None
        };
        let client_seq = self.take_client_seq();
        self.pending_tree
            .insert(client_seq, (path.to_string(), kind));
        let ensure = ClientControl::TreeEnsure {
            client_seq,
            path: path.to_string(),
            kind,
            base_blob,
        };
        self.send_control(&ensure).await?;
        let file_id = loop {
            if let Some(id) = self.replica.file_id(path) {
                break id;
            }
            if !self.pending_tree.contains_key(&client_seq) {
                let (code, message) = self.last_nack.clone().unwrap_or_default();
                return Err(SessionError::Refused { code, message });
            }
            let message = tokio::time::timeout(ANSWER_TIMEOUT, self.transport.recv())
                .await
                .map_err(|_| SessionError::Timeout)?
                .ok_or(SessionError::ClosedEarly)?;
            self.handle(message).await?;
        };
        // A binary file's Base is its blob; only text is seeded.
        if publish_base && kind == FileKind::Text {
            for seed in self.replica.seed_for(path)? {
                self.send_update(file_id, seed).await?;
            }
        }
        Ok(file_id)
    }

    /// Does `path`'s Base content look like a secret the person has not
    /// chosen to share?
    fn base_is_secret(&self, path: &str) -> bool {
        if self.included.contains(path) {
            return false;
        }
        match self.replica.base_bytes(path) {
            Ok(Some(bytes)) => secret_reason(path, &String::from_utf8_lossy(&bytes)).is_some(),
            Ok(None) => false,
            // Unreadable: say nothing rather than guess.
            Err(_) => true,
        }
    }

    /// Send an edit's updates, in order.
    async fn send_updates(
        &mut self,
        file_id: u64,
        updates: Vec<Vec<u8>>,
    ) -> Result<(), SessionError> {
        for update in updates {
            self.send_update(file_id, update).await?;
        }
        Ok(())
    }

    async fn send_update(&mut self, file_id: u64, update: Vec<u8>) -> Result<(), SessionError> {
        if update.len() > wire::MAX_PAYLOAD_BYTES {
            // The server would refuse it. Edits are made in frame-sized pieces
            // (`FileDoc::set_content`), so only a pathological update — one
            // edit's deletions alone over the cap — gets here, and it is
            // reported rather than sent to be refused.
            return Err(SessionError::Refused {
                code: "payload_too_large".into(),
                message: format!("one edit of {} bytes is over the frame limit", update.len()),
            });
        }
        let client_seq = self.take_client_seq();
        let bytes =
            wire::encode(&Frame::update(file_id, client_seq, update)).expect("small numbers");
        // Kept until acknowledged: a drop before the ack means a resend, and
        // the server stores it once.
        self.unacked.insert(client_seq, bytes.clone());
        self.updates_sent += 1;
        if self.connected {
            if let Err(e) = self.transport.send(Message::Binary(bytes)).await {
                self.connected = false;
                return Err(e.into());
            }
        }
        Ok(())
    }

    fn is_our_bundle(&self, request_id: &str) -> bool {
        matches!(&self.bundle_request, Some((_, Some(id))) if id == request_id)
    }

    fn take_client_seq(&mut self) -> u64 {
        let seq = self.next_client_seq;
        self.next_client_seq += 1;
        seq
    }

    fn saw_seq(&mut self, seq: u64) {
        if seq > self.head + 1 {
            self.gaps += 1;
        }
        self.head = self.head.max(seq);
    }

    async fn handle(&mut self, message: Message) -> Result<Handled, SessionError> {
        match message {
            Message::Text(text) => {
                let Ok(frame) = serde_json::from_str::<ServerControl>(&text) else {
                    tracing::warn!(target: "atlas_thread_sync", "unreadable control frame");
                    return Ok(Handled::Other);
                };
                match frame {
                    ServerControl::Welcome {
                        role,
                        last_client_seq,
                        user_id,
                        ..
                    } => {
                        self.role = Some(role);
                        if user_id.is_some() {
                            self.user_id = user_id;
                        }
                        if role != Role::Viewer {
                            self.awaiting_approval = false;
                        }
                        self.refresh_read_only();
                        // Never reuse a client_seq the server already stored.
                        self.next_client_seq = self.next_client_seq.max(last_client_seq + 1);
                        // What it stored needs no resend.
                        self.unacked.retain(|seq, _| *seq > last_client_seq);
                    }
                    ServerControl::Tree { seq, entry } => {
                        self.saw_seq(seq);
                        if let Some(version) = entry.merge_version {
                            self.versions.insert(entry.file_id, version);
                        }
                        let fetch = self.replica.learn(&entry)?;
                        if let Some(sha) = fetch {
                            // A blob that cannot be fetched now is fetched at
                            // the next checkout; the change is not lost.
                            if let Err(e) = self.fetch_blob(entry.file_id, sha).await {
                                tracing::warn!(target: "atlas_thread_sync", path = %entry.path, "blob fetch failed: {e}");
                            }
                        }
                        // Behind a compaction, the file's history comes as a
                        // snapshot, before the tail that builds on it.
                        if self.pending_snapshots.remove(&entry.file_id) {
                            let bytes = self.store.get_snapshot(entry.file_id).await?;
                            let local = self.replica.apply_remote(entry.file_id, &bytes)?;
                            self.send_updates(entry.file_id, local).await?;
                        }
                        for aside in self.replica.take_set_aside() {
                            self.notice(format!(
                                "A teammate's change needed {}; your own file there is now {}.",
                                aside.path, aside.moved_to
                            ));
                        }
                    }
                    ServerControl::Ack {
                        client_seq,
                        seq,
                        file_id,
                    } => {
                        self.saw_seq(seq);
                        self.unacked.remove(&client_seq);
                        self.answer(client_seq, Answer::Ack);
                        if let (Some((path, kind)), Some(file_id)) =
                            (self.pending_tree.remove(&client_seq), file_id)
                        {
                            // A file this replica knew was deleted is revived.
                            if !self.replica.add_entry(file_id, &path, kind)? {
                                self.replica.revive(file_id, &path)?;
                            }
                        }
                    }
                    ServerControl::Nack {
                        client_seq,
                        code,
                        message,
                    } => {
                        tracing::warn!(target: "atlas_thread_sync", %code, "frame refused");
                        self.pending_tree.remove(&client_seq);
                        self.answer(
                            client_seq,
                            Answer::Nack {
                                code: code.clone(),
                                message: message.clone(),
                            },
                        );
                        self.last_nack = Some((code, message));
                    }
                    ServerControl::Synced { head } => {
                        self.head = self.head.max(head);
                        return Ok(Handled::Synced);
                    }
                    ServerControl::Error { code, message } => {
                        return Err(SessionError::Refused { code, message });
                    }
                    ServerControl::Run { run } => self.note_run(run),
                    ServerControl::MergeAccepted {
                        client_seq,
                        version,
                        files,
                        conflicts,
                        ..
                    } => self.answer(
                        client_seq,
                        Answer::Accepted {
                            version,
                            files,
                            conflicts: conflicts.into_iter().map(|c| c.conflict_id).collect(),
                        },
                    ),
                    ServerControl::PresenceSnapshot { peers } => {
                        self.peers = peers.into_iter().map(|p| (p.peer_id.clone(), p)).collect();
                        self.tell_presence();
                    }
                    ServerControl::Presence { peer } => {
                        self.peers.insert(peer.peer_id.clone(), peer);
                        self.tell_presence();
                    }
                    ServerControl::PresenceLeft { peer_id, .. } => {
                        if self.peers.remove(&peer_id).is_some() {
                            self.tell_presence();
                        }
                    }
                    ServerControl::ConflictRaised { conflict } => {
                        self.conflicts.insert(conflict.conflict_id, conflict);
                        while self.conflicts.len() > CONFLICTS_KEPT {
                            // Resolved ones go first; the oldest of them.
                            let drop = self
                                .conflicts
                                .iter()
                                .find(|(_, c)| !c.is_open())
                                .or_else(|| self.conflicts.iter().next())
                                .map(|(id, _)| *id);
                            match drop {
                                Some(id) => self.conflicts.remove(&id),
                                None => break,
                            };
                        }
                    }
                    ServerControl::ConflictResolved {
                        conflict,
                        file_version,
                    } => {
                        // The resolution's update arrived ahead of this.
                        self.versions
                            .insert(file_version.file_id, file_version.version);
                        self.conflicts.insert(conflict.conflict_id, conflict);
                        self.tell_versions();
                    }
                    ServerControl::ConflictAccepted {
                        client_seq,
                        version,
                        file_version,
                        ..
                    } => self.answer(
                        client_seq,
                        Answer::Resolved {
                            version,
                            file_version,
                        },
                    ),
                    ServerControl::ConflictRejected {
                        client_seq,
                        version,
                        ..
                    } => self.answer(client_seq, Answer::ResolveRejected { version }),
                    ServerControl::MergeRejected {
                        client_seq,
                        versions,
                        ..
                    } => self.answer(client_seq, Answer::Rejected { versions }),
                    ServerControl::Merged {
                        run_id,
                        version,
                        files,
                    } => {
                        // The merge's updates arrived ahead of this, in `seq`
                        // order; here is only where each file now stands.
                        self.head = self.head.max(version);
                        let mut paths = Vec::new();
                        for f in files {
                            self.versions.insert(f.file_id, f.version);
                            if let Some((_, path)) =
                                self.replica.files().find(|(id, _)| *id == f.file_id)
                            {
                                paths.push(path.to_string());
                            }
                        }
                        if let Some(view) = self.runs.get_mut(&run_id) {
                            view.files = paths;
                        }
                        self.tell_versions();
                    }
                    ServerControl::Restored { version, files, .. } => {
                        // A Restore to Version (ATL-419): its updates came
                        // ahead of this; here is where each file now stands.
                        self.head = self.head.max(version);
                        for f in files {
                            self.versions.insert(f.file_id, f.version);
                        }
                        self.tell_versions();
                    }
                    ServerControl::VersionAdded { .. } => self.tell_versions(),
                    ServerControl::RoleChanged { user_id, role } => {
                        if self.user_id.as_deref() == Some(user_id.as_str()) {
                            self.role = Some(role);
                            // The owner answered: approved (an editor's
                            // role), or declined (still a viewer).
                            self.awaiting_approval = false;
                            self.refresh_read_only();
                        }
                    }
                    ServerControl::Status { status, .. } => {
                        self.closed = status == ThreadStatus::Closed;
                        self.refresh_read_only();
                    }
                    ServerControl::RemoteRun { request } => self.note_remote(request),
                    ServerControl::RemoteSettings {
                        accept,
                        auto_approve,
                    } => {
                        self.remote_accept = accept;
                        self.remote_auto = auto_approve;
                    }
                    ServerControl::JoinRequested { user_id } => {
                        if let Some(events) = &self.events {
                            let _ = events.send(ThreadEvent::JoinRequested { user_id });
                        }
                    }
                    ServerControl::ResyncRequired { head, .. } => {
                        tracing::warn!(target: "atlas_thread_sync", head, "the thread is behind this replica; rebuilding");
                        return Ok(Handled::Resync);
                    }
                    ServerControl::Snapshot { through, files } => {
                        self.pending_snapshots
                            .extend(files.iter().map(|f| f.file_id));
                        self.head = self.head.max(through);
                    }
                    ServerControl::ChecksumResult {
                        client_seq,
                        status,
                        mismatched,
                        ..
                    } => self.answer(client_seq, Answer::Checksum { status, mismatched }),
                    ServerControl::BundleWanted { request_id, have } => {
                        // Waiting on the person's say-so, requests pile up;
                        // keep the newest few (the server forgets old ones).
                        if self.wanted.len() >= MAX_WANTED {
                            self.wanted.remove(0);
                        }
                        self.wanted.push(BundleWant { request_id, have });
                    }
                    ServerControl::BundlePending {
                        client_seq,
                        request_id,
                    } => {
                        if let Some((ours, id)) = &mut self.bundle_request {
                            if *ours == client_seq {
                                *id = Some(request_id);
                            }
                        }
                    }
                    ServerControl::BundleAvailable {
                        request_id, sha, ..
                    } => {
                        if self.is_our_bundle(&request_id) {
                            self.bundle_answer = Some(BundleAnswer::Available { sha });
                        }
                    }
                    ServerControl::BundleUnavailable {
                        request_id,
                        reason,
                        bytes,
                    } => {
                        if self.is_our_bundle(&request_id) {
                            self.bundle_answer = Some(BundleAnswer::Unavailable { reason, bytes });
                        }
                    }
                    ServerControl::Other => {}
                }
            }
            Message::Binary(bytes) => {
                let Some(frame) = wire::decode(&bytes) else {
                    tracing::warn!(target: "atlas_thread_sync", "unreadable binary frame");
                    return Ok(Handled::Other);
                };
                if frame.kind == FrameKind::RunStream as u8
                    || frame.kind == FrameKind::RunFile as u8
                {
                    if frame.kind == FrameKind::RunStream as u8 {
                        self.note_transcript(frame.file_id, &frame.payload);
                    }
                    if let Some(events) = &self.events {
                        let _ = events.send(ThreadEvent::RunFrame {
                            run_no: frame.file_id,
                            kind: frame.kind,
                            payload: frame.payload,
                        });
                    }
                    return Ok(Handled::Other);
                }
                if frame.kind != FrameKind::CanonicalUpdate as u8 {
                    return Ok(Handled::Other);
                }
                self.saw_seq(frame.seq);
                // A binary file's content is its blob; the update a binary
                // Conflict's resolution journals is empty and changes nothing.
                if self.replica.kind(frame.file_id) == Some(FileKind::Binary) {
                    return Ok(Handled::Other);
                }
                // A save the person made while this arrived is folded in and
                // goes out as its own change.
                let local = self.replica.apply_remote(frame.file_id, &frame.payload)?;
                self.send_updates(frame.file_id, local).await?;
            }
        }
        Ok(Handled::Other)
    }
}

/// Largest total of updates one `merge.submit` may carry (the server's
/// `THREAD_MAX_MERGE_BYTES`); a held hunk's three texts count toward it.
const MAX_MERGE_BYTES: usize = 768 * 1024;

/// Largest text one side of a Conflict may carry (`THREAD_MAX_CONFLICT_TEXT`).
const MAX_CONFLICT_TEXT: usize = 16 * 1024;

/// Most Conflicts one merge may raise (`THREAD_MAX_CONFLICTS_PER_MERGE`).
const MAX_CONFLICTS_PER_MERGE: usize = 100;

/// Conflicts a session remembers.
const CONFLICTS_KEPT: usize = 500;

/// A Run's binary result planned to land whole (ATL-410), and what the
/// thread held for it when the plan was made — checked again before it lands.
struct Landing {
    file_id: Option<u64>,
    path: String,
    sha: String,
    bytes: Vec<u8>,
    /// The file's canonical blob at the plan.
    seen: Option<String>,
    /// Its content at the Run's fork.
    forked: Option<String>,
}

/// How somebody resolves a Conflict (ATL-410).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolve {
    /// Keep canonical state's version of the hunk.
    Canonical,
    /// Take the Run's.
    Run,
    /// Canonical's, then the Run's.
    Both,
    /// Text the person wrote, starting from the proposal.
    Edited(String),
    /// Text an agent wrote.
    Agent(String),
}

impl Resolve {
    fn side(&self) -> ConflictSide {
        match self {
            Resolve::Canonical => ConflictSide::Canonical,
            Resolve::Run => ConflictSide::Run,
            Resolve::Both => ConflictSide::Both,
            Resolve::Edited(_) => ConflictSide::Edited,
            Resolve::Agent(_) => ConflictSide::Agent,
        }
    }
}

/// A Conflict as the app shows it: the server's record, who and which agent
/// is behind each side, and a proposed result.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictView {
    #[serde(flatten)]
    pub conflict: ThreadConflict,
    /// Who ran the Run whose hunk was held, and its agent.
    pub run_by: Option<String>,
    pub run_agent: Option<String>,
    /// Who else changed those lines, and the agents of other Runs involved.
    pub canonical_by: Vec<String>,
    pub canonical_agents: Vec<String>,
    /// One side when only it changed the base, both otherwise. `None` for a
    /// binary file, which takes one side or the other.
    pub proposed: Option<String>,
}

fn unexpected(answer: &Answer) -> SessionError {
    SessionError::Refused {
        code: "unexpected_answer".into(),
        message: format!("the server answered {answer:?}"),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Handled {
    Synced,
    /// The server says this replica is ahead of it: rebuild.
    Resync,
    Other,
}
