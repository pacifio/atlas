//! The Timeline's cloud half: the bridge between `atlas-artifacts` and the
//! renderer.
//!
//! Every route to the ingest service goes through here because only Rust holds
//! the Bearer. The renderer invokes these commands and applies the events
//! emitted on [`ARTIFACTS_EVENT`]; it decides nothing.
//!
//! # What lives here and what does not
//!
//! Pushing Sessions is `atlas_checkpoint::sync`, driven from
//! [`crate::commands::capture`]. This module only ever **reads** — remote
//! Sessions, comments — and holds the realtime sockets. Two modules with the
//! right to say a row was sent would be one too many.
//!
//! # The refresh is not on the read path
//!
//! [`artifacts_board`](crate::commands::capture::artifacts_board) merges the
//! cache synchronously and never awaits the network, so the board stays instant
//! and still renders local Sessions with no connection at all. Filling the
//! cache is this module's job, on a ticker and from the socket.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use atlas_artifacts::{
    AnchorKind, ArtifactsClient, ArtifactsEvent, ArtifactsManager, CloudBoard, Comment,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// The window event channel. One per subsystem, as `atlas:agents` is.
pub const ARTIFACTS_EVENT: &str = "atlas:artifacts-cloud";

/// How often the remote board is re-read.
///
/// The server has no board-level realtime beyond `session.summary` on a Project
/// this machine is connected to, so a Project nobody here has bound only
/// updates on this tick. Fifteen seconds matches the web board's own poll.
const REFRESH_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);

pub struct ArtifactsCloudState {
    pub manager: Arc<ArtifactsManager>,
    pub board: Arc<CloudBoard>,
    pub client: Arc<ArtifactsClient>,
    /// The Organisation currently being refreshed, by **server** id. `None`
    /// when signed out or in a local-only Organisation.
    pub org: std::sync::Mutex<Option<String>>,
    /// The last `(org_id, project_paths)` the renderer targeted, replayed by
    /// [`resync_targets`] when a binding changes on the Rust side — the
    /// renderer's effect keys on auth, Organisation and the set of project
    /// paths, none of which move when a Project is connected or promoted.
    pub targets: std::sync::Mutex<(Option<String>, Vec<String>)>,
}

impl ArtifactsCloudState {
    pub(crate) fn org_id(&self) -> Option<String> {
        self.org.lock().ok().and_then(|org| org.clone())
    }
}

/// Mints the access JWT from the account session.
///
/// Resolves `AuthState` per call rather than holding it: this source is built
/// during `setup`, where registration order is not guaranteed.
struct AppTokenSource {
    app: AppHandle,
}

impl atlas_artifacts::TokenSource for AppTokenSource {
    fn mint(&self) -> Pin<Box<dyn Future<Output = atlas_artifacts::Result<String>> + Send + '_>> {
        let app = self.app.clone();
        Box::pin(async move {
            let Some(state) = app.try_state::<crate::commands::auth::AuthState>() else {
                return Err(atlas_artifacts::Error::Unauthorized("auth is not ready".into()));
            };
            state.core().mint_access_token().await.map_err(|e| match e {
                // INDETERMINATE — a transport failure, DNS, a timeout, a 5xx:
                // we learned NOTHING about the credential. It must arrive as a
                // transport failure, because the socket supervisor retires a
                // Project on an auth refusal and merely backs off on a
                // transport one. Flattening the two is what made a Wi-Fi switch
                // kill chat for a whole session.
                crate::auth::AuthFailure::Indeterminate { ref reason, .. } => {
                    atlas_artifacts::Error::Transport(reason.clone())
                }
                other => atlas_artifacts::Error::Unauthorized(format!("{other:?}")),
            })
        })
    }
}

/// Stand the manager up and bridge its events onto the window channel.
pub fn install(app: &AppHandle) {
    let tokens = Arc::new(AppTokenSource { app: app.clone() });
    let client = match ArtifactsClient::new(tokens.clone()) {
        Ok(client) => Arc::new(client),
        Err(e) => {
            // Degrade rather than refuse: without a cloud reader the Timeline
            // is exactly the offline product, which is a complete one.
            tracing::error!(target: "atlas_artifacts", "no artifacts client: {e}");
            return;
        }
    };

    let board = Arc::new(CloudBoard::new());
    // `setup` runs on the main thread, outside the runtime — a constructor that
    // spawns would panic with no reactor entered.
    let manager = {
        let handle = tauri::async_runtime::handle();
        let _guard = handle.inner().enter();
        ArtifactsManager::new(tokens, board.clone())
    };

    app.manage(ArtifactsCloudState {
        manager: manager.clone(),
        board,
        client,
        org: std::sync::Mutex::new(None),
        targets: std::sync::Mutex::new((None, Vec::new())),
    });

    // Forward the crate's broadcast onto the one window channel.
    let forward_app = app.clone();
    let mut rx = manager.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event) => emit(&forward_app, event),
                // We fell behind and frames were dropped. A resync is the only
                // honest answer: the renderer re-reads rather than carrying a
                // gap it cannot see.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(target: "atlas_artifacts", "event bridge lagged {n} frames");
                    emit(&forward_app, ArtifactsEvent::Resync);
                }
                Err(_) => break,
            }
        }
    });

    // The board refresher. A Project nobody on this machine has bound has no
    // socket, so this tick is the only thing that ever surfaces it.
    let refresh_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(REFRESH_INTERVAL);
        loop {
            ticker.tick().await;
            refresh_board(&refresh_app).await;
        }
    });
}

/// What the renderer receives on [`ARTIFACTS_EVENT`].
///
/// Flat and `kind`-tagged, matching `atlas:agents` — one channel, payload-typed,
/// rather than a channel per shape.
///
/// `rename_all` on an enum renames the **variants** only; the fields inside
/// need `rename_all_fields`, or `session_id` goes out as written and the
/// renderer's `payload.sessionId` filter drops every frame. That was the whole
/// of the "comments aren't live" bug — see the test below.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum WireEvent {
    BoardChanged,
    EntryUpsert {
        session_id: String,
        change: String,
        entry: serde_json::Value,
    },
    CommentUpsert {
        session_id: String,
        comment: Comment,
    },
    Presence {
        project_id: String,
        online: Vec<String>,
    },
    Revoked {
        project_id: String,
    },
    Resync,
}

fn emit(app: &AppHandle, event: ArtifactsEvent) {
    let wire = match event {
        // The board already re-reads on this; growing a second refresh route
        // would mean two ways for the list to be stale in different places.
        ArtifactsEvent::BoardChanged { .. } => {
            let _ = app.emit(crate::commands::capture::CAPTURE_CHANGED, ());
            WireEvent::BoardChanged
        }
        ArtifactsEvent::EntryUpsert { session_id, change, entry, .. } => {
            WireEvent::EntryUpsert { session_id, change, entry }
        }
        ArtifactsEvent::CommentUpsert { session_id, comment, .. } => {
            WireEvent::CommentUpsert { session_id, comment: *comment }
        }
        ArtifactsEvent::Presence { key, online } => {
            WireEvent::Presence { project_id: key.1, online }
        }
        ArtifactsEvent::Revoked { key } => WireEvent::Revoked { project_id: key.1 },
        ArtifactsEvent::Resync => WireEvent::Resync,
    };
    if let Err(e) = app.emit(ARTIFACTS_EVENT, &wire) {
        tracing::error!(target: "atlas_artifacts", "failed to emit {ARTIFACTS_EVENT}: {e}");
    }
}

/// Re-read the Organisation's board into the cache.
///
/// A failure is logged and dropped rather than surfaced: the board still has
/// its local rows, and a toast every fifteen seconds on a flaky connection
/// would be worse than a quietly stale remote half.
async fn refresh_board(app: &AppHandle) {
    let Some(state) = app.try_state::<ArtifactsCloudState>() else { return };
    let Some(org_id) = state.org_id() else { return };

    match state.client.board(&org_id, None).await {
        Ok(page) => {
            state
                .board
                .replace(&org_id, page.sessions, page.workspaces, page.notes);
        }
        Err(e) => {
            tracing::debug!(target: "atlas_artifacts", "board refresh failed: {e}");
            // The wait has to end either way, or a board that cannot reach the
            // server sits on its loading skeleton for ever.
            state.board.mark_attempted(&org_id);
        }
    }
    // Both arms: the board is waiting on this to stop showing a skeleton, and a
    // failed refresh is still an answer.
    let _ = app.emit(crate::commands::capture::CAPTURE_CHANGED, ());
}

/// Point the cloud half at an Organisation and this machine's projects.
///
/// Takes project **paths**, not server ids: which of them are bound to Cloud,
/// and what their server ids are, is read from each store's binding here. The
/// renderer has the paths already and has no business opening bindings to
/// answer a question Rust can answer from the same data.
///
/// Called on sign-in, on an Organisation switch, and whenever a binding
/// changes. A different `org_id` clears everything first: the incoming tenant
/// must not inherit the previous one's rows, even for a frame.
#[tauri::command]
pub async fn artifacts_cloud_retarget(
    org_id: Option<String>,
    project_paths: Vec<String>,
    app: AppHandle,
) -> Result<(), String> {
    let Some(state) = app.try_state::<ArtifactsCloudState>() else {
        return Err("artifacts cloud is not ready".into());
    };
    if let Ok(mut targets) = state.targets.lock() {
        *targets = (org_id.clone(), project_paths.clone());
    }
    apply_targets(&app, org_id, project_paths).await
}

/// Re-run targeting after a binding changed on this side.
///
/// `capture_connect`, `capture_promote`, `capture_register_cloud` and
/// `capture_disable` all change which Projects should hold a socket, and none
/// of them changes anything the renderer's retarget effect watches. Replays the
/// renderer's last inputs plus `touched`, so a Project bound before the
/// renderer ever listed it is still reached. Spawned, never awaited: the
/// callers hold nothing this needs, and a binding write must not wait on a
/// board refresh.
pub fn resync_targets(app: &AppHandle, touched: Option<&str>) {
    let Some(state) = app.try_state::<ArtifactsCloudState>() else { return };
    let (org_id, mut project_paths) =
        state.targets.lock().map(|t| t.clone()).unwrap_or_default();
    if let Some(path) = touched {
        if !project_paths.iter().any(|p| p == path) {
            project_paths.push(path.to_string());
        }
    }
    tracing::info!(
        target: "atlas_artifacts",
        "resync targets after a binding change ({} paths, touched={touched:?})",
        project_paths.len()
    );
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = apply_targets(&app, org_id, project_paths).await {
            tracing::warn!(target: "atlas_artifacts", "resync targets failed: {e}");
        }
    });
}

/// The body of a retarget: reconcile the manager against the bindings that
/// are Cloud in this Organisation, then paint from the network once.
async fn apply_targets(
    app: &AppHandle,
    org_id: Option<String>,
    project_paths: Vec<String>,
) -> Result<(), String> {
    let Some(state) = app.try_state::<ArtifactsCloudState>() else {
        return Err("artifacts cloud is not ready".into());
    };

    let changed = {
        let Ok(mut current) = state.org.lock() else {
            return Err("artifacts cloud state is poisoned".into());
        };
        let changed = *current != org_id;
        current.clone_from(&org_id);
        changed
    };

    let Some(org_id) = org_id else {
        state.manager.shutdown();
        return Ok(());
    };
    if changed {
        state.board.clear();
    }

    let project_ids = {
        let org_id = org_id.clone();
        tauri::async_runtime::spawn_blocking(move || connected_projects(&project_paths, &org_id))
            .await
            .map_err(|e| e.to_string())?
    };
    state.manager.retarget(&org_id, project_ids);

    // Paint from the network once immediately rather than waiting a whole tick
    // — a switch that shows an empty remote half for fifteen seconds reads as
    // "this Organisation has no work".
    refresh_board(app).await;
    Ok(())
}

/// The server Project ids this machine has bound to Cloud, in this Organisation.
///
/// Scoped to the Organisation on purpose: a project bound to a *different*
/// tenant must not get a socket opened against the one currently active. The
/// ids would not resolve there, and the attempt would look like a 404 rather
/// than the scoping mistake it is.
fn connected_projects(project_paths: &[String], org_id: &str) -> Vec<String> {
    let mut out = Vec::new();
    for path in project_paths {
        // An unreadable store is a Project with no cloud binding as far as this
        // is concerned — it cannot be worse than that, and one bad store must
        // not cost every other Project its socket.
        let Ok(Some(store)) = crate::commands::capture::open_reader(path) else {
            continue;
        };
        let Ok(Some(binding)) = store.binding() else { continue };
        if !is_cloud_bound(&binding, org_id) {
            continue;
        }
        match binding.remote_workspace_id {
            Some(id) => out.push(id),
            // A binding from before the column existed drains by slug but has
            // no id to open a socket against. Worth one line, because such a
            // Project looks synced on the board and silently never goes live.
            None => tracing::debug!(
                target: "atlas_artifacts",
                "{path}: cloud binding has no remote workspace id; no socket"
            ),
        }
    }
    out.sort();
    out.dedup();
    out
}

/// Is this binding one this Organisation's sockets and comments apply to?
///
/// Cloud mode, still enabled, and bound to *this* tenant. The remote id is
/// checked by the caller because a missing one is worth a log line here and a
/// plain `None` elsewhere.
pub(crate) fn is_cloud_bound(binding: &atlas_checkpoint::Binding, org_id: &str) -> bool {
    binding.mode == atlas_checkpoint::ProjectMode::Cloud
        && binding.enabled
        && binding.org_id.as_deref() == Some(org_id)
}

/// The cloud identity of a live chat session, or `None` when comments do not
/// apply to it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentTarget {
    /// The server Project id — what every `artifacts_cloud_*` call wants.
    pub remote_project_id: String,
    /// The captured Session row id, which is also its id on the server.
    pub session_id: String,
    pub entries: Vec<atlas_checkpoint::AnchorEntry>,
}

/// What a live chat session is called in the cloud, and which of its rows can
/// carry a comment.
///
/// `None` unless all three hold: a synced Organisation is targeted, the
/// Project is bound to Cloud for it, and the session has been captured (its
/// first prompt creates the row). The renderer asks again after each turn —
/// the read is two indexed selects.
#[tauri::command]
pub async fn chat_comment_target(
    project_path: String,
    native_session_id: String,
    app: AppHandle,
) -> Result<Option<CommentTarget>, String> {
    let Some(state) = app.try_state::<ArtifactsCloudState>() else { return Ok(None) };
    let Some(org_id) = state.org_id() else { return Ok(None) };
    tauri::async_runtime::spawn_blocking(move || {
        let Some(store) = crate::commands::capture::open_reader(&project_path)? else {
            return Ok(None);
        };
        let Ok(Some(binding)) = store.binding() else { return Ok(None) };
        if !is_cloud_bound(&binding, &org_id) {
            return Ok(None);
        }
        let Some(remote_project_id) = binding.remote_workspace_id else { return Ok(None) };
        let Some(session_id) = recorded_session_id(&store, &project_path, &native_session_id)?
        else {
            return Ok(None);
        };
        let entries =
            atlas_checkpoint::session_anchors(&store, &session_id).map_err(|e| e.to_string())?;
        Ok(Some(CommentTarget { remote_project_id, session_id, entries }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The captured row a live chat session is recorded in, which is also its id
/// on the server — the "current session" join. A chat is keyed by the id its
/// agent answered with; the row by `(Project, source, that id)`, and which
/// source recorded it is not known here, so both are tried.
///
/// Shared by [`chat_comment_target`] and the organisation tool server's
/// current recorded session, so the chat's comment pane and the agent can
/// never disagree about which recorded session a chat is.
pub(crate) fn recorded_session_id(
    store: &atlas_checkpoint::Store,
    project_path: &str,
    native_session_id: &str,
) -> Result<Option<String>, String> {
    use atlas_checkpoint::Source;
    let workspace_id = crate::commands::capture::project_id_for(std::path::Path::new(project_path));
    for source in [Source::Acp, Source::Native] {
        let row_id = store
            .session_id_for(&workspace_id, source, native_session_id)
            .map_err(|e| e.to_string())?;
        if row_id.is_some() {
            return Ok(row_id);
        }
    }
    Ok(None)
}

/// Follow one Session's entries and comments in realtime.
///
/// Opens (or shares) a socket subscribed to that Session — for any Project in
/// the Organisation, bound on this machine or not. Recorded even before an
/// Organisation is targeted; the manager dials it when one is.
#[tauri::command]
pub async fn artifacts_cloud_follow(
    project_id: String,
    session_id: String,
    app: AppHandle,
) -> Result<(), String> {
    let Some(state) = app.try_state::<ArtifactsCloudState>() else { return Ok(()) };
    state.manager.follow(&project_id, &session_id);
    Ok(())
}

/// Stop following a Session. The socket closes once nobody else follows it.
#[tauri::command]
pub async fn artifacts_cloud_unfollow(
    project_id: String,
    session_id: String,
    app: AppHandle,
) -> Result<(), String> {
    let Some(state) = app.try_state::<ArtifactsCloudState>() else { return Ok(()) };
    state.manager.unfollow(&project_id, &session_id);
    Ok(())
}

/// One remote Session in full, in the same shape a local one comes back in.
///
/// Mapped here rather than in the crate because only this layer can see both
/// `atlas_artifacts` and `atlas_checkpoint`, and the viewer must not learn that
/// a Session can arrive in two shapes — a second wire format for remote rows
/// would fork every renderer it touches.
#[tauri::command]
pub async fn artifacts_cloud_session(
    project_id: String,
    session_id: String,
    app: AppHandle,
) -> Result<atlas_checkpoint::SessionDetail, String> {
    let (client, org_id) = reader(&app)?;
    let page = client
        .session_detail(&org_id, &project_id, &session_id)
        .await
        .map_err(|e| e.to_string())?;

    Ok(atlas_checkpoint::SessionDetail {
        summary: crate::commands::capture::remote_summary(page.summary),
        entries: page.entries.iter().map(remote_entry).collect(),
        counts: atlas_checkpoint::EntryCounts {
            prompts: page.counts.prompts,
            responses: page.counts.responses,
            thinking: page.counts.thinking,
            tool_calls: page.counts.tool_calls,
            checkpoints: page.counts.checkpoints,
        },
        tools: page
            .tools
            .into_iter()
            .map(|t| atlas_checkpoint::ToolTally { tool_name: t.tool_name, count: t.count })
            .collect(),
    })
}

/// Fold one wire entry into the local read model.
///
/// Two local fields stay empty, and neither is an oversight:
///
/// * `commit_subject` — resolved by running `git show` in the repository, which
///   only the machine holding that checkout can do. A remote Checkpoint shows
///   its sha and its stats without a subject.
/// * the `*_ref` blob keys — the server does not expose blob keys at all. An
///   oversized body is fetched by `rowId` and a part name instead, which is
///   what `artifacts_cloud_payload` is for. Leaving these `None` is what stops
///   the viewer offering a local blob read that would find nothing.
fn remote_entry(entry: &atlas_artifacts::RemoteEntry) -> atlas_checkpoint::TimelineEntry {
    atlas_checkpoint::TimelineEntry {
        id: entry.id.clone(),
        kind: parse_enum(&entry.kind).unwrap_or(atlas_checkpoint::EntryKind::Response),
        at: entry.at.clone(),
        turn_seq: entry.turn_seq,
        text: entry.text.clone(),
        truncated: entry.truncated,
        body_bytes: entry.body_bytes,
        body_ref: None,
        tool_name: entry.tool_name.clone(),
        tool_title: entry.tool_title.clone(),
        tool_status: entry.tool_status.as_deref().and_then(parse_enum),
        paths: entry.paths.clone(),
        arguments: entry.arguments.clone(),
        arguments_ref: None,
        result: entry.result.clone(),
        result_ref: None,
        result_binary: entry.result_binary,
        commit_sha: entry.commit_sha.clone(),
        commit_subject: None,
        branch: entry.branch.clone(),
        link_state: entry.link_state.as_deref().and_then(parse_enum),
        insertions: entry.insertions,
        deletions: entry.deletions,
        files: entry.files.clone(),
    }
}

/// Read one of the read model's string-tagged enums off the wire.
///
/// Through serde rather than a hand-written match, so the spellings can only
/// ever be the ones the type itself declares — a `snake_case` rename changing
/// on the Rust side updates this for free instead of silently falling back.
fn parse_enum<T: serde::de::DeserializeOwned>(raw: &str) -> Option<T> {
    serde_json::from_value(serde_json::Value::String(raw.to_string())).ok()
}

/// Re-read the Organisation's board now.
///
/// The retry behind the "couldn't load" notice. Answers whether the board is
/// still failing, so the caller can leave the notice up rather than guess —
/// `refresh_board` swallows its own errors by design (a toast every fifteen
/// seconds on a flaky connection is worse than a stale board).
#[tauri::command]
pub async fn artifacts_cloud_refresh(app: AppHandle) -> Result<bool, String> {
    refresh_board(&app).await;
    let Some(state) = app.try_state::<ArtifactsCloudState>() else { return Ok(false) };
    let Some(org_id) = state.org_id() else { return Ok(false) };
    Ok(!state.board.has_failed(&org_id))
}

/// The web app's address for a shared Session, for copying or opening.
///
/// `None` when the Session is not on the server, so a caller can offer the id
/// instead rather than a link that goes nowhere.
#[tauri::command]
pub async fn artifacts_cloud_session_url(
    project_id: String,
    session_id: String,
    app: AppHandle,
) -> Result<Option<String>, String> {
    let Some(state) = app.try_state::<ArtifactsCloudState>() else { return Ok(None) };
    let Some(org_id) = state.org_id() else { return Ok(None) };
    Ok(Some(atlas_artifacts::session_web_url(&org_id, &project_id, &session_id)))
}

/// The full text behind a truncated remote entry.
///
/// The remote twin of `artifacts_payload`, which reads this machine's blob
/// sidecar — a Session captured elsewhere has no entry there.
#[tauri::command]
pub async fn artifacts_cloud_payload(
    project_id: String,
    session_id: String,
    row_id: String,
    part: String,
    app: AppHandle,
) -> Result<crate::commands::capture::ArtifactPayload, String> {
    let (client, org_id) = reader(&app)?;
    let payload = client
        .entry_payload(&org_id, &project_id, &session_id, &row_id, &part)
        .await
        .map_err(|e| e.to_string())?;
    Ok(crate::commands::capture::ArtifactPayload {
        text: payload.text,
        binary: payload.binary,
        bytes: payload.bytes.max(0) as usize,
    })
}

/// One Session's comments, grouped by what they are attached to.
///
/// Grouped here rather than in the renderer because the server has neither a
/// per-anchor count nor an aggregate: this one read is both the threads and the
/// counts, and doing the bucketing twice on two sides would let them disagree.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentThreads {
    /// Anchor id → that anchor's comments, oldest first, roots and replies
    /// together. The anchor id is the entry's `rowId`, which is the same id the
    /// local store minted — so a caller looks these up with what it already has.
    pub by_anchor: std::collections::HashMap<String, Vec<Comment>>,
    /// Comments on the Session itself.
    pub session: Vec<Comment>,
}

#[tauri::command]
pub async fn artifacts_cloud_comments(
    project_id: String,
    session_id: String,
    app: AppHandle,
) -> Result<CommentThreads, String> {
    let (client, org_id) = reader(&app)?;
    let comments = client
        .comments(&org_id, &project_id, &session_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(group(comments))
}

/// Split a flat comment list into per-anchor buckets.
fn group(comments: Vec<Comment>) -> CommentThreads {
    let mut by_anchor: std::collections::HashMap<String, Vec<Comment>> =
        std::collections::HashMap::new();
    let mut session = Vec::new();
    for comment in comments {
        if comment.anchor_kind == AnchorKind::Session {
            session.push(comment);
        } else {
            by_anchor.entry(comment.anchor_id.clone()).or_default().push(comment);
        }
    }
    CommentThreads { by_anchor, session }
}

#[tauri::command]
pub async fn artifacts_cloud_comment_create(
    project_id: String,
    session_id: String,
    anchor_kind: String,
    anchor_id: String,
    parent_id: Option<String>,
    body: String,
    app: AppHandle,
) -> Result<Comment, String> {
    let (client, org_id) = reader(&app)?;
    let anchor_kind = parse_anchor(&anchor_kind)?;
    client
        .create_comment(
            atlas_artifacts::CommentTarget {
                org_id: &org_id,
                project_id: &project_id,
                session_id: &session_id,
            },
            atlas_artifacts::NewComment {
                anchor_kind,
                anchor_id: &anchor_id,
                parent_id: parent_id.as_deref(),
                body: &body,
            },
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn artifacts_cloud_comment_update(
    project_id: String,
    session_id: String,
    comment_id: String,
    body: Option<String>,
    resolved: Option<bool>,
    app: AppHandle,
) -> Result<Comment, String> {
    let (client, org_id) = reader(&app)?;
    client
        .update_comment(
            &org_id,
            &project_id,
            &session_id,
            &comment_id,
            body.as_deref(),
            resolved,
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn artifacts_cloud_comment_delete(
    project_id: String,
    session_id: String,
    comment_id: String,
    app: AppHandle,
) -> Result<Comment, String> {
    let (client, org_id) = reader(&app)?;
    client
        .delete_comment(&org_id, &project_id, &session_id, &comment_id)
        .await
        .map_err(|e| e.to_string())
}

/// The client and the Organisation it is pointed at, or a legible refusal.
fn reader(app: &AppHandle) -> Result<(Arc<ArtifactsClient>, String), String> {
    let state = app
        .try_state::<ArtifactsCloudState>()
        .ok_or("artifacts cloud is not ready")?;
    let org_id = state
        .org_id()
        .ok_or("sign in to a synced Organisation to use the shared timeline")?;
    Ok((Arc::clone(&state.client), org_id))
}

fn parse_anchor(raw: &str) -> Result<AnchorKind, String> {
    match raw {
        "session" => Ok(AnchorKind::Session),
        "message" => Ok(AnchorKind::Message),
        "tool_call" => Ok(AnchorKind::ToolCall),
        "checkpoint" => Ok(AnchorKind::Checkpoint),
        other => Err(format!("unknown anchor kind: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn comment(id: &str, kind: AnchorKind, anchor: &str, parent: Option<&str>) -> Comment {
        Comment {
            id: id.into(),
            session_id: "ses_1".into(),
            anchor_kind: kind,
            anchor_id: anchor.into(),
            parent_id: parent.map(str::to_string),
            author_id: "user_ada".into(),
            guest_name: None,
            body: Some("hi".into()),
            mentions: Vec::new(),
            created_at: "2026-09-20T10:00:00.000Z".into(),
            edited_at: None,
            deleted_at: None,
            resolved_at: None,
            resolved_by: None,
        }
    }

    #[test]
    fn wire_events_carry_camel_case_fields() {
        // The renderer filters on `payload.sessionId` / `payload.projectId`.
        // A snake_case key here is not a type error anywhere — it is a frame
        // that arrives, matches on `kind`, and is then dropped by the id
        // comparison, which is exactly how comments stopped being live.
        let frames = [
            WireEvent::CommentUpsert {
                session_id: "ses_1".into(),
                comment: comment("c1", AnchorKind::Message, "msg_1", None),
            },
            WireEvent::EntryUpsert {
                session_id: "ses_1".into(),
                change: "updated".into(),
                entry: serde_json::json!({ "id": "msg_1" }),
            },
            WireEvent::Presence { project_id: "ws_1".into(), online: vec!["user_ada".into()] },
            WireEvent::Revoked { project_id: "ws_1".into() },
        ];
        for frame in frames {
            let json = serde_json::to_value(&frame).unwrap();
            let keys: Vec<&str> = json.as_object().unwrap().keys().map(String::as_str).collect();
            assert!(!keys.contains(&"session_id"), "{json}");
            assert!(!keys.contains(&"project_id"), "{json}");
            assert!(
                keys.contains(&"sessionId") || keys.contains(&"projectId"),
                "{json}"
            );
        }
        // The kind tag itself is what the renderer switches on.
        let json = serde_json::to_value(WireEvent::CommentUpsert {
            session_id: "ses_1".into(),
            comment: comment("c1", AnchorKind::Message, "msg_1", None),
        })
        .unwrap();
        assert_eq!(json["kind"], "commentUpsert");
        assert_eq!(json["sessionId"], "ses_1");
        assert_eq!(json["comment"]["anchorId"], "msg_1");
    }

    #[test]
    fn session_comments_are_kept_apart_from_anchored_ones() {
        // A session-level comment carries the Session id as its anchor. Bucketed
        // by anchor id alone it would land on whatever row shares that id.
        let threads = group(vec![
            comment("c1", AnchorKind::Session, "ses_1", None),
            comment("c2", AnchorKind::Message, "msg_1", None),
        ]);
        assert_eq!(threads.session.len(), 1);
        assert_eq!(threads.by_anchor.len(), 1);
        assert!(threads.by_anchor.contains_key("msg_1"));
    }

    #[test]
    fn replies_stay_with_their_anchor_so_the_count_is_the_thread_length() {
        // The count on a node is the whole thread, roots and replies — which is
        // what the web shows, and there is no count endpoint to disagree with.
        let threads = group(vec![
            comment("c1", AnchorKind::ToolCall, "tc_1", None),
            comment("c2", AnchorKind::ToolCall, "tc_1", Some("c1")),
            comment("c3", AnchorKind::ToolCall, "tc_1", Some("c1")),
        ]);
        assert_eq!(threads.by_anchor["tc_1"].len(), 3);
    }

    #[test]
    fn grouping_preserves_the_servers_order() {
        // The server answers oldest-first and the viewer renders in that order;
        // re-sorting here would fight it.
        let threads = group(vec![
            comment("c1", AnchorKind::Checkpoint, "cp_1", None),
            comment("c2", AnchorKind::Checkpoint, "cp_1", Some("c1")),
        ]);
        let ids: Vec<&str> = threads.by_anchor["cp_1"].iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["c1", "c2"]);
    }

    #[test]
    fn every_entry_kind_the_server_sends_round_trips() {
        // Parsed through serde against the read model's own `snake_case`
        // spellings. A silent fallback here would render every tool call as a
        // response, which looks like data loss rather than a mapping bug.
        for (wire, expected) in [
            ("prompt", atlas_checkpoint::EntryKind::Prompt),
            ("response", atlas_checkpoint::EntryKind::Response),
            ("thinking", atlas_checkpoint::EntryKind::Thinking),
            ("tool_call", atlas_checkpoint::EntryKind::ToolCall),
            ("checkpoint", atlas_checkpoint::EntryKind::Checkpoint),
        ] {
            let entry = atlas_artifacts::RemoteEntry {
                id: "row_1".into(),
                kind: wire.into(),
                at: "2026-09-20T10:00:00.000Z".into(),
                ..Default::default()
            };
            assert_eq!(remote_entry(&entry).kind, expected, "kind {wire}");
        }
    }

    #[test]
    fn an_entry_that_omits_everything_optional_still_maps() {
        // The server omits a field that does not apply rather than sending a
        // zero — a Checkpoint has no tool status, a prompt no insertions. A
        // mapper that required them would drop every row.
        let entry = atlas_artifacts::RemoteEntry {
            id: "row_1".into(),
            kind: "prompt".into(),
            at: "2026-09-20T10:00:00.000Z".into(),
            ..Default::default()
        };
        let mapped = remote_entry(&entry);
        assert_eq!(mapped.id, "row_1");
        assert_eq!(mapped.tool_status, None);
        assert_eq!(mapped.insertions, 0);
        assert!(mapped.paths.is_empty());
    }

    #[test]
    fn a_remote_entry_never_claims_a_local_blob() {
        // The `*_ref` keys address this machine's blob sidecar, which holds
        // nothing for a Session captured elsewhere. Populating them would make
        // the viewer offer a "Show full" that can only fail.
        let entry = atlas_artifacts::RemoteEntry {
            id: "row_1".into(),
            kind: "response".into(),
            at: "2026-09-20T10:00:00.000Z".into(),
            text: Some("preview".into()),
            truncated: true,
            body_bytes: 900_000,
            ..Default::default()
        };
        let mapped = remote_entry(&entry);
        assert_eq!(mapped.body_ref, None);
        assert_eq!(mapped.arguments_ref, None);
        assert_eq!(mapped.result_ref, None);
        // …but it must still say the body is short, so the reader is not told a
        // 900 KB response was 2 KB long.
        assert!(mapped.truncated);
        assert_eq!(mapped.body_bytes, 900_000);
    }

    #[test]
    fn a_tool_call_carries_its_status_and_paths() {
        let entry = atlas_artifacts::RemoteEntry {
            id: "tc_1".into(),
            kind: "tool_call".into(),
            at: "2026-09-20T10:00:00.000Z".into(),
            tool_name: Some("Bash".into()),
            tool_status: Some("failed".into()),
            paths: vec!["src/main.rs".into()],
            ..Default::default()
        };
        let mapped = remote_entry(&entry);
        assert_eq!(mapped.tool_status, Some(atlas_checkpoint::ToolStatus::Failed));
        assert_eq!(mapped.paths, vec!["src/main.rs".to_string()]);
    }

    #[test]
    fn a_remote_checkpoint_has_no_commit_subject() {
        // Resolving one means running `git show` in the repository, which only
        // the machine holding that checkout can do.
        let entry = atlas_artifacts::RemoteEntry {
            id: "cp_1".into(),
            kind: "checkpoint".into(),
            at: "2026-09-20T10:00:00.000Z".into(),
            commit_sha: Some("9f2c1ab".into()),
            link_state: Some("linked".into()),
            insertions: 12,
            ..Default::default()
        };
        let mapped = remote_entry(&entry);
        assert_eq!(mapped.commit_sha.as_deref(), Some("9f2c1ab"));
        assert_eq!(mapped.link_state, Some(atlas_checkpoint::LinkState::Linked));
        assert_eq!(mapped.commit_subject, None);
        assert_eq!(mapped.insertions, 12);
    }

    #[test]
    fn every_anchor_the_server_accepts_parses() {
        assert!(parse_anchor("session").is_ok());
        assert!(parse_anchor("message").is_ok());
        assert!(parse_anchor("tool_call").is_ok());
        assert!(parse_anchor("checkpoint").is_ok());
        // camelCase is the server's 422, so catch it here with a legible error.
        assert!(parse_anchor("toolCall").is_err());
    }
}
