//! Elicitation-store tests, adapted from Zed's `acp_thread` suite
//! (`~/Codes/zed-ref/crates/acp_thread/src/acp_thread.rs`, the elicitation
//! tests around `test_form_elicitation_accepts_response` onwards).
//!
//! The invariants under test are the ones an agent's `elicitation/create` call
//! is blocked on: it must always get exactly one answer, and never zero.

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::*;

fn form_request(session: &str) -> acp::CreateElicitationRequest {
    let scope = acp::ElicitationScope::Session(acp::ElicitationSessionScope::new(
        acp::SessionId::new(session),
    ));
    acp::CreateElicitationRequest::new(
        acp::ElicitationMode::Form(acp::ElicitationFormMode::new(
            scope,
            acp::ElicitationSchema::new(),
        )),
        "Pick one",
    )
}

fn url_request(session: &str, elicitation_id: &str, url: &str) -> acp::CreateElicitationRequest {
    let scope = acp::ElicitationScope::Session(acp::ElicitationSessionScope::new(
        acp::SessionId::new(session),
    ));
    acp::CreateElicitationRequest::new(
        acp::ElicitationMode::Url(acp::ElicitationUrlMode::new(
            scope,
            acp::ElicitationId::new(elicitation_id),
            url,
        )),
        "Sign in",
    )
}

fn request_scoped(request_id: i64) -> acp::CreateElicitationRequest {
    let scope = acp::ElicitationScope::Request(acp::ElicitationRequestScope::new(
        acp::RequestId::Number(request_id),
    ));
    acp::CreateElicitationRequest::new(
        acp::ElicitationMode::Form(acp::ElicitationFormMode::new(
            scope,
            acp::ElicitationSchema::new(),
        )),
        "Enter the code",
    )
}

fn accept() -> acp::CreateElicitationResponse {
    acp::CreateElicitationResponse::new(acp::ElicitationAction::Accept(
        acp::ElicitationAcceptAction::new(),
    ))
}

fn new_store() -> (ElicitationStore, EventStream<ElicitationStoreEvent>) {
    let (tx, rx) = event_channel();
    (ElicitationStore::new(tx), rx)
}

fn status_of(store: &ElicitationStore, id: &ElicitationEntryId) -> String {
    let (_, elicitation) = store.elicitation(id).expect("elicitation missing");
    format!("{:?}", elicitation.status)
        .split(&[' ', '{'][..])
        .next()
        .unwrap()
        .to_string()
}

/// Adapted from `test_form_elicitation_accepts_response`.
#[tokio::test]
async fn accepting_a_form_resolves_the_waiter_and_records_accepted() {
    let (mut store, _events) = new_store();

    let (id, waiter) = store.request_elicitation(form_request("s1")).unwrap();
    store.respond_to_elicitation(&id, accept());

    let response = waiter.await;
    assert!(matches!(
        response.action,
        acp::ElicitationAction::Accept(_)
    ));
    assert_eq!(status_of(&store, &id), "Accepted");
}

/// Adapted from `test_session_elicitation_ignores_duplicate_response` /
/// `test_request_elicitation_store_ignores_duplicate_response`.
///
/// The oneshot has already been consumed; a second answer must be dropped
/// rather than panicking or overwriting the recorded status.
#[tokio::test]
async fn a_duplicate_response_is_ignored() {
    let (mut store, _events) = new_store();

    let (id, waiter) = store.request_elicitation(form_request("s1")).unwrap();
    store.respond_to_elicitation(&id, accept());
    store.respond_to_elicitation(
        &id,
        acp::CreateElicitationResponse::new(acp::ElicitationAction::Decline),
    );

    assert!(matches!(waiter.await.action, acp::ElicitationAction::Accept(_)));
    assert_eq!(status_of(&store, &id), "Accepted");
}

/// Adapted from `test_cancel_pending_session_elicitation_resolves_cancel`.
#[tokio::test]
async fn cancelling_a_pending_elicitation_resolves_it_as_cancelled() {
    let (mut store, _events) = new_store();

    let (id, waiter) = store.request_elicitation(form_request("s1")).unwrap();
    store.cancel_elicitation(&id);

    assert!(matches!(waiter.await.action, acp::ElicitationAction::Cancel));
    assert_eq!(status_of(&store, &id), "Canceled");
}

/// A store that goes away must not strand the agent: the dropped sender
/// resolves the waiter as cancelled rather than leaving it pending forever.
#[tokio::test]
async fn dropping_the_store_still_answers_the_agent() {
    let (mut store, _events) = new_store();

    let (_id, waiter) = store.request_elicitation(form_request("s1")).unwrap();
    drop(store);

    assert!(matches!(waiter.await.action, acp::ElicitationAction::Cancel));
}

/// Adapted from `test_url_elicitation_can_be_completed`.
#[tokio::test]
async fn an_accepted_url_elicitation_can_be_completed() {
    let (mut store, _events) = new_store();

    let (id, waiter) = store
        .request_elicitation(url_request("s1", "e1", "https://example.com/device"))
        .unwrap();
    store.respond_to_elicitation(&id, accept());
    let _ = waiter.await;
    assert_eq!(status_of(&store, &id), "Accepted");

    store.complete_url_elicitation(&acp::ElicitationId::new("e1"));
    assert_eq!(status_of(&store, &id), "Completed");
}

/// Adapted from `test_cancel_accepted_url_elicitation_marks_canceled`.
///
/// An accepted URL elicitation is still outstanding — the user is off in a
/// browser — so cancellation is allowed to reach it, unlike other resolved
/// states.
#[tokio::test]
async fn an_accepted_url_elicitation_can_still_be_cancelled() {
    let (mut store, _events) = new_store();

    let (id, waiter) = store
        .request_elicitation(url_request("s1", "e1", "https://example.com/device"))
        .unwrap();
    store.respond_to_elicitation(&id, accept());
    let _ = waiter.await;

    store.cancel_elicitation(&id);
    assert_eq!(status_of(&store, &id), "Canceled");
}

/// Adapted from
/// `test_request_elicitation_store_clear_resolved_preserves_outstanding`.
#[tokio::test]
async fn clear_resolved_keeps_pending_and_accepted_url_entries() {
    let (mut store, _events) = new_store();

    let (answered, answered_waiter) = store.request_elicitation(form_request("s1")).unwrap();
    store.respond_to_elicitation(&answered, accept());
    let _ = answered_waiter.await;

    let (pending, _pending_waiter) = store.request_elicitation(form_request("s1")).unwrap();

    let (url, url_waiter) = store
        .request_elicitation(url_request("s1", "e1", "https://example.com/device"))
        .unwrap();
    store.respond_to_elicitation(&url, accept());
    let _ = url_waiter.await;

    let cleared = store.clear_resolved();

    assert_eq!(cleared, vec![answered]);
    assert!(store.elicitation(&pending).is_some());
    assert!(store.elicitation(&url).is_some());
}

/// Adapted from `test_cancel_request_scoped_elicitation_resolves_cancel`.
///
/// Abandoning one in-flight auth request must cancel only that request's
/// elicitations, not every outstanding one.
#[tokio::test]
async fn cancel_request_only_touches_that_requests_elicitations() {
    let (mut store, _events) = new_store();

    let (mine, mine_waiter) = store.request_elicitation(request_scoped(1)).unwrap();
    let (other, _other_waiter) = store.request_elicitation(request_scoped(2)).unwrap();

    store.cancel_request(&acp::RequestId::Number(1));

    assert!(matches!(
        mine_waiter.await.action,
        acp::ElicitationAction::Cancel
    ));
    assert_eq!(status_of(&store, &mine), "Canceled");
    assert_eq!(status_of(&store, &other), "Pending");
}

/// Adapted from `test_request_elicitation_store_cancel_all_resolves_cancel`.
#[tokio::test]
async fn cancel_all_resolves_every_pending_waiter() {
    let (mut store, _events) = new_store();

    let (_a, a_waiter) = store.request_elicitation(form_request("s1")).unwrap();
    let (_b, b_waiter) = store.request_elicitation(form_request("s1")).unwrap();

    store.cancel_all();

    assert!(matches!(a_waiter.await.action, acp::ElicitationAction::Cancel));
    assert!(matches!(b_waiter.await.action, acp::ElicitationAction::Cancel));
}

/// Adapted from `test_url_elicitation_rejects_non_browser_urls`.
///
/// This is a security boundary, not validation politeness: the client is about
/// to hand this URL to the OS browser.
#[tokio::test]
async fn a_url_elicitation_must_be_http_or_https_with_a_host() {
    let (mut store, _events) = new_store();

    for bad in [
        "file:///etc/passwd",
        "javascript:alert(1)",
        "https://",
        "not a url",
    ] {
        assert!(
            store
                .request_elicitation(url_request("s1", "e1", bad))
                .is_err(),
            "expected `{bad}` to be rejected"
        );
    }

    assert!(store
        .request_elicitation(url_request("s1", "e1", "https://example.com"))
        .is_ok());
}

/// Adapted from `test_elicitation_rejects_unadvertised_mode`: a mode this client
/// cannot render is refused rather than silently accepted and never answered.
#[tokio::test]
async fn an_unknown_elicitation_mode_is_rejected() {
    let (mut store, _events) = new_store();

    let scope = acp::ElicitationScope::Session(acp::ElicitationSessionScope::new(
        acp::SessionId::new("s1"),
    ));
    let mode = acp::ElicitationMode::Other(acp::OtherElicitationMode::new(
        "telepathy",
        scope,
        Default::default(),
    ));
    let request = acp::CreateElicitationRequest::new(mode, "think at me");

    assert!(store.request_elicitation(request).is_err());
}

/// Regression, ATL-218 finding 2. `entry_id_for_url_elicitation` resolves an
/// agent-supplied `elicitationId` by reverse-scanning, so a duplicate meant
/// last-wins: the older entry could never be completed, stayed `Accepted`
/// (which `clear_resolved` deliberately keeps), and left a stale row on screen
/// for the life of the session. The schema documents the field as unique;
/// nothing enforced it.
#[tokio::test]
async fn a_duplicate_url_elicitation_id_is_refused_while_the_first_is_outstanding() {
    let (mut store, _events) = new_store();

    let (_first, _waiter) = store
        .request_elicitation(url_request("s1", "e1", "https://example.com/device"))
        .unwrap();

    let duplicate = store.request_elicitation(url_request("s1", "e1", "https://example.com/other"));

    assert!(duplicate.is_err(), "a second live elicitation took the same id");
    assert_eq!(store.elicitations().len(), 1);
}

/// The scope of that refusal matters: a device-code login legitimately retries
/// with the same id after the first attempt was cancelled, and refusing THAT
/// would break the retry rather than fix anything.
#[tokio::test]
async fn a_url_elicitation_id_can_be_reused_once_the_first_is_resolved() {
    let (mut store, _events) = new_store();

    let (first, waiter) = store
        .request_elicitation(url_request("s1", "e1", "https://example.com/device"))
        .unwrap();
    store.cancel_elicitation(&first);
    let _ = waiter.await;

    assert!(store
        .request_elicitation(url_request("s1", "e1", "https://example.com/device"))
        .is_ok());
}
