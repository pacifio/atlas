//! Rust-owned persisted state.
//!
//! Replaces the zustand `persist` middleware that previously stored
//! `currentProject` + `recentProjects` in the WebView's localStorage. The
//! frontend now reads this state in one shot via the
//! `bootstrap_app_state` Tauri command at app start, and writes via
//! `save_app_state` (debounced from the project store actions).
//!
//! Storage path: `<app_data_dir>/state.json`
//!   macOS:   `~/Library/Application Support/dev.atlas.ide/state.json`
//!   Linux:   `~/.local/share/dev.atlas.ide/state.json`
//!   Windows: `%APPDATA%\dev.atlas.ide\state.json`

pub mod app_state;
pub mod atlas_config;

pub use app_state::{AppState, AppStateHandle, AppStatePatch};
pub use atlas_config::{
    AppSettings, AtlasConfigHandle, ConfigError, ConfigSnapshot, ConfigStatus, SettingsPatch,
    UpdateOutcome,
};
