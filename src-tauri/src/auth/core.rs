//! The device grant, the poll loop, and the credential and identity lifecycle.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

use super::backoff::{self, Backoff};
use super::store::{self, Role, StoredIdentity, StoredOrg, StoredSession};
use super::{avatar, AuthSnapshot};

/// RFC 8628 `client_id` for this app, matching the server's device plugin.
const CLIENT_ID: &str = "atlas-desktop";
const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";

/// Floor on the poll interval so a misbehaving or hostile server cannot make us
/// hammer it. The server normally says 5s.
const MIN_POLL_INTERVAL: Duration = Duration::from_millis(200);

/// Ceiling on an authenticated call. The shared `reqwest::Client` carries no
/// default, and one of these sits on the sign-in path between approval and the
/// dialog closing: a server that accepts the connection and then never answers
/// would otherwise leave "Continue in your browser…" on screen forever, long
/// after the credential was safely written.
const AUTHED_TIMEOUT: Duration = Duration::from_secs(10);

/// A grant awaiting approval in the browser.
#[derive(Debug, Clone)]
pub struct PendingGrant {
    /// The secret the desktop polls with. Never leaves Rust, never logged.
    pub device_code: String,
    /// The short human-readable code. A display string, not a secret.
    pub user_code: String,
    pub verification_uri: String,
    /// The pre-filled approval URL. Parsed because RFC 8628 defines it and the
    /// server sends it, but **deliberately never opened** — see the comment in
    /// `commands::auth::auth_sign_in`. A link that carries the code is the
    /// remote-phishing surface the copy-and-paste hand-off exists to close.
    ///
    /// Never read outside tests, and that is the point: the test
    /// `the_browser_is_sent_to_the_plain_url_never_the_pre_filled_one` asserts
    /// this differs from `approval_url()`, pinning the decision.
    /// `allow(dead_code)` keeps that guard without the field reading as an
    /// oversight — do NOT "fix" the warning by deleting it or by opening it.
    #[allow(dead_code)]
    pub verification_uri_complete: String,
    pub expires_at: SystemTime,
    pub interval: Duration,
    /// Flipped by `cancel_grant`; the loop checks it between polls.
    cancel: Arc<AtomicBool>,
}

impl PendingGrant {
    fn expired(&self) -> bool {
        SystemTime::now() >= self.expires_at
    }

    /// The page to open in the browser: the **plain** verification URI.
    ///
    /// A named method rather than a field access at the call site, because this
    /// is a security decision and not a formatting one. Opening
    /// `verification_uri_complete` instead would put the code in the URL, and a
    /// link that carries the code is the whole remote-phishing attack — an
    /// already-signed-in user is then one click from approving a grant someone
    /// else started. Sending them to an empty box means the code that gets
    /// approved is necessarily the one this window is showing.
    ///
    /// It reads as a harmless UX improvement to "just pre-fill it", which is
    /// exactly why it is stated here and pinned by a test.
    pub fn approval_url(&self) -> &str {
        &self.verification_uri
    }
}

/// One poll of `/device/token`, classified.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PollOutcome {
    /// Approved. Carries the Better Auth session token.
    Token(String),
    /// Not approved yet — keep going at the current interval.
    Pending,
    /// Polled too fast; RFC 8628 says add 5 seconds.
    SlowDown,
    /// The human pressed Deny.
    Denied,
    /// The code aged out server-side.
    Expired,
    /// We learned nothing: network error, 5xx, or an unparseable body. NOT a
    /// reason to end the grant — see `run_grant`.
    Transient,
}

/// Why a grant ended without a token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GrantError {
    Denied,
    Expired,
    Cancelled,
    /// Could not even start the grant.
    Start(String),
}

impl GrantError {
    /// Message for the connecting dialog.
    pub fn user_message(&self) -> String {
        match self {
            GrantError::Denied => "Connection denied in the browser.".into(),
            GrantError::Expired => "That code expired. Get a new one to try again.".into(),
            GrantError::Cancelled => "Sign-in cancelled.".into(),
            GrantError::Start(e) => format!("Could not reach Atlas: {e}"),
        }
    }
}

/// Why an authenticated call produced no value (ATL-48).
///
/// This is the failure classification the whole module turns on, and the reason
/// it is an enum rather than a `String`: a caller that cannot see the class
/// cannot avoid the mistake this ticket exists to prevent, which is treating
/// "the server never answered" as "the server said no". **Only [`Rejected`] may
/// ever clear the credential.**
///
/// [`Rejected`]: AuthFailure::Rejected
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthFailure {
    /// Nothing stored to authenticate with. Not a failure — there was simply
    /// nothing to ask about, and no request was made.
    NoCredential,
    /// **AUTHORITATIVE (401).** The server looked at the credential and
    /// rejected it. The session is dead and no amount of retrying revives it.
    Rejected,
    /// **DENIED (403).** The credential is valid; this particular action is
    /// not permitted. Neither sign out nor retry.
    ///
    /// Every other unexpected 4xx joins this class rather than earning a fourth
    /// one: a 400 or a 404 is not a verdict on the credential either, and
    /// repeating the request will not change it — which is exactly how this
    /// class is handled.
    Denied,
    /// **INDETERMINATE.** Transport failure, timeout, DNS failure, 5xx, or 429.
    /// We learned *nothing* about the credential, so everything is preserved
    /// and the call is retried on the schedule in [`super::backoff`].
    Indeterminate {
        /// From the response's `Retry-After`, when the server supplied one.
        retry_after: Option<Duration>,
        /// For logs. Carries no URL and no token — see [`redact`].
        reason: String,
    },
}

impl AuthFailure {
    fn indeterminate(reason: impl Into<String>) -> Self {
        AuthFailure::Indeterminate {
            retry_after: None,
            reason: reason.into(),
        }
    }

    /// A message safe to show the user for a failed authenticated *action*
    /// (as opposed to the silent launch-path refresh). Never carries the
    /// `reason` string — that is for logs, and only the class is user-facing.
    pub fn user_message(&self) -> String {
        match self {
            AuthFailure::NoCredential => "Sign in to sync organisations.".into(),
            AuthFailure::Rejected => {
                "Your Atlas session ended. Sign in again to reconnect.".into()
            }
            // For create, the realistic Denied is a 400 duplicate slug/name; a
            // 403 on a caller-scoped create would be a server fault. Either way
            // retrying is pointless, so the message points at the fixable cause.
            AuthFailure::Denied => {
                "Couldn't sync — that organisation name or handle may already be taken.".into()
            }
            AuthFailure::Indeterminate { .. } => {
                "Couldn't reach Atlas. Check your connection and try again.".into()
            }
        }
    }

    /// [`Self::user_message`] with a caller-supplied `Denied` wording.
    ///
    /// `Denied` collapses 403 *and* 400, so what it means is entirely
    /// endpoint-specific: on org create it is a taken handle, on invite-member
    /// it is "you are not an admin" or "they are already in". The default
    /// message names the create case, so every other caller must say its own or
    /// it will tell people their handle is taken when they tried to remove
    /// someone. The match stays in here so the enum need not leak to commands.
    pub fn user_message_denied(&self, denied: &str) -> String {
        match self {
            AuthFailure::Denied => denied.into(),
            other => other.user_message(),
        }
    }
}

/// An authenticated call: a value, or a classified failure.
pub type Authed<T> = Result<T, AuthFailure>;

/// What one validation of the stored credential settled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Validation {
    /// Nothing stored. Signed out, and no network call was made.
    NoCredential,
    /// The server accepted the credential; the identity snapshot was refreshed.
    Confirmed,
    /// **401.** The credential and its snapshot have been cleared.
    Rejected,
    /// **403.** Nothing was changed and nothing will be retried.
    Denied,
    /// We learned nothing. Everything is preserved; the caller retries.
    Indeterminate {
        /// Honoured by the backoff when present — see [`Backoff::next_after`].
        retry_after: Option<Duration>,
    },
}

/// The credential a completed sign-out has already cleared, kept just long
/// enough to tell the server about it (ATL-50).
///
/// The ordering the ticket exists for is written as a type rather than a
/// comment: the only way to obtain one is to have *already* cleared the local
/// state, so no caller can revoke first and clear second — the mistake that
/// makes sign-out fail exactly when someone closing a borrowed laptop most
/// needs it to work. [`AuthCore::revoke`] then consumes it, so "fired once and
/// forgotten" is not a discipline anyone has to keep either: there is no second
/// ticket to retry with.
pub struct RevocationTicket(String);

impl std::fmt::Debug for RevocationTicket {
    /// Hand-written because this is the one type here whose entire content is a
    /// credential; a derived `Debug` would put the user's session into any log
    /// line that ever formatted a struct holding one.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RevocationTicket(<redacted>)")
    }
}

/// The auth module's whole public surface.
pub struct AuthCore {
    base: String,
    dir: PathBuf,
    http: reqwest::Client,
    /// At most one grant in flight. Guards against a double-click minting two
    /// competing codes, and is what makes a second click *resume* rather than
    /// restart — the recovery path for someone who got lost mid-flow.
    pending: Mutex<Option<PendingGrant>>,
    /// Serialises every read-modify-write of the credential file. The store
    /// is disk-backed with no in-memory copy, so `set_active_org` (a switch)
    /// and the tail of `refresh_identity` (a revalidate finishing) are both
    /// load→save sequences on the same file; unguarded, a switch landing
    /// between the refresh's re-read and its save was silently undone. Held
    /// only across synchronous sections — never across an await.
    file: Mutex<()>,
    /// First retry delay for [`Self::revalidate`]. A field only so tests can
    /// exercise the loop without sleeping through a real schedule; production
    /// always uses [`backoff::BASE`].
    backoff_base: Duration,
}

impl AuthCore {
    pub fn new(base: impl Into<String>, dir: impl Into<PathBuf>, http: reqwest::Client) -> Self {
        Self {
            base: super::config::normalize(&base.into()),
            dir: dir.into(),
            http,
            pending: Mutex::new(None),
            file: Mutex::new(()),
            backoff_base: backoff::BASE,
        }
    }

    /// The credential-file lock. Poisoning is irrelevant here — the guarded
    /// sections hold no state of their own — so a poisoned lock is recovered
    /// rather than propagated into every later sign-in.
    fn file_guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.file.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Shrink the retry schedule so a test can drive the loop through several
    /// failures in milliseconds. Absent from the shipped binary by
    /// construction, so no production path can reach for it.
    #[cfg(test)]
    pub fn with_backoff_base(mut self, base: Duration) -> Self {
        self.backoff_base = base;
        self
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    // ---- credential ----------------------------------------------------

    pub fn stored(&self) -> Option<StoredSession> {
        store::load(&self.dir)
    }

    pub fn clear_session(&self) -> Result<(), String> {
        let _guard = self.file_guard();
        store::clear(&self.dir)
    }

    /// Write a freshly granted credential, deliberately with **no identity**
    /// and no pinned organisation.
    ///
    /// A new grant can be a different person, so carrying the old snapshot over
    /// would show one user another user's name until the profile call returned.
    /// [`Self::refresh_identity`] fills it in a moment later.
    fn persist(&self, session_token: &str) -> Result<(), String> {
        let _guard = self.file_guard();
        store::save(
            &self.dir,
            &StoredSession {
                session_token: session_token.to_string(),
                saved_at: chrono::Utc::now().to_rfc3339(),
                identity: None,
                pinned_org: None,
            },
        )
    }

    /// What the frontend may see.
    pub fn snapshot(&self) -> AuthSnapshot {
        if let Some(p) = self.pending.lock().ok().and_then(|g| g.clone()) {
            if !p.expired() {
                return AuthSnapshot::Connecting {
                    user_code: p.user_code,
                    verification_uri: p.verification_uri,
                    expires_at: chrono::DateTime::<chrono::Utc>::from(p.expires_at).to_rfc3339(),
                };
            }
        }
        match self.stored() {
            Some(session) => {
                let pinned = session.pinned_org;
                let identity = session.identity;
                let resolved = identity.as_ref().and_then(StoredIdentity::active_org);
                AuthSnapshot::SignedIn {
                    orgs: identity.as_ref().and_then(|i| {
                        i.orgs
                            .as_ref()
                            .map(|orgs| orgs.iter().cloned().map(Into::into).collect())
                    }),
                    // Billing/display keep their documented fallback; the
                    // socket gets the desktop's explicit choice, "none"
                    // included, and only falls back while nothing is pinned.
                    comms_org_id: match pinned {
                        Some(pin) => pin.org_id,
                        None => resolved.clone(),
                    },
                    active_org_id: resolved,
                    user: identity.map(Into::into),
                }
            }
            None => AuthSnapshot::SignedOut,
        }
    }

    /// Record which organisation the desktop is acting for (#73).
    ///
    /// This writes the same field the web's `/organization/set-active` feeds,
    /// but locally only — the server is not told, deliberately: web and
    /// desktop each keep their own last choice, the same independence they
    /// had before, just symmetric now.
    ///
    /// The store's doc used to say this field is "never written from the
    /// desktop". That held while it only decided which organisation the
    /// sidebar displays — and stopped holding the moment it became the
    /// organisation every gateway request bills: the `Atlas-Org` source reads
    /// the snapshot per request, so a switch that never lands here keeps
    /// billing (and entitlement-checking) the previous org, which is exactly
    /// how an unentitled org appeared to work — its turns were quietly
    /// charged to the entitled one.
    ///
    /// `None` clears the desktop's choice; display and billing then fall back
    /// the way [`StoredIdentity::active_org`] documents (web-set value, else
    /// the first org). An id that is not in the org list is stored anyway and
    /// tolerated on the read side, same as the web's value — membership lists
    /// can lag.
    ///
    /// The choice is also PINNED at the session level (`None` included), which
    /// is what the chat socket follows and what a later identity refresh
    /// preserves. Pinning does not need the identity to exist yet — a switch
    /// during the boot window used to fail with "no identity yet" and leave
    /// the socket on whichever org the server listed first.
    pub fn set_active_org(&self, org_id: Option<String>) -> Result<(), String> {
        let _guard = self.file_guard();
        let Some(mut session) = self.stored() else {
            return Err("not signed in".to_string());
        };
        session.pinned_org = Some(store::PinnedOrg {
            org_id: org_id.clone(),
        });
        if let Some(identity) = session.identity.as_mut() {
            identity.active_org_id = org_id;
        }
        store::save(&self.dir, &session)
    }

    // ---- identity --------------------------------------------------------

    /// Read the signed-in user from the server.
    ///
    /// `Ok(None)` is the server saying nobody is signed in — note that
    /// `/get-session` expresses that as **200 with a `null` body**, not a 401
    /// (proven in ATL-44), so status alone would never see it. It is reported
    /// rather than classified: [`Self::validate_once`] takes its verdict from
    /// `/token` instead, and this call only ever decides a name, a photo, and
    /// which organisation was last made active.
    async fn fetch_profile(&self) -> Authed<Option<SessionResponse>> {
        let res = self.authed_get("/get-session").await?;

        let body = res
            .text()
            .await
            .map_err(|e| AuthFailure::indeterminate(redact(&e.to_string())))?;
        if body.trim().is_empty() || body.trim() == "null" {
            return Ok(None);
        }
        let session: SessionResponse = serde_json::from_str(&body)
            .map_err(|e| AuthFailure::indeterminate(format!("unreadable profile: {e}")))?;
        Ok(Some(session))
    }

    /// Every organisation the user belongs to, with the role they hold in each
    /// (ATL-51).
    ///
    /// Two calls, because neither answers alone: `/organization/list` has the
    /// names and no roles, and the access token's `orgs` claim has the roles
    /// and no names.
    ///
    /// **A failed list keeps the one already stored.** Same rule as the avatar
    /// cache and the credential itself: a call that never landed says nothing
    /// about the user's membership, and trading a known-good list for an empty
    /// one would empty the menu on every flaky launch — including the offline
    /// one this snapshot exists to serve.
    ///
    /// That includes a 401 here, which does **not** clear the credential:
    /// [`Self::validate_once`] takes its verdict from `/token` alone and has
    /// already confirmed it by the time this runs, so a rejection arriving on
    /// this call means the session died in between and the next validation is
    /// what acts on it. Only one call in this module may destroy a credential.
    ///
    /// A 403 is not surfaced to the user either, deviating from the spec's
    /// "DENIED → surface in context". There is no honest context to surface it
    /// in: this runs unprompted on the launch path, the endpoint is
    /// caller-scoped so a 403 on it indicates a server fault rather than
    /// anything the user can act on, and a toast on every launch would be
    /// noise. The section simply stays as it was, or absent — which is the
    /// truthful rendering of "we do not know".
    async fn resolve_orgs(
        &self,
        access_token: Option<String>,
        previous: Option<&StoredIdentity>,
    ) -> Option<Vec<StoredOrg>> {
        let Ok(listed) = self.fetch_orgs().await else {
            // `None` propagates when there was nothing stored either: still not
            // known, which the menu renders as no section rather than as "no
            // organisation".
            return previous.and_then(|p| p.orgs.clone());
        };

        // An empty list is a *verdict*, not a failure — a user who has joined
        // no organisation — so it is stored as-is and reaches the menu as the
        // empty state.
        let roles = match access_token {
            Some(jwt) => org_roles(&jwt),
            // Nothing minted one for us: this is the sign-in path, where the
            // credential is seconds old and no validation has run yet. A failure
            // costs the roles, never the names.
            None => self
                .mint_access_token()
                .await
                .ok()
                .and_then(|jwt| org_roles(&jwt)),
        };

        Some(
            listed
                .into_iter()
                .map(|org| StoredOrg {
                    role: match &roles {
                        // The claim was read. Absent from it means absent —
                        // membership per the server, not a failure to look.
                        Some(roles) => roles.get(&org.id).copied(),
                        // The claim was never read at all. Downgrading a label
                        // we already have would be the same mistake as trading
                        // a known-good photo for initials over one timeout.
                        None => previous.and_then(|p| p.role_of(&org.id)),
                    },
                    id: org.id,
                    name: org.name,
                })
                .collect(),
        )
    }

    /// `GET /organization/list` — the only source of organisation *names*.
    ///
    /// **One extra request per successful validation**, and one extra `/token`
    /// mint on the sign-in path. Re-checked against the auth worker's global
    /// ceiling of 100 requests per 60s, as the spec requires of anyone changing
    /// the request count: the retry path is untouched, because
    /// [`Self::validate_once`] only loops when `/token` itself fails and
    /// [`Self::refresh_identity`] never runs on the backoff schedule. A
    /// successful validation costs 3 requests and happens about once a launch.
    async fn fetch_orgs(&self) -> Authed<Vec<OrgEntry>> {
        let res = self.authed_get("/organization/list").await?;
        res.json::<Vec<OrgEntry>>()
            .await
            .map_err(|e| AuthFailure::indeterminate(format!("unreadable organisations: {e}")))
    }

    /// Pull the profile and organisations and write them onto the stored
    /// credential.
    ///
    /// Silent about every failure on purpose: this runs on the boot path behind
    /// an already-rendered signed-in title bar, and a photo, a stale display
    /// name, or a stale role is never worth a toast, let alone touching the
    /// credential.
    ///
    /// `previous` is the identity being replaced. It supplies the avatar cache
    /// key — what lets an unchanged photo cost zero requests — and is also what
    /// every fallback in [`Self::resolve_orgs`] falls back *to*.
    ///
    /// `access_token` is a JWT the caller has *already* minted, so the common
    /// path costs no second mint: [`Self::validate_once`] takes its verdict from
    /// one and would otherwise throw it away.
    async fn refresh_identity(
        &self,
        previous: Option<StoredIdentity>,
        access_token: Option<String>,
    ) {
        let Ok(Some(session)) = self.fetch_profile().await else {
            return;
        };
        let profile = session.user;
        let held = previous
            .as_ref()
            .map(|p| avatar::CachedAvatar::new(p.avatar_url.clone(), p.avatar_path.clone()))
            .unwrap_or_default();
        // Writes back the *pair* — a failed fetch returns the previous one
        // untouched, so a blip never trades a known-good photo for initials.
        let avatar =
            avatar::resolve(&self.http, &self.dir, profile.image.as_deref(), &held).await;

        let orgs = self.resolve_orgs(access_token, previous.as_ref()).await;

        // Re-read *after* the network work rather than reusing an earlier load,
        // and after the photo rather than before it: both calls above are round
        // trips, and a sign-out landing in either must not be undone by the
        // write below — a resurrected credential file would sign the user
        // straight back in on the next launch. A photo fetched into that gap
        // goes with it, since nothing will ever point at it again.
        //
        // The re-read and the save are ONE critical section under the file
        // lock: a `set_active_org` landing between the two used to be
        // overwritten by the save, which then re-pointed the socket at the
        // org the user had just left.
        let _guard = self.file_guard();
        let Some(current) = self.stored() else {
            avatar::discard(avatar.path.as_deref());
            return;
        };

        // The desktop's own choice survives the refresh. #73 made this field
        // the organisation every gateway request bills, and `set_active_org`
        // documents the independence: web and desktop each keep their own
        // last choice. The server's value is therefore a *seed* for a session
        // that has never chosen — never an override of one that has.
        // Clobbering it here was what re-pointed the chat socket (and the
        // billing header) at `orgs.first()` a few seconds after every launch,
        // until the next manual org switch wrote it back.
        //
        // A pin wins outright, "none" included: with only the identity field
        // to go on, an explicit "no organisation" (a local-only org) read as
        // "never chose" and the web's seed came straight back on the next
        // refresh — a retarget with no user action behind it.
        let active_org_id = match &current.pinned_org {
            Some(pin) => pin.org_id.clone(),
            None => current
                .identity
                .as_ref()
                .and_then(|i| i.active_org_id.clone())
                .or(session.session.active_organization_id),
        };

        let _ = store::save(
            &self.dir,
            &StoredSession {
                identity: Some(StoredIdentity {
                    id: profile.id,
                    name: profile.name,
                    email: profile.email,
                    avatar_url: avatar.url,
                    avatar_path: avatar.path,
                    orgs,
                    active_org_id,
                }),
                ..current
            },
        );
    }

    // ---- device grant --------------------------------------------------

    /// Begin a grant, or hand back the one already in flight.
    ///
    /// Reuse is load-bearing rather than an optimisation: a first-run user who
    /// has to sign in on the web often loses their way back, and clicking the
    /// account button again must return them to the *same* approval page —
    /// now with a browser session in hand — instead of stranding a fresh code.
    pub async fn start_grant(&self) -> Result<PendingGrant, GrantError> {
        if let Some(existing) = self.pending.lock().ok().and_then(|g| g.clone()) {
            if !existing.expired() && !existing.cancel.load(Ordering::SeqCst) {
                return Ok(existing);
            }
        }

        let res = self
            .http
            .post(self.url("/device/code"))
            .json(&serde_json::json!({ "client_id": CLIENT_ID }))
            .send()
            .await
            .map_err(|e| GrantError::Start(redact(&e.to_string())))?;

        if !res.status().is_success() {
            return Err(GrantError::Start(format!("server said {}", res.status())));
        }

        let body: DeviceCodeResponse = res
            .json()
            .await
            .map_err(|e| GrantError::Start(format!("unreadable response: {e}")))?;

        let grant = PendingGrant {
            device_code: body.device_code,
            user_code: body.user_code,
            verification_uri: body.verification_uri,
            verification_uri_complete: body.verification_uri_complete,
            expires_at: SystemTime::now() + Duration::from_secs(body.expires_in.max(1)),
            interval: Duration::from_secs(body.interval).max(MIN_POLL_INTERVAL),
            cancel: Arc::new(AtomicBool::new(false)),
        };

        if let Ok(mut slot) = self.pending.lock() {
            *slot = Some(grant.clone());
        }
        Ok(grant)
    }

    /// Abandon the in-flight grant, if any. Idempotent.
    pub fn cancel_grant(&self) {
        if let Ok(mut slot) = self.pending.lock() {
            if let Some(p) = slot.as_ref() {
                p.cancel.store(true, Ordering::SeqCst);
            }
            *slot = None;
        }
    }

    /// One poll, classified. Anything we cannot interpret is `Transient` —
    /// "we do not know" is never the same as "no".
    pub async fn poll_once(&self, device_code: &str) -> PollOutcome {
        let res = self
            .http
            .post(self.url("/device/token"))
            .json(&serde_json::json!({
                "grant_type": DEVICE_GRANT,
                "device_code": device_code,
                "client_id": CLIENT_ID,
            }))
            .send()
            .await;

        let Ok(res) = res else {
            return PollOutcome::Transient;
        };

        if res.status().is_server_error() {
            return PollOutcome::Transient;
        }

        if res.status().is_success() {
            return match res.json::<DeviceTokenSuccess>().await {
                Ok(b) if !b.access_token.is_empty() => PollOutcome::Token(b.access_token),
                _ => PollOutcome::Transient,
            };
        }

        match res.json::<DeviceTokenError>().await {
            Ok(b) => match b.error.as_str() {
                "authorization_pending" => PollOutcome::Pending,
                "slow_down" => PollOutcome::SlowDown,
                "access_denied" => PollOutcome::Denied,
                "expired_token" => PollOutcome::Expired,
                _ => PollOutcome::Transient,
            },
            Err(_) => PollOutcome::Transient,
        }
    }

    /// Drive the grant to a conclusion, persisting the token on success.
    ///
    /// Transient failures deliberately do **not** end the grant: a two-second
    /// wifi blip must not discard an approval the human has already given in
    /// the browser. They simply cost one poll, and the 10-minute server-side
    /// deadline still bounds the whole thing.
    pub async fn run_grant(&self, grant: &PendingGrant) -> Result<(), GrantError> {
        let mut interval = grant.interval;

        loop {
            if grant.cancel.load(Ordering::SeqCst) {
                return Err(GrantError::Cancelled);
            }
            if grant.expired() {
                self.finish();
                return Err(GrantError::Expired);
            }

            tokio::time::sleep(interval).await;

            if grant.cancel.load(Ordering::SeqCst) {
                return Err(GrantError::Cancelled);
            }

            match self.poll_once(&grant.device_code).await {
                PollOutcome::Token(token) => {
                    // Captured before the write: a new grant may be a different
                    // person, and this is what lets the avatar cache prune the
                    // previous user's photo and skip a re-fetch for the same.
                    let previous = self.stored().and_then(|s| s.identity);
                    self.persist(&token).map_err(GrantError::Start)?;
                    self.finish();
                    // Inline rather than spawned, so the single state broadcast
                    // the caller emits already carries the user's name and face.
                    // The alternative flashes a nameless signed-in title bar on
                    // every sign-in to save a few hundred milliseconds behind a
                    // spinner the user is already watching.
                    //
                    // `None`: nothing has minted an access token yet on this
                    // path, so the roles cost one of their own.
                    self.refresh_identity(previous, None).await;
                    return Ok(());
                }
                PollOutcome::Pending | PollOutcome::Transient => continue,
                PollOutcome::SlowDown => {
                    interval += Duration::from_secs(5);
                    continue;
                }
                PollOutcome::Denied => {
                    self.finish();
                    return Err(GrantError::Denied);
                }
                PollOutcome::Expired => {
                    self.finish();
                    return Err(GrantError::Expired);
                }
            }
        }
    }

    /// Clear the pending slot without signalling cancellation (the grant is
    /// over on its own terms).
    fn finish(&self) {
        if let Ok(mut slot) = self.pending.lock() {
            *slot = None;
        }
    }

    // ---- token ----------------------------------------------------------

    /// A GET carrying the stored session token as a Bearer.
    ///
    /// **This is the only place a response is classified**, so the distinction
    /// the whole module turns on is written once rather than per endpoint:
    /// [`AuthFailure::Rejected`] is the server looking at the credential and
    /// refusing it, [`AuthFailure::Indeterminate`] is us never finding out.
    /// Conflating them is what signs people out for opening a laptop on a plane.
    async fn authed_get(&self, path: &str) -> Authed<reqwest::Response> {
        let Some(stored) = self.stored() else {
            return Err(AuthFailure::NoCredential);
        };

        let res = match self
            .http
            .get(self.url(path))
            .bearer_auth(&stored.session_token)
            .timeout(AUTHED_TIMEOUT)
            .send()
            .await
        {
            Ok(res) => res,
            // Refused, timed out, DNS gone, TLS failed — the request never got
            // an answer, so it says nothing whatsoever about the credential.
            // This branch is the entire reason the class exists.
            Err(e) => return Err(AuthFailure::indeterminate(redact(&e.to_string()))),
        };

        let status = res.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(AuthFailure::Rejected);
        }
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
            return Err(AuthFailure::Indeterminate {
                retry_after: retry_after(res.headers()),
                // The path and the status, never the response body: an error
                // body from an auth server is the one place a token could
                // plausibly be echoed back.
                reason: format!("{path} failed: {status}"),
            });
        }
        if !status.is_success() {
            return Err(AuthFailure::Denied);
        }
        Ok(res)
    }

    /// [`Self::authed_get`] with a query string, classified by the same rules.
    ///
    /// A separate method rather than callers interpolating into `path`, for two
    /// reasons: an id spliced into a URL by hand is a query-injection waiting to
    /// happen (reqwest percent-encodes here), and `reason` below logs only the
    /// bare `path`, so a query value can never reach the log line. Both are the
    /// same instinct as the body never being logged in `authed_post`.
    async fn authed_get_query(
        &self,
        path: &str,
        query: &impl Serialize,
    ) -> Authed<reqwest::Response> {
        let Some(stored) = self.stored() else {
            return Err(AuthFailure::NoCredential);
        };

        let res = match self
            .http
            .get(self.url(path))
            .query(query)
            .bearer_auth(&stored.session_token)
            .timeout(AUTHED_TIMEOUT)
            .send()
            .await
        {
            Ok(res) => res,
            Err(e) => return Err(AuthFailure::indeterminate(redact(&e.to_string()))),
        };

        let status = res.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(AuthFailure::Rejected);
        }
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
            return Err(AuthFailure::Indeterminate {
                retry_after: retry_after(res.headers()),
                reason: format!("{path} failed: {status}"),
            });
        }
        if !status.is_success() {
            return Err(AuthFailure::Denied);
        }
        Ok(res)
    }

    /// The write sibling of [`Self::authed_get`]: a bearer-authenticated POST
    /// carrying a JSON body, classified by the exact same rules. Split out for
    /// the same reason — the one place a credential's fate is decided lives once,
    /// not per endpoint. The body is never logged: it, and any error body coming
    /// back, are the places a token could plausibly be echoed.
    async fn authed_post(
        &self,
        path: &str,
        body: &impl Serialize,
    ) -> Authed<reqwest::Response> {
        let Some(stored) = self.stored() else {
            return Err(AuthFailure::NoCredential);
        };

        let res = match self
            .http
            .post(self.url(path))
            .bearer_auth(&stored.session_token)
            .json(body)
            .timeout(AUTHED_TIMEOUT)
            .send()
            .await
        {
            Ok(res) => res,
            Err(e) => return Err(AuthFailure::indeterminate(redact(&e.to_string()))),
        };

        let status = res.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(AuthFailure::Rejected);
        }
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
            return Err(AuthFailure::Indeterminate {
                retry_after: retry_after(res.headers()),
                reason: format!("{path} failed: {status}"),
            });
        }
        if !status.is_success() {
            return Err(AuthFailure::Denied);
        }
        Ok(res)
    }

    /// `POST /organization/create` — create an organisation server-side and link
    /// it to the local one that requested sync.
    ///
    /// The org creator becomes `admin` (API doc §6). On success the new org is
    /// pulled into the stored identity via [`Self::refresh_identity`] so the next
    /// snapshot carries it, and the new server id is returned — that id is the
    /// `remoteId` the frontend writes onto the local org.
    ///
    /// A `Denied` here is most likely a 400 duplicate slug (the server enforces a
    /// global unique index); the caller turns that into a user-facing message
    /// rather than a credential action. Only a 401 (`Rejected`) is ever about the
    /// credential.
    pub async fn create_org(&self, name: &str, slug: &str) -> Authed<CreatedOrg> {
        #[derive(Serialize)]
        struct CreateBody<'a> {
            name: &'a str,
            slug: &'a str,
        }

        let res = self
            .authed_post("/organization/create", &CreateBody { name, slug })
            .await?;
        let created: CreatedOrg = res
            .json()
            .await
            .map_err(|e| AuthFailure::indeterminate(format!("unreadable organisation: {e}")))?;

        // Fold the new org into the stored identity so the snapshot that follows
        // this call already lists it. Best-effort — its failure never undoes the
        // create, and the manual refresh / next launch reconciles regardless.
        self.refresh_identity(self.stored().and_then(|s| s.identity), None)
            .await;

        Ok(created)
    }

    /// `POST /organization/check-slug` — is this handle free? (API doc §6.2)
    ///
    /// A create-form probe, for typeahead. The auth worker normalises Better
    /// Auth's taken-slug `400` into a uniform `200 { "available": false }`, so
    /// any non-ok response here is a *real* failure (401 no session, 429 rate
    /// limit) and classifies as usual — a taken slug is NOT an error.
    ///
    /// **Advisory only.** The unique index on `organization.slug` is the real
    /// guard, so [`Self::create_org`] can still come back `Denied` on a race;
    /// callers must handle that rather than trusting a `true` here.
    pub async fn check_slug(&self, slug: &str) -> Authed<bool> {
        #[derive(Serialize)]
        struct SlugBody<'a> {
            slug: &'a str,
        }
        #[derive(Deserialize)]
        struct SlugResult {
            #[serde(default)]
            available: bool,
        }

        let res = self
            .authed_post("/organization/check-slug", &SlugBody { slug })
            .await?;
        let body: SlugResult = res
            .json()
            .await
            .map_err(|e| AuthFailure::indeterminate(format!("unreadable slug check: {e}")))?;
        Ok(body.available)
    }

    /// `POST /organization/delete` — delete an organisation server-side.
    ///
    /// Deleting is admin-only, so a non-admin member's call comes back `Denied`
    /// (403); the frontend removes the org locally regardless (the user's
    /// "delete locally anyway"). On success the stored list is refreshed so it
    /// drops the org and the next snapshot's add-only merge won't re-add it.
    ///
    /// As everywhere in this module, only a 401 (`Rejected`) is about the
    /// credential — a 403/404/offline delete never signs the user out.
    pub async fn delete_org(&self, remote_id: &str) -> Authed<()> {
        #[derive(Serialize)]
        struct DeleteBody<'a> {
            #[serde(rename = "organizationId")]
            organization_id: &'a str,
        }

        self.authed_post(
            "/organization/delete",
            &DeleteBody {
                organization_id: remote_id,
            },
        )
        .await?;

        // Drop it from the stored list so the follow-up snapshot + merge reflect
        // the deletion. Best-effort — the local purge happens regardless.
        self.refresh_identity(self.stored().and_then(|s| s.identity), None)
            .await;

        Ok(())
    }

    /// `GET /organization/get-full-organization` — the org's members (API §6).
    ///
    /// The server nests the account inside each membership (`{ id, role, user:
    /// { id, name, email } }`); that is flattened into [`OrgMember`] here rather
    /// than in the frontend, so the shape the UI renders is the shape it gets.
    /// The avatar URL is deliberately dropped — see [`OrgMember`].
    pub async fn list_members(&self, org_id: &str) -> Authed<Vec<OrgMember>> {
        #[derive(Deserialize)]
        struct FullOrg {
            #[serde(default)]
            members: Vec<RawMember>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct RawMember {
            id: String,
            #[serde(default)]
            role: Option<String>,
            #[serde(default)]
            created_at: Option<String>,
            #[serde(default)]
            user: Option<RawUser>,
        }
        #[derive(Deserialize)]
        struct RawUser {
            #[serde(default)]
            id: String,
            #[serde(default)]
            name: String,
            #[serde(default)]
            email: String,
            /// The remote photo URL. Never leaves Rust — it is resolved to a
            /// local cache path below.
            #[serde(default)]
            image: Option<String>,
        }

        let res = self
            .authed_get_query(
                "/organization/get-full-organization",
                &[("organizationId", org_id)],
            )
            .await?;
        let full: FullOrg = res
            .json()
            .await
            .map_err(|e| AuthFailure::indeterminate(format!("unreadable members: {e}")))?;

        // Resolve every photo to a local cache path. Bounded concurrency: a
        // cache hit is four `stat`s, but a cold 200-person org would otherwise
        // open 200 sockets at once. Failures are `None` and render as initials,
        // so a slow or dead avatar host costs a face, never the members list.
        use futures::StreamExt as _;
        let members = futures::stream::iter(full.members)
            .map(|m| async move {
                let user = m.user.unwrap_or(RawUser {
                    id: String::new(),
                    name: String::new(),
                    email: String::new(),
                    image: None,
                });
                let avatar_path =
                    avatar::resolve_member(&self.http, &self.dir, user.image.as_deref()).await;
                OrgMember {
                    id: m.id,
                    user_id: user.id,
                    name: user.name,
                    email: user.email,
                    // An unknown role string is `None`, never a guess: the row
                    // renders without a label rather than mislabelling someone's
                    // permissions. Same rule as `StoredOrg::role`.
                    role: m.role.as_deref().and_then(Role::from_claim),
                    created_at: m.created_at,
                    avatar_path,
                }
            })
            .buffered(8)
            .collect::<Vec<_>>()
            .await;

        Ok(members)
    }

    /// `GET /organization/list-invitations` — pending + past invites (API §6).
    ///
    /// Admin-scoped server-side, so a non-admin gets `Denied` and the caller
    /// shows an empty invitations tab rather than an error.
    pub async fn list_invitations(&self, org_id: &str) -> Authed<Vec<OrgInvitation>> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct RawInvite {
            id: String,
            #[serde(default)]
            email: String,
            #[serde(default)]
            role: Option<String>,
            #[serde(default)]
            status: Option<String>,
            #[serde(default)]
            expires_at: Option<String>,
        }

        let res = self
            .authed_get_query(
                "/organization/list-invitations",
                &[("organizationId", org_id)],
            )
            .await?;
        let raw: Vec<RawInvite> = res
            .json()
            .await
            .map_err(|e| AuthFailure::indeterminate(format!("unreadable invitations: {e}")))?;

        Ok(raw
            .into_iter()
            .map(|i| OrgInvitation {
                id: i.id,
                email: i.email,
                role: i.role.as_deref().and_then(Role::from_claim),
                status: i.status.unwrap_or_else(|| "pending".into()),
                expires_at: i.expires_at,
                // Only `/invite-member` mints an accept URL; a listed invite
                // carries none, and inventing one from the id would be a guess
                // at the web origin.
                accept_url: None,
            })
            .collect())
    }

    /// `POST /organization/invite-member` (API §6.1).
    ///
    /// Email delivery is deferred server-side, so the response's `acceptUrl` is
    /// the ONLY way the invitee ever learns of the invite — it must reach the
    /// UI to be shared out of band. Returning it is the point of this call.
    pub async fn invite_member(
        &self,
        org_id: &str,
        email: &str,
        role: Role,
    ) -> Authed<OrgInvitation> {
        #[derive(Serialize)]
        struct InviteBody<'a> {
            email: &'a str,
            role: Role,
            #[serde(rename = "organizationId")]
            organization_id: &'a str,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct RawInvite {
            id: String,
            #[serde(default)]
            email: String,
            #[serde(default)]
            role: Option<String>,
            #[serde(default)]
            status: Option<String>,
            #[serde(default)]
            expires_at: Option<String>,
            #[serde(default)]
            accept_url: Option<String>,
        }

        let res = self
            .authed_post(
                "/organization/invite-member",
                &InviteBody {
                    email,
                    role,
                    organization_id: org_id,
                },
            )
            .await?;
        let raw: RawInvite = res
            .json()
            .await
            .map_err(|e| AuthFailure::indeterminate(format!("unreadable invitation: {e}")))?;

        Ok(OrgInvitation {
            id: raw.id,
            email: if raw.email.is_empty() {
                email.to_string()
            } else {
                raw.email
            },
            role: raw.role.as_deref().and_then(Role::from_claim).or(Some(role)),
            status: raw.status.unwrap_or_else(|| "pending".into()),
            expires_at: raw.expires_at,
            accept_url: raw.accept_url,
        })
    }

    /// `POST /organization/cancel-invitation` — revoke a pending invite.
    pub async fn cancel_invitation(&self, invitation_id: &str) -> Authed<()> {
        #[derive(Serialize)]
        struct CancelBody<'a> {
            #[serde(rename = "invitationId")]
            invitation_id: &'a str,
        }

        self.authed_post(
            "/organization/cancel-invitation",
            &CancelBody { invitation_id },
        )
        .await?;
        Ok(())
    }

    /// `POST /organization/update-member-role` — change one member's role.
    ///
    /// Takes effect in the member's **next** minted token; tokens already issued
    /// stay valid until they expire (the 10-minute TTL bound,
    /// `docs/reference/atlas-ai-api.md` §12.2).
    pub async fn update_member_role(
        &self,
        org_id: &str,
        member_id: &str,
        role: Role,
    ) -> Authed<()> {
        #[derive(Serialize)]
        struct RoleBody<'a> {
            #[serde(rename = "memberId")]
            member_id: &'a str,
            role: Role,
            #[serde(rename = "organizationId")]
            organization_id: &'a str,
        }

        self.authed_post(
            "/organization/update-member-role",
            &RoleBody {
                member_id,
                role,
                organization_id: org_id,
            },
        )
        .await?;
        Ok(())
    }

    /// `POST /organization/remove-member` — remove someone from the org.
    ///
    /// The one member op that can change the CALLER's own org set (you may be
    /// removing yourself), so the stored identity is re-pulled afterwards the
    /// way `delete_org` does — otherwise the account menu keeps listing an org
    /// the user is no longer in. Best-effort; the removal already happened.
    pub async fn remove_member(&self, org_id: &str, member_id_or_email: &str) -> Authed<()> {
        #[derive(Serialize)]
        struct RemoveBody<'a> {
            #[serde(rename = "memberIdOrEmail")]
            member_id_or_email: &'a str,
            #[serde(rename = "organizationId")]
            organization_id: &'a str,
        }

        self.authed_post(
            "/organization/remove-member",
            &RemoveBody {
                member_id_or_email,
                organization_id: org_id,
            },
        )
        .await?;

        self.refresh_identity(self.stored().and_then(|s| s.identity), None)
            .await;

        Ok(())
    }

    /// Force a server re-pull of profile + organisations onto the stored
    /// credential, out of band from the launch path. Backs the manual "refresh"
    /// affordance; the caller broadcasts the resulting snapshot.
    pub async fn refresh(&self) {
        if self.stored().is_some() {
            self.refresh_identity(self.stored().and_then(|s| s.identity), None)
            .await;
        }
    }

    /// Mint a short-TTL access JWT from the stored session token.
    pub async fn mint_access_token(&self) -> Authed<String> {
        let res = self.authed_get("/token").await?;

        #[derive(Deserialize)]
        struct TokenResponse {
            token: String,
        }
        // A 200 we cannot read is not a verdict on the credential either — the
        // server answered, but not with anything that proves or disproves it.
        let body: TokenResponse = res
            .json()
            .await
            .map_err(|e| AuthFailure::indeterminate(format!("unreadable token: {e}")))?;
        Ok(body.token)
    }

    /// Check the stored credential against the server, once.
    ///
    /// The verdict is taken from `/token`, not from `/get-session`. Both answer
    /// for a dead session, but `/get-session` expresses it as **200 with a
    /// `null` body** (ATL-44) — a far weaker signal than a status code, and one
    /// an unrelated serialisation change could start emitting by accident. A
    /// misread here destroys a valid credential, so the reading that carries
    /// that power is the unambiguous one.
    pub async fn validate_once(&self) -> Validation {
        let Some(current) = self.stored() else {
            return Validation::NoCredential;
        };

        match self.mint_access_token().await {
            Ok(jwt) => {
                // Every successful validation refreshes the snapshot, so a name,
                // photo, or role changed on the web reaches the desktop without
                // a re-sign-in. It runs only after the credential is confirmed —
                // there is no point fetching a profile we may be about to
                // discard, and a failure here must never reach the credential.
                //
                // The JWT is handed on rather than dropped: it is the only
                // source of per-organisation roles, and this call already paid
                // for it.
                self.refresh_identity(current.identity, Some(jwt)).await;
                Validation::Confirmed
            }
            Err(AuthFailure::NoCredential) => Validation::NoCredential,
            // The one branch permitted to destroy a credential.
            Err(AuthFailure::Rejected) => {
                let _ = self.clear_session();
                Validation::Rejected
            }
            Err(AuthFailure::Denied) => Validation::Denied,
            Err(AuthFailure::Indeterminate { retry_after, .. }) => {
                // Deliberately touches nothing. The stored snapshot is what
                // renders a complete signed-in title bar on a plane.
                Validation::Indeterminate { retry_after }
            }
        }
    }

    /// Validate at launch and keep trying until the answer means something.
    ///
    /// Indeterminate failures retry on the backoff schedule with **no attempt
    /// limit**, for as long as this task lives: someone offline for six hours
    /// is signed in the moment they reconnect, without restarting Atlas.
    ///
    /// `on_settled` fires exactly once, with the resulting snapshot. Nothing is
    /// emitted between attempts — by design. The signed-in state has no
    /// "verifying" variant, because a spinner or a warning in the title bar
    /// every time a laptop lid opens only teaches people to ignore it.
    pub async fn revalidate(&self, on_settled: impl FnOnce(AuthSnapshot)) -> Validation {
        let mut backoff = Backoff::new(self.backoff_base, backoff::CEILING);

        loop {
            match self.validate_once().await {
                Validation::Indeterminate { retry_after } => {
                    tokio::time::sleep(backoff.next_after(retry_after)).await;
                }
                settled => {
                    on_settled(self.snapshot());
                    return settled;
                }
            }
        }
    }

    // ---- sign-out --------------------------------------------------------

    /// Sign out of this device. Touches nothing but local state, and cannot
    /// fail (ATL-50).
    ///
    /// The credential, the identity snapshot, and the cached photo all go
    /// first and unconditionally — no network call gates any of it, which is
    /// what makes signing out work with the wifi off. The returned ticket is
    /// the only way to reach [`Self::revoke`], and it is `None` when there was
    /// nothing stored: already signed out is a success with nothing to tell the
    /// server about.
    ///
    /// If the unlink itself somehow fails — a read-only config dir — nothing
    /// here pretends otherwise: [`Self::snapshot`] is derived from the file, so
    /// the state the caller broadcasts next is whatever is really on disk.
    ///
    /// One in-memory access token DOES exist elsewhere: #51 gave the native
    /// agent's connection a cache that serves the JWT until its own `exp`,
    /// and this function cannot reach it. The `auth_sign_out` command drops
    /// that connection alongside calling this (#62) — a future caller of
    /// `sign_out` from anywhere else must do the same, or the engine keeps
    /// making org-billed calls for up to ~9 minutes on a revoked account.
    /// (The JWT verifies statelessly against JWKS; revoking the session
    /// token does not invalidate it.)
    pub fn sign_out(&self) -> Option<RevocationTicket> {
        // Under the file lock as one unit, so a refresh finishing right now
        // cannot resurrect the credential between the read and the unlink.
        let _guard = self.file_guard();
        let stored = self.stored();
        // Before the credential, not after: the identity is where the path to
        // the cached photo is recorded, so clearing the file first would leave
        // a face on disk with nothing left pointing at it.
        if let Some(identity) = stored.as_ref().and_then(|s| s.identity.as_ref()) {
            avatar::discard(identity.avatar_path.as_deref());
        }
        let _ = store::clear(&self.dir);
        stored.map(|s| RevocationTicket(s.session_token))
    }

    /// Tell the server the session is over. Best-effort, fired **once**.
    ///
    /// Deliberately outside [`Self::authed_get`] and the retry policy it feeds:
    /// the credential arrives on the ticket because the store is already empty
    /// by the time this runs, and there is nothing left for a backoff schedule
    /// to protect. A failure costs a residual server session that expires on
    /// its own — which the user is told about, rather than retried at.
    ///
    /// `true` when the session is definitely gone server-side.
    pub async fn revoke(&self, ticket: RevocationTicket) -> bool {
        let res = self
            .http
            .post(self.url("/sign-out"))
            .bearer_auth(&ticket.0)
            .json(&serde_json::json!({}))
            .timeout(AUTHED_TIMEOUT)
            .send()
            .await;

        match res {
            // A 401 is the server saying it does not recognise this credential,
            // so there is no live session left to caveat. Every other refusal
            // is counted as a failure: we cannot tell whether it ended.
            Ok(res) => {
                res.status().is_success() || res.status() == reqwest::StatusCode::UNAUTHORIZED
            }
            Err(_) => false,
        }
    }
}

/// `Retry-After` as delta-seconds.
///
/// The HTTP-date form is not parsed: the auth worker sends seconds, and a date
/// read against a skewed local clock is worse than the backoff we already have
/// waiting behind it.
fn retry_after(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    let raw = headers.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?;
    Some(Duration::from_secs(raw.trim().parse().ok()?))
}

/// Strip anything that could carry a credential out of an error string before
/// it reaches a log or the UI. `reqwest` puts the request URL in its errors,
/// and a URL is the one place a token could plausibly appear.
fn redact(message: &str) -> String {
    match message.find(" for url") {
        Some(i) => message[..i].to_string(),
        None => message.to_string(),
    }
}

#[derive(Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    verification_uri_complete: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Deserialize)]
struct DeviceTokenSuccess {
    access_token: String,
}

/// `GET /get-session`.
#[derive(Deserialize)]
struct SessionResponse {
    /// `default` so a body without one still yields a profile. Expiry is
    /// deliberately still ignored — it is the server's business, and nothing
    /// here is improved by a second opinion on it.
    #[serde(default)]
    session: SessionMeta,
    user: Profile,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SessionMeta {
    /// Which organisation the user last made active, or `None` — which is the
    /// normal state for a device-granted session, since only the web ever calls
    /// `/organization/set-active`. [`active_org`] is what copes with that.
    #[serde(default)]
    active_organization_id: Option<String>,
}

/// One entry of `GET /organization/list`. Slug, logo, and timestamps are
/// deliberately not read: the menu renders a name, and ATL-36 owns the rest.
#[derive(Deserialize)]
struct OrgEntry {
    id: String,
    name: String,
}

/// The result of [`AuthCore::create_org`] — the server-issued id (which becomes
/// the local org's `remoteId`) and the name it was created under. Public because
/// it is the one org shape that crosses back out to a command; carries no token
/// or role, only what the frontend links against.
#[derive(Serialize, Deserialize)]
pub struct CreatedOrg {
    pub id: String,
    pub name: String,
}

/// One person in an organisation, as the members table renders them (ATL-36).
///
/// `id` is the **membership** id — what `/update-member-role` and
/// `/remove-member` address — while `user_id` identifies the human. They are
/// different ids and mixing them up is a 400, so both are carried explicitly.
///
/// Notice what is missing, for the same reason as [`AccountUser`](super::AccountUser):
/// the remote avatar URL. Handing it over would put an `<img src>` per row
/// requesting Google or GitHub on every open of this modal — exactly what the
/// avatar cache exists to avoid — so the photo arrives as a **local path** that
/// the asset protocol can serve, or `None` and the row renders initials.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OrgMember {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub email: String,
    /// `None` when the server named a role this build does not know. The row
    /// renders without a label rather than guessing at someone's permissions.
    pub role: Option<Role>,
    pub created_at: Option<String>,
    /// Absolute path to the cached photo, or `None` — no photo, or the fetch
    /// failed. Both render as initials; the UI draws no distinction.
    pub avatar_path: Option<String>,
}

/// A pending (or past) invitation to an organisation.
///
/// `accept_url` is present only on the response to `/invite-member`: email
/// delivery is deferred server-side, so that URL is the only way the invitee
/// ever hears about it and the inviter has to be able to copy it. Listing
/// invitations later does not re-issue one.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OrgInvitation {
    pub id: String,
    pub email: String,
    pub role: Option<Role>,
    pub status: String,
    pub expires_at: Option<String>,
    pub accept_url: Option<String>,
}

/// The `orgs` claim — `{ organisationId: role }` — off an access token.
///
/// **The signature is deliberately not verified.** We minted this token
/// ourselves, over TLS, from the issuer, seconds ago; JWKS verification exists
/// for parties receiving tokens from untrusted sources, and checking our own
/// proves nothing it did not already know. The claims are used only to label a
/// row in a menu — nothing here authorises anything (spec, "Deviations from the
/// API doc", §5.2).
///
/// `None` for a token that could not be read at all — the same "we learned
/// nothing" the rest of the module turns on, kept distinct from `Some({})`,
/// which is the server genuinely placing the user in no organisation (API doc
/// §5.1: "`orgs` is `{}` until the user belongs to an Organisation"). Only the
/// caller can tell what to do with the difference, and it does: an unread claim
/// keeps the roles already known, an empty one clears them.
///
/// Never an error, and never a reason to doubt the credential — nothing here
/// authorises anything.
fn org_roles(jwt: &str) -> Option<HashMap<String, Role>> {
    use base64::Engine;

    #[derive(Deserialize)]
    struct Claims {
        #[serde(default)]
        orgs: HashMap<String, String>,
    }

    let payload = jwt.split('.').nth(1)?;
    // JWTs are base64**url** with the padding stripped, which the standard
    // alphabet decodes into garbage rather than rejecting.
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let claims = serde_json::from_slice::<Claims>(&bytes).ok()?;

    Some(
        claims
            .orgs
            .into_iter()
            // A role this build does not know is dropped, leaving its
            // organisation role-less rather than absent.
            .filter_map(|(id, role)| Role::from_claim(&role).map(|role| (id, role)))
            .collect(),
    )
}

#[derive(Deserialize)]
struct Profile {
    id: String,
    name: String,
    email: String,
    /// The provider photo URL. Absent for a user who set none.
    image: Option<String>,
}

#[derive(Deserialize)]
struct DeviceTokenError {
    error: String,
}
