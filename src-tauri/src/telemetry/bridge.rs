//! Bridges the `atlas::harness` tracing target into PostHog.
//!
//! The per-turn line is emitted inside `atlas-cersei`, which has no telemetry
//! dependency (and must not — the counters belong to the crate, the consent
//! gate to the app). This layer watches for that line and forwards its
//! counter fields as one `harness_turn` event. Counters only: the line
//! carries no content by construction, and the whitelist below is the
//! enforcement — a field added to the line does not reach PostHog until it is
//! added here AND to the `TELEMETRY.md` catalogue.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, Layer};

use super::TelemetryClient;

static CLIENT: OnceLock<Arc<TelemetryClient>> = OnceLock::new();

/// Hand the layer its client once it exists — the subscriber installs at
/// process start, before Tauri manages the client. Until then (and in builds
/// where telemetry is inert) the layer drops events; the tracing line itself
/// is unaffected.
pub fn install_client(client: Arc<TelemetryClient>) {
    let _ = CLIENT.set(client);
}

/// Counter fields forwarded to PostHog. Everything else on the line —
/// including `edit_strategy_used` (strategy names) and `stop` — stays local.
const FORWARDED: &[&str] = &[
    "edit_calls",
    "edit_not_found",
    "doom_loop_triggers",
    "steered",
    "retries",
    "compaction_events",
    "permission_asks",
    "tokens_in",
    "tokens_out",
    "wall_clock_ms",
];

pub struct HarnessTelemetryBridge;

impl<S: Subscriber> Layer<S> for HarnessTelemetryBridge {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        if event.metadata().target() != "atlas::harness" {
            return;
        }
        let Some(client) = CLIENT.get() else { return };
        let mut counters = CounterVisitor::default();
        event.record(&mut counters);
        let mut props = serde_json::Map::new();
        for key in FORWARDED {
            if let Some(v) = counters.0.get(*key) {
                props.insert((*key).to_string(), serde_json::json!(v));
            }
        }
        if !props.is_empty() {
            client.capture("harness_turn", serde_json::Value::Object(props));
        }
    }
}

/// Collects only numeric fields; string/debug fields are ignored by design.
#[derive(Default)]
struct CounterVisitor(HashMap<&'static str, u64>);

impl Visit for CounterVisitor {
    fn record_u64(&mut self, field: &Field, value: u64) {
        self.0.insert(field.name(), value);
    }
    fn record_i64(&mut self, field: &Field, value: i64) {
        if value >= 0 {
            self.0.insert(field.name(), value as u64);
        }
    }
    fn record_debug(&mut self, _field: &Field, _value: &dyn std::fmt::Debug) {}
}
