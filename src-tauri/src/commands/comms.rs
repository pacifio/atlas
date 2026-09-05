//! Team chat: the bridge between `atlas-comms` and the renderer.
//!
//! Every route to the chat host goes through here because only Rust holds the
//! Bearer. The renderer invokes these commands and applies the events emitted
//! on `atlas:comms`; it decides nothing, exactly as `auth-store` does not.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use atlas_comms::events::WireMessage;
use atlas_comms::manager::to_wire;
use atlas_comms::rest::ConversationPatch;
use atlas_comms::wire::{Conversation, ReactionRow, ReadState};
use atlas_comms::{
    chat_base, CommsError, CommsManager, CommsStore, ConnectionState, OrgTarget, TokenSource,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// The window event channel. One per subsystem, as `atlas:agents` is.
pub const COMMS_EVENT: &str = "atlas:comms";

pub struct CommsState(pub CommsManager);

/// Mints the access JWT from the account session.
///
/// Resolves `AuthState` per call rather than holding it: this source is built
/// during `setup`, where registration order is not guaranteed, and a captured
/// handle would be wrong for the life of the process if it were built early.
struct AppTokenSource {
    app: AppHandle,
}

impl TokenSource for AppTokenSource {
    fn mint(&self) -> Pin<Box<dyn Future<Output = atlas_comms::Result<String>> + Send + '_>> {
        let app = self.app.clone();
        Box::pin(async move {
            let Some(state) = app.try_state::<crate::commands::auth::AuthState>() else {
                return Err(CommsError::Token("auth is not ready".into()));
            };
            let core = state.core();
            core.mint_access_token()
                .await
                .map_err(|e| CommsError::Token(format!("{e:?}")))
        })
    }
}

/// Stand the manager up and bridge its events onto the window channel.
pub fn install(app: &AppHandle) {
    let config_dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir());

    let store = match CommsStore::open(&atlas_comms::db_path(&config_dir)) {
        Ok(store) => store,
        Err(e) => {
            // Degrade rather than refuse: chat still works without a local
            // snapshot, it just re-syncs on every launch instead of painting
            // from disk.
            tracing::error!(target: "atlas_comms", "comms store unavailable, using memory: {e}");
            match CommsStore::open_in_memory() {
                Ok(store) => store,
                Err(e) => {
                    tracing::error!(target: "atlas_comms", "no comms store at all: {e}");
                    return;
                }
            }
        }
    };

    let tokens = Arc::new(AppTokenSource { app: app.clone() });

    // `setup` runs on the main thread, outside the runtime — a constructor that
    // spawns would panic with no reactor entered.
    let manager = {
        let handle = tauri::async_runtime::handle();
        let _guard = handle.inner().enter();
        CommsManager::new(store, tokens.clone())
    };
    app.manage(CommsState(manager.clone()));

    // The Spaces sockets (one per open canvas) share the token source but are
    // otherwise a separate subsystem: nothing they carry is journaled.
    let spaces = {
        let handle = tauri::async_runtime::handle();
        let _guard = handle.inner().enter();
        atlas_comms::spaces::SpacesManager::new(tokens.clone())
    };
    app.manage(crate::commands::spaces::SpacesState(spaces.clone()));
    let spaces_app = app.clone();
    let mut spaces_rx = spaces.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            match spaces_rx.recv().await {
                Ok(envelope) => {
                    if let Err(e) =
                        spaces_app.emit(crate::commands::spaces::SPACES_EVENT, &envelope)
                    {
                        tracing::error!(target: "atlas_comms", "failed to emit spaces event: {e}");
                    }
                }
                // Lagging drops frames, and a dropped Yjs update would fork the
                // doc — but the renderer heals on the next `page.opened`
                // (re-open with `since`), so the honest move is to keep going.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(target: "atlas_comms", "spaces bridge lagged {n} frames");
                }
                Err(_) => break,
            }
        }
    });

    // Forward the crate's broadcast onto the one window channel.
    let forward_app = app.clone();
    let mut rx = manager.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(envelope) => {
                    tracing::debug!(
                        target: "atlas_comms::bridge",
                        "emit epoch={} {:?}", envelope.epoch, envelope.ev
                    );
                    if let Err(e) = forward_app.emit(COMMS_EVENT, &envelope) {
                        tracing::error!(target: "atlas_comms", "failed to emit {COMMS_EVENT}: {e}");
                    }
                }
                // We fell behind and frames were dropped. A resync is the only
                // honest answer: the renderer re-reads the snapshot rather than
                // carrying a gap it cannot see.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(target: "atlas_comms", "event bridge lagged {n} frames");
                    let _ = forward_app.emit(
                        COMMS_EVENT,
                        serde_json::json!({ "org": "", "epoch": 0, "ev": { "kind": "resync" } }),
                    );
                }
                Err(_) => break,
            }
        }
    });

    // Sends that never got an ack become visibly failed rather than silently
    // stuck. Frames carry no correlation id, so a timer is the honest signal.
    let sweep = manager;
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(5));
        loop {
            ticker.tick().await;
            sweep.expire_stale_sends();
        }
    });
}

/// Point the socket at whatever the auth snapshot says is active.
///
/// Called from `auth::broadcast`, which every transition funnels through —
/// launch restore, sign-in, sign-out and `auth_set_active_org` alike. That is
/// why there is no separate "connect" command: changing the active org *is* the
/// connect path.
pub fn retarget(app: &AppHandle, snapshot: &crate::auth::AuthSnapshot) {
    let Some(state) = app.try_state::<CommsState>() else {
        tracing::warn!(target: "atlas_comms::bridge", "retarget before CommsState was managed");
        return;
    };
    tracing::debug!(
        target: "atlas_comms::bridge",
        "retarget from auth snapshot: {}",
        match snapshot {
            crate::auth::AuthSnapshot::SignedIn { active_org_id, orgs, .. } => format!(
                "signed-in active_org={:?} orgs_known={}",
                active_org_id,
                orgs.is_some()
            ),
            crate::auth::AuthSnapshot::Connecting { .. } => "connecting".into(),
            crate::auth::AuthSnapshot::SignedOut => "signed-out".into(),
        }
    );
    let target = match snapshot {
        crate::auth::AuthSnapshot::SignedIn { active_org_id, .. } => active_org_id
            .as_ref()
            .map(|org_id| OrgTarget {
                org_id: org_id.clone(),
            }),
        // Signed out, or mid-grant: there is no credential to dial with.
        _ => None,
    };
    // A Space socket is only valid for the org it was opened under. On any org
    // change (or sign-out) they all die; the tabs redial on their own when the
    // renderer sees the connection drop and the org settle.
    let changed = state.0.org_id() != target.as_ref().map(|t| t.org_id.clone());
    if changed {
        if let Some(spaces) = app.try_state::<crate::commands::spaces::SpacesState>() {
            spaces.0.disconnect_all();
        }
    }
    state.0.set_target(target);
}

pub(crate) fn manager(app: &AppHandle) -> Result<CommsManager, String> {
    app.try_state::<CommsState>()
        .map(|s| s.0.clone())
        .ok_or_else(|| "chat is not ready".to_string())
}

pub(crate) fn org(mgr: &CommsManager) -> Result<String, String> {
    mgr.org_id()
        .ok_or_else(|| "no organisation is connected".to_string())
}

/// Errors reach the UI as their code plus message; the structured `detail` is
/// preserved for the refusals that need it — `group_dm_frozen`'s `fork_hint`,
/// `quota_exceeded`'s byte counts.
pub(crate) fn map_err(e: CommsError) -> String {
    match e {
        CommsError::Refused {
            code,
            message,
            detail,
        } => serde_json::json!({ "code": code, "message": message, "detail": detail }).to_string(),
        other => other.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Status and hydration
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfoDto {
    pub state: ConnectionState,
    pub reason: Option<atlas_comms::ConnReason>,
    pub epoch: u64,
    pub org_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommsSnapshot {
    pub connection: ConnectionInfoDto,
    pub me: Option<String>,
    pub conversations: Vec<Conversation>,
    pub discoverable: Vec<Conversation>,
    pub reads: Vec<ReadState>,
    pub online: Vec<String>,
    /// Cold-synced over REST at conversation open (ATL-208) and overlaid with
    /// journaled `call.*` frames; the snapshot carries whatever both have
    /// taught the state so far.
    pub calls: Vec<atlas_comms::wire::Call>,
}

// Deliberately NOT camelCase: `messages`/`reactions` are wire objects with
// snake_case fields, and the TS side reads `pinned_message_ids`. The camel
// rename here silently produced `pinnedMessageIds`, whose absence threw inside
// the store's merge and took the whole update — messages included — with it.
#[derive(Serialize)]
pub struct ConversationWindow {
    pub messages: Vec<WireMessage>,
    pub reactions: Vec<ReactionRow>,
    pub pinned_message_ids: Vec<String>,
}

#[derive(Serialize)]
pub struct MessagePageDto {
    pub messages: Vec<WireMessage>,
    pub has_more: bool,
}

#[tauri::command]
pub fn comms_status(app: AppHandle) -> Result<ConnectionInfoDto, String> {
    let mgr = manager(&app)?;
    let info = mgr.connection();
    Ok(ConnectionInfoDto {
        state: info.state,
        reason: info.reason,
        epoch: info.epoch,
        org_id: info.org_id,
    })
}

#[tauri::command(async)]
pub fn comms_snapshot(app: AppHandle) -> Result<CommsSnapshot, String> {
    let mgr = manager(&app)?;
    let info = mgr.connection();
    tracing::debug!(
        target: "atlas_comms::bridge",
        "snapshot requested: state={:?} conversations={}",
        info.state,
        mgr.with_state(|s| s.conversations.len())
    );
    Ok(mgr.with_state(|state| CommsSnapshot {
        connection: ConnectionInfoDto {
            state: info.state,
            reason: info.reason,
            epoch: info.epoch,
            org_id: info.org_id.clone(),
        },
        me: state.me.clone(),
        conversations: state.conversations.clone(),
        discoverable: state.discoverable.clone(),
        reads: state.reads.values().cloned().collect(),
        online: state.online.clone(),
        calls: state.calls.values().cloned().collect(),
    }))
}

/// Register a conversation as open and return its tail.
///
/// Registration matters beyond this call: a cold sync refills only the
/// conversations the UI actually has open.
#[tauri::command]
pub async fn comms_open_conversation(
    app: AppHandle,
    conv_id: String,
) -> Result<ConversationWindow, String> {
    let mgr = manager(&app)?;
    let org_id = org(&mgr)?;
    mgr.open_window(&conv_id);

    // Gate on "have we fetched this conversation's HISTORY", never on "do we
    // hold any messages for it". A resume replay hands back the events that
    // happened while we were away — commonly a single frame, our own last send,
    // because an `ack` does not advance the watermark — and treating that as a
    // loaded transcript is what made a channel render exactly one message after
    // a restart. The page merges with whatever replay delivered: `adopt_page`
    // dedupes by id and re-sorts by seq.
    let hydrated = mgr.is_hydrated(&conv_id);
    tracing::debug!(
        target: "atlas_comms::bridge",
        "open_conversation {conv_id}: hydrated={hydrated} cached={}",
        mgr.with_state(|s| s.messages(&conv_id).len())
    );
    if !hydrated {
        let page = mgr
            .rest()
            .messages(&org_id, &conv_id, None, 50)
            .await
            .map_err(|e| {
                tracing::warn!(target: "atlas_comms::bridge", "open_conversation {conv_id}: page fetch failed: {e}");
                map_err(e)
            })?;
        tracing::debug!(
            target: "atlas_comms::bridge",
            "open_conversation {conv_id}: fetched {} messages, {} reaction rows",
            page.messages.len(),
            page.reactions.len()
        );
        mgr.adopt_page(&conv_id, page.messages, false);
        mgr.adopt_reactions(page.reactions);
        mgr.mark_hydrated(&conv_id);
        if let Ok(pins) = mgr.rest().pins(&org_id, &conv_id).await {
            mgr.adopt_pins(&conv_id, pins.pins.iter().map(|p| p.message_id.clone()).collect());
        }
        // Call history rides the same hydration: REST is its only cold source
        // (ATL-208) — a watermark at the live edge replays no `call.*` frames.
        // Best-effort like pins; the transcript is usable without it.
        match mgr.rest().calls(&org_id, &conv_id).await {
            Ok(list) => {
                tracing::debug!(
                    target: "atlas_comms::bridge",
                    "open_conversation {conv_id}: fetched {} calls",
                    list.calls.len()
                );
                mgr.adopt_calls(list.calls);
            }
            Err(e) => {
                tracing::warn!(target: "atlas_comms::bridge", "open_conversation {conv_id}: calls fetch failed: {e}");
            }
        }
    }
    let win = window(&mgr, &conv_id);
    tracing::debug!(
        target: "atlas_comms::bridge",
        "open_conversation {conv_id}: window has {} messages",
        win.messages.len()
    );
    Ok(win)
}

#[tauri::command]
pub fn comms_close_conversation(app: AppHandle, conv_id: String) -> Result<(), String> {
    manager(&app)?.close_window(&conv_id);
    Ok(())
}

#[tauri::command(async)]
pub fn comms_conversation_snapshot(
    app: AppHandle,
    conv_id: String,
) -> Result<ConversationWindow, String> {
    let mgr = manager(&app)?;
    Ok(window(&mgr, &conv_id))
}

fn window(mgr: &CommsManager, conv_id: &str) -> ConversationWindow {
    mgr.with_state(|state| {
        let messages: Vec<WireMessage> = state.messages(conv_id).iter().map(to_wire).collect();
        let ids: Vec<&str> = state
            .messages(conv_id)
            .iter()
            .map(|m| m.message.id.as_str())
            .collect();
        let reactions = ids
            .iter()
            .filter_map(|id| state.reactions.get(*id))
            .flatten()
            .cloned()
            .collect();
        ConversationWindow {
            messages,
            reactions,
            pinned_message_ids: state.pins.get(conv_id).cloned().unwrap_or_default(),
        }
    })
}

/// Page backwards. Within a page messages are oldest-first, so the caller
/// appends rather than reverses.
#[tauri::command]
pub async fn comms_load_older(
    app: AppHandle,
    conv_id: String,
    before_seq: i64,
    limit: Option<u32>,
) -> Result<MessagePageDto, String> {
    let mgr = manager(&app)?;
    let org_id = org(&mgr)?;
    let page = mgr
        .rest()
        .messages(&org_id, &conv_id, Some(before_seq), limit.unwrap_or(50).min(200))
        .await
        .map_err(map_err)?;
    let has_more = page.has_more;
    mgr.adopt_page(&conv_id, page.messages.clone(), true);
    mgr.adopt_reactions(page.reactions);
    Ok(MessagePageDto {
        messages: page
            .messages
            .into_iter()
            .map(|m| to_wire(&atlas_comms::LocalMessage::settled(m)))
            .collect(),
        has_more,
    })
}


/// A conversation's prompt drafts — REST passthrough, no state. The list is
/// poll-owned by the renderer (no lifecycle frames exist to keep a cache
/// honest), so holding it here would only manufacture staleness.
#[tauri::command]
pub async fn comms_drafts(
    app: AppHandle,
    conv_id: String,
) -> Result<Vec<atlas_comms::rest::PromptDraft>, String> {
    let mgr = manager(&app)?;
    let org_id = org(&mgr)?;
    let list = mgr.rest().drafts(&org_id, &conv_id).await.map_err(map_err)?;
    Ok(list.drafts)
}

#[tauri::command]
pub async fn comms_create_draft(
    app: AppHandle,
    conv_id: String,
    title: String,
) -> Result<atlas_comms::rest::PromptDraft, String> {
    let mgr = manager(&app)?;
    let org_id = org(&mgr)?;
    mgr.rest()
        .create_draft(&org_id, &conv_id, &title)
        .await
        .map_err(map_err)
}

/// The full pin rail for a conversation, message content included.
///
/// A REST passthrough with no state mutation: the store only holds pinned
/// *ids*, but the menu wants author/body/time for messages that may be far
/// outside the loaded window — and the server already sends the message
/// riding with its pin so a rail renders in one request.
#[tauri::command]
pub async fn comms_pins(
    app: AppHandle,
    conv_id: String,
) -> Result<Vec<atlas_comms::wire::Pin>, String> {
    let mgr = manager(&app)?;
    let org_id = org(&mgr)?;
    let list = mgr.rest().pins(&org_id, &conv_id).await.map_err(map_err)?;
    Ok(list.pins)
}

// ---------------------------------------------------------------------------
// Socket verbs
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendReceipt {
    pub client_msg_id: String,
}

#[tauri::command]
pub fn comms_send(
    app: AppHandle,
    conv_id: String,
    body: String,
    reply_to_id: Option<String>,
    attachments: Option<Vec<String>>,
) -> Result<SendReceipt, String> {
    let mgr = manager(&app)?;
    // The limit is UTF-8 bytes, not characters — emoji and CJK cost 3–4×, and
    // refusing here is kinder than a server 400 after the composer cleared.
    if body.len() > atlas_comms::wire::CHAT_BODY_MAX_BYTES {
        return Err("message is too long".into());
    }
    let attachments = attachments.unwrap_or_default();
    if attachments.len() > atlas_comms::wire::CHAT_MESSAGE_ATTACHMENT_MAX {
        return Err("too many attachments".into());
    }
    // An empty body is legal ONLY with an attachment — a screenshot with no
    // caption is the ordinary case, an empty message is not.
    if body.trim().is_empty() && attachments.is_empty() {
        return Err("nothing to send".into());
    }
    Ok(SendReceipt {
        client_msg_id: mgr.send(&conv_id, body, reply_to_id, attachments),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadReceipt {
    pub file_id: String,
}

/// Upload one file and return its server file id, which a later `comms_send`
/// claims. Uploads are STAGED until a message claims them and swept after 24h,
/// so abandoning a draft leaks nothing.
///
/// `upload_id` is chosen by the renderer so it can match the progress events
/// (which start arriving before this future resolves) to its own chip.
#[tauri::command]
pub async fn comms_upload_attachment(
    app: AppHandle,
    conv_id: String,
    upload_id: String,
    path: String,
) -> Result<UploadReceipt, String> {
    let mgr = manager(&app)?;
    let file_id = mgr
        .upload_attachment(&conv_id, std::path::Path::new(&path), &upload_id)
        .await
        .map_err(map_err)?;
    Ok(UploadReceipt { file_id })
}

/// Ask a running upload to stop. Cooperative — it lands between parts.
#[tauri::command]
pub fn comms_cancel_upload(app: AppHandle, upload_id: String) -> Result<(), String> {
    manager(&app)?.cancel_upload(&upload_id);
    Ok(())
}

#[tauri::command]
pub fn comms_edit(app: AppHandle, message_id: String, body: String) -> Result<(), String> {
    manager(&app)?.edit(&message_id, body);
    Ok(())
}

#[tauri::command]
pub fn comms_delete(app: AppHandle, message_id: String) -> Result<(), String> {
    manager(&app)?.delete(&message_id);
    Ok(())
}

#[tauri::command]
pub fn comms_react(
    app: AppHandle,
    message_id: String,
    emoji: String,
    on: bool,
) -> Result<(), String> {
    manager(&app)?.react(&message_id, &emoji, on).map_err(map_err)
}

#[tauri::command]
pub fn comms_pin(app: AppHandle, message_id: String, on: bool) -> Result<(), String> {
    manager(&app)?.pin(&message_id, on);
    Ok(())
}

#[tauri::command]
pub fn comms_read(app: AppHandle, conv_id: String, seq: i64) -> Result<(), String> {
    manager(&app)?.read(&conv_id, seq);
    Ok(())
}

/// Subscribe the socket to a draft (answered with a `draftOpened` event).
#[tauri::command]
pub fn comms_draft_open(app: AppHandle, draft_id: String) -> Result<(), String> {
    manager(&app)?.draft_open(&draft_id);
    Ok(())
}

/// Opaque base64 Yjs bytes; the renderer owns debounce and retention.
#[tauri::command]
pub fn comms_draft_update(app: AppHandle, draft_id: String, update: String) -> Result<(), String> {
    manager(&app)?.draft_update(&draft_id, &update);
    Ok(())
}

#[tauri::command]
pub fn comms_draft_awareness(
    app: AppHandle,
    draft_id: String,
    state: String,
) -> Result<(), String> {
    manager(&app)?.draft_awareness(&draft_id, &state);
    Ok(())
}

#[tauri::command]
pub fn comms_typing(app: AppHandle, conv_id: String) -> Result<(), String> {
    manager(&app)?.typing(&conv_id);
    Ok(())
}

// ---------------------------------------------------------------------------
// REST verbs
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DmResultDto {
    pub conversation: Conversation,
    /// `true` = created, `false` = opened one that already existed. The server
    /// says which by 201 vs 200, and the UI reads differently for each.
    pub created: bool,
}

#[tauri::command]
pub async fn comms_create_channel(
    app: AppHandle,
    name: String,
    visibility: Option<String>,
    workspace_ref_ids: Option<Vec<String>>,
) -> Result<Conversation, String> {
    let mgr = manager(&app)?;
    let org_id = org(&mgr)?;
    mgr.rest()
        .create_channel(
            &org_id,
            &name,
            visibility.as_deref(),
            workspace_ref_ids.unwrap_or_default(),
        )
        .await
        .map_err(map_err)
}

#[tauri::command]
pub async fn comms_create_dm(app: AppHandle, user_id: String) -> Result<DmResultDto, String> {
    let mgr = manager(&app)?;
    let org_id = org(&mgr)?;
    let result = mgr.rest().create_dm(&org_id, &user_id).await.map_err(map_err)?;
    Ok(DmResultDto {
        conversation: result.conversation,
        created: result.created,
    })
}

#[tauri::command]
pub async fn comms_create_group_dm(
    app: AppHandle,
    member_ids: Vec<String>,
) -> Result<Conversation, String> {
    let mgr = manager(&app)?;
    let org_id = org(&mgr)?;
    mgr.rest()
        .create_group_dm(&org_id, member_ids)
        .await
        .map_err(map_err)
}

#[tauri::command]
pub async fn comms_join(app: AppHandle, conv_id: String) -> Result<Conversation, String> {
    let mgr = manager(&app)?;
    let org_id = org(&mgr)?;
    mgr.rest().join(&org_id, &conv_id).await.map_err(map_err)
}

#[tauri::command]
pub async fn comms_invite(app: AppHandle, conv_id: String, user_id: String) -> Result<(), String> {
    let mgr = manager(&app)?;
    let org_id = org(&mgr)?;
    mgr.rest()
        .invite(&org_id, &conv_id, &user_id)
        .await
        .map_err(map_err)
}

#[tauri::command]
pub async fn comms_leave(
    app: AppHandle,
    conv_id: String,
    user_id: Option<String>,
) -> Result<(), String> {
    let mgr = manager(&app)?;
    let org_id = org(&mgr)?;
    let me = mgr.with_state(|s| s.me.clone()).unwrap_or_default();
    mgr.rest()
        .leave(&org_id, &conv_id, user_id.as_deref().unwrap_or(&me))
        .await
        .map_err(map_err)
}

#[tauri::command]
pub async fn comms_patch_conversation(
    app: AppHandle,
    conv_id: String,
    name: Option<String>,
    archived: Option<bool>,
    workspace_ref_ids: Option<Vec<String>>,
) -> Result<Conversation, String> {
    let mgr = manager(&app)?;
    let org_id = org(&mgr)?;
    mgr.rest()
        .patch_conversation(
            &org_id,
            &conv_id,
            ConversationPatch {
                name,
                archived,
                workspace_ref_ids,
            },
        )
        .await
        .map_err(map_err)
}

/// Newest-first, unlike history paging. The last word is a prefix match, so it
/// works mid-type; there is no operator syntax to advertise.
#[tauri::command]
pub async fn comms_search(
    app: AppHandle,
    q: String,
    conv_id: Option<String>,
    before_seq: Option<i64>,
) -> Result<MessagePageDto, String> {
    let mgr = manager(&app)?;
    let org_id = org(&mgr)?;
    let page = mgr
        .rest()
        .search(&org_id, &q, conv_id.as_deref(), before_seq)
        .await
        .map_err(map_err)?;
    Ok(MessagePageDto {
        has_more: page.has_more,
        messages: page
            .messages
            .into_iter()
            .map(|m| to_wire(&atlas_comms::LocalMessage::settled(m)))
            .collect(),
    })
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/// The renderer announcing that its listener is attached.
///
/// Must be called *after* `listenComms` resolves. Rust answers with the current
/// connection state and a `resync`, which is what makes a cold launch
/// deterministic: without it, a socket that opened before React mounted emitted
/// its one `resync` into a void and the panel stayed empty until something else
/// happened to fire an event (an org switch, in practice).
#[tauri::command]
pub fn comms_ready(app: AppHandle) -> Result<(), String> {
    let mgr = manager(&app)?;
    tracing::debug!(
        target: "atlas_comms::bridge",
        "renderer ready; target={:?} state={:?}",
        mgr.org_id(),
        mgr.connection().state
    );
    mgr.announce();
    Ok(())
}

/// Retry after `unavailable`, which does not retry on its own because retrying
/// a `403` cannot help.
#[tauri::command]
pub fn comms_reconnect(app: AppHandle) -> Result<(), String> {
    let mgr = manager(&app)?;
    let target = mgr.org_id().map(|org_id| OrgTarget { org_id });
    // Force a fresh attempt: clearing the target first makes `set_target`
    // reconcile rather than treat this as a no-op.
    mgr.set_target(None);
    mgr.set_target(target);
    Ok(())
}

/// Close the socket for an org switch. The reopen comes from the auth
/// broadcast that `auth_set_active_org` triggers a moment later.
#[tauri::command]
pub fn comms_disconnect(app: AppHandle) -> Result<(), String> {
    manager(&app)?.disconnect();
    Ok(())
}

/// A call's recordings. The URLs expire in ~60s, so this is called at open
/// time rather than cached with the call.
#[tauri::command]
pub async fn comms_call_recordings(
    app: AppHandle,
    call_id: String,
) -> Result<atlas_comms::rest::RecordingsResponse, String> {
    let mgr = manager(&app)?;
    let org_id = org(&mgr)?;
    mgr.rest()
        .call_recordings(&org_id, &call_id)
        .await
        .map_err(map_err)
}

/// Save a recording track wherever the user wants it.
///
/// Takes the URL rather than an id because the link is minted per read and
/// dies in a minute — the renderer passes back the one it was just handed.
#[tauri::command]
pub async fn comms_save_recording(
    app: AppHandle,
    url: String,
    dest: String,
    download_id: String,
) -> Result<(), String> {
    crate::commands::save_guard::guard_save_dest(&dest)?;
    let mgr = manager(&app)?;
    let bytes = mgr
        .download_recording(&url, &download_id)
        .await
        .map_err(map_err)?;
    std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    Ok(())
}

/// Fetch a recording track into the local cache and return its path.
///
/// The track URL is a sixty-second mint, which is exactly why playback cannot
/// point an `<audio>` element at it: a seek past the buffered range becomes a
/// range request against a dead ticket. The bytes are cached under the
/// track's id — track content is immutable — and the renderer plays the local
/// file through `convertFileSrc`, the same road attachments take. Progress is
/// announced under the track id, so the same arc the save flow uses covers
/// the pre-play buffering too.
#[tauri::command]
pub async fn comms_fetch_recording(
    app: AppHandle,
    url: String,
    track_id: String,
    filename: String,
) -> Result<String, String> {
    let mgr = manager(&app)?;
    if track_id.contains('/') || track_id.contains("..") {
        return Err("bad track id".into());
    }
    let ext = std::path::Path::new(&filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("webm")
        .to_string();
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("comms-recordings");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{track_id}.{ext}"));
    if path.exists() {
        return Ok(path.to_string_lossy().into_owned());
    }
    let bytes = mgr.download_recording(&url, &track_id).await.map_err(map_err)?;
    let tmp = dir.join(format!(".{track_id}.part"));
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// The base the renderer would show in a diagnostics panel. Never a token.
#[tauri::command]
pub fn comms_base_url() -> String {
    chat_base()
}

/// Ensure an attachment is in the local cache and return its path.
///
/// The download URL is a 302 to a ticket that dies in 60 seconds, so the
/// redirect is followed immediately and **never cached** — the file id is the
/// stable name, the ticket is not. A file already on disk is returned without a
/// network trip: attachments are immutable (deleting the message deletes the
/// file server-side; a stale local copy of a deleted attachment is acceptable
/// and unavoidable).
async fn cache_attachment(
    app: &AppHandle,
    file_id: &str,
    filename: &str,
    download_id: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    let mgr = manager(app)?;
    let org_id = org(&mgr)?;

    // Belt and braces: the id is server-minted, but it becomes a path segment.
    if file_id.contains('/') || file_id.contains("..") {
        return Err("bad file id".into());
    }
    let ext = std::path::Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin")
        .to_string();

    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("comms-attachments");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{file_id}.{ext}"));
    if path.exists() {
        return Ok(path);
    }

    let bytes = match download_id {
        // Announced, for a ring somewhere: route through the manager.
        Some(id) => mgr.download_attachment(file_id, id).await.map_err(map_err)?,
        // Silent, for inline media that has its own loading treatment.
        None => mgr
            .rest()
            .download_file(&org_id, file_id)
            .await
            .map_err(map_err)?,
    };
    // Write-then-rename, so a crash mid-download never leaves a plausible file.
    let tmp = dir.join(format!(".{file_id}.part"));
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(path)
}

/// Fetch an attachment into the local cache; the renderer turns the returned
/// path into a displayable URL with `convertFileSrc`.
#[tauri::command]
pub async fn comms_fetch_attachment(
    app: AppHandle,
    file_id: String,
    filename: String,
) -> Result<String, String> {
    let path = cache_attachment(&app, &file_id, &filename, None).await?;
    Ok(path.to_string_lossy().into_owned())
}

/// Save an attachment to a destination the user picked.
///
/// Goes through the same cache as viewing, so "download" after a preview costs
/// no second round trip — and a file the user has already seen saves instantly.
#[tauri::command]
pub async fn comms_save_attachment(
    app: AppHandle,
    file_id: String,
    filename: String,
    dest: String,
    download_id: String,
) -> Result<(), String> {
    crate::commands::save_guard::guard_save_dest(&dest)?;
    let cached = cache_attachment(&app, &file_id, &filename, Some(&download_id)).await?;
    std::fs::copy(&cached, &dest).map_err(|e| e.to_string())?;
    Ok(())
}

