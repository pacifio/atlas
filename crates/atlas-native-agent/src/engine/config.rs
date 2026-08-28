//! Assembling the engine's configuration.
//!
//! The spec puts this **in the seam**, not in `src-tauri` and not in the
//! engine: the seam is the only place that knows both Atlas's settings and the
//! engine's shape, and keeping it here is what lets `src-tauri` go on calling
//! nothing but the `AgentConnection` trait.
//!
//! Config reaches the engine two ways, and the split is not arbitrary:
//!
//! - **`ConfigOverrides`** for the things that have no config-file spelling.
//!   `codex_self_exe` is the load-bearing one — the engine's own docs say it
//!   "cannot be set in the config file: it must be set in code via
//!   `ConfigOverrides`". Sandbox and approval defaults ride along here too.
//! - **TOML overrides** for everything that *is* a config key: the provider
//!   definition and the analytics switch. Going through the documented key path
//!   means the engine's own `validate_model_providers` runs over what we built,
//!   so a malformed provider fails at config load with the engine's error rather
//!   than at the first request with ours.

use std::path::Path;
use std::path::PathBuf;

use anyhow::Context;
use anyhow::Result;
use codex_core::config::Config;
use codex_core::config::ConfigBuilder;
use codex_core::config::ConfigOverrides;
use codex_protocol::config_types::SandboxMode;
use codex_protocol::protocol::AskForApproval;
use toml::Value as TomlValue;

/// The engine's own `DEFAULT_STREAM_MAX_RETRIES`, restated so the seam can
/// report it without reaching into the provider crate's private constant.
pub const DEFAULT_STREAM_MAX_RETRIES: usize = 5;

/// The engine's private working directory.
///
/// A newtype because getting this wrong is silent and bad. Starting the runtime
/// calls `resolve_installation_id`, which is **not a read**: it `create_dir_all`s
/// this path and creates a `0644` installation-id file inside it. So this must
/// be a directory Atlas owns.
///
/// It is emphatically **not** `~/.codex`. Pointing it there would have the app
/// adopt, and write into, the user's real Codex CLI state.
///
/// Everything under here is engine-private working storage in D9's sense: the
/// engine may keep rollouts and its own SQLite here, and no history or sidebar
/// reader is ever pointed at it. Those keep reading the app-owned
/// thread-metadata store (ADR-0001).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineHome(PathBuf);

impl EngineHome {
    /// The engine's home inside Atlas's own config directory.
    ///
    /// `config_dir` is what the Cersei path is handed today, so both engines
    /// keep their state under the same Atlas-owned root and a profile wipe
    /// takes both.
    pub fn under_config_dir(config_dir: &Path) -> Self {
        Self(config_dir.join("atlas-agent").join("engine"))
    }

    /// An explicit path, for tests that want a tempdir.
    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self(path.into())
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

/// Which wire format a provider speaks.
///
/// Both arms exist now. `Responses` is the engine's own dialect, which the
/// Phase 2 dev provider uses; `Chat` is the Atlas gateway dialect authored in
/// Phase 3 (D3), reinstated in the engine as `WireApi::Chat` after upstream
/// removed it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireDialect {
    Responses,
    Chat,
}

impl WireDialect {
    fn as_config_value(self) -> &'static str {
        match self {
            Self::Responses => "responses",
            Self::Chat => "chat",
        }
    }
}

/// The provider the engine talks to.
///
/// In Phase 2 this is a developer-configured provider carrying the turn. In
/// Phase 3 it becomes the Atlas gateway on the Chat Completions dialect.
#[derive(Debug, Clone)]
pub struct EngineProvider {
    /// The key this provider is registered under in `model_providers`.
    pub id: String,
    /// Display name.
    pub name: String,
    pub base_url: String,
    pub wire: WireDialect,
    /// The environment variable holding the key, when the provider is
    /// key-authenticated rather than account-authenticated.
    ///
    /// `None` is the D10 shape: auth arrives through the `ExternalAuth`
    /// provider instead, resolved per request.
    pub env_key: Option<String>,
}

/// Where the gateway lives.
pub const GATEWAY_BASE_URL: &str = "https://ai.tryatlas.cc/v1";

/// The id the gateway provider is registered under.
pub const GATEWAY_PROVIDER_ID: &str = "atlas";

impl EngineProvider {
    /// A developer-configured provider for the Phase 2 tracer bullet.
    pub fn dev(id: impl Into<String>, base_url: impl Into<String>, env_key: Option<String>) -> Self {
        let id = id.into();
        Self {
            name: id.clone(),
            id,
            base_url: base_url.into(),
            wire: WireDialect::Responses,
            env_key,
        }
    }

    /// The Atlas gateway (D3), authenticated by the D10 token provider.
    ///
    /// No `env_key`: naming one would give the engine a second place to look
    /// for a credential, and the one it found there would be static — no
    /// refresh, no `401` recovery, and therefore a session that dies at the
    /// ten-minute token TTL.
    pub fn gateway(base_url: impl Into<String>) -> Self {
        Self {
            id: GATEWAY_PROVIDER_ID.to_string(),
            name: "Atlas".to_string(),
            base_url: base_url.into(),
            wire: WireDialect::Chat,
            env_key: None,
        }
    }
}

/// Everything the seam decides about how the engine runs.
#[derive(Debug, Clone)]
pub struct EngineSettings {
    pub home: EngineHome,
    pub provider: EngineProvider,
    pub model: String,
    /// The session's working directory.
    pub cwd: PathBuf,
    /// The path to Atlas's own executable.
    ///
    /// Sandboxed execution on macOS re-enters this binary, so the engine has to
    /// be told what it is. This is the single process-level assumption in the
    /// whole embedding, and it has an explicit code-level seam precisely so an
    /// embedder can satisfy it without adopting the engine's argv0 dispatch.
    pub self_exe: Option<PathBuf>,
    pub approval_policy: AskForApproval,
    pub sandbox_mode: SandboxMode,
    /// How many times the engine retries a dropped stream.
    ///
    /// Held here as well as in the provider config because the retry pill
    /// renders "attempt N of M" and the seam is the only thing that knows M
    /// — the engine's stream-error notification does not carry it (D8).
    /// `5` is the engine's own `DEFAULT_STREAM_MAX_RETRIES`.
    pub stream_max_retries: usize,
}

impl EngineSettings {
    pub fn new(home: EngineHome, provider: EngineProvider, model: impl Into<String>, cwd: PathBuf) -> Self {
        Self {
            home,
            provider,
            model: model.into(),
            cwd,
            self_exe: std::env::current_exe().ok(),
            // D5: the sandbox is on from day one on macOS, in the engine's own
            // default approval/sandbox mode. `WorkspaceWrite` plus
            // `OnRequest` is that default — writes confined to the workspace,
            // anything else routed to the approval dialog Atlas already has.
            approval_policy: AskForApproval::OnRequest,
            sandbox_mode: SandboxMode::WorkspaceWrite,
            stream_max_retries: DEFAULT_STREAM_MAX_RETRIES,
        }
    }

    /// Lowers the stream-retry ceiling, so a test can reach exhaustion without
    /// waiting out five backoffs.
    pub fn with_stream_max_retries(mut self, retries: usize) -> Self {
        self.stream_max_retries = retries;
        self
    }

    /// Settings for a development-time run, read from the environment.
    ///
    /// Phase 2's tracer bullet is carried by "a dev-configured provider … until
    /// the gateway dialect lands", so the provider is a developer's choice
    /// rather than a product decision, and the environment is where a developer
    /// makes it. Every value has a working default so the switch does something
    /// sensible with nothing set.
    ///
    /// This is deliberately **not** how the shipped agent will be configured.
    /// In Phase 3 the provider becomes the Atlas gateway and the credential
    /// becomes the D10 token provider; these variables go away with the switch.
    pub fn from_env(config_dir: &Path, cwd: PathBuf) -> Self {
        let base_url = std::env::var("ATLAS_ENGINE_BASE_URL")
            .unwrap_or_else(|_| "https://api.openai.com/v1".to_string());
        let model =
            std::env::var("ATLAS_ENGINE_MODEL").unwrap_or_else(|_| "gpt-5-codex".to_string());
        // Named rather than read: the engine resolves the variable itself, so
        // the key never passes through Atlas.
        let env_key = std::env::var("ATLAS_ENGINE_API_KEY_ENV")
            .unwrap_or_else(|_| "OPENAI_API_KEY".to_string());

        Self::new(
            EngineHome::under_config_dir(config_dir),
            EngineProvider::dev("atlas-dev", base_url, Some(env_key)),
            model,
            cwd,
        )
    }

    /// The overrides that have no config-file spelling.
    pub fn config_overrides(&self) -> ConfigOverrides {
        ConfigOverrides {
            model: Some(self.model.clone()),
            model_provider: Some(self.provider.id.clone()),
            cwd: Some(self.cwd.clone()),
            approval_policy: Some(self.approval_policy),
            sandbox_mode: Some(self.sandbox_mode),
            codex_self_exe: self.self_exe.clone(),
            ..Default::default()
        }
    }

    /// The config-file-shaped overrides: the provider, and analytics off.
    ///
    /// Ordered and deterministic so a test can assert on the whole vector.
    pub fn cli_overrides(&self) -> Vec<(String, TomlValue)> {
        let p = &self.provider;
        let key = |suffix: &str| format!("model_providers.{}.{suffix}", p.id);
        let mut out = vec![
            (key("name"), TomlValue::String(p.name.clone())),
            (key("base_url"), TomlValue::String(p.base_url.clone())),
            (
                key("wire_api"),
                TomlValue::String(p.wire.as_config_value().to_string()),
            ),
            // D10: the engine's own login surface stays off. With this false
            // the engine never presents a login screen, and auth comes from
            // whatever the seam installed.
            (key("requires_openai_auth"), TomlValue::Boolean(false)),
            // D2. The analytics client's upload paths are gone from the fork
            // outright, so this is belt-and-braces rather than the mechanism —
            // but a config that says "off" is what makes the intent legible to
            // the next person reading it.
            ("analytics.enabled".to_string(), TomlValue::Boolean(false)),
            // Set explicitly so the number the retry pill shows is the number
            // the engine actually uses. Left implicit, the two could drift and
            // the pill would count past its own maximum.
            (
                key("stream_max_retries"),
                TomlValue::Integer(self.stream_max_retries as i64),
            ),
        ];
        if let Some(env_key) = &p.env_key {
            out.push((key("env_key"), TomlValue::String(env_key.clone())));
        }
        if p.wire == WireDialect::Chat {
            // The transport layer retries every 5xx blindly, up to four times,
            // *inside* each turn-level retry — which is how a `503` meaning
            // "Atlas's own spend backstop tripped" gets hit around thirty times
            // by a client that was told to stop. The D13 arm is what decides
            // whether a gateway error is worth another request, and it cannot
            // decide anything the transport already did. Zero here means one
            // attempt, and the classification owns the rest.
            //
            // This also switches off transport-level retry of *connection*
            // failures, which is a real loss and an accepted one: a dropped
            // connection surfaces as `ConnectionFailed`, which the turn loop
            // already treats as retryable, so the retry still happens — one
            // layer up, where the retry pill can show it.
            out.push((key("request_max_retries"), TomlValue::Integer(0)));
            // The gateway's `/models` is stock-OpenAI shaped and the engine's
            // fetch cannot read it, so the catalogue is authored and read from
            // disk (D3). `build_config` writes the file before this path is
            // used, because a missing one fails config load outright.
            out.push((
                "model_catalog_json".to_string(),
                TomlValue::String(self.home.path().join("models.json").display().to_string()),
            ));
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    /// Settings for the shipped agent: the Atlas gateway, on the D3 dialect.
    ///
    /// The credential is not here and never will be — it arrives through the
    /// D10 `ExternalAuth` provider, resolved per request.
    pub fn gateway(config_dir: &Path, cwd: PathBuf) -> Self {
        Self::new(
            EngineHome::under_config_dir(config_dir),
            EngineProvider::gateway(GATEWAY_BASE_URL),
            crate::engine::catalog::DEFAULT_MODEL,
            cwd,
        )
    }

    /// Loads the engine's `Config` with everything above applied.
    pub async fn build_config(&self) -> Result<Config> {
        tokio::fs::create_dir_all(self.home.path())
            .await
            .with_context(|| {
                format!(
                    "creating the engine's private home at {}",
                    self.home.path().display()
                )
            })?;

        if self.provider.wire == WireDialect::Chat {
            // Written before the config is loaded, not after: `model_catalog_json`
            // names a path the loader reads immediately, and a missing file is a
            // config-load failure rather than a fallback to the bundled catalogue.
            crate::engine::catalog::write_catalog(self.home.path()).await?;
        }

        ConfigBuilder::default()
            .codex_home(self.home.path().to_path_buf())
            .cli_overrides(self.cli_overrides())
            .harness_overrides(self.config_overrides())
            .fallback_cwd(Some(self.cwd.clone()))
            .build()
            .await
            .map_err(anyhow::Error::from)
            .context("loading the ported engine's configuration")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(tmp: &Path) -> EngineSettings {
        EngineSettings::new(
            EngineHome::at(tmp.join("engine")),
            EngineProvider::dev("atlas-dev", "https://example.invalid/v1", None),
            "gpt-5-codex",
            tmp.to_path_buf(),
        )
    }

    #[test]
    fn the_engine_home_is_atlas_owned_and_never_the_users_codex_cli_state() {
        // Starting the runtime writes an installation-id file into this
        // directory. Pointing it at ~/.codex would make Atlas write into the
        // user's real Codex CLI state.
        let home = EngineHome::under_config_dir(Path::new("/Users/somebody/Library/atlas"));
        assert!(home.path().starts_with("/Users/somebody/Library/atlas"));
        assert!(!home.path().to_string_lossy().contains(".codex"));
    }

    #[test]
    fn the_provider_is_registered_under_its_own_key_with_the_login_surface_off() {
        let tmp = std::env::temp_dir();
        let overrides = settings(&tmp).cli_overrides();
        let get = |k: &str| {
            overrides
                .iter()
                .find(|(key, _)| key == k)
                .map(|(_, v)| v.clone())
        };

        assert_eq!(
            get("model_providers.atlas-dev.base_url"),
            Some(TomlValue::String("https://example.invalid/v1".into())),
        );
        assert_eq!(
            get("model_providers.atlas-dev.wire_api"),
            Some(TomlValue::String("responses".into())),
        );
        // D10: never show the engine's own login screen.
        assert_eq!(
            get("model_providers.atlas-dev.requires_openai_auth"),
            Some(TomlValue::Boolean(false)),
        );
        // D2.
        assert_eq!(get("analytics.enabled"), Some(TomlValue::Boolean(false)));
    }

    #[test]
    fn an_account_authenticated_provider_declares_no_env_key() {
        // The D10 shape: no `env_key`, because auth arrives through the
        // ExternalAuth provider rather than the environment. An env_key here
        // would give the engine a second, staler place to find a credential.
        let tmp = std::env::temp_dir();
        let overrides = settings(&tmp).cli_overrides();
        assert!(
            !overrides.iter().any(|(k, _)| k.ends_with(".env_key")),
            "an account-authenticated provider must not name an env key",
        );

        let keyed = EngineSettings::new(
            EngineHome::at(tmp.join("engine")),
            EngineProvider::dev("byok", "https://example.invalid/v1", Some("DEV_KEY".into())),
            "gpt-5-codex",
            tmp.clone(),
        );
        assert!(
            keyed
                .cli_overrides()
                .iter()
                .any(|(k, v)| k == "model_providers.byok.env_key"
                    && v == &TomlValue::String("DEV_KEY".into())),
        );
    }

    #[test]
    fn the_self_exe_path_is_injected_because_the_config_file_cannot_carry_it() {
        // The engine re-enters this binary for sandboxed execution and the key
        // has no config-file spelling, so it has to arrive through
        // ConfigOverrides or not at all.
        let tmp = std::env::temp_dir();
        let overrides = settings(&tmp).config_overrides();
        assert_eq!(overrides.codex_self_exe, std::env::current_exe().ok());
        assert!(overrides.codex_self_exe.is_some(), "current_exe must resolve in a test binary");
    }

    #[test]
    fn the_sandbox_is_on_by_default() {
        // D5: on from day one, in the engine's default mode. A regression here
        // is a silently unsandboxed agent, which no test failure would
        // otherwise announce.
        let tmp = std::env::temp_dir();
        let s = settings(&tmp);
        assert_eq!(s.sandbox_mode, SandboxMode::WorkspaceWrite);
        assert!(matches!(s.approval_policy, AskForApproval::OnRequest));
    }

    #[test]
    fn the_dev_provider_names_an_env_key_rather_than_reading_one() {
        // The engine resolves the variable itself. Reading the key here would
        // put a live credential through Atlas's own memory for no reason.
        let s = EngineSettings::from_env(Path::new("/tmp/atlas"), PathBuf::from("/tmp"));
        let overrides = s.cli_overrides();
        let env_key = overrides
            .iter()
            .find(|(k, _)| k.ends_with(".env_key"))
            .map(|(_, v)| v.clone());
        assert!(env_key.is_some(), "a dev provider authenticates by env key");
        assert!(
            !overrides
                .iter()
                .any(|(_, v)| matches!(v, TomlValue::String(s) if s.starts_with("sk-"))),
            "no credential value may appear in the engine's config",
        );
    }

    #[tokio::test]
    async fn build_config_creates_the_home_and_resolves_the_provider() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let s = settings(tmp.path());
        let config = s.build_config().await.expect("config should load");

        assert!(s.home.path().is_dir(), "the engine home must exist after build");
        assert_eq!(config.model.as_deref(), Some("gpt-5-codex"));
        assert_eq!(
            config.model_provider.base_url.as_deref(),
            Some("https://example.invalid/v1"),
        );
        assert!(
            !config.model_provider.requires_openai_auth,
            "the engine's own login surface must stay off (D10)",
        );
        assert_eq!(config.analytics_enabled, Some(false));
    }

    #[test]
    fn the_gateway_provider_speaks_the_chat_dialect_and_names_no_key() {
        // D3 and D10 in one row. An `env_key` here would give the engine a
        // second, static place to find a credential — and static means no
        // refresh and no 401 recovery, so every session would die at the
        // ten-minute token TTL.
        let s = EngineSettings::gateway(Path::new("/tmp/atlas"), PathBuf::from("/tmp"));
        let overrides = s.cli_overrides();
        let get = |k: &str| {
            overrides
                .iter()
                .find(|(key, _)| key == k)
                .map(|(_, v)| v.clone())
        };
        assert_eq!(
            get("model_providers.atlas.wire_api"),
            Some(TomlValue::String("chat".into())),
        );
        assert!(
            !overrides.iter().any(|(k, _)| k.ends_with(".env_key")),
            "the gateway authenticates by minted token, never by a stored key",
        );
        assert_eq!(s.model, crate::engine::catalog::DEFAULT_MODEL);
    }

    #[test]
    fn the_transport_does_not_retry_underneath_the_classification_arm() {
        // The trap this closes: the transport retries every 5xx blindly, four
        // times, *inside* each turn-level retry. So a 503 meaning "Atlas's own
        // spend backstop tripped" — the one status whose meaning is that every
        // retry makes it worse — gets hit about thirty times by a client that
        // was told to stop.
        let s = EngineSettings::gateway(Path::new("/tmp/atlas"), PathBuf::from("/tmp"));
        assert_eq!(
            s.cli_overrides()
                .iter()
                .find(|(k, _)| k == "model_providers.atlas.request_max_retries")
                .map(|(_, v)| v.clone()),
            Some(TomlValue::Integer(0)),
        );

        // And not on the dev provider, which classifies errors upstream's way.
        let dev = EngineSettings::from_env(Path::new("/tmp/atlas"), PathBuf::from("/tmp"));
        assert!(
            !dev.cli_overrides()
                .iter()
                .any(|(k, _)| k.ends_with(".request_max_retries")),
        );
    }

    #[tokio::test]
    async fn the_authored_catalogue_is_on_disk_before_the_config_reads_it() {
        // `model_catalog_json` names a path the loader reads immediately; a
        // missing file is a config-load failure, not a quiet fallback to the
        // bundled catalogue. So the write has to happen first, and the failure
        // if it does not is "the agent will not start" rather than "the wrong
        // models are listed".
        let Ok(tmp) = tempfile::tempdir() else {
            panic!("tempdir");
        };
        let mut s = EngineSettings::gateway(tmp.path(), tmp.path().to_path_buf());
        s.home = EngineHome::at(tmp.path().join("engine"));

        let config = match s.build_config().await {
            Ok(config) => config,
            Err(err) => panic!("the gateway config must load: {err:#}"),
        };
        assert!(s.home.path().join("models.json").is_file());

        let Some(catalog) = config.model_catalog else {
            panic!("the engine must have loaded the authored catalogue");
        };
        assert!(
            catalog
                .models
                .iter()
                .any(|m| m.slug == crate::engine::catalog::DEFAULT_MODEL),
            "the default model has to be selectable",
        );
    }
}
