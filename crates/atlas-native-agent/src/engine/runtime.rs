//! Starting the engine in-process.
//!
//! ADR-0004's surface, in one function. Everything the stdio transport would
//! assemble from ambient process state is passed in here explicitly, because
//! the in-process entry performs none of it (spec open question 3): no OTel
//! provider is built, no socket lock is taken, and the SQLite state handle is
//! whatever the caller supplies.
//!
//! That property is the reason this is a short file rather than a careful
//! sequence of things to neutralise.
//!
//! # Why the engine gets its own runtime
//!
//! One thing *does* have to be arranged, and it is not obvious: **stack size.**
//!
//! The engine's futures are enormous. Upstream knows it — `codex-core` boxes
//! its config load with the note "Keep the large config-loading future off
//! small runtime thread stacks", and `codex-arg0`, which is how every upstream
//! binary starts, builds its Tokio runtime with
//! `TOKIO_WORKER_STACK_SIZE_BYTES = 16 MiB` instead of the 2 MiB default. Every
//! shipped Codex frontend therefore runs on 16 MiB workers without ever saying
//! so out loud.
//!
//! Atlas does not use `arg0` (that is the point of the embedding), and ADR-0004
//! has it adopt the *host* runtime — which is Tauri's, with default-size
//! workers. Handing the engine those is not a subtle degradation: `thread/start`
//! overflows the stack and the process **aborts**. Not an error a `Result`
//! carries; a `SIGABRT` with the whole app attached to it.
//!
//! Boxing futures on Atlas's side does not fix it, and the reason is worth
//! keeping: the overflow is not on the caller's stack. The engine hands
//! `thread/start` to its own `MessageProcessor` task, so the frame that runs
//! out of room belongs to a task Atlas never awaits.
//!
//! So the seam owns a Tokio runtime for the engine, built with upstream's own
//! 16 MiB figure. Engine work is spawned onto it, which is what makes every
//! task the engine spawns from inside inherit it. The app's own runtime is
//! untouched, and requests cross between the two over channels, which are
//! runtime-agnostic.

use std::sync::Arc;

use anyhow::Context;
use anyhow::Result;
use codex_app_server_client::InProcessAppServerClient;
use codex_app_server_client::InProcessClientStartArgs;
use codex_arg0::Arg0DispatchPaths;
use codex_config::CloudConfigBundleLoader;
use codex_config::LoaderOverrides;
use codex_exec_server::EnvironmentManager;
use codex_exec_server::ExecServerRuntimePaths;
use codex_feedback::CodexFeedback;
use codex_login::auth::ExternalAuth;
use codex_protocol::protocol::SessionSource;

use crate::engine::config::EngineSettings;

/// How Atlas identifies itself to the engine at `initialize`.
///
/// It reaches thread metadata, so it is a real identity rather than a label:
/// the engine stamps it into the threads it stores.
pub const ATLAS_CLIENT_NAME: &str = "atlas";

/// Starts the engine and returns the client facade.
///
/// `external_auth` is the D10 token provider. It is installed *before* the
/// initialize handshake, so the very first request already resolves through it
/// — which is why this goes through the `start_with_external_auth` entry point
/// Atlas added to the fork rather than through `start`.
/// Worker stack size for the engine's runtime.
///
/// Upstream's own number, from `codex-arg0`. Not tuned by us and not a guess:
/// it is what every shipped Codex frontend runs on.
const ENGINE_WORKER_STACK_BYTES: usize = 16 * 1024 * 1024;

/// The Tokio runtime the engine runs on. See the module docs for why it exists.
///
/// Held by the connection, so the engine outlives no connection and a dropped
/// connection takes its runtime with it.
pub struct EngineRuntime(Option<tokio::runtime::Runtime>);

impl EngineRuntime {
    fn start() -> Result<Self> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_stack_size(ENGINE_WORKER_STACK_BYTES)
            .thread_name("atlas-agent-engine")
            .build()
            .context("building the engine's Tokio runtime")?;
        Ok(Self(Some(runtime)))
    }

    pub fn handle(&self) -> tokio::runtime::Handle {
        self.0
            .as_ref()
            .expect("the runtime is only taken in Drop")
            .handle()
            .clone()
    }
}

impl Drop for EngineRuntime {
    fn drop(&mut self) {
        // `Runtime::drop` blocks until its tasks finish, and blocking inside an
        // async context panics — which a connection dropped from a task would
        // do every time. Shutting down in the background is the supported way
        // to dispose of a runtime from anywhere.
        if let Some(runtime) = self.0.take() {
            runtime.shutdown_background();
        }
    }
}

/// Starts the engine on its own runtime, and returns both.
///
/// The runtime comes back with the client because it has to outlive it: the
/// client's worker task and everything the engine spawned are running on it.
pub async fn start_engine(
    settings: &EngineSettings,
    external_auth: Option<Arc<dyn ExternalAuth>>,
) -> Result<(EngineRuntime, InProcessAppServerClient)> {
    let runtime = EngineRuntime::start()?;
    let settings = settings.clone();

    // `spawn` rather than `block_on`: this is called from the host runtime, and
    // blocking one of its workers on engine startup would stall the UI. The
    // handle is awaitable from anywhere, and the future — with every task the
    // engine spawns from inside it — runs on the engine's workers.
    let client = runtime
        .handle()
        .spawn(async move { start_engine_inner(&settings, external_auth).await })
        .await
        .context("the engine's startup task panicked")??;

    Ok((runtime, client))
}

async fn start_engine_inner(
    settings: &EngineSettings,
    external_auth: Option<Arc<dyn ExternalAuth>>,
) -> Result<InProcessAppServerClient> {
    let config = Arc::new(Box::pin(settings.build_config()).await?);

    // The engine re-enters this binary for sandboxed execution. `self_exe` is
    // the one process-level assumption the embedding makes, and this is where
    // it is satisfied — refusing early with a clear message beats a confusing
    // failure at the first tool call.
    let runtime_paths = ExecServerRuntimePaths::from_optional_paths(
        settings.self_exe.clone(),
        // `None` in every shipping build: the macOS seatbelt path needs no
        // helper. This is the one the Linux seccomp path refuses without, and
        // the integration tests are the only thing that supplies it today —
        // see `EngineSettings::linux_sandbox_exe`.
        settings.linux_sandbox_exe.clone(),
    )
    .context(
        "the engine needs the path to Atlas's own executable for sandboxed execution \
         (D5); std::env::current_exe() did not resolve",
    )?;

    let environment_manager = Box::pin(EnvironmentManager::from_codex_home(
        settings.home.path(),
        Some(runtime_paths),
        config.http_client_factory(),
    ))
    .await
    .map_err(|e| anyhow::anyhow!("{e}"))
    .context("building the engine's environment manager")?;

    // Before the struct literal: `config` moves into it a few fields earlier.
    let state_db = Box::pin(codex_core::init_state_db(config.as_ref())).await;

    let args = InProcessClientStartArgs {
        // Atlas does not use the engine's argv0 dispatch: this is a plain
        // struct of Options, hand-constructible, which is what makes the engine
        // embeddable without adopting its process model.
        //
        // It carries the self-exe because `ConfigManager::apply_arg0_paths`
        // stamps it onto every config it reloads. The copy in `config` above
        // does not survive that reload — this is the one that reaches a thread.
        arg0_paths: Arg0DispatchPaths {
            codex_self_exe: settings.self_exe.clone(),
            // Stamped onto every config `ConfigManager` reloads, so the copy in
            // `runtime_paths` above is not enough on its own.
            codex_linux_sandbox_exe: settings.linux_sandbox_exe.clone(),
            main_execve_wrapper_exe: None,
        },
        config,
        // Passed again, deliberately. `thread/start` does not reuse the `Config`
        // above: it asks `ConfigManager` to load one, and the manager only
        // knows the overrides given here. Leaving this empty makes the provider
        // exist at startup and vanish at the first turn — "Model provider
        // `atlas-…` not found", from a config that loaded fine a moment
        // earlier. Setting the same TOML key twice is idempotent, so the
        // duplication costs nothing.
        cli_overrides: settings.cli_overrides(),
        loader_overrides: LoaderOverrides::default(),
        strict_config: false,
        cloud_config_bundle: CloudConfigBundleLoader::default(),
        feedback: CodexFeedback::new(),
        // No log db: engine-private logging feeds no Atlas surface (D9 /
        // ADR-0001). The STATE db is supplied now, though — it stayed `None`
        // while nothing read it, but thread goals (`/goal`) are stored there
        // and answer "sqlite state db unavailable" without it. It lives under
        // the engine home like every other engine-private file. Best-effort:
        // an engine without goals is better than no engine.
        log_db: None,
        state_db,
        environment_manager: Arc::new(environment_manager),
        config_warnings: Vec::new(),
        // Threads the engine stores are stamped with this. `Custom` rather than
        // one of the built-in surfaces because Atlas is none of them, and a
        // wrong answer here would be a lie in stored metadata.
        session_source: SessionSource::Custom(ATLAS_CLIENT_NAME.to_string()),
        // Never. The engine would otherwise pick up an ambient CODEX_API_KEY
        // from the user's shell and authenticate as something Atlas did not
        // choose.
        enable_codex_api_key_env: false,
        client_name: ATLAS_CLIENT_NAME.to_string(),
        client_version: env!("CARGO_PKG_VERSION").to_string(),
        // On, deliberately. 76 protocol methods are gated behind this flag,
        // and the ones Atlas cannot do without are among them —
        // `thread/settings/update` is the only per-thread lever for permission
        // modes and reasoning effort, and it refuses outright without this.
        //
        // "Experimental" upstream means "may change upstream", which is a risk
        // Atlas does not carry: ADR-0003 makes this a hard fork with no
        // upstream tracking, so nothing changes under us. Upstream's own
        // client tests set it too.
        experimental_api: true,
        mcp_server_openai_form_elicitation: false,
        opt_out_notification_methods: Vec::new(),
        channel_capacity: codex_app_server::in_process::DEFAULT_IN_PROCESS_CHANNEL_CAPACITY,
    };

    Box::pin(InProcessAppServerClient::start_with_external_auth(
        args,
        external_auth,
    ))
    .await
        .map_err(anyhow::Error::from)
        .context("starting the in-process app-server runtime")
}
