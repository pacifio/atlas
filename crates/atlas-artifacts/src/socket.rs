//! One Project's realtime connection, from dial to close.
//!
//! Ported from `atlas_comms::conn` rather than reinvented — the artifacts
//! socket authenticates identically and has the same three failure modes, and
//! two hand-written handshakes would drift.
//!
//! ## The ticket
//!
//! Browsers cannot set headers on a WebSocket, so the access JWT rides in the
//! subprotocol list:
//!
//! ```text
//! Sec-WebSocket-Protocol: atlas.v1, atlas.ticket.<jwt>
//! ```
//!
//! The server echoes only `atlas.v1` on the 101; the ticket is never reflected.
//!
//! **Never log the request, its headers, or the URL of a failed dial.** The
//! second value in that header is a live credential, and a tungstenite HTTP
//! error can carry the whole request back — which is why every log line below
//! prints a classification rather than an error's own `Display`.
//!
//! ## Scope
//!
//! Sockets are per **Project**, never per Organisation: the server has no
//! org-wide socket. `session.summary` reaches every socket on the Project, so
//! the board gets realtime for free; entry and comment frames only reach the
//! socket that subscribed to that Session — one Session per socket, which is
//! why the manager opens a follower socket per watched Session.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use crate::error::{Error, Result};
use crate::model::{Comment, RemoteSession};

/// The close code the server uses when membership was revoked.
const WS_CLOSE_REVOKED: u16 = 1008;

/// How a connection proves it is still a connection.
///
/// Neither side of this protocol pings on its own: the server's Durable Object
/// hibernates and never calls `setWebSocketAutoResponse`, and tungstenite only
/// *answers* pings. So a socket cut without a FIN — a laptop lid, a Wi-Fi
/// switch, a NAT table expiring — used to sit half-open forever: the read
/// never returned, the subscription was gone server-side, and every comment
/// posted after that was lost until the Session was reopened.
///
/// The client pings every `ping`; going `idle` without a single incoming
/// message (a frame, a ping or a pong) ends the attempt as a transport failure
/// and the manager redials. A dial that produces no `101` within `dial` is cut
/// the same way, because `connect_async` has no deadline of its own.
#[derive(Debug, Clone, Copy)]
pub struct Keepalive {
    pub ping: Duration,
    pub idle: Duration,
    pub dial: Duration,
}

impl Default for Keepalive {
    fn default() -> Self {
        Self {
            ping: Duration::from_secs(25),
            idle: Duration::from_secs(80),
            dial: Duration::from_secs(20),
        }
    }
}

/// The exit reason for a socket that went quiet past [`Keepalive::idle`].
pub const IDLE_EXIT: &str = "idle";

/// What this client says.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "t")]
pub enum ClientFrame {
    /// Start receiving this Session's entry and comment frames. One Session at
    /// a time per socket — a second subscribe replaces the first.
    #[serde(rename = "session.subscribe")]
    SessionSubscribe { session_id: String },
    #[serde(rename = "session.unsubscribe")]
    SessionUnsubscribe,
}

/// What the server says.
///
/// `Unknown` rather than a decode failure: the server ships ahead of the
/// desktop, and a release that added a frame type must not take the socket down
/// for everyone still on the old build.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "t")]
pub enum ServerFrame {
    #[serde(rename = "workspace.hello")]
    Hello {
        #[serde(default)]
        online: Vec<String>,
    },
    /// A Session's summary changed — including its liveness flipping. Sent to
    /// **every** socket on the Project, which is what makes the board live.
    #[serde(rename = "session.summary")]
    SessionSummary { summary: RemoteSession },
    /// One timeline entry was inserted or updated.
    ///
    /// `change: "updated"` is the common case, not the exception — a tool call
    /// settles from `pending` to `completed`. Key on the entry's `id` and
    /// replace, or completed calls render twice.
    #[serde(rename = "artifact.upsert")]
    ArtifactUpsert {
        session_id: String,
        change: String,
        entry: serde_json::Value,
    },
    /// A comment was posted, edited, resolved or deleted. **One frame covers
    /// all four**; a deletion arrives as a comment whose `body` is null.
    #[serde(rename = "comment.upsert")]
    CommentUpsert {
        session_id: String,
        comment: Comment,
    },
    #[serde(rename = "presence")]
    Presence {
        #[serde(default)]
        online: Vec<String>,
    },
    #[serde(other)]
    Unknown,
}

/// Why an attempt ended. The manager's retry policy keys off this.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExitReason {
    /// Closed cleanly or by the peer; reconnect after a backoff.
    Closed,
    /// The ticket was refused. Worth exactly one immediate re-mint: the JWT
    /// lives ten minutes and can expire between minting and dialling.
    Unauthorized,
    /// Valid token, not a member. Retrying cannot help.
    Forbidden,
    /// Membership was revoked — the server closes 1008. Distinct from `Closed`
    /// so the manager stops instead of reconnecting forever against a door
    /// that will keep refusing.
    Revoked,
    Transport(String),
}

impl ExitReason {
    /// Should the manager dial again?
    pub fn should_retry(&self) -> bool {
        matches!(self, Self::Closed | Self::Transport(_) | Self::Unauthorized)
    }
}

pub enum ConnEvent {
    /// Boxed: a `ServerFrame` carrying a whole `RemoteSession` is an order of
    /// magnitude larger than a close reason, and every `Closed` would otherwise
    /// be padded to its size on a channel that sees a lot of both.
    Frame(Box<ServerFrame>),
    Closed(ExitReason),
}

/// Build the dial request with the two-value subprotocol offer.
///
/// The pinned fork validates the server's echo against this list, so a server
/// echoing something else fails the handshake rather than proceeding on a
/// protocol nobody agreed to.
///
/// Public so the other sockets on the ingest door (the Universal RC host
/// socket in `atlas-remote-control`) dial with exactly this handshake rather
/// than a second hand-written copy of it.
pub fn ticket_request(
    url: String,
    token: &str,
) -> Result<tokio_tungstenite::tungstenite::handshake::client::Request> {
    let mut request = url
        .into_client_request()
        .map_err(|e| Error::Transport(format!("bad url: {e}")))?;
    let protocols = format!("atlas.v1, atlas.ticket.{token}");
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        HeaderValue::from_str(&protocols)
            .map_err(|_| Error::Protocol("token is not a valid header value".into()))?,
    );
    Ok(request)
}

/// Dial, forward every frame to `events`, and write everything from `outbound`
/// until one side closes.
pub async fn run(
    url: String,
    token: String,
    mut outbound: mpsc::UnboundedReceiver<ClientFrame>,
    events: mpsc::UnboundedSender<ConnEvent>,
    keepalive: Keepalive,
) -> Result<()> {
    let request = ticket_request(url, &token)?;

    let dialed =
        tokio::time::timeout(keepalive.dial, tokio_tungstenite::connect_async(request)).await;
    let (stream, _response) = match dialed {
        Ok(Ok(ok)) => ok,
        Ok(Err(err)) => {
            let reason = classify_handshake(&err);
            tracing::warn!(target: "atlas_artifacts::socket", "handshake failed: {reason:?}");
            let _ = events.send(ConnEvent::Closed(reason));
            return Ok(());
        }
        Err(_elapsed) => {
            tracing::warn!(
                target: "atlas_artifacts::socket",
                "handshake produced no answer in {:?}",
                keepalive.dial
            );
            let _ = events.send(ConnEvent::Closed(ExitReason::Transport(
                "dial timeout".into(),
            )));
            return Ok(());
        }
    };

    tracing::info!(target: "atlas_artifacts::socket", "socket open");
    let (mut write, mut read) = stream.split();

    let mut last_seen = Instant::now();
    let mut ping = tokio::time::interval_at(Instant::now() + keepalive.ping, keepalive.ping);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    let exit = loop {
        tokio::select! {
            incoming = read.next() => match incoming {
                Some(Ok(WsMessage::Text(text))) => {
                    last_seen = Instant::now();
                    match serde_json::from_str::<ServerFrame>(&text) {
                        Ok(frame) => {
                            if events.send(ConnEvent::Frame(Box::new(frame))).is_err() {
                                break ExitReason::Closed;
                            }
                        }
                        Err(e) => {
                            // Not fatal: a new frame *shape* is as possible as
                            // a new `t`, and neither is worth a disconnect.
                            tracing::debug!(target: "atlas_artifacts::socket", "undecodable frame: {e}");
                        }
                    }
                }
                Some(Ok(WsMessage::Close(frame))) => {
                    let revoked = frame
                        .as_ref()
                        .is_some_and(|f| u16::from(f.code) == WS_CLOSE_REVOKED);
                    break if revoked { ExitReason::Revoked } else { ExitReason::Closed };
                }
                // A ping is auto-answered by the library and a pong is the
                // answer to ours; either proves the peer is there. Binary is
                // refused by the server anyway — blobs go over `PUT /blobs`.
                Some(Ok(_)) => last_seen = Instant::now(),
                Some(Err(e)) => break ExitReason::Transport(e.to_string()),
                None => break ExitReason::Closed,
            },

            _ = ping.tick() => {
                if last_seen.elapsed() >= keepalive.idle {
                    tracing::warn!(
                        target: "atlas_artifacts::socket",
                        "no frame or pong in {:?}; treating the socket as dead",
                        last_seen.elapsed()
                    );
                    break ExitReason::Transport(IDLE_EXIT.into());
                }
                if let Err(e) = write.send(WsMessage::Ping(b"atlas".to_vec().into())).await {
                    break ExitReason::Transport(format!("ping: {e}"));
                }
            }

            to_send = outbound.recv() => match to_send {
                Some(frame) => {
                    let text = match serde_json::to_string(&frame) {
                        Ok(t) => t,
                        Err(e) => {
                            tracing::error!(target: "atlas_artifacts::socket", "unserializable frame: {e}");
                            continue;
                        }
                    };
                    if let Err(e) = write.send(WsMessage::Text(text.into())).await {
                        break ExitReason::Transport(e.to_string());
                    }
                }
                // The manager dropped the sender: this Project is being torn
                // down. Close politely so presence drops promptly.
                None => {
                    let _ = write.send(WsMessage::Close(None)).await;
                    break ExitReason::Closed;
                }
            },
        }
    };

    tracing::info!(target: "atlas_artifacts::socket", "socket closed: {exit:?}");
    let _ = events.send(ConnEvent::Closed(exit));
    Ok(())
}

/// Map a handshake failure onto the retry policy.
///
/// Distinguishable only by status: `401` is worth one re-mint, `403` is worth
/// nothing at all, everything else is worth a backoff.
///
/// `404` is deliberately **not** terminal. The server answers it for "no such
/// Workspace" *and* "one you may not read" (anti-enumeration), but also during
/// a deploy, a Durable Object cold start and the seconds between a Project
/// being registered and its object being reachable. Retiring the Project on
/// it — as this once did — silently ended realtime until the next retarget.
fn classify_handshake(err: &tokio_tungstenite::tungstenite::Error) -> ExitReason {
    use tokio_tungstenite::tungstenite::Error as WsError;
    match err {
        WsError::Http(response) => match response.status().as_u16() {
            401 => ExitReason::Unauthorized,
            403 => ExitReason::Forbidden,
            other => ExitReason::Transport(format!("HTTP {other}")),
        },
        // Deliberately not formatting the error itself: it can carry the
        // request, and the request carries the ticket.
        WsError::Io(_) => ExitReason::Transport("io".into()),
        WsError::Tls(_) => ExitReason::Transport("tls".into()),
        WsError::Protocol(p) => ExitReason::Transport(format!("protocol: {p}")),
        _ => ExitReason::Transport("connect failed".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_revocation_is_not_retried_but_a_drop_is() {
        // 1008 means the identity was removed. Reconnecting would hammer a
        // door that keeps refusing, and would never recover on its own.
        assert!(!ExitReason::Revoked.should_retry());
        assert!(!ExitReason::Forbidden.should_retry());
        assert!(ExitReason::Closed.should_retry());
        assert!(ExitReason::Transport("io".into()).should_retry());
        // One re-mint, then the backoff — a JWT can expire between mint and dial.
        assert!(ExitReason::Unauthorized.should_retry());
    }

    #[test]
    fn a_missing_workspace_is_retried_rather_than_retired() {
        // 404 covers "not yours" but also "not yet" — a Project registered a
        // second ago, a worker mid-deploy. Only 403 is a verdict worth stopping
        // on; a 404 that persists is bounded by the backoff cap and cleared by
        // the next retarget.
        use tokio_tungstenite::tungstenite::http::Response;
        let http = |status: u16| {
            tokio_tungstenite::tungstenite::Error::Http(Box::new(
                Response::builder().status(status).body(None).unwrap(),
            ))
        };
        assert!(matches!(
            classify_handshake(&http(404)),
            ExitReason::Transport(_)
        ));
        assert!(classify_handshake(&http(404)).should_retry());
        assert_eq!(classify_handshake(&http(403)), ExitReason::Forbidden);
        assert_eq!(classify_handshake(&http(401)), ExitReason::Unauthorized);
        assert!(matches!(
            classify_handshake(&http(503)),
            ExitReason::Transport(_)
        ));
    }

    #[test]
    fn an_unknown_frame_type_decodes_rather_than_failing() {
        // The server ships ahead of the desktop. A new `t` must not take the
        // socket down for everyone on the previous release.
        let frame: ServerFrame =
            serde_json::from_str(r#"{"t":"something.new","payload":1}"#).expect("decodes");
        assert!(matches!(frame, ServerFrame::Unknown));
    }

    #[test]
    fn a_deleted_comment_arrives_as_an_upsert_with_no_body() {
        // There is no `comment.delete` frame — one shape covers post, edit,
        // resolve and delete, and a viewer that ignored a null body would show
        // deleted comments forever.
        let frame: ServerFrame = serde_json::from_value(serde_json::json!({
            "t": "comment.upsert",
            "session_id": "ses_1",
            "comment": {
                "id": "c1",
                "sessionId": "ses_1",
                "anchorKind": "tool_call",
                "anchorId": "tc_1",
                "authorId": "user_ada",
                "body": serde_json::Value::Null,
                "createdAt": "2026-09-20T10:04:11.000Z",
                "deletedAt": "2026-09-20T10:05:00.000Z",
            },
        }))
        .expect("decodes");
        let ServerFrame::CommentUpsert { comment, .. } = frame else {
            panic!("expected a comment frame");
        };
        assert!(comment.is_deleted());
    }

    #[test]
    fn a_summary_frame_carries_a_whole_row() {
        // Which is what lets the board apply it without a refresh.
        let frame: ServerFrame = serde_json::from_value(serde_json::json!({
            "t": "session.summary",
            "summary": { "id": "ses_7", "messageCount": 3 },
        }))
        .expect("decodes");
        let ServerFrame::SessionSummary { summary } = frame else {
            panic!("expected a summary frame");
        };
        assert_eq!(summary.id, "ses_7");
        assert_eq!(summary.message_count, 3);
    }

    #[test]
    fn client_frames_use_the_servers_tag_spelling() {
        let json = serde_json::to_value(ClientFrame::SessionSubscribe {
            session_id: "ses_1".into(),
        })
        .unwrap();
        assert_eq!(json["t"], "session.subscribe");
        assert_eq!(json["session_id"], "ses_1");
    }
}
