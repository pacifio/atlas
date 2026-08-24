//! The managed Node runtime.
//!
//! Ported from `zed-ref/crates/node_runtime/src/node_runtime.rs` (its
//! `ManagedNodeRuntime`, `read_package_executable`, `npm_command_env`) and used
//! for exactly the two things Zed uses it for: running an npx-distributed agent,
//! and satisfying a binary target whose `cmd` is `"node"`.
//!
//! DECIDED, research §D12-8: managed only. Zed can fall back to a system Node;
//! Atlas does not, and this is what retires `node_setup.rs`'s nvm flow. The
//! reason is the one Zed gives implicitly by requiring `cmd == "node"` and
//! supplying its own runtime — an agent that works on the developer's machine
//! and not on the user's because their Node is three majors old is a support
//! burden with no upside.
//!
//! Nothing here is on a spawn ladder: this runtime is never *searched for*, it
//! is downloaded to a known path and used from there.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Output;
use std::sync::Arc;

use anyhow::{bail, Context as _, Result};
use semver::Version;

use crate::archive::{install_archive, registry_archive_kind_for_url};
use crate::http::HttpClient;

const NODE_VERSION: &str = "v24.11.0";
const NODE_CA_CERTS_ENV_VAR: &str = "NODE_EXTRA_CA_CERTS";

#[cfg(not(windows))]
const NODE_PATH: &str = "bin/node";
#[cfg(windows)]
const NODE_PATH: &str = "node.exe";

// `bin/npm` in the distribution is a symlink to npm's CLI entry point, so
// `node bin/npm …` runs npm without a shell. Windows ships no such symlink.
#[cfg(not(windows))]
const NPM_PATH: &str = "bin/npm";
#[cfg(windows)]
const NPM_PATH: &str = "node_modules/npm/bin/npm-cli.js";

#[derive(Clone)]
pub struct NodeRuntime(Arc<Inner>);

enum Inner {
    Managed {
        containing_dir: PathBuf,
        http: Arc<dyn HttpClient>,
        /// Serialises installation: two agents resolving at once must not both
        /// download Node over the top of each other.
        install: tokio::sync::Mutex<Option<PathBuf>>,
    },
    Unavailable(String),
}

impl NodeRuntime {
    /// A runtime that installs itself under `<data_dir>/node` on first use.
    pub fn managed(data_dir: &Path, http: Arc<dyn HttpClient>) -> Self {
        Self(Arc::new(Inner::Managed {
            containing_dir: data_dir.join("node"),
            http,
            install: tokio::sync::Mutex::new(None),
        }))
    }

    /// A runtime that fails with `reason` when anything asks for it. Zed's
    /// `NodeRuntime::unavailable()`; here it is how a test builds a store whose
    /// agents never need Node.
    pub fn unavailable(reason: impl Into<String>) -> Self {
        Self(Arc::new(Inner::Unavailable(reason.into())))
    }

    pub async fn binary_path(&self) -> Result<PathBuf> {
        Ok(self.install_if_needed().await?.join(NODE_PATH))
    }

    /// Run `npm <subcommand> <args>`, retrying once.
    ///
    /// The retry is Zed's (`node_runtime.rs:764-800`) and is not superstition:
    /// npm's first run after an install can fail while it populates its cache.
    pub async fn run_npm_subcommand(
        &self,
        directory: Option<&Path>,
        subcommand: &str,
        args: &[&str],
    ) -> Result<Output> {
        let node_dir = self.install_if_needed().await?;

        let mut output = self.npm_attempt(&node_dir, directory, subcommand, args).await;
        if output.is_err() {
            output = self.npm_attempt(&node_dir, directory, subcommand, args).await;
        }
        let output = output.with_context(|| format!("launching npm {subcommand}"))?;

        anyhow::ensure!(
            output.status.success(),
            "failed to execute npm {subcommand} subcommand:\nstdout: {:?}\nstderr: {:?}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
        Ok(output)
    }

    async fn npm_attempt(
        &self,
        node_dir: &Path,
        directory: Option<&Path>,
        subcommand: &str,
        args: &[&str],
    ) -> Result<Output> {
        let node_binary = node_dir.join(NODE_PATH);
        let npm_file = node_dir.join(NPM_PATH);
        anyhow::ensure!(
            tokio::fs::metadata(&node_binary).await.is_ok(),
            "missing node binary file"
        );
        anyhow::ensure!(
            tokio::fs::metadata(&npm_file).await.is_ok(),
            "missing npm file"
        );

        let mut command = tokio::process::Command::new(&node_binary);
        command.args(npm_command_args(&npm_file, node_dir, directory, subcommand, args));
        command.envs(npm_command_env(&node_binary));
        if let Some(directory) = directory {
            command.current_dir(directory);
        }
        Ok(command.output().await?)
    }

    async fn install_if_needed(&self) -> Result<PathBuf> {
        let (containing_dir, http, install) = match &*self.0 {
            Inner::Unavailable(reason) => bail!("Node.js is unavailable: {reason}"),
            Inner::Managed {
                containing_dir,
                http,
                install,
            } => (containing_dir, http, install),
        };

        let mut install = install.lock().await;
        if let Some(node_dir) = install.as_ref() {
            return Ok(node_dir.clone());
        }

        let (os, arch) = node_platform()?;
        let node_dir = containing_dir.join(format!("node-{NODE_VERSION}-{os}-{arch}"));

        if !node_install_works(&node_dir).await {
            // Not just the version directory: Zed wipes the whole containing
            // directory (`node_runtime.rs:680-683`) so an abandoned install of
            // another version does not accumulate.
            let _ = tokio::fs::remove_dir_all(containing_dir).await;

            let extension = if cfg!(windows) { "zip" } else { "tar.gz" };
            let url = format!(
                "https://nodejs.org/dist/{NODE_VERSION}/node-{NODE_VERSION}-{os}-{arch}.{extension}"
            );
            tracing::info!(url, "downloading the managed Node.js runtime");

            // The tarball's single top-level directory is the version directory,
            // so extracting it *into* the containing dir produces `node_dir`.
            let kind = registry_archive_kind_for_url(&url)?;
            install_archive(&**http, &url, None, containing_dir, &kind)
                .await
                .context("installing the managed Node.js runtime")?;

            anyhow::ensure!(
                node_install_works(&node_dir).await,
                "the downloaded Node.js runtime at {node_dir:?} does not run"
            );
        }

        // Outside the install branch on purpose, so an installation from an
        // earlier Atlas version gets these too.
        let _ = tokio::fs::remove_dir_all(node_dir.join("cache")).await;
        let _ = tokio::fs::create_dir_all(node_dir.join("cache")).await;
        let _ = tokio::fs::write(node_dir.join("blank_user_npmrc"), []).await;
        let _ = tokio::fs::write(node_dir.join("blank_global_npmrc"), []).await;

        *install = Some(node_dir.clone());
        Ok(node_dir)
    }
}

/// Whether the Node at `node_dir` actually runs.
///
/// Zed checks by running npm rather than by checking the file exists
/// (`node_runtime.rs:641-676`): a half-extracted or wrong-architecture install
/// has the file and fails at the worst possible moment otherwise.
async fn node_install_works(node_dir: &Path) -> bool {
    let node_binary = node_dir.join(NODE_PATH);
    if tokio::fs::metadata(&node_binary).await.is_err() {
        return false;
    }

    let npm_file = node_dir.join(NPM_PATH);
    let result = tokio::process::Command::new(&node_binary)
        .env(
            NODE_CA_CERTS_ENV_VAR,
            std::env::var(NODE_CA_CERTS_ENV_VAR).unwrap_or_default(),
        )
        .arg(&npm_file)
        .arg("--version")
        .args(["--cache".into(), node_dir.join("cache")])
        .args(["--userconfig".into(), node_dir.join("blank_user_npmrc")])
        .args(["--globalconfig".into(), node_dir.join("blank_global_npmrc")])
        .output()
        .await;

    match result {
        Ok(output) if output.status.success() => true,
        Ok(output) => {
            tracing::warn!(
                node = %node_binary.display(),
                stderr = %String::from_utf8_lossy(&output.stderr),
                "the managed Node.js binary failed its check"
            );
            false
        }
        Err(error) => {
            tracing::warn!(
                node = %node_binary.display(),
                %error,
                "the managed Node.js binary could not be run"
            );
            false
        }
    }
}

fn node_platform() -> Result<(&'static str, &'static str)> {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "linux" => "linux",
        "windows" => "win",
        other => bail!("running on unsupported os: {other}"),
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => bail!("running on unsupported architecture: {other}"),
    };
    Ok((os, arch))
}

/// Ported from `build_npm_command_args` (`node_runtime.rs:1124-1158`). Every
/// path is pinned at the managed install so npm never reads the user's npmrc or
/// writes their global cache.
fn npm_command_args(
    npm_file: &Path,
    node_dir: &Path,
    prefix_dir: Option<&Path>,
    subcommand: &str,
    args: &[&str],
) -> Vec<String> {
    let mut command_args = vec![npm_file.to_string_lossy().into_owned()];
    if let Some(prefix_dir) = prefix_dir {
        command_args.push("--prefix".into());
        command_args.push(prefix_dir.to_string_lossy().into_owned());
    }
    command_args.push(subcommand.to_string());
    command_args.push(format!("--cache={}", node_dir.join("cache").display()));
    command_args.push("--userconfig".into());
    command_args.push(node_dir.join("blank_user_npmrc").to_string_lossy().into_owned());
    command_args.push("--globalconfig".into());
    command_args.push(
        node_dir
            .join("blank_global_npmrc")
            .to_string_lossy()
            .into_owned(),
    );
    command_args.extend(args.iter().map(|arg| arg.to_string()));
    command_args
}

/// The environment an npx-distributed agent needs: the managed Node first on
/// `PATH`, so a package that shells out to `node` gets ours rather than
/// whatever the user has (`node_runtime.rs:1160-1190`).
pub fn npm_command_env(node_binary: &Path) -> HashMap<String, String> {
    let mut env = HashMap::new();
    if let Some(path) = path_with_node_binary_prepended(node_binary) {
        env.insert("PATH".to_string(), path);
    }

    if let Ok(node_ca_certs) = std::env::var(NODE_CA_CERTS_ENV_VAR) {
        if !node_ca_certs.is_empty() {
            env.insert(NODE_CA_CERTS_ENV_VAR.to_string(), node_ca_certs);
        }
    }

    #[cfg(windows)]
    {
        for key in ["SYSTEMROOT", "ComSpec"] {
            if let Ok(value) = std::env::var(key) {
                env.insert(key.to_string(), value);
            }
        }
    }

    env
}

fn path_with_node_binary_prepended(node_binary: &Path) -> Option<String> {
    let node_bin_dir = node_binary.parent()?;
    let existing = std::env::var_os("PATH");
    let joined = match &existing {
        Some(existing) => std::env::join_paths(
            std::iter::once(node_bin_dir.to_path_buf())
                .chain(std::env::split_paths(existing)),
        )
        .ok()?,
        None => node_bin_dir.as_os_str().to_owned(),
    };
    Some(joined.to_string_lossy().into_owned())
}

/// The executable an npm package declares, resolved out of its `package.json`.
/// Ported from `node_runtime.rs:1019-1064`.
pub async fn read_package_executable(node_modules_dir: &Path, name: &str) -> Result<PathBuf> {
    #[derive(serde::Deserialize)]
    #[serde(untagged)]
    enum Bin {
        Path(String),
        Named(HashMap<String, String>),
    }

    #[derive(serde::Deserialize)]
    struct PackageJson {
        bin: Option<Bin>,
    }

    let package_directory = node_modules_dir.join(name);
    let package_json_path = package_directory.join("package.json");
    let contents = tokio::fs::read_to_string(&package_json_path)
        .await
        .with_context(|| format!("opening {}", package_json_path.display()))?;
    let package_json: PackageJson = serde_json::from_str(&contents)
        .with_context(|| format!("parsing {}", package_json_path.display()))?;

    let relative_path = match package_json.bin {
        Some(Bin::Path(path)) => path,
        Some(Bin::Named(bins)) => {
            let unscoped_name = name.rsplit('/').next().unwrap_or(name);
            let path = if bins.len() == 1 {
                bins.values().next()
            } else {
                bins.get(unscoped_name)
            };
            path.with_context(|| {
                format!("npm package {name} declares no executable named {unscoped_name}")
            })?
            .clone()
        }
        None => bail!("npm package {name} declares no executable"),
    };

    Ok(package_directory.join(relative_path))
}

/// Turn `pkg@1.2.3` into `("pkg", "pkg@0.0.0 - 1.2.3")` — a version *ceiling*,
/// not a pin.
///
/// Ported verbatim, comment and all, from `agent_server_store.rs:1436-1477`:
///
/// > People are using min-release-age more frequently. Which means a fresh
/// > registry will likely have new package versions than the user can install.
/// > We set the version to now be a ceiling and not an exact pin instead. This
/// > allows npm to resolve the latest version it can find that satisfies the
/// > constraint. […] This is a best-effort attempt to install a version that
/// > works without overriding the user's security settings.
/// >
/// > We use npm's hyphen-range syntax (`0.0.0 - <version>`, equivalent to
/// > `<=<version>`) instead of the more compact `<=<version>` form because on
/// > Windows, `npm` is `npm.cmd` (a batch file run by cmd.exe), and the quotes
/// > our shell builder emits are PowerShell string-literal syntax that PS strips
/// > during parsing. […] so `package@<=0.25.3` reaches cmd.exe bare and the
/// > unquoted `<` is interpreted as input redirection. See
/// > zed-industries/zed#55921.
pub fn bounded_npm_package_spec(package_spec: &str) -> (&str, String) {
    let Some((package_name, version)) = package_spec.rsplit_once('@') else {
        return (package_spec, package_spec.to_string());
    };
    if package_name.is_empty() {
        return (package_spec, package_spec.to_string());
    }
    if Version::parse(version).is_err() {
        return (package_name, package_spec.to_string());
    }

    (package_name, format!("{package_name}@0.0.0 - {version}"))
}
