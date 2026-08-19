//! Consent-gated, privacy-preserving product telemetry (PostHog).
//!
//! Consent is Settings → General → "Share anonymous usage data", which defaults
//! **ON** — the opt-out posture of VS Code and Zed, and the reason `TELEMETRY.md`
//! says so plainly rather than calling this opt-in. Switching it off takes effect
//! immediately: [`capture`](TelemetryClient::capture) returns before anything is
//! queued, and nothing is buffered for later. When enabled, this module emits
//! coarse **usage / error metadata only** — never prompt or response text, file
//! contents or absolute paths, KB/chat content, API keys, terminal I/O, or
//! browser URLs. See `TELEMETRY.md` at the repo root for the full event catalogue
//! and the never-collected list; an event added here belongs in that table in the
//! same change.
//!
//! Identity has two layers. The base is a persisted random UUID per **device**
//! (`<app_config_dir>/device.json`, see [`device`]), used as the PostHog
//! `distinct_id` by both this Rust emitter and the frontend `posthog-js`, so one
//! machine maps to one person. When the user signs in to an Atlas account,
//! [`TelemetryClient::identify_account`] swaps the id to the account id and
//! sends `$identify` with `$anon_distinct_id`, merging the device person into
//! the account. Signing out reverts to the device id.
//!
//! That merge is retroactive — PostHog re-attributes the device person's prior
//! events to the account — and it replaces the "anonymous forever" posture this
//! module shipped with through 0.2.3 (ATL-52). It was retired deliberately in
//! 0.2.4; `TELEMETRY.md` was rewritten in the same change and is the public
//! statement of what this now does. What did **not** change: identity is still
//! consent-gated, so an install that never opted in sends nothing extra as a
//! result of signing in.
//!
//! Key/host resolution (highest priority wins):
//!   1. env `ATLAS_POSTHOG_KEY`/`POSTHOG_KEY` (+ `ATLAS_POSTHOG_HOST`/`POSTHOG_HOST`),
//!      also picked up from a `.env` loaded by `dotenvy` at `main()` start.
//!   2. `<app_config_dir>/telemetry.json` ({ "key": ..., "host": ... }).
//!   3. compile-time `option_env!("ATLAS_POSTHOG_KEY")` — official release builds.
//!   4. none → the client is permanently **inert** (no network, every call a no-op).

pub mod bridge;
pub mod device;
pub mod retrieval;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc;

/// PostHog US cloud ingest endpoint (used when no host override is given).
const DEFAULT_HOST: &str = "https://us.i.posthog.com";
/// Flush whenever this many events are queued…
const FLUSH_BATCH: usize = 20;
/// …or this often, whichever comes first.
const FLUSH_INTERVAL: Duration = Duration::from_secs(5);
/// Bounded queue. On overflow we drop events (telemetry must never apply
/// backpressure to the app).
const QUEUE_CAP: usize = 512;

/// Baked into official release builds via CI secrets. `None` in source / fork
/// builds unless the builder sets the env at compile time.
const BUILD_KEY: Option<&str> = option_env!("ATLAS_POSTHOG_KEY");
const BUILD_HOST: Option<&str> = option_env!("ATLAS_POSTHOG_HOST");

/// A single queued capture, serialized into the PostHog `/batch/` payload.
///
/// Carries its own `distinct_id`, stamped at **enqueue** time rather than at
/// flush. That is what makes the sign-in merge correct: events captured before
/// `$identify` keep the device id and are merged by PostHog, while a batch that
/// straddles the transition no longer mislabels its first half.
#[derive(Clone)]
pub(crate) struct QueuedEvent {
    event: String,
    distinct_id: String,
    properties: Value,
    timestamp: String,
}

/// The live analytics identity: who subsequent events are attributed to.
#[derive(Debug, Default)]
struct Identity {
    /// `device_id` while signed out, the Atlas user id while signed in.
    distinct_id: String,
    /// `Some` only while signed in.
    account_id: Option<String>,
    /// The last identity sent, so a re-sync that changed nothing sends nothing.
    /// `broadcast` fires on every auth transition *and* every revalidation, so
    /// without this a long session would emit a `$identify` on a timer.
    last_sent: Option<AccountIdentity>,
    /// The active Organisation, injected into every event as `$groups` plus a
    /// pair of flat properties. Owned by [`TelemetryClient::set_active_org`],
    /// **not** by sign-in — see that method for why.
    org: Option<OrgIdentity>,
    /// A device→account merge that could not be sent because consent was off at
    /// the time. Drained on opt-in so the link isn't lost forever.
    pending_merge_anon: Option<String>,
}

/// Non-secret config the frontend reads to bootstrap `posthog-js`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryConfig {
    pub enabled: bool,
    pub host: String,
    /// Device-stable anonymous id. Still named `anonId` on the wire so the
    /// renderer bootstrap keeps working unchanged.
    pub anon_id: String,
    /// Atlas account id when signed in. Lets the renderer identify at boot
    /// instead of waiting for an `atlas:auth-changed` it may already have missed
    /// (`initTelemetry` is async and races the auth restore).
    pub account_id: Option<String>,
    pub using_default_key: bool,
    /// PostHog *project* (write-only ingest) key — safe to expose client-side.
    /// `None` when inert; the frontend then skips `posthog-js` init entirely.
    pub key: Option<String>,
}

/// The account facts telemetry is allowed to know, built from an `AuthSnapshot`
/// by `commands::auth::sync_identity`.
///
/// Note what is absent: `avatar_path`. It is an absolute local path, and paths
/// do not leave the machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountIdentity {
    pub user_id: String,
    pub email: String,
    pub name: String,
    pub org_id: Option<String>,
    pub org_name: Option<String>,
    pub org_role: Option<String>,
    pub org_count: usize,
}

/// The active Organisation, as telemetry is allowed to know it.
///
/// **`name` is only ever set for a synced org.** A local org's name is typed by
/// the user into a box on their own machine and never leaves it — it is as
/// likely to be "adib personal" as "Acme" — so only the random local id travels,
/// which is enough to segment a device's own events without shipping a string
/// nobody agreed to send. A synced org's name is already server-side and shared
/// with everyone in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrgIdentity {
    /// The **local** org id in both cases. Stable across a device, and what the
    /// app itself keys everything else on.
    pub id: String,
    /// `"cloud"` once the org is synced, `"local"` while it lives only here.
    pub kind: &'static str,
    /// Synced orgs only. See the type docs.
    pub name: Option<String>,
    /// The signed-in user's role in this org, when it is a synced org they are
    /// actually a member of.
    pub role: Option<String>,
}

impl OrgIdentity {
    fn groups(&self) -> Value {
        json!({ "organisation": self.id })
    }
}

/// The two auto-update values pulled from PostHog remote config.
#[derive(Debug, Clone)]
pub struct RemoteUpdateConfig {
    /// Latest version, raw string (e.g. `"0.1.21"`).
    pub version: String,
    /// Direct download URL of the release DMG.
    pub uri: String,
}

/// Coerce a PostHog `featureFlagPayloads` value into a plain string. Payloads
/// may arrive already as a JSON string, or double-encoded (a string whose
/// contents are themselves a JSON-quoted string, e.g. `"\"0.1.21\""`).
fn payload_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => match serde_json::from_str::<Value>(s) {
            Ok(Value::String(inner)) => Some(inner),
            _ => Some(s.clone()),
        },
        _ => None,
    }
}

/// Managed Tauri state. Cheap to clone (`Arc`). Every public method is an
/// instant no-op when inert or disabled.
pub struct TelemetryClient {
    /// Runtime opt-in gate (flips live via `set_enabled`).
    enabled: AtomicBool,
    /// No key resolved → permanently dead. Distinct from `enabled` so toggling
    /// on a key-less build still does nothing.
    inert: bool,
    api_key: Option<String>,
    host: String,
    using_default_key: bool,
    /// Immutable per-device id. The `$anon_distinct_id` of any account merge,
    /// and what identity reverts to on sign-out.
    device_id: String,
    /// Who events are attributed to right now. Behind a lock because the flush
    /// loop holds only an `Arc<Self>` and `capture` takes `&self`.
    identity: RwLock<Identity>,
    app_version: &'static str,
    os: &'static str,
    arch: &'static str,
    tx: Option<mpsc::Sender<QueuedEvent>>,
}

struct Resolved {
    api_key: String,
    host: String,
    using_default_key: bool,
}

/// Resolve the PostHog key + host by priority. `None` → inert.
fn resolve_keys(app: &AppHandle) -> Option<Resolved> {
    // 1. Environment (also populated from `.env` via dotenvy in main()).
    let env_key = std::env::var("ATLAS_POSTHOG_KEY")
        .ok()
        .or_else(|| std::env::var("POSTHOG_KEY").ok())
        .filter(|k| !k.trim().is_empty());
    if let Some(key) = env_key {
        let host = std::env::var("ATLAS_POSTHOG_HOST")
            .ok()
            .or_else(|| std::env::var("POSTHOG_HOST").ok())
            .filter(|h| !h.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_HOST.to_string());
        return Some(Resolved {
            api_key: key.trim().to_string(),
            host,
            using_default_key: false,
        });
    }

    // 2. User config file `<app_config_dir>/telemetry.json`.
    if let Some(r) = read_config_file(app) {
        return Some(r);
    }

    // 3. Compile-time default (official builds only).
    if let Some(key) = BUILD_KEY.filter(|k| !k.trim().is_empty()) {
        return Some(Resolved {
            api_key: key.trim().to_string(),
            host: BUILD_HOST
                .filter(|h| !h.trim().is_empty())
                .unwrap_or(DEFAULT_HOST)
                .to_string(),
            using_default_key: true,
        });
    }

    // 4. Nothing → inert.
    None
}

/// Shape of the optional `<app_config_dir>/telemetry.json` self-host config.
#[derive(Deserialize)]
struct FileConfig {
    key: Option<String>,
    host: Option<String>,
}

fn read_config_file(app: &AppHandle) -> Option<Resolved> {
    let dir = app.path().app_config_dir().ok()?;
    let raw = std::fs::read_to_string(dir.join("telemetry.json")).ok()?;
    let cfg: FileConfig = serde_json::from_str(&raw).ok()?;
    let key = cfg.key.filter(|k| !k.trim().is_empty())?;
    Some(Resolved {
        api_key: key.trim().to_string(),
        host: cfg
            .host
            .filter(|h| !h.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_HOST.to_string()),
        using_default_key: false,
    })
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Strip obvious PII (path-like / URL-like tokens) and truncate. Applied to any
/// free-text we forward (agent/panic error summaries) as a defensive backstop —
/// callers should already pass only metadata.
pub fn redact_message(msg: &str, max_chars: usize) -> String {
    let cleaned = msg
        .split_whitespace()
        .filter(|t| {
            !t.starts_with('/')
                && !t.starts_with('~')
                && !t.contains('\\')
                && !t.contains("://")
                && !t.contains('@')
        })
        .collect::<Vec<_>>()
        .join(" ");
    if cleaned.chars().count() > max_chars {
        let head: String = cleaned.chars().take(max_chars).collect();
        format!("{head}…")
    } else {
        cleaned
    }
}

impl TelemetryClient {
    /// Construct the client (resolving key/host) and, unless inert, the
    /// background flush channel receiver the caller must hand to a spawned
    /// `run_flush_loop`. `enabled` is the persisted opt-in setting.
    pub(crate) fn new(
        app: &AppHandle,
        device_id: String,
        enabled: bool,
    ) -> (Arc<Self>, Option<mpsc::Receiver<QueuedEvent>>) {
        let resolved = resolve_keys(app);
        let inert = resolved.is_none();
        let (tx, rx) = if inert {
            (None, None)
        } else {
            let (t, r) = mpsc::channel(QUEUE_CAP);
            (Some(t), Some(r))
        };
        let (api_key, host, using_default_key) = match resolved {
            Some(r) => (Some(r.api_key), r.host, r.using_default_key),
            None => (None, DEFAULT_HOST.to_string(), false),
        };
        let client = Arc::new(Self {
            enabled: AtomicBool::new(enabled && !inert),
            inert,
            api_key,
            host,
            using_default_key,
            identity: RwLock::new(Identity {
                distinct_id: device_id.clone(),
                ..Identity::default()
            }),
            device_id,
            app_version: env!("CARGO_PKG_VERSION"),
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            tx,
        });
        (client, rx)
    }

    /// Who events are attributed to right now — the account id when signed in,
    /// otherwise this device's id.
    pub fn current_distinct_id(&self) -> String {
        self.identity.read().distinct_id.clone()
    }

    /// The signed-in Atlas user id, if any.
    pub fn account_id(&self) -> Option<String> {
        self.identity.read().account_id.clone()
    }

    pub fn is_enabled(&self) -> bool {
        !self.inert && self.enabled.load(Ordering::Relaxed)
    }

    pub fn config(&self) -> TelemetryConfig {
        TelemetryConfig {
            enabled: self.is_enabled(),
            host: self.host.clone(),
            anon_id: self.device_id.clone(),
            account_id: self.account_id(),
            using_default_key: self.using_default_key,
            key: if self.inert {
                None
            } else {
                self.api_key.clone()
            },
        }
    }

    /// Fetch the two auto-update remote-config values (`version`, `uri`) from
    /// PostHog using the official `posthog-rs` SDK's feature-flag evaluation
    /// (`evaluate_flags` → `/flags/?v=2`), keyed on the project token + anon
    /// distinct id. Both values are stored as PostHog **remote-config flag
    /// payloads** (JSON-encoded strings, so `get_flag_payload` returns e.g.
    /// `"\"0.1.20\""` — decoded via [`payload_string`]). Deliberately
    /// **independent of the telemetry opt-in** (app updates are not analytics) —
    /// it only requires a resolved project key (i.e. not inert). Returns `None`
    /// when inert or on any error.
    pub async fn fetch_remote_config(&self) -> Option<RemoteUpdateConfig> {
        let key = self.api_key.clone()?; // inert build → no key → skip
        let host = self.host.clone();
        let client = posthog_rs::client((key.as_str(), host.as_str())).await;
        // Keyed on the DEVICE id, not the live identity: the update check must
        // resolve to the same flags across a sign-in, and it is not analytics.
        let flags = client
            .evaluate_flags(
                self.device_id.as_str(),
                posthog_rs::EvaluateFlagsOptions::default(),
            )
            .await
            .ok()?;
        let version = flags.get_flag_payload("version").as_ref().and_then(payload_string)?;
        let uri = flags.get_flag_payload("uri").as_ref().and_then(payload_string)?;
        if version.trim().is_empty() || uri.trim().is_empty() {
            return None;
        }
        Some(RemoteUpdateConfig { version, uri })
    }

    /// Flip the live opt-in gate. Records a single `telemetry_opt_in` on enable
    /// and `telemetry_opt_out` on disable (the latter sent while still enabled,
    /// so nothing is transmitted after the user has opted out).
    pub fn set_enabled(&self, on: bool) {
        if self.inert {
            return;
        }
        let was = self.enabled.load(Ordering::Relaxed);
        if on && !was {
            self.enabled.store(true, Ordering::Relaxed);
            self.capture("telemetry_opt_in", json!({}));
            // A sign-in that happened while consent was off left the device→account
            // link unsent. Send it now, so opting in later doesn't strand the
            // account as a second, unrelated person.
            self.drain_pending_merge();
        } else if !on && was {
            self.capture("telemetry_opt_out", json!({}));
            self.enabled.store(false, Ordering::Relaxed);
        }
    }

    /// Fire-and-forget capture. Instant no-op when inert/disabled; never blocks
    /// (drops on a full queue).
    pub fn capture(&self, event: &str, mut properties: Value) {
        if !self.is_enabled() {
            return;
        }
        let Some(tx) = self.tx.as_ref() else {
            return;
        };
        self.inject_common(&mut properties);
        let _ = tx.try_send(QueuedEvent {
            event: event.to_string(),
            distinct_id: self.current_distinct_id(),
            properties,
            timestamp: now_iso(),
        });
    }

    /// Attribute subsequent events to this Atlas account, merging the device
    /// person into it (`$identify` + `$anon_distinct_id`).
    ///
    /// **Idempotent.** Called from the single auth broadcast funnel, which fires
    /// on every transition *and* on each launch revalidation — so repeat calls
    /// with the same `user_id` must refresh person properties without sending
    /// another merge, or a relaunch would emit one every time.
    ///
    /// The `$anon_distinct_id` is attached **only** when the id being replaced is
    /// this device's own. Merging one account into another is irreversible in
    /// PostHog: it would silently fuse two real people, and there is no undo.
    /// Account-to-account switches therefore re-attribute going forward and
    /// leave history where it is.
    ///
    /// Consent-gated like everything else — [`capture`](Self::capture) is a
    /// no-op when the user has not opted in, so signing in sends nothing. The
    /// unsent merge is remembered and drained if they later opt in.
    pub fn identify_account(&self, id: &AccountIdentity) {
        if self.inert || id.user_id.trim().is_empty() {
            return;
        }

        let merge_anon = {
            let mut g = self.identity.write();
            // Note what is NOT set here: the org. Sign-in does not decide which
            // Organisation you are working in — see `set_active_org`.

            // Nothing has changed since the last send — not the account, not the
            // name, not the active org. Emitting again would only add noise.
            if g.last_sent.as_ref() == Some(id) {
                return;
            }
            if g.account_id.as_deref() == Some(id.user_id.as_str()) {
                // Same account, changed details — refresh `$set`, no merge.
                g.last_sent = Some(id.clone());
                None
            } else {
                let prior = std::mem::replace(&mut g.distinct_id, id.user_id.clone());
                g.account_id = Some(id.user_id.clone());
                let anon = (prior == self.device_id).then_some(prior);
                if !self.is_enabled() {
                    // Remember the merge for `set_enabled(true)` to drain, and
                    // deliberately do NOT record this as sent — opting in later
                    // must still deliver the person properties.
                    g.pending_merge_anon = anon;
                    return;
                }
                g.last_sent = Some(id.clone());
                anon
            }
        };

        let mut props = json!({
            "$set": {
                "email": id.email,
                "name": id.name,
                "atlas_account": true,
                "atlas_org_count": id.org_count,
                "atlas_active_org_id": id.org_id,
            },
            "$set_once": {
                "atlas_device_id": self.device_id,
            },
        });
        if let (Some(anon), Value::Object(m)) = (merge_anon, &mut props) {
            m.insert("$anon_distinct_id".into(), json!(anon));
        }
        self.capture("$identify", props);
    }

    /// Set the Organisation every subsequent event is attributed to.
    ///
    /// **This is deliberately not driven by sign-in.** The Organisation you are
    /// working in is a local fact: it is switchable at any moment without any
    /// auth transition, it exists while signed out, and a local-only org has no
    /// server row at all. Deriving it from the auth snapshot — as this module
    /// did through 0.2.4 — meant events were grouped by *whichever org the
    /// server last thought was active*, so a local org produced ungrouped
    /// ("global") events and an org switch silently kept filing work under the
    /// previous tenant until the next revalidation. Both are the same bug: the
    /// wrong system owned the fact.
    ///
    /// The caller is `commands::telemetry::telemetry_set_org`, which resolves
    /// the whole identity from app state so the frontend only ever passes an id.
    ///
    /// Idempotent: an unchanged org re-sends nothing, which matters because the
    /// startup seed and the store's first hydrate both fire.
    pub fn set_active_org(&self, org: Option<OrgIdentity>) {
        if self.inert {
            return;
        }
        {
            let mut g = self.identity.write();
            if g.org == org {
                return;
            }
            g.org = org.clone();
        }

        // `$groupidentify` defines the group; the `$groups` that `inject_common`
        // puts on every event is what associates it. Only a synced org has
        // properties worth defining — a local one is an opaque id by design.
        if let Some(org) = org.filter(|o| o.name.is_some()) {
            self.capture(
                "$groupidentify",
                json!({
                    "$group_type": "organisation",
                    "$group_key": org.id,
                    "$group_set": { "name": org.name, "role": org.role, "kind": org.kind },
                }),
            );
        }
    }

    /// Revert to the device person. Emits nothing itself — the caller decides
    /// whether the sign-out is worth an event, and `auth_signed_out` is captured
    /// *before* this so it lands on the account it belongs to.
    pub fn reset_identity(&self) {
        let mut g = self.identity.write();
        g.distinct_id = self.device_id.clone();
        g.account_id = None;
        // The org is NOT cleared. Signing out does not move you out of the
        // Organisation you have open — you keep working in it, now as the device
        // person — so dropping the group here would file that work as ungrouped
        // and split one continuous session across two buckets.
        g.pending_merge_anon = None;
        // Signing back into the same account must re-identify, so this cannot
        // be remembered across a sign-out.
        g.last_sent = None;
    }

    /// Send a merge that `identify_account` deferred because consent was off.
    fn drain_pending_merge(&self) {
        let anon = self.identity.write().pending_merge_anon.take();
        if let Some(anon) = anon {
            self.capture(
                "$identify",
                json!({
                    "$anon_distinct_id": anon,
                    "$set_once": { "atlas_device_id": self.device_id },
                }),
            );
        }
    }

    /// One-shot POST to `/capture/`, bypassing both the queue and the opt-in
    /// gate.
    ///
    /// **Only** for submissions the user explicitly initiated — today that means
    /// feedback, where a button labelled "Send" that silently discarded the
    /// message would be a worse betrayal than sending it. Still a hard no-op
    /// when **inert**: no resolved key means no network under any circumstance,
    /// and that promise is not negotiable.
    ///
    /// Direct rather than queued so the caller can show a real success or
    /// failure, instead of "it'll go out within five seconds, probably".
    pub async fn capture_user_initiated(
        &self,
        event: &str,
        mut properties: Value,
    ) -> Result<(), String> {
        let Some(key) = self.api_key.clone() else {
            return Err("Telemetry is not configured in this build.".into());
        };
        self.inject_common(&mut properties);
        if let Value::Object(m) = &mut properties {
            // Makes the consent state of every submission visible downstream.
            m.insert("telemetry_opt_in".into(), json!(self.is_enabled()));
        }
        let url = format!("{}/capture/", self.host.trim_end_matches('/'));
        let body = json!({
            "api_key": key,
            "event": event,
            "distinct_id": self.current_distinct_id(),
            "properties": properties,
            "timestamp": now_iso(),
        });
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = http
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if resp.status().is_success() {
            Ok(())
        } else {
            Err(format!("PostHog returned {}", resp.status()))
        }
    }

    /// The account events.
    ///
    /// These no longer carry "no identity at all" — [`identify_account`] has
    /// already attributed the session to the Atlas account by the time this
    /// fires, so the event lands on the account person. The properties here are
    /// the *shape* of the account, not the person: counts, not names.
    ///
    /// Still consent-gated, because [`capture`](Self::capture) is. That part of
    /// the original ATL-52 guarantee stands: an install that has never opted in
    /// sends nothing extra as a result of signing in.
    ///
    /// [`identify_account`]: Self::identify_account
    pub fn capture_signed_in(&self, org_count: usize, has_active_org: bool) {
        self.capture(
            "auth_signed_in",
            json!({ "org_count": org_count, "has_active_org": has_active_org }),
        );
    }

    /// Companion to [`capture_signed_in`](Self::capture_signed_in). Emitted only
    /// when the *user* signs out, never when the server ends a session: folding
    /// a revocation into this event would leave a count that means neither one
    /// thing nor the other.
    pub fn capture_signed_out(&self) {
        self.capture(
            "auth_signed_out",
            json!({ "had_account": self.account_id().is_some() }),
        );
    }

    /// Best-effort **synchronous** capture for the panic hook. Because the build
    /// is `panic = "abort"` the process dies right after the hook, so we can't
    /// rely on the async flush task. Runs the POST on a fresh OS thread (so a
    /// panic on a tokio worker can still spin up a tiny runtime) with a short
    /// timeout, and blocks until it finishes or times out.
    pub fn capture_panic_blocking(&self, mut properties: Value) {
        if !self.is_enabled() {
            return;
        }
        let Some(key) = self.api_key.clone() else {
            return;
        };
        self.inject_common(&mut properties);
        let url = format!("{}/capture/", self.host.trim_end_matches('/'));
        let body = json!({
            "api_key": key,
            "event": "rust_panic",
            "distinct_id": self.current_distinct_id(),
            "properties": properties,
            "timestamp": now_iso(),
        });
        let handle = std::thread::spawn(move || {
            if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                rt.block_on(async move {
                    if let Ok(client) = reqwest::Client::builder()
                        .timeout(Duration::from_secs(2))
                        .build()
                    {
                        let _ = client.post(&url).json(&body).send().await;
                    }
                });
            }
        });
        let _ = handle.join();
    }

    fn inject_common(&self, properties: &mut Value) {
        if let Value::Object(map) = properties {
            map.entry("$lib")
                .or_insert_with(|| json!("atlas-rust"));
            map.entry("app_version")
                .or_insert_with(|| json!(self.app_version));
            map.entry("os").or_insert_with(|| json!(self.os));
            map.entry("arch").or_insert_with(|| json!(self.arch));
            // Org-level rollups while an Organisation is active. `$groups` is
            // what PostHog's group analytics reads; the two flat properties are
            // what makes an event filterable in an ordinary insight without
            // group analytics enabled, and `atlas_org_kind` is the one dimension
            // that separates "our team's usage" from "someone's private
            // scratch org" — the two behave nothing alike.
            if let Some(org) = self.identity.read().org.clone() {
                map.entry("$groups").or_insert_with(|| org.groups());
                map.entry("atlas_org_id").or_insert_with(|| json!(org.id));
                map.entry("atlas_org_kind").or_insert_with(|| json!(org.kind));
            }
        }
    }
}

/// Drain the queue and POST batches to `{host}/batch/`. Owns the receiver; ends
/// when every sender is dropped.
pub(crate) async fn run_flush_loop(
    client: Arc<TelemetryClient>,
    mut rx: mpsc::Receiver<QueuedEvent>,
) {
    let Some(api_key) = client.api_key.clone() else {
        return;
    };
    let url = format!("{}/batch/", client.host.trim_end_matches('/'));
    let http = reqwest::Client::builder()
        .user_agent(concat!("Atlas/", env!("CARGO_PKG_VERSION"), " (telemetry)"))
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap_or_default();

    let mut buf: Vec<QueuedEvent> = Vec::new();
    let mut ticker = tokio::time::interval(FLUSH_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            maybe = rx.recv() => {
                match maybe {
                    Some(ev) => {
                        buf.push(ev);
                        if buf.len() >= FLUSH_BATCH {
                            send_batch(&http, &url, &api_key, &mut buf).await;
                        }
                    }
                    None => {
                        // All senders dropped — final flush then exit.
                        send_batch(&http, &url, &api_key, &mut buf).await;
                        break;
                    }
                }
            }
            _ = ticker.tick() => {
                if !buf.is_empty() {
                    send_batch(&http, &url, &api_key, &mut buf).await;
                }
            }
        }
    }
}

async fn send_batch(
    http: &reqwest::Client,
    url: &str,
    api_key: &str,
    buf: &mut Vec<QueuedEvent>,
) {
    if buf.is_empty() {
        return;
    }
    let batch: Vec<Value> = buf
        .iter()
        .map(|e| {
            json!({
                "event": e.event,
                // Per-event, stamped when it was captured — a batch that spans a
                // sign-in must not relabel the events queued before it.
                "distinct_id": e.distinct_id,
                "properties": e.properties,
                "timestamp": e.timestamp,
            })
        })
        .collect();
    let payload = json!({ "api_key": api_key, "batch": batch });
    // Fire-and-forget: a failed flush drops this batch rather than retrying
    // forever. Telemetry is best-effort by design.
    if let Err(e) = http.post(url).json(&payload).send().await {
        tracing::debug!(target: "atlas::telemetry", "batch flush failed: {e}");
    }
    buf.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_strips_paths_urls_and_truncates() {
        let r = redact_message("failed to read /Users/adib/secret.rs at line 4", 200);
        assert!(!r.contains("/Users"));
        assert!(r.contains("failed to read"));

        let r2 = redact_message("connect https://internal.example.com/x denied", 200);
        assert!(!r2.contains("https://"));
        assert!(r2.contains("denied"));

        let long = "x ".repeat(100);
        let r3 = redact_message(&long, 10);
        assert!(r3.chars().count() <= 11); // 10 + ellipsis
        assert!(r3.ends_with('…'));
    }

    #[test]
    fn redact_drops_home_and_email_tokens() {
        let r = redact_message("error for ~/Library/x and user@host.com here", 200);
        assert!(!r.contains('~'));
        assert!(!r.contains('@'));
        assert!(r.contains("error for"));
        assert!(r.contains("here"));
    }


    /// Build a client without an `AppHandle` (which `resolve_keys` would need).
    /// `enabled` is the consent gate; the returned receiver is the queue tail.
    fn client(enabled: bool, inert: bool) -> (TelemetryClient, mpsc::Receiver<QueuedEvent>) {
        let (tx, rx) = mpsc::channel(32);
        let c = TelemetryClient {
            enabled: AtomicBool::new(enabled && !inert),
            inert,
            api_key: (!inert).then(|| "phc_test".to_string()),
            host: DEFAULT_HOST.to_string(),
            using_default_key: true,
            identity: RwLock::new(Identity {
                distinct_id: "device-uuid".into(),
                ..Identity::default()
            }),
            device_id: "device-uuid".into(),
            app_version: "0.0.0",
            os: "test",
            arch: "test",
            tx: (!inert).then_some(tx),
        };
        (c, rx)
    }

    fn account(user_id: &str) -> AccountIdentity {
        AccountIdentity {
            user_id: user_id.into(),
            email: "a@example.com".into(),
            name: "A".into(),
            org_id: Some("org-1".into()),
            org_name: Some("Acme".into()),
            org_role: Some("admin".into()),
            org_count: 2,
        }
    }

    /// Drain the queue into `(event, distinct_id, properties)` triples.
    fn drain(rx: &mut mpsc::Receiver<QueuedEvent>) -> Vec<(String, String, Value)> {
        let mut out = Vec::new();
        while let Ok(e) = rx.try_recv() {
            out.push((e.event, e.distinct_id, e.properties));
        }
        out
    }

    #[test]
    fn inert_client_is_a_total_no_op() {
        let (c, _rx) = client(true, true);
        assert!(!c.is_enabled());
        assert!(c.inert);
        // None of these may panic or transmit.
        c.capture("agent_turn_completed", json!({ "x": 1 }));
        c.set_enabled(true);
        c.set_enabled(false);
        c.identify_account(&account("user-1"));
        c.reset_identity();
        assert_eq!(c.current_distinct_id(), "device-uuid");
        let cfg = c.config();
        assert!(!cfg.enabled);
        assert!(cfg.key.is_none());
        assert!(cfg.account_id.is_none());
    }

    #[test]
    fn disabled_client_drops_events_but_records_nothing() {
        let (c, mut rx) = client(false, false);
        c.capture("agent_turn_started", json!({}));
        assert!(rx.try_recv().is_err(), "disabled client must not enqueue");

        // Opt in → an opt-in event is queued and common props injected.
        c.set_enabled(true);
        let ev = rx.try_recv().expect("opt-in event");
        assert_eq!(ev.event, "telemetry_opt_in");
        assert_eq!(ev.properties["$lib"], json!("atlas-rust"));
        assert_eq!(ev.properties["app_version"], json!("0.0.0"));

        c.capture("agent_turn_completed", json!({ "plugin_id": "codex" }));
        let ev2 = rx.try_recv().expect("completed event");
        assert_eq!(ev2.event, "agent_turn_completed");
        assert_eq!(ev2.properties["plugin_id"], json!("codex"));
    }

    /// The core of the account linkage: events before sign-in keep the device
    /// id, `$identify` carries the merge, and events after land on the account.
    #[test]
    fn identify_swaps_distinct_id_and_merges_device() {
        let (c, mut rx) = client(true, false);

        c.capture("app_started", json!({}));
        c.identify_account(&account("user-1"));
        c.capture("agent_turn_started", json!({}));

        let events = drain(&mut rx);
        let before = &events[0];
        assert_eq!(before.0, "app_started");
        assert_eq!(before.1, "device-uuid", "pre-sign-in event keeps the device id");

        let ident = events.iter().find(|e| e.0 == "$identify").expect("$identify");
        assert_eq!(ident.1, "user-1");
        assert_eq!(ident.2["$anon_distinct_id"], json!("device-uuid"));
        assert_eq!(ident.2["$set"]["email"], json!("a@example.com"));
        assert_eq!(ident.2["$set_once"]["atlas_device_id"], json!("device-uuid"));

        // Sign-in does NOT define the group — the active Organisation is a
        // local fact owned by `set_active_org`.
        assert!(
            !events.iter().any(|e| e.0 == "$groupidentify"),
            "identify must not group; the org layer owns that"
        );

        let after = events.last().expect("post-identify event");
        assert_eq!(after.0, "agent_turn_started");
        assert_eq!(after.1, "user-1");
    }

    /// Every event carries the active Organisation, whoever (or nobody) is
    /// signed in — that is the whole point of the org layer being separate.
    #[test]
    fn active_org_groups_every_event() {
        let (c, mut rx) = client(true, false);

        c.capture("app_started", json!({}));
        c.set_active_org(Some(OrgIdentity {
            id: "local-org-9".into(),
            kind: "local",
            name: None,
            role: None,
        }));
        c.capture("agent_turn_started", json!({}));

        let events = drain(&mut rx);
        assert!(
            events[0].2.get("$groups").is_none(),
            "no org set yet → ungrouped"
        );
        assert!(
            !events.iter().any(|e| e.0 == "$groupidentify"),
            "a local org is an opaque id — nothing to define"
        );

        let after = events.last().expect("post-org event");
        assert_eq!(after.2["$groups"]["organisation"], json!("local-org-9"));
        assert_eq!(after.2["atlas_org_id"], json!("local-org-9"));
        assert_eq!(after.2["atlas_org_kind"], json!("local"));
    }

    /// A synced org has a server-side name worth defining on the group; a local
    /// one deliberately travels as a bare id.
    #[test]
    fn a_synced_org_defines_the_group_and_a_local_one_does_not() {
        let (c, mut rx) = client(true, false);
        c.set_active_org(Some(OrgIdentity {
            id: "org-1".into(),
            kind: "cloud",
            name: Some("Acme".into()),
            role: Some("admin".into()),
        }));

        let events = drain(&mut rx);
        let group = events.iter().find(|e| e.0 == "$groupidentify").expect("group");
        assert_eq!(group.2["$group_key"], json!("org-1"));
        assert_eq!(group.2["$group_set"]["name"], json!("Acme"));
        assert_eq!(group.2["$group_set"]["role"], json!("admin"));
    }

    /// Re-seeding the same org must not re-emit: the startup seed and the
    /// store's first hydrate both fire on every launch.
    #[test]
    fn set_active_org_is_idempotent() {
        let (c, mut rx) = client(true, false);
        let org = OrgIdentity {
            id: "org-1".into(),
            kind: "cloud",
            name: Some("Acme".into()),
            role: None,
        };
        c.set_active_org(Some(org.clone()));
        c.set_active_org(Some(org));
        let groups = drain(&mut rx).into_iter().filter(|e| e.0 == "$groupidentify").count();
        assert_eq!(groups, 1);
    }

    /// Signing out does not move you out of the Organisation you have open, so
    /// the work either side of it must not land in two different buckets.
    #[test]
    fn signing_out_keeps_the_active_org() {
        let (c, mut rx) = client(true, false);
        c.set_active_org(Some(OrgIdentity {
            id: "org-1".into(),
            kind: "local",
            name: None,
            role: None,
        }));
        c.identify_account(&account("user-1"));
        c.reset_identity();
        c.capture("agent_turn_started", json!({}));

        let after = drain(&mut rx).pop().expect("post-signout event");
        assert_eq!(after.1, "device-uuid", "back to the device person");
        assert_eq!(after.2["$groups"]["organisation"], json!("org-1"));
    }

    /// `broadcast` re-syncs identity on every auth transition and on each launch
    /// revalidation, so a non-idempotent identify would emit a merge per launch.
    #[test]
    fn identify_is_idempotent() {
        let (c, mut rx) = client(true, false);
        c.identify_account(&account("user-1"));
        c.identify_account(&account("user-1"));
        let identifies = drain(&mut rx).into_iter().filter(|e| e.0 == "$identify").count();
        assert_eq!(identifies, 1);
    }

    /// Merging one account into another is irreversible in PostHog — it fuses
    /// two real people with no undo. Switching accounts must re-attribute going
    /// forward and leave history alone.
    #[test]
    fn identify_never_merges_two_accounts() {
        let (c, mut rx) = client(true, false);
        c.identify_account(&account("user-1"));
        c.identify_account(&account("user-2"));

        let identifies: Vec<_> = drain(&mut rx).into_iter().filter(|e| e.0 == "$identify").collect();
        assert_eq!(identifies.len(), 2);
        assert_eq!(identifies[0].2["$anon_distinct_id"], json!("device-uuid"));
        assert!(
            identifies[1].2.get("$anon_distinct_id").is_none(),
            "account→account switch must not carry a merge"
        );
    }

    #[test]
    fn reset_reverts_to_the_device_id() {
        let (c, mut rx) = client(true, false);
        c.identify_account(&account("user-1"));
        let _ = drain(&mut rx);

        c.reset_identity();
        assert_eq!(c.current_distinct_id(), "device-uuid");
        assert!(c.account_id().is_none());
        assert!(drain(&mut rx).is_empty(), "reset emits nothing itself");

        c.capture("app_started", json!({}));
        let ev = drain(&mut rx);
        assert_eq!(ev[0].1, "device-uuid");
        // No org was ever set here, so there is still nothing to group by —
        // but note that reset does NOT clear one that was; see
        // `signing_out_keeps_the_active_org`.
        assert!(ev[0].2.get("$groups").is_none());
    }

    /// The surviving half of ATL-52: signing in is not a telemetry backdoor. A
    /// user who has not opted in sends nothing extra as a result of it.
    #[test]
    fn auth_events_and_identify_are_gated_by_consent() {
        let (c, mut rx) = client(false, false);
        c.identify_account(&account("user-1"));
        c.capture_signed_in(2, true);
        c.capture_signed_out();
        assert!(
            rx.try_recv().is_err(),
            "nothing may be enqueued without consent"
        );
    }

    /// ...but the link isn't lost forever: opting in later sends the merge that
    /// was deferred, so the account doesn't become a second unrelated person.
    #[test]
    fn opt_in_drains_a_deferred_identify() {
        let (c, mut rx) = client(false, false);
        c.identify_account(&account("user-1"));
        assert_eq!(c.current_distinct_id(), "user-1", "identity still switches");

        c.set_enabled(true);
        let events = drain(&mut rx);
        assert_eq!(events[0].0, "telemetry_opt_in");
        let ident = events.iter().find(|e| e.0 == "$identify").expect("$identify");
        assert_eq!(ident.1, "user-1");
        assert_eq!(ident.2["$anon_distinct_id"], json!("device-uuid"));
    }

    /// `auth_signed_out` must be captured before `reset_identity` so it lands on
    /// the account it describes — see the ordering in `commands::auth`.
    #[test]
    fn signed_out_reports_whether_an_account_was_held() {
        let (c, mut rx) = client(true, false);
        c.identify_account(&account("user-1"));
        let _ = drain(&mut rx);

        c.capture_signed_out();
        let ev = drain(&mut rx);
        assert_eq!(ev[0].0, "auth_signed_out");
        assert_eq!(ev[0].1, "user-1");
        assert_eq!(ev[0].2["had_account"], json!(true));
    }
}
