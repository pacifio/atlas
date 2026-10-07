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
use std::time::Duration;

use anyhow::{bail, Context as _, Result};
use semver::Version;
use tokio::sync::watch;

use crate::archive::{install_archive, registry_archive_kind_for_url};
use crate::http::{get_body, HttpClient};

const NODE_VERSION: &str = "v24.11.0";
const NODE_CA_CERTS_ENV_VAR: &str = "NODE_EXTRA_CA_CERTS";

/// How long one `npm <subcommand>` other than `install` may run before it is
/// killed. npm's own fetch timeout (see [`npm_command_args`]) is an *idle*
/// timeout per socket, so it never bounds a slow-but-flowing download; this
/// does, so a wedged run cannot hold a "Starting …" bubble forever.
const NPM_TIMEOUT: Duration = Duration::from_secs(600);

/// The same deadline for `npm install`. Codex alone is a 220 MB platform
/// tarball plus ~70 MB more; at ten minutes anything under ~500 KB/s was
/// killed mid-extract, and the half-written tree it left behind looked
/// installed (see [`crate::npm_tree`]). Thirty minutes is ~160 KB/s.
const NPM_INSTALL_TIMEOUT: Duration = Duration::from_secs(1800);

/// A subcommand's deadline.
fn npm_timeout(subcommand: &str) -> Duration {
    if subcommand == "install" {
        NPM_INSTALL_TIMEOUT
    } else {
        NPM_TIMEOUT
    }
}

/// How long the Node tarball download + extract may take while holding the
/// install lock. Past this, every agent waiting on Node fails with a clear
/// error instead of queueing behind a stalled socket.
const NODE_INSTALL_TIMEOUT: Duration = Duration::from_secs(900);

/// How long the `SHASUMS256.txt` fetch may take. Short: it is a few kilobytes
/// from the same host the tarball comes from, so a slow one means the release
/// server is unwell and the download after it would have failed anyway.
const NODE_SHASUMS_TIMEOUT: Duration = Duration::from_secs(30);

/// What the managed user-level npmrc pins. `update-notifier=false` stops npm
/// making a `GET registry.npmjs.org/npm` on every run just to advertise a
/// newer npm — one fewer network round-trip on the agent start path.
const USER_NPMRC: &str = "update-notifier=false\n";

/// A loading-status channel, as the store hands it out (`Some(text)` while
/// something is in flight, `None` when the agent is ready).
pub type LoadingStatus = watch::Sender<Option<String>>;

#[cfg(not(windows))]
pub(crate) const NODE_PATH: &str = "bin/node";
#[cfg(windows)]
pub(crate) const NODE_PATH: &str = "node.exe";

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
        Ok(self.install_if_needed(None).await?.join(NODE_PATH))
    }

    /// Install Node if it is missing, reporting a download to `loading_status`.
    ///
    /// Callers that will go on to run npm call this first, so the user sees
    /// "Downloading Node.js…" during the one step that can take minutes rather
    /// than a bare "Starting …". When Node is already present nothing is sent.
    pub async fn ensure_installed(
        &self,
        loading_status: Option<&LoadingStatus>,
    ) -> Result<PathBuf> {
        self.install_if_needed(loading_status).await
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
        let node_dir = self.install_if_needed(None).await?;

        let mut output = self
            .npm_attempt(&node_dir, directory, subcommand, args)
            .await;
        // Retry spawn/IO failures only. A timeout already waited ten minutes;
        // doing it again would double the hang the deadline exists to end.
        if output
            .as_ref()
            .is_err_and(|error| !error.is::<NpmTimedOut>())
        {
            output = self
                .npm_attempt(&node_dir, directory, subcommand, args)
                .await;
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

        let mut command = atlas_process::async_command(&node_binary);
        command.args(npm_command_args(
            &npm_file, node_dir, directory, subcommand, args,
        ));
        command.envs(npm_command_env(&node_binary));
        for key in inherited_npm_config_keys(std::env::vars_os().map(|(key, _)| key)) {
            command.env_remove(key);
        }
        if let Some(directory) = directory {
            // Node reports a verbatim working directory back verbatim as
            // `process.cwd()`, and npm resolves any path-like spec against it
            // (`npm error Invalid file: URL, must comply with RFC 8089`).
            command.current_dir(plain_process_path(directory));
        }
        // Dropping the future on timeout must take the npm process with it,
        // or the next attempt races an orphan over the same `node_modules`.
        command.kill_on_drop(true);

        let timeout = npm_timeout(subcommand);
        match tokio::time::timeout(timeout, command.output()).await {
            Ok(output) => Ok(output?),
            Err(_elapsed) => Err(NpmTimedOut {
                subcommand: subcommand.to_owned(),
                timeout,
            }
            .into()),
        }
    }

    // The `install` guard is held across the download and extract on purpose:
    // it is a double-checked install lock, and the whole point is that a second
    // caller waits rather than racing a `remove_dir_all(containing_dir)` against
    // an extraction already in flight. That is what `tokio::sync::Mutex` is for.
    #[expect(
        clippy::await_holding_invalid_type,
        reason = "the install lock must span the download so concurrent callers do not race the extract"
    )]
    async fn install_if_needed(&self, loading_status: Option<&LoadingStatus>) -> Result<PathBuf> {
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
            let file_name = format!("node-{NODE_VERSION}-{os}-{arch}.{extension}");
            let url = format!("https://nodejs.org/dist/{NODE_VERSION}/{file_name}");
            tracing::info!(url, "downloading the managed Node.js runtime");
            if let Some(tx) = loading_status {
                tx.send(Some("Downloading Node.js…".to_owned())).ok();
            }

            // Before the bytes, the digest for them. This runtime is about to
            // be executed as a child process on every npx agent, and unlike
            // the registry it costs nothing to verify.
            let digest = node_archive_digest(&**http, &file_name).await?;

            // The tarball's single top-level directory is the version directory,
            // so extracting it *into* the containing dir produces `node_dir`.
            let kind = registry_archive_kind_for_url(&url)?;
            // Bounded, because the install lock is held across this: a stalled
            // nodejs.org socket would otherwise block every agent for good.
            // A timeout leaves `install` as `None`, so the next caller retries.
            tokio::time::timeout(
                NODE_INSTALL_TIMEOUT,
                install_archive(&**http, &url, Some(&digest), containing_dir, &kind),
            )
            .await
            .map_err(|_elapsed| {
                anyhow::anyhow!(
                    "the Node.js runtime download from {url} did not finish within {} minutes \
                     (nodejs.org may be unreachable)",
                    NODE_INSTALL_TIMEOUT.as_secs() / 60
                )
            })?
            .context("installing the managed Node.js runtime")?;

            anyhow::ensure!(
                node_install_works(&node_dir).await,
                "the downloaded Node.js runtime at {node_dir:?} does not run"
            );

            // A fresh runtime starts with a fresh npm cache. This is the only
            // place the cache is wiped: keeping it across launches is what lets
            // an install revalidate metadata instead of re-downloading tarballs,
            // and lets an offline host fall back to what it already fetched.
            let _ = tokio::fs::remove_dir_all(node_dir.join("cache")).await;
        }

        // Outside the install branch on purpose, so an installation from an
        // earlier Atlas version gets these too.
        let _ = tokio::fs::create_dir_all(node_dir.join("cache")).await;
        let _ = tokio::fs::write(node_dir.join("blank_user_npmrc"), USER_NPMRC).await;
        let _ = tokio::fs::write(node_dir.join("blank_global_npmrc"), []).await;

        *install = Some(node_dir.clone());
        Ok(node_dir)
    }
}

/// `npm <subcommand>` outlived its deadline ([`npm_timeout`]) and was killed.
///
/// Its own type so [`NodeRuntime::run_npm_subcommand`] can tell it apart from
/// a spawn failure and skip the retry.
#[derive(Debug)]
struct NpmTimedOut {
    subcommand: String,
    timeout: Duration,
}

impl std::fmt::Display for NpmTimedOut {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "npm {} did not finish within {} minutes (the npm registry may be unreachable)",
            self.subcommand,
            self.timeout.as_secs() / 60
        )
    }
}

impl std::error::Error for NpmTimedOut {}

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
    let result = atlas_process::async_command(&node_binary)
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

/// The platform npm gates `os`/`cpu` on — `process.platform`/`process.arch` of
/// the managed Node, which is the Atlas build's own arch (an x64 build under
/// Rosetta gets an x64 Node and resolves x64 packages, consistently).
pub fn npm_platform() -> Option<crate::npm_tree::NpmPlatform> {
    let (os, cpu) = node_platform().ok()?;
    let os = if os == "win" { "win32" } else { os };
    Some(crate::npm_tree::NpmPlatform { os, cpu })
}

/// The inherited environment keys npm must not see.
///
/// `--userconfig`/`--globalconfig` only blank the npmrc *files*; `@npmcli/config`
/// still reads every `npm_config_*` variable, and `NODE_ENV=production` flips
/// `omit` to `dev`. A stray `npm_config_omit=optional` or `npm_config_arch`
/// from the user's shell would silently drop the platform package an agent
/// exists to ship.
fn inherited_npm_config_keys(
    keys: impl IntoIterator<Item = std::ffi::OsString>,
) -> Vec<std::ffi::OsString> {
    keys.into_iter()
        .filter(|key| {
            let key = key.to_string_lossy();
            key.to_ascii_lowercase().starts_with("npm_config_") || key == "NODE_ENV"
        })
        .collect()
}

/// The fetch policy every managed npm run gets. Zed's
/// (`node_runtime.rs:1124-1158`) plus bounded network waits: the Codex
/// platform tarball alone is 220 MB. Note `fetch-timeout` is npm's per-socket
/// *idle* timeout (`@npmcli/agent` maps it to `timeouts.idle`), not a transfer
/// cap — it ends a stalled socket, never a slow download; the whole-invocation
/// deadline is [`npm_timeout`]. Audit/fund are two more round-trips that
/// answer nothing we act on.
///
/// No cache policy here (`--prefer-offline` / `--prefer-online`): each caller
/// picks its own, because npm resolves the two by precedence rather than by
/// order — with both on the line `--prefer-offline` wins, so a default here
/// silently overrode every caller that asked to go online.
const NPM_FETCH_ARGS: &[&str] = &[
    "--no-audit",
    "--no-fund",
    "--fetch-timeout",
    "300000",
    "--fetch-retries",
    "2",
    "--fetch-retry-mintimeout",
    "2000",
    "--fetch-retry-maxtimeout",
    "10000",
];

/// Ported from `build_npm_command_args` (`node_runtime.rs:1124-1158`). Every
/// path is pinned at the managed install so npm never reads the user's npmrc or
/// writes their global cache, and every path goes out in its plain spelling
/// ([`plain_process_path`]) whatever the caller resolved it to.
fn npm_command_args(
    npm_file: &Path,
    node_dir: &Path,
    prefix_dir: Option<&Path>,
    subcommand: &str,
    args: &[&str],
) -> Vec<String> {
    let arg = |path: &Path| plain_process_path(path).to_string_lossy().into_owned();
    let mut command_args = vec![arg(npm_file)];
    if let Some(prefix_dir) = prefix_dir {
        command_args.push("--prefix".into());
        command_args.push(arg(prefix_dir));
    }
    command_args.push(subcommand.to_string());
    command_args.push(format!("--cache={}", arg(&node_dir.join("cache"))));
    command_args.push("--userconfig".into());
    command_args.push(arg(&node_dir.join("blank_user_npmrc")));
    command_args.push("--globalconfig".into());
    command_args.push(arg(&node_dir.join("blank_global_npmrc")));
    command_args.extend(NPM_FETCH_ARGS.iter().map(std::string::ToString::to_string));
    command_args.extend(args.iter().map(std::string::ToString::to_string));
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
    // Plain for the same reason as npm's arguments: whatever runs `node` off
    // this `PATH` (npm's lifecycle scripts, the agent's own children) hands
    // the directory on to Node.
    let node_bin_dir = plain_process_path(node_binary.parent()?);
    let existing = std::env::var_os("PATH");
    let joined = match &existing {
        Some(existing) => std::env::join_paths(
            std::iter::once(node_bin_dir).chain(std::env::split_paths(existing)),
        )
        .ok()?,
        None => node_bin_dir.into_os_string(),
    };
    Some(joined.to_string_lossy().into_owned())
}

/// The plain spelling of `path`, safe to hand to npm or Node.
///
/// `canonicalize` on Windows returns the `\\?\`-verbatim spelling, and neither
/// child process this crate runs on a path can digest it: npm's Arborist
/// recurses to a stack overflow when it is the `--prefix` (`RangeError:
/// Maximum call stack size exceeded at resolve`), and Node fails with `EISDIR:
/// lstat 'C:'` when it is the script argument — both reproduced in #277, where
/// a clean-install Codex ACP agent could not start at all. Stripping the
/// prefix keeps the symlink resolution `canonicalize` did (the path still
/// points at the same directory); only the spelling changes.
///
/// Only the two spellings that have a plain equivalent are stripped:
/// `\\?\C:\...` (drive) and `\\?\UNC\server\share` (→ `\\server\share`).
/// Device paths (`\\?\Volume{...}`) have no plain spelling and are returned
/// unchanged, as is anything that does not carry the prefix. Not gated on
/// `cfg!(windows)`: POSIX `canonicalize` never produces the prefix, and an
/// unconditional strip keeps this testable on the Linux CI runners — the same
/// call the app makes on Windows.
pub(crate) fn plain_process_path(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    let Some(rest) = text.strip_prefix(r"\\?\") else {
        return path.to_path_buf();
    };
    if let Some(share) = rest.strip_prefix(r"UNC\") {
        return PathBuf::from(format!(r"\\{share}"));
    }
    // `C:\...`: a drive letter, a colon, and a separator. The separator matters
    // — bare `C:` means "the current directory on C", a different location.
    let bytes = rest.as_bytes();
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\' {
        return PathBuf::from(rest);
    }
    path.to_path_buf()
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

/// The version ceiling a package spec implies, if it names a parseable one.
///
/// Same split as [`bounded_npm_package_spec`]: `pkg@1.2.3` → `1.2.3`;
/// `pkg`, `pkg@latest` and a bare scoped name → `None`.
fn package_spec_ceiling(package_spec: &str) -> Option<Version> {
    let (package_name, version) = package_spec.rsplit_once('@')?;
    if package_name.is_empty() {
        return None;
    }
    Version::parse(version).ok()
}

/// Whether an already-installed package satisfies `wanted_spec`, so the
/// `npm install` can be skipped.
///
/// The bounded spec is a ceiling (`0.0.0 - <version>`), so "satisfies" is
/// `installed <= ceiling`. A spec with no parseable version (`pkg`,
/// `pkg@latest`) has no ceiling to check, so any installed copy counts; the
/// caller still requires the package to exist and declare an executable.
pub fn installed_version_satisfies(installed: &str, wanted_spec: &str) -> bool {
    let Some(ceiling) = package_spec_ceiling(wanted_spec) else {
        return true;
    };
    match Version::parse(installed.trim()) {
        Ok(installed) => installed <= ceiling,
        Err(_) => false,
    }
}

/// Whether `installed` is strictly older than the version `wanted_spec` names.
///
/// The ceiling check lets any older copy through on purpose — an offline host
/// can keep running the version it has. But npm resolves the bounded range
/// against whatever packument it has, and one cached before the wanted
/// release was published makes it install an older version and exit 0. This
/// is how the caller tells "npm gave us the release the registry asked for"
/// from "npm gave us whatever its cache knew about".
/// A spec with no ceiling, or a version that does not parse, is never below.
pub fn installed_below_ceiling(installed: &str, wanted_spec: &str) -> bool {
    let Some(ceiling) = package_spec_ceiling(wanted_spec) else {
        return false;
    };
    Version::parse(installed.trim()).is_ok_and(|installed| installed < ceiling)
}

/// The `version` an installed npm package declares, or `None` when it is not
/// installed or its `package.json` does not parse.
pub async fn installed_package_version(node_modules_dir: &Path, name: &str) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct PackageJson {
        version: Option<String>,
    }

    let package_json_path = node_modules_dir.join(name).join("package.json");
    let contents = tokio::fs::read_to_string(&package_json_path).await.ok()?;
    let package_json: PackageJson = serde_json::from_str(&contents).ok()?;
    Some(package_json.version.unwrap_or_default())
}

/// The SHA-256 nodejs.org publishes for `file_name`.
///
/// Required, not best-effort — which is the opposite of how the agent registry
/// is treated, and deliberately so. Half the agent catalogue publishes no
/// digest, and refusing those would remove real agents from Atlas. nodejs.org
/// publishes `SHASUMS256.txt` beside every release without exception, so there
/// is nothing to trade: if the runtime we are about to execute cannot be
/// checked, it does not get installed.
async fn node_archive_digest(http: &dyn HttpClient, file_name: &str) -> Result<String> {
    let url = format!("https://nodejs.org/dist/{NODE_VERSION}/SHASUMS256.txt");
    let (status, body) = get_body(http, &url, NODE_SHASUMS_TIMEOUT)
        .await
        .with_context(|| format!("fetching {url}"))?;

    anyhow::ensure!(
        (200..300).contains(&status),
        "fetching {url} failed with status {status}",
    );

    let listing = String::from_utf8(body).with_context(|| format!("{url} is not UTF-8"))?;
    digest_for(&listing, file_name)
        .with_context(|| format!("{url} publishes no SHA-256 for {file_name}"))
}

/// Pull one file's digest out of a `SHASUMS256.txt` body.
///
/// Lines are `<64 hex><space><space><file name>`. Split on whitespace rather
/// than a fixed column so a single-space or tab variant still reads, and strip
/// the `*` some checksum writers prefix to mean "binary mode".
fn digest_for(listing: &str, file_name: &str) -> Option<String> {
    listing.lines().find_map(|line| {
        let mut fields = line.split_whitespace();
        let digest = fields.next()?;
        let name = fields.next()?;
        let matches = name.trim_start_matches('*') == file_name
            && digest.len() == 64
            && digest.bytes().all(|byte| byte.is_ascii_hexdigit());
        matches.then(|| digest.to_ascii_lowercase())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fetching the digest is worth nothing unless it is handed to the
    /// installer. Reverting `Some(&digest)` to `None` compiles and leaves the
    /// parser tests green, so the call site needs its own pin — and it is
    /// reachable because the checksum is compared before extraction, so no
    /// runnable Node is required.
    #[tokio::test]
    async fn a_node_tarball_that_fails_its_checksum_is_not_installed() {
        use crate::http::HttpResponse;
        use futures::StreamExt as _;

        struct StubHttp(HashMap<String, Vec<u8>>);

        impl HttpClient for StubHttp {
            fn get(&self, url: &str) -> futures::future::BoxFuture<'static, Result<HttpResponse>> {
                let body = self.0.get(url).cloned();
                Box::pin(async move {
                    Ok(match body {
                        Some(bytes) => HttpResponse {
                            status: 200,
                            body: futures::stream::once(async move { Ok(bytes) }).boxed(),
                        },
                        None => HttpResponse {
                            status: 404,
                            body: futures::stream::empty().boxed(),
                        },
                    })
                })
            }
        }

        let (os, arch) = node_platform().expect("a supported test platform");
        let extension = if cfg!(windows) { "zip" } else { "tar.gz" };
        let file_name = format!("node-{NODE_VERSION}-{os}-{arch}.{extension}");

        // A well-formed listing that names the right file — with the digest of
        // something else entirely.
        let listing = format!("{}  {file_name}\n", "1".repeat(64),);

        let mut routes = HashMap::new();
        routes.insert(
            format!("https://nodejs.org/dist/{NODE_VERSION}/SHASUMS256.txt"),
            listing.into_bytes(),
        );
        routes.insert(
            format!("https://nodejs.org/dist/{NODE_VERSION}/{file_name}"),
            b"not a node runtime".to_vec(),
        );

        let dir = tempfile::tempdir().unwrap();
        let node = NodeRuntime::managed(dir.path(), Arc::new(StubHttp(routes)));

        let error = format!("{:#}", node.ensure_installed(None).await.unwrap_err());
        assert!(
            error.contains("SHA-256 mismatch"),
            "the published digest is fetched but not enforced: {error}"
        );
    }

    /// The real file's shape: two spaces, digest first, many lines, and the
    /// one we want is not the first.
    const SHASUMS_SAMPLE: &str = "\
0000000000000000000000000000000000000000000000000000000000000001  node-v24.11.0-linux-x64.tar.gz
0000000000000000000000000000000000000000000000000000000000000002  node-v24.11.0-darwin-arm64.tar.gz
0000000000000000000000000000000000000000000000000000000000000003  node-v24.11.0-win-x64.zip
";

    #[test]
    fn reads_one_digest_out_of_a_shasums_listing() {
        assert_eq!(
            digest_for(SHASUMS_SAMPLE, "node-v24.11.0-darwin-arm64.tar.gz").as_deref(),
            Some("0000000000000000000000000000000000000000000000000000000000000002"),
        );
    }

    #[test]
    fn a_file_the_listing_does_not_mention_has_no_digest() {
        assert!(digest_for(SHASUMS_SAMPLE, "node-v24.11.0-linux-arm64.tar.gz").is_none());
    }

    /// A prefix match would hand back the wrong release's digest, and the
    /// install would then fail for a reason that says nothing useful.
    #[test]
    fn a_similar_file_name_is_not_a_match() {
        assert!(digest_for(SHASUMS_SAMPLE, "node-v24.11.0-linux-x64.tar").is_none());
        assert!(digest_for(SHASUMS_SAMPLE, "node-v24.11.0-linux-x64.tar.gz.asc").is_none());
    }

    #[test]
    fn tolerates_single_space_and_binary_mode_markers() {
        let listing = "00000000000000000000000000000000000000000000000000000000000000ab *node-v24.11.0-linux-x64.tar.gz\n";
        assert_eq!(
            digest_for(listing, "node-v24.11.0-linux-x64.tar.gz").as_deref(),
            Some("00000000000000000000000000000000000000000000000000000000000000ab"),
        );
    }

    /// A line that is not a digest line must not be read as one — the GPG
    /// signature block at the end of the real file is exactly this shape.
    #[test]
    fn ignores_lines_that_are_not_digests() {
        let listing = "-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\nnot-a-digest node-v24.11.0-linux-x64.tar.gz\n";
        assert!(digest_for(listing, "node-v24.11.0-linux-x64.tar.gz").is_none());
    }

    #[test]
    fn installed_version_is_a_ceiling_check() {
        assert!(installed_version_satisfies("1.2.3", "pkg@1.2.3"));
        assert!(installed_version_satisfies("1.0.0", "pkg@1.2.3"));
        assert!(installed_version_satisfies("0.0.1", "@scope/pkg@1.2.3"));
        assert!(!installed_version_satisfies("1.2.4", "pkg@1.2.3"));
        assert!(!installed_version_satisfies("2.0.0", "@scope/pkg@1.2.3"));

        // Prereleases order below their release, as semver says.
        assert!(installed_version_satisfies("1.2.3-beta.1", "pkg@1.2.3"));
        assert!(!installed_version_satisfies("1.2.3", "pkg@1.2.3-beta.1"));
    }

    #[test]
    fn below_ceiling_is_strict_and_needs_a_ceiling() {
        assert!(installed_below_ceiling("0.76.0", "@scope/pkg@0.81.2"));
        assert!(installed_below_ceiling("0.81.2-preview.1", "pkg@0.81.2"));
        assert!(!installed_below_ceiling("0.81.2", "pkg@0.81.2"));
        assert!(!installed_below_ceiling("0.81.3", "pkg@0.81.2"));
        assert!(!installed_below_ceiling("0.1.0", "pkg@latest"));
        assert!(!installed_below_ceiling("0.1.0", "pkg"));
        assert!(!installed_below_ceiling("garbage", "pkg@1.0.0"));
    }

    #[test]
    fn unparseable_installed_version_forces_a_reinstall() {
        assert!(!installed_version_satisfies("", "pkg@1.2.3"));
        assert!(!installed_version_satisfies("garbage", "pkg@1.2.3"));
    }

    #[test]
    fn a_spec_without_a_ceiling_accepts_any_installed_copy() {
        assert!(installed_version_satisfies("9.9.9", "pkg"));
        assert!(installed_version_satisfies("9.9.9", "@scope/pkg"));
        assert!(installed_version_satisfies("9.9.9", "pkg@latest"));
        assert!(installed_version_satisfies("", "pkg@latest"));
    }

    #[test]
    fn npm_args_pin_config_and_bound_fetches() {
        let node_dir = Path::new("/opt/atlas/node/node-v24");
        let prefix = Path::new("/opt/atlas/npx/codex");
        let npm = node_dir.join("bin/npm");
        let args = npm_command_args(
            &npm,
            node_dir,
            Some(prefix),
            "install",
            &["codex-acp@0.0.0 - 1.0.0", "--save-exact"],
        );

        // The pinned paths are spelled with `join`, as the code builds them,
        // so the separator is the host's: on Windows `cache` is joined with
        // `\` onto a `/`-spelled base.
        let joined = args.join(" ");
        assert!(
            joined.starts_with(&format!(
                "{} --prefix {} install --cache={} --userconfig {} --globalconfig {} ",
                npm.display(),
                prefix.display(),
                node_dir.join("cache").display(),
                node_dir.join("blank_user_npmrc").display(),
                node_dir.join("blank_global_npmrc").display(),
            )),
            "got {joined}"
        );
        assert!(
            joined.contains(
                "--no-audit --no-fund --fetch-timeout 300000 --fetch-retries 2 \
             --fetch-retry-mintimeout 2000 --fetch-retry-maxtimeout 10000"
            ),
            "got {joined}"
        );
        // The caller's own args come last.
        assert_eq!(
            &args[args.len() - 2..],
            ["codex-acp@0.0.0 - 1.0.0", "--save-exact"]
        );
    }

    /// The boundary half of #277: whatever spelling a caller resolved its
    /// paths to, none reaches npm's command line verbatim.
    #[test]
    fn npm_args_never_carry_a_verbatim_path() {
        let node_dir = Path::new(r"\\?\C:\atlas\node\node-v24");
        let npm = node_dir.join("npm-cli.js");
        let args = npm_command_args(
            &npm,
            node_dir,
            Some(Path::new(r"\\?\C:\atlas\npx\codex-acp")),
            "install",
            &["codex-acp@0.0.0 - 1.0.0"],
        );

        assert!(
            args.iter().all(|arg| !arg.contains(r"\\?\")),
            "a verbatim path reached npm: {args:?}"
        );
        assert_eq!(args[1..3], ["--prefix", r"C:\atlas\npx\codex-acp"]);
        assert!(
            args.iter()
                .any(|arg| arg.starts_with(r"--cache=C:\atlas\node\node-v24")),
            "got {args:?}"
        );
    }

    #[test]
    fn plain_process_path_drops_windows_verbatim_prefixes() {
        // A disk path canonicalized on Windows comes back `\\?\C:\...`; npm's
        // Arborist recurses to a stack overflow on it as `--prefix`, and Node
        // fails `lstat 'C:'` when it is the script argument (#277).
        assert_eq!(
            plain_process_path(Path::new(
                r"\\?\C:\Users\u\AppData\Roaming\dev.atlas.ide\external-agents\registry\npx\codex-acp"
            )),
            PathBuf::from(
                r"C:\Users\u\AppData\Roaming\dev.atlas.ide\external-agents\registry\npx\codex-acp"
            )
        );
        // The UNC spelling must come back as `\\server\share`, not
        // `UNC\server\share`.
        assert_eq!(
            plain_process_path(Path::new(r"\\?\UNC\server\share\agent")),
            PathBuf::from(r"\\server\share\agent")
        );
    }

    #[test]
    fn plain_process_path_keeps_every_plain_spelling_untouched() {
        for plain in [
            r"C:\Users\u\AppData\Roaming\dev.atlas.ide",
            r"\\server\share\agent",
            "/home/u/.local/share/dev.atlas.ide/npx/codex-acp",
            // The marker only counts at the very front: a POSIX path with a
            // literal backslash component stays exactly as it is.
            r"/tmp/\\?\inside",
            // A device path has no plain spelling; keep the verbatim one.
            r"\\?\Volume{12345678-1234-1234-1234-123456789abc}\agent",
            // A bare drive is "the current directory on C", not its root.
            r"\\?\C:",
            // Nothing after the prefix to hand back.
            r"\\?\",
        ] {
            assert_eq!(
                plain_process_path(Path::new(plain)),
                PathBuf::from(plain),
                "changed {plain:?}"
            );
        }
    }

    #[test]
    fn inherited_npm_config_and_node_env_are_stripped_case_insensitively() {
        let keys = [
            "npm_config_omit",
            "NPM_CONFIG_ARCH",
            "NODE_ENV",
            "HOME",
            "PATH",
            "node_env",
        ]
        .map(std::ffi::OsString::from);
        let stripped = inherited_npm_config_keys(keys);
        assert_eq!(
            stripped,
            ["npm_config_omit", "NPM_CONFIG_ARCH", "NODE_ENV"].map(std::ffi::OsString::from)
        );
    }

    #[test]
    fn install_gets_the_long_deadline_and_everything_else_the_short_one() {
        assert_eq!(npm_timeout("install"), NPM_INSTALL_TIMEOUT);
        assert_eq!(npm_timeout("view"), NPM_TIMEOUT);
        assert!(NPM_INSTALL_TIMEOUT > NPM_TIMEOUT);
    }

    #[test]
    fn npm_platform_uses_node_names() {
        let platform = npm_platform().expect("supported host");
        assert!(["darwin", "linux", "win32"].contains(&platform.os));
        assert!(["x64", "arm64"].contains(&platform.cpu));
    }

    #[test]
    fn npm_timeout_error_names_the_phase() {
        let error: anyhow::Error = NpmTimedOut {
            subcommand: "install".into(),
            timeout: NPM_TIMEOUT,
        }
        .into();
        assert!(error.is::<NpmTimedOut>());
        assert_eq!(
            error.to_string(),
            "npm install did not finish within 10 minutes (the npm registry may be unreachable)"
        );
    }
}
