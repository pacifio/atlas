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
use crate::{spaces_socket_url, TokenSource};

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
}
