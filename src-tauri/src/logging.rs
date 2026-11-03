//! Global tracing subscriber installer.
//!
//! Routes `tracing::info!` / `warn!` / `error!` calls from anywhere in the
//! Rust project to stderr AND to a daily-rotated log file. Verbosity is
//! controlled by the `RUST_LOG` environment variable; default is
//! `atlas=info,atlas_acp_thread=info,atlas_agent_servers=info,atlas_agent_store=info,info`.
//!
//! The file sink exists because a Finder-launched `.app` has no stderr: every
//! customer report of an agent that "never starts" arrived with nothing to
//! read, even though the connect / `session/new` phases are logged at info.
//! The file lives where macOS puts app logs (`~/Library/Logs/<bundle id>`,
//! the same directory Tauri's `app_log_dir` resolves to), so Console.app and
//! a support request can find it without knowing anything about Atlas.
//!
//! Examples:
//! ```bash
//! npx tauri dev                                          # default verbosity
//! RUST_LOG=atlas=debug,tauri=debug npx tauri dev         # crank up
//! RUST_LOG=trace npx tauri dev                           # everything
//! tail -f ~/Library/Logs/dev.atlas.ide/atlas.*.log       # the shipped app
//! ```

use std::path::PathBuf;
use std::sync::OnceLock;

use tracing_subscriber::layer::SubscriberExt as _;
use tracing_subscriber::util::SubscriberInitExt as _;
use tracing_subscriber::EnvFilter;

use crate::state::atlas_config::{
    config_root, CONFIG_FILE_NAME, DEFAULT_LOG_RETENTION_DAYS, MAX_LOG_RETENTION_DAYS,
    MIN_LOG_RETENTION_DAYS,
};

const LOG_FILE_PREFIX: &str = "atlas";

static LOG_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Where the rolling log files are written, when a file sink was installed.
pub fn log_dir() -> Option<PathBuf> {
    LOG_DIR.get().cloned().flatten()
}

/// The subscriber is installed before a Tauri handle exists, so the path is
/// derived rather than resolved — from the profile's bundle identifier
/// (`dev.atlas.ide`, or `dev.atlas.ide.dev` for the dev profile), which is the
/// `identifier` the app was built with. `run()` fixes the profile before
/// calling [`init`].
fn default_log_dir() -> Option<PathBuf> {
    let bundle_id = atlas_profile::current().identifier();
    if cfg!(target_os = "macos") {
        dirs::home_dir().map(|home| home.join("Library").join("Logs").join(bundle_id))
    } else {
        dirs::data_local_dir().map(|dir| dir.join(bundle_id).join("logs"))
    }
}

/// How many daily log files to keep: `logRetentionDays` from `config.toml`.
///
/// The file sink is installed before the config is loaded (so the loading
/// itself is logged), which is why this reads the one key straight from the
/// file. A missing file, unparsable TOML, or a value outside the setting's
/// bounds keeps the default, as the config loader would reject it too. The
/// appender prunes when it is built, so lowering the value removes the older
/// files at the next launch.
fn log_retention_days() -> usize {
    let text = config_root()
        .map(|root| root.join(CONFIG_FILE_NAME))
        .and_then(|path| std::fs::read_to_string(path).ok());
    retention_days_in(text.as_deref()) as usize
}

fn retention_days_in(config: Option<&str>) -> u32 {
    config
        .and_then(|text| text.parse::<toml::Table>().ok())
        .and_then(|doc| doc.get("settings")?.get("logRetentionDays")?.as_integer())
        .and_then(|days| u32::try_from(days).ok())
        .filter(|days| (MIN_LOG_RETENTION_DAYS..=MAX_LOG_RETENTION_DAYS).contains(days))
        .unwrap_or(DEFAULT_LOG_RETENTION_DAYS)
}

pub fn init() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        EnvFilter::new(
            "atlas=info,atlas_acp_thread=info,atlas_agent_servers=info,atlas_agent_store=info,info",
        )
    });

    let stderr_layer = tracing_subscriber::fmt::layer()
        .with_target(true)
        .with_thread_ids(false)
        .with_file(false)
        .with_line_number(false)
        .with_writer(std::io::stderr)
        .compact();

    // Blocking writes on purpose: the volume at info is a few lines per
    // agent action, and a non-blocking worker loses its tail when the app
    // leaves through `process::exit`, which skips `Drop` — exactly the moment
    // a stuck-start log is worth having.
    let file_layer = default_log_dir().and_then(|dir| {
        std::fs::create_dir_all(&dir).ok()?;
        let appender = tracing_appender::rolling::Builder::new()
            .rotation(tracing_appender::rolling::Rotation::DAILY)
            .filename_prefix(LOG_FILE_PREFIX)
            .filename_suffix("log")
            .max_log_files(log_retention_days())
            .build(&dir)
            .ok()?;
        let _ = LOG_DIR.set(Some(dir));
        Some(
            tracing_subscriber::fmt::layer()
                .with_target(true)
                .with_thread_ids(false)
                .with_file(false)
                .with_line_number(false)
                .with_ansi(false)
                .with_writer(appender)
                .compact(),
        )
    });
    if file_layer.is_none() {
        let _ = LOG_DIR.set(None);
    }

    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(stderr_layer)
        .with(file_layer)
        .try_init();

    if let Some(dir) = log_dir() {
        tracing::info!(dir = %dir.display(), version = env!("CARGO_PKG_VERSION"), "log file sink installed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_settings(line: &str) -> String {
        format!("[settings]\n{line}\n")
    }

    #[test]
    fn retention_reads_the_setting_and_falls_back_to_the_default() {
        let days = |toml: &str| retention_days_in(Some(toml));
        for kept in [1, 30, 90] {
            assert_eq!(
                days(&with_settings(&format!("logRetentionDays = {kept}"))),
                kept
            );
        }

        // Anything the config loader would reject keeps the default.
        for rejected in [
            with_settings("logRetentionDays = 0"),
            with_settings("logRetentionDays = 91"),
            with_settings("logRetentionDays = -3"),
            with_settings("logRetentionDays = \"30\""),
            with_settings("showHiddenFiles = false"),
            "logRetentionDays = 30\n".to_string(),
            "not toml [".to_string(),
        ] {
            assert_eq!(days(&rejected), DEFAULT_LOG_RETENTION_DAYS, "{rejected:?}");
        }
        assert_eq!(retention_days_in(None), DEFAULT_LOG_RETENTION_DAYS);
    }
}
