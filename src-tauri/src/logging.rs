//! Global tracing subscriber installer.
//!
//! Routes `tracing::info!` / `warn!` / `error!` calls from anywhere in the
//! Rust workspace to stderr. Verbosity is controlled by the `RUST_LOG`
//! environment variable; default is `atlas=info,atlas_acp=info,atlas_agents=info,info`.
//!
//! Examples:
//! ```bash
//! npx tauri dev                                          # default verbosity
//! RUST_LOG=atlas=debug,tauri=debug npx tauri dev         # crank up
//! RUST_LOG=trace npx tauri dev                           # everything
//! ```

use tracing_subscriber::prelude::*;
use tracing_subscriber::EnvFilter;

pub fn init() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        EnvFilter::new("atlas=info,atlas_acp=info,atlas_agents=info,info")
    });

    let fmt_layer = tracing_subscriber::fmt::layer()
        .with_target(true)
        .with_thread_ids(false)
        .with_file(false)
        .with_line_number(false)
        .with_writer(std::io::stderr)
        .compact();

    // The telemetry bridge forwards `atlas::harness` counter lines to PostHog
    // (consent-gated, whitelist in telemetry/bridge.rs). It sits under the
    // same EnvFilter as the console output: the default filter's `info`
    // catch-all admits the lines it needs.
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(fmt_layer)
        .with(crate::telemetry::bridge::HarnessTelemetryBridge)
        .try_init();
}
