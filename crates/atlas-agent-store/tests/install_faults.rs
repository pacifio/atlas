//! Fault injection for the npx install path.
//!
//! The reports behind these: macOS users whose agent "gets stuck on
//! installing" and loops after a network failure. Every test here is a
//! scenario a user hit, driven through the real `get_command` with a fake
//! `node`/`npm` ([`fake_node`]) and a fake HTTP client ([`fake_http`]), so
//! the whole ladder — health check, download, install, fallback, verdict,
//! sidecar — runs exactly as it does in the app.
//!
//! Unix only: the fake runtime is a `/bin/sh` script at `bin/node`.

#![cfg(unix)]

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use atlas_acp_thread::AgentId;
use atlas_agent_store::registry::{
    AgentRegistryStore, RegistryAgent, RegistryAgentMetadata, RegistryNpxAgent,
};
use atlas_agent_store::servers::npx_install_dir;
use atlas_agent_store::settings::{AgentServerSettings, AllAgentServersSettings};
use atlas_agent_store::store::AgentServerStore;
use atlas_agent_store::{registry_dir, NodeRuntime, ProjectEnvironment};

mod fake_http;
mod fake_node;
use fake_http::FakeHttp;
use fake_node::{tree, Behaviour, FakeNode};

const PKG: &str = "@acme/agent-acp";
const ID: &str = "acme";

fn npx_agent(version: &str) -> RegistryAgent {
    RegistryAgent::Npx(RegistryNpxAgent {
        metadata: RegistryAgentMetadata {
            id: AgentId::new(ID),
            name: ID.to_owned(),
            description: String::new(),
            version: version.to_owned(),
            repository: None,
            website: None,
            icon_path: None,
        },
        package: format!("{PKG}@{version}"),
        args: Vec::new(),
        env: HashMap::new(),
    })
}

struct Fixture {
    store: AgentServerStore,
    node: FakeNode,
    _http: Arc<FakeHttp>,
    data_dir: tempfile::TempDir,
}

impl Fixture {
    /// A store with one npx agent installed, at registry `version`, over a
    /// planted runtime behaving per `behaviour`.
    async fn new(version: &str, behaviour: &Behaviour) -> Self {
        let http = FakeHttp::new();
        Self::with_http(version, Some(behaviour), http).await
    }

    async fn with_http(version: &str, behaviour: Option<&Behaviour>, http: Arc<FakeHttp>) -> Self {
        let data_dir = tempfile::tempdir().unwrap();
        let node = match behaviour {
            Some(b) => FakeNode::plant(data_dir.path(), b),
            // Nothing planted: the runtime has to be downloaded.
            None => FakeNode {
                data_dir: data_dir.path().to_path_buf(),
                node_dir: fake_node::node_dir(data_dir.path()),
                log: fake_node::node_dir(data_dir.path()).join("fake-npm.log"),
            },
        };
        let registry = Arc::new(AgentRegistryStore::new(
            data_dir.path().to_path_buf(),
            http.clone(),
        ));
        registry.set_agents(vec![npx_agent(version)]);
        let project_env: Arc<dyn ProjectEnvironment> = Arc::new(HashMap::new());
        let store = AgentServerStore::new(
            data_dir.path().to_path_buf(),
            http.clone(),
            NodeRuntime::managed(data_dir.path(), http.clone()),
            project_env,
            Some(registry),
        );
        store
            .set_settings(
                [(ID.to_owned(), AgentServerSettings::registry())]
                    .into_iter()
                    .collect::<AllAgentServersSettings>(),
            )
            .await;
        Self {
            store,
            node,
            _http: http,
            data_dir,
        }
    }

    fn install_dir(&self) -> std::path::PathBuf {
        npx_install_dir(&registry_dir(self.data_dir.path()), ID)
    }

    /// The real connect's first step.
    async fn connect(&self) -> anyhow::Result<()> {
        self.store
            .agent_server(&AgentId::new(ID))
            .unwrap()
            .get_command(vec![], HashMap::new())
            .await
            .map(|_| ())
    }

    fn installed_version(&self) -> Option<String> {
        let manifest = self
            .install_dir()
            .join("node_modules")
            .join(PKG)
            .join("package.json");
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(manifest).ok()?).ok()?;
        json.get("version")?.as_str().map(str::to_owned)
    }

    /// Put a finished `node_modules` in place, as a previous install left it.
    fn plant_installed(&self, version: &str, sidecar: &str) {
        let node_modules = self.install_dir().join("node_modules");
        copy_dir(tree(PKG, version, true).path(), &node_modules);
        std::fs::write(
            self.install_dir().join(".atlas-wanted"),
            format!("{sidecar}\n"),
        )
        .unwrap();
    }
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

// ------------------------------------------------------------ the loop

/// The report: a slow link, an install killed by the connect's deadline,
/// and the next send starting the download from zero — forever.
///
/// Dropping the connect must not drop the install. The next connect joins
/// the one already running, so the work done so far is kept, and npm runs
/// once.
#[tokio::test(flavor = "multi_thread")]
async fn a_dropped_connect_does_not_kill_the_install_and_the_next_one_joins_it() {
    let complete = tree(PKG, "1.0.0", true);
    let fx = Fixture::new(
        "1.0.0",
        &Behaviour {
            install_sleep: 1.5,
            online_tree: Some(complete.path().to_path_buf()),
            ..Behaviour::default()
        },
    )
    .await;

    // The connect gives up after 300 ms; npm needs 1.5 s.
    let first = tokio::time::timeout(Duration::from_millis(300), fx.connect()).await;
    assert!(first.is_err(), "the connect was meant to be abandoned");

    // The next connect lands while the first install is still running.
    fx.connect().await.expect("the second connect");
    assert_eq!(fx.installed_version().as_deref(), Some("1.0.0"));
    assert_eq!(
        fx.node.install_count(),
        1,
        "the abandoned install was killed and redone instead of joined: {:?}",
        fx.node.invocations()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn two_connects_at_once_run_one_npm_install() {
    let complete = tree(PKG, "1.0.0", true);
    let fx = Fixture::new(
        "1.0.0",
        &Behaviour {
            install_sleep: 0.5,
            online_tree: Some(complete.path().to_path_buf()),
            ..Behaviour::default()
        },
    )
    .await;

    let (a, b) = futures::join!(fx.connect(), fx.connect());
    a.unwrap();
    b.unwrap();
    assert_eq!(fx.node.install_count(), 1, "{:?}", fx.node.invocations());
}

// ------------------------------------------------- nothing working is lost

/// The registry moved on while the user is offline. The install that was
/// working five minutes ago must still work: the upgrade is attempted, fails,
/// and the agent starts on the copy it had.
#[tokio::test(flavor = "multi_thread")]
async fn a_failed_upgrade_keeps_the_working_install() {
    let fx = Fixture::new(
        "1.1.0",
        &Behaviour {
            online_exit: 1,
            offline_exit: 1,
            stderr: "npm ERR! network request to https://registry.npmjs.org failed".into(),
            ..Behaviour::default()
        },
    )
    .await;
    fx.plant_installed("1.0.0", &format!("{PKG}@1.0.0"));

    fx.connect()
        .await
        .expect("the connect should start the agent on the copy it already had");
    assert_eq!(
        fx.installed_version().as_deref(),
        Some("1.0.0"),
        "the working install was wiped before the upgrade that failed"
    );
    assert!(fx.node.install_count() >= 1, "the upgrade was never tried");
}

/// After a network failure npm's cache served an older copy. That copy is
/// runnable; the next connect must not wipe it and redo the whole download
/// ladder — once per connect, indefinitely — but run on it and retry online
/// later.
#[tokio::test(flavor = "multi_thread")]
async fn an_offline_cached_copy_is_not_reinstalled_on_every_connect() {
    let cached = tree(PKG, "1.0.0", true);
    let fx = Fixture::new(
        "1.1.0",
        &Behaviour {
            online_exit: 1,
            offline_exit: 0,
            offline_tree: Some(cached.path().to_path_buf()),
            stderr: "npm ERR! ENOTFOUND registry.npmjs.org".into(),
            ..Behaviour::default()
        },
    )
    .await;

    fx.connect()
        .await
        .expect("the cached copy starts the agent");
    assert_eq!(fx.installed_version().as_deref(), Some("1.0.0"));
    let after_first = fx.node.install_count();
    assert!(
        after_first >= 2,
        "online then offline: {:?}",
        fx.node.invocations()
    );

    fx.connect().await.expect("the second connect");
    fx.connect().await.expect("the third connect");
    assert_eq!(
        fx.node.install_count(),
        after_first,
        "every connect re-ran the install ladder: {:?}",
        fx.node.invocations()
    );
}

// --------------------------------------------------- npm's silent failure

/// npm exits 0 having failed to fetch the one optional package the agent
/// exists to ship. The verdict reads the hidden lockfile, retries once on a
/// clean tree, and when that lands the same gap refuses the install and
/// leaves nothing that looks installed.
#[tokio::test(flavor = "multi_thread")]
async fn an_install_missing_its_platform_package_is_retried_once_then_refused() {
    let inert = tree(PKG, "1.0.0", false);
    let fx = Fixture::new(
        "1.0.0",
        &Behaviour {
            online_tree: Some(inert.path().to_path_buf()),
            ..Behaviour::default()
        },
    )
    .await;

    let error = format!("{:#}", fx.connect().await.unwrap_err());
    assert!(
        error.contains("platform package"),
        "the error must name what npm silently skipped: {error}"
    );
    // Once, then once more on a clean tree — and NOT a third time against
    // npm's cache: the registry was reached and served an incomplete
    // package, and the cache holds the same one.
    assert_eq!(fx.node.install_count(), 2, "{:?}", fx.node.invocations());
    assert!(
        !fx.install_dir().join("node_modules").exists(),
        "a tree without its platform package must not be left to be spawned into"
    );
}

// ------------------------------------------------------- the health check

/// `node npm --version` is the runtime's health check and it runs under the
/// install lock. A runtime that answers nothing — a Gatekeeper scan, a wedged
/// filesystem — must fail the check, not park every agent behind it.
#[tokio::test(flavor = "multi_thread")]
async fn a_health_check_that_never_answers_does_not_hang_the_install() {
    let fx = Fixture::new(
        "1.0.0",
        &Behaviour {
            version_sleep: 120.0,
            ..Behaviour::default()
        },
    )
    .await;

    // Generous for a bounded check, far too short for an unbounded one.
    let outcome = tokio::time::timeout(Duration::from_secs(45), fx.connect()).await;
    let error = match outcome {
        Err(_) => panic!("the health check has no deadline: the connect hung"),
        Ok(Ok(())) => panic!("a runtime that never answers cannot be healthy"),
        Ok(Err(error)) => format!("{error:#}"),
    };
    assert!(
        error.contains("nodejs.org") || error.contains("not found"),
        "after a failed check the runtime is re-downloaded (and the fake HTTP 404s): {error}"
    );
}

// ---------------------------------------------------- the Node download

/// `SHASUMS256.txt` for one file, plus a tarball whose `bin/node` is the fake.
fn node_release(data_dir: &Path, behaviour: &Behaviour) -> (String, Vec<u8>) {
    use sha2::Digest as _;
    use std::io::Write as _;

    // Plant into a scratch dir to borrow the script, then pack that dir.
    let scratch = tempfile::tempdir().unwrap();
    let planted = FakeNode::plant(scratch.path(), behaviour);
    let top = planted.node_dir.file_name().unwrap().to_owned();
    let _ = data_dir;

    let mut tar = tar::Builder::new(Vec::new());
    tar.append_dir_all(&top, &planted.node_dir).unwrap();
    let tar = tar.into_inner().unwrap();
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder.write_all(&tar).unwrap();
    let bytes = encoder.finish().unwrap();

    let digest = format!("{:x}", sha2::Sha256::digest(&bytes));
    let (os, arch) = (
        if cfg!(target_os = "macos") {
            "darwin"
        } else {
            "linux"
        },
        if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x64"
        },
    );
    let listing = format!(
        "{digest}  node-{}-{os}-{arch}.tar.gz\n",
        fake_node::NODE_VERSION
    );
    (listing, bytes)
}

fn node_urls() -> (String, String) {
    let (os, arch) = (
        if cfg!(target_os = "macos") {
            "darwin"
        } else {
            "linux"
        },
        if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x64"
        },
    );
    let v = fake_node::NODE_VERSION;
    (
        format!("https://nodejs.org/dist/{v}/SHASUMS256.txt"),
        format!("https://nodejs.org/dist/{v}/node-{v}-{os}-{arch}.tar.gz"),
    )
}

/// The connection drops mid-tarball. Nothing half-extracted may be left
/// looking like a runtime, nothing may leak in a staging directory, and the
/// next connect — on a working link — installs cleanly.
#[tokio::test(flavor = "multi_thread")]
async fn a_node_download_cut_mid_stream_leaves_nothing_and_the_retry_succeeds() {
    let complete = tree(PKG, "1.0.0", true);
    let behaviour = Behaviour {
        online_tree: Some(complete.path().to_path_buf()),
        ..Behaviour::default()
    };
    let (shasums_url, tarball_url) = node_urls();
    let scratch = tempfile::tempdir().unwrap();
    let (listing, tarball) = node_release(scratch.path(), &behaviour);

    let http = FakeHttp::new()
        .with(&shasums_url, 200, listing.into_bytes())
        .with(&tarball_url, 200, tarball.clone())
        .chunked(4096)
        .failing_after(&tarball_url, 1000);
    let fx = Fixture::with_http("1.0.0", None, http.clone()).await;

    let error = format!("{:#}", fx.connect().await.unwrap_err());
    assert!(
        error.contains("connection reset") || error.contains("reading"),
        "the cut must surface as the network failure it was: {error}"
    );
    assert!(
        !fx.node.node_dir.exists(),
        "a half-downloaded runtime was left where the health check will find it"
    );
    let leaked: Vec<_> = std::fs::read_dir(fx.data_dir.path())
        .unwrap()
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(".tmp-agent-download-"))
        .collect();
    assert!(leaked.is_empty(), "staging directories leaked: {leaked:?}");

    // The link recovers.
    http.heal(&tarball_url);
    fx.connect().await.expect("the retry on a working link");
    assert_eq!(fx.installed_version().as_deref(), Some("1.0.0"));
}

/// nodejs.org answers the tarball with a 503. No runtime, a clear error, and
/// the previous runtime — had there been one — untouched.
#[tokio::test(flavor = "multi_thread")]
async fn a_node_download_that_fails_outright_installs_nothing() {
    let (shasums_url, tarball_url) = node_urls();
    let scratch = tempfile::tempdir().unwrap();
    let (listing, _) = node_release(scratch.path(), &Behaviour::default());
    let http = FakeHttp::new()
        .with(&shasums_url, 200, listing.into_bytes())
        .with(&tarball_url, 503, b"service unavailable".to_vec());
    let fx = Fixture::with_http("1.0.0", None, http).await;

    let error = format!("{:#}", fx.connect().await.unwrap_err());
    assert!(error.contains("503"), "{error}");
    assert!(!fx.node.node_dir.exists());
}
