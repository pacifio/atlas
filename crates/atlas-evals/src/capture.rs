//! Capture of the `atlas::harness` tracing line (decision 6: the runner
//! consumes the same telemetry schema the product emits, instead of
//! inventing its own).
//!
//! [`HarnessCapture`] is a [`tracing_subscriber::Layer`] that collects every
//! `target: "atlas::harness"` event into a shared vector; the runner drains
//! it after each `send_prompt`. The field inventory mirrors
//! `atlas-cersei/src/lib.rs` (`send_prompt_at_depth`'s closing line) — a
//! renamed field there shows up here as a zero, which the round-trip test in
//! this module is designed to catch.

use std::sync::{Arc, Mutex};

use tracing::field::{Field, Visit};
use tracing_subscriber::layer::Context;
use tracing_subscriber::Layer;

/// One `atlas::harness` "turn" line, decoded.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct HarnessTurn {
    pub turn_id: u64,
    pub edit_calls: u64,
    pub edit_strategy_used: String,
    pub edit_not_found: u64,
    pub doom_loop_triggers: u64,
    pub steered: u64,
    pub retries: u64,
    pub compaction_events: u64,
    pub permission_asks: u64,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub wall_clock_ms: u64,
    pub stop: String,
}

/// Shared collector + the layer that feeds it. Clone freely; all clones
/// drain the same buffer.
#[derive(Clone, Default)]
pub struct HarnessCapture {
    turns: Arc<Mutex<Vec<HarnessTurn>>>,
}

impl HarnessCapture {
    pub fn new() -> Self {
        Self::default()
    }

    /// Take everything captured since the last drain.
    pub fn drain(&self) -> Vec<HarnessTurn> {
        std::mem::take(&mut self.turns.lock().expect("capture lock"))
    }
}

impl<S: tracing::Subscriber> Layer<S> for HarnessCapture {
    fn on_event(&self, event: &tracing::Event<'_>, _ctx: Context<'_, S>) {
        if event.metadata().target() != "atlas::harness" {
            return;
        }
        let mut turn = HarnessTurn::default();
        event.record(&mut TurnVisitor(&mut turn));
        self.turns.lock().expect("capture lock").push(turn);
    }
}

struct TurnVisitor<'a>(&'a mut HarnessTurn);

impl Visit for TurnVisitor<'_> {
    fn record_u64(&mut self, field: &Field, value: u64) {
        match field.name() {
            "turn_id" => self.0.turn_id = value,
            "edit_calls" => self.0.edit_calls = value,
            "edit_not_found" => self.0.edit_not_found = value,
            "doom_loop_triggers" => self.0.doom_loop_triggers = value,
            "steered" => self.0.steered = value,
            "retries" => self.0.retries = value,
            "compaction_events" => self.0.compaction_events = value,
            "permission_asks" => self.0.permission_asks = value,
            "tokens_in" => self.0.tokens_in = value,
            "tokens_out" => self.0.tokens_out = value,
            "wall_clock_ms" => self.0.wall_clock_ms = value,
            _ => {}
        }
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        if let Ok(v) = u64::try_from(value) {
            self.record_u64(field, v);
        }
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        match field.name() {
            "edit_strategy_used" => self.0.edit_strategy_used = value.to_string(),
            "stop" => self.0.stop = value.to_string(),
            _ => {}
        }
    }

    // `%`-recorded (Display) fields arrive here on tracing's default path.
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        match field.name() {
            "edit_strategy_used" | "stop" => {
                let raw = format!("{value:?}");
                self.record_str(field, raw.trim_matches('"'));
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing_subscriber::layer::SubscriberExt;

    /// Emits the exact field inventory `send_prompt_at_depth` emits. If the
    /// product line and this test drift apart, the capture layer is
    /// silently dropping data — keep them in sync by hand.
    fn emit_product_shaped_line() {
        tracing::info!(
            target: "atlas::harness",
            turn_id = 3u64,
            edit_calls = 5u64,
            edit_strategy_used = %"line_trimmed,block_anchor",
            edit_not_found = 1u64,
            doom_loop_triggers = 0u64,
            steered = 2u64,
            retries = 1u64,
            compaction_events = 0u64,
            permission_asks = 4u64,
            tokens_in = 1000u64,
            tokens_out = 250u64,
            wall_clock_ms = 4200u64,
            stop = %"end_turn",
            "turn"
        );
    }

    #[test]
    fn a_product_shaped_harness_line_round_trips_through_the_layer() {
        let capture = HarnessCapture::new();
        let subscriber = tracing_subscriber::registry().with(capture.clone());
        tracing::subscriber::with_default(subscriber, emit_product_shaped_line);

        let turns = capture.drain();
        assert_eq!(turns.len(), 1);
        let t = &turns[0];
        assert_eq!(
            *t,
            HarnessTurn {
                turn_id: 3,
                edit_calls: 5,
                edit_strategy_used: "line_trimmed,block_anchor".into(),
                edit_not_found: 1,
                doom_loop_triggers: 0,
                steered: 2,
                retries: 1,
                compaction_events: 0,
                permission_asks: 4,
                tokens_in: 1000,
                tokens_out: 250,
                wall_clock_ms: 4200,
                stop: "end_turn".into(),
            }
        );
    }

    #[test]
    fn other_targets_are_ignored_and_drain_empties_the_buffer() {
        let capture = HarnessCapture::new();
        let subscriber = tracing_subscriber::registry().with(capture.clone());
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(target: "atlas::retrieval", n_results = 2u64, "retrieval");
            emit_product_shaped_line();
        });
        assert_eq!(capture.drain().len(), 1);
        assert!(capture.drain().is_empty());
    }
}
