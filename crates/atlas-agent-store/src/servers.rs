//! The three ways an installed agent resolves to a command line.
//!
//! Each implements [`ExternalAgentServer`], the seam
//! `atlas-agent-servers` left open in stage 1: given extra args and extra env,
//! produce an [`AgentServerCommand`]. Ported from
//! `agent_server_store.rs:1130-1500`.
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

use anyhow::{Context as _, Result};
use atlas_agent_servers::connection::AgentServerCommand;
use atlas_agent_servers::server::ExternalAgentServer;
use futures::future::BoxFuture;
use tokio::sync::watch;

use crate::archive::{
    github_release_archive_from_url, github_release_digest, install_archive,
    registry_archive_kind_for_url, remove_stale_versioned_archive_cache_dirs, sanitize_path_component,
    versioned_archive_cache_dir,
};
use crate::http::HttpClient;
use crate::node::{bounded_npm_package_spec, npm_command_env, read_package_executable, NodeRuntime};
use crate::registry::{current_platform_key, RegistryTargetConfig};

/// The environment an agent inherits from the project it is opened in.
///
/// Zed reads this from its `ProjectEnvironment` entity, which runs the user's
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

/// Divergence from Zed: a custom entry's own `env` is the *settings* layer here
/// and so beats `extra`, where Zed layers it below `extra`
/// (`agent_server_store.rs:1489-1494`). Zed's own registry path puts the
/// settings env on top; a custom entry's env is settings by definition, and
/// having the launcher's env workarounds silently override something the user
/// typed for this one agent is the surprising reading of the two.
pub struct LocalCustomAgent {
    pub(crate) command: AgentServerCommand,
    pub(crate) project_env: Arc<dyn ProjectEnvironment>,
    pub(crate) byok_env: HashMap<String, String>,
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
        Box::pin(async move {
            // A custom entry's own env is the "settings" layer — it is the most
            // specific thing the user said about this agent.
            let settings_env = command.env.take().unwrap_or_default();
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
    pub(crate) settings_env: HashMap<String, String>,
    pub(crate) byok_env: HashMap<String, String>,
    pub(crate) loading_status: Option<watch::Sender<Option<String>>>,
}

impl ExternalAgentServer for LocalRegistryArchiveAgent {
    fn version(&self) -> Option<Arc<str>> {
        Some(self.version.clone())
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
        let settings_env = self.settings_env.clone();
        let byok_env = self.byok_env.clone();
        let loading_status = self.loading_status.clone();

        Box::pin(async move {
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

            let env = layered_env(
                project_env.await,
                &target.env,
                extra_env,
                &byok_env,
                &settings_env,
            );

            let archive_url = &target.archive;
            let version_dir = versioned_archive_cache_dir(
                &installation_dir,
                Some(&version),
                archive_url,
                target.sha256.as_deref(),
            );

            if !is_dir(&version_dir).await {
                if let Some(tx) = &loading_status {
                    tx.send(Some(format!("Installing {version}…"))).ok();
                }

                // The registry's own checksum wins; failing that, GitHub's
                // recorded digest for the release asset. Both absent means an
                // unverified install, which is what Zed does too.
                let sha256 = match &target.sha256 {
                    Some(sha256) => Some(sha256.clone()),
                    None => match github_release_archive_from_url(archive_url) {
                        Some(release) => github_release_digest(&*http, &release).await,
                        None => None,
                    },
                };

                let kind = registry_archive_kind_for_url(archive_url)?;
                install_archive(&*http, archive_url, sha256.as_deref(), &version_dir, &kind).await?;
            }

            let cmd_path = resolve_target_cmd(&node, &target.cmd, &version_dir).await?;

            // Detached, as in Zed: the previous version's directory is dead
            // weight, not a correctness problem, and removing it should never
            // delay the agent starting.
            tokio::spawn({
                let installation_dir = installation_dir.clone();
                let version_dir = version_dir.clone();
                async move {
                    if let Err(error) =
                        remove_stale_versioned_archive_cache_dirs(&installation_dir, &version_dir)
                            .await
                    {
                        tracing::warn!(error = %format!("{error:#}"), "archive cache GC failed");
                    }
                }
            });

            let mut args = target.args.clone();
            args.extend(extra_args);

            Ok(AgentServerCommand {
                path: cmd_path,
                args,
                env: Some(env),
            })
        })
    }
}

/// Ported from `agent_server_store.rs:1282-1302`.
///
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

    anyhow::ensure!(
        !cmd.contains(".."),
        "command path cannot contain '..': {cmd}"
    );
    let relative = cmd
        .strip_prefix("./")
        .or_else(|| cmd.strip_prefix(".\\"))
        .with_context(|| format!("command must be relative (start with './'): {cmd}"))?;

    let cmd_path = version_dir.join(relative);
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

// ------------------------------------------------------- registry: npx target

pub struct LocalRegistryNpxAgent {
    pub(crate) node: NodeRuntime,
    pub(crate) project_env: Arc<dyn ProjectEnvironment>,
    pub(crate) install_dir: PathBuf,
    pub(crate) version: Arc<str>,
    pub(crate) package: String,
    pub(crate) args: Vec<String>,
    pub(crate) distribution_env: HashMap<String, String>,
    pub(crate) settings_env: HashMap<String, String>,
    pub(crate) byok_env: HashMap<String, String>,
}

impl ExternalAgentServer for LocalRegistryNpxAgent {
    fn version(&self) -> Option<Arc<str>> {
        Some(self.version.clone())
    }

    fn get_command(
        &self,
        extra_args: Vec<String>,
        extra_env: HashMap<String, String>,
    ) -> BoxFuture<'static, Result<AgentServerCommand>> {
        let node = self.node.clone();
        let project_env = self.project_env.project_env();
        let install_dir = self.install_dir.clone();
        let package = self.package.clone();
        let args = self.args.clone();
        let distribution_env = self.distribution_env.clone();
        let settings_env = self.settings_env.clone();
        let byok_env = self.byok_env.clone();

        Box::pin(async move {
            tokio::fs::create_dir_all(&install_dir)
                .await
                .with_context(|| format!("creating {install_dir:?}"))?;

            let (package_name, package_spec) = bounded_npm_package_spec(&package);
            node.run_npm_subcommand(
                Some(&install_dir),
                "install",
                &[package_spec.as_str(), "--save-exact"],
            )
            .await?;

            let executable =
                read_package_executable(&install_dir.join("node_modules"), package_name).await?;
            let node_binary = node.binary_path().await?;

            // npm's own env (the managed Node first on `PATH`) layers over the
            // project's and under the distribution's, exactly as Zed orders it
            // at `agent_server_store.rs:1405-1411`. It has to beat the project
            // env specifically: the project almost always has a `PATH` of its
            // own, and the point of this layer is that ours wins.
            let mut base = project_env.await;
            base.extend(npm_command_env(&node_binary));
            let env = layered_env(base, &distribution_env, extra_env, &byok_env, &settings_env);

            let mut command_args = vec![executable.to_string_lossy().into_owned()];
            command_args.extend(args);
            command_args.extend(extra_args);

            Ok(AgentServerCommand {
                path: node_binary,
                args: command_args,
                env: Some(env),
            })
        })
    }
}

/// `<external-agents>/registry/npx/<id>` — one install directory per agent, so
/// two agents depending on different versions of the same package cannot fight.
pub(crate) fn npx_install_dir(registry_dir: &std::path::Path, id: &str) -> PathBuf {
    registry_dir.join("npx").join(sanitize_path_component(id))
}

async fn is_dir(path: &std::path::Path) -> bool {
    tokio::fs::metadata(path)
        .await
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false)
}
