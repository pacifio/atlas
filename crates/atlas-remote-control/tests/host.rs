//! The host supervisor against a fake room object on loopback: the handshake,
//! the resync-then-snapshot join, the coalesced stream, the command round
//! trip, and the room's end.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use atlas_agent_wire::{AgentId, SessionDelta, SessionDeltaEnvelope, SessionStatus};
use atlas_remote_control::codec::{
    decode_delta_batch, decode_frame, FRAME_FLAG_MORE, FRAME_KIND_DELTA_BATCH, FRAME_KIND_SNAPSHOT,
};
use atlas_remote_control::wire::{Capability, Command, PrincipalRef};
use atlas_remote_control::{
    spawn, HostConfig, HostStatus, LinkState, Refusal, SessionPort, SnapshotDoc,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::WebSocketStream;

const SESSION: &str = "ses_rc";
const ULID: &str = "01JB8Z5G7Q2W3E4R5T6Y7V8X9Z";
const ULID2: &str = "01JB8Z5G7Q2W3E4R5T6Y7V8XA0";
const SECRET: &str = "9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b";
/// A control request's `expiresAt` that the host's expiry prune (ms since the
/// epoch) will not have passed: the year 5138.
const FAR_FUTURE_MS: u64 = 100_000_000_000_000;

struct StaticToken;

impl atlas_artifacts::TokenSource for StaticToken {
    fn mint(&self) -> Pin<Box<dyn Future<Output = atlas_artifacts::Result<String>> + Send + '_>> {
        Box::pin(async { Ok("tok".to_string()) })
    }
}

#[derive(Default)]
struct FakeSession {
    seq: AtomicU64,
    commands: Mutex<Vec<(String, Command)>>,
}

impl SessionPort for FakeSession {
    fn snapshot(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<SnapshotDoc, String>> + Send + 'static>> {
        let as_of = self.seq.load(Ordering::SeqCst);
        Box::pin(async move {
            Ok(SnapshotDoc {
                as_of_seq: as_of,
                document: json!({ "as_of_seq": as_of, "messages": [], "status": "idle" }),
            })
        })
    }

    fn execute(
        &self,
        from: PrincipalRef,
        command: Command,
    ) -> Pin<Box<dyn Future<Output = Result<(), Refusal>> + Send + 'static>> {
        self.commands.lock().unwrap().push((from.id, command));
        Box::pin(async { Ok(()) })
    }
}

fn envelope(seq: u64, delta: SessionDelta) -> SessionDeltaEnvelope {
    SessionDeltaEnvelope {
        agent_id: AgentId::new(),
        session_id: SESSION.into(),
        seq,
        delta,
    }
}

fn text(seq: u64) -> SessionDeltaEnvelope {
    envelope(
        seq,
        SessionDelta::TextChunk {
            message_id: "m1".into(),
            delta: format!("t{seq}"),
        },
    )
}

type Accepted = mpsc::UnboundedReceiver<(WebSocketStream<TcpStream>, String)>;

async fn listen() -> (String, Accepted) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("ws://{}", listener.local_addr().unwrap());
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let tx = tx.clone();
            tokio::spawn(async move {
                let offered = Arc::new(Mutex::new(String::new()));
                let seen = offered.clone();
                let ws = tokio_tungstenite::accept_hdr_async(
                    stream,
                    move |req: &Request, mut res: Response| {
                        *seen.lock().unwrap() = format!(
                            "{}?{}|{}",
                            req.uri().path(),
                            req.uri().query().unwrap_or(""),
                            req.headers()
                                .get("Sec-WebSocket-Protocol")
                                .and_then(|v| v.to_str().ok())
                                .unwrap_or("")
                        );
                        res.headers_mut().insert(
                            "Sec-WebSocket-Protocol",
                            HeaderValue::from_static("atlas.v1"),
                        );
                        Ok(res)
                    },
                )
                .await
                .unwrap();
                let offered = offered.lock().unwrap().clone();
                let _ = tx.send((ws, offered));
            });
        }
    });
    (base, rx)
}

async fn next_text(ws: &mut WebSocketStream<TcpStream>) -> Value {
    loop {
        let message = timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("a frame")
            .unwrap()
            .unwrap();
        match message {
            WsMessage::Text(t) if t.as_str() == "ping" => continue,
            WsMessage::Text(t) => return serde_json::from_str(t.as_str()).unwrap(),
            WsMessage::Binary(_) => panic!("expected text, got binary"),
            _ => continue,
        }
    }
}

async fn next_binary(ws: &mut WebSocketStream<TcpStream>) -> Vec<u8> {
    loop {
        let message = timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("a frame")
            .unwrap()
            .unwrap();
        match message {
            WsMessage::Binary(b) => return b.to_vec(),
            WsMessage::Text(t) if t.as_str() == "ping" => continue,
            WsMessage::Text(t) => panic!("expected binary, got {t}"),
            _ => continue,
        }
    }
}

async fn send(ws: &mut WebSocketStream<TcpStream>, frame: Value) {
    ws.send(WsMessage::Text(frame.to_string().into()))
        .await
        .unwrap();
}

async fn until(what: &str, check: impl Fn() -> bool) {
    for _ in 0..500 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for {what}");
}

fn config(base: String, capabilities: Vec<Capability>) -> HostConfig {
    let mut cfg = HostConfig::new(
        "01ROOM".into(),
        SESSION.into(),
        "user_owner".into(),
        "desk-7f3a9c21".into(),
        SECRET.into(),
        "atlas-agent".into(),
        Some("claude-opus-5".into()),
        capabilities,
    );
    cfg.ws_base = base;
    cfg
}

fn welcome(head: u64, wants: &str) -> Value {
    json!({
        "t": "rc.welcome", "protocol": 1, "roomId": "01ROOM", "orgId": null, "workspaceId": null, "role": "host",
        "head": head, "driverEpoch": 1,
        "driver": { "id": "user_owner", "kind": "user", "name": null },
        "snapshotAsOf": null, "wants": wants
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn a_host_joins_streams_takes_commands_and_ends_with_the_room() {
    let (base, mut accepted) = listen().await;
    let session = Arc::new(FakeSession::default());
    session.seq.store(5, Ordering::SeqCst);
    let statuses: Arc<Mutex<Vec<HostStatus>>> = Arc::default();
    let seen = statuses.clone();
    let handle = spawn(
        config(base, vec![Capability::Steer, Capability::Approve]),
        Arc::new(StaticToken),
        session.clone(),
        Arc::new(move |s| seen.lock().unwrap().push(s)),
    );

    // Buffered before the first sync, and at or below the snapshot: dropped.
    handle.offer(&text(4));
    handle.offer(&text(5));

    let (mut ws, offered) = timeout(Duration::from_secs(5), accepted.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        offered,
        "/rc/host/ws?room=01ROOM|atlas.v1, atlas.ticket.tok"
    );

    let hello = next_text(&mut ws).await;
    assert_eq!(hello["t"], "rc.hello");
    assert_eq!(hello["role"], "host");
    assert_eq!(hello["hostSecret"], SECRET);
    assert_eq!(hello["clientId"], "desk-7f3a9c21");
    assert_eq!(hello["as_of_seq"], 5);
    assert_eq!(hello["capabilities"], json!(["steer", "approve"]));

    send(&mut ws, welcome(0, "snapshot")).await;

    // `wants: snapshot` → `rc.resync { as_of_seq }` then kind-2 parts.
    let resync = next_text(&mut ws).await;
    assert_eq!(resync, json!({ "t": "rc.resync", "as_of_seq": 5 }));
    let part = decode_frame(&next_binary(&mut ws).await).unwrap();
    assert_eq!(
        (part.kind, part.seq_first, part.count),
        (FRAME_KIND_SNAPSHOT, 5, 1)
    );
    assert_eq!(part.flags & FRAME_FLAG_MORE, 0, "one part");
    let snapshot: Value = serde_json::from_slice(&part.payload).unwrap();
    assert_eq!(snapshot["as_of_seq"], 5);

    until("live", || handle.status().state == LinkState::Live).await;

    send(
        &mut ws,
        json!({
            "t": "rc.roster", "scope": "full", "driverEpoch": 1, "ownerOnline": true,
            "driver": { "id": "user_owner", "kind": "user", "name": null },
            "peers": [
                { "peerId": "phone-0001", "id": "user_owner", "kind": "user", "name": null,
                  "surface": "mobile", "role": "owner", "tier": "steer_approve", "since": 1 },
                { "peerId": "web-tab-0001", "id": "user_owner", "kind": "user", "name": null,
                  "surface": "web", "role": "owner", "tier": "steer_approve", "since": 2 },
                { "peerId": "web-tab-0002", "id": "user_member", "kind": "user", "name": null,
                  "surface": "web", "role": "visitor", "tier": "view", "since": 3 }
            ]
        }),
    )
    .await;
    until("the roster counted", || handle.status().viewers == 2).await;

    // Text is held for the window; a status flushes it with everything
    // before it, in one dense run from as_of + 1.
    session.seq.store(8, Ordering::SeqCst);
    handle.offer(&text(6));
    handle.offer(&text(7));
    handle.offer(&envelope(
        8,
        SessionDelta::Status {
            status: SessionStatus::Idle,
            turn_seq: 1,
        },
    ));
    let mut seqs = Vec::new();
    while seqs.last() != Some(&8) {
        let frame = decode_frame(&next_binary(&mut ws).await).unwrap();
        assert_eq!(frame.kind, FRAME_KIND_DELTA_BATCH);
        for (i, e) in decode_delta_batch(&frame).unwrap().into_iter().enumerate() {
            let e: Value = serde_json::from_slice(&e).unwrap();
            assert_eq!(e["seq"], frame.seq_first + i as u64);
            seqs.push(e["seq"].as_u64().unwrap());
        }
    }
    assert_eq!(seqs, [6, 7, 8]);

    // A command from the owner runs and is answered with `fromId`.
    let command = json!({
        "t": "rc.command", "commandId": ULID, "driverEpoch": 1,
        "from": { "id": "user_owner", "kind": "user", "name": "Ada" },
        "command": { "kind": "submit", "content": "Run the tests again" }
    });
    send(&mut ws, command.clone()).await;
    let result = next_text(&mut ws).await;
    assert_eq!(
        result,
        json!({ "t": "rc.command_result", "commandId": ULID, "fromId": "user_owner", "ok": true })
    );
    assert_eq!(session.commands.lock().unwrap().len(), 1);

    // The same `(from, commandId)` again is a no-op.
    send(&mut ws, command).await;

    // Someone who is not the driver is refused by the desktop.
    send(
        &mut ws,
        json!({
            "t": "rc.command", "commandId": ULID2, "driverEpoch": 1,
            "from": { "id": "user_member", "kind": "user", "name": null },
            "command": { "kind": "stop" }
        }),
    )
    .await;
    let refused = next_text(&mut ws).await;
    assert_eq!(refused["commandId"], ULID2);
    assert_eq!(refused["fromId"], "user_member");
    assert_eq!(refused["ok"], false);
    assert_eq!(refused["refusedBy"], "desktop");
    assert_eq!(refused["gate"], "not_driver");
    assert_eq!(
        session.commands.lock().unwrap().len(),
        1,
        "the repeat ran nothing"
    );

    // A visitor asks to drive: the host hears it and the owner answers from
    // the desktop; the room hands the seat over with a new epoch.
    send(
        &mut ws,
        json!({
            "t": "rc.control_request",
            "request": { "requestId": "req_1", "from": { "id": "user_member", "kind": "user", "name": "Ada" },
                         "status": "pending", "requestedAt": 10, "expiresAt": FAR_FUTURE_MS, "answeredAt": null, "reason": null }
        }),
    )
    .await;
    until("the request is pending", || {
        handle.status().pending.len() == 1
    })
    .await;
    // One the object already timed out never reaches the owner's list.
    send(
        &mut ws,
        json!({
            "t": "rc.control_request",
            "request": { "requestId": "req_stale", "from": { "id": "user_other", "kind": "user", "name": null },
                         "status": "pending", "requestedAt": 10, "expiresAt": 70, "answeredAt": null, "reason": null }
        }),
    )
    .await;
    handle.answer_control("req_1", true).unwrap();
    let answer = next_text(&mut ws).await;
    assert_eq!(
        answer,
        json!({ "t": "rc.control_answer", "requestId": "req_1", "approve": true })
    );
    send(
        &mut ws,
        json!({
            "t": "rc.control_request",
            "request": { "requestId": "req_1", "from": { "id": "user_member", "kind": "user", "name": "Ada" },
                         "status": "approved", "requestedAt": 10, "expiresAt": FAR_FUTURE_MS, "answeredAt": 11, "reason": null }
        }),
    )
    .await;
    send(
        &mut ws,
        json!({
            "t": "rc.roster", "scope": "full", "driverEpoch": 2, "ownerOnline": true,
            "driver": { "id": "user_member", "kind": "user", "name": "Ada" },
            "peers": [
                { "peerId": "web-tab-0002", "id": "user_member", "kind": "user", "name": "Ada",
                  "surface": "web", "role": "driver", "tier": "steer", "since": 3 }
            ]
        }),
    )
    .await;
    until("the seat moved", || handle.status().driver_epoch == 2).await;
    let status = handle.status();
    assert!(status.pending.is_empty());
    assert!(status.driven_by_someone_else("user_owner"));
    assert_eq!(
        status
            .driver
            .as_ref()
            .and_then(|d| d.name.clone())
            .as_deref(),
        Some("Ada")
    );

    // Now the owner's own remote prompt is refused by the desktop, and the
    // member's runs.
    send(
        &mut ws,
        json!({
            "t": "rc.command", "commandId": "01JB8Z5G7Q2W3E4R5T6Y7V8XA1", "driverEpoch": 2,
            "from": { "id": "user_owner", "kind": "user", "name": null },
            "command": { "kind": "submit", "content": "Me again" }
        }),
    )
    .await;
    let refused = next_text(&mut ws).await;
    assert_eq!(refused["ok"], false);
    assert_eq!(refused["gate"], "not_driver");
    send(
        &mut ws,
        json!({
            "t": "rc.command", "commandId": "01JB8Z5G7Q2W3E4R5T6Y7V8XA2", "driverEpoch": 2,
            "from": { "id": "user_member", "kind": "user", "name": "Ada" },
            "command": { "kind": "submit", "content": "Ada's turn" }
        }),
    )
    .await;
    let ran = next_text(&mut ws).await;
    assert_eq!(ran["ok"], true);
    assert_eq!(session.commands.lock().unwrap().len(), 2);

    // The owner takes the seat back from the desktop.
    handle.take_over().unwrap();
    assert_eq!(next_text(&mut ws).await, json!({ "t": "rc.take_over" }));

    // The room ends: `rc.closed`, then 4410.
    send(
        &mut ws,
        json!({ "t": "rc.closed", "reason": "closed_by_owner" }),
    )
    .await;
    let _ = ws
        .send(WsMessage::Close(Some(CloseFrame {
            code: CloseCode::from(4410),
            reason: "room closed".into(),
        })))
        .await;
    until("ended", || handle.status().state == LinkState::Ended).await;
    let last = statuses.lock().unwrap().last().cloned().unwrap();
    assert_eq!(last.state, LinkState::Ended);
    assert_eq!(
        serde_json::to_value(last.end_reason).unwrap(),
        json!("closed_by_owner")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_overflowing_queue_is_answered_with_a_resync_not_a_gap() {
    let (base, mut accepted) = listen().await;
    let session = Arc::new(FakeSession::default());
    session.seq.store(1, Ordering::SeqCst);
    let mut cfg = config(base, vec![Capability::Steer]);
    cfg.queue_capacity = 4;
    let handle = spawn(
        cfg,
        Arc::new(StaticToken),
        session.clone(),
        Arc::new(|_| {}),
    );

    let (mut ws, _) = timeout(Duration::from_secs(5), accepted.recv())
        .await
        .unwrap()
        .unwrap();
    let hello = next_text(&mut ws).await;
    assert_eq!(hello["as_of_seq"], 1);
    // The room already holds exactly this much: nothing to send.
    send(&mut ws, welcome(1, "nothing")).await;
    until("live", || handle.status().state == LinkState::Live).await;

    // Far more than the queue holds, faster than it drains.
    session.seq.store(400, Ordering::SeqCst);
    for seq in 2..=400 {
        handle.offer(&text(seq));
    }
    // What follows: delta frames that never skip a seq, until an
    // `rc.resync { as_of_seq }` and its snapshot carry the room past the loss.
    let mut floor = 1u64;
    let mut resynced = false;
    while floor < 400 {
        let message = timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("a frame")
            .unwrap()
            .unwrap();
        match message {
            WsMessage::Text(t) if t.as_str() == "ping" => {}
            WsMessage::Text(t) => {
                let v: Value = serde_json::from_str(t.as_str()).unwrap();
                assert_eq!(v["t"], "rc.resync");
                resynced = true;
                floor = v["as_of_seq"].as_u64().unwrap();
            }
            WsMessage::Binary(b) => {
                let frame = decode_frame(&b).unwrap();
                if frame.kind == FRAME_KIND_SNAPSHOT {
                    assert!(resynced);
                    assert_eq!(frame.seq_first, floor);
                } else {
                    assert_eq!(frame.seq_first, floor + 1, "dense, or resynced past");
                    floor = frame.seq_last();
                }
            }
            _ => {}
        }
    }
    assert!(resynced, "the overflow was announced");
    handle.stop();
    // Once stopped, a control frame has nowhere to go.
    until("stopped", || {
        handle.status().state != LinkState::Live || handle.take_over().is_err()
    })
    .await;
}

/// Records a command when it *finishes*, and takes its time over the first:
/// with a task per command the runtime may finish the second one first.
#[derive(Default)]
struct OrderedSession {
    finished: Arc<Mutex<Vec<String>>>,
}

impl SessionPort for OrderedSession {
    fn snapshot(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<SnapshotDoc, String>> + Send + 'static>> {
        Box::pin(async {
            Ok(SnapshotDoc {
                as_of_seq: 0,
                document: json!({ "as_of_seq": 0, "messages": [], "status": "idle" }),
            })
        })
    }

    fn execute(
        &self,
        _from: PrincipalRef,
        command: Command,
    ) -> Pin<Box<dyn Future<Output = Result<(), Refusal>> + Send + 'static>> {
        let finished = self.finished.clone();
        Box::pin(async move {
            let label = match command {
                Command::Submit { content, .. } => content,
                other => other.kind().as_str().to_string(),
            };
            if label.starts_with("slow") {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            finished.lock().unwrap().push(label);
            Ok(())
        })
    }
}

/// Commands run in the order the room relayed them: a driver's "run the
/// tests" then "now commit" must not swap, nor a stop and the prompt after it.
#[tokio::test(flavor = "multi_thread")]
async fn commands_run_in_the_order_the_room_relayed_them() {
    let (base, mut accepted) = listen().await;
    let session = Arc::new(OrderedSession::default());
    let finished = session.finished.clone();
    let handle = spawn(
        config(base, vec![Capability::Steer, Capability::Approve]),
        Arc::new(StaticToken),
        session,
        Arc::new(|_| {}),
    );
    let (mut ws, _) = timeout(Duration::from_secs(5), accepted.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(next_text(&mut ws).await["t"], "rc.hello");
    send(&mut ws, welcome(0, "nothing")).await;
    until("live", || handle.status().state == LinkState::Live).await;

    for (id, content) in [
        ("01JB8Z5G7Q2W3E4R5T6Y7V8XB1", "slow: run the tests"),
        ("01JB8Z5G7Q2W3E4R5T6Y7V8XB2", "now commit"),
    ] {
        send(
            &mut ws,
            json!({
                "t": "rc.command", "commandId": id, "driverEpoch": 1,
                "from": { "id": "user_owner", "kind": "user", "name": null },
                "command": { "kind": "submit", "content": content }
            }),
        )
        .await;
    }
    for _ in 0..2 {
        assert_eq!(next_text(&mut ws).await["t"], "rc.command_result");
    }
    assert_eq!(
        *finished.lock().unwrap(),
        ["slow: run the tests", "now commit"]
    );
}
