//! The outbox drain, against a real HTTP server on loopback.
//!
//! No mock traits: the base URL is injected, so these drive the real client
//! against a real socket — the same pattern the auth tests use, and for the same
//! reason. What is asserted is what reached the server and what state the local
//! rows ended in.
//!
//! **The server contract this encodes does not exist yet** (ATL-57). These tests
//! are therefore also the written form of that contract: a 202 means durably
//! accepted, per-artifact results are echoed by row id, and 401/403/429 are
//! distinguishable. The drain must not ship against an endpoint that has not
//! adopted it.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use atlas_checkpoint::artifacts::AtlasArtifact;
use atlas_checkpoint::model::WorkspaceMode;
use atlas_checkpoint::{
    bind, drain, Capture, DrainStatus, Role, SessionKey, Source, Store, SyncConfig, TurnContent,
    SPILL_THRESHOLD_BYTES,
};

const WORKSPACE: &str = "ws-atlas";
/// The server-assigned wire identity — deliberately distinct from the local
/// row key above, so a test can assert the payload never carries the local one.
const WIRE_WORKSPACE: &str = "rw-atlas-remote";
const ORG: &str = "org-tryatlas";

// ── A stub ingest server ────────────────────────────────────────────────────

/// How the stub should answer the next ingest request.
#[derive(Clone, Debug)]
enum Reply {
    Accept,
    /// Accept some rows and reject others, by row-id substring.
    Partial { reject: Vec<String> },
    Status(u16),
    /// Accept, but only once the token has been refreshed.
    ExpireOnce,
    /// 400 for any batch whose raw body contains this substring; accept the
    /// rest. Content-based, so it models a server that rejects whole batches
    /// without naming the offending row — the case the bisect exists for.
    RejectContaining(String),
    /// 429 with a `Retry-After` header of this many seconds.
    RetryAfter(u64),
}

struct Stub {
    base_url: String,
    received: Arc<Mutex<Vec<AtlasArtifact>>>,
    blobs: Arc<Mutex<Vec<String>>>,
    ingest_calls: Arc<AtomicUsize>,
    blob_calls: Arc<AtomicUsize>,
    blob_tokens: Arc<Mutex<Vec<String>>>,
}

impl Stub {
    fn start(replies: Vec<Reply>, blob_status: u16) -> Self {
        Self::start_full(replies, Vec::new(), blob_status)
    }

    /// `blob_replies` answers blob uploads by call index; `blob_status` is the
    /// fallback once the list is exhausted.
    fn start_full(replies: Vec<Reply>, blob_replies: Vec<u16>, blob_status: u16) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let received = Arc::new(Mutex::new(Vec::new()));
        let blobs = Arc::new(Mutex::new(Vec::new()));
        let ingest_calls = Arc::new(AtomicUsize::new(0));
        let blob_calls = Arc::new(AtomicUsize::new(0));
        let blob_tokens = Arc::new(Mutex::new(Vec::new()));

        let stub = Self {
            base_url,
            received: received.clone(),
            blobs: blobs.clone(),
            ingest_calls: ingest_calls.clone(),
            blob_calls: blob_calls.clone(),
            blob_tokens: blob_tokens.clone(),
        };

        std::thread::spawn(move || {
            let mut seen_tokens: Vec<String> = Vec::new();
            for stream in listener.incoming() {
                let Ok(stream) = stream else { break };
                handle(
                    stream,
                    &replies,
                    &blob_replies,
                    blob_status,
                    &received,
                    &blobs,
                    &ingest_calls,
                    &blob_calls,
                    &blob_tokens,
                    &mut seen_tokens,
                );
            }
        });
        stub
    }

    fn artifacts(&self) -> Vec<AtlasArtifact> {
        self.received.lock().unwrap().clone()
    }

    fn blob_keys(&self) -> Vec<String> {
        self.blobs.lock().unwrap().clone()
    }

    fn ingest_calls(&self) -> usize {
        self.ingest_calls.load(Ordering::SeqCst)
    }

    fn blob_calls(&self) -> usize {
        self.blob_calls.load(Ordering::SeqCst)
    }

    fn blob_tokens(&self) -> Vec<String> {
        self.blob_tokens.lock().unwrap().clone()
    }
}

#[allow(clippy::too_many_arguments)]
fn handle(
    mut stream: TcpStream,
    replies: &[Reply],
    blob_replies: &[u16],
    blob_status: u16,
    received: &Arc<Mutex<Vec<AtlasArtifact>>>,
    blobs: &Arc<Mutex<Vec<String>>>,
    ingest_calls: &Arc<AtomicUsize>,
    blob_calls: &Arc<AtomicUsize>,
    blob_tokens: &Arc<Mutex<Vec<String>>>,
    seen_tokens: &mut Vec<String>,
) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }

    let mut headers = HashMap::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 || line.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    let length: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut body = vec![0u8; length];
    if length > 0 {
        let _ = reader.read_exact(&mut body);
    }

    let token = headers
        .get("authorization")
        .cloned()
        .unwrap_or_default();

    // Blob upload.
    if request_line.starts_with("PUT /blobs/") {
        let call = blob_calls.fetch_add(1, Ordering::SeqCst);
        let status = blob_replies.get(call).copied().unwrap_or(blob_status);
        blob_tokens.lock().unwrap().push(token);
        if (200..300).contains(&status) {
            if let Some(key) = request_line
                .split_whitespace()
                .nth(1)
                .and_then(|p| p.strip_prefix("/blobs/"))
            {
                blobs.lock().unwrap().push(key.to_string());
            }
        }
        respond(&mut stream, status, "{}");
        return;
    }

    // Slug availability.
    if request_line.starts_with("GET /workspaces/slug-available") {
        let available = !request_line.contains("slug=taken");
        respond(
            &mut stream,
            200,
            &format!("{{\"available\":{available}}}"),
        );
        return;
    }

    // Workspace registration.
    if request_line.starts_with("POST /workspaces ") {
        if String::from_utf8_lossy(&body).contains("\"slug\":\"taken\"") {
            respond(&mut stream, 409, "{}");
        } else {
            respond(&mut stream, 200, "{\"workspaceId\":\"ws-remote-1\"}");
        }
        return;
    }

    // Ingest.
    let call = ingest_calls.fetch_add(1, Ordering::SeqCst);
    let reply = replies.get(call).cloned().unwrap_or(Reply::Accept);

    let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap_or_default();
    let artifacts: Vec<AtlasArtifact> = parsed
        .get("artifacts")
        .and_then(|a| serde_json::from_value(a.clone()).ok())
        .unwrap_or_default();

    match reply {
        Reply::ExpireOnce => {
            let fresh = seen_tokens.iter().any(|t| t != &token);
            seen_tokens.push(token);
            if fresh {
                received.lock().unwrap().extend(artifacts);
                respond(&mut stream, 202, "{}");
            } else {
                respond(&mut stream, 401, "{}");
            }
        }
        Reply::Accept => {
            received.lock().unwrap().extend(artifacts);
            respond(&mut stream, 202, "{}");
        }
        Reply::Partial { reject } => {
            let results: Vec<serde_json::Value> = artifacts
                .iter()
                .map(|a| {
                    let id = a.row_id().to_string();
                    let accepted = !reject.iter().any(|r| id.contains(r.as_str()));
                    serde_json::json!({ "rowId": id, "accepted": accepted })
                })
                .collect();
            received
                .lock()
                .unwrap()
                .extend(artifacts.into_iter().filter(|a| {
                    !reject.iter().any(|r| a.row_id().contains(r.as_str()))
                }));
            respond(
                &mut stream,
                202,
                &serde_json::json!({ "results": results }).to_string(),
            );
        }
        Reply::Status(code) => respond(&mut stream, code, "{}"),
        Reply::RejectContaining(marker) => {
            if String::from_utf8_lossy(&body).contains(marker.as_str()) {
                respond(&mut stream, 400, "{}");
            } else {
                received.lock().unwrap().extend(artifacts);
                respond(&mut stream, 202, "{}");
            }
        }
        Reply::RetryAfter(secs) => {
            respond_with_header(&mut stream, 429, &format!("Retry-After: {secs}"), "{}");
        }
    }
}

fn respond(stream: &mut TcpStream, status: u16, body: &str) {
    let _ = write!(
        stream,
        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.flush();
}

fn respond_with_header(stream: &mut TcpStream, status: u16, header: &str, body: &str) {
    let _ = write!(
        stream,
        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\n{header}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.flush();
}

// ── Fixtures ────────────────────────────────────────────────────────────────

fn cloud_store(dir: &std::path::Path) -> Store {
    let store = Store::open(dir.join(".atlas")).expect("store opens");
    bind(&store, WORKSPACE, dir, WorkspaceMode::Cloud).expect("binds");
    store
}

fn record(store: &mut Store, native_id: &str, body: &str) -> String {
    let mut capture = Capture::new(store, WorkspaceMode::Cloud);
    let session = capture
        .record_prompt(
            &SessionKey {
                workspace_id: WORKSPACE.into(),
                source: Source::Acp,
                native_session_id: native_id.into(),
            },
            "Add rate limiting",
            1,
            Some("claude-code"),
            None,
            None,
        )
        .expect("prompt");
    capture
        .record_turn(
            &session,
            TurnContent {
                turn_seq: 1,
                native_message_id: Some(format!("{native_id}-m1")),
                role: Role::Assistant,
                mode: atlas_checkpoint::Mode::Text,
                body: body.to_string(),
                created_at: None,
            },
        )
        .expect("turn");
    session
}

fn config<'a>(base_url: &str, token: &'a dyn Fn() -> Option<String>) -> SyncConfig<'a> {
    SyncConfig {
        base_url: base_url.to_string(),
        org_id: ORG.to_string(),
        workspace_id: WORKSPACE.to_string(),
        wire_workspace_id: WIRE_WORKSPACE.to_string(),
        token,
        timeout: Duration::from_secs(5),
    }
}

fn always_token() -> impl Fn() -> Option<String> {
    || Some("token-1".to_string())
}

// ── The happy path ──────────────────────────────────────────────────────────

#[test]
fn pending_rows_are_uploaded_and_marked_sent() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = cloud_store(dir.path());
    record(&mut store, "s1", "I've added a token bucket.");

    let stub = Stub::start(vec![], 200);
    let token = always_token();
    let outcome = drain(&store, &config(&stub.base_url, &token)).expect("drains");

    assert_eq!(outcome.status, DrainStatus::Drained);
    assert!(outcome.sent >= 3, "session + prompt + response, got {}", outcome.sent);
    assert_eq!(outcome.still_pending, 0);
    assert!(!stub.artifacts().is_empty());
}

#[test]
fn no_author_field_is_ever_sent() {
    // Authorship is stamped server-side from the verified token. A payload that
    // could declare it is a payload that could forge it.
    let dir = tempfile::tempdir().unwrap();
    let mut store = cloud_store(dir.path());
    record(&mut store, "s1", "hello");

    let stub = Stub::start(vec![], 200);
    let token = always_token();
    drain(&store, &config(&stub.base_url, &token)).unwrap();

    for artifact in stub.artifacts() {
        let json = serde_json::to_string(&artifact).unwrap();
        assert!(!json.contains("authorId"), "{json}");
        assert!(!json.contains("author_id"), "{json}");
    }
}

#[test]
fn the_wire_workspace_id_is_never_the_local_row_key() {
    // The local row key is the project path — machine-specific, privacy-bearing,
    // and useless to the server for converging two teammates onto one timeline.
    // Every artifact must carry the registered wire identity instead.
    let dir = tempfile::tempdir().unwrap();
    let mut store = cloud_store(dir.path());
    record(&mut store, "s1", "hello");

    let stub = Stub::start(vec![], 200);
    let token = always_token();
    drain(&store, &config(&stub.base_url, &token)).unwrap();

    let artifacts = stub.artifacts();
    assert!(!artifacts.is_empty());
    for artifact in artifacts {
        let json = serde_json::to_string(&artifact).unwrap();
        assert!(json.contains(WIRE_WORKSPACE), "{json}");
        assert!(!json.contains(&format!("\"{WORKSPACE}\"")), "{json}");
    }
}

#[test]
fn replaying_the_same_batch_does_not_resend_rows() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = cloud_store(dir.path());
    record(&mut store, "s1", "hello");

    let stub = Stub::start(vec![], 200);
    let token = always_token();
    let cfg = config(&stub.base_url, &token);

    let first = drain(&store, &cfg).unwrap();
    let second = drain(&store, &cfg).unwrap();

    assert!(first.sent > 0);
    assert_eq!(second.sent, 0, "nothing is left pending to resend");
    assert_eq!(second.status, DrainStatus::Drained);
}

// ── Offline is the ordinary case ────────────────────────────────────────────

#[test]
fn with_the_server_unreachable_capture_succeeds_and_rows_stay_pending() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = cloud_store(dir.path());
    let session = record(&mut store, "s1", "recorded while offline");

    // A port nothing is listening on.
    let token = always_token();
    let outcome = drain(&store, &config("http://127.0.0.1:1", &token)).unwrap();

    assert_eq!(outcome.status, DrainStatus::Offline);
    assert_eq!(outcome.sent, 0);
    assert!(outcome.still_pending > 0);
    // The point: capture was completely unaffected.
    assert!(store.session(&session).unwrap().is_some());
    assert_eq!(store.messages_for_session(&session).unwrap().len(), 2);
}

#[test]
fn when_the_server_recovers_pending_rows_drain() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = cloud_store(dir.path());
    record(&mut store, "s1", "queued while offline");

    let token = always_token();
    assert_eq!(
        drain(&store, &config("http://127.0.0.1:1", &token)).unwrap().status,
        DrainStatus::Offline
    );

    let stub = Stub::start(vec![], 200);
    let outcome = drain(&store, &config(&stub.base_url, &token)).unwrap();
    assert_eq!(outcome.status, DrainStatus::Drained);
    assert!(outcome.sent > 0);
    assert_eq!(outcome.still_pending, 0);
}

#[test]
fn a_server_error_leaves_rows_pending_rather_than_failing_them() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = cloud_store(dir.path());
    record(&mut store, "s1", "hello");

    let stub = Stub::start(vec![Reply::Status(500)], 200);
    let token = always_token();
    let outcome = drain(&store, &config(&stub.base_url, &token)).unwrap();

    assert_eq!(outcome.status, DrainStatus::Offline, "5xx is the server's problem");
    assert_eq!(outcome.failed, 0);
    assert!(outcome.still_pending > 0);
}

// ── Auth ────────────────────────────────────────────────────────────────────

#[test]
fn a_token_expiring_mid_drain_refreshes_and_resumes() {
    // Access tokens are short-lived and a post-promotion backlog runs far longer
    // than one lifetime, so this is routine rather than exceptional.
    let dir = tempfile::tempdir().unwrap();
    let mut store = cloud_store(dir.path());
    record(&mut store, "s1", "hello");

    let stub = Stub::start(vec![Reply::ExpireOnce], 200);
    let calls = std::sync::atomic::AtomicUsize::new(0);
    let token = move || {
        let n = calls.fetch_add(1, Ordering::SeqCst);
        Some(format!("token-{n}"))
    };

    let outcome = drain(&store, &config(&stub.base_url, &token)).unwrap();
    assert_eq!(outcome.status, DrainStatus::Drained);
    assert!(outcome.sent > 0, "the drain resumed after refreshing");
}

#[test]
fn a_permanent_authorization_failure_stops_retrying_and_says_so() {
    // Removed from the Organisation, or the Workspace was deleted. Presenting
    // that as a transient failure would be an endless spinner.
    let dir = tempfile::tempdir().unwrap();
    let mut store = cloud_store(dir.path());
    let session = record(&mut store, "s1", "hello");

    let stub = Stub::start(vec![Reply::Status(403)], 200);
    let token = always_token();
    let outcome = drain(&store, &config(&stub.base_url, &token)).unwrap();

    assert_eq!(outcome.status, DrainStatus::NotAuthorized);
    assert_eq!(outcome.sent, 0);
    // Local capture continues untouched — only the drain stops.
    assert!(store.session(&session).unwrap().is_some());
}

#[test]
fn a_rate_limit_backs_off_rather_than_treating_rows_as_poison() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = cloud_store(dir.path());
    record(&mut store, "s1", "hello");

    let stub = Stub::start(vec![Reply::Status(429)], 200);
    let token = always_token();
    let outcome = drain(&store, &config(&stub.base_url, &token)).unwrap();

    assert_eq!(outcome.status, DrainStatus::RateLimited);
    assert_eq!(outcome.failed, 0, "429 is not a bad row");
    assert!(outcome.still_pending > 0);
}

#[test]
fn without_a_credential_the_drain_parks_rather_than_failing() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = cloud_store(dir.path());
    record(&mut store, "s1", "hello");

    let token = || None;
    let outcome = drain(&store, &config("http://127.0.0.1:1", &token)).unwrap();
    assert_eq!(outcome.status, DrainStatus::NoCredential);
    assert!(outcome.still_pending > 0);
}

// ── Per-row semantics ───────────────────────────────────────────────────────

#[test]
fn a_rejected_row_is_marked_failed_and_the_rest_still_drain() {
    // One malformed record must never stall everything behind it.
    let dir = tempfile::tempdir().unwrap();
    let mut store = cloud_store(dir.path());
    record(&mut store, "s1", "hello");

    // Reject the Session row; messages still go.
    let stub = Stub::start(vec![Reply::Partial { reject: vec!["as-".into()] }], 200);
    let token = always_token();
    let outcome = drain(&store, &config(&stub.base_url, &token)).unwrap();

    assert_eq!(outcome.failed, 1, "the rejected row is marked failed");
    assert!(outcome.sent > 0, "the rest kept draining");
    assert!(
        store.row_count_in_state(WORKSPACE, atlas_checkpoint::SyncState::Failed).unwrap() > 0
    );
}

// ── Blob-first ordering ─────────────────────────────────────────────────────

#[test]
fn a_spilled_payload_is_uploaded_before_the_row_that_references_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = cloud_store(dir.path());
    record(&mut store, "s1", &"log output\n".repeat(20_000));

    let stub = Stub::start(vec![], 200);
    let token = always_token();
    let outcome = drain(&store, &config(&stub.base_url, &token)).unwrap();

    assert_eq!(outcome.status, DrainStatus::Drained);
    assert!(outcome.blobs_uploaded > 0, "the payload was uploaded");
    assert!(!stub.blob_keys().is_empty());

    // Every referenced blob reached the server.
    for artifact in stub.artifacts() {
        for key in artifact.blob_refs() {
            assert!(
                stub.blob_keys().iter().any(|k| k == key),
                "row referenced a blob the server never received: {key}"
            );
        }
    }
}

#[test]
fn a_row_is_never_sent_when_its_blob_upload_failed() {
    // The failure this forbids: a row lands, its blob did not, and a *teammate*
    // opens the message to find nothing.
    let dir = tempfile::tempdir().unwrap();
    let mut store = cloud_store(dir.path());
    record(&mut store, "s1", &"log output\n".repeat(20_000));
    assert!(
        "log output\n".repeat(20_000).len() > SPILL_THRESHOLD_BYTES,
        "the fixture must actually spill"
    );

    // Blob uploads fail; ingest would happily accept.
    let stub = Stub::start(vec![], 500);
    let token = always_token();
    let outcome = drain(&store, &config(&stub.base_url, &token)).unwrap();

    assert_eq!(outcome.status, DrainStatus::Offline);
    for artifact in stub.artifacts() {
        assert!(
            artifact.blob_refs().is_empty(),
            "a row with a spilled payload was sent despite the blob failing"
        );
    }
    assert!(outcome.still_pending > 0, "it stays pending for the next pass");
}

// ── Batching ────────────────────────────────────────────────────────────────

#[test]
fn batches_respect_the_count_ceiling() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = cloud_store(dir.path());
    for i in 0..120 {
        record(&mut store, &format!("s{i}"), "a short answer");
    }

    let batch = store
        .pending_artifacts(WORKSPACE, WIRE_WORKSPACE, ORG, atlas_checkpoint::sync::MAX_BATCH_COUNT, usize::MAX)
        .unwrap();
    assert!(batch.len() <= atlas_checkpoint::sync::MAX_BATCH_COUNT);
}

#[test]
fn batches_respect_the_byte_ceiling_independently_of_the_count() {
    // A hundred artifacts can be enormous; the measured corpus has a single
    // 2.02 MB message.
    let dir = tempfile::tempdir().unwrap();
    let mut store = cloud_store(dir.path());
    for i in 0..20 {
        record(&mut store, &format!("s{i}"), &"x".repeat(40_000));
    }

    let batch = store.pending_artifacts(WORKSPACE, WIRE_WORKSPACE, ORG, 100, 64 * 1024).unwrap();
    let bytes: usize = batch.iter().map(atlas_checkpoint::artifacts::AtlasArtifact::approx_bytes).sum();
    assert!(batch.len() < 100, "the byte ceiling bit before the count did");
    assert!(bytes < 512 * 1024, "batch was {bytes} bytes");
}

// ── Batch-level rejection: the bisect ───────────────────────────────────────

#[test]
fn a_batch_level_rejection_bisects_to_the_poison_row_and_the_rest_drain() {
    // The server refuses whole batches without naming a row — today's contract.
    // The drain must converge on the offender within one call: halve, retry,
    // convict the single-row batch, and everything else still reaches the
    // Organisation.
    let dir = tempfile::tempdir().unwrap();
    let mut store = cloud_store(dir.path());
    record(&mut store, "s1", "a perfectly fine answer");
    record(&mut store, "s2", "poison marker that fails any batch carrying it");
    record(&mut store, "s3", "another fine answer");

    let stub = Stub::start(
        vec![Reply::RejectContaining("poison marker".into()); 64],
        200,
    );
    let token = always_token();
    let outcome = drain(&store, &config(&stub.base_url, &token)).expect("drain converges");

    assert_eq!(outcome.failed, 1, "exactly the poison row was convicted");
    assert_eq!(outcome.sent, 8, "3 sessions + 6 messages, minus the poison");
    assert_eq!(outcome.still_pending, 0, "nothing left stalled behind the poison");
    assert_eq!(
        store.row_count_in_state(WORKSPACE, atlas_checkpoint::SyncState::Failed).unwrap(),
        1
    );
    assert!(
        stub.ingest_calls() <= 12,
        "convergence is bounded, took {} passes",
        stub.ingest_calls()
    );
}

#[test]
fn convicted_rows_can_be_re_pended_and_then_drain() {
    // The failed → pending transition of the outbox state machine: a deliberate
    // retry gives every convicted row another chance.
    let dir = tempfile::tempdir().unwrap();
    let mut store = cloud_store(dir.path());
    record(&mut store, "s1", "rejected wholesale the first time");

    let rejecting = Stub::start(vec![Reply::Status(400); 16], 200);
    let token = always_token();
    let first = drain(&store, &config(&rejecting.base_url, &token)).unwrap();

    assert_eq!(first.failed, 3, "every row was convicted one by one");
    assert_eq!(first.still_pending, 0);
    assert_eq!(first.status, DrainStatus::Drained, "nothing pending remains");
    assert!(
        rejecting.ingest_calls() <= 8,
        "conviction is bounded, took {} passes",
        rejecting.ingest_calls()
    );

    assert_eq!(store.retry_failed_rows(WORKSPACE).unwrap(), 3);

    let accepting = Stub::start(vec![], 200);
    let second = drain(&store, &config(&accepting.base_url, &token)).unwrap();
    assert_eq!(second.status, DrainStatus::Drained);
    assert_eq!(second.sent, 3, "the re-pended rows drained");
    assert_eq!(
        store.row_count_in_state(WORKSPACE, atlas_checkpoint::SyncState::Failed).unwrap(),
        0
    );
}

// ── Auth on the blob path ───────────────────────────────────────────────────

#[test]
fn a_blob_upload_401_refreshes_the_token_and_the_drain_completes() {
    // The multi-hour first drain expires tokens during the blob phase too, not
    // only between pushes.
    let dir = tempfile::tempdir().unwrap();
    let mut store = cloud_store(dir.path());
    record(&mut store, "s1", &"log output\n".repeat(20_000));

    let stub = Stub::start_full(vec![], vec![401], 200);
    let calls = std::sync::atomic::AtomicUsize::new(0);
    let token = move || {
        let n = calls.fetch_add(1, Ordering::SeqCst);
        Some(format!("token-{n}"))
    };

    let outcome = drain(&store, &config(&stub.base_url, &token)).unwrap();
    assert_eq!(outcome.status, DrainStatus::Drained);
    assert!(outcome.sent > 0, "the drain resumed after refreshing");
    assert!(outcome.blobs_uploaded > 0, "the blob went up on the retry");

    let tokens = stub.blob_tokens();
    assert!(tokens.len() >= 2, "the blob upload was retried");
    assert_ne!(tokens[0], tokens[1], "the retry carried a fresh token");
}

#[test]
fn a_blob_upload_403_surfaces_not_authorized_and_rows_stay_pending() {
    // Membership revoked mid-drain during the blob phase must be as terminal —
    // and as visible — as on the push path, never silently deferred and
    // reported as drained.
    let dir = tempfile::tempdir().unwrap();
    let mut store = cloud_store(dir.path());
    record(&mut store, "s1", &"log output\n".repeat(20_000));

    let stub = Stub::start(vec![], 403);
    let token = always_token();
    let outcome = drain(&store, &config(&stub.base_url, &token)).unwrap();

    assert_eq!(outcome.status, DrainStatus::NotAuthorized);
    assert_eq!(outcome.sent, 0, "nothing was sent");
    assert_eq!(outcome.failed, 0, "a 403 is not the rows' fault");
    assert!(outcome.still_pending > 0, "rows stay pending, honestly reported");
    assert!(stub.artifacts().is_empty());
    assert_eq!(stub.blob_calls(), 1, "the drain stopped instead of retrying");
}

// ── Permanently unsendable rows ─────────────────────────────────────────────

#[test]
fn a_missing_local_blob_fails_its_row_and_everything_else_drains() {
    // A deleted `.atlas/blobs` shard, or a database restored without its
    // blobs: the bytes are gone, so the row is failed now rather than left as
    // an eternal "1 pending" that never clears.
    let dir = tempfile::tempdir().unwrap();
    let mut store = cloud_store(dir.path());
    record(&mut store, "s1", &"log output\n".repeat(20_000));
    record(&mut store, "s2", "a small answer that still drains");
    std::fs::remove_dir_all(dir.path().join(".atlas").join("blobs")).expect("blobs deleted");

    let stub = Stub::start(vec![], 200);
    let token = always_token();
    let outcome = drain(&store, &config(&stub.base_url, &token)).unwrap();

    assert_eq!(outcome.failed, 1, "the blob-less row failed");
    assert!(outcome.sent > 0, "everything else drained");
    assert_eq!(outcome.still_pending, 0);
    assert_eq!(outcome.status, DrainStatus::Drained, "an honest Drained: nothing pending remains");
    assert_eq!(
        store.row_count_in_state(WORKSPACE, atlas_checkpoint::SyncState::Failed).unwrap(),
        1
    );
    for artifact in stub.artifacts() {
        assert!(
            artifact.blob_refs().is_empty(),
            "the row with the missing blob was never sent"
        );
    }
}

// ── The 401 hot-loop guard ──────────────────────────────────────────────────

#[test]
fn a_persistent_401_refreshes_exactly_once_then_stops() {
    // Every mint yields a byte-different JWT, so an unguarded "refresh and
    // retry on 401" spins forever against a server that keeps rejecting the
    // credential (clock skew, key rotation, audience mismatch).
    let dir = tempfile::tempdir().unwrap();
    let mut store = cloud_store(dir.path());
    record(&mut store, "s1", "hello");

    let stub = Stub::start(vec![Reply::Status(401); 8], 200);
    let calls = std::sync::atomic::AtomicUsize::new(0);
    let token = move || {
        let n = calls.fetch_add(1, Ordering::SeqCst);
        Some(format!("token-{n}"))
    };

    let outcome = drain(&store, &config(&stub.base_url, &token)).unwrap();
    assert_eq!(outcome.status, DrainStatus::NoCredential);
    assert_eq!(
        stub.ingest_calls(),
        2,
        "one original attempt plus exactly one refreshed retry"
    );
    assert!(outcome.still_pending > 0, "rows stay pending for a later, fixed credential");
}

// ── Batch construction edge ─────────────────────────────────────────────────

#[test]
fn a_single_artifact_over_the_byte_ceiling_still_ships_alone() {
    // The ceiling is checked before appending, except when the batch is empty:
    // one oversized artifact ships by itself rather than deadlocking the queue.
    let dir = tempfile::tempdir().unwrap();
    let mut store = cloud_store(dir.path());
    record(&mut store, "s1", &"x".repeat(10_000));

    let mut passes = 0;
    loop {
        let batch = store.pending_artifacts(WORKSPACE, WIRE_WORKSPACE, ORG, 100, 1).unwrap();
        if batch.is_empty() {
            break;
        }
        assert_eq!(batch.len(), 1, "every artifact dwarfs the ceiling, so each ships alone");
        store.mark_sent(batch[0].row_id()).unwrap();
        passes += 1;
        assert!(passes <= 10, "the queue drains rather than deadlocking");
    }
    assert_eq!(passes, 3, "session + prompt + response each shipped alone");
}

// ── Backoff hints ───────────────────────────────────────────────────────────

#[test]
fn a_429_carries_the_servers_retry_after_hint_into_the_outcome() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = cloud_store(dir.path());
    record(&mut store, "s1", "hello");

    let stub = Stub::start(vec![Reply::RetryAfter(7)], 200);
    let token = always_token();
    let outcome = drain(&store, &config(&stub.base_url, &token)).unwrap();

    assert_eq!(outcome.status, DrainStatus::RateLimited);
    assert_eq!(outcome.retry_after, Some(Duration::from_secs(7)));
    assert_eq!(outcome.failed, 0, "a rate limit is not a poison row");
    assert!(outcome.still_pending > 0);
}

// ── Local mode never drains ─────────────────────────────────────────────────

#[test]
fn a_local_workspace_accumulates_rows_that_never_drain() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join(".atlas")).unwrap();
    bind(&store, WORKSPACE, dir.path(), WorkspaceMode::Local).unwrap();

    let mut store = store;
    {
        let mut capture = Capture::new(&mut store, WorkspaceMode::Local);
        capture
            .record_prompt(
                &SessionKey {
                    workspace_id: WORKSPACE.into(),
                    source: Source::Acp,
                    native_session_id: "s1".into(),
                },
                "local only",
                1,
                None,
                None,
                None,
            )
            .unwrap();
    }

    // Nothing is pending, so a drain has nothing to do — Local mode is the same
    // database with draining switched off, not a separate path.
    let stub = Stub::start(vec![], 200);
    let token = always_token();
    let outcome = drain(&store, &config(&stub.base_url, &token)).unwrap();

    assert_eq!(outcome.sent, 0);
    assert_eq!(outcome.still_pending, 0);
    assert!(stub.artifacts().is_empty(), "nothing left the machine");
}
