//! The D10 token provider: an Atlas access JWT, minted per request.
//!
//! The engine's `ExternalAuth` trait is the injection point. What it buys, from
//! machinery the engine already ships, is exactly the three things the gateway's
//! auth contract demands (`docs/reference/atlas-ai-api.md` §12.2):
//!
//! - **per-request auth resolution** — `resolve()` runs on every request, so a
//!   token is never baked in at construction time;
//! - **proactive re-mint** — this type re-mints at `exp − 60s` rather than
//!   waiting for a failure;
//! - **401 refresh-once-then-retry** — `refresh()` is what the engine calls on
//!   an `Unauthorized`, and it forces a fresh mint.
//!
//! **Why not the static-bearer path.** The engine can take a fixed API key, and
//! for a provider key that is correct — those do not expire on a ten-minute
//! clock. For the gateway token it would be a bug: a static bearer has no
//! refresh and no 401 recovery, so every session would die at the TTL. The
//! distinction is D10's, and it is the reason this file exists.
//!
//! **What this does not have to defend against.** §3.1 of the gateway doc:
//! *"Auth is an admission decision. It is verified once at request start and
//! never re-checked mid-stream."* A token expiring mid-turn does not truncate
//! the in-flight request — the *next* request is the one that fails. So the
//! shape being defended against is a stalled second turn, not a broken first
//! one, and a re-mint that costs a round trip is affordable.

use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use codex_login::CodexAuth;
use codex_login::ExternalAuthFuture;
use codex_login::auth::ExternalAuth;
use codex_login::auth::ExternalAuthRefreshContext;

/// How long before a token's own expiry we stop trusting it.
///
/// The gateway's desktop checklist says re-mint at T−60s, so this is its
/// number, not a guess.
const REMINT_MARGIN: Duration = Duration::from_secs(60);

/// The fallback lifetime for a token whose `exp` we could not read.
///
/// The documented TTL is 10 minutes. It is the fallback rather than the rule
/// because the token states its own expiry and a served token is more
/// authoritative than a document about it.
const ASSUMED_TTL: Duration = Duration::from_secs(600);

/// Mints an Atlas access JWT.
///
/// Implemented by `src-tauri` over `AuthCore::mint_access_token`. It is a trait
/// rather than a closure so a test can drive expiry and count calls, and so
/// this crate does not depend on the auth module.
pub trait AtlasTokenSource: Send + Sync {
    fn mint(&self) -> ExternalAuthFuture<'_, String>;
}

/// Wall clock, injectable so the expiry logic is testable without sleeping.
pub trait Clock: Send + Sync {
    fn now_unix(&self) -> u64;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now_unix(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    }
}

#[derive(Clone)]
struct CachedToken {
    token: String,
    /// Unix seconds after which this token must not be reused.
    ///
    /// Already has the 60-second margin subtracted, so the comparison at the
    /// use site is a plain `now < renew_after`.
    renew_after: u64,
}

/// Reads `exp` out of a JWT payload.
///
/// JWTs are base64**url** with padding stripped; the standard alphabet decodes
/// that into garbage rather than rejecting it, which is why the alphabet is
/// spelled out. A token we cannot read is not an error — it just falls back to
/// the assumed TTL, because failing to parse a claim is no reason to refuse a
/// credential the server issued.
fn jwt_exp(token: &str) -> Option<u64> {
    use base64::Engine;

    #[derive(serde::Deserialize)]
    struct Claims {
        exp: Option<u64>,
    }

    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    serde_json::from_slice::<Claims>(&bytes).ok()?.exp
}

/// An `ExternalAuth` that hands the engine a current Atlas access JWT.
///
/// The token is presented to the engine as a bearer credential
/// (`CodexAuth::from_api_key`), which is the shape the gateway wants on the
/// wire. That is *not* the static-bearer path D10 forbids: the value is rebuilt
/// from the cache on every `resolve()`, so the engine never holds a token past
/// its life.
pub struct AtlasExternalAuth {
    source: Arc<dyn AtlasTokenSource>,
    clock: Arc<dyn Clock>,
    cached: Mutex<Option<CachedToken>>,
}

impl AtlasExternalAuth {
    pub fn new(source: Arc<dyn AtlasTokenSource>) -> Self {
        Self::with_clock(source, Arc::new(SystemClock))
    }

    pub fn with_clock(source: Arc<dyn AtlasTokenSource>, clock: Arc<dyn Clock>) -> Self {
        Self {
            source,
            clock,
            cached: Mutex::new(None),
        }
    }

    fn cached_if_fresh(&self) -> Option<String> {
        let now = self.clock.now_unix();
        let cached = self.cached.lock().unwrap_or_else(|p| p.into_inner());
        cached
            .as_ref()
            .filter(|c| now < c.renew_after)
            .map(|c| c.token.clone())
    }

    /// Mints, caches, and returns a token, ignoring whatever was cached.
    async fn mint_fresh(&self) -> std::io::Result<String> {
        let token = self.source.mint().await?;
        let now = self.clock.now_unix();
        // A token whose `exp` is already inside the margin would cache as
        // permanently stale and re-mint on every single request. Treat it as
        // good for one margin's worth rather than melting down.
        let renew_after = match jwt_exp(&token) {
            Some(exp) => exp.saturating_sub(REMINT_MARGIN.as_secs()).max(now + 1),
            None => now + ASSUMED_TTL.as_secs() - REMINT_MARGIN.as_secs(),
        };
        *self.cached.lock().unwrap_or_else(|p| p.into_inner()) = Some(CachedToken {
            token: token.clone(),
            renew_after,
        });
        Ok(token)
    }

    async fn current(&self) -> std::io::Result<String> {
        match self.cached_if_fresh() {
            Some(token) => Ok(token),
            None => self.mint_fresh().await,
        }
    }
}

impl ExternalAuth for AtlasExternalAuth {
    fn resolve(&self) -> ExternalAuthFuture<'_, CodexAuth> {
        Box::pin(async move { Ok(CodexAuth::from_api_key(&self.current().await?)) })
    }

    /// The engine calls this on a 401. Always mints — the cached token is the
    /// one that just got rejected, so trusting it here is what would turn
    /// refresh-once into a loop.
    fn refresh(&self, _context: ExternalAuthRefreshContext) -> ExternalAuthFuture<'_, CodexAuth> {
        Box::pin(async move { Ok(CodexAuth::from_api_key(&self.mint_fresh().await?)) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_login::auth::ExternalAuthRefreshReason;
    use std::sync::atomic::AtomicU64;
    use std::sync::atomic::Ordering;

    /// Issues `token-1`, `token-2`, … each expiring `ttl` after `issued_at`.
    struct CountingSource {
        calls: AtomicU64,
        issued_at: Arc<AtomicU64>,
        ttl: u64,
    }

    impl CountingSource {
        fn new(issued_at: Arc<AtomicU64>, ttl: u64) -> Arc<Self> {
            Arc::new(Self {
                calls: AtomicU64::new(0),
                issued_at,
                ttl,
            })
        }

        fn calls(&self) -> u64 {
            self.calls.load(Ordering::SeqCst)
        }
    }

    /// A JWT with a real base64url payload — the decoder must actually work,
    /// not be bypassed by a fixture that parses as anything.
    fn jwt_with_exp(exp: u64) -> String {
        use base64::Engine;
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(format!(r#"{{"exp":{exp},"aud":"atlas"}}"#));
        format!("header.{payload}.signature")
    }

    impl AtlasTokenSource for CountingSource {
        fn mint(&self) -> ExternalAuthFuture<'_, String> {
            Box::pin(async move {
                let n = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
                let exp = self.issued_at.load(Ordering::SeqCst) + self.ttl;
                Ok(format!("{}#{n}", jwt_with_exp(exp)))
            })
        }
    }

    struct TestClock(Arc<AtomicU64>);

    impl Clock for TestClock {
        fn now_unix(&self) -> u64 {
            self.0.load(Ordering::SeqCst)
        }
    }

    fn harness(ttl: u64) -> (AtlasExternalAuth, Arc<CountingSource>, Arc<AtomicU64>) {
        let now = Arc::new(AtomicU64::new(1_000_000));
        let source = CountingSource::new(now.clone(), ttl);
        let auth = AtlasExternalAuth::with_clock(
            source.clone() as Arc<dyn AtlasTokenSource>,
            Arc::new(TestClock(now.clone())),
        );
        (auth, source, now)
    }

    fn bearer(auth: &CodexAuth) -> String {
        auth.api_key()
            .expect("the provider must be handed a bearer credential")
            .to_string()
    }

    #[tokio::test]
    async fn reads_the_expiry_from_the_token_rather_than_assuming_the_documented_ttl() {
        // The documented TTL is 600s. This token says 100s, and the token wins:
        // at t+90 it is inside the 60s margin and must have been re-minted.
        let (auth, source, now) = harness(100);
        auth.resolve().await.expect("first resolve");
        assert_eq!(source.calls(), 1);

        now.fetch_add(30, Ordering::SeqCst);
        auth.resolve().await.expect("still fresh");
        assert_eq!(source.calls(), 1, "a token 30s into a 100s life is reusable");

        now.fetch_add(60, Ordering::SeqCst);
        auth.resolve().await.expect("past the margin");
        assert_eq!(
            source.calls(),
            2,
            "at 90s of a 100s token the 60s margin has been crossed",
        );
    }

    #[tokio::test]
    async fn caches_across_requests_instead_of_minting_per_call() {
        // The regression this pins: mint-fresh-per-use is right for a
        // point-of-use caller and wrong here, where a long turn would mint on
        // every request the engine makes.
        let (auth, source, _now) = harness(600);
        for _ in 0..5 {
            auth.resolve().await.expect("resolve");
        }
        assert_eq!(source.calls(), 1);
    }

    #[tokio::test]
    async fn re_mints_at_the_sixty_second_margin_not_at_expiry() {
        let (auth, source, now) = harness(600);
        auth.resolve().await.expect("first");

        now.fetch_add(539, Ordering::SeqCst);
        auth.resolve().await.expect("one second before the margin");
        assert_eq!(source.calls(), 1);

        now.fetch_add(1, Ordering::SeqCst);
        auth.resolve().await.expect("at the margin");
        assert_eq!(
            source.calls(),
            2,
            "T-60s is the re-mint point, not T-0 — waiting for expiry is what \
             leaves a request holding a dead token",
        );
    }

    #[tokio::test]
    async fn refresh_ignores_the_cache_so_a_401_cannot_loop() {
        // The 401 path. Returning the cached token here would re-present the
        // credential the gateway just rejected, turning refresh-once into a
        // retry loop against a wall.
        let (auth, source, _now) = harness(600);
        let first = bearer(&auth.resolve().await.expect("first"));
        assert_eq!(source.calls(), 1);

        let refreshed = bearer(
            &auth
                .refresh(ExternalAuthRefreshContext {
                    reason: ExternalAuthRefreshReason::Unauthorized,
                    previous_account_id: None,
                })
                .await
                .expect("refresh"),
        );
        assert_eq!(source.calls(), 2);
        assert_ne!(first, refreshed, "refresh must produce a different token");

        // And the refreshed token is what subsequent resolves see.
        assert_eq!(bearer(&auth.resolve().await.expect("after refresh")), refreshed);
        assert_eq!(source.calls(), 2);
    }

    #[tokio::test]
    async fn an_unreadable_token_falls_back_to_the_documented_ttl() {
        struct Opaque;
        impl AtlasTokenSource for Opaque {
            fn mint(&self) -> ExternalAuthFuture<'_, String> {
                Box::pin(async { Ok("not-a-jwt".to_string()) })
            }
        }
        let now = Arc::new(AtomicU64::new(1_000_000));
        let auth = AtlasExternalAuth::with_clock(
            Arc::new(Opaque),
            Arc::new(TestClock(now.clone())),
        );

        assert_eq!(bearer(&auth.resolve().await.expect("resolve")), "not-a-jwt");
        now.fetch_add(539, Ordering::SeqCst);
        auth.resolve().await.expect("inside the assumed ttl");
        now.fetch_add(1, Ordering::SeqCst);
        auth.resolve().await.expect("past it");
        // Not an error, just a shorter trust window: 600 - 60.
    }

    #[tokio::test]
    async fn an_already_expired_token_is_used_once_rather_than_re_minted_forever() {
        // A clock skew or a very short-lived token could put `exp` behind the
        // margin on arrival. Caching it as stale would mint on every request.
        let (auth, source, _now) = harness(10);
        auth.resolve().await.expect("first");
        auth.resolve().await.expect("second");
        assert_eq!(
            source.calls(),
            1,
            "a token that arrives inside the margin still gets one use",
        );
    }

    #[test]
    fn jwt_exp_rejects_standard_base64_masquerading_as_base64url() {
        // `-` and `_` are the url alphabet; the standard alphabet would decode
        // this to garbage rather than failing, which is the bug this guards.
        assert_eq!(jwt_exp(&jwt_with_exp(1_234_567_890)), Some(1_234_567_890));
        assert_eq!(jwt_exp("no-dots"), None);
        assert_eq!(jwt_exp("a.!!!not-base64!!!.c"), None);
    }
}
