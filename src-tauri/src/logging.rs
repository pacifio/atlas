//! Global tracing subscriber installer.
//!
//! Routes `tracing::info!` / `warn!` / `error!` calls from anywhere in the
//! Rust workspace to stderr. Verbosity is controlled by the `RUST_LOG`
//! environment variable; default is `atlas=info,atlas_acp_thread=info,atlas_agent_servers=info,atlas_agent_store=info,info`.
//!
//! Examples:
//! ```bash
//! npx tauri dev                                          # default verbosity
//! RUST_LOG=atlas=debug,tauri=debug npx tauri dev         # crank up
//! RUST_LOG=trace npx tauri dev                           # everything
//! ```

use tracing_subscriber::EnvFilter;

pub fn init() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        EnvFilter::new("atlas=info,atlas_acp_thread=info,atlas_agent_servers=info,atlas_agent_store=info,info")
    });

    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(true)
        .with_thread_ids(false)
        .with_file(false)
        .with_line_number(false)
        .with_writer(std::io::stderr)
        .compact()
        .try_init();
}
