//! Atlas, the Organisation's agent: one socket per signed-in Organisation, and
//! its REST doors (`docs/api/atlas-agent-api.md` in the server repo).
//!
//! Rust is a pipe here, as it is for Spaces. The protocol's rules — events
//! applied in `seq` order, a gap answered by `resume`, sends held in an
//! outbox until their echo comes back — are the web client's, and live in the
//! renderer beside it (`src/features/org-agent/lib/org-agent-log.ts`), where
//! they are tested the way the web tests them. What only Rust can do is here:
//! hold the token, dial with the `atlas.ticket.` subprotocol, keep the socket
//! alive with `ping`, redial with backoff and a fresh token, and stop dialling
//! once the server says no for good.
//!
//! Frames cross the bridge verbatim as strings. Every reconnect is announced
//! (`Connection { state: Open }`), and that is the renderer's cue to resume
//! each Ask it holds from its last `seq`: frames sent while the socket was
//! down are gone, but every one of them is still in the Ask's log.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::tungstenite::Message as WsMessage;

use crate::conn::{classify_handshake, ticket_request, ExitReason};
use crate::rest::RestClient;
use crate::{agent_base, ws_scheme, CommsError, TokenSource};

/// The web's keepalive (`lib/atlas/socket.ts`): the Workers runtime drops an
/// idle socket, and a `ping` is answered `pong` without waking anything.
pub const PING_INTERVAL: Duration = Duration::from_secs(25);
const RECONNECT_BASE_MS: u64 = 1_000;
const RECONNECT_MAX_MS: u64 = 30_000;
const EVENT_CAPACITY: usize = 1_024;
const OUTBOUND_CAP: usize = 256;

/// Where the socket stands, for the renderer's connection line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentConnState {
    /// No Organisation to dial: signed out, or a local-only one.
    Disconnected,
    Connecting,
    Open,
    /// Lost; dialling again after a pause.
    Backoff,
    /// Refused for good: not a member, removed, or Atlas switched off. The
    /// renderer may ask for a redial ([`OrgAgentManager::reconnect`]) when it
    /// learns something changed.
    Unavailable,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentEvent {
    Connection {
        state: AgentConnState,
    },
    /// One server frame, verbatim.
    Frame {
        frame: String,
    },
}

/// One event, stamped with the Organisation and the socket's epoch. The epoch
/// moves on every retarget, so a frame from the socket of an Organisation the
/// person just left is recognisably stale.
#[derive(Debug, Clone, Serialize)]
pub struct AgentEnvelope {
    pub org: String,
    pub epoch: u64,
    pub ev: AgentEvent,
}

/// What the renderer may ask the REST doors for: the first path segment, by
/// method. Everything the contract lists, and nothing else, so a renderer bug
/// (or a model's text that reached one) cannot aim the member's token at a
/// door this client has no business calling.
const DOORS: &[(&str, &[&str])] = &[
    (
        "GET",
        &[
            "status",
            "effort",
            "settings",
            "notifications",
            "asks",
            "memory",
            "facts",
            "loops",
            "usage",
            "audit",
        ],
    ),
    ("POST", &["asks", "notifications", "loops"]),
    ("PUT", &["settings"]),
    ("PATCH", &["facts", "loops"]),
    ("DELETE", &["asks", "memory", "loops"]),
];

/// Is `method path` one of the agent's doors? `path` is `/segment[/…][?query]`:
/// each segment one id-like token, the query plain `key=value` pairs, and no
/// `org` in it — the manager adds the Organisation itself.
pub fn door_allowed(method: &str, path: &str) -> bool {
    let (route, query) = path.split_once('?').unwrap_or((path, ""));
    let Some(route) = route.strip_prefix('/') else {
        return false;
    };
    let segments: Vec<&str> = route.split('/').collect();
    let id_like = |s: &str| {
        !s.is_empty()
            && s.len() <= 200
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
            && s != "."
            && s != ".."
    };
    if segments.len() > 3 || !segments.iter().all(|s| id_like(s)) {
        return false;
    }
    let first = segments[0];
    let allowed = DOORS
        .iter()
        .any(|(m, roots)| *m == method && roots.contains(&first));
    if !allowed {
        return false;
    }
    // The second and third segments are an id and one known action.
    if segments.len() == 3 && !matches!(segments[2], "feedback") {
        return false;
    }
    if segments.len() == 2 && first == "notifications" && segments[1] != "read" {
        return false;
    }
    query.split('&').filter(|p| !p.is_empty()).all(|pair| {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        k != "org"
            && !k.is_empty()
            && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            && v.chars().all(|c| {
                c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '%' | '+' | '~')
            })
    })
}

/// The agent socket's URL for an Organisation, under `base`.
pub fn socket_url_at(base: &str, org_id: &str) -> String {
    format!("{}/ws?org={org_id}", ws_scheme(base))
}

struct Slot {
    org_id: String,
    epoch: u64,
    /// Cleared when the slot is replaced, or when the server refused it for
    /// good; the supervisor stops at the next look.
    alive: AtomicBool,
    outbound: Mutex<Option<mpsc::Sender<String>>>,
}

struct Inner {
    tokens: Arc<dyn TokenSource>,
    base: String,
    rest: RestClient,
    events: broadcast::Sender<AgentEnvelope>,
    current: Mutex<Option<Arc<Slot>>>,
    epoch: AtomicU64,
    state: Mutex<AgentConnState>,
}

/// The agent socket's supervisor, and the REST doors beside it.
#[derive(Clone)]
pub struct OrgAgentManager {
    inner: Arc<Inner>,
}

impl OrgAgentManager {
    pub fn new(tokens: Arc<dyn TokenSource>) -> Self {
        Self::with_base(tokens, agent_base())
    }

    /// Against another host: a local server, or a test's.
    pub fn with_base(tokens: Arc<dyn TokenSource>, base: String) -> Self {
        let (events, _) = broadcast::channel(EVENT_CAPACITY);
        let base = base.trim_end_matches('/').to_string();
        Self {
            inner: Arc::new(Inner {
                rest: RestClient::new(base.clone(), tokens.clone()),
                tokens,
                base,
                events,
                current: Mutex::new(None),
                epoch: AtomicU64::new(0),
                state: Mutex::new(AgentConnState::Disconnected),
            }),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AgentEnvelope> {
        self.inner.events.subscribe()
    }

    /// The Organisation the socket is for, if any.
    pub fn org_id(&self) -> Option<String> {
        self.inner
            .current
            .lock()
            .unwrap()
            .as_ref()
            .map(|s| s.org_id.clone())
    }

    /// The Organisation, the socket's epoch and where it stands.
    pub fn status(&self) -> (Option<String>, u64, AgentConnState) {
        let current = self.inner.current.lock().unwrap();
        let state = *self.inner.state.lock().unwrap();
        match current.as_ref() {
            Some(slot) => (Some(slot.org_id.clone()), slot.epoch, state),
            None => (None, self.inner.epoch.load(Ordering::SeqCst), state),
        }
    }

    /// Point the socket at `org`, or at nothing. The same Organisation again
    /// is a no-op while its socket is alive, so an auth broadcast that changed
    /// nothing does not drop it.
    pub fn set_target(&self, org: Option<String>) {
        let mut current = self.inner.current.lock().unwrap();
        if let (Some(slot), Some(org)) = (current.as_ref(), org.as_ref()) {
            if &slot.org_id == org && slot.alive.load(Ordering::SeqCst) {
                return;
            }
        }
        if let Some(old) = current.take() {
            old.alive.store(false, Ordering::SeqCst);
            old.outbound.lock().unwrap().take();
        }
        let epoch = self.inner.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        match org {
            Some(org_id) => {
                let slot = Arc::new(Slot {
                    org_id,
                    epoch,
                    alive: AtomicBool::new(true),
                    outbound: Mutex::new(None),
                });
                *current = Some(slot.clone());
                drop(current);
                self.spawn_supervisor(slot);
            }
            None => {
                drop(current);
                self.set_state(None, epoch, AgentConnState::Disconnected);
            }
        }
    }

    /// Dial again now: after the server refused (Atlas switched back on, say)
    /// or when the renderer has reason to think the socket is stale. A live
    /// socket is closed and redialled by its supervisor.
    pub fn reconnect(&self) {
        let org = {
            let current = self.inner.current.lock().unwrap();
            match current.as_ref() {
                Some(slot) if slot.alive.load(Ordering::SeqCst) => {
                    slot.outbound.lock().unwrap().take();
                    return;
                }
                Some(slot) => slot.org_id.clone(),
                None => return,
            }
        };
        // Refused earlier: a fresh slot for the same Organisation.
        self.inner.current.lock().unwrap().take();
        self.set_target(Some(org));
    }

    /// Send one client frame. `false` when the socket is not open: the caller
    /// keeps whatever must survive (the renderer's outbox) and sends it again
    /// on the next `Open`.
    pub fn send(&self, frame: String) -> bool {
        let slot = self.inner.current.lock().unwrap().clone();
        let Some(slot) = slot else { return false };
        let guard = slot.outbound.lock().unwrap();
        match guard.as_ref() {
            Some(tx) => tx.try_send(frame).is_ok(),
            None => false,
        }
    }

    /// One REST call, as the member, in the socket's Organisation.
    pub async fn rest(
        &self,
        method: &str,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> crate::Result<serde_json::Value> {
        if !door_allowed(method, path) {
            return Err(CommsError::Protocol(format!(
                "not an agent door: {method} {path}"
            )));
        }
        let org = self
            .org_id()
            .ok_or_else(|| CommsError::Token("no organization is connected".into()))?;
        let method = reqwest::Method::from_bytes(method.as_bytes())
            .map_err(|_| CommsError::Protocol("bad method".into()))?;
        self.inner.rest.raw(method, path, &org, body).await
    }

    fn set_state(&self, org: Option<&str>, epoch: u64, state: AgentConnState) {
        *self.inner.state.lock().unwrap() = state;
        let _ = self.inner.events.send(AgentEnvelope {
            org: org.unwrap_or_default().to_string(),
            epoch,
            ev: AgentEvent::Connection { state },
        });
    }

    fn spawn_supervisor(&self, slot: Arc<Slot>) {
        let me = self.clone();
        tokio::spawn(async move {
            let mut attempt: u32 = 0;
            let mut reminted_once = false;
            loop {
                if !slot.alive.load(Ordering::SeqCst) {
                    return;
                }
                me.set_state(Some(&slot.org_id), slot.epoch, AgentConnState::Connecting);
                let (reason, opened) = me.attempt_once(&slot).await;
                if !slot.alive.load(Ordering::SeqCst) {
                    return;
                }
                if opened {
                    attempt = 0;
                    reminted_once = false;
                }
                match reason {
                    ExitReason::Unauthorized if !reminted_once => {
                        // The token can expire between minting and dialling.
                        reminted_once = true;
                        continue;
                    }
                    ExitReason::Unauthorized | ExitReason::Forbidden | ExitReason::Evicted => {
                        // Not a member, removed, or Atlas off for the
                        // Organisation: dialling again cannot change that.
                        slot.alive.store(false, Ordering::SeqCst);
                        me.set_state(Some(&slot.org_id), slot.epoch, AgentConnState::Unavailable);
                        return;
                    }
                    ExitReason::Closed | ExitReason::Transport(_) => {
                        attempt = attempt.saturating_add(1);
                        me.set_state(Some(&slot.org_id), slot.epoch, AgentConnState::Backoff);
                        tokio::time::sleep(Duration::from_millis(backoff_ms(attempt - 1))).await;
                    }
                }
            }
        });
    }

    /// One dial-to-close cycle: why it ended, and whether it ever opened.
    async fn attempt_once(&self, slot: &Arc<Slot>) -> (ExitReason, bool) {
        let token = match self.inner.tokens.mint().await {
            Ok(t) => t,
            Err(CommsError::Token(e)) => {
                // No credential at all (signed out mid-flight): a verdict.
                tracing::warn!(target: "atlas_comms::org_agent", "no token: {e}");
                return (ExitReason::Unauthorized, false);
            }
            Err(e) => {
                tracing::warn!(target: "atlas_comms::org_agent", "token mint failed: {e}");
                return (ExitReason::Transport("mint".into()), false);
            }
        };
        let request = match ticket_request(socket_url_at(&self.inner.base, &slot.org_id), &token) {
            Ok(r) => r,
            Err(e) => {
                tracing::error!(target: "atlas_comms::org_agent", "bad request: {e}");
                return (ExitReason::Transport("request".into()), false);
            }
        };
        let (stream, _response) = match tokio_tungstenite::connect_async(request).await {
            Ok(ok) => ok,
            Err(err) => {
                // The classification only: the error can carry the request,
                // and the request the ticket.
                let reason = classify_handshake(&err);
                tracing::warn!(target: "atlas_comms::org_agent", "handshake failed: {reason:?}");
                return (reason, false);
            }
        };
        if !slot.alive.load(Ordering::SeqCst) {
            return (ExitReason::Closed, false);
        }

        let (tx, mut outbound) = mpsc::channel::<String>(OUTBOUND_CAP);
        *slot.outbound.lock().unwrap() = Some(tx);
        self.set_state(Some(&slot.org_id), slot.epoch, AgentConnState::Open);
        tracing::info!(target: "atlas_comms::org_agent", "agent socket open");

        let (mut write, mut read) = stream.split();
        let mut ping =
            tokio::time::interval_at(tokio::time::Instant::now() + PING_INTERVAL, PING_INTERVAL);
        let exit = loop {
            tokio::select! {
                incoming = read.next() => match incoming {
                    Some(Ok(WsMessage::Text(text))) => {
                        let _ = self.inner.events.send(AgentEnvelope {
                            org: slot.org_id.clone(),
                            epoch: slot.epoch,
                            ev: AgentEvent::Frame { frame: text.to_string() },
                        });
                    }
                    Some(Ok(WsMessage::Close(frame))) => {
                        // 1008: access was taken away (`WS_CLOSE_REVOKED`).
                        let revoked = frame.as_ref().is_some_and(|f| u16::from(f.code) == 1008);
                        break if revoked { ExitReason::Evicted } else { ExitReason::Closed };
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => break ExitReason::Transport(e.to_string()),
                    None => break ExitReason::Closed,
                },
                to_send = outbound.recv() => match to_send {
                    Some(text) => {
                        if let Err(e) = write.send(WsMessage::Text(text.into())).await {
                            break ExitReason::Transport(e.to_string());
                        }
                    }
                    // Sender taken: a retarget, or a deliberate redial.
                    None => {
                        let _ = write.send(WsMessage::Close(None)).await;
                        break ExitReason::Closed;
                    }
                },
                _ = ping.tick() => {
                    if let Err(e) = write.send(WsMessage::Text(r#"{"t":"ping"}"#.into())).await {
                        break ExitReason::Transport(e.to_string());
                    }
                }
            }
        };
        slot.outbound.lock().unwrap().take();
        tracing::info!(target: "atlas_comms::org_agent", "agent socket closed: {exit:?}");
        (exit, true)
    }
}

fn backoff_ms(attempt: u32) -> u64 {
    RECONNECT_BASE_MS
        .saturating_mul(1u64 << attempt.min(20))
        .min(RECONNECT_MAX_MS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;
    use std::pin::Pin;
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
    use tokio_tungstenite::tungstenite::http::HeaderValue;

    struct Fixed(&'static str);
    impl TokenSource for Fixed {
        fn mint(&self) -> Pin<Box<dyn Future<Output = crate::Result<String>> + Send + '_>> {
            let t = self.0.to_string();
            Box::pin(async move { Ok(t) })
        }
    }

    #[test]
    fn every_documented_door_is_allowed() {
        for (m, p) in [
            ("GET", "/status"),
            ("GET", "/effort"),
            ("GET", "/settings"),
            ("PUT", "/settings"),
            ("GET", "/notifications"),
            ("POST", "/notifications/read"),
            ("GET", "/asks?kind=ask&cursor=1793600000000.a1"),
            (
                "GET",
                "/asks/dc16c765-d751-46a5-99d5-ea5fe75de1c7?after_seq=12",
            ),
            ("DELETE", "/asks/a1"),
            ("POST", "/asks/a1/feedback"),
            ("GET", "/memory"),
            ("DELETE", "/memory/m1"),
            ("GET", "/facts?status=candidate&q=pay%20ments"),
            ("PATCH", "/facts/f1"),
            ("GET", "/loops"),
            ("GET", "/loops?all=1"),
            ("POST", "/loops"),
            ("PATCH", "/loops/l1"),
            ("DELETE", "/loops/l1"),
            ("GET", "/usage?range=7d"),
            ("GET", "/audit?cursor=1793600000000.x"),
        ] {
            assert!(door_allowed(m, p), "{m} {p} should be allowed");
        }
    }

    #[test]
    fn anything_else_is_refused() {
        for (m, p) in [
            ("GET", "status"),                 // not a path
            ("GET", "/ws"),                    // the socket is not a REST door
            ("POST", "/status"),               // wrong method for the door
            ("DELETE", "/facts/f1"),           // facts are retired, never deleted
            ("GET", "/asks/../status"),        // traversal
            ("GET", "/asks/a b"),              // whitespace
            ("GET", "/asks/a1/events"),        // unknown action
            ("POST", "/notifications/unread"), // unknown action
            ("GET", "/status?org=other"),      // the org is never the caller's to name
            ("GET", "/asks?cursor=a&x=<b>"),   // unescaped query
            ("GET", "//evil.example/status"),  // scheme-relative
            ("GET", "/asks/a1/feedback/x"),    // too deep
            ("CONNECT", "/status"),
        ] {
            assert!(!door_allowed(m, p), "{m} {p} should be refused");
        }
    }

    #[test]
    fn the_socket_url_rewrites_the_scheme_and_names_the_org() {
        assert_eq!(
            socket_url_at("https://app.tryatlas.cc/api/agent", "o1"),
            "wss://app.tryatlas.cc/api/agent/ws?org=o1"
        );
        assert_eq!(
            socket_url_at("http://127.0.0.1:9/x", "o1"),
            "ws://127.0.0.1:9/x/ws?org=o1"
        );
    }

    #[test]
    fn backoff_doubles_to_its_ceiling() {
        assert_eq!(backoff_ms(0), 1_000);
        assert_eq!(backoff_ms(1), 2_000);
        assert_eq!(backoff_ms(10), 30_000);
        assert_eq!(backoff_ms(u32::MAX), 30_000);
    }

    #[test]
    fn an_envelope_serialises_as_the_renderer_reads_it() {
        let frame = serde_json::to_value(AgentEnvelope {
            org: "o1".into(),
            epoch: 3,
            ev: AgentEvent::Frame {
                frame: "{\"t\":\"pong\"}".into(),
            },
        })
        .unwrap();
        assert_eq!(
            frame,
            serde_json::json!({"org":"o1","epoch":3,"ev":{"kind":"frame","frame":"{\"t\":\"pong\"}"}})
        );
        let conn = serde_json::to_value(AgentEnvelope {
            org: "o1".into(),
            epoch: 3,
            ev: AgentEvent::Connection {
                state: AgentConnState::Unavailable,
            },
        })
        .unwrap();
        assert_eq!(
            conn,
            serde_json::json!({"org":"o1","epoch":3,"ev":{"kind":"connection","state":"unavailable"}})
        );
    }

    #[test]
    fn nothing_is_sent_without_a_socket() {
        let mgr = OrgAgentManager::with_base(Arc::new(Fixed("t")), "http://127.0.0.1:9".into());
        assert!(!mgr.send("{\"t\":\"ping\"}".into()));
        assert_eq!(mgr.status().2, AgentConnState::Disconnected);
    }

    /// A local server speaking the agent's socket: checks the offer carries the
    /// ticket, answers `ping` with `pong`, echoes anything else back as an
    /// event, and closes with `close_code` after `close_after` frames.
    async fn serve(
        close_after: usize,
        close_code: Option<u16>,
    ) -> (String, mpsc::UnboundedReceiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (seen_tx, seen_rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            loop {
                let Ok((tcp, _)) = listener.accept().await else {
                    return;
                };
                let seen = seen_tx.clone();
                tokio::spawn(async move {
                    let offer = Arc::new(Mutex::new(String::new()));
                    let offer2 = offer.clone();
                    let ws = tokio_tungstenite::accept_hdr_async(
                        tcp,
                        move |req: &Request, mut res: Response| {
                            *offer2.lock().unwrap() = format!(
                                "{} {}",
                                req.uri(),
                                req.headers()
                                    .get("sec-websocket-protocol")
                                    .and_then(|v| v.to_str().ok())
                                    .unwrap_or("")
                            );
                            res.headers_mut().insert(
                                "sec-websocket-protocol",
                                HeaderValue::from_static("atlas.v1"),
                            );
                            Ok(res)
                        },
                    )
                    .await
                    .unwrap();
                    let _ = seen.send(format!("dial {}", offer.lock().unwrap()));
                    let (mut w, mut r) = ws.split();
                    let mut n = 0;
                    while let Some(Ok(WsMessage::Text(t))) = r.next().await {
                        let _ = seen.send(t.to_string());
                        let reply = if t.contains("\"ping\"") {
                            r#"{"t":"pong"}"#.to_string()
                        } else {
                            format!(
                                r#"{{"t":"event","ask_id":"a1","seq":{},"kind":"text_delta","at":1,"payload":{{"text":"ok"}}}}"#,
                                n + 1
                            )
                        };
                        w.send(WsMessage::Text(reply.into())).await.unwrap();
                        n += 1;
                        if n >= close_after {
                            let frame = close_code.map(|code| {
                                tokio_tungstenite::tungstenite::protocol::CloseFrame {
                                    code: code.into(),
                                    reason: "".into(),
                                }
                            });
                            let _ = w.send(WsMessage::Close(frame)).await;
                            return;
                        }
                    }
                });
            }
        });
        (base, seen_rx)
    }

    async fn next_where(
        rx: &mut broadcast::Receiver<AgentEnvelope>,
        pred: impl Fn(&AgentEnvelope) -> bool,
    ) -> AgentEnvelope {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let env = rx.recv().await.unwrap();
                if pred(&env) {
                    return env;
                }
            }
        })
        .await
        .expect("event in time")
    }

    fn is_state(s: AgentConnState) -> impl Fn(&AgentEnvelope) -> bool {
        move |e| matches!(e.ev, AgentEvent::Connection { state } if state == s)
    }

    #[tokio::test]
    async fn dials_with_the_ticket_relays_frames_and_sends() {
        let (base, mut seen) = serve(100, None).await;
        let mgr = OrgAgentManager::with_base(Arc::new(Fixed("jwt-1")), base);
        let mut rx = mgr.subscribe();
        mgr.set_target(Some("org_a".into()));
        let open = next_where(&mut rx, is_state(AgentConnState::Open)).await;
        assert_eq!(open.org, "org_a");

        let dial = seen.recv().await.unwrap();
        assert_eq!(dial, "dial /ws?org=org_a atlas.v1, atlas.ticket.jwt-1");

        assert!(mgr.send(r#"{"t":"ping"}"#.into()));
        let pong = next_where(&mut rx, |e| matches!(&e.ev, AgentEvent::Frame { .. })).await;
        assert!(matches!(&pong.ev, AgentEvent::Frame { frame } if frame == r#"{"t":"pong"}"#));
        assert_eq!(pong.epoch, open.epoch);

        assert!(mgr.send(r#"{"t":"resume","ask_id":"a1","after_seq":0}"#.into()));
        let event = next_where(
            &mut rx,
            |e| matches!(&e.ev, AgentEvent::Frame { frame } if frame.contains("text_delta")),
        )
        .await;
        assert_eq!(event.org, "org_a");
    }

    #[tokio::test]
    async fn a_dropped_socket_redials_and_announces_open_again() {
        let (base, _seen) = serve(1, None).await;
        let mgr = OrgAgentManager::with_base(Arc::new(Fixed("jwt")), base);
        let mut rx = mgr.subscribe();
        mgr.set_target(Some("org_a".into()));
        next_where(&mut rx, is_state(AgentConnState::Open)).await;
        assert!(mgr.send(r#"{"t":"ping"}"#.into()));
        next_where(&mut rx, is_state(AgentConnState::Backoff)).await;
        // Open again: the renderer's cue to resume every Ask it holds.
        next_where(&mut rx, is_state(AgentConnState::Open)).await;
    }

    #[tokio::test]
    async fn a_revoked_socket_stops_dialling_until_asked() {
        let (base, mut seen) = serve(1, Some(1008)).await;
        let mgr = OrgAgentManager::with_base(Arc::new(Fixed("jwt")), base);
        let mut rx = mgr.subscribe();
        mgr.set_target(Some("org_a".into()));
        next_where(&mut rx, is_state(AgentConnState::Open)).await;
        mgr.send(r#"{"t":"ping"}"#.into());
        next_where(&mut rx, is_state(AgentConnState::Unavailable)).await;
        assert_eq!(mgr.status().2, AgentConnState::Unavailable);
        assert!(!mgr.send(r#"{"t":"ping"}"#.into()));

        // Asked to try again: a fresh dial.
        while seen.try_recv().is_ok() {}
        mgr.reconnect();
        next_where(&mut rx, is_state(AgentConnState::Open)).await;
        assert!(seen.recv().await.unwrap().starts_with("dial "));
    }

    #[tokio::test]
    async fn retargeting_moves_the_epoch_and_the_same_org_keeps_the_socket() {
        let (base, mut seen) = serve(100, None).await;
        let mgr = OrgAgentManager::with_base(Arc::new(Fixed("jwt")), base);
        let mut rx = mgr.subscribe();
        mgr.set_target(Some("org_a".into()));
        let first = next_where(&mut rx, is_state(AgentConnState::Open)).await;
        assert!(seen.recv().await.unwrap().contains("org=org_a"));

        mgr.set_target(Some("org_a".into()));
        assert_eq!(mgr.status().1, first.epoch, "same org, same socket");

        mgr.set_target(Some("org_b".into()));
        let second = next_where(&mut rx, |e| {
            e.org == "org_b" && is_state(AgentConnState::Open)(e)
        })
        .await;
        assert!(second.epoch > first.epoch);
        assert!(seen.recv().await.unwrap().contains("org=org_b"));

        mgr.set_target(None);
        next_where(&mut rx, is_state(AgentConnState::Disconnected)).await;
        assert_eq!(mgr.org_id(), None);
        assert!(!mgr.send(r#"{"t":"ping"}"#.into()));
    }

    #[tokio::test]
    async fn rest_refuses_an_unknown_door_before_any_request() {
        let mgr = OrgAgentManager::with_base(Arc::new(Fixed("jwt")), "http://127.0.0.1:9".into());
        mgr.set_target(None);
        let err = mgr.rest("GET", "/ws", None).await.unwrap_err();
        assert!(matches!(err, CommsError::Protocol(_)));
        let err = mgr.rest("GET", "/status", None).await.unwrap_err();
        assert!(matches!(err, CommsError::Token(_)), "no org: {err:?}");
    }
}
