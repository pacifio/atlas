//! Realtime Spaces: one WebSocket **per open conversation canvas**, next to
//! (never through) the one-per-org chat socket.
//!
//! Rust is deliberately a dumb pipe here. The Space protocol's hot path is
//! opaque binary — Yjs updates and awareness blobs the server itself never
//! parses — and every codec convention is defined by the web client. So this
//! module dials, authenticates, reconnects, and shuttles frames; all
//! encoding/decoding lives in the renderer, mirroring the web implementation
//! 1:1 so interop bugs cannot hide in a translation layer. Nothing is
//! journaled and no watermark moves: resume is the renderer's business
//! (`since` on `page.open`), exactly as prompt drafts established.
//!
//! Frames cross the bridge as-is: JSON control frames as raw strings, binary
//! frames as base64. The renderer's spaces-bus fans them out at frame rate
//! without touching zustand.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::tungstenite::Message as WsMessage;

use crate::conn::{classify_handshake, ticket_request, ExitReason};
use crate::{spaces_socket_url, CommsError, TokenSource};

/// Backoff for the Spaces socket — the web client's numbers (500ms · 2^n,
/// capped at 10s), not the chat socket's. A canvas reconnect is user-visible
/// in a way a chat resync is not.
const RECONNECT_BASE_MS: u64 = 500;
const RECONNECT_MAX_MS: u64 = 10_000;
const EVENT_CAPACITY: usize = 4_096;

/// What one Space connection emits toward the renderer.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SpaceEvent {
    /// Socket lifecycle. `unavailable` means retrying cannot help (403 /
    /// membership revoked) — the tab shows a refusal, not a spinner.
    Connection { state: SpaceConnState },
    /// A JSON control frame, verbatim. The renderer parses it against the
    /// contract (`space.hello`, `page.opened`, `page.tree`, …).
    Control { frame: String },
    /// A binary frame (update batch or awareness fanout), base64.
    Binary { data: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SpaceConnState {
    Connecting,
    Open,
    Backoff,
    Disconnected,
    Unavailable,
}

/// The envelope on the `atlas:spaces` window channel. Envelopes for a stale
/// org or a closed conversation are simply ignored by the renderer.
#[derive(Debug, Clone, Serialize)]
pub struct SpaceEnvelope {
    pub org: String,
    pub conv: String,
    pub ev: SpaceEvent,
}

/// What the renderer can send. Control frames are opaque JSON strings; the
/// contract's whole client surface is six page frames, all built renderer-side.
enum SpaceOutbound {
    Control(String),
    Binary(Vec<u8>),
}

/// Outbound queue bound. A stalled-but-open TCP connection must not let
/// per-mousemove updates balloon RAM; past this, awareness (byte[0] = 0x02,
/// only the newest matters) is dropped first, then anything — the renderer's
/// held-merge path already covers updates that never made it out.
const OUTBOUND_CAP: usize = 512;

struct SpaceSlot {
    org_id: String,
    /// Refreshed per attempt; `None` while between attempts. A send while
    /// disconnected is dropped — the renderer holds and merges unsent Yjs
    /// updates itself, per the protocol.
    outbound: Mutex<Option<mpsc::Sender<SpaceOutbound>>>,
    /// Bumped to invalidate this slot's supervisor. A task that observes a
    /// stale generation exits without touching anything.
    generation: AtomicU64,
}

struct Inner {
    tokens: Arc<dyn TokenSource>,
    events: broadcast::Sender<SpaceEnvelope>,
    spaces: Mutex<HashMap<String, Arc<SpaceSlot>>>,
}

/// The per-conversation Spaces socket supervisor.
#[derive(Clone)]
pub struct SpacesManager {
    inner: Arc<Inner>,
}

impl SpacesManager {
    pub fn new(tokens: Arc<dyn TokenSource>) -> Self {
        let (events, _) = broadcast::channel(EVENT_CAPACITY);
        Self {
            inner: Arc::new(Inner {
                tokens,
                events,
                spaces: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SpaceEnvelope> {
        self.inner.events.subscribe()
    }

    /// Open (or keep open) the socket for one conversation's Space.
    /// Idempotent: a second tab for the same conversation shares the socket.
    pub fn connect(&self, org_id: &str, conv_id: &str) {
        let mut spaces = self.inner.spaces.lock().unwrap();
        if let Some(existing) = spaces.get(conv_id) {
            if existing.org_id == org_id {
                return;
            }
            // Same conversation id under a different org — tear the old one
            // down first. (Conv ids are minted per-org; this is belt over
            // braces for an org switch racing a tab open.)
            existing.generation.fetch_add(1, Ordering::SeqCst);
            existing.outbound.lock().unwrap().take();
        }
        let slot = Arc::new(SpaceSlot {
            org_id: org_id.to_string(),
            outbound: Mutex::new(None),
            generation: AtomicU64::new(0),
        });
        spaces.insert(conv_id.to_string(), slot.clone());
        drop(spaces);
        self.spawn_supervisor(slot, conv_id.to_string());
    }

    /// Close one conversation's socket. Dropping the outbound sender makes the
    /// connection close politely, so the server drops presence promptly.
    pub fn disconnect(&self, conv_id: &str) {
        let removed = self.inner.spaces.lock().unwrap().remove(conv_id);
        if let Some(slot) = removed {
            slot.generation.fetch_add(1, Ordering::SeqCst);
            slot.outbound.lock().unwrap().take();
            self.emit(&slot.org_id, conv_id, SpaceConnState::Disconnected);
        }
    }

    /// Org switch / sign-out teardown: every Space socket dies with the org.
    pub fn disconnect_all(&self) {
        let drained: Vec<(String, Arc<SpaceSlot>)> =
            self.inner.spaces.lock().unwrap().drain().collect();
        for (conv_id, slot) in drained {
            slot.generation.fetch_add(1, Ordering::SeqCst);
            slot.outbound.lock().unwrap().take();
            self.emit(&slot.org_id, &conv_id, SpaceConnState::Disconnected);
        }
    }

    /// Ask the supervisor to drop the current socket and dial again — the
    /// server's `error.detail.reconnect === true` instruction (fresh slots).
    pub fn cycle(&self, conv_id: &str) {
        let slot = self.inner.spaces.lock().unwrap().get(conv_id).cloned();
        if let Some(slot) = slot {
            // Taking the sender closes the live connection; the supervisor
            // sees `Closed`, keeps its generation, and redials.
            slot.outbound.lock().unwrap().take();
        }
    }

    pub fn send_control(&self, conv_id: &str, frame: String) {
        self.send(conv_id, SpaceOutbound::Control(frame));
    }

    pub fn send_binary(&self, conv_id: &str, bytes: Vec<u8>) {
        self.send(conv_id, SpaceOutbound::Binary(bytes));
    }

    fn send(&self, conv_id: &str, out: SpaceOutbound) {
        let slot = self.inner.spaces.lock().unwrap().get(conv_id).cloned();
        let Some(slot) = slot else { return };
        let guard = slot.outbound.lock().unwrap();
        if let Some(tx) = guard.as_ref() {
            if let Err(mpsc::error::TrySendError::Full(rejected)) = tx.try_send(out) {
                // Queue full = the socket is stalled. Awareness is safe to
                // drop (only the newest position means anything); a dropped
                // update is the renderer's held-merge contract.
                let droppable =
                    matches!(&rejected, SpaceOutbound::Binary(b) if b.first() == Some(&0x02));
                if !droppable {
                    tracing::warn!(
                        target: "atlas_comms::spaces",
                        "outbound queue full; dropping a non-awareness frame"
                    );
                }
            }
        }
        // No sender = between attempts. Dropped by design; see SpaceSlot.
    }

    fn emit(&self, org: &str, conv: &str, state: SpaceConnState) {
        let _ = self.inner.events.send(SpaceEnvelope {
            org: org.to_string(),
            conv: conv.to_string(),
            ev: SpaceEvent::Connection { state },
        });
    }

    fn spawn_supervisor(&self, slot: Arc<SpaceSlot>, conv_id: String) {
        let me = self.clone();
        let generation = slot.generation.load(Ordering::SeqCst);
        tokio::spawn(async move {
            let mut attempt: u32 = 0;
            let mut reminted_once = false;
            loop {
                if slot.generation.load(Ordering::SeqCst) != generation {
                    return;
                }
                me.emit(&slot.org_id, &conv_id, SpaceConnState::Connecting);
                let reason = me.attempt_once(&slot, &conv_id, generation).await;
                if slot.generation.load(Ordering::SeqCst) != generation {
                    return;
                }
                match reason {
                    ExitReason::Unauthorized if !reminted_once => {
                        // The JWT lives ten minutes and can expire between
                        // minting and dialling: one immediate retry.
                        reminted_once = true;
                        continue;
                    }
                    ExitReason::Unauthorized | ExitReason::Forbidden | ExitReason::Evicted => {
                        // Not a member (or removed — the DO closes 1008
                        // "membership revoked"). Retrying cannot help.
                        me.emit(&slot.org_id, &conv_id, SpaceConnState::Unavailable);
                        me.inner.spaces.lock().unwrap().remove(&conv_id);
                        return;
                    }
                    ExitReason::Closed | ExitReason::Transport(_) => {
                        reminted_once = false;
                        attempt = attempt.saturating_add(1);
                        me.emit(&slot.org_id, &conv_id, SpaceConnState::Backoff);
                        tokio::time::sleep(Duration::from_millis(backoff_ms(attempt - 1))).await;
                    }
                }
            }
        });
    }

    /// One dial-to-close cycle. Returns why it ended.
    async fn attempt_once(&self, slot: &Arc<SpaceSlot>, conv_id: &str, generation: u64) -> ExitReason {
        let token = match self.inner.tokens.mint().await {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!(target: "atlas_comms::spaces", "token mint failed: {e}");
                return ExitReason::Transport("mint".into());
            }
        };
        let url = spaces_socket_url(&slot.org_id, conv_id);
        let request = match ticket_request(url, &token) {
            Ok(r) => r,
            Err(e) => {
                tracing::error!(target: "atlas_comms::spaces", "bad request: {e}");
                return ExitReason::Transport("request".into());
            }
        };

        let (stream, _response) = match tokio_tungstenite::connect_async(request).await {
            Ok(ok) => ok,
            Err(err) => {
                let reason = classify_handshake(&err);
                // The classification, never the error — a tungstenite HTTP
                // error can carry the request, and the request the ticket.
                tracing::warn!(target: "atlas_comms::spaces", "handshake failed: {reason:?}");
                return reason;
            }
        };

        if slot.generation.load(Ordering::SeqCst) != generation {
            return ExitReason::Closed;
        }

        let (tx, mut outbound) = mpsc::channel::<SpaceOutbound>(OUTBOUND_CAP);
        *slot.outbound.lock().unwrap() = Some(tx);
        self.emit(&slot.org_id, conv_id, SpaceConnState::Open);
        tracing::info!(target: "atlas_comms::spaces", "space socket open");

        let (mut write, mut read) = stream.split();
        let b64 = base64::engine::general_purpose::STANDARD;

        let exit = loop {
            tokio::select! {
                incoming = read.next() => match incoming {
                    Some(Ok(WsMessage::Text(text))) => {
                        // Verbatim to the renderer; the contract is decoded
                        // there. An undecodable frame is its problem to drop.
                        let _ = self.inner.events.send(SpaceEnvelope {
                            org: slot.org_id.clone(),
                            conv: conv_id.to_string(),
                            ev: SpaceEvent::Control { frame: text.to_string() },
                        });
                    }
                    Some(Ok(WsMessage::Binary(bytes))) => {
                        // The hot path: update batches and awareness fanouts.
                        let _ = self.inner.events.send(SpaceEnvelope {
                            org: slot.org_id.clone(),
                            conv: conv_id.to_string(),
                            ev: SpaceEvent::Binary { data: b64.encode(&bytes) },
                        });
                    }
                    Some(Ok(WsMessage::Close(frame))) => {
                        // 1008 = membership revoked (`cutMemberSockets`).
                        let revoked = frame
                            .as_ref()
                            .is_some_and(|f| u16::from(f.code) == 1008);
                        break if revoked { ExitReason::Evicted } else { ExitReason::Closed };
                    }
                    Some(Ok(_)) => {} // ping/pong
                    Some(Err(e)) => break ExitReason::Transport(e.to_string()),
                    None => break ExitReason::Closed,
                },

                to_send = outbound.recv() => match to_send {
                    Some(SpaceOutbound::Control(text)) => {
                        if let Err(e) = write.send(WsMessage::Text(text.into())).await {
                            break ExitReason::Transport(e.to_string());
                        }
                    }
                    Some(SpaceOutbound::Binary(bytes)) => {
                        if let Err(e) = write.send(WsMessage::Binary(bytes.into())).await {
                            break ExitReason::Transport(e.to_string());
                        }
                    }
                    // Sender dropped: teardown or a deliberate cycle. Close
                    // politely so presence clears on the next fanout tick.
                    None => {
                        let _ = write.send(WsMessage::Close(None)).await;
                        break ExitReason::Closed;
                    }
                },
            }
        };

        slot.outbound.lock().unwrap().take();
        tracing::info!(target: "atlas_comms::spaces", "space socket closed: {exit:?}");
        exit
    }
}

/// How long a one-shot [`SpacesManager::create_page`] waits for its answer.
/// A tree write on the Space's object is one SQL insert; ten seconds is a
/// server that is not answering, not one that is busy.
pub const PAGE_CREATE_TIMEOUT: Duration = Duration::from_secs(10);

/// A `page.create` control frame, as the contract (`SpacePageCreate`) shapes
/// it. Every field is optional there: an absent one is left out of the frame,
/// never sent as `null`, because `parent_id: null` and `icon: null` are
/// statements ("at the root", "no icon") where absence is not.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct PageCreate {
    /// `"page"` (the server's default) or `"folder"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// The folder it goes in; absent lands it at the root.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
}

impl PageCreate {
    /// A page at the root of the Space, with a name.
    pub fn root_page(name: impl Into<String>) -> Self {
        Self { name: Some(name.into()), ..Self::default() }
    }

    /// The frame as it goes on the wire.
    pub fn frame(&self) -> String {
        let mut value = serde_json::to_value(self).unwrap_or_else(|_| serde_json::json!({}));
        value["t"] = serde_json::json!("page.create");
        value.to_string()
    }
}

impl SpacesManager {
    /// Create one page in a conversation's Space from Rust, and answer its id.
    ///
    /// On a **connection of its own**, dialled for this one frame and closed
    /// after, never the renderer's canvas socket: the server answers
    /// `page.created` to the socket that asked and to no other, so a private
    /// socket is what makes the answer unambiguously this call's — on a shared
    /// one, a page the person creates at the same moment would race it. The
    /// tree broadcast that follows reaches every open canvas as usual, so a
    /// Space open in the window shows the new page at once.
    ///
    /// Authenticated exactly as the canvas socket is (one re-mint on a 401,
    /// the JWT being able to expire between minting and dialling); a 403 —
    /// not a member of the conversation — is [`CommsError::Forbidden`].
    pub async fn create_page(&self, org_id: &str, conv_id: &str, page: &PageCreate) -> crate::Result<String> {
        let mut reminted = false;
        loop {
            let token = self.inner.tokens.mint().await?;
            let request = ticket_request(spaces_socket_url(org_id, conv_id), &token)?;
            match tokio_tungstenite::connect_async(request).await {
                Ok((stream, _response)) => {
                    let (write, read) = stream.split();
                    return await_page_created(write, read, page.frame(), PAGE_CREATE_TIMEOUT).await;
                }
                Err(err) => match classify_handshake(&err) {
                    // Never the error itself: it can carry the request, and
                    // the request the ticket.
                    ExitReason::Unauthorized if !reminted => reminted = true,
                    ExitReason::Unauthorized => return Err(CommsError::Unauthorized),
                    ExitReason::Forbidden | ExitReason::Evicted => return Err(CommsError::Forbidden),
                    ExitReason::Closed => return Err(CommsError::Transport("closed during the handshake".into())),
                    ExitReason::Transport(reason) => return Err(CommsError::Transport(reason)),
                },
            }
        }
    }
}

/// One `page.create` over an open Space socket: send the frame, then read
/// until the server answers it — `page.created` with the new page's id, or an
/// `error` frame (the contract's chat envelope: a full Space, an archived
/// conversation, a malformed name), which is [`CommsError::Refused`] with the
/// server's code and words. The greeting and tree broadcasts in between are
/// passed over. A close before the answer, or no answer within `timeout`, is
/// an error that says the page may or may not exist — the frame went out, so
/// only the Space can say which.
///
/// The socket is closed politely whatever the outcome.
pub(crate) async fn await_page_created<W, R, E>(
    mut write: W,
    mut read: R,
    frame: String,
    timeout: Duration,
) -> crate::Result<String>
where
    W: futures_util::Sink<WsMessage> + Unpin,
    W::Error: std::fmt::Display,
    R: futures_util::Stream<Item = Result<WsMessage, E>> + Unpin,
    E: std::fmt::Display,
{
    if let Err(e) = write.send(WsMessage::Text(frame.into())).await {
        return Err(CommsError::Transport(e.to_string()));
    }
    let answer = tokio::time::timeout(timeout, async {
        loop {
            match read.next().await {
                Some(Ok(WsMessage::Text(text))) => {
                    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
                    match value.get("t").and_then(|t| t.as_str()) {
                        Some("page.created") => {
                            return match value.get("page_id").and_then(|id| id.as_str()) {
                                Some(id) if !id.is_empty() => Ok(id.to_string()),
                                _ => Err(CommsError::Protocol("page.created without a page_id".into())),
                            };
                        }
                        Some("error") => {
                            let error = &value["error"];
                            return Err(CommsError::Refused {
                                code: error["code"].as_str().unwrap_or("error").to_string(),
                                message: error["message"].as_str().unwrap_or("the Space refused the page").to_string(),
                                detail: error.get("detail").cloned(),
                            });
                        }
                        _ => {}
                    }
                }
                Some(Ok(WsMessage::Close(frame))) => {
                    let revoked = frame.as_ref().is_some_and(|f| u16::from(f.code) == 1008);
                    return Err(if revoked {
                        CommsError::Forbidden
                    } else {
                        CommsError::Transport("the Space closed before answering; the page may not exist".into())
                    });
                }
                Some(Ok(_)) => {}
                Some(Err(e)) => return Err(CommsError::Transport(e.to_string())),
                None => {
                    return Err(CommsError::Transport("the Space closed before answering; the page may not exist".into()))
                }
            }
        }
    })
    .await
    .unwrap_or_else(|_| {
        Err(CommsError::Transport(format!(
            "the Space did not answer within {}s; the page may or may not have been created",
            timeout.as_secs()
        )))
    });
    let _ = write.send(WsMessage::Close(None)).await;
    answer
}

fn backoff_ms(attempt: u32) -> u64 {
    RECONNECT_BASE_MS
        .saturating_mul(1u64 << attempt.min(20))
        .min(RECONNECT_MAX_MS)
}

/// REST types for the Space summary pre-flight — the one Spaces REST read.
/// A `GET /spaces?org&conv` lazily creates the Space and its default page, and
/// maps 401/403/404 to human refusals before a WS handshake can fail mutely.
#[derive(Debug, Clone, serde::Deserialize, Serialize)]
pub struct SpacePageRow {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub icon: Option<String>,
    pub parent_id: Option<String>,
    pub sort: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, serde::Deserialize, Serialize)]
pub struct SpaceSummary {
    pub protocol: i64,
    pub doc_version: i64,
    pub space_id: String,
    pub conv_id: String,
    pub pages: Vec<SpacePageRow>,
    pub active_page_id: Option<String>,
    pub archived: bool,
}

/// Media reservation answer. `stored: true` is dedup — nothing to upload.
#[derive(Debug, Clone, serde::Deserialize, Serialize)]
pub struct SpaceMediaReserved {
    pub content_hash: String,
    pub mime: String,
    pub bytes: i64,
    pub stored: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_is_web_curve() {
        assert_eq!(backoff_ms(0), 500);
        assert_eq!(backoff_ms(1), 1_000);
        assert_eq!(backoff_ms(2), 2_000);
        assert_eq!(backoff_ms(4), 8_000);
        assert_eq!(backoff_ms(5), 10_000);
        assert_eq!(backoff_ms(30), 10_000); // and the shift cannot overflow
    }

    #[test]
    fn space_event_serialization_shape() {
        // The renderer switches on `kind` and camelCase states; a rename here
        // is a protocol change for the bridge.
        let ev = SpaceEvent::Connection { state: SpaceConnState::Backoff };
        assert_eq!(
            serde_json::to_string(&ev).unwrap(),
            r#"{"kind":"connection","state":"backoff"}"#
        );
        let ev = SpaceEvent::Binary { data: "AQI=".into() };
        assert_eq!(
            serde_json::to_string(&ev).unwrap(),
            r#"{"kind":"binary","data":"AQI="}"#
        );
    }

    #[test]
    fn a_root_page_create_frame_names_the_page_and_nothing_else() {
        let frame: serde_json::Value = serde_json::from_str(&PageCreate::root_page("Architecture").frame()).unwrap();
        assert_eq!(frame, serde_json::json!({ "t": "page.create", "name": "Architecture" }));
    }

    #[test]
    fn a_page_create_frame_carries_every_field_it_was_given() {
        let page = PageCreate {
            kind: Some("folder".into()),
            name: Some("Plans".into()),
            icon: Some("🗂".into()),
            parent_id: Some("p-1".into()),
        };
        let frame: serde_json::Value = serde_json::from_str(&page.frame()).unwrap();
        assert_eq!(
            frame,
            serde_json::json!({ "t": "page.create", "kind": "folder", "name": "Plans", "icon": "🗂", "parent_id": "p-1" })
        );
    }

    type Frames = Vec<Result<WsMessage, std::convert::Infallible>>;

    fn text(value: serde_json::Value) -> Result<WsMessage, std::convert::Infallible> {
        Ok(WsMessage::Text(value.to_string().into()))
    }

    #[tokio::test]
    async fn page_created_answers_the_new_pages_id_past_the_greeting_and_the_tree() {
        let mut sent: Vec<WsMessage> = Vec::new();
        let frames: Frames = vec![
            text(serde_json::json!({ "t": "space.hello", "pages": [] })),
            text(serde_json::json!({ "t": "page.tree", "pages": [] })),
            text(serde_json::json!({ "t": "page.created", "page_id": "p-new" })),
        ];
        let frame = PageCreate::root_page("Architecture").frame();
        let id = await_page_created(&mut sent, futures_util::stream::iter(frames), frame.clone(), PAGE_CREATE_TIMEOUT)
            .await
            .unwrap();
        assert_eq!(id, "p-new");
        assert_eq!(sent.first(), Some(&WsMessage::Text(frame.into())), "the frame went out first");
        assert!(matches!(sent.last(), Some(WsMessage::Close(None))), "and the socket was closed");
    }

    #[tokio::test]
    async fn an_error_frame_is_the_servers_refusal_with_its_code_and_words() {
        let mut sent: Vec<WsMessage> = Vec::new();
        let frames: Frames = vec![text(serde_json::json!({
            "t": "error",
            "error": { "code": "quota_exceeded", "message": "A Space holds at most 200 pages and folders.", "detail": { "limit": 200 } },
        }))];
        let err = await_page_created(&mut sent, futures_util::stream::iter(frames), "{}".into(), PAGE_CREATE_TIMEOUT)
            .await
            .unwrap_err();
        match err {
            CommsError::Refused { code, message, detail } => {
                assert_eq!(code, "quota_exceeded");
                assert!(message.contains("200 pages"));
                assert_eq!(detail, Some(serde_json::json!({ "limit": 200 })));
            }
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn a_close_before_the_answer_says_the_page_may_not_exist() {
        let mut sent: Vec<WsMessage> = Vec::new();
        let frames: Frames = vec![text(serde_json::json!({ "t": "space.hello" }))];
        let err = await_page_created(&mut sent, futures_util::stream::iter(frames), "{}".into(), PAGE_CREATE_TIMEOUT)
            .await
            .unwrap_err();
        assert!(matches!(&err, CommsError::Transport(m) if m.contains("may not exist")), "{err:?}");
    }

    #[tokio::test(start_paused = true)]
    async fn no_answer_within_the_timeout_is_an_error_that_says_it_may_exist() {
        let mut sent: Vec<WsMessage> = Vec::new();
        let silent = futures_util::stream::pending::<Result<WsMessage, std::convert::Infallible>>();
        let err = await_page_created(&mut sent, silent, "{}".into(), PAGE_CREATE_TIMEOUT).await.unwrap_err();
        assert!(matches!(&err, CommsError::Transport(m) if m.contains("did not answer within 10s")), "{err:?}");
        assert!(matches!(sent.last(), Some(WsMessage::Close(None))));
    }
}
