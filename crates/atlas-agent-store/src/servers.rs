//! The three ways an installed agent resolves to a command line.
//!
//! Each implements [`ExternalAgentServer`], the seam
//! `atlas-agent-servers` defines: given extra args and extra env,
//! produce an [`AgentServerCommand`].
//!
//! - [`LocalCustomAgent`] — the user's own command, run as written.
//! - [`LocalRegistryArchiveAgent`] — a registry binary distribution: download,
//!   verify, extract, then run the target's `cmd` out of the versioned install
//!   directory (or the managed Node, when `cmd` is `"node"`).
//! - [`LocalRegistryNpxAgent`] — a registry npx distribution: `npm install` into
//!   a per-agent directory with the managed Node, then run the package's
//!   declared executable.
//!
//! None of them looks anything up. There is no fallback from one to another and
//! no search of `PATH`: the installed-map entry decided which of these three it
//! is, and that is the whole resolution.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result};
use atlas_agent_servers::connection::AgentServerCommand;
use atlas_agent_servers::server::ExternalAgentServer;
use futures::future::{BoxFuture, Shared};
use futures::FutureExt as _;
use tokio::sync::watch;

use crate::archive::{
    github_release_archive_from_url, github_release_digest, install_archive,
    registry_archive_kind_for_url, remove_stale_versioned_archive_cache_dirs,
    sanitize_path_component, versioned_archive_cache_dir,
};
use crate::http::HttpClient;
use crate::node::{
    bounded_npm_package_spec, installed_below_ceiling, installed_package_version,
    installed_version_satisfies, npm_command_env, npm_platform, plain_process_path,
    read_package_executable, NodeRuntime,
};
use crate::npm_tree::{install_state, InstallState, NpmPlatform};
use crate::registry::{current_platform_key, RegistryTargetConfig};
use crate::secrets::SecretEnv;

/// The environment an agent inherits from the project it is opened in.
///
/// An implementation runs the user's
/// login shell in the worktree root so an agent sees the same `PATH`,
/// `NODE_OPTIONS` and direnv-provided variables the user's terminal would. It
/// is a trait here so this crate stays leaf-level and a test can supply a fixed
/// map.
pub trait ProjectEnvironment: Send + Sync {
    fn project_env(&self) -> BoxFuture<'static, HashMap<String, String>>;
}

/// The default: whatever Atlas itself was started with.
///
/// This is the bottom layer of the env stack, so it is only ever a base for the
/// more specific sources to override.
pub struct InheritedProjectEnvironment;

impl ProjectEnvironment for InheritedProjectEnvironment {
    fn project_env(&self) -> BoxFuture<'static, HashMap<String, String>> {
        let env = std::env::vars().collect();
        Box::pin(async move { env })
    }
}

impl ProjectEnvironment for HashMap<String, String> {
    fn project_env(&self) -> BoxFuture<'static, HashMap<String, String>> {
        let env = self.clone();
        Box::pin(async move { env })
    }
}

/// The env stack, in one place so all three agents layer identically.
///
/// `project < distribution < extra < BYOK < settings`. See the crate docs for
/// why BYOK sits where it does.
fn layered_env(
    project: HashMap<String, String>,
    distribution: &HashMap<String, String>,
    extra: HashMap<String, String>,
    byok: &HashMap<String, String>,
    settings: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut env = project;
    env.extend(distribution.clone());
    env.extend(extra);
    env.extend(byok.clone());
    env.extend(settings.clone());
    env
}

// ------------------------------------------------------------ custom entries

/// A custom entry's own `env` is the *settings* layer and so beats `extra`,
/// the same as the registry path puts settings env on top; a custom entry's env
/// is settings by definition, and
/// having the launcher's env workarounds silently override something the user
/// typed for this one agent is the surprising reading of the two.
pub struct LocalCustomAgent {
    pub(crate) command: AgentServerCommand,
    pub(crate) project_env: Arc<dyn ProjectEnvironment>,
    pub(crate) byok_env: HashMap<String, String>,
    pub(crate) secret_env: SecretEnv,
}

impl ExternalAgentServer for LocalCustomAgent {
    fn get_command(
        &self,
        extra_args: Vec<String>,
        extra_env: HashMap<String, String>,
    ) -> BoxFuture<'static, Result<AgentServerCommand>> {
        let mut command = self.command.clone();
        let project_env = self.project_env.project_env();
        let byok_env = self.byok_env.clone();
        let secret_env = self.secret_env.clone();
        Box::pin(async move {
            // A custom entry's own env is the "settings" layer — it is the most
            // specific thing the user said about this agent.
            let settings_env = secret_env
                .layer_over(command.env.take().unwrap_or_default())
                .await;
            command.env = Some(layered_env(
                project_env.await,
                &HashMap::new(),
                extra_env,
                &byok_env,
                &settings_env,
            ));
            command.args.extend(extra_args);
            Ok(command)
        })
    }
}

// ---------------------------------------------------- registry: binary target

pub struct LocalRegistryArchiveAgent {
    pub(crate) http: Arc<dyn HttpClient>,
    pub(crate) node: NodeRuntime,
    pub(crate) project_env: Arc<dyn ProjectEnvironment>,
    pub(crate) installation_dir: PathBuf,
    pub(crate) version: Arc<str>,
    pub(crate) targets: HashMap<String, RegistryTargetConfig>,
    /// The user's arguments, after the distribution's own.
    pub(crate) settings_args: Vec<String>,
    pub(crate) settings_env: HashMap<String, String>,
    /// Sensitive values, layered over `settings_env` at launch.
    pub(crate) secret_env: SecretEnv,
    pub(crate) byok_env: HashMap<String, String>,
    pub(crate) loading_status: Option<watch::Sender<Option<String>>>,
}

impl ExternalAgentServer for LocalRegistryArchiveAgent {
    fn version(&self) -> Option<Arc<str>> {
        Some(self.version.clone())
    }

    fn prefetch_update(&self) -> BoxFuture<'static, Result<bool>> {
        self.prefetch()
    }

    fn update_pending(&self) -> BoxFuture<'static, bool> {
        let installation_dir = self.installation_dir.clone();
        let version = self.version.clone();
        let targets = self.targets.clone();
        Box::pin(async move {
            let Some(target) = current_platform_key().and_then(|key| targets.get(key)) else {
                return false;
            };
            let version_dir = versioned_archive_cache_dir(
                &installation_dir,
                Some(&version),
                &target.archive,
                target.sha256.as_deref(),
            );
            has_subdirectory(&installation_dir).await && !is_dir(&version_dir).await
        })
    }

    fn get_command(
        &self,
        extra_args: Vec<String>,
        extra_env: HashMap<String, String>,
    ) -> BoxFuture<'static, Result<AgentServerCommand>> {
        let http = self.http.clone();
        let node = self.node.clone();
        let project_env = self.project_env.project_env();
        let installation_dir = self.installation_dir.clone();
        let version = self.version.clone();
        let targets = self.targets.clone();
        let settings_args = self.settings_args.clone();
        let settings_env = self.settings_env.clone();
        let secret_env = self.secret_env.clone();
        let byok_env = self.byok_env.clone();
        let loading_status = self.loading_status.clone();

        Box::pin(async move {
            let result = async {
                tokio::fs::create_dir_all(&installation_dir)
                    .await
                    .with_context(|| format!("creating {installation_dir:?}"))?;

                let platform_key = current_platform_key().context("unsupported platform")?;
                let target = targets.get(platform_key).with_context(|| {
                    let mut available = targets.keys().cloned().collect::<Vec<_>>();
                    available.sort();
                    format!(
                        "no target specified for platform '{platform_key}'. Available platforms: {}",
                        available.join(", ")
                    )
                })?;

                let settings_env = secret_env.layer_over(settings_env).await;
                let env = layered_env(
                    project_env.await,
                    &target.env,
                    extra_env,
                    &byok_env,
                    &settings_env,
                );

                let (version_dir, _) = ensure_archive(
                    &*http,
                    &installation_dir,
                    &version,
                    target,
                    loading_status.as_ref(),
                )
                .await?;

                let cmd_path = resolve_target_cmd(&node, &target.cmd, &version_dir).await?;

                // Detached: the previous version's directory is dead
                // weight, not a correctness problem, and removing it should never
                // delay the agent starting.
                tokio::spawn({
                    let installation_dir = installation_dir.clone();
                    let version_dir = version_dir.clone();
                    async move {
                        if let Err(error) = remove_stale_versioned_archive_cache_dirs(
                            &installation_dir,
                            &version_dir,
                        )
                        .await
                        {
                            tracing::warn!(error = %format!("{error:#}"), "archive cache GC failed");
                        }
                    }
                });

                let mut args = target.args.clone();
                args.extend(settings_args);
                args.extend(extra_args);

                Ok(AgentServerCommand {
                    path: cmd_path,
                    args,
                    env: Some(env),
                })
            }
            .await;

            // Ready or failed, the "Installing …" text must not outlive the
            // attempt — the same contract as the npx target below. Without
            // it a finished or failed archive install left the tab reading
            // "Installing <version>…" for good.
            if let Some(tx) = &loading_status {
                tx.send(None).ok();
            }
            result
        })
    }
}

impl LocalRegistryArchiveAgent {
    fn prefetch(&self) -> BoxFuture<'static, Result<bool>> {
        let http = self.http.clone();
        let installation_dir = self.installation_dir.clone();
        let version = self.version.clone();
        let targets = self.targets.clone();
        Box::pin(async move {
            // Only an update: some earlier version has to be here already.
            if !has_subdirectory(&installation_dir).await {
                return Ok(false);
            }
            let Some(target) = current_platform_key().and_then(|key| targets.get(key)) else {
                return Ok(false);
            };
            let (_, installed) =
                ensure_archive(&*http, &installation_dir, &version, target, None).await?;
            Ok(installed)
        })
    }
}

/// The versioned directory for `target`, downloading and verifying it first
/// when it is not there. `true` when this call installed it.
///
/// Serialized per installation directory: a background prefetch and a
/// connect can both arrive here for the same version, and two extractions
/// into one directory corrupt it.
#[expect(
    clippy::await_holding_invalid_type,
    reason = "the install lock must span the install so a prefetch and a connect never write one directory at once"
)]
async fn ensure_archive(
    http: &dyn HttpClient,
    installation_dir: &std::path::Path,
    version: &str,
    target: &RegistryTargetConfig,
    loading_status: Option<&watch::Sender<Option<String>>>,
) -> Result<(PathBuf, bool)> {
    let archive_url = &target.archive;
    let version_dir = versioned_archive_cache_dir(
        installation_dir,
        Some(version),
        archive_url,
        target.sha256.as_deref(),
    );
    let lock = install_lock(installation_dir);
    let _guard = lock.lock().await;
    if is_dir(&version_dir).await {
        return Ok((version_dir, false));
    }
    if let Some(tx) = loading_status {
        tx.send(Some(format!("Installing {version}…"))).ok();
    }

    // The registry's own checksum wins; failing that, GitHub's recorded digest
    // for the release asset. Both absent means an unverified install.
    let sha256 = match &target.sha256 {
        Some(sha256) => Some(sha256.clone()),
        None => match github_release_archive_from_url(archive_url) {
            Some(release) => github_release_digest(http, &release).await,
            None => None,
        },
    };

    let kind = registry_archive_kind_for_url(archive_url)?;
    install_archive(http, archive_url, sha256.as_deref(), &version_dir, &kind).await?;
    Ok((version_dir, true))
}

/// One async mutex per install directory, for the life of the process.
///
/// The manager already keeps two connects to one agent from overlapping; the
/// background prefetch is the second writer this exists for. Keyed by the
/// path as the store built it, before any canonicalization, so every caller
/// agrees on the key.
fn install_lock(dir: &std::path::Path) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: std::sync::LazyLock<
        std::sync::Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>,
    > = std::sync::LazyLock::new(Default::default);
    LOCKS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .entry(dir.to_path_buf())
        .or_default()
        .clone()
}

async fn has_subdirectory(dir: &std::path::Path) -> bool {
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return false;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        if entry.file_type().await.is_ok_and(|kind| kind.is_dir()) {
            return true;
        }
    }
    false
}

/// The rule is narrow on purpose: `"node"` means our managed runtime, and
/// anything else must be a `./relative` path that exists inside the extraction
/// directory. An absolute path or a `..` would let a registry entry name a
/// binary that was never part of the archive we verified.
async fn resolve_target_cmd(
    node: &NodeRuntime,
    cmd: &str,
    version_dir: &std::path::Path,
) -> Result<PathBuf> {
    if cmd == "node" {
        return node.binary_path().await;
    }

    let cmd_path = version_dir.join(relative_target_cmd(cmd)?);
    anyhow::ensure!(
        tokio::fs::metadata(&cmd_path)
            .await
            .map(|metadata| metadata.is_file())
            .unwrap_or(false),
        "Missing command {} after extraction",
        cmd_path.display()
    );
    Ok(cmd_path)
}

/// The archive-relative part of a registry target's `cmd`.
///
/// Some registry targets name the binary bare (`amp-acp.exe` on Windows)
/// instead of `./amp-acp.exe`. A bare file name can only mean the archive
/// root, so it is exactly as contained as `./`; anything carrying a separator
/// or a drive still has to spell the `./` out.
fn relative_target_cmd(cmd: &str) -> Result<&str> {
    anyhow::ensure!(
        !cmd.contains(".."),
        "command path cannot contain '..': {cmd}"
    );
    cmd.strip_prefix("./")
        .or_else(|| cmd.strip_prefix(".\\"))
        .or_else(|| (!cmd.is_empty() && !cmd.contains(['/', '\\', ':'])).then_some(cmd))
        .with_context(|| format!("command must be relative (start with './'): {cmd}"))
}

// ------------------------------------------------------- registry: npx target

pub struct LocalRegistryNpxAgent {
    pub(crate) node: NodeRuntime,
    pub(crate) project_env: Arc<dyn ProjectEnvironment>,
    pub(crate) install_dir: PathBuf,
    pub(crate) version: Arc<str>,
    pub(crate) package: String,
    pub(crate) args: Vec<String>,
    pub(crate) distribution_env: HashMap<String, String>,
    /// The user's arguments, after the distribution's own.
    pub(crate) settings_args: Vec<String>,
    pub(crate) settings_env: HashMap<String, String>,
    /// Sensitive values, layered over `settings_env` at launch.
    pub(crate) secret_env: SecretEnv,
    pub(crate) byok_env: HashMap<String, String>,
    pub(crate) loading_status: Option<watch::Sender<Option<String>>>,
}

impl ExternalAgentServer for LocalRegistryNpxAgent {
    fn version(&self) -> Option<Arc<str>> {
        Some(self.version.clone())
    }

    fn prefetch_update(&self) -> BoxFuture<'static, Result<bool>> {
        let node = self.node.clone();
        let install_dir = self.install_dir.clone();
        let version = self.version.clone();
        let package = self.package.clone();
        Box::pin(async move {
            // Only an update: an agent never fetched has no tree here.
            if !is_dir(&install_dir.join("node_modules")).await {
                return Ok(false);
            }
            let resolved = resolve_install_dir(&install_dir).await?;
            ensure_npx_package(&node, &resolved, &install_dir, &package, &version, None).await
        })
    }

    fn update_pending(&self) -> BoxFuture<'static, bool> {
        let install_dir = self.install_dir.clone();
        let package = self.package.clone();
        Box::pin(async move {
            if !is_dir(&install_dir.join("node_modules")).await {
                return false;
            }
            let Ok(resolved) = resolve_install_dir(&install_dir).await else {
                return false;
            };
            let (package_name, _) = bounded_npm_package_spec(&package);
            install_needed(&resolved, package_name, &package, npm_platform())
                .await
                .is_some()
        })
    }

    fn get_command(
        &self,
        extra_args: Vec<String>,
        extra_env: HashMap<String, String>,
    ) -> BoxFuture<'static, Result<AgentServerCommand>> {
        let node = self.node.clone();
        let project_env = self.project_env.project_env();
        let install_dir = self.install_dir.clone();
        let version = self.version.clone();
        let package = self.package.clone();
        let args = self.args.clone();
        let settings_args = self.settings_args.clone();
        let distribution_env = self.distribution_env.clone();
        let settings_env = self.settings_env.clone();
        let secret_env = self.secret_env.clone();
        let byok_env = self.byok_env.clone();
        let loading_status = self.loading_status.clone();

        Box::pin(async move {
            let lock_key = install_dir.clone();
            let result = async {
                let lock_key = install_dir.clone();
                tokio::fs::create_dir_all(&install_dir)
                    .await
                    .with_context(|| format!("creating {install_dir:?}"))?;
                // Resolved once, up front, so every consumer below — npm, the
                // filesystem checks, the agent's script path — sees the same
                // spelling. See [`resolve_install_dir`].
                let install_dir = resolve_install_dir(&install_dir).await?;

                // Node first, and through the status-aware path: this is the
                // one step that can take minutes on a fresh machine, and every
                // later call (`run_npm_subcommand`, `binary_path`) would install
                // it silently.
                let node_binary = node
                    .ensure_installed(loading_status.as_ref())
                    .await?
                    .join(crate::node::NODE_PATH);

                ensure_npx_package(
                    &node,
                    &install_dir,
                    &lock_key,
                    &package,
                    &version,
                    loading_status.as_ref(),
                )
                .await?;
                let (package_name, _) = bounded_npm_package_spec(&package);
                let node_modules = install_dir.join("node_modules");
                let executable = read_package_executable(&node_modules, package_name).await?;

                // npm's own env (the managed Node first on `PATH`) layers over the
                // project's and under the distribution's. It has to beat the project
                // env specifically: the project almost always has a `PATH` of its
                // own, and the point of this layer is that ours wins.
                let mut base = project_env.await;
                base.extend(npm_command_env(&node_binary));
                let settings_env = secret_env.layer_over(settings_env).await;
                let env = layered_env(base, &distribution_env, extra_env, &byok_env, &settings_env);

                // The agent's own Node launch, plain at the boundary like npm's:
                // Node fails `lstat 'C:'` on a verbatim script path (#277), and
                // neither path should depend on how its caller resolved it.
                let mut command_args = vec![plain_process_path(&executable)
                    .to_string_lossy()
                    .into_owned()];
                command_args.extend(args);
                command_args.extend(settings_args);
                command_args.extend(extra_args);

                Ok(AgentServerCommand {
                    path: plain_process_path(&node_binary),
                    args: command_args,
                    env: Some(env),
                })
            }
            .await;

            // Ready or failed, the "Installing …" text must not outlive the
            // attempt: the manager surfaces the error itself. Unless the
            // install is still running: it outlives this attempt on purpose
            // (see [`ensure_npx_package`]), and clears the text itself.
            if let Some(tx) = &loading_status {
                if !install_in_flight(&lock_key) {
                    tx.send(None).ok();
                }
            }
            result
        })
    }
}

/// Install `package` into `install_dir` unless the copy there already serves
/// it. `true` when npm ran.
///
/// Install only when the copy on disk cannot serve the spec. Running `npm
/// install` on every connect would make each agent start a registry
/// round-trip, and a registry that does not answer a hang. It is a
/// per-version cost — and a per-repair cost: a tree npm left without its
/// platform package (see `npm_tree`) counts as not serving the spec.
///
/// The install is a JOB, keyed on `lock_key`, that the caller joins rather
/// than owns. A connect that is abandoned — the renderer's three-minute
/// deadline, the manager's twenty-minute one, a user pressing Restart —
/// drops its future, and when that future owned the `npm install`, dropping
/// it killed npm mid-download (`kill_on_drop`) and the next connect wiped the
/// tree and started again from byte zero. On a link slower than the deadline
/// that is a loop with no progress: the reported "stuck on installing". Now
/// the job runs on its own task, every concurrent or later caller awaits the
/// same [`Shared`] result, and dropping a caller changes nothing.
///
/// The decision "is an install needed" is still serialized on `lock_key`
/// ([`install_lock`]) so two callers cannot both read the tree before either
/// has created the job.
#[expect(
    clippy::await_holding_invalid_type,
    reason = "the lock spans the on-disk check and the job registration, so two callers cannot both decide an install is needed and start two"
)]
async fn ensure_npx_package(
    node: &NodeRuntime,
    install_dir: &std::path::Path,
    lock_key: &std::path::Path,
    package: &str,
    version: &str,
    loading_status: Option<&watch::Sender<Option<String>>>,
) -> Result<bool> {
    let job = {
        let lock = install_lock(lock_key);
        let _guard = lock.lock().await;

        // A job already running for this directory is the answer, whatever
        // the tree looks like right now (it is mid-write).
        if let Some(job) = install_job(lock_key) {
            tracing::info!(package, "joining the npm install already in flight");
            Some(job)
        } else {
            let (package_name, package_spec) = bounded_npm_package_spec(package);
            let platform = npm_platform();
            match install_needed(install_dir, package_name, package, platform).await {
                None => {
                    tracing::info!(
                        package = %package_spec,
                        "agent package already installed within its version ceiling; skipping npm install"
                    );
                    None
                }
                Some(need) => {
                    tracing::info!(
                        package = %package_spec,
                        reason = %need.reason,
                        "running npm install for the agent package"
                    );
                    Some(start_install_job(
                        node.clone(),
                        install_dir.to_path_buf(),
                        lock_key.to_path_buf(),
                        package.to_owned(),
                        version.to_owned(),
                        need.previous_runnable,
                        loading_status.cloned(),
                    ))
                }
            }
        }
    };
    let Some(job) = job else {
        return Ok(false);
    };
    job.await.map_err(|error| anyhow::anyhow!("{error:#}"))?;
    Ok(true)
}

/// One install's result, shared by everyone who waited for it.
type InstallJob = Shared<BoxFuture<'static, std::result::Result<(), Arc<anyhow::Error>>>>;

/// The install jobs in flight, by `lock_key`. An entry exists exactly while
/// its task runs: the task removes itself before it resolves.
fn install_jobs() -> &'static std::sync::Mutex<HashMap<PathBuf, InstallJob>> {
    static JOBS: std::sync::LazyLock<std::sync::Mutex<HashMap<PathBuf, InstallJob>>> =
        std::sync::LazyLock::new(Default::default);
    &JOBS
}

fn install_job(lock_key: &std::path::Path) -> Option<InstallJob> {
    install_jobs()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(lock_key)
        .cloned()
}

/// Whether an install for `lock_key` is still running — the status text is
/// its to clear, not a finished caller's.
fn install_in_flight(lock_key: &std::path::Path) -> bool {
    install_job(lock_key).is_some()
}

/// Spawn the install for `install_dir` and register it under `lock_key`.
///
/// Spawned, not awaited, so the task is owned by the runtime rather than by
/// whichever connect happened to arrive first. The status text is sent and
/// cleared from inside the task for the same reason: it describes the
/// install, which may outlive every caller that is currently watching.
fn start_install_job(
    node: NodeRuntime,
    install_dir: PathBuf,
    lock_key: PathBuf,
    package: String,
    version: String,
    previous_runnable: bool,
    loading_status: Option<watch::Sender<Option<String>>>,
) -> InstallJob {
    let key = lock_key.clone();
    let task = tokio::spawn(async move {
        let (package_name, package_spec) = bounded_npm_package_spec(&package);
        let ticker = loading_status.as_ref().map(|tx| {
            crate::node::tick_status(tx.clone(), format!("Installing {package_name} {version}"))
        });
        let result = async {
            let outcome = install_package(
                &node,
                &install_dir,
                package_name,
                &package,
                &package_spec,
                npm_platform(),
                previous_runnable,
            )
            .await?;
            if let Some(sidecar) = outcome.sidecar(&package, SystemTime::now()) {
                write_wanted_spec(&install_dir, &sidecar).await;
            }
            Ok::<(), anyhow::Error>(())
        }
        .await;
        // Unregister BEFORE resolving: a caller that wakes on the result and
        // immediately re-checks must see the tree, not a finished job.
        install_jobs()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&key);
        if let Some(ticker) = ticker {
            ticker.abort();
        }
        if let Some(tx) = &loading_status {
            tx.send(None).ok();
        }
        result
    });
    let job: InstallJob = async move {
        match task.await {
            Ok(result) => result.map_err(Arc::new),
            Err(join) => Err(Arc::new(anyhow::anyhow!("the install task failed: {join}"))),
        }
    }
    .boxed()
    .shared();
    install_jobs()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(lock_key, job.clone());
    job
}

/// What [`install_package`] left on disk, measured against the version the
/// registry asked for.
#[derive(Debug, PartialEq, Eq)]
enum InstallOutcome {
    /// The registry's version (or, for a spec with no version, whatever npm
    /// resolved).
    AtCeiling,
    /// An online resolve confirmed this older version is the newest npm can
    /// serve within the ceiling — a registry pin npm does not (yet) have.
    NewestAvailable(String),
    /// The registry was unreachable, so this older copy came out of npm's
    /// cache. Runnable, but not what was asked for.
    Stale(String),
    /// Every attempt failed and the install that was working before the
    /// attempt is back in place. Runnable, and not what was asked for.
    KeptPrevious(String),
}

impl InstallOutcome {
    /// The sidecar to record.
    ///
    /// An older copy that is runnable is recorded with a retry-after stamp
    /// ([`stale_sidecar`]). It used to be recorded as nothing, "so the next
    /// connect tries again" — and the next connect did, and the one after:
    /// every connect while the registry stayed unreachable re-ran the whole
    /// ladder, wiping and reinstalling a copy that worked. Now the next
    /// connect runs on it, and the online retry happens once
    /// [`STALE_RETRY_AFTER`] has passed.
    fn sidecar(&self, raw_spec: &str, now: SystemTime) -> Option<String> {
        match self {
            Self::AtCeiling => Some(raw_spec.to_owned()),
            Self::NewestAvailable(version) => Some(resolved_sidecar(raw_spec, version, now)),
            Self::Stale(version) | Self::KeptPrevious(version) => {
                Some(stale_sidecar(raw_spec, version, now))
            }
        }
    }
}

/// The error for an install npm reported as a success with the platform
/// package missing — twice, on clean trees. Typed, so the caller does not
/// try npm's cache for a package the registry itself could not serve.
#[derive(Debug)]
struct PlatformGap(String);

impl std::fmt::Display for PlatformGap {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for PlatformGap {}

/// Install `bounded_spec` online, falling back to npm's cache when the
/// registry cannot be reached.
///
/// Online first, because this only runs when the registry has moved (or the
/// tree needs repair) — exactly when a cached packument is the stale one: npm
/// resolves the bounded range against it, and one cached before the wanted
/// release existed yields an older version with exit 0. `--prefer-online`
/// revalidates the metadata with conditional requests and still takes every
/// tarball it has from the cache, so a repeat install is not a re-download.
///
/// The cache fallback (`--prefer-offline`) is what keeps an offline host
/// starting its agent. Whatever it installs, the version on disk is checked
/// against `raw_spec`: short of it, the caller leaves the sidecar alone so the
/// next connect goes online again.
/// `previous_runnable` says the tree on disk before this call could start
/// the agent (an upgrade, not a repair). Such a tree is set aside, not wiped,
/// and comes back if every attempt fails — an agent that worked five minutes
/// ago must still work when the registry moves on and the network does not.
async fn install_package(
    node: &NodeRuntime,
    install_dir: &std::path::Path,
    package_name: &str,
    raw_spec: &str,
    bounded_spec: &str,
    platform: Option<NpmPlatform>,
    previous_runnable: bool,
) -> Result<InstallOutcome> {
    let node_modules = install_dir.join("node_modules");
    let previous = if previous_runnable {
        stash_install_tree(install_dir).await?
    } else {
        wipe_install_tree(install_dir).await?;
        None
    };

    let outcome = async {
        match install_tree(
            node,
            install_dir,
            package_name,
            bounded_spec,
            platform,
            true,
        )
        .await
        {
            Ok(()) => {
                let installed = installed_package_version(&node_modules, package_name)
                    .await
                    .unwrap_or_default();
                if !installed_below_ceiling(&installed, raw_spec) {
                    return Ok(InstallOutcome::AtCeiling);
                }
                tracing::warn!(
                    package = raw_spec,
                    %installed,
                    "the registry pins a version npm does not serve; keeping the newest it has"
                );
                Ok(InstallOutcome::NewestAvailable(installed))
            }
            // Not a network failure: npm reached the registry and the
            // package it serves is incomplete for this host. The cache holds
            // the same package.
            Err(online_error) if online_error.is::<PlatformGap>() => Err(online_error),
            Err(online_error) => {
                tracing::warn!(
                    package = raw_spec,
                    error = %format!("{online_error:#}"),
                    "online npm install failed; falling back to npm's cache"
                );
                // The online error is the one worth showing: it names the
                // network problem, where the cache's would only say it had
                // nothing.
                if install_tree(
                    node,
                    install_dir,
                    package_name,
                    bounded_spec,
                    platform,
                    false,
                )
                .await
                .is_err()
                {
                    return Err(online_error);
                }
                let installed = installed_package_version(&node_modules, package_name)
                    .await
                    .unwrap_or_default();
                if !installed_below_ceiling(&installed, raw_spec) {
                    return Ok(InstallOutcome::AtCeiling);
                }
                tracing::warn!(
                    package = raw_spec,
                    %installed,
                    "installed an older cached copy; retrying online later"
                );
                Ok(InstallOutcome::Stale(installed))
            }
        }
    }
    .await;

    match (outcome, previous) {
        (Ok(outcome), Some(stash)) => {
            stash.discard().await;
            Ok(outcome)
        }
        (Ok(outcome), None) => Ok(outcome),
        (Err(error), Some(stash)) => {
            tracing::warn!(
                package = raw_spec,
                error = %format!("{error:#}"),
                "the install failed; the previous install is back in place"
            );
            stash.restore(install_dir).await?;
            let installed = installed_package_version(&node_modules, package_name)
                .await
                .unwrap_or_default();
            Ok(InstallOutcome::KeptPrevious(installed))
        }
        (Err(error), None) => Err(error),
    }
}

/// A working install set aside while a newer one is attempted.
///
/// A rename, not a copy: `node_modules` can be hundreds of megabytes, and a
/// rename within one directory is one metadata write on every filesystem
/// Atlas runs on.
struct StashedTree {
    node_modules: Option<PathBuf>,
    lockfile: Option<PathBuf>,
}

const STASH_SUFFIX: &str = ".previous";

/// Set the current tree aside so npm starts from nothing, keeping it to
/// restore. `None` when there was nothing to keep.
async fn stash_install_tree(install_dir: &std::path::Path) -> Result<Option<StashedTree>> {
    let mut stash = StashedTree {
        node_modules: None,
        lockfile: None,
    };
    for (name, slot) in [
        ("node_modules", &mut stash.node_modules),
        ("package-lock.json", &mut stash.lockfile),
    ] {
        let path = install_dir.join(name);
        if tokio::fs::metadata(&path).await.is_err() {
            continue;
        }
        let aside = install_dir.join(format!("{name}{STASH_SUFFIX}"));
        // A stash left by a crash is just an older previous; this one wins.
        let _ = tokio::fs::remove_dir_all(&aside).await;
        let _ = tokio::fs::remove_file(&aside).await;
        tokio::fs::rename(&path, &aside)
            .await
            .with_context(|| format!("setting aside {}", path.display()))?;
        *slot = Some(aside);
    }
    Ok((stash.node_modules.is_some() || stash.lockfile.is_some()).then_some(stash))
}

impl StashedTree {
    /// The attempt succeeded: the previous tree is no longer needed.
    async fn discard(self) {
        if let Some(dir) = self.node_modules {
            let _ = tokio::fs::remove_dir_all(dir).await;
        }
        if let Some(file) = self.lockfile {
            let _ = tokio::fs::remove_file(file).await;
        }
    }

    /// The attempt failed: whatever it left goes, the previous tree returns.
    async fn restore(self, install_dir: &std::path::Path) -> Result<()> {
        wipe_install_tree(install_dir).await?;
        if let Some(aside) = self.node_modules {
            tokio::fs::rename(&aside, install_dir.join("node_modules"))
                .await
                .with_context(|| format!("restoring {}", aside.display()))?;
        }
        if let Some(aside) = self.lockfile {
            tokio::fs::rename(&aside, install_dir.join("package-lock.json"))
                .await
                .with_context(|| format!("restoring {}", aside.display()))?;
        }
        Ok(())
    }
}

/// `npm install` into a clean `install_dir`, verified against the platform
/// package(s) the hidden lockfile says this host needs, with one retry.
///
/// Clean, because npm records a failed optional dependency as `ideallyInert`
/// in `node_modules/.package-lock.json` and trusts that on the next run: an
/// install over the old tree would skip exactly the package we are here to
/// fetch. Wiping is cheap — npm still serves every tarball it did cache — and
/// makes the outcome independent of what was on disk before.
///
/// `online` picks the cache policy of the first run: `--prefer-online` or
/// `--prefer-offline`, never both (npm lets offline win; see `NPM_FETCH_ARGS`).
///
/// Verified, because npm exits 0 when an optional dependency fails. The retry
/// is `--prefer-online` so a tarball the cache never saw is fetched fresh. A
/// second gap is an error naming the package; the sidecar is not written, and
/// the tree is wiped so the next connect re-detects rather than spawning into
/// `Missing optional dependency …`.
async fn install_tree(
    node: &NodeRuntime,
    install_dir: &std::path::Path,
    package_name: &str,
    package_spec: &str,
    platform: Option<NpmPlatform>,
    online: bool,
) -> Result<()> {
    let cache_policy = if online {
        "--prefer-online"
    } else {
        "--prefer-offline"
    };
    // The caller cleared (or set aside) the tree before the first attempt;
    // a second attempt in the same call starts clean too.
    wipe_install_tree(install_dir).await?;
    node.run_npm_subcommand(
        Some(install_dir),
        "install",
        &[package_spec, "--save-exact", cache_policy],
    )
    .await?;
    let Some(platform) = platform else {
        return Ok(());
    };

    let state = install_state(install_dir, platform).await;
    let InstallState::MissingOptional(gaps) = state else {
        return match state.reinstall_reason() {
            None => Ok(()),
            Some(reason) => Err(anyhow::anyhow!(
                "npm install of {package_name} finished but left no usable tree ({reason})"
            )),
        };
    };

    tracing::warn!(
        package = package_name,
        gaps = %gaps.join(", "),
        "npm install exited 0 without the platform package(s); retrying with a clean tree"
    );
    wipe_install_tree(install_dir).await?;
    node.run_npm_subcommand(
        Some(install_dir),
        "install",
        &[package_spec, "--save-exact", "--prefer-online"],
    )
    .await?;

    match install_state(install_dir, platform).await {
        InstallState::Complete => Ok(()),
        state => {
            let gaps = match &state {
                InstallState::MissingOptional(gaps) => gaps.join(", "),
                other => other.reinstall_reason().unwrap_or_default(),
            };
            // Leave nothing that looks installed: the next connect must land
            // here again, not in the agent's own crash.
            let _ = wipe_install_tree(install_dir).await;
            Err(anyhow::Error::new(PlatformGap(format!(
                "npm installed {package_name} but could not fetch its platform package(s) for \
                 {}/{}: {gaps}. npm treats these as optional and reports success anyway; the \
                 install was discarded. Check the network (the package is a large download) \
                 and try again, or uninstall the agent with \"purge cache\" and reinstall.",
                platform.os, platform.cpu,
            ))))
        }
    }
}

/// Remove `node_modules` and `package-lock.json` so the next `npm install`
/// resolves from scratch.
async fn wipe_install_tree(install_dir: &std::path::Path) -> Result<()> {
    for name in ["node_modules", "package-lock.json"] {
        let path = install_dir.join(name);
        let result = match tokio::fs::metadata(&path).await {
            Ok(meta) if meta.is_dir() => tokio::fs::remove_dir_all(&path).await,
            Ok(_) => tokio::fs::remove_file(&path).await,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => Err(e),
        };
        result.with_context(|| format!("removing {}", path.display()))?;
        tracing::info!(path = %path.display(), "removed stale install tree before npm install");
    }
    Ok(())
}

/// The sidecar recording which package spec the install directory was last
/// installed against.
///
/// The ceiling check alone can never upgrade: an installed `1.11.0` satisfies
/// `<= 1.12.0` when the registry moves on, so the install would be skipped
/// forever. The sidecar makes a registry bump visible: a different spec here
/// means "the registry now wants something newer than we resolved against".
const WANTED_SPEC_FILE: &str = ".atlas-wanted";

/// The sidecar for an install whose online resolve confirmed `version` is the
/// newest npm serves within `package_spec`'s ceiling, stamped with when.
///
/// Tied to that version, so a different older copy never matches. And it
/// expires ([`NEWEST_AVAILABLE_TTL`]): "npm does not have the pinned release
/// yet" is true only for now. Without the expiry the record held until the
/// registry moved again, and one written wrongly — as a build whose "online"
/// retry never went online did — pinned an old copy for good.
fn resolved_sidecar(package_spec: &str, version: &str, at: SystemTime) -> String {
    let secs = at
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs());
    format!("{package_spec}#newest-available={version}@{secs}")
}

/// How long an online resolve's "this is the newest npm has" stands before
/// the next connect asks npm again. Long enough that a registry pin npm lags
/// on costs one online install per half day, not one per connect.
const NEWEST_AVAILABLE_TTL: Duration = Duration::from_secs(12 * 60 * 60);

/// Whether `sidecar` is a [`resolved_sidecar`] for `installed` under
/// `package_spec` that has not expired. A record without a stamp (the
/// original format) or from the future counts as expired.
fn newest_available_is_fresh(
    sidecar: &str,
    package_spec: &str,
    installed: &str,
    now: SystemTime,
) -> bool {
    let Some(stamp) =
        sidecar.strip_prefix(&format!("{package_spec}#newest-available={installed}@"))
    else {
        return false;
    };
    let Ok(secs) = stamp.parse::<u64>() else {
        return false;
    };
    now.duration_since(UNIX_EPOCH + Duration::from_secs(secs))
        .is_ok_and(|age| age < NEWEST_AVAILABLE_TTL)
}

/// The sidecar for a runnable copy older than the registry wants, stamped
/// with when it was last tried: an offline fallback ([`InstallOutcome::Stale`])
/// or a failed upgrade whose previous install was kept
/// ([`InstallOutcome::KeptPrevious`]).
fn stale_sidecar(package_spec: &str, version: &str, at: SystemTime) -> String {
    let secs = at
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs());
    format!("{package_spec}#stale={version}@{secs}")
}

/// How long a runnable older copy is left alone before the registry's
/// version is tried again. One upgrade attempt an hour, not one per connect:
/// an attempt is up to two `npm install`s, and while the network is down the
/// outcome is the same each time.
const STALE_RETRY_AFTER: Duration = Duration::from_secs(60 * 60);

/// Whether `sidecar` is a [`stale_sidecar`] for `installed` under
/// `package_spec` within [`STALE_RETRY_AFTER`].
fn stale_is_fresh(sidecar: &str, package_spec: &str, installed: &str, now: SystemTime) -> bool {
    let Some(stamp) = sidecar.strip_prefix(&format!("{package_spec}#stale={installed}@")) else {
        return false;
    };
    let Ok(secs) = stamp.parse::<u64>() else {
        return false;
    };
    now.duration_since(UNIX_EPOCH + Duration::from_secs(secs))
        .is_ok_and(|age| age < STALE_RETRY_AFTER)
}

async fn read_wanted_spec(install_dir: &std::path::Path) -> Option<String> {
    tokio::fs::read_to_string(install_dir.join(WANTED_SPEC_FILE))
        .await
        .ok()
        .map(|spec| spec.trim().to_owned())
}

async fn write_wanted_spec(install_dir: &std::path::Path, package_spec: &str) {
    if let Err(error) = tokio::fs::write(
        install_dir.join(WANTED_SPEC_FILE),
        format!("{package_spec}\n"),
    )
    .await
    {
        tracing::warn!(
            path = %install_dir.join(WANTED_SPEC_FILE).display(),
            %error,
            "could not record the installed package spec; the next launch will re-check"
        );
    }
}

/// Why the package under `<install_dir>/node_modules/<name>` has to be
/// (re)installed, or `None` when the copy on disk already serves
/// `package_spec` (the raw registry spec, e.g. `@scope/pkg@1.11.0`) and
/// declares an executable.
///
/// An install older than the spec's own version is repaired whatever the
/// sidecar says, unless the sidecar records a recent online resolve that
/// confirmed that version as the newest available ([`resolved_sidecar`],
/// [`NEWEST_AVAILABLE_TTL`]).
///
/// A satisfied install with no [`WANTED_SPEC_FILE`] — every install made
/// before the sidecar existed — is adopted: the sidecar is written with the
/// current spec and the install is skipped, so existing users stay offline and
/// upgrades kick in at the next ceiling change.
///
/// Adoption and the skip both require the tree to be *complete* for
/// `platform` ([`install_state`]): the top-level package having a version and
/// a `bin` says nothing about whether npm managed to land the optional
/// platform package underneath it, and once it has not, npm will not retry on
/// its own. A `platform` of `None` (unsupported host) skips that check.
async fn install_needed(
    install_dir: &std::path::Path,
    package_name: &str,
    package_spec: &str,
    platform: Option<NpmPlatform>,
) -> Option<InstallNeed> {
    let repair = |reason: String| InstallNeed {
        reason,
        previous_runnable: false,
    };
    let upgrade = |reason: String| InstallNeed {
        reason,
        previous_runnable: true,
    };
    let node_modules = install_dir.join("node_modules");
    let Some(installed) = installed_package_version(&node_modules, package_name).await else {
        return Some(repair("package.json missing or unparsable".to_owned()));
    };
    if read_package_executable(&node_modules, package_name)
        .await
        .is_err()
    {
        return Some(repair(
            "installed package declares no usable executable".to_owned(),
        ));
    }
    if let Some(platform) = platform {
        if let Some(reason) = install_state(install_dir, platform)
            .await
            .reinstall_reason()
        {
            return Some(repair(reason));
        }
    }
    // From here the copy on disk can start the agent; what follows is about
    // whether it is the copy the registry wants.
    if !installed_version_satisfies(&installed, package_spec) {
        return Some(upgrade(format!(
            "installed {installed} is outside the ceiling of {package_spec}"
        )));
    }
    let sidecar = read_wanted_spec(install_dir).await;
    let now = SystemTime::now();
    match sidecar {
        Some(previous) if newest_available_is_fresh(&previous, package_spec, &installed, now) => {
            None
        }
        Some(previous) if stale_is_fresh(&previous, package_spec, &installed, now) => None,
        Some(previous) if previous.starts_with(&format!("{package_spec}#newest-available=")) => {
            Some(upgrade(format!(
                "re-checking whether npm serves {package_spec} yet (it last confirmed {installed})"
            )))
        }
        Some(previous) if previous.starts_with(&format!("{package_spec}#stale=")) => {
            Some(upgrade(format!(
                "retrying the {package_spec} the registry wants (running {installed} meanwhile)"
            )))
        }
        Some(previous) if previous != package_spec => Some(upgrade(format!(
            "registry now wants {package_spec} (installed against {previous})"
        ))),
        // An equal sidecar may be lying: installs made before `install_package`
        // verified the version recorded the registry's spec over whatever
        // older copy npm's stale packument resolved to. And an older copy is
        // never adopted.
        _ if installed_below_ceiling(&installed, package_spec) => Some(upgrade(format!(
            "installed {installed} is older than the {package_spec} the registry wants"
        ))),
        Some(_) => None,
        None => {
            write_wanted_spec(install_dir, package_spec).await;
            None
        }
    }
}

/// Why an install has to run, and whether what it replaces could have run
/// the agent — which decides whether that tree is kept for a failed attempt
/// to fall back on.
struct InstallNeed {
    reason: String,
    previous_runnable: bool,
}

/// `<external-agents>/registry/npx/<id>` — one install directory per agent, so
/// two agents depending on different versions of the same package cannot fight.
pub fn npx_install_dir(registry_dir: &std::path::Path, id: &str) -> PathBuf {
    registry_dir.join("npx").join(sanitize_path_component(id))
}

/// The version of `package_spec`'s package installed for npx agent `id`, or
/// `None` when nothing is installed yet.
///
/// Synchronous and cheap — one small `package.json` read — because the
/// marketplace listing calls it per card. Next to the registry's version it is
/// what says an update is waiting: an install is lazy and silent, so a copy
/// npm left behind the registry shows nowhere else.
pub fn installed_npx_version(
    registry_dir: &std::path::Path,
    id: &str,
    package_spec: &str,
) -> Option<String> {
    let (package_name, _) = bounded_npm_package_spec(package_spec);
    let manifest = npx_install_dir(registry_dir, id)
        .join("node_modules")
        .join(package_name)
        .join("package.json");
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(manifest).ok()?).ok()?;
    manifest.get("version")?.as_str().map(str::to_owned)
}

/// Make the next connect of npx agent `id` re-decide its install from scratch.
///
/// Removes the sidecar, and with it any record that an older copy was the
/// newest npm had ([`resolved_sidecar`]). An install behind the registry is
/// then reinstalled online; one already at the registry's version is adopted
/// as it stands, so this never costs a download that is not needed.
pub async fn forget_npx_install_decision(registry_dir: &std::path::Path, id: &str) -> Result<()> {
    let sidecar = npx_install_dir(registry_dir, id).join(WANTED_SPEC_FILE);
    match tokio::fs::remove_file(&sidecar).await {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            Err(error).with_context(|| format!("removing {}", sidecar.display()))
        }
        _ => Ok(()),
    }
}

/// The npx install directory, resolved the one way every consumer of it needs.
///
/// Resolved, because npm keys its hidden lockfile by path relative to the
/// *real* prefix: hand it a symlinked one (a relocated `~/Library`, `/tmp` on
/// macOS) and every entry comes back as `../../real/path/node_modules/…`, which
/// nothing here can match against the tree. Plain, because `canonicalize` on
/// Windows answers in the `\\?\`-verbatim spelling, and both npm (as
/// `--prefix`) and Node (as the agent's script path, which is built from this
/// directory) reject it — the clean-install Codex failure in #277. One helper
/// for `get_command`, `prefetch_update` and `update_pending`, so the three can
/// never disagree about which spelling of the directory they are checking.
async fn resolve_install_dir(install_dir: &std::path::Path) -> Result<PathBuf> {
    let resolved = tokio::fs::canonicalize(install_dir)
        .await
        .with_context(|| format!("resolving {install_dir:?}"))?;
    Ok(plain_process_path(&resolved))
}

async fn is_dir(path: &std::path::Path) -> bool {
    tokio::fs::metadata(path)
        .await
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The reason an install is needed, or `None` — what the tests here
    /// assert on; which tree is kept is covered by `tests/install_faults.rs`.
    async fn needed(
        install_dir: &std::path::Path,
        package_name: &str,
        package_spec: &str,
        platform: Option<NpmPlatform>,
    ) -> Option<String> {
        install_needed(install_dir, package_name, package_spec, platform)
            .await
            .map(|need| need.reason)
    }

    const PACKAGE: &str = "@scope/agent";

    /// The real `canonicalize`, not a spelled-out string: on Windows it is what
    /// produced the `\\?\` prefix npm and Node rejected (#277), and on POSIX it
    /// must still resolve symlinks for npm's hidden lockfile.
    #[tokio::test]
    async fn the_install_dir_resolves_to_a_plain_existing_path() {
        let dir = tempfile::tempdir().unwrap();
        let canonical = std::fs::canonicalize(dir.path()).unwrap();
        if cfg!(windows) {
            // Pins the premise: without it this test would pass vacuously.
            assert!(
                canonical.to_string_lossy().starts_with(r"\\?\"),
                "expected a verbatim path, got {canonical:?}"
            );
        }

        let resolved = resolve_install_dir(dir.path()).await.unwrap();
        assert!(
            !resolved.to_string_lossy().starts_with(r"\\?\"),
            "verbatim install dir would reach npm and Node: {resolved:?}"
        );
        assert!(is_dir(&resolved).await, "{resolved:?} is not the directory");
        assert_eq!(std::fs::canonicalize(&resolved).unwrap(), canonical);
    }

    #[test]
    fn target_cmd_accepts_dot_relative_paths_and_bare_names() {
        assert_eq!(relative_target_cmd("./bin/agent").unwrap(), "bin/agent");
        assert_eq!(
            relative_target_cmd("./dist-package\\cursor-agent.cmd").unwrap(),
            "dist-package\\cursor-agent.cmd"
        );
        assert_eq!(relative_target_cmd(".\\agent.exe").unwrap(), "agent.exe");
        assert_eq!(relative_target_cmd("amp-acp.exe").unwrap(), "amp-acp.exe");
    }

    #[test]
    fn target_cmd_refuses_anything_that_could_leave_the_archive() {
        for cmd in [
            "",
            "/usr/bin/agent",
            "C:\\agent.exe",
            "C:agent.exe",
            "bin/agent",
            "./../agent",
            "..\\agent.exe",
        ] {
            assert!(relative_target_cmd(cmd).is_err(), "accepted {cmd:?}");
        }
    }

    const PLATFORM: Option<NpmPlatform> = Some(NpmPlatform {
        os: "darwin",
        cpu: "arm64",
    });

    /// A hidden lockfile with one optional platform package for darwin/arm64
    /// and one inert foreign variant — the shape npm leaves after a good
    /// install of a Codex-like package.
    const HIDDEN_LOCKFILE: &str = r#"{ "lockfileVersion": 3, "packages": {
        "": {},
        "node_modules/@scope/agent": { "version": "1.11.0" },
        "node_modules/@scope/agent-darwin-arm64": { "optional": true, "os": ["darwin"], "cpu": ["arm64"] },
        "node_modules/@scope/agent-linux-x64": { "optional": true, "ideallyInert": true, "os": ["linux"], "cpu": ["x64"] }
    } }"#;

    /// An install dir whose `node_modules/@scope/agent` is at `version`, with
    /// a complete tree for [`PLATFORM`].
    fn installed(version: &str) -> tempfile::TempDir {
        let dir = installed_without_platform_package(version);
        let platform_dir = dir.path().join("node_modules/@scope/agent-darwin-arm64");
        std::fs::create_dir_all(&platform_dir).unwrap();
        std::fs::write(
            platform_dir.join("package.json"),
            r#"{"name":"@scope/agent"}"#,
        )
        .unwrap();
        dir
    }

    /// The same, but npm never landed the platform package.
    fn installed_without_platform_package(version: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let node_modules = dir.path().join("node_modules");
        let package_dir = node_modules.join(PACKAGE);
        std::fs::create_dir_all(&package_dir).unwrap();
        std::fs::write(
            package_dir.join("package.json"),
            format!(r#"{{"version": "{version}", "bin": "cli.js"}}"#),
        )
        .unwrap();
        std::fs::write(node_modules.join(".package-lock.json"), HIDDEN_LOCKFILE).unwrap();
        dir
    }

    fn sidecar(dir: &tempfile::TempDir) -> Option<String> {
        std::fs::read_to_string(dir.path().join(WANTED_SPEC_FILE)).ok()
    }

    #[tokio::test]
    async fn missing_sidecar_with_satisfied_ceiling_is_adopted_and_skipped() {
        let dir = installed("1.11.0");
        assert_eq!(sidecar(&dir), None);

        assert_eq!(
            needed(dir.path(), PACKAGE, "@scope/agent@1.11.0", PLATFORM).await,
            None
        );
        assert_eq!(sidecar(&dir).as_deref(), Some("@scope/agent@1.11.0\n"));
    }

    #[tokio::test]
    async fn a_registry_bump_forces_an_install_even_within_the_ceiling() {
        let dir = installed("1.11.0");
        write_wanted_spec(dir.path(), "@scope/agent@1.11.0").await;

        // 1.11.0 <= 1.12.0, so the ceiling alone would skip; the sidecar says
        // the registry moved on.
        let reason = needed(dir.path(), PACKAGE, "@scope/agent@1.12.0", PLATFORM)
            .await
            .expect("a differing sidecar must force an install");
        assert_eq!(
            reason,
            "registry now wants @scope/agent@1.12.0 (installed against @scope/agent@1.11.0)"
        );
        // Not rewritten until the install actually succeeds.
        assert_eq!(sidecar(&dir).as_deref(), Some("@scope/agent@1.11.0\n"));
    }

    #[tokio::test]
    async fn an_install_below_the_spec_is_repaired_even_under_an_equal_sidecar() {
        // The state a stale npm packument left behind: npm resolved the bounded
        // range to an older release, and the sidecar recorded the spec anyway.
        let dir = installed("1.9.0");
        write_wanted_spec(dir.path(), "@scope/agent@1.11.0").await;

        assert_eq!(
            needed(dir.path(), PACKAGE, "@scope/agent@1.11.0", PLATFORM)
                .await
                .as_deref(),
            Some("installed 1.9.0 is older than the @scope/agent@1.11.0 the registry wants")
        );
    }

    #[tokio::test]
    async fn an_older_copy_is_not_adopted_without_a_sidecar() {
        let dir = installed("1.9.0");
        assert!(needed(dir.path(), PACKAGE, "@scope/agent@1.11.0", PLATFORM)
            .await
            .is_some());
        assert_eq!(sidecar(&dir), None);
    }

    #[tokio::test]
    async fn a_confirmed_newest_available_version_is_not_reinstalled() {
        let dir = installed("1.9.0");
        let spec = "@scope/agent@1.11.0";
        write_wanted_spec(
            dir.path(),
            &resolved_sidecar(spec, "1.9.0", SystemTime::now()),
        )
        .await;
        assert_eq!(needed(dir.path(), PACKAGE, spec, PLATFORM).await, None);

        // The confirmation is for that version only.
        let dir = installed("1.8.0");
        write_wanted_spec(
            dir.path(),
            &resolved_sidecar(spec, "1.9.0", SystemTime::now()),
        )
        .await;
        assert!(needed(dir.path(), PACKAGE, spec, PLATFORM).await.is_some());

        // And a registry bump past it still installs.
        let dir = installed("1.9.0");
        write_wanted_spec(
            dir.path(),
            &resolved_sidecar(spec, "1.9.0", SystemTime::now()),
        )
        .await;
        assert!(needed(dir.path(), PACKAGE, "@scope/agent@1.12.0", PLATFORM)
            .await
            .is_some());
    }

    /// "npm does not have it yet" is only true for now: an expired record, or
    /// one in the original unstamped format, sends the next connect back to
    /// npm rather than pinning the old copy until the registry moves.
    #[tokio::test]
    async fn a_newest_available_record_expires() {
        let spec = "@scope/agent@1.11.0";
        let dir = installed("1.9.0");
        let long_ago = SystemTime::now() - NEWEST_AVAILABLE_TTL - Duration::from_secs(60);
        write_wanted_spec(dir.path(), &resolved_sidecar(spec, "1.9.0", long_ago)).await;
        assert_eq!(
            needed(dir.path(), PACKAGE, spec, PLATFORM).await.as_deref(),
            Some(
                "re-checking whether npm serves @scope/agent@1.11.0 yet (it last confirmed 1.9.0)"
            )
        );

        let dir = installed("1.9.0");
        write_wanted_spec(dir.path(), &format!("{spec}#newest-available=1.9.0")).await;
        assert!(needed(dir.path(), PACKAGE, spec, PLATFORM).await.is_some());
    }

    /// The listing reads the version on disk per card, and the Update button
    /// drops the sidecar — including a `newest-available` one, which is the
    /// record that would otherwise keep an older copy from ever being retried.
    #[tokio::test]
    async fn the_installed_version_is_read_and_the_decision_can_be_forgotten() {
        let registry = tempfile::tempdir().unwrap();
        assert_eq!(
            installed_npx_version(registry.path(), "agent", "@scope/agent@1.11.0"),
            None
        );

        let dir = npx_install_dir(registry.path(), "agent");
        let package = dir.join("node_modules/@scope/agent");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(package.join("package.json"), r#"{"version":"1.9.0"}"#).unwrap();
        assert_eq!(
            installed_npx_version(registry.path(), "agent", "@scope/agent@1.11.0").as_deref(),
            Some("1.9.0")
        );

        write_wanted_spec(
            &dir,
            &resolved_sidecar("@scope/agent@1.11.0", "1.9.0", SystemTime::now()),
        )
        .await;
        forget_npx_install_decision(registry.path(), "agent")
            .await
            .unwrap();
        assert_eq!(read_wanted_spec(&dir).await, None);
        // Nothing to forget is not an error.
        forget_npx_install_decision(registry.path(), "agent")
            .await
            .unwrap();
    }

    #[test]
    fn a_runnable_older_copy_is_recorded_with_a_retry_after_stamp() {
        let spec = "@scope/agent@1.11.0";
        let now = SystemTime::now();
        assert_eq!(
            InstallOutcome::AtCeiling.sidecar(spec, now).as_deref(),
            Some(spec)
        );
        let newest = InstallOutcome::NewestAvailable("1.9.0".into())
            .sidecar(spec, now)
            .expect("recorded");
        assert!(newest_available_is_fresh(&newest, spec, "1.9.0", now));

        // An offline fallback and a kept previous install both record the
        // copy that is running and when it was last tried, so the next
        // connect runs on it instead of redoing the install ladder — and the
        // record lapses, so the registry's version is tried again.
        for outcome in [
            InstallOutcome::Stale("1.9.0".into()),
            InstallOutcome::KeptPrevious("1.9.0".into()),
        ] {
            let stale = outcome.sidecar(spec, now).expect("recorded");
            assert!(stale_is_fresh(&stale, spec, "1.9.0", now));
            assert!(
                !stale_is_fresh(&stale, spec, "1.8.0", now),
                "tied to the version"
            );
            assert!(
                !stale_is_fresh(&stale, spec, "1.9.0", now + STALE_RETRY_AFTER),
                "lapses"
            );
        }
    }

    #[tokio::test]
    async fn an_equal_sidecar_skips_the_install() {
        let dir = installed("1.11.0");
        write_wanted_spec(dir.path(), "@scope/agent@1.11.0").await;

        assert_eq!(
            needed(dir.path(), PACKAGE, "@scope/agent@1.11.0", PLATFORM).await,
            None
        );
    }

    #[tokio::test]
    async fn a_missing_or_out_of_range_install_is_reported_before_the_sidecar() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            needed(dir.path(), PACKAGE, "@scope/agent@1.11.0", PLATFORM)
                .await
                .as_deref(),
            Some("package.json missing or unparsable")
        );
        assert_eq!(sidecar(&dir), None, "nothing is adopted without an install");

        let dir = installed("2.0.0");
        assert!(needed(dir.path(), PACKAGE, "@scope/agent@1.11.0", PLATFORM)
            .await
            .is_some_and(|reason| reason.contains("outside the ceiling")));
        assert_eq!(sidecar(&dir), None);
    }

    #[tokio::test]
    async fn a_missing_platform_package_forces_a_reinstall_and_is_not_adopted() {
        // The user's exact state: top-level package fine, sidecar absent
        // (or equal), npm silently dropped the optional platform package.
        let dir = installed_without_platform_package("1.11.0");
        assert_eq!(
            needed(dir.path(), PACKAGE, "@scope/agent@1.11.0", PLATFORM)
                .await
                .as_deref(),
            Some("platform package(s) missing or inert: node_modules/@scope/agent-darwin-arm64")
        );
        assert_eq!(sidecar(&dir), None, "a broken tree must not be adopted");

        write_wanted_spec(dir.path(), "@scope/agent@1.11.0").await;
        assert!(
            needed(dir.path(), PACKAGE, "@scope/agent@1.11.0", PLATFORM)
                .await
                .is_some(),
            "an equal sidecar must not mask a missing platform package"
        );
    }

    #[tokio::test]
    async fn an_incomplete_tree_without_hidden_lockfile_is_reinstalled() {
        let dir = installed("1.11.0");
        std::fs::remove_file(dir.path().join("node_modules/.package-lock.json")).unwrap();
        assert_eq!(
            needed(dir.path(), PACKAGE, "@scope/agent@1.11.0", PLATFORM)
                .await
                .as_deref(),
            Some("install incomplete: node_modules has no .package-lock.json")
        );
    }

    #[tokio::test]
    async fn an_unsupported_host_skips_the_platform_check() {
        let dir = installed_without_platform_package("1.11.0");
        assert_eq!(
            needed(dir.path(), PACKAGE, "@scope/agent@1.11.0", None).await,
            None
        );
    }

    #[tokio::test]
    async fn wiping_removes_node_modules_and_the_lockfile_but_keeps_the_sidecar() {
        let dir = installed("1.11.0");
        std::fs::write(dir.path().join("package-lock.json"), "{}").unwrap();
        write_wanted_spec(dir.path(), "@scope/agent@1.11.0").await;

        wipe_install_tree(dir.path()).await.unwrap();
        assert!(!dir.path().join("node_modules").exists());
        assert!(!dir.path().join("package-lock.json").exists());
        assert!(sidecar(&dir).is_some());
        // Idempotent on an already-clean dir.
        wipe_install_tree(dir.path()).await.unwrap();
    }
}
