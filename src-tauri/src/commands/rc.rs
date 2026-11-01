//! Universal RC in the app: the IPC verbs, the session port onto the steering
//! entry, and the `atlas:rc` window event.
//!
//! `atlas-remote-control` does the protocol; this module supplies what only
//! the app has — the bearer (the artifacts token source), the room's scope
//! hint, the session itself (through [`AgentHost`]), the lossless delta tap,
//! and the session hold.
//!
//! # Lifecycle (design review D7)
//!
//! `rc_start(sessionId)`: create the room (`POST /rc/rooms`), hold the
//! session so closing its tab or switching project leaves it running, register
//! the tap, start the host task. `rc_stop(sessionId)` undoes all four, ending
//! the room with the REST close door. A room the server ends on its own
//! (closed from the web, revoked, the owner's grace run out) is cleaned up the
//! same way when the host task reports `ended`. A sign-out, or a sign-in as
//! another account, closes every room this desktop hosts
//! ([`close_all_rooms`]) and leaves the sessions running: the room belongs to
//! the account that was signed in when it started, and to nobody after.
//!
//! # Whose room, and the scope hint
//!
//! A room is the **account's**: starting one needs a signed-in session and
//! nothing more, so a developer with no Organisation at all has remote
//! control. The Organisation is only a *hint* about multiplayer — whom the
//! owner may later invite. It is sent when the Timeline's target Organisation
//! ([`ArtifactsCloudState::org_id`]) is one the stored identity still lists;
//! a stale pin, a local-only Organisation or a signed-in-but-no-org account
//! all open a *solo* room, whose viewer link works exactly the same. The
//! Workspace rides along when the session's Project is Cloud-bound to that
//! Organisation (the capture store's `binding.remote_workspace_id`, the same
//! test `chat_comment_target` uses). The scope is set once: `rc_set_scope`
//! sends it later for a room opened before the user picked an Organisation.
//!
//! # The seat
//!
//! The host task reports who drives; while that is not this account, the
//! steering entry refuses the window's composer
//! ([`AgentHost::set_remote_driver`]) and the window offers "Take over"
//! (`rc_take_over`). A visitor's request to drive reaches the window on the
//! same event (`pending`) and is answered with `rc_answer_control`.
//!
//! # What never reaches the renderer
//!
//! The host secret. It lives in the host task's memory for the room's life
//! (not the keychain: a room does not survive a restart in v1, and neither
//! does the live session it hosts).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::v1 as acp;
use atlas_remote_control::gate::Refusal;
use atlas_remote_control::host::BoxFuture;
use atlas_remote_control::wire::{Capability, Command, EndReason, Gate, PrincipalRef, Tier};
use atlas_remote_control::{
    CreateRoomRequest, HostConfig, HostStatus, LinkState, RcClient, RoomHandle, Scope, SessionPort,
    SnapshotDoc, UpdateRoomRequest,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use super::agent_host::{
    AgentHost, HostError, Origin, PermissionDecision, Prompt, RemoteDriver, SessionControls,
    SessionKey, SubmitPolicy,
};
use super::agents::DeltaTaps;
use super::artifacts_cloud::{AppTokenSource, ArtifactsCloudState};
use super::auth::AuthState;

/// The window event channel: one room's state, whole, on every change.
pub const RC_EVENT: &str = "atlas:rc";

/// The longest title the create door takes.
const TITLE_MAX: usize = 80;

/// A room's scope, as the window sees it: who may be invited.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RcScopeWire {
    pub org_id: String,
    pub workspace_id: Option<String>,
}

impl From<Scope> for RcScopeWire {
    fn from(scope: Scope) -> Self {
        Self {
            org_id: scope.org_id,
            workspace_id: scope.workspace_id,
        }
    }
}

/// Who holds the seat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RcDriverWire {
    pub id: String,
    pub name: Option<String>,
    /// This desktop's account holds it — the composer is free.
    pub is_owner: bool,
    /// The seat is waiting out the driver's reconnect.
    pub lost: bool,
}

/// A visitor asking to drive, still unanswered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RcControlRequestWire {
    pub request_id: String,
    pub from_id: String,
    pub from_name: Option<String>,
    pub requested_at: u64,
    pub expires_at: u64,
}

/// One room, as the window sees it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RcRoomWire {
    pub session_id: String,
    pub room_id: String,
    /// `None` for a solo room.
    pub scope: Option<RcScopeWire>,
    pub viewer_url: String,
    /// `connecting` | `live` | `offline` | `ended`.
    pub state: LinkState,
    pub owner_online: bool,
    /// Distinct people connected to the room, from its roster.
    pub viewers: usize,
    /// `None` before the room's first welcome.
    pub driver: Option<RcDriverWire>,
    pub pending: Vec<RcControlRequestWire>,
    pub last_error: Option<String>,
    pub end_reason: Option<EndReason>,
}

/// What `rc_start` answers.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RcStarted {
    pub room_id: String,
    pub scope: Option<RcScopeWire>,
    pub viewer_url: String,
    /// A non-blocking word about the scope: the Organisation refused sharing,
    /// so the room opened solo. `None` when nothing is worth saying.
    pub note: Option<String>,
}

struct LiveRoom {
    handle: Arc<RoomHandle>,
    tap: u64,
    holder: String,
    owner_user_id: String,
    wire: RcRoomWire,
}

/// Every room this desktop hosts, by session id.
pub struct RcState {
    /// This desktop's replica id, minted per process. The room is bound to
    /// it (only this desktop may host), and the room cannot outlive the
    /// process anyway: its secret is memory-only.
    client_id: String,
    rooms: Mutex<HashMap<String, LiveRoom>>,
    /// Sessions whose room is being created right now, so a second start
    /// (a double click) cannot open a second room. Stop and the end-of-room
    /// cleanup need no such guard: whoever removes a room from `rooms` is
    /// the one that tears it down.
    starting: Mutex<HashSet<String>>,
    client: std::sync::OnceLock<Arc<RcClient>>,
}

impl RcState {
    fn new() -> Self {
        Self {
            client_id: format!("desk-{}", Uuid::new_v4().simple()),
            rooms: Mutex::new(HashMap::new()),
            starting: Mutex::new(HashSet::new()),
            client: std::sync::OnceLock::new(),
        }
    }

    fn rooms(&self) -> std::sync::MutexGuard<'_, HashMap<String, LiveRoom>> {
        self.rooms
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Claim the start of `session_id`'s room; `None` while another start
    /// for it is in flight. The claim is released when the guard drops.
    fn claim_start(&self, session_id: &str) -> Option<StartClaim<'_>> {
        let mut starting = self
            .starting
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        starting.insert(session_id.to_owned()).then(|| StartClaim {
            state: self,
            session_id: session_id.to_owned(),
        })
    }

    fn client(&self, app: &AppHandle) -> Result<Arc<RcClient>, String> {
        if let Some(client) = self.client.get() {
            return Ok(client.clone());
        }
        let client = Arc::new(
            RcClient::new(Arc::new(AppTokenSource { app: app.clone() }))
                .map_err(|e| e.to_string())?,
        );
        Ok(self.client.get_or_init(|| client).clone())
    }

    /// The room's handle, for a control frame.
    fn handle(&self, session_id: &str) -> Result<Arc<RoomHandle>, String> {
        self.rooms()
            .get(session_id)
            .map(|room| room.handle.clone())
            .ok_or_else(|| "Remote control is not on for this session.".to_string())
    }
}

struct StartClaim<'a> {
    state: &'a RcState,
    session_id: String,
}

impl Drop for StartClaim<'_> {
    fn drop(&mut self) {
        self.state
            .starting
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.session_id);
    }
}

/// Manage the state. Nothing dials until a room is started.
///
/// Also hooks two notices. The agent host's session end: a session that ends
/// under its room — the agent's process died, the agent was killed — takes
/// its record and the room's hold with it, so the room is ended too and the
/// window hears `ended` rather than the host task retrying a snapshot of a
/// session that no longer exists. And the auth core's credential rejection:
/// the server refusing the stored credential is a sign-in change on the host
/// (CC-1), so every room closes at once — while the bearer still mints, the
/// same way `auth_sign_out` does it — and the sessions run on. Without it
/// the host socket failed `401` and the room lingered until `owner_timeout`.
pub fn install(app: &AppHandle) {
    app.manage(RcState::new());
    if let Some(auth) = app.try_state::<AuthState>() {
        let app = app.clone();
        auth.core().on_credential_rejected(Arc::new(move || {
            let app = app.clone();
            Box::pin(async move {
                tracing::info!(target: "atlas_rc", "the account's credential was rejected; closing every room");
                close_all_rooms(&app).await;
            })
        }));
    }
    if let Some(host) = app.try_state::<Arc<AgentHost>>() {
        let app = app.clone();
        host.observe_session_end(Arc::new(move |session_id: &str| {
            let has_room = app
                .try_state::<RcState>()
                .is_some_and(|rc| rc.rooms().contains_key(session_id));
            if !has_room {
                return;
            }
            let app = app.clone();
            let session_id = session_id.to_owned();
            tauri::async_runtime::spawn(async move {
                if let Some(rc) = app.try_state::<RcState>() {
                    tracing::info!(target: "atlas_rc", session = %session_id, "the session ended; ending its room");
                    stop_room(&app, rc.inner(), &session_id).await;
                }
            });
        }));
    }
}

fn emit(app: &AppHandle, wire: &RcRoomWire) {
    if let Err(e) = app.emit(RC_EVENT, wire) {
        tracing::warn!(target: "atlas_rc", "failed to emit {RC_EVENT}: {e}");
    }
}

/// Start remote control for a live session, or answer the room it already
/// has. `title` is the window's name for the thread (cut to 80 characters).
/// Needs a signed-in account and nothing else — no Organisation.
#[tauri::command]
pub async fn rc_start(
    session_id: String,
    title: Option<String>,
    app: AppHandle,
    host: State<'_, Arc<AgentHost>>,
    rc: State<'_, RcState>,
) -> Result<RcStarted, String> {
    let Some(_claim) = rc.claim_start(&session_id) else {
        return Err("Remote control is already starting for this session.".into());
    };
    if let Some(room) = rc.rooms().get(&session_id) {
        if reusable(&room.wire) {
            return Ok(RcStarted {
                room_id: room.wire.room_id.clone(),
                scope: room.wire.scope.clone(),
                viewer_url: room.wire.viewer_url.clone(),
                note: None,
            });
        }
    }
    // A room that ended but whose cleanup has not run yet is not one to hand
    // back: finish it here, then make another.
    stop_room(&app, rc.inner(), &session_id).await;
    let host = host.inner().clone();
    let key = host.session_key(&session_id).ok_or(
        "That session is not running. Send it a message first, then start remote control.",
    )?;
    let meta = host.snapshot_meta(&key).map_err(|e| e.to_string())?;

    let scope = scope_hint(&app, &meta.cwd).await;

    let capabilities = capabilities_for(host.session_controls(&key).map_err(|e| e.to_string())?);
    let title = title
        .map(|t| t.trim().chars().take(TITLE_MAX).collect::<String>())
        .filter(|t| !t.is_empty());
    let mut request = CreateRoomRequest {
        scope,
        session_id: session_id.clone(),
        client_id: rc.client_id.clone(),
        agent: meta.plugin_id.clone(),
        model: meta.current_model.clone(),
        title,
        member_tier: Some(Tier::View),
        capabilities: capabilities.clone(),
    };

    let client = rc.client(&app)?;
    // The scope is a hint about multiplayer, never a condition of the room:
    // an Organisation whose grant refuses sharing (`403 rc_refused` from the
    // org layer) costs the scope, not the room. Retry solo at once, and say
    // so without blocking (plan B-61..B-65).
    let mut note = None;
    let mut created = match client.create_room(&request).await {
        Ok(created) => created,
        Err(e) if request.scope.is_some() && scope_refused(&e) => {
            let org = request.scope.take().map(|s| s.org_id).unwrap_or_default();
            tracing::info!(target: "atlas_rc", %org, error = %e, "the scope was refused; opening a solo room");
            note = Some(format!(
                "Sharing with your organisation isn't available ({e}); this room is just for you."
            ));
            client.create_room(&request).await.map_err(start_error)?
        }
        Err(e) => return Err(start_error(e)),
    };
    if created.host_secret.is_none() {
        // An open room for this session from an earlier run of the app: its
        // secret is gone with that process, so it can never be hosted again.
        // Close it and make another (the create door's own instruction).
        tracing::info!(target: "atlas_rc", room = %created.room.id, "replacing a room this desktop can no longer host");
        client
            .close_room(&created.room.id)
            .await
            .map_err(|e| e.to_string())?;
        created = client.create_room(&request).await.map_err(start_error)?;
    }
    let room = created.room;
    let Some(host_secret) = created.host_secret else {
        return Err("The room could not be created; try again.".into());
    };

    let holder = format!("rc:{}", room.id);
    if let Err(e) = host.hold_session(&session_id, &holder) {
        let _ = client.close_room(&room.id).await;
        return Err(e.to_string());
    }

    // The server's answer wins over the hint: it is what the room has.
    let scope = room.org_id.clone().map(|org_id| Scope {
        org_id,
        workspace_id: room.workspace_id.clone(),
    });
    let viewer_url = atlas_remote_control::viewer_url(&room.id);
    let wire = RcRoomWire {
        session_id: session_id.clone(),
        room_id: room.id.clone(),
        scope: scope.map(RcScopeWire::from),
        viewer_url: viewer_url.clone(),
        state: LinkState::Connecting,
        owner_online: false,
        viewers: 0,
        driver: None,
        pending: Vec::new(),
        last_error: None,
        end_reason: None,
    };

    let config = HostConfig::new(
        room.id.clone(),
        session_id.clone(),
        room.owner_user_id.clone(),
        rc.client_id.clone(),
        host_secret,
        meta.plugin_id.clone(),
        meta.current_model.clone(),
        capabilities,
    );
    // The join order: the tap first, so the host task's first snapshot is
    // taken with the stream already buffering behind it.
    let (handle, unstarted) = atlas_remote_control::prepare(config);
    let handle = Arc::new(handle);
    let tapped = handle.clone();
    let tap = app
        .state::<Arc<DeltaTaps>>()
        .add(Arc::new(move |envelope| tapped.offer(envelope)));
    rc.rooms().insert(
        session_id.clone(),
        LiveRoom {
            handle,
            tap,
            holder,
            owner_user_id: room.owner_user_id.clone(),
            wire: wire.clone(),
        },
    );
    emit(&app, &wire);

    let port = Arc::new(AppSessionPort {
        host: host.clone(),
        key,
        owner_user_id: room.owner_user_id.clone(),
    });
    let status_app = app.clone();
    let status_session = session_id.clone();
    unstarted.start(
        Arc::new(AppTokenSource { app: app.clone() }),
        port,
        Arc::new(move |status: HostStatus| {
            on_status(&status_app, &status_session, status);
        }),
    );
    tracing::info!(target: "atlas_rc", room = %room.id, session = %session_id, "remote control started");

    Ok(RcStarted {
        room_id: room.id,
        scope: wire.scope,
        viewer_url,
        note,
    })
}

/// What this desktop advertises for the room's life: steering and approval
/// always; mode, model and config when the agent's connection advertises
/// the control — not when its list happens to be non-empty at this instant
/// (a native session whose catalogue fetch failed at start still has model
/// selection, and the gate would otherwise refuse `set_model` for the room's
/// life even after a refresh).
fn capabilities_for(controls: SessionControls) -> Vec<Capability> {
    let mut capabilities = vec![Capability::Steer, Capability::Approve];
    if controls.modes {
        capabilities.push(Capability::Mode);
    }
    if controls.models {
        capabilities.push(Capability::Model);
    }
    if controls.config {
        capabilities.push(Capability::Config);
    }
    capabilities
}

/// The create door refused the *scope*, not the room: the Organisation's
/// grant (`403 rc_refused { gate: "org_setting" }`), an Organisation the
/// token does not name (`403 forbidden`), or a Workspace it cannot read
/// (`404 not_found`). A `platform_flag` refusal is final — remote control is
/// off everywhere — and so is everything else.
fn scope_refused(e: &atlas_remote_control::RestError) -> bool {
    use atlas_remote_control::RestError;
    match e {
        RestError::Refused { gate, .. } => gate != "platform_flag",
        RestError::Forbidden(_) | RestError::NotFound(_) => true,
        _ => false,
    }
}

/// A create-door failure, in the words the window shows. A platform refusal
/// says so; an Organisation never enters into it.
fn start_error(e: atlas_remote_control::RestError) -> String {
    use atlas_remote_control::RestError;
    match e {
        RestError::Unauthorized(_) => {
            "Remote control needs a signed-in Atlas account. Sign in and try again.".into()
        }
        RestError::Refused { message, .. } if message.is_empty() => {
            "Remote control is turned off right now.".into()
        }
        other => other.to_string(),
    }
}

/// End remote control for a session: the room, the hold, the tap.
/// Idempotent — a session with no room answers `Ok`.
#[tauri::command]
pub async fn rc_stop(
    session_id: String,
    app: AppHandle,
    rc: State<'_, RcState>,
) -> Result<(), String> {
    stop_room(&app, rc.inner(), &session_id).await;
    Ok(())
}

async fn stop_room(app: &AppHandle, rc: &RcState, session_id: &str) {
    let Some(room) = rc.rooms().remove(session_id) else {
        return;
    };
    room.handle.stop();
    let closed = match rc.client(app) {
        Ok(client) => client
            .close_room(&room.wire.room_id)
            .await
            .map_err(|e| e.to_string()),
        Err(e) => Err(e),
    };
    release(app, session_id, room.tap, &room.holder, &room.owner_user_id).await;
    let mut wire = room.wire;
    wire.state = LinkState::Ended;
    wire.owner_online = false;
    wire.viewers = 0;
    wire.driver = None;
    wire.pending.clear();
    // A room the server already ended keeps its reason; one this desktop
    // ends is the owner's doing — the session going away included, since
    // the session is the owner's.
    wire.end_reason = wire.end_reason.or(Some(EndReason::ClosedByOwner));
    if let Err(e) = &closed {
        // The room ends itself once the owner's grace runs out; nothing more
        // to do here than say so.
        tracing::warn!(target: "atlas_rc", room = %wire.room_id, "closing the room failed: {e}");
        wire.last_error = Some(format!(
            "The room could not be closed now; it ends on its own shortly. ({e})"
        ));
    }
    emit(app, &wire);
    tracing::info!(target: "atlas_rc", room = %wire.room_id, session = %session_id, "remote control stopped");
}

/// Close every room this desktop hosts — the sign-out / account-change path
/// (CC-1: a sign-in change on the host ends the room and leaves the session
/// running). Call it **before** the credential goes, so the close door still
/// has a bearer; a room that cannot be closed ends on its own grace.
pub async fn close_all_rooms(app: &AppHandle) {
    let Some(rc) = app.try_state::<RcState>() else {
        return;
    };
    let sessions: Vec<String> = rc.rooms().keys().cloned().collect();
    for session_id in sessions {
        stop_room(app, rc.inner(), &session_id).await;
    }
}

/// Whether a room in the table is one `rc_start` may hand back: an ended
/// room whose cleanup has not run yet is not.
fn reusable(wire: &RcRoomWire) -> bool {
    wire.state != LinkState::Ended
}

/// Every room this desktop hosts, for a window that just loaded.
#[tauri::command]
pub fn rc_status(rc: State<'_, RcState>) -> Vec<RcRoomWire> {
    let mut rooms: Vec<RcRoomWire> = rc.rooms().values().map(|room| room.wire.clone()).collect();
    rooms.sort_by(|a, b| a.session_id.cmp(&b.session_id));
    rooms
}

/// Share a solo room with the Organisation the desktop now targets — the
/// later-pick case. Set once: a room that already has a scope keeps it.
#[tauri::command]
pub async fn rc_set_scope(
    session_id: String,
    app: AppHandle,
    host: State<'_, Arc<AgentHost>>,
    rc: State<'_, RcState>,
) -> Result<Option<RcScopeWire>, String> {
    let (room_id, current) = {
        let rooms = rc.rooms();
        let room = rooms
            .get(&session_id)
            .ok_or("Remote control is not on for this session.")?;
        (room.wire.room_id.clone(), room.wire.scope.clone())
    };
    if current.is_some() {
        return Ok(current);
    }
    let cwd = host
        .session_key(&session_id)
        .and_then(|key| host.snapshot_meta(&key).ok())
        .map(|meta| meta.cwd)
        .unwrap_or_default();
    let Some(scope) = scope_hint(&app, &cwd).await else {
        return Err("Pick a cloud organisation in Atlas first, then share the room.".into());
    };
    rc.client(&app)?
        .update_room(
            &room_id,
            &UpdateRoomRequest {
                scope: Some(scope.clone()),
                ..UpdateRoomRequest::default()
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    let wire = {
        let mut rooms = rc.rooms();
        let Some(room) = rooms.get_mut(&session_id) else {
            return Ok(None);
        };
        room.wire.scope = Some(RcScopeWire::from(scope));
        room.wire.clone()
    };
    emit(&app, &wire);
    Ok(wire.scope)
}

/// Owner: take the seat back from whoever drives.
#[tauri::command]
pub fn rc_take_over(session_id: String, rc: State<'_, RcState>) -> Result<(), String> {
    rc.handle(&session_id)?.take_over()
}

/// Owner: answer a visitor's request to drive. Approving hands them the seat;
/// the window's own composer is then refused until `rc_take_over`.
#[tauri::command]
pub fn rc_answer_control(
    session_id: String,
    request_id: String,
    approve: bool,
    rc: State<'_, RcState>,
) -> Result<(), String> {
    rc.handle(&session_id)?.answer_control(&request_id, approve)
}

/// Owner: hand the seat to a connected principal (by principal id) without
/// waiting for a request. The window's own composer is then refused until
/// `rc_take_over`.
#[tauri::command]
pub fn rc_grant_control(
    session_id: String,
    target: String,
    rc: State<'_, RcState>,
) -> Result<(), String> {
    rc.handle(&session_id)?.grant_control(&target)
}

/// Owner: cut a principal's sockets. A driver so kicked loses the seat.
#[tauri::command]
pub fn rc_kick(session_id: String, target: String, rc: State<'_, RcState>) -> Result<(), String> {
    rc.handle(&session_id)?.kick(&target)
}

/// The host task reported a change: mirror it, tell the window and the
/// steering entry, and clean up after a room the server ended.
fn on_status(app: &AppHandle, session_id: &str, status: HostStatus) {
    let Some(rc) = app.try_state::<RcState>() else {
        return;
    };
    let ended = status.state == LinkState::Ended;
    let (wire, owner, remote_driver) = {
        let mut rooms = rc.rooms();
        let Some(room) = rooms.get_mut(session_id) else {
            return;
        };
        let owner = room.owner_user_id.clone();
        let driver = status.driver.as_ref().map(|d| RcDriverWire {
            id: d.id.clone(),
            name: d.name.clone(),
            is_owner: d.id == owner,
            lost: d.lost.unwrap_or(false),
        });
        let remote_driver = remote_driver_for(status.state, driver.as_ref());
        room.wire.state = status.state;
        room.wire.owner_online = status.owner_online;
        room.wire.viewers = status.viewers;
        room.wire.driver = driver;
        room.wire.pending = status
            .pending
            .iter()
            .map(|r| RcControlRequestWire {
                request_id: r.request_id.clone(),
                from_id: r.from.id.clone(),
                from_name: r.from.name.clone(),
                requested_at: r.requested_at,
                expires_at: r.expires_at,
            })
            .collect();
        // Every welcome restates the scope, so a revoked one (the owner
        // removed from the Organisation, the Organisation deleted) reads as
        // `None` on the next welcome: the room continues solo, and
        // `rc_set_scope` may share it again later.
        if status.state == LinkState::Live {
            room.wire.scope = status.scope.clone().map(RcScopeWire::from);
        }
        room.wire.last_error = status.last_error.clone();
        room.wire.end_reason = status.end_reason;
        (room.wire.clone(), owner, remote_driver)
    };
    // The steering entry hears the seat before the window does, so a send
    // the window fires on this very event is already refused.
    if let Some(host) = app.try_state::<Arc<AgentHost>>() {
        host.set_remote_driver(session_id, &owner, remote_driver);
    }
    emit(app, &wire);
    if ended {
        let app = app.clone();
        let session_id = session_id.to_owned();
        let room_id = wire.room_id;
        tauri::async_runtime::spawn(async move {
            let Some(rc) = app.try_state::<RcState>() else {
                return;
            };
            let room = {
                let mut rooms = rc.rooms();
                // Only this room: `rc_start` may have replaced an ended room
                // with a new one for the same session in the meantime.
                match rooms.get(&session_id) {
                    Some(room) if room.wire.room_id == room_id => rooms.remove(&session_id),
                    _ => None,
                }
            };
            let Some(room) = room else {
                return;
            };
            // Idempotent: a room that ended server-side answers 204 again; one
            // this desktop was refused as host is ended rather than left to
            // time out.
            if let Ok(client) = rc.client(&app) {
                let _ = client.close_room(&room.wire.room_id).await;
            }
            release(
                &app,
                &session_id,
                room.tap,
                &room.holder,
                &room.owner_user_id,
            )
            .await;
        });
    }
}

/// The seat, as the steering entry is told it: someone other than the owner
/// holds it **and the room is live**. Offline, connecting or ended, the
/// last-known driver is stale — the server may have moved the seat since, and
/// `rc_take_over` cannot be sent on a socket that is down — so the owner's
/// composer is not locked on its account; the next welcome or roster
/// re-asserts whoever drives.
fn remote_driver_for(state: LinkState, driver: Option<&RcDriverWire>) -> Option<RemoteDriver> {
    match driver {
        Some(d) if !d.is_owner && state == LinkState::Live => Some(RemoteDriver {
            id: d.id.clone(),
            name: d.name.clone(),
        }),
        _ => None,
    }
}

async fn release(app: &AppHandle, session_id: &str, tap: u64, holder: &str, owner_user_id: &str) {
    app.state::<Arc<DeltaTaps>>().remove(tap);
    let host = app.state::<Arc<AgentHost>>().inner().clone();
    host.set_remote_driver(session_id, owner_user_id, None);
    if let Err(e) = host.release_session(session_id, holder).await {
        tracing::warn!(target: "atlas_rc", session = session_id, "releasing the hold failed: {e}");
    }
}

/// The room's scope hint: the Timeline's target Organisation, **only** when
/// the stored identity still lists it (a stale pin names one it does not),
/// and the session's Project's Workspace when it is Cloud-bound to that
/// Organisation. `None` is a solo room.
async fn scope_hint(app: &AppHandle, cwd: &str) -> Option<Scope> {
    let org_id = app
        .try_state::<ArtifactsCloudState>()
        .and_then(|state| state.org_id())?;
    // `stored()` reads the credential file: off the runtime the IPC channel
    // shares.
    let core = app.try_state::<AuthState>().map(|auth| auth.core());
    let listed = match core {
        Some(core) => {
            let wanted = org_id.clone();
            tauri::async_runtime::spawn_blocking(move || {
                core.stored()
                    .and_then(|stored| stored.identity)
                    .and_then(|identity| identity.orgs)
                    .is_some_and(|orgs| orgs.iter().any(|org| org.id == wanted))
            })
            .await
            .unwrap_or(false)
        }
        None => false,
    };
    if !listed {
        tracing::info!(target: "atlas_rc", org = %org_id, "the target organisation is not one the account lists; opening a solo room");
        return None;
    }
    let workspace_id = workspace_for(cwd, &org_id).await;
    Some(Scope {
        org_id,
        workspace_id,
    })
}

/// The session's Project's server Workspace, when it is Cloud-bound to the
/// Organisation; `None` otherwise.
async fn workspace_for(cwd: &str, org_id: &str) -> Option<String> {
    if cwd.is_empty() {
        return None;
    }
    let cwd = cwd.to_owned();
    let org_id = org_id.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let store = super::capture::open_reader(&cwd).ok()??;
        let binding = store.binding().ok()??;
        if !super::artifacts_cloud::is_cloud_bound(&binding, &org_id) {
            return None;
        }
        binding.remote_workspace_id
    })
    .await
    .ok()
    .flatten()
}

// ── The session, as the room needs it ───────────────────────────────────────

/// The steering entry, for one session, as a remote origin reaches it.
struct AppSessionPort {
    host: Arc<AgentHost>,
    key: SessionKey,
    owner_user_id: String,
}

impl SessionPort for AppSessionPort {
    fn snapshot(&self) -> BoxFuture<Result<SnapshotDoc, String>> {
        let host = self.host.clone();
        let key = self.key.clone();
        Box::pin(async move {
            // A whole-transcript read, and `build_snapshot` blocks on the
            // model list: off the runtime the IPC channel shares.
            tauri::async_runtime::spawn_blocking(move || {
                let snapshot = host.snapshot(&key).map_err(|e| e.to_string())?;
                let as_of_seq = snapshot.as_of_seq;
                let document = serde_json::to_value(&snapshot).map_err(|e| e.to_string())?;
                Ok(SnapshotDoc {
                    as_of_seq,
                    document,
                })
            })
            .await
            .map_err(|e| e.to_string())?
        })
    }

    fn execute(&self, from: PrincipalRef, command: Command) -> BoxFuture<Result<(), Refusal>> {
        let host = self.host.clone();
        let key = self.key.clone();
        let is_owner = from.id == self.owner_user_id;
        Box::pin(async move {
            let origin = Origin::Remote {
                id: from.id,
                name: from.name,
            };
            let done = match command {
                Command::Submit {
                    content,
                    client_message_id,
                } => {
                    let prompt = Prompt {
                        client_message_id,
                        ..Prompt::text(content)
                    };
                    host.submit(&key, prompt, origin, SubmitPolicy::QueueIfBusy)
                        .map(|_| ())
                }
                Command::Stop => host.stop(&key, origin),
                Command::AnswerPermission {
                    request_id,
                    option_id,
                } => {
                    let request_id = parse_request(&request_id)?;
                    // The room answers its own session's prompts and no
                    // other's: a request id is global on this desktop.
                    bound_to_session(host.permission_session(request_id), &key.session_id)?;
                    // A standing grant widens what the agent may do on this
                    // machine without asking for the rest of the session
                    // (§11.1 gate 13; decision audit D9): refused from every
                    // remote surface, the owner's phone included — the
                    // desktop's own card is the one place to grant it. The
                    // desktop is the side that knows the option's kind, so
                    // the check is here.
                    standing_refusal(host.permission_option_kind(request_id, &option_id))?;
                    host.answer_permission(
                        &key.session_id,
                        request_id,
                        PermissionDecision::Selected { option_id },
                        origin,
                    )
                }
                Command::AnswerElicitation { request_id, answer } => {
                    let request_id = parse_request(&request_id)?;
                    // A request-scoped (sign-in) elicitation belongs to no
                    // session, so it never passes here: sign-in stays on the
                    // desktop (design review §4.4).
                    bound_to_session(host.elicitation_session(request_id), &key.session_id)?;
                    let (action, content) = elicitation_answer(answer);
                    host.answer_elicitation(request_id, &action, content, origin)
                }
                Command::SetMode { mode_id } => host.set_mode(&key, mode_id, origin).await,
                Command::SetModel { model_id } => host.set_model(&key, model_id, origin).await,
                Command::SetConfigOption { key: option, value } => {
                    // A member Driver may set the knobs that shape the
                    // model's answer — thinking level, model, model
                    // configuration — and nothing else: a config option is
                    // agent-defined, and the desktop is the side that holds
                    // the agent's own category for it (§11.1 gate 13; the
                    // crate's gate already refused keys that name a sandbox
                    // or approval switch). An option the agent no longer
                    // lists, or lists uncategorised, is owner-only.
                    if !is_owner && !member_may_set(host.config_option_category(&key, &option)) {
                        return Err(Refusal::new(
                            Gate::Widening,
                            "only the owner may change this session's options",
                        ));
                    }
                    host.set_config_option(&key, option, value, origin).await
                }
            };
            done.map_err(refusal_for)
        })
    }
}

/// The config-option categories a Driver who is not the owner may set: the
/// ones that shape the model's answer. `Mode` has `set_mode`'s rule, and an
/// uncategorised or unlisted option (`None`, `Other`) is owner-only — a "web
/// search" or "sandbox" toggle is `Other`.
fn member_may_set(category: Option<acp::SessionConfigOptionCategory>) -> bool {
    use acp::SessionConfigOptionCategory as Category;
    matches!(
        category,
        Some(Category::ThoughtLevel | Category::ModelConfig | Category::Model)
    )
}

/// A permission option that outlives the prompt it answers.
fn standing(kind: Option<acp::PermissionOptionKind>) -> bool {
    matches!(
        kind,
        Some(acp::PermissionOptionKind::AllowAlways | acp::PermissionOptionKind::RejectAlways)
    )
}

/// Refuse a standing grant from a remote surface — whoever holds the phone.
/// There is deliberately no owner exemption (D9: no standing grants from any
/// remote surface).
fn standing_refusal(kind: Option<acp::PermissionOptionKind>) -> Result<(), Refusal> {
    if standing(kind) {
        return Err(Refusal::new(
            Gate::Widening,
            "a grant for the rest of the session is made on the desktop, not from a remote",
        ));
    }
    Ok(())
}

/// A pending prompt is answerable through a room only when it is the room's
/// session's. `found` is the session the prompt belongs to, `None` when
/// nothing by that id is pending on any session (a sign-in elicitation is
/// session-less and reads as `None` too).
fn bound_to_session(found: Option<String>, session_id: &str) -> Result<(), Refusal> {
    match found {
        Some(owner) if owner == session_id => Ok(()),
        _ => Err(Refusal::new(
            Gate::NotPending,
            "no such prompt is waiting on this session",
        )),
    }
}

fn parse_request(id: &str) -> Result<Uuid, Refusal> {
    Uuid::parse_str(id).map_err(|_| Refusal::new(Gate::NotPending, "no such prompt is waiting"))
}

/// An elicitation answer off the wire: `{ action, content? }` as the window
/// sends it, or a bare value, which accepts with that value as the content.
fn elicitation_answer(answer: serde_json::Value) -> (String, Option<serde_json::Value>) {
    if let Some(action) = answer.get("action").and_then(serde_json::Value::as_str) {
        let content = answer.get("content").cloned();
        return (action.to_owned(), content);
    }
    ("accept".to_owned(), Some(answer))
}

/// A steering failure, as the gate the remote branches on. The words travel
/// too — "mode can't change mid-turn" is shown remotely as the desktop said it.
fn refusal_for(error: HostError) -> Refusal {
    let message = error.message;
    let lower = message.to_ascii_lowercase();
    if lower.contains("not pending")
        || lower.contains("no longer queued")
        || lower.contains("unknown session")
    {
        return Refusal::with_code(Gate::NotPending, "not_pending", message);
    }
    if lower.contains("not offered") {
        return Refusal::with_code(Gate::OptionStanding, "option_standing", message);
    }
    // A full queue is "busy" in the client's terms: the same gate a prompt
    // that cannot start yet gets, no new wire variant.
    if lower.contains("queue is full")
        || lower.contains("turn")
        || lower.contains("running")
        || lower.contains("busy")
    {
        return Refusal::with_code(Gate::InFlight, "in_flight", message);
    }
    // The gate list has no "the agent said no"; `in_flight` is the closest a
    // client already handles, and the code says which it was.
    Refusal::with_code(Gate::InFlight, "agent_error", message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use atlas_agent_wire::ErrorClass;

    #[test]
    fn a_steering_failure_names_the_gate_a_remote_branches_on() {
        let gate = |m: &str| refusal_for(HostError::new(m, ErrorClass::Fatal)).gate;
        assert_eq!(gate("permission request is not pending"), Gate::NotPending);
        assert_eq!(
            gate("permission option is not offered"),
            Gate::OptionStanding
        );
        assert_eq!(gate("mode can't change mid-turn"), Gate::InFlight);
        let other = refusal_for(HostError::new(
            "this agent has no session modes",
            ErrorClass::Fatal,
        ));
        assert_eq!(
            (other.gate, other.code.as_str()),
            (Gate::InFlight, "agent_error")
        );
        assert_eq!(other.message, "this agent has no session modes");
    }

    #[test]
    fn an_elicitation_answer_reads_the_windows_shape_or_a_bare_value() {
        let (action, content) = elicitation_answer(serde_json::json!({ "action": "decline" }));
        assert_eq!((action.as_str(), content), ("decline", None));
        let (action, content) = elicitation_answer(serde_json::json!({ "branch": "main" }));
        assert_eq!(action, "accept");
        assert_eq!(content, Some(serde_json::json!({ "branch": "main" })));
    }

    #[test]
    fn a_refused_scope_retries_solo_but_a_platform_refusal_is_final() {
        use atlas_remote_control::RestError;
        let refused = |gate: &str| RestError::Refused {
            gate: gate.into(),
            message: String::new(),
        };
        assert!(scope_refused(&refused("org_setting")));
        assert!(scope_refused(&RestError::Forbidden("not a member".into())));
        assert!(scope_refused(&RestError::NotFound(
            "no such workspace".into()
        )));
        assert!(!scope_refused(&refused("platform_flag")));
        assert!(!scope_refused(&RestError::LimitReached("3 rooms".into())));
        assert!(!scope_refused(&RestError::Unauthorized(String::new())));
    }

    /// A member may set the knobs that shape the answer; everything else —
    /// a mode select, an uncategorised toggle, an option the agent no longer
    /// lists — is the owner's.
    #[test]
    fn a_member_may_set_thinking_model_and_model_config_options_only() {
        use acp::SessionConfigOptionCategory as Category;
        assert!(member_may_set(Some(Category::ThoughtLevel)));
        assert!(member_may_set(Some(Category::ModelConfig)));
        assert!(member_may_set(Some(Category::Model)));
        assert!(!member_may_set(Some(Category::Mode)));
        assert!(!member_may_set(Some(Category::Other("web_search".into()))));
        assert!(!member_may_set(None));
    }

    /// The room advertises what the agent's connection can do, not what a
    /// list held at that instant.
    #[test]
    fn the_rooms_capabilities_follow_the_agents_controls() {
        let all = capabilities_for(SessionControls {
            modes: true,
            models: true,
            config: true,
        });
        assert_eq!(
            all,
            [
                Capability::Steer,
                Capability::Approve,
                Capability::Mode,
                Capability::Model,
                Capability::Config
            ]
        );
        let native = capabilities_for(SessionControls {
            modes: true,
            models: true,
            config: false,
        });
        assert_eq!(
            native,
            [
                Capability::Steer,
                Capability::Approve,
                Capability::Mode,
                Capability::Model
            ]
        );
        let bare = capabilities_for(SessionControls {
            modes: false,
            models: false,
            config: false,
        });
        assert_eq!(bare, [Capability::Steer, Capability::Approve]);
    }

    #[test]
    fn a_standing_grant_is_told_from_a_one_off() {
        assert!(standing(Some(acp::PermissionOptionKind::AllowAlways)));
        assert!(standing(Some(acp::PermissionOptionKind::RejectAlways)));
        assert!(!standing(Some(acp::PermissionOptionKind::AllowOnce)));
        assert!(!standing(Some(acp::PermissionOptionKind::RejectOnce)));
        assert!(!standing(None));
    }

    /// D9: no standing grant from any remote surface. The refusal takes no
    /// "is this the owner" input at all — the owner's phone gets the same
    /// `widening` as a member's; only the desktop's own card grants for the
    /// session.
    #[test]
    fn a_standing_grant_is_refused_from_every_remote_surface_the_owner_included() {
        for kind in [
            acp::PermissionOptionKind::AllowAlways,
            acp::PermissionOptionKind::RejectAlways,
        ] {
            let refusal = standing_refusal(Some(kind)).unwrap_err();
            assert_eq!(refusal.gate, Gate::Widening);
            assert!(refusal.message.contains("desktop"), "{}", refusal.message);
        }
        assert_eq!(
            standing_refusal(Some(acp::PermissionOptionKind::AllowOnce)),
            Ok(())
        );
        assert_eq!(
            standing_refusal(Some(acp::PermissionOptionKind::RejectOnce)),
            Ok(())
        );
        // An option the desktop cannot classify is not a standing one — the
        // steering entry's own "not offered" check decides what it is.
        assert_eq!(standing_refusal(None), Ok(()));
    }

    /// A room answers its own session's prompts only; a sign-in elicitation
    /// (no session) and another session's prompt both read as not pending.
    #[test]
    fn a_remote_answer_is_bound_to_the_rooms_session() {
        assert_eq!(bound_to_session(Some("ses_a".into()), "ses_a"), Ok(()));
        let other = bound_to_session(Some("ses_b".into()), "ses_a").unwrap_err();
        assert_eq!(other.gate, Gate::NotPending);
        let signin = bound_to_session(None, "ses_a").unwrap_err();
        assert_eq!(signin.gate, Gate::NotPending);
        assert!(
            signin.message.contains("this session"),
            "{}",
            signin.message
        );
    }

    /// The owner's composer is locked only while the room is live: with the
    /// socket down the last-known driver may be stale and `rc_take_over`
    /// cannot be sent, so an offline room must not lock the owner out.
    #[test]
    fn the_seat_locks_the_owner_out_only_while_the_room_is_live() {
        let ada = RcDriverWire {
            id: "user_member".into(),
            name: Some("Ada".into()),
            is_owner: false,
            lost: false,
        };
        let me = RcDriverWire {
            id: "user_owner".into(),
            name: None,
            is_owner: true,
            lost: false,
        };
        assert_eq!(
            remote_driver_for(LinkState::Live, Some(&ada)),
            Some(RemoteDriver {
                id: "user_member".into(),
                name: Some("Ada".into()),
            })
        );
        for state in [LinkState::Connecting, LinkState::Offline, LinkState::Ended] {
            assert_eq!(remote_driver_for(state, Some(&ada)), None, "{state:?}");
        }
        assert_eq!(remote_driver_for(LinkState::Live, Some(&me)), None);
        assert_eq!(remote_driver_for(LinkState::Live, None), None);
    }

    /// `rc_start` hands back a room it already hosts — unless that room has
    /// ended and only its cleanup is outstanding.
    #[test]
    fn an_ended_room_is_not_handed_back_by_rc_start() {
        let mut wire = RcRoomWire {
            session_id: "s".into(),
            room_id: "r".into(),
            scope: None,
            viewer_url: "u".into(),
            state: LinkState::Connecting,
            owner_online: false,
            viewers: 0,
            driver: None,
            pending: Vec::new(),
            last_error: None,
            end_reason: None,
        };
        for state in [LinkState::Connecting, LinkState::Live, LinkState::Offline] {
            wire.state = state;
            assert!(reusable(&wire), "{state:?}");
        }
        wire.state = LinkState::Ended;
        assert!(!reusable(&wire));
    }

    /// A full queue is answered on the gate a client already handles.
    #[test]
    fn a_full_queue_is_an_in_flight_refusal() {
        let refusal = refusal_for(HostError::new(
            "the queue is full (16 prompts); wait for a turn to finish",
            ErrorClass::Fatal,
        ));
        assert_eq!(
            (refusal.gate, refusal.code.as_str()),
            (Gate::InFlight, "in_flight")
        );
    }

    #[test]
    fn the_window_event_names_its_fields_in_camel_case() {
        let wire = RcRoomWire {
            session_id: "s".into(),
            room_id: "r".into(),
            scope: Some(RcScopeWire {
                org_id: "o".into(),
                workspace_id: None,
            }),
            viewer_url: "u".into(),
            state: LinkState::Live,
            owner_online: true,
            viewers: 2,
            driver: Some(RcDriverWire {
                id: "user_member".into(),
                name: Some("Ada".into()),
                is_owner: false,
                lost: false,
            }),
            pending: vec![RcControlRequestWire {
                request_id: "req".into(),
                from_id: "user_other".into(),
                from_name: None,
                requested_at: 1,
                expires_at: 2,
            }],
            last_error: None,
            end_reason: None,
        };
        let json = serde_json::to_value(&wire).unwrap();
        for key in [
            "sessionId",
            "roomId",
            "scope",
            "viewerUrl",
            "state",
            "ownerOnline",
            "viewers",
            "driver",
            "pending",
            "lastError",
            "endReason",
        ] {
            assert!(json.get(key).is_some(), "{key}");
        }
        assert_eq!(json["state"], "live");
        assert_eq!(json["scope"]["orgId"], "o");
        assert!(json["scope"]["workspaceId"].is_null());
        assert_eq!(json["driver"]["isOwner"], false);
        assert_eq!(json["driver"]["name"], "Ada");
        assert_eq!(json["pending"][0]["requestId"], "req");
        assert_eq!(json["pending"][0]["fromId"], "user_other");
        assert!(
            json.get("orgId").is_none(),
            "the org rides in the scope only"
        );
        // A solo room: `scope: null`, never a missing key.
        let solo = RcRoomWire {
            scope: None,
            driver: None,
            pending: Vec::new(),
            ..wire
        };
        let json = serde_json::to_value(&solo).unwrap();
        assert!(json["scope"].is_null());
        assert!(json["driver"].is_null());
    }
}
