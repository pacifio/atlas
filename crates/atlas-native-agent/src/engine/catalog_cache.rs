//! The gateway's model catalogue, fetched and cached (ADR-0007).
//!
//! Nothing about which models Atlas Agent may use is written down in this
//! repo. The list is the gateway's — `GET /v1/catalogue` — and the only thing
//! kept locally is a copy of the gateway's last answer, in the engine's home,
//! so that a launch with no network still has a picker and a working agent.
//!
//! # The three sources, in order
//!
//! 1. **A fresh cache** (under [`CACHE_TTL`] old, fetched for the same org) is
//!    used as-is. No request goes out.
//! 2. **The gateway**, with a short timeout. A good answer overwrites the cache.
//! 3. **A stale cache** — any age, same org — when the fetch fails. The agent
//!    runs on the list it last saw; the picker is marked stale.
//!
//! With no cache and no gateway there is no list, and [`resolve`] says so with
//! [`CatalogueUnavailable`]. That is a deliberate refusal rather than a
//! fallback to a list authored here: an authored list drifts from what the
//! gateway serves, and the previous one had — it named a default the gateway
//! had since re-priced and excluded models by hand.
//!
//! # What is cached
//!
//! The gateway's rows, not the engine's records. The engine's `ModelInfo` has
//! forty-odd fields and every one of them is a projection decision made in
//! this crate (what the wire can carry, which prompt to use). Caching the
//! projection would freeze those decisions into every user's cache file; the
//! rows are what the gateway said, and [`project`] can change under them.
//!
//! # Org
//!
//! `entitled` is answered for the organisation named in the `Atlas-Org`
//! header, so a cache carries the org it was fetched for and is a miss for any
//! other. A user switching orgs must not be offered the previous org's models.
//!
//! # Metadata the gateway does not send yet
//!
//! Display name, description and context window are requested from the
//! gateway (`docs/requests/gateway-catalogue-metadata.md`) and read here when
//! present. Until they land: the name is the slug, there is no description,
//! and — the one that matters — there is no context window, so the engine's
//! auto-compaction is off for that row and the gateway's own `413` is the
//! ceiling. Accepted, and temporary.

use std::collections::hash_map::DefaultHasher;
use std::hash::Hash;
use std::hash::Hasher;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use anyhow::Result;
use atlas_acp_thread::AgentModelId;
use atlas_acp_thread::AgentModelInfo;
use codex_protocol::openai_models::ModelsResponse;
use futures::future::BoxFuture;
use futures::FutureExt;
use serde::Deserialize;
use serde::Serialize;

use crate::engine::auth::AtlasTokenSource;
use crate::engine::auth::Clock;

/// The cache file, inside the engine's home.
pub const CACHE_FILE: &str = "catalogue-cache.json";

/// How long a cached answer is trusted without asking again.
pub const CACHE_TTL: Duration = Duration::from_secs(60 * 60);

/// How long a fetch may take before the cache wins.
///
/// The engine's own `/models` refresh uses five seconds; a connect that waits
/// longer than that on a list it probably already has is a connect the user
/// experiences as a hang.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(5);

const CACHE_VERSION: u32 = 1;

/// One row of `GET /v1/catalogue`, as the gateway sends it.
///
/// Every field but `id` is defaulted so the gateway may add or drop fields
/// without invalidating a cache or breaking a launch. The three metadata
/// fields are the ones requested from the gateway team; they are optional
/// here precisely so they can ship incrementally.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GatewayRow {
    pub id: String,
    #[serde(default)]
    pub publisher: Option<String>,
    #[serde(default)]
    pub entitled: bool,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub context_window: Option<i64>,
}

/// The gateway's whole answer.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct GatewayCatalogue {
    #[serde(default, rename = "hasGrant")]
    pub has_grant: bool,
    #[serde(default, rename = "data")]
    pub rows: Vec<GatewayRow>,
}

/// What is on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogueCache {
    pub version: u32,
    /// Unix seconds.
    pub fetched_at: u64,
    /// The `Atlas-Org` the rows are entitled for. `None` is personal.
    pub org: Option<String>,
    pub has_grant: bool,
    pub rows: Vec<GatewayRow>,
}

impl CatalogueCache {
    pub fn new(catalogue: GatewayCatalogue, org: Option<String>, fetched_at: u64) -> Self {
        Self {
            version: CACHE_VERSION,
            fetched_at,
            org,
            has_grant: catalogue.has_grant,
            rows: catalogue.rows,
        }
    }
}

/// Why a fetch did not produce a catalogue.
///
/// The `Display` strings are chosen so the host's message classifier reads
/// them right: the two credential cases say "unauthorized" / "not
/// authenticated" and route to sign-in; the rest do not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    /// No token could be minted — signed out, or the auth service refused.
    NoToken(String),
    /// The gateway refused the token.
    Unauthorized(String),
    /// Any other status.
    Http { status: u16, body: String },
    /// The request never completed.
    Transport(String),
    /// The reply did not parse.
    Shape(String),
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoToken(why) => write!(f, "not authenticated: {why}"),
            Self::Unauthorized(_) => write!(f, "the gateway rejected the account token (unauthorized)"),
            Self::Http { status, .. } => write!(f, "the gateway answered HTTP {status}"),
            Self::Transport(why) => write!(f, "could not reach the gateway: {why}"),
            Self::Shape(why) => write!(f, "the gateway's catalogue did not parse: {why}"),
        }
    }
}

impl std::error::Error for FetchError {}

/// Fetches the catalogue. One implementation talks to the gateway; tests
/// supply their own.
pub trait CatalogueFetcher: Send + Sync {
    fn fetch(&self) -> BoxFuture<'_, std::result::Result<GatewayCatalogue, FetchError>>;
    /// The organisation the fetch is made for — the cache key.
    fn org(&self) -> Option<String>;
}

/// Where the org header comes from.
pub type OrgSource = Arc<dyn Fn() -> Option<String> + Send + Sync>;

/// The real thing: `GET {base_url}/catalogue` with the account token.
pub struct GatewayCatalogueFetcher {
    base_url: String,
    /// `None` resolves the host-registered source at fetch time — the same
    /// lazy lookup the token provider does, and for the same reason: the host
    /// is built before the auth state exists.
    token: Option<Arc<dyn AtlasTokenSource>>,
    org: OrgSource,
}

impl GatewayCatalogueFetcher {
    pub fn new(base_url: impl Into<String>, token: Arc<dyn AtlasTokenSource>, org: OrgSource) -> Self {
        Self {
            base_url: base_url.into(),
            token: Some(token),
            org,
        }
    }

    /// The fetcher the app uses: the registered token source and the
    /// registered org source, both read when a fetch happens.
    pub fn registered(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            token: None,
            org: Arc::new(codex_api::atlas_chat::org::current_org),
        }
    }

    fn token_source(&self) -> Option<Arc<dyn AtlasTokenSource>> {
        self.token
            .clone()
            .or_else(crate::engine::auth::registered_token_source)
    }
}

impl CatalogueFetcher for GatewayCatalogueFetcher {
    fn fetch(&self) -> BoxFuture<'_, std::result::Result<GatewayCatalogue, FetchError>> {
        async move {
            let Some(source) = self.token_source() else {
                return Err(FetchError::NoToken("no account token source".to_string()));
            };
            let token = source
                .mint()
                .await
                .map_err(|e| FetchError::NoToken(e.to_string()))?;
            let client = reqwest::Client::builder()
                .timeout(FETCH_TIMEOUT)
                .build()
                .map_err(|e| FetchError::Transport(e.to_string()))?;
            let url = format!("{}/catalogue", self.base_url.trim_end_matches('/'));
            let mut request = client.get(url).bearer_auth(token);
            if let Some(org) = (self.org)() {
                request = request.header("atlas-org", org);
            }
            let response = request
                .send()
                .await
                .map_err(|e| FetchError::Transport(e.to_string()))?;
            let status = response.status().as_u16();
            let body = response
                .text()
                .await
                .map_err(|e| FetchError::Transport(e.to_string()))?;
            match status {
                200 => serde_json::from_str::<GatewayCatalogue>(&body)
                    .map_err(|e| FetchError::Shape(e.to_string())),
                401 => Err(FetchError::Unauthorized(body)),
                status => Err(FetchError::Http { status, body }),
            }
        }
        .boxed()
    }

    fn org(&self) -> Option<String> {
        (self.org)()
    }
}

// ── The cache on disk ────────────────────────────────────────────────────────

fn cache_path(home: &Path) -> PathBuf {
    home.join(CACHE_FILE)
}

/// The cache, or `None` when there is none worth the name.
///
/// Missing, unreadable, unparseable and wrong-version all mean the same
/// thing here — "start as if never fetched" — exactly as the registry store
/// treats its own cache. A corrupt file is logged, never propagated: it is
/// not the user's fault and refusing to start over it would help nobody.
pub async fn load_cache(home: &Path) -> Option<CatalogueCache> {
    let path = cache_path(home);
    let bytes = tokio::fs::read(&path).await.ok()?;
    match serde_json::from_slice::<CatalogueCache>(&bytes) {
        Ok(cache) if cache.version == CACHE_VERSION => Some(cache),
        Ok(cache) => {
            tracing::warn!(
                version = cache.version,
                "ignoring a model catalogue cache written by another version",
            );
            None
        }
        Err(err) => {
            tracing::warn!(path = %path.display(), %err, "ignoring an unreadable model catalogue cache");
            None
        }
    }
}

/// Writes the cache atomically: a sibling temp file, then a rename.
///
/// A launch that dies mid-write must not leave a half file for the next
/// launch to trip on; `load_cache` would treat it as absent, which is
/// survivable, but a stale-but-whole cache is strictly better than none.
pub async fn write_cache(home: &Path, cache: &CatalogueCache) -> Result<()> {
    tokio::fs::create_dir_all(home)
        .await
        .with_context(|| format!("creating the engine home at {}", home.display()))?;
    let path = cache_path(home);
    let tmp = home.join(format!("{CACHE_FILE}.{}.tmp", std::process::id()));
    let body = serde_json::to_vec_pretty(cache).context("serialising the model catalogue cache")?;
    tokio::fs::write(&tmp, body)
        .await
        .with_context(|| format!("writing {}", tmp.display()))?;
    tokio::fs::rename(&tmp, &path)
        .await
        .with_context(|| format!("moving the model catalogue cache into place at {}", path.display()))?;
    Ok(())
}

/// A cache is fresh when it is young enough AND was fetched for this org.
pub fn is_fresh(cache: &CatalogueCache, org: Option<&str>, now: u64) -> bool {
    cache.org.as_deref() == org && now.saturating_sub(cache.fetched_at) < CACHE_TTL.as_secs()
}

/// Where the catalogue came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolved {
    /// The cache was young enough; no request was made.
    Fresh(CatalogueCache),
    /// The gateway answered and the cache was rewritten.
    Fetched(CatalogueCache),
    /// The gateway did not answer and an older cache carried the connection.
    Stale { cache: CatalogueCache, error: FetchError },
}

impl Resolved {
    pub fn cache(&self) -> &CatalogueCache {
        match self {
            Self::Fresh(cache) | Self::Fetched(cache) => cache,
            Self::Stale { cache, .. } => cache,
        }
    }

    pub fn into_cache(self) -> CatalogueCache {
        match self {
            Self::Fresh(cache) | Self::Fetched(cache) => cache,
            Self::Stale { cache, .. } => cache,
        }
    }

    pub fn is_stale(&self) -> bool {
        matches!(self, Self::Stale { .. })
    }
}

/// No catalogue from anywhere.
///
/// The `Display` is the sentence the user sees: it goes through the host's
/// error path unchanged. The underlying fetch error is kept as the source so
/// the classifier — which reads the whole chain — can still route a
/// credential failure to sign-in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogueUnavailable {
    pub error: Option<FetchError>,
}

impl CatalogueUnavailable {
    /// The gateway answered, and nothing in the answer is entitled.
    pub fn no_entitled_models() -> Self {
        Self { error: None }
    }
}

impl std::fmt::Display for CatalogueUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.error {
            Some(error) => write!(
                f,
                "Atlas Agent can't load its model list ({error}). Check your connection and try again."
            ),
            None => f.write_str(
                "Atlas Agent has no models to offer: the gateway lists none this organisation may use.",
            ),
        }
    }
}

impl std::error::Error for CatalogueUnavailable {}

/// The catalogue for a connect: fresh cache, else gateway, else stale cache.
///
/// `force` skips the freshness check (the manual refresh) but keeps the
/// stale fallback — a refresh that fails must not take the list away.
pub async fn resolve(
    home: &Path,
    fetcher: &dyn CatalogueFetcher,
    clock: &dyn Clock,
    force: bool,
) -> std::result::Result<Resolved, CatalogueUnavailable> {
    let org = fetcher.org();
    let cached = load_cache(home).await;
    if !force {
        if let Some(cache) = cached.as_ref() {
            if is_fresh(cache, org.as_deref(), clock.now_unix()) {
                return Ok(Resolved::Fresh(cache.clone()));
            }
        }
    }
    match fetcher.fetch().await {
        Ok(catalogue) => {
            let cache = CatalogueCache::new(catalogue, org, clock.now_unix());
            if let Err(err) = write_cache(home, &cache).await {
                // Not fatal: the list is in hand and the next launch will
                // fetch again. Say so, because a cache that never writes is
                // a launch that always waits on the network.
                tracing::warn!(%err, "the model catalogue could not be cached");
            }
            Ok(Resolved::Fetched(cache))
        }
        Err(error) => {
            // Same org only. The previous org's list is not a fallback for
            // this one — it is a list of models this org may not be allowed
            // to run.
            match cached.filter(|cache| cache.org == org) {
                Some(cache) => {
                    tracing::warn!(%error, age_secs = clock.now_unix().saturating_sub(cache.fetched_at), "using the cached model catalogue");
                    Ok(Resolved::Stale { cache, error })
                }
                None => Err(CatalogueUnavailable { error: Some(error) }),
            }
        }
    }
}

/// The manual refresh: ask the gateway now, and rewrite the cache.
///
/// Unlike [`resolve`] this does not fall back — the caller wants to know
/// whether the gateway answered, and still has whatever the connection is
/// running on.
pub async fn refresh_now(
    home: &Path,
    fetcher: &dyn CatalogueFetcher,
    clock: &dyn Clock,
) -> std::result::Result<CatalogueCache, FetchError> {
    let org = fetcher.org();
    let catalogue = fetcher.fetch().await?;
    let cache = CatalogueCache::new(catalogue, org, clock.now_unix());
    if let Err(err) = write_cache(home, &cache).await {
        tracing::warn!(%err, "the refreshed model catalogue could not be cached");
    }
    Ok(cache)
}

// ── Projection ──────────────────────────────────────────────────────────────

/// The catalogue as the engine and the picker each need it.
#[derive(Debug, Clone)]
pub struct ProjectedCatalogue {
    /// What `models.json` holds.
    pub response: ModelsResponse,
    /// What the composer lists.
    pub picker: Vec<AgentModelInfo>,
    /// The first entitled row: what a session runs on before any pick.
    pub default_model: String,
    /// The identity that matters to the engine — slugs and context windows,
    /// in order. Names and descriptions are not in it: a change to those
    /// swaps into a live connection; a change to this needs a reconnect.
    pub fingerprint: u64,
}

/// The entitled rows, in the gateway's order, as engine records.
///
/// `None` when nothing is entitled — a list with no rows is not a catalogue,
/// and the engine refuses to load an empty one anyway.
pub fn project(cache: &CatalogueCache) -> Option<ProjectedCatalogue> {
    let entitled: Vec<&GatewayRow> = cache.rows.iter().filter(|row| row.entitled).collect();
    let first = entitled.first()?;

    let rows: Vec<serde_json::Value> = entitled
        .iter()
        .enumerate()
        .map(|(index, row)| {
            crate::engine::catalog::row(
                &row.id,
                row.display_name.as_deref().unwrap_or(&row.id),
                row.description.as_deref(),
                row.context_window,
                index as i32 + 1,
            )
        })
        .collect();
    let response: ModelsResponse = match serde_json::from_value(serde_json::json!({ "models": rows })) {
        Ok(response) => response,
        Err(err) => {
            // The row builder and the engine's record are both in this
            // workspace and covered by tests, so this is a build-time
            // impossibility — but an empty picker beats a panic.
            tracing::error!(%err, "the projected model catalogue does not parse as the engine's record");
            return None;
        }
    };

    let picker = entitled
        .iter()
        .map(|row| AgentModelInfo {
            id: AgentModelId::new(row.id.as_str()),
            name: row.display_name.as_deref().unwrap_or(&row.id).into(),
            description: row.description.as_deref().map(Into::into),
            icon: None,
            is_latest: false,
            // Deliberately blank. The BYOK picker shows per-million provider
            // rates, which are not what an Atlas turn costs — a turn is
            // metered against the account's own weighted cap.
            cost: None,
            disabled: None,
        })
        .collect();

    Some(ProjectedCatalogue {
        response,
        picker,
        default_model: first.id.clone(),
        fingerprint: fingerprint(entitled.iter().map(|row| (row.id.as_str(), row.context_window))),
    })
}

fn fingerprint<'a>(rows: impl Iterator<Item = (&'a str, Option<i64>)>) -> u64 {
    let mut hasher = DefaultHasher::new();
    for (slug, window) in rows {
        slug.hash(&mut hasher);
        window.hash(&mut hasher);
    }
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct FakeClock(u64);
    impl Clock for FakeClock {
        fn now_unix(&self) -> u64 {
            self.0
        }
    }

    /// Scripted answers, counted.
    struct FakeFetcher {
        org: Option<String>,
        answer: Mutex<std::result::Result<GatewayCatalogue, FetchError>>,
        calls: std::sync::atomic::AtomicUsize,
    }

    impl FakeFetcher {
        fn ok(rows: Vec<GatewayRow>) -> Self {
            Self::with(Ok(GatewayCatalogue { has_grant: true, rows }))
        }
        fn failing(error: FetchError) -> Self {
            Self::with(Err(error))
        }
        fn with(answer: std::result::Result<GatewayCatalogue, FetchError>) -> Self {
            Self {
                org: None,
                answer: Mutex::new(answer),
                calls: std::sync::atomic::AtomicUsize::new(0),
            }
        }
        fn for_org(mut self, org: &str) -> Self {
            self.org = Some(org.to_string());
            self
        }
        fn calls(&self) -> usize {
            self.calls.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl CatalogueFetcher for FakeFetcher {
        fn fetch(&self) -> BoxFuture<'_, std::result::Result<GatewayCatalogue, FetchError>> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let answer = self
                .answer
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone();
            async move { answer }.boxed()
        }
        fn org(&self) -> Option<String> {
            self.org.clone()
        }
    }

    fn row(id: &str, entitled: bool) -> GatewayRow {
        GatewayRow {
            id: id.to_string(),
            publisher: Some("anthropic".to_string()),
            entitled,
            display_name: None,
            description: None,
            context_window: None,
        }
    }

    fn cache_with(rows: Vec<GatewayRow>, org: Option<&str>, fetched_at: u64) -> CatalogueCache {
        CatalogueCache::new(
            GatewayCatalogue {
                has_grant: true,
                rows,
            },
            org.map(str::to_string),
            fetched_at,
        )
    }

    fn tempdir() -> tempfile::TempDir {
        match tempfile::tempdir() {
            Ok(dir) => dir,
            Err(err) => panic!("tempdir: {err}"),
        }
    }

    // ── the wire ────────────────────────────────────────────────────────

    #[test]
    fn the_gateways_answer_parses_with_only_the_fields_it_sends_today() {
        // Exactly the shape in docs/reference/atlas-ai-api.md §6a. The
        // metadata fields are absent and that must be fine.
        let body = r#"{"object":"list","data":[
            {"id":"claude-opus-5","object":"model","created":1786320000,"owned_by":"google-vertex-ai","publisher":"anthropic","entitled":false},
            {"id":"gemini-3.6-flash","object":"model","created":1785801600,"owned_by":"google-vertex-ai","publisher":"google","entitled":true}
        ],"hasGrant":true}"#;
        let Ok(catalogue) = serde_json::from_str::<GatewayCatalogue>(body) else {
            panic!("the documented catalogue shape must parse");
        };
        assert!(catalogue.has_grant);
        assert_eq!(catalogue.rows.len(), 2);
        assert_eq!(catalogue.rows[1].id, "gemini-3.6-flash");
        assert!(catalogue.rows[1].entitled);
        assert!(!catalogue.rows[0].entitled);
        assert_eq!(catalogue.rows[0].display_name, None);
    }

    #[test]
    fn the_requested_metadata_is_read_when_the_gateway_sends_it() {
        let body = r#"{"data":[{"id":"m","entitled":true,"display_name":"Model M","description":"fast","context_window":200000}]}"#;
        let Ok(catalogue) = serde_json::from_str::<GatewayCatalogue>(body) else {
            panic!("parse");
        };
        assert_eq!(catalogue.rows[0].display_name.as_deref(), Some("Model M"));
        assert_eq!(catalogue.rows[0].description.as_deref(), Some("fast"));
        assert_eq!(catalogue.rows[0].context_window, Some(200_000));
    }

    // ── the cache ───────────────────────────────────────────────────────

    #[tokio::test]
    async fn a_fresh_cache_is_used_without_asking_the_gateway() {
        let home = tempdir();
        let cache = cache_with(vec![row("a", true)], None, 1_000);
        write_cache(home.path(), &cache).await.expect("write");

        let fetcher = FakeFetcher::ok(vec![row("b", true)]);
        let resolved = resolve(home.path(), &fetcher, &FakeClock(1_000 + 60), false)
            .await
            .expect("a fresh cache resolves");
        assert!(matches!(resolved, Resolved::Fresh(_)));
        assert_eq!(resolved.cache().rows[0].id, "a");
        assert_eq!(fetcher.calls(), 0, "no request may go out");
    }

    #[tokio::test]
    async fn a_stale_cache_is_refetched_and_overwritten() {
        let home = tempdir();
        let cache = cache_with(vec![row("a", true)], None, 1_000);
        write_cache(home.path(), &cache).await.expect("write");

        let fetcher = FakeFetcher::ok(vec![row("b", true)]);
        let now = 1_000 + CACHE_TTL.as_secs() + 1;
        let resolved = resolve(home.path(), &fetcher, &FakeClock(now), false)
            .await
            .expect("resolves");
        assert!(matches!(resolved, Resolved::Fetched(_)));
        assert_eq!(resolved.cache().rows[0].id, "b");
        assert_eq!(fetcher.calls(), 1);

        let on_disk = load_cache(home.path()).await.expect("the cache was rewritten");
        assert_eq!(on_disk.rows[0].id, "b");
        assert_eq!(on_disk.fetched_at, now);
    }

    #[tokio::test]
    async fn force_ignores_freshness_but_keeps_the_stale_fallback() {
        let home = tempdir();
        write_cache(home.path(), &cache_with(vec![row("a", true)], None, 1_000))
            .await
            .expect("write");

        let fetcher = FakeFetcher::ok(vec![row("b", true)]);
        let resolved = resolve(home.path(), &fetcher, &FakeClock(1_001), true)
            .await
            .expect("resolves");
        assert!(matches!(resolved, Resolved::Fetched(_)));
        assert_eq!(fetcher.calls(), 1);

        let failing = FakeFetcher::failing(FetchError::Transport("down".into()));
        let resolved = resolve(home.path(), &failing, &FakeClock(1_002), true)
            .await
            .expect("the stale cache still carries it");
        assert!(resolved.is_stale());
        assert_eq!(resolved.cache().rows[0].id, "b");
    }

    #[tokio::test]
    async fn a_failed_fetch_falls_back_to_a_stale_cache_of_any_age() {
        let home = tempdir();
        write_cache(home.path(), &cache_with(vec![row("a", true)], None, 1))
            .await
            .expect("write");
        let fetcher = FakeFetcher::failing(FetchError::Transport("offline".into()));
        let resolved = resolve(home.path(), &fetcher, &FakeClock(10_000_000), false)
            .await
            .expect("offline with a cache still resolves");
        let Resolved::Stale { cache, error } = resolved else {
            panic!("must be marked stale");
        };
        assert_eq!(cache.rows[0].id, "a");
        assert_eq!(error, FetchError::Transport("offline".into()));
    }

    #[tokio::test]
    async fn no_cache_and_no_gateway_is_a_refusal_not_a_list() {
        // Decision 1: nothing authored here stands in. The message is the one
        // the user reads.
        let home = tempdir();
        let fetcher = FakeFetcher::failing(FetchError::Transport("offline".into()));
        let Err(err) = resolve(home.path(), &fetcher, &FakeClock(1), false).await else {
            panic!("with nothing to fall back to there must be no catalogue");
        };
        assert!(err.to_string().contains("model list"), "{err}");
        assert!(err.to_string().contains("could not reach the gateway"), "{err}");
    }

    #[tokio::test]
    async fn a_credential_failure_reads_as_one_all_the_way_up() {
        // The host classifies on the message text; a 401 must route to
        // sign-in rather than to a generic toast.
        let home = tempdir();
        let fetcher = FakeFetcher::failing(FetchError::Unauthorized("".into()));
        let Err(err) = resolve(home.path(), &fetcher, &FakeClock(1), false).await else {
            panic!("no catalogue");
        };
        assert!(err.to_string().to_ascii_lowercase().contains("unauthorized"), "{err}");
        let no_token = FetchError::NoToken("signed out".into()).to_string();
        assert!(no_token.contains("not authenticated"), "{no_token}");
    }

    #[tokio::test]
    async fn a_cache_for_another_org_counts_as_missing() {
        let home = tempdir();
        write_cache(home.path(), &cache_with(vec![row("a", true)], Some("org_1"), 1_000))
            .await
            .expect("write");

        // Fresh by age, wrong org: fetch.
        let fetcher = FakeFetcher::ok(vec![row("b", true)]).for_org("org_2");
        let resolved = resolve(home.path(), &fetcher, &FakeClock(1_001), false)
            .await
            .expect("resolves");
        assert!(matches!(resolved, Resolved::Fetched(_)));
        assert_eq!(resolved.cache().org.as_deref(), Some("org_2"));

        // And a failed fetch for a third org may not fall back to org_2's rows.
        let failing = FakeFetcher::failing(FetchError::Transport("down".into())).for_org("org_3");
        assert!(resolve(home.path(), &failing, &FakeClock(1_002), false).await.is_err());
    }

    #[tokio::test]
    async fn a_corrupt_cache_file_is_treated_as_absent() {
        let home = tempdir();
        std::fs::write(home.path().join(CACHE_FILE), b"{not json").expect("write garbage");
        assert!(load_cache(home.path()).await.is_none());

        let fetcher = FakeFetcher::ok(vec![row("a", true)]);
        let resolved = resolve(home.path(), &fetcher, &FakeClock(1), false)
            .await
            .expect("a corrupt cache is a miss, not an error");
        assert!(matches!(resolved, Resolved::Fetched(_)));
    }

    #[tokio::test]
    async fn the_cache_is_written_whole_or_not_at_all() {
        let home = tempdir();
        write_cache(home.path(), &cache_with(vec![row("a", true)], None, 5))
            .await
            .expect("write");
        // No temp file is left behind, and the file reloads as written.
        let leftovers: Vec<_> = std::fs::read_dir(home.path())
            .expect("read dir")
            .filter_map(std::result::Result::ok)
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files must not survive a write");
        let reloaded = load_cache(home.path()).await.expect("reload");
        assert_eq!(reloaded.fetched_at, 5);
        assert_eq!(reloaded.version, CACHE_VERSION);
    }

    #[tokio::test]
    async fn refresh_now_always_asks_and_rewrites() {
        let home = tempdir();
        write_cache(home.path(), &cache_with(vec![row("a", true)], None, 1_000))
            .await
            .expect("write");
        let fetcher = FakeFetcher::ok(vec![row("b", true)]);
        let cache = refresh_now(home.path(), &fetcher, &FakeClock(1_001))
            .await
            .expect("refresh");
        assert_eq!(cache.rows[0].id, "b");
        assert_eq!(fetcher.calls(), 1);
        assert_eq!(load_cache(home.path()).await.expect("reload").rows[0].id, "b");

        let failing = FakeFetcher::failing(FetchError::Http { status: 503, body: String::new() });
        assert!(refresh_now(home.path(), &failing, &FakeClock(1_002)).await.is_err());
        assert_eq!(
            load_cache(home.path()).await.expect("reload").rows[0].id,
            "b",
            "a failed refresh leaves the cache alone",
        );
    }

    // ── projection ──────────────────────────────────────────────────────

    #[test]
    fn only_entitled_rows_are_offered_in_the_gateways_order() {
        let cache = cache_with(
            vec![row("second", true), row("locked", false), row("first", true)],
            None,
            0,
        );
        let projected = project(&cache).expect("two entitled rows");
        let slugs: Vec<&str> = projected.response.models.iter().map(|m| m.slug.as_str()).collect();
        assert_eq!(slugs, ["second", "first"], "gateway order, not sorted");
        assert_eq!(
            projected.response.models.iter().map(|m| m.priority).collect::<Vec<_>>(),
            [1, 2],
        );
        assert_eq!(projected.default_model, "second", "the first entitled row is the default");
        assert_eq!(projected.picker.len(), 2);
        assert!(projected.picker.iter().all(|m| m.cost.is_none()));
    }

    #[test]
    fn nothing_entitled_is_no_catalogue() {
        let cache = cache_with(vec![row("locked", false)], None, 0);
        assert!(project(&cache).is_none());
        assert!(project(&cache_with(vec![], None, 0)).is_none());
    }

    #[test]
    fn the_name_falls_back_to_the_slug_until_the_gateway_sends_one() {
        let mut named = row("claude-opus-5", true);
        named.display_name = Some("Claude Opus 5".into());
        named.description = Some("The most capable.".into());
        let cache = cache_with(vec![row("gemini-3.6-flash", true), named], None, 0);
        let projected = project(&cache).expect("rows");
        assert_eq!(projected.response.models[0].display_name, "gemini-3.6-flash");
        assert_eq!(projected.response.models[0].description, None);
        assert_eq!(projected.response.models[1].display_name, "Claude Opus 5");
        assert_eq!(projected.response.models[1].description.as_deref(), Some("The most capable."));
        assert_eq!(&*projected.picker[0].name, "gemini-3.6-flash");
        assert_eq!(&*projected.picker[1].name, "Claude Opus 5");
    }

    #[test]
    fn the_context_window_drives_compaction_only_when_the_gateway_states_it() {
        let mut sized = row("sized", true);
        sized.context_window = Some(200_000);
        let cache = cache_with(vec![row("unsized", true), sized], None, 0);
        let projected = project(&cache).expect("rows");
        // Absent: the engine has no ceiling to compact against. This is the
        // accepted interim cost until the gateway sends the number.
        assert_eq!(projected.response.models[0].context_window, None);
        assert_eq!(projected.response.models[0].auto_compact_token_limit(), None);
        // Present: compaction fires at 90%.
        assert_eq!(projected.response.models[1].context_window, Some(200_000));
        assert_eq!(projected.response.models[1].auto_compact_token_limit(), Some(180_000));
    }

    #[test]
    fn no_projected_row_advertises_a_control_this_wire_cannot_carry() {
        let cache = cache_with(vec![row("a", true), row("b", true)], None, 0);
        for model in project(&cache).expect("rows").response.models {
            assert!(model.supported_reasoning_levels.is_empty(), "{}", model.slug);
            assert!(!model.support_verbosity, "{}", model.slug);
            assert!(!model.supports_reasoning_summary_parameter, "{}", model.slug);
            assert!(model.service_tiers.is_empty(), "{}", model.slug);
            assert!(!model.use_responses_lite, "{}", model.slug);
            assert!(!model.supports_search_tool, "{}", model.slug);
            assert!(model.apply_patch_tool_type.is_some(), "{} lost apply_patch", model.slug);
        }
    }

    #[test]
    fn every_projected_row_carries_instructions() {
        // An empty prompt is a silent lobotomy: the engine warns and runs
        // with no system prompt at all.
        let cache = cache_with(vec![row("a", true)], None, 0);
        for model in project(&cache).expect("rows").response.models {
            assert!(model.get_model_instructions(None).len() > 1_000, "{}", model.slug);
        }
    }

    #[test]
    fn the_fingerprint_ignores_labels_and_tracks_what_the_engine_loaded() {
        let base = cache_with(vec![row("a", true), row("b", true)], None, 0);
        let fp = |cache: &CatalogueCache| project(cache).expect("rows").fingerprint;

        let mut relabelled = base.clone();
        relabelled.rows[0].display_name = Some("A!".into());
        relabelled.rows[1].description = Some("desc".into());
        assert_eq!(fp(&base), fp(&relabelled), "names and descriptions swap in place");

        let mut added = base.clone();
        added.rows.push(row("c", true));
        assert_ne!(fp(&base), fp(&added), "a new slug needs a reconnect");

        let mut unentitled = base.clone();
        unentitled.rows[1].entitled = false;
        assert_ne!(fp(&base), fp(&unentitled));

        let mut resized = base.clone();
        resized.rows[0].context_window = Some(100_000);
        assert_ne!(fp(&base), fp(&resized), "a context window is engine state");

        let mut reordered = base.clone();
        reordered.rows.swap(0, 1);
        assert_ne!(fp(&base), fp(&reordered), "order decides the default");
    }

    #[tokio::test]
    async fn the_projection_reloads_as_the_record_the_engine_reads() {
        // Round-trips through disk, which is the path the engine takes.
        let home = tempdir();
        let cache = cache_with(vec![row("a", true)], None, 0);
        let projected = project(&cache).expect("rows");
        let path = crate::engine::catalog::write_models_json(home.path(), &projected.response)
            .await
            .expect("write");
        let body = std::fs::read_to_string(&path).expect("read back");
        let reloaded: ModelsResponse = serde_json::from_str(&body).expect("reload");
        assert_eq!(reloaded.models.len(), 1);
        assert_eq!(reloaded.models[0].slug, "a");
    }
}
