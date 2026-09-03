//! Tests for the auth core.
//!
//! These drive [`AuthCore`] against a **stub HTTP server bound to loopback**,
//! with a temporary directory standing in for the app config dir. That works
//! because the auth base is injected rather than hardcoded, so the seam already
//! exists by design — no mock traits, no dependency-injection scaffolding, and
//! the real `reqwest` client, the real poll loop and the real file I/O are all
//! exercised.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::backoff::{Backoff, BASE, CEILING};
use super::core::AuthFailure;
use super::*;

// ---------------------------------------------------------------- temp dir

/// A unique directory removed on drop. Avoids a `tempfile` dev-dependency for
/// what is fifteen lines.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        static N: AtomicU32 = AtomicU32::new(0);
        let unique = format!(
            "atlas-auth-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        );
        let path = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&path).expect("create temp dir");
        Self(path)
    }
    fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// ------------------------------------------------------------- stub server

/// One canned HTTP response.
#[derive(Clone)]
struct Reply {
    status: u16,
    body: String,
    content_type: &'static str,
    /// `None` omits the header entirely, so the client must read to EOF without
    /// knowing how much is coming. That is the only way to reach the avatar
    /// fetch's *streaming* size cap: with an honest length the cheap up-front
    /// check fires first, and an understated one just makes `reqwest` truncate.
    content_length: Option<usize>,
    /// Extra raw header lines, without the trailing CRLF. Currently only
    /// `Retry-After`, which the classification has to read off a 429.
    headers: Vec<String>,
    /// Held before answering, so a test can act while a call is in flight.
    delay: Option<Duration>,
}

impl Reply {
    fn new(status: u16, body: &str, content_type: &'static str) -> Self {
        Self {
            status,
            body: body.into(),
            content_type,
            content_length: Some(body.len()),
            headers: Vec::new(),
            delay: None,
        }
    }
    fn ok(body: &str) -> Self {
        Self::new(200, body, "application/json")
    }
    fn err(status: u16, body: &str) -> Self {
        Self::new(status, body, "application/json")
    }
    /// A 200 with an explicit content type — used for image bodies, and for
    /// proving what happens when the "photo" turns out not to be one. The bytes
    /// are never a real image: nothing in the Rust layer decodes them.
    fn with_content_type(content_type: &'static str, body: &str) -> Self {
        Self::new(200, body, content_type)
    }
    fn without_content_length(mut self) -> Self {
        self.content_length = None;
        self
    }
    /// One extra header line, e.g. `"Retry-After: 42"`.
    fn with_header(mut self, line: &str) -> Self {
        self.headers.push(line.to_string());
        self
    }
    /// Answer only after `ms`, which is what makes a call *observably* in
    /// flight — the only way to test what a user action racing one does.
    fn slow(mut self, ms: u64) -> Self {
        self.delay = Some(Duration::from_millis(ms));
        self
    }
}

/// What the stub was *sent*, so a test can assert on the request and not only
/// on the reply. Carries only what something asserts on: sign-out is defined by
/// the call it makes, not by the answer it chooses to ignore.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Seen {
    method: String,
    /// The credential from `Authorization: Bearer …`, when one was sent.
    bearer: Option<String>,
}

impl Seen {
    /// Parse the request line and headers out of a raw request.
    fn parse(req: &str) -> Self {
        let method = req
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().next())
            .unwrap_or("")
            .to_string();
        let bearer = req
            .lines()
            .find(|l| l.to_ascii_lowercase().starts_with("authorization:"))
            .and_then(|l| l.split_once(':'))
            .map(|(_, v)| v.trim())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(str::to_string);
        Self { method, bearer }
    }
}

/// Scriptable auth server. Each path holds a queue of replies; the last one
/// repeats once the queue is drained, so a test only scripts what it cares
/// about.
#[derive(Default)]
struct Script {
    replies: HashMap<String, Vec<Reply>>,
    hits: HashMap<String, u32>,
    seen: HashMap<String, Vec<Seen>>,
}

struct Stub {
    addr: SocketAddr,
    script: Arc<Mutex<Script>>,
}

impl Stub {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let script = Arc::new(Mutex::new(Script::default()));
        let handle = Arc::clone(&script);

        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                let handle = Arc::clone(&handle);
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    let Ok(n) = sock.read(&mut buf).await else { return };
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let path = req
                        .lines()
                        .next()
                        .and_then(|l| l.split_whitespace().nth(1))
                        .unwrap_or("/")
                        .to_string();

                    let reply = {
                        let mut s = handle.lock().unwrap();
                        *s.hits.entry(path.clone()).or_insert(0) += 1;
                        s.seen.entry(path.clone()).or_default().push(Seen::parse(&req));
                        let queue = s.replies.get_mut(&path);
                        match queue {
                            Some(q) if q.len() > 1 => q.remove(0),
                            Some(q) if q.len() == 1 => q[0].clone(),
                            _ => Reply::err(404, "{}"),
                        }
                    };

                    if let Some(delay) = reply.delay {
                        tokio::time::sleep(delay).await;
                    }

                    let length = match reply.content_length {
                        Some(n) => format!("Content-Length: {n}\r\n"),
                        None => String::new(),
                    };
                    let extra = reply
                        .headers
                        .iter()
                        .map(|h| format!("{h}\r\n"))
                        .collect::<String>();
                    let out = format!(
                        "HTTP/1.1 {} X\r\nContent-Type: {}\r\n{}{}Connection: close\r\n\r\n{}",
                        reply.status, reply.content_type, length, extra, reply.body
                    );
                    let _ = sock.write_all(out.as_bytes()).await;
                    let _ = sock.shutdown().await;
                });
            }
        });

        Self { addr, script }
    }

    fn base(&self) -> String {
        format!("http://{}", self.addr)
    }

    fn on(&self, path: &str, replies: Vec<Reply>) {
        self.script.lock().unwrap().replies.insert(path.into(), replies);
    }

    fn hits(&self, path: &str) -> u32 {
        self.script.lock().unwrap().hits.get(path).copied().unwrap_or(0)
    }

    /// Every request the stub received for a path, in order.
    fn seen(&self, path: &str) -> Vec<Seen> {
        self.script.lock().unwrap().seen.get(path).cloned().unwrap_or_default()
    }

    /// A grant that is immediately pollable, with no artificial delay.
    fn grant_ready(&self, expires_in: u64) {
        self.on(
            "/device/code",
            vec![Reply::ok(&format!(
                r#"{{"device_code":"dev-secret","user_code":"ABCD-1234",
                     "verification_uri":"https://app.example/device",
                     "verification_uri_complete":"https://app.example/device?user_code=ABCD-1234",
                     "expires_in":{expires_in},"interval":0}}"#
            ))],
        );
    }

    /// A `/get-session` profile. `image` is the *absolute* URL the desktop will
    /// fetch, so tests point it back at this same stub.
    fn profile(&self, name: &str, image: Option<&str>) {
        self.profile_active_org(name, image, None);
    }

    /// The same, with the session naming an active organisation — what the
    /// server returns once the *web* has called `/organization/set-active`.
    /// `None` is the normal state for a device-granted session.
    fn profile_active_org(&self, name: &str, image: Option<&str>, active: Option<&str>) {
        let image = match image {
            Some(url) => format!(r#""{url}""#),
            None => "null".to_string(),
        };
        let active = match active {
            Some(id) => format!(r#""{id}""#),
            None => "null".to_string(),
        };
        self.on(
            "/get-session",
            vec![Reply::ok(&format!(
                r#"{{"session":{{"id":"sess_1","activeOrganizationId":{active}}},
                     "user":{{"id":"user_1","name":"{name}",
                              "email":"ada@atlas.example","image":{image}}}}}"#
            ))],
        );
    }

    /// `GET /organization/list` — `(id, name)` pairs, carrying the extra fields
    /// the real endpoint returns so the desktop is proven to ignore them.
    fn org_list(&self, orgs: &[(&str, &str)]) {
        let body = orgs
            .iter()
            .map(|(id, name)| {
                format!(r#"{{"id":"{id}","name":"{name}","slug":"{id}","logo":null}}"#)
            })
            .collect::<Vec<_>>()
            .join(",");
        self.on("/organization/list", vec![Reply::ok(&format!("[{body}]"))]);
    }

    /// Absolute URL for a stub path, for use as a profile `image`.
    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base(), path)
    }
}

fn core(stub: &Stub, dir: &TempDir) -> AuthCore {
    AuthCore::new(stub.base(), dir.path(), reqwest::Client::new())
}

/// Signed in, whoever it turns out to be — for the tests that are about the
/// grant rather than the user.
fn signed_in(snapshot: &AuthSnapshot) -> bool {
    matches!(snapshot, AuthSnapshot::SignedIn { .. })
}

/// The identity on a signed-in snapshot, or a panic naming what we got instead.
fn user_of(snapshot: &AuthSnapshot) -> AccountUser {
    match snapshot {
        AuthSnapshot::SignedIn {
            user: Some(user), ..
        } => user.clone(),
        other => panic!("expected a signed-in snapshot with an identity, got {other:?}"),
    }
}

/// The organisation list on a signed-in snapshot (ATL-51).
///
/// Deliberately hands back the `Option` rather than defaulting it: `None`
/// ("not known yet") and `Some([])` ("belongs to none") render differently, and
/// a helper that flattened them would let a test pass while the menu lied.
fn orgs_of(snapshot: &AuthSnapshot) -> Option<Vec<AccountOrg>> {
    match snapshot {
        AuthSnapshot::SignedIn { orgs, .. } => orgs.clone(),
        other => panic!("expected a signed-in snapshot, got {other:?}"),
    }
}

/// The organisation the desktop resolved as active, and nothing else about it.
fn active_org_of(snapshot: &AuthSnapshot) -> Option<String> {
    match snapshot {
        AuthSnapshot::SignedIn { active_org_id, .. } => active_org_id.clone(),
        other => panic!("expected a signed-in snapshot, got {other:?}"),
    }
}

/// Drive a grant to completion against an already-scripted stub.
async fn sign_in(auth: &AuthCore) {
    let grant = auth.start_grant().await.expect("start grant");
    auth.run_grant(&grant).await.expect("complete grant");
}

const TOKEN_OK: &str = r#"{"access_token":"session-tok","token_type":"Bearer"}"#;
/// A successful `/token` mint — the call [`AuthCore::validate_once`] takes its
/// verdict from, so any test that validates has to script it.
///
/// Deliberately **not** a well-formed JWT. Every test that does not care about
/// roles uses it, so each of them also proves that an unparseable token costs
/// the roles and nothing else.
const JWT_OK: &str = r#"{"token":"jwt-here"}"#;

/// A `/token` reply whose JWT carries an `orgs` claim — `(organisationId, role)`
/// pairs, exactly the `{ orgId: role }` shape of the real claim (API doc §5.1).
///
/// Three dot-separated segments, base64url without padding. The signature is
/// gibberish on purpose: nothing verifies it, and a test that supplied a real
/// one would imply otherwise.
fn jwt_reply(orgs: &[(&str, &str)]) -> Reply {
    use base64::Engine;
    let claims = orgs
        .iter()
        .map(|(id, role)| format!(r#""{id}":"{role}""#))
        .collect::<Vec<_>>()
        .join(",");
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(format!(r#"{{"sub":"user_1","orgs":{{{claims}}}}}"#));
    Reply::ok(&format!(r#"{{"token":"header.{payload}.signature"}}"#))
}
/// Stands in for image bytes. Content is irrelevant — nothing decodes it.
const PIXELS: &str = "not-really-a-png-but-nothing-here-decodes-it";

// ------------------------------------------------------------------ config

#[test]
fn auth_base_prefers_the_environment_and_trims_slashes() {
    // Serialised implicitly: this is the only test touching the process env.
    std::env::set_var("ATLAS_AUTH_URL", "http://localhost:8787/api/auth/");
    assert_eq!(auth_base(), "http://localhost:8787/api/auth");

    std::env::set_var("ATLAS_AUTH_URL", "   ");
    assert!(
        auth_base().starts_with("https://"),
        "a blank override must fall through to the built-in default"
    );

    std::env::remove_var("ATLAS_AUTH_URL");
    assert_eq!(auth_base(), "https://auth.tryatlas.cc/api/auth");
}

// ----------------------------------------------------------------- storage

#[tokio::test]
async fn a_granted_token_is_persisted_and_survives_a_restart() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    stub.grant_ready(600);
    stub.on("/device/token", vec![Reply::ok(TOKEN_OK)]);

    let auth = core(&stub, &dir);
    let grant = auth.start_grant().await.expect("start");
    auth.run_grant(&grant).await.expect("grant");

    assert!(signed_in(&auth.snapshot()));

    // A fresh core over the same directory is what a relaunch looks like.
    let relaunched = AuthCore::new(stub.base(), dir.path(), reqwest::Client::new());
    assert!(signed_in(&relaunched.snapshot()));
    assert_eq!(relaunched.stored().unwrap().session_token, "session-tok");
}

#[cfg(unix)]
#[tokio::test]
async fn the_credential_file_is_owner_only() {
    use std::os::unix::fs::PermissionsExt;

    let stub = Stub::start().await;
    let dir = TempDir::new();
    stub.grant_ready(600);
    stub.on("/device/token", vec![Reply::ok(TOKEN_OK)]);

    let auth = core(&stub, &dir);
    let grant = auth.start_grant().await.unwrap();
    auth.run_grant(&grant).await.unwrap();

    let mode = std::fs::metadata(dir.path().join("atlas-session.json"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600, "credential must not be group/world readable");
}

#[tokio::test]
async fn clearing_is_idempotent_and_returns_to_signed_out() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    let auth = core(&stub, &dir);

    assert!(auth.clear_session().is_ok(), "clearing when absent must succeed");
    stub.grant_ready(600);
    stub.on("/device/token", vec![Reply::ok(TOKEN_OK)]);
    let grant = auth.start_grant().await.unwrap();
    auth.run_grant(&grant).await.unwrap();

    auth.clear_session().unwrap();
    assert_eq!(auth.snapshot(), AuthSnapshot::SignedOut);
    assert!(auth.clear_session().is_ok());
}

// ------------------------------------------------------------- grant matrix

#[tokio::test]
async fn pending_polls_continue_until_approval() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    stub.grant_ready(600);
    stub.on(
        "/device/token",
        vec![
            Reply::err(400, r#"{"error":"authorization_pending"}"#),
            Reply::err(400, r#"{"error":"authorization_pending"}"#),
            Reply::ok(TOKEN_OK),
        ],
    );

    let auth = core(&stub, &dir);
    let grant = auth.start_grant().await.unwrap();
    auth.run_grant(&grant).await.expect("should end signed in");

    assert!(signed_in(&auth.snapshot()));
    assert_eq!(stub.hits("/device/token"), 3);
}

#[tokio::test]
async fn a_transient_failure_does_not_discard_an_approval() {
    // The point of the whole classification: a 500 and a dropped connection
    // tell us nothing about whether the human approved, so the grant must
    // survive them. Ending here would throw away an approval already given.
    let stub = Stub::start().await;
    let dir = TempDir::new();
    stub.grant_ready(600);
    stub.on(
        "/device/token",
        vec![
            Reply::err(500, "boom"),
            Reply::err(502, "still boom"),
            Reply::ok(TOKEN_OK),
        ],
    );

    let auth = core(&stub, &dir);
    let grant = auth.start_grant().await.unwrap();
    auth.run_grant(&grant).await.expect("transient errors must not end the grant");
    assert!(signed_in(&auth.snapshot()));
}

#[tokio::test]
async fn slow_down_backs_off_and_keeps_going() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    stub.grant_ready(600);
    stub.on(
        "/device/token",
        vec![Reply::err(400, r#"{"error":"slow_down"}"#), Reply::ok(TOKEN_OK)],
    );

    let auth = core(&stub, &dir);
    let grant = auth.start_grant().await.unwrap();
    let started = std::time::Instant::now();
    auth.run_grant(&grant).await.expect("slow_down is not terminal");

    assert!(
        started.elapsed() >= Duration::from_secs(5),
        "slow_down must add 5s to the interval before the next poll"
    );
    assert!(signed_in(&auth.snapshot()));
}

#[tokio::test]
async fn denial_is_terminal_and_stores_nothing() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    stub.grant_ready(600);
    stub.on("/device/token", vec![Reply::err(400, r#"{"error":"access_denied"}"#)]);

    let auth = core(&stub, &dir);
    let grant = auth.start_grant().await.unwrap();
    assert_eq!(auth.run_grant(&grant).await, Err(GrantError::Denied));
    assert_eq!(auth.snapshot(), AuthSnapshot::SignedOut);
}

#[tokio::test]
async fn a_server_expired_code_is_terminal() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    stub.grant_ready(600);
    stub.on("/device/token", vec![Reply::err(400, r#"{"error":"expired_token"}"#)]);

    let auth = core(&stub, &dir);
    let grant = auth.start_grant().await.unwrap();
    assert_eq!(auth.run_grant(&grant).await, Err(GrantError::Expired));
    assert_eq!(auth.snapshot(), AuthSnapshot::SignedOut);
}

#[tokio::test]
async fn the_local_deadline_ends_a_grant_the_server_never_finishes() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    stub.grant_ready(1); // expires almost immediately
    stub.on("/device/token", vec![Reply::err(400, r#"{"error":"authorization_pending"}"#)]);

    let auth = core(&stub, &dir);
    let grant = auth.start_grant().await.unwrap();
    assert_eq!(auth.run_grant(&grant).await, Err(GrantError::Expired));
    assert_eq!(auth.snapshot(), AuthSnapshot::SignedOut);
}

#[tokio::test]
async fn cancelling_ends_the_grant_and_stops_polling() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    stub.grant_ready(600);
    stub.on("/device/token", vec![Reply::err(400, r#"{"error":"authorization_pending"}"#)]);

    let auth = Arc::new(core(&stub, &dir));
    let grant = auth.start_grant().await.unwrap();

    let runner = {
        let auth = Arc::clone(&auth);
        let grant = grant.clone();
        tokio::spawn(async move { auth.run_grant(&grant).await })
    };

    tokio::time::sleep(Duration::from_millis(120)).await;
    auth.cancel_grant();

    assert_eq!(runner.await.unwrap(), Err(GrantError::Cancelled));
    assert_eq!(auth.snapshot(), AuthSnapshot::SignedOut);

    // Nothing keeps polling after cancellation.
    let after = stub.hits("/device/token");
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(stub.hits("/device/token"), after, "poll loop must be stopped");
}

#[tokio::test]
async fn a_second_start_resumes_the_same_grant_instead_of_minting_another() {
    // The recovery path: someone who got lost signing in on the web clicks the
    // account button again and must land back on the SAME approval page.
    let stub = Stub::start().await;
    let dir = TempDir::new();
    stub.grant_ready(600);
    stub.on("/device/token", vec![Reply::err(400, r#"{"error":"authorization_pending"}"#)]);

    let auth = core(&stub, &dir);
    let first = auth.start_grant().await.unwrap();
    let second = auth.start_grant().await.unwrap();

    assert_eq!(first.user_code, second.user_code);
    assert_eq!(first.device_code, second.device_code);
    assert_eq!(stub.hits("/device/code"), 1, "must not mint a competing code");
}

#[tokio::test]
async fn the_browser_is_sent_to_the_plain_url_never_the_pre_filled_one() {
    // The remote-phishing guard, pinned. A link carrying the code puts an
    // already-signed-in user one click from approving someone else's grant;
    // sending them to an empty box means the approved code is necessarily the
    // one this window is showing. "Just pre-fill it" reads as a harmless UX
    // win, so the property gets a test rather than only a comment.
    let stub = Stub::start().await;
    let dir = TempDir::new();
    stub.grant_ready(600);

    let auth = core(&stub, &dir);
    let grant = auth.start_grant().await.expect("start grant");

    assert_eq!(grant.approval_url(), "https://app.example/device");
    assert!(
        !grant.approval_url().contains("user_code"),
        "the code must not travel in the URL — that link is the attack"
    );
    assert!(
        grant.verification_uri_complete.contains("user_code"),
        "the pre-filled URL is still parsed off the wire; it is simply not opened, \
         so this asserts the two are genuinely different values"
    );
}

#[tokio::test]
async fn the_connecting_snapshot_exposes_the_code_but_never_the_secret() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    stub.grant_ready(600);

    let auth = core(&stub, &dir);
    let grant = auth.start_grant().await.unwrap();

    match auth.snapshot() {
        AuthSnapshot::Connecting { user_code, verification_uri, .. } => {
            assert_eq!(user_code, "ABCD-1234");
            // The PLAIN url, for manual entry. The pre-filled variant is used
            // to open the browser from Rust and never needs to cross over.
            assert_eq!(verification_uri, "https://app.example/device");
            let json = serde_json::to_string(&auth.snapshot()).unwrap();
            assert!(
                !json.contains(&grant.device_code),
                "the device_code is the secret and must never cross to the frontend"
            );
        }
        other => panic!("expected Connecting, got {other:?}"),
    }
}

#[tokio::test]
async fn an_unreachable_server_fails_to_start_without_leaking_the_url() {
    let dir = TempDir::new();
    // Port 1 on loopback: nothing listens, so the connection is refused.
    let auth = AuthCore::new("http://127.0.0.1:1", dir.path(), reqwest::Client::new());

    match auth.start_grant().await {
        Err(GrantError::Start(msg)) => {
            assert!(!msg.contains("127.0.0.1:1"), "error text must not carry the URL");
        }
        other => panic!("expected a start failure, got {other:?}"),
    }
    assert_eq!(auth.snapshot(), AuthSnapshot::SignedOut);
}

// -------------------------------------------------------------------- boot

#[tokio::test]
async fn boot_with_no_credential_makes_no_network_call() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    let auth = core(&stub, &dir);

    assert_eq!(auth.validate_once().await, Validation::NoCredential);
    assert_eq!(auth.snapshot(), AuthSnapshot::SignedOut);
    assert_eq!(stub.hits("/token"), 0, "a signed-out launch must be silent");
}

#[tokio::test]
async fn minting_reports_rejection_and_unreachability_differently() {
    // The distinction the whole ticket is built on: `Rejected` is "the server
    // said no", `Indeterminate` is "we never found out". Conflating them is
    // what signs people out for opening a laptop on a plane.
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant(&stub);

    let auth = core(&stub, &dir);
    sign_in(&auth).await;

    stub.on("/token", vec![Reply::err(401, "unauthorized")]);
    assert_eq!(auth.mint_access_token().await, Err(AuthFailure::Rejected));

    stub.on("/token", vec![Reply::ok(JWT_OK)]);
    assert_eq!(auth.mint_access_token().await, Ok("jwt-here".into()));

    let offline = AuthCore::new("http://127.0.0.1:1", dir.path(), reqwest::Client::new());
    assert!(
        matches!(
            offline.mint_access_token().await,
            Err(AuthFailure::Indeterminate { .. })
        ),
        "unreachable is not a rejection"
    );
}

// ------------------------------------------------- failure classification
//
// The highest-value group in the module (ATL-48). Every case below is one row
// of the rule: only an authoritative rejection may ever cost the credential.

/// Sign in, then hand back a core pointed at a server that will never answer.
/// This is what launching on a plane looks like.
async fn signed_in_then_offline(stub: &Stub, dir: &TempDir) -> AuthCore {
    let auth = core(stub, dir);
    sign_in(&auth).await;
    AuthCore::new("http://127.0.0.1:1", dir.path(), reqwest::Client::new())
}

#[tokio::test]
async fn a_rejected_session_is_cleared_and_signs_the_user_out() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant(&stub);

    let auth = core(&stub, &dir);
    sign_in(&auth).await;

    stub.on("/token", vec![Reply::err(401, "unauthorized")]);
    assert_eq!(auth.validate_once().await, Validation::Rejected);
    assert_eq!(auth.snapshot(), AuthSnapshot::SignedOut);
    assert!(
        auth.stored().is_none(),
        "a 401 is the server refusing this credential — keeping it would leave \
         a signed-in UI that silently fails every call"
    );
}

#[tokio::test]
async fn a_server_error_never_costs_the_credential() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant(&stub);
    stub.profile("Ada Lovelace", None);

    let auth = core(&stub, &dir);
    sign_in(&auth).await;

    stub.on("/token", vec![Reply::err(500, "boom")]);
    assert_eq!(
        auth.validate_once().await,
        Validation::Indeterminate { retry_after: None }
    );
    assert!(auth.stored().is_some(), "an outage says nothing about the session");
    assert_eq!(user_of(&auth.snapshot()).name, "Ada Lovelace");
}

#[tokio::test]
async fn a_refused_connection_never_costs_the_credential() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant(&stub);

    let offline = signed_in_then_offline(&stub, &dir).await;
    assert_eq!(
        offline.validate_once().await,
        Validation::Indeterminate { retry_after: None }
    );
    assert!(offline.stored().is_some());
}

#[tokio::test]
async fn an_offline_launch_renders_a_fully_populated_signed_in_state() {
    // The case that would otherwise ship as a session-destroying bug: no
    // network at all, and the title bar still shows a name and a face.
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant(&stub);
    stub.profile("Ada Lovelace", Some(&stub.url("/photo.png")));
    stub.on("/photo.png", vec![Reply::with_content_type("image/png", PIXELS)]);

    let auth = core(&stub, &dir);
    sign_in(&auth).await;
    let known = user_of(&auth.snapshot());

    let offline = AuthCore::new("http://127.0.0.1:1", dir.path(), reqwest::Client::new());
    // Before any network attempt — the launch path renders this first.
    assert_eq!(user_of(&offline.snapshot()), known);

    offline.validate_once().await;
    let after = user_of(&offline.snapshot());
    assert_eq!(after, known, "a failed validation must change nothing");
    assert!(after.avatar_path.is_some(), "the cached photo is the whole point");
    assert!(!after.name.is_empty());
}

#[tokio::test]
async fn a_forbidden_response_neither_signs_out_nor_retries() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant(&stub);

    let auth = core(&stub, &dir).with_backoff_base(Duration::from_millis(1));
    sign_in(&auth).await;

    stub.on("/token", vec![Reply::err(403, "forbidden")]);
    assert_eq!(auth.revalidate(|_| {}).await, Validation::Denied);
    assert!(auth.stored().is_some(), "403 says the credential is fine");
    assert_eq!(
        stub.hits("/token"),
        1,
        "retrying a permission decision would loop forever against a settled answer"
    );
}

#[tokio::test]
async fn two_failures_then_a_success_end_signed_in_with_no_user_action() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant(&stub);
    stub.profile("Ada Lovelace", None);

    let auth = core(&stub, &dir).with_backoff_base(Duration::from_millis(1));
    sign_in(&auth).await;

    stub.on(
        "/token",
        vec![Reply::err(503, "down"), Reply::err(500, "down"), Reply::ok(JWT_OK)],
    );

    let mut settled_with = None;
    assert_eq!(
        auth.revalidate(|snapshot| settled_with = Some(snapshot)).await,
        Validation::Confirmed
    );
    assert!(signed_in(&settled_with.expect("the loop must report once, at the end")));
    assert_eq!(stub.hits("/token"), 3, "it kept trying without being asked to");
}

#[tokio::test]
async fn a_rate_limit_is_indeterminate_and_honours_retry_after() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant(&stub);

    let auth = core(&stub, &dir);
    sign_in(&auth).await;

    stub.on(
        "/token",
        vec![Reply::err(429, "slow down").with_header("Retry-After: 42")],
    );
    assert_eq!(
        auth.validate_once().await,
        Validation::Indeterminate {
            retry_after: Some(Duration::from_secs(42))
        },
        "a 429 is the server rationing us, not rejecting us"
    );
    assert!(auth.stored().is_some());

    // Without the header it simply falls into the same backoff.
    stub.on("/token", vec![Reply::err(429, "slow down")]);
    assert_eq!(
        auth.validate_once().await,
        Validation::Indeterminate { retry_after: None }
    );
}

#[test]
fn backoff_grows_and_is_bounded() {
    let mut schedule = Backoff::new(BASE, CEILING);
    let mut previous = Duration::ZERO;

    for attempt in 0..40 {
        let delay = schedule.next();
        assert!(delay <= CEILING, "attempt {attempt} exceeded the ceiling: {delay:?}");
        // Each delay is drawn from [cap/2, cap] and cap doubles, so the lowest
        // a delay can be is the highest the previous one could have been.
        // Growth therefore holds without depending on the jitter — until the
        // ceiling, where both draws come from the same window.
        if delay < CEILING / 2 {
            assert!(
                delay >= previous,
                "attempt {attempt} went backwards: {previous:?} -> {delay:?}"
            );
        }
        previous = delay;
    }

    assert!(
        previous >= CEILING / 2,
        "a long outage must settle at the ceiling, not drift below it"
    );
}

#[test]
fn a_hostile_retry_after_cannot_escape_the_window() {
    let mut schedule = Backoff::new(BASE, CEILING);
    assert_eq!(
        schedule.next_after(Some(Duration::from_secs(86_400))),
        CEILING,
        "one bad header must not strand a signed-in user for a day"
    );
    assert_eq!(
        schedule.next_after(Some(Duration::ZERO)),
        BASE,
        "a zero must not turn the loop into a spin against a server asking for quiet"
    );
    assert_eq!(schedule.next_after(Some(Duration::from_secs(30))), Duration::from_secs(30));
}

// ---------------------------------------------------------------- identity

/// How many avatar files the cache is holding. Growth here would mean every
/// photo change leaks a file into the config directory forever.
fn cached_avatars(dir: &TempDir) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir.path())
        .expect("read config dir")
        .filter_map(std::result::Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("avatar-"))
        })
        .collect();
    found.sort();
    found
}

fn scripted_grant(stub: &Stub) {
    stub.grant_ready(600);
    stub.on("/device/token", vec![Reply::ok(TOKEN_OK)]);
    // Validation takes its verdict from `/token`, and the identity refresh only
    // runs once the credential is confirmed — so a test about a photo has to
    // let the credential pass first.
    stub.on("/token", vec![Reply::ok(JWT_OK)]);
}

/// Validate, then hand back the resulting snapshot. The shape the identity
/// tests want: they care about the name and the photo, not the outcome class.
async fn validated(auth: &AuthCore) -> AuthSnapshot {
    auth.validate_once().await;
    auth.snapshot()
}

#[tokio::test]
async fn the_identity_snapshot_is_written_on_sign_in_and_survives_a_restart() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant(&stub);
    stub.profile("Ada Lovelace", Some(&stub.url("/photo.png")));
    stub.on("/photo.png", vec![Reply::with_content_type("image/png", PIXELS)]);

    let auth = core(&stub, &dir);
    sign_in(&auth).await;

    let user = user_of(&auth.snapshot());
    assert_eq!(user.name, "Ada Lovelace");
    assert_eq!(user.email, "ada@atlas.example");
    let path = user.avatar_path.clone().expect("a photo was fetched");
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        PIXELS,
        "the cached file must hold the bytes the server served"
    );

    // A fresh core over the same directory is what a relaunch looks like — and
    // it must render a complete title bar with no network involved at all.
    let relaunched = AuthCore::new("http://127.0.0.1:1", dir.path(), reqwest::Client::new());
    let offline = user_of(&relaunched.snapshot());
    assert_eq!(offline, user, "the snapshot must survive a restart intact");
}

#[tokio::test]
async fn a_photo_that_has_not_changed_is_never_fetched_again() {
    // The privacy claim, made testable: a launch must not tell Google or GitHub
    // that this user opened their editor, for a picture already on disk.
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant(&stub);
    stub.profile("Ada Lovelace", Some(&stub.url("/photo.png")));
    stub.on("/photo.png", vec![Reply::with_content_type("image/png", PIXELS)]);

    let auth = core(&stub, &dir);
    sign_in(&auth).await;
    assert_eq!(stub.hits("/photo.png"), 1, "fetched once on sign-in");
    let first = user_of(&auth.snapshot()).avatar_path;

    let relaunched = core(&stub, &dir);
    let snapshot = validated(&relaunched).await;

    assert_eq!(stub.hits("/photo.png"), 1, "a relaunch must reuse the cache");
    assert_eq!(user_of(&snapshot).avatar_path, first);
    assert!(
        stub.hits("/get-session") >= 2,
        "the profile itself is still refreshed — it is the photo that is cached"
    );
}

#[tokio::test]
async fn a_changed_photo_url_re_fetches_and_drops_the_old_file() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant(&stub);
    stub.profile("Ada Lovelace", Some(&stub.url("/photo.png")));
    stub.on("/photo.png", vec![Reply::with_content_type("image/png", PIXELS)]);

    let auth = core(&stub, &dir);
    sign_in(&auth).await;
    let old = user_of(&auth.snapshot()).avatar_path.expect("first photo");

    // The user changed their photo; the provider hands back a new URL.
    stub.profile("Ada Lovelace", Some(&stub.url("/photo-v2.png")));
    stub.on("/photo-v2.png", vec![Reply::with_content_type("image/png", "new-pixels")]);

    let snapshot = validated(&core(&stub, &dir)).await;
    let new = user_of(&snapshot).avatar_path.expect("second photo");

    assert_eq!(stub.hits("/photo-v2.png"), 1, "a changed URL must re-fetch");
    assert_ne!(new, old, "a new photo must land at a new path, or the webview caches the old face");
    assert_eq!(std::fs::read_to_string(&new).unwrap(), "new-pixels");
    assert_eq!(cached_avatars(&dir).len(), 1, "the superseded file must not linger");
}

#[tokio::test]
async fn a_failed_re_fetch_keeps_the_photo_it_already_had() {
    // The rule the whole failure classification turns on, applied to the cache:
    // a timeout tells us nothing about the new photo, so it must not cost the
    // known-good old one. Deleting it would mean a five-second blip during one
    // launch leaves the title bar blank on every offline launch afterwards.
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant(&stub);
    stub.profile("Ada Lovelace", Some(&stub.url("/photo.png")));
    stub.on("/photo.png", vec![Reply::with_content_type("image/png", PIXELS)]);

    let auth = core(&stub, &dir);
    sign_in(&auth).await;
    let known_good = user_of(&auth.snapshot()).avatar_path.expect("first photo");

    // The photo changes, but the CDN is having a bad minute.
    stub.profile("Ada Lovelace", Some(&stub.url("/photo-v2.png")));
    stub.on("/photo-v2.png", vec![Reply::err(503, "unavailable")]);

    let snapshot = validated(&core(&stub, &dir)).await;
    assert_eq!(
        user_of(&snapshot).avatar_path.as_deref(),
        Some(known_good.as_str()),
        "an indeterminate failure must not trade a good photo for initials"
    );
    assert!(
        std::path::Path::new(&known_good).exists(),
        "nor delete the bytes behind it"
    );

    // And the next launch must still notice the photo changed, rather than
    // filing the new URL against the old file and never trying again.
    stub.on(
        "/photo-v2.png",
        vec![Reply::with_content_type("image/png", "new-pixels")],
    );
    let recovered = validated(&core(&stub, &dir)).await;
    let new = user_of(&recovered).avatar_path.expect("second photo");
    assert_ne!(new, known_good, "the retry must land the new photo");
    assert_eq!(std::fs::read_to_string(&new).unwrap(), "new-pixels");
    assert_eq!(cached_avatars(&dir).len(), 1, "and only then drop the old one");
}

#[tokio::test]
async fn a_photo_that_fails_to_fetch_falls_back_without_blocking_sign_in() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant(&stub);
    stub.profile("Ada Lovelace", Some(&stub.url("/gone.png")));
    stub.on("/gone.png", vec![Reply::err(404, "nope")]);

    let auth = core(&stub, &dir);
    sign_in(&auth).await;

    let user = user_of(&auth.snapshot());
    assert_eq!(user.avatar_path, None, "a failed fetch renders as initials");
    assert_eq!(user.name, "Ada Lovelace", "and must not cost the rest of the identity");
    assert!(auth.stored().is_some(), "least of all the credential");
    assert!(cached_avatars(&dir).is_empty(), "nothing half-written on disk");

    // Self-healing: the recorded URL matches but no file exists, so the next
    // launch tries again rather than treating the failure as permanent.
    stub.on("/gone.png", vec![Reply::with_content_type("image/png", PIXELS)]);
    let snapshot = validated(&core(&stub, &dir)).await;
    assert!(
        user_of(&snapshot).avatar_path.is_some(),
        "a failed fetch must be retried on the next launch, not cached as a no"
    );
}

#[tokio::test]
async fn an_oversized_photo_is_refused_however_the_length_is_declared() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    let huge = "x".repeat(2 * 1024 * 1024 + 1);

    scripted_grant(&stub);
    stub.profile("Ada Lovelace", Some(&stub.url("/huge.png")));
    stub.on("/huge.png", vec![Reply::with_content_type("image/png", &huge)]);

    let auth = core(&stub, &dir);
    sign_in(&auth).await;
    assert_eq!(
        user_of(&auth.snapshot()).avatar_path,
        None,
        "a declared length over the cap must be refused before downloading it"
    );

    // No Content-Length at all: the cap has to hold while streaming, which is
    // the case a host that wants to fill the disk would actually use.
    let dir2 = TempDir::new();
    stub.on(
        "/huge.png",
        vec![Reply::with_content_type("image/png", &huge).without_content_length()],
    );
    let auth2 = core(&stub, &dir2);
    sign_in(&auth2).await;
    assert_eq!(
        user_of(&auth2.snapshot()).avatar_path,
        None,
        "an undeclared length must be capped while streaming"
    );
    assert!(cached_avatars(&dir2).is_empty());
}

#[tokio::test]
async fn a_response_that_is_not_an_image_is_never_written_to_disk() {
    // The avatar cache lives in a directory the asset protocol serves, so what
    // gets written there is worth being narrow about.
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant(&stub);
    stub.profile("Ada Lovelace", Some(&stub.url("/login.html")));
    stub.on(
        "/login.html",
        vec![Reply::with_content_type("text/html", "<h1>sign in</h1>")],
    );

    let auth = core(&stub, &dir);
    sign_in(&auth).await;

    assert_eq!(user_of(&auth.snapshot()).avatar_path, None);
    assert!(cached_avatars(&dir).is_empty(), "only image types reach the disk");
}

#[tokio::test]
async fn a_user_with_no_photo_is_still_fully_identified() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant(&stub);
    stub.profile("Grace Hopper", None);

    let auth = core(&stub, &dir);
    sign_in(&auth).await;

    let user = user_of(&auth.snapshot());
    assert_eq!(user.name, "Grace Hopper");
    assert_eq!(user.avatar_path, None, "the UI draws an initial for this");
}

#[tokio::test]
async fn a_successful_validation_refreshes_a_stale_snapshot() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant(&stub);
    stub.profile("Ada Lovelace", None);

    let auth = core(&stub, &dir);
    sign_in(&auth).await;
    assert_eq!(user_of(&auth.snapshot()).name, "Ada Lovelace");

    // Renamed on the web. The desktop must pick it up without a re-sign-in.
    stub.profile("Ada Byron", None);
    stub.on("/token", vec![Reply::ok(JWT_OK)]);
    let relaunched = core(&stub, &dir);
    assert_eq!(relaunched.validate_once().await, Validation::Confirmed);
    assert_eq!(user_of(&relaunched.snapshot()).name, "Ada Byron");
}

#[tokio::test]
async fn a_validation_that_fails_keeps_the_last_known_identity() {
    // The offline launch. The snapshot exists precisely so this renders a
    // complete title bar rather than a nameless one.
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant(&stub);
    stub.profile("Ada Lovelace", Some(&stub.url("/photo.png")));
    stub.on("/photo.png", vec![Reply::with_content_type("image/png", PIXELS)]);

    let auth = core(&stub, &dir);
    sign_in(&auth).await;
    let known = user_of(&auth.snapshot());

    let offline = AuthCore::new("http://127.0.0.1:1", dir.path(), reqwest::Client::new());
    offline.validate_once().await;
    assert_eq!(user_of(&offline.snapshot()), known);
    assert!(offline.stored().is_some());
}

#[tokio::test]
async fn the_signed_in_snapshot_identifies_the_user_and_carries_no_credential() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant(&stub);
    stub.profile("Ada Lovelace", Some(&stub.url("/photo.png")));
    stub.on("/photo.png", vec![Reply::with_content_type("image/png", PIXELS)]);

    let auth = core(&stub, &dir);
    sign_in(&auth).await;

    let json = serde_json::to_string(&auth.snapshot()).unwrap();
    assert!(json.contains("ada@atlas.example"), "identity is what the frontend is for");
    assert!(
        !json.contains("session-tok"),
        "the session token must never cross to the frontend"
    );
    assert!(
        !json.contains("/photo.png"),
        "nor the remote photo URL — an <img> pointed at it would put the \
         per-launch request to the provider straight back"
    );
}

#[tokio::test]
async fn a_credential_stored_before_identities_existed_still_loads() {
    // Anyone who signed in on an ATL-46 build has a file with no `identity`
    // key. Treating that as corrupt would sign them out on upgrade.
    let stub = Stub::start().await;
    let dir = TempDir::new();
    std::fs::write(
        dir.path().join("atlas-session.json"),
        r#"{"sessionToken":"session-tok","savedAt":"2026-07-22T00:00:00Z"}"#,
    )
    .unwrap();

    let auth = core(&stub, &dir);
    assert_eq!(
        auth.snapshot(),
        AuthSnapshot::SignedIn {
            user: None,
            orgs: None,
            active_org_id: None
        },
        "signed in, just not yet identified — and not yet knowing anything \
         about organisations either, which is not the same as belonging to none"
    );

    stub.profile("Ada Lovelace", None);
    stub.on("/token", vec![Reply::ok(JWT_OK)]);
    assert_eq!(
        user_of(&validated(&auth).await).name,
        "Ada Lovelace",
        "the first validation after upgrade fills the identity in"
    );
}

// ----------------------------------------------------------- organisations
//
// ATL-51. Two calls, joined, because neither answers alone: `/organization/list`
// carries the names and no roles, and the access token's `orgs` claim carries
// the roles and no names. Everything below is about that join surviving the
// ways either half can be missing.

/// A grant whose `/token` mint carries real roles, so signing in alone lands a
/// populated organisation section — no validation pass required.
fn scripted_grant_with_roles(stub: &Stub, roles: &[(&str, &str)]) {
    stub.grant_ready(600);
    stub.on("/device/token", vec![Reply::ok(TOKEN_OK)]);
    stub.on("/token", vec![jwt_reply(roles)]);
}

fn org(id: &str, name: &str, role: Option<Role>) -> AccountOrg {
    AccountOrg {
        id: id.into(),
        name: name.into(),
        role,
    }
}

#[tokio::test]
async fn organisation_names_and_roles_are_joined_from_the_two_sources() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant_with_roles(&stub, &[("org_1", "admin"), ("org_2", "developer")]);
    stub.profile("Ada Lovelace", None);
    stub.org_list(&[("org_1", "Atlas"), ("org_2", "Side Project")]);

    let auth = core(&stub, &dir);
    sign_in(&auth).await;

    let snapshot = auth.snapshot();
    assert_eq!(
        orgs_of(&snapshot),
        Some(vec![
            org("org_1", "Atlas", Some(Role::Admin)),
            org("org_2", "Side Project", Some(Role::Developer)),
        ]),
        "every name came from the list and every role from the claim — \
         neither source could have produced this alone"
    );
    assert_eq!(
        active_org_of(&snapshot).as_deref(),
        Some("org_1"),
        "with nothing set on the web, the first organisation is the active one"
    );

    // The contract ATL-44 proved: the desktop has no cookie, so the list is
    // only reachable with the session token as a Bearer.
    let seen = stub.seen("/organization/list");
    assert_eq!(seen.len(), 1, "one list call per refresh");
    assert_eq!(seen[0].method, "GET");
    assert_eq!(seen[0].bearer.as_deref(), Some("session-tok"));
}

#[tokio::test]
async fn an_account_in_no_organisation_yields_a_deliberate_empty_state() {
    // The user belongs to none — a real answer, not a failure. It has to be
    // distinguishable from every degraded state, because the menu renders a
    // plain line for it rather than a blank row, a spinner, or an error.
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant_with_roles(&stub, &[]);
    stub.profile("Ada Lovelace", None);
    stub.org_list(&[]);

    let auth = core(&stub, &dir);
    sign_in(&auth).await;

    let snapshot = auth.snapshot();
    assert!(signed_in(&snapshot), "no organisation is not a failed sign-in");
    assert_eq!(
        orgs_of(&snapshot),
        Some(Vec::new()),
        "`Some([])` — the server answered, and the answer is none. The menu \
         only states that because it can tell this from having never asked"
    );
    assert_eq!(active_org_of(&snapshot), None);
    assert_eq!(
        user_of(&snapshot).name,
        "Ada Lovelace",
        "the identity is unaffected by having joined nothing"
    );
}

#[tokio::test]
async fn the_organisation_list_survives_a_restart_and_renders_with_the_server_unreachable() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant_with_roles(&stub, &[("org_1", "product_owner")]);
    stub.profile("Ada Lovelace", None);
    stub.org_list(&[("org_1", "Atlas")]);

    let auth = core(&stub, &dir);
    sign_in(&auth).await;
    let known = orgs_of(&auth.snapshot());
    assert_eq!(
        known,
        Some(vec![org("org_1", "Atlas", Some(Role::ProductOwner))])
    );

    // A relaunch on a plane: same config directory, nothing listening.
    let offline = AuthCore::new("http://127.0.0.1:1", dir.path(), reqwest::Client::new());
    assert_eq!(
        orgs_of(&offline.snapshot()),
        known,
        "the section renders from the snapshot before any call is made"
    );

    offline.validate_once().await;
    assert_eq!(
        orgs_of(&offline.snapshot()),
        known,
        "a call that never landed says nothing about membership, so it must \
         not empty the menu"
    );
    assert_eq!(active_org_of(&offline.snapshot()).as_deref(), Some("org_1"));
}

#[tokio::test]
async fn a_failed_organisation_list_keeps_the_one_already_stored() {
    // Distinct from being offline: the server answered, just not with a list.
    // The old one is still the best thing known about this user's membership.
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant_with_roles(&stub, &[("org_1", "admin")]);
    stub.profile("Ada Lovelace", None);
    stub.org_list(&[("org_1", "Atlas")]);

    let auth = core(&stub, &dir);
    sign_in(&auth).await;
    let known = orgs_of(&auth.snapshot());

    stub.on("/organization/list", vec![Reply::err(500, "boom")]);
    assert_eq!(auth.validate_once().await, Validation::Confirmed);
    assert_eq!(
        orgs_of(&auth.snapshot()),
        known,
        "an outage on one endpoint must not trade a known-good list for an \
         empty one"
    );
}

#[tokio::test]
async fn an_organisation_the_claim_does_not_mention_is_listed_without_a_role() {
    // The two calls are not atomic with respect to each other: an invitation
    // accepted between the mint and the list lands here. A name with no role
    // beats an organisation that silently disappears.
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant_with_roles(&stub, &[("org_1", "admin")]);
    stub.profile("Ada Lovelace", None);
    stub.org_list(&[("org_1", "Atlas"), ("org_2", "Joined Just Now")]);

    let auth = core(&stub, &dir);
    sign_in(&auth).await;

    assert_eq!(
        orgs_of(&auth.snapshot()),
        Some(vec![
            org("org_1", "Atlas", Some(Role::Admin)),
            org("org_2", "Joined Just Now", None),
        ])
    );
}

#[tokio::test]
async fn a_role_this_build_does_not_know_is_dropped_but_its_organisation_is_not() {
    // A fifth role added server-side after this build shipped. There is no
    // label to render, but the organisation is still real.
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant_with_roles(&stub, &[("org_1", "auditor")]);
    stub.profile("Ada Lovelace", None);
    stub.org_list(&[("org_1", "Atlas")]);

    let auth = core(&stub, &dir);
    sign_in(&auth).await;

    assert_eq!(
        orgs_of(&auth.snapshot()),
        Some(vec![org("org_1", "Atlas", None)])
    );
}

#[tokio::test]
async fn an_unreadable_access_token_costs_the_roles_and_nothing_else() {
    // `scripted_grant` mints a `token` that is not a JWT at all. Nothing here
    // authorises anything, so an unparseable claim is a missing label — never
    // an error, and never a reason to doubt the credential.
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant(&stub);
    stub.profile("Ada Lovelace", None);
    stub.org_list(&[("org_1", "Atlas")]);

    let auth = core(&stub, &dir);
    sign_in(&auth).await;

    assert_eq!(
        orgs_of(&auth.snapshot()),
        Some(vec![org("org_1", "Atlas", None)]),
        "nothing was ever known about this role, so there is nothing to show"
    );
    assert_eq!(active_org_of(&auth.snapshot()).as_deref(), Some("org_1"));
    assert!(auth.stored().is_some());
}

#[tokio::test]
async fn an_unreadable_access_token_keeps_the_role_already_known() {
    // The other half of the case above, and the one that matters: a role was
    // known, and a later refresh could not read the claim. Downgrading "Admin"
    // to nothing over one unreadable token is the same mistake as trading a
    // known-good photo for initials over one timeout.
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant_with_roles(&stub, &[("org_1", "admin")]);
    stub.profile("Ada Lovelace", None);
    stub.org_list(&[("org_1", "Atlas")]);

    let auth = core(&stub, &dir);
    sign_in(&auth).await;
    let known = orgs_of(&auth.snapshot());
    assert_eq!(known, Some(vec![org("org_1", "Atlas", Some(Role::Admin))]));

    // The mint still succeeds — the credential is fine — but the token is not
    // one this build can read.
    stub.on("/token", vec![Reply::ok(JWT_OK)]);
    assert_eq!(auth.validate_once().await, Validation::Confirmed);
    assert_eq!(orgs_of(&auth.snapshot()), known);
}

#[tokio::test]
async fn a_claim_that_places_the_user_nowhere_does_clear_the_role() {
    // The distinction the tri-state exists for: an `orgs` claim of `{}` was
    // *read*, and says this user holds no role here (API doc §5.1). Unlike an
    // unreadable token, that is an answer, and it must land.
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant_with_roles(&stub, &[("org_1", "admin")]);
    stub.profile("Ada Lovelace", None);
    stub.org_list(&[("org_1", "Atlas")]);

    let auth = core(&stub, &dir);
    sign_in(&auth).await;
    assert_eq!(
        orgs_of(&auth.snapshot()),
        Some(vec![org("org_1", "Atlas", Some(Role::Admin))])
    );

    stub.on("/token", vec![jwt_reply(&[])]);
    assert_eq!(auth.validate_once().await, Validation::Confirmed);
    assert_eq!(
        orgs_of(&auth.snapshot()),
        Some(vec![org("org_1", "Atlas", None)]),
        "a claim we could read outranks one we remember"
    );
}

#[tokio::test]
async fn organisations_that_were_never_fetched_are_unknown_rather_than_none() {
    // Upgrading from a build that stored no organisations. Saying "no
    // organisation" here would be a lie to a user who has one — and offline,
    // a lie with no expiry, since the list call never lands to correct it.
    let stub = Stub::start().await;
    let dir = TempDir::new();
    std::fs::write(
        dir.path().join("atlas-session.json"),
        r#"{"sessionToken":"session-tok","savedAt":"2026-07-22T00:00:00Z",
            "identity":{"id":"user_1","name":"Ada Lovelace",
                        "email":"ada@atlas.example","avatarUrl":null,
                        "avatarPath":null}}"#,
    )
    .unwrap();

    let auth = core(&stub, &dir);
    assert_eq!(
        user_of(&auth.snapshot()).name,
        "Ada Lovelace",
        "the identity from the old file still loads"
    );
    assert_eq!(
        orgs_of(&auth.snapshot()),
        None,
        "never asked is not the same answer as none"
    );

    // A launch where the list call fails must not resolve the question either.
    stub.profile("Ada Lovelace", None);
    stub.on("/token", vec![Reply::ok(JWT_OK)]);
    stub.on("/organization/list", vec![Reply::err(500, "boom")]);
    assert_eq!(auth.validate_once().await, Validation::Confirmed);
    assert_eq!(orgs_of(&auth.snapshot()), None, "still unknown, still silent");

    // And is settled the moment one lands.
    stub.org_list(&[("org_1", "Atlas")]);
    assert_eq!(auth.validate_once().await, Validation::Confirmed);
    assert_eq!(
        orgs_of(&auth.snapshot()),
        Some(vec![org("org_1", "Atlas", None)])
    );
}

#[tokio::test]
async fn the_active_organisation_follows_the_web_and_falls_back_when_it_cannot() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant_with_roles(&stub, &[("org_1", "member"), ("org_2", "admin")]);
    stub.org_list(&[("org_1", "First"), ("org_2", "Chosen")]);
    stub.profile_active_org("Ada Lovelace", None, Some("org_2"));

    let auth = core(&stub, &dir);
    sign_in(&auth).await;
    assert_eq!(
        active_org_of(&auth.snapshot()).as_deref(),
        Some("org_2"),
        "a choice made on the web outranks list order"
    );

    // Membership in the active organisation removed on the web: the stored
    // choice is no longer in the list, and must not resolve to nothing.
    stub.profile_active_org("Ada Lovelace", None, Some("org_2"));
    stub.org_list(&[("org_1", "First")]);
    assert_eq!(auth.validate_once().await, Validation::Confirmed);
    assert_eq!(
        active_org_of(&auth.snapshot()).as_deref(),
        Some("org_1"),
        "an active id that is no longer a membership falls back to the first"
    );
}

/// #73: the desktop org switcher must reach billing. The active org used to
/// be writable only from the web — that held while the field just picked
/// which org the sidebar shows, and stopped holding when it became the org
/// every gateway request bills. A frontend-only switch kept billing (and
/// entitlement-checking) the previous org, so an unentitled org appeared to
/// work: its turns were quietly charged to the entitled one.
#[tokio::test]
async fn the_desktop_can_set_the_active_organisation_it_bills() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant_with_roles(&stub, &[("org_a", "admin"), ("org_b", "member")]);
    stub.org_list(&[("org_a", "Entitled"), ("org_b", "Unentitled")]);
    stub.profile("Ada Lovelace", None);

    let auth = core(&stub, &dir);
    sign_in(&auth).await;
    assert_eq!(
        active_org_of(&auth.snapshot()).as_deref(),
        Some("org_a"),
        "list order is the fallback before any switch",
    );

    auth.set_active_org(Some("org_b".to_string()))
        .expect("a signed-in user can switch");
    assert_eq!(
        active_org_of(&auth.snapshot()).as_deref(),
        Some("org_b"),
        "the switch is what the gateway's Atlas-Org source reads next",
    );

    // Survives a restart: the choice lives in the credential file.
    let reopened = core(&stub, &dir);
    assert_eq!(active_org_of(&reopened.snapshot()).as_deref(), Some("org_b"));

    // Clearing returns to the documented fallback (web-set value, else first) —
    // the state a local-only org (no server id) selects.
    auth.set_active_org(None).expect("clearing is a valid state");
    assert_eq!(active_org_of(&auth.snapshot()).as_deref(), Some("org_a"));
}

// ---------------------------------------------------------------- sign-out
//
// The ordering is the whole ticket (ATL-50): everything local goes first and
// unconditionally, and only then is the server told. Revoking first would make
// sign-out fail while offline — precisely when someone closing a borrowed
// laptop most needs it to work.

/// Signed in with a photo on disk, which is the state sign-out has to erase.
async fn signed_in_with_a_photo(stub: &Stub, dir: &TempDir) -> AuthCore {
    scripted_grant(stub);
    stub.profile("Ada Lovelace", Some(&stub.url("/photo.png")));
    stub.on("/photo.png", vec![Reply::with_content_type("image/png", PIXELS)]);
    let auth = core(stub, dir);
    sign_in(&auth).await;
    assert!(!cached_avatars(dir).is_empty(), "the photo should be cached");
    auth
}

#[tokio::test]
async fn signing_out_clears_everything_local_before_the_server_is_told() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    stub.on("/sign-out", vec![Reply::ok("{}")]);
    let auth = signed_in_with_a_photo(&stub, &dir).await;

    let ticket = auth.sign_out().expect("a stored credential to revoke");

    assert_eq!(auth.snapshot(), AuthSnapshot::SignedOut);
    assert!(auth.stored().is_none(), "the credential must be gone");
    assert!(
        !dir.path().join("atlas-session.json").exists(),
        "the identity snapshot lives in the credential file and goes with it"
    );
    assert!(cached_avatars(&dir).is_empty(), "the cached photo must be gone too");
    assert_eq!(
        stub.hits("/sign-out"),
        0,
        "nothing may be sent before the local state is clear — that ordering is \
         what makes sign-out work with the network off"
    );

    // A fresh core over the same directory is what a relaunch looks like: it
    // must start signed out, and reach for nothing.
    let relaunched = AuthCore::new("http://127.0.0.1:1", dir.path(), reqwest::Client::new());
    assert_eq!(relaunched.snapshot(), AuthSnapshot::SignedOut);
    assert_eq!(relaunched.validate_once().await, Validation::NoCredential);

    assert!(auth.revoke(ticket).await, "a 200 is the session confirmed gone");
    assert_eq!(
        stub.seen("/sign-out"),
        vec![Seen {
            method: "POST".into(),
            bearer: Some("session-tok".into()),
        }],
        "revocation is one POST carrying the session token as a Bearer (ATL-44)"
    );
}

#[tokio::test]
async fn a_failed_revocation_is_reported_once_and_never_retried() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    stub.on("/sign-out", vec![Reply::err(500, "boom")]);
    let auth = signed_in_with_a_photo(&stub, &dir).await;

    let ticket = auth.sign_out().expect("signed in");
    assert!(!auth.revoke(ticket).await, "a 500 leaves the server session up");

    // The local state a retry would protect is already gone, so there is
    // nothing left for a backoff schedule to defend — see `revoke`.
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(stub.hits("/sign-out"), 1, "fired once and forgotten");
    assert!(auth.stored().is_none(), "and the failure never resurrects the credential");
}

#[tokio::test]
async fn signing_out_with_the_network_off_still_signs_out() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    // Sign in against the reachable stub, then throw that core away.
    drop(signed_in_with_a_photo(&stub, &dir).await);

    // Port 1 on loopback: nothing listens, so the connection is refused. This
    // is the case the ordering exists for.
    let offline = AuthCore::new("http://127.0.0.1:1", dir.path(), reqwest::Client::new());
    let ticket = offline.sign_out().expect("signed in");

    assert_eq!(offline.snapshot(), AuthSnapshot::SignedOut);
    assert!(offline.stored().is_none());
    assert!(cached_avatars(&dir).is_empty());
    assert!(
        !offline.revoke(ticket).await,
        "unreachable is not confirmation — the user is owed the caveat that the \
         server session may stay up until it expires"
    );
}

#[tokio::test]
async fn a_session_the_server_has_already_forgotten_needs_no_caveat() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    // 401: the server does not recognise the credential, so there is no live
    // session left to warn anyone about.
    stub.on("/sign-out", vec![Reply::err(401, "unauthorized")]);
    let auth = signed_in_with_a_photo(&stub, &dir).await;

    let ticket = auth.sign_out().expect("signed in");
    assert!(auth.revoke(ticket).await);
}

#[tokio::test]
async fn signing_out_when_already_signed_out_asks_the_server_nothing() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    let auth = core(&stub, &dir);

    assert!(
        auth.sign_out().is_none(),
        "no credential means no ticket, and nothing to revoke"
    );
    assert_eq!(auth.snapshot(), AuthSnapshot::SignedOut);
    assert_eq!(stub.hits("/sign-out"), 0);
}

#[tokio::test]
async fn a_refresh_in_flight_cannot_resurrect_a_signed_out_credential() {
    // Sign-out is not the only thing running: a launch validates in the
    // background, and that path *writes the credential file* once its profile
    // and photo calls return. A click landing in that window would otherwise be
    // undone — the title bar signed out, the file back on disk, and the next
    // launch signed straight back in.
    let stub = Stub::start().await;
    let dir = TempDir::new();
    let auth = Arc::new(signed_in_with_a_photo(&stub, &dir).await);

    // A changed photo URL, served slowly: the refresh is now provably still in
    // flight when the sign-out below happens.
    stub.profile("Ada Lovelace", Some(&stub.url("/slow.png")));
    stub.on(
        "/slow.png",
        vec![Reply::with_content_type("image/png", PIXELS).slow(300)],
    );

    let refreshing = {
        let auth = Arc::clone(&auth);
        tokio::spawn(async move { auth.validate_once().await })
    };
    tokio::time::sleep(Duration::from_millis(80)).await;

    let ticket = auth.sign_out().expect("signed in");
    let _ = refreshing.await;

    assert!(
        auth.stored().is_none(),
        "a write from a call that started before the sign-out must not put the \
         credential back"
    );
    assert_eq!(auth.snapshot(), AuthSnapshot::SignedOut);
    assert!(
        cached_avatars(&dir).is_empty(),
        "nor may it leave a face behind in the config directory"
    );
    drop(ticket);
}
