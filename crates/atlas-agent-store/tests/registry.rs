//! The catalogue: what the registry JSON becomes, what gets written to disk,
//! and what a failed fetch does to what we already had.

use std::sync::Arc;

use atlas_agent_store::registry::{
    current_platform_key, AgentRegistryStore, RegistryAgent, REGISTRY_URL,
};

mod fake_http;
use fake_http::FakeHttp;

/// A registry index with one agent, whose distribution is whatever the caller
/// pastes in.
fn index_with(distribution: &str) -> String {
    format!(
        r#"{{
          "version": "1",
          "agents": [
            {{
              "id": "some-cli",
              "name": "Some CLI",
              "version": "1.2.3",
              "description": "an agent",
              "repository": "https://example.com/repo",
              "distribution": {distribution}
            }}
          ]
        }}"#
    )
}

fn binary_distribution(platform: &str) -> String {
    format!(
        r#"{{
          "binary": {{
            "{platform}": {{
              "archive": "https://example.com/agent.tar.gz",
              "cmd": "./agent",
              "args": ["--acp"],
              "sha256": "abc123"
            }}
          }}
        }}"#
    )
}

const NPX_DISTRIBUTION: &str = r#"{ "npx": { "package": "some-cli@1.2.3", "args": ["acp"] } }"#;

fn store_serving(body: &str) -> (Arc<AgentRegistryStore>, Arc<FakeHttp>, tempfile::TempDir) {
    let data_dir = tempfile::tempdir().unwrap();
    let http = FakeHttp::new().with(REGISTRY_URL, 200, body.as_bytes().to_vec());
    let store = Arc::new(AgentRegistryStore::new(
        data_dir.path().to_path_buf(),
        http.clone(),
    ));
    (store, http, data_dir)
}

#[tokio::test]
async fn parses_a_binary_distribution_for_this_platform() {
    let platform = current_platform_key().unwrap();
    let (store, _http, _dir) = store_serving(&index_with(&binary_distribution(platform)));
    store.refresh().await.unwrap();

    let agent = store.agent("some-cli").unwrap();
    let RegistryAgent::Binary(binary) = &agent else {
        panic!("expected a binary agent, got {agent:?}");
    };
    assert!(binary.supports_current_platform);
    assert_eq!(agent.name(), "Some CLI");
    assert_eq!(agent.version(), "1.2.3");
    assert_eq!(agent.repository(), Some("https://example.com/repo"));

    let target = &binary.targets[platform];
    assert_eq!(target.cmd, "./agent");
    assert_eq!(target.args, vec!["--acp".to_string()]);
    assert_eq!(target.sha256.as_deref(), Some("abc123"));
}

/// Binary wins where it runs; npx is the fallback, not a second entry.
#[tokio::test]
async fn prefers_a_binary_that_runs_here_and_falls_back_to_npx() {
    let platform = current_platform_key().unwrap();
    let both = format!(
        r#"{{
          "binary": {{ "{platform}": {{ "archive": "https://example.com/a.tar.gz", "cmd": "./a" }} }},
          "npx": {{ "package": "some-cli" }}
        }}"#
    );
    let (store, _http, _dir) = store_serving(&index_with(&both));
    store.refresh().await.unwrap();
    assert!(matches!(
        store.agent("some-cli").unwrap(),
        RegistryAgent::Binary(_)
    ));

    let elsewhere = r#"{
      "binary": { "sunos-sparc": { "archive": "https://example.com/a.tar.gz", "cmd": "./a" } },
      "npx": { "package": "some-cli" }
    }"#;
    let (store, _http, _dir) = store_serving(&index_with(elsewhere));
    store.refresh().await.unwrap();
    let agent = store.agent("some-cli").unwrap();
    assert!(matches!(agent, RegistryAgent::Npx(_)));
    // npx runs anywhere Node does.
    assert!(agent.supports_current_platform());
}

#[tokio::test]
async fn an_agent_with_no_usable_distribution_is_dropped() {
    let (store, _http, _dir) = store_serving(&index_with("{}"));
    store.refresh().await.unwrap();
    assert!(store.agents().is_empty());
}

/// Cache-first: the marketplace renders offline because the last good index is
/// on disk with its icons.
#[tokio::test]
async fn writes_the_index_to_disk_and_reads_it_back() {
    let body = index_with(NPX_DISTRIBUTION);
    let data_dir = tempfile::tempdir().unwrap();
    let http = FakeHttp::new().with(REGISTRY_URL, 200, body.as_bytes().to_vec());

    let store = AgentRegistryStore::new(data_dir.path().to_path_buf(), http.clone());
    store.refresh().await.unwrap();

    let cache_path = atlas_agent_store::registry_dir(data_dir.path()).join("registry.json");
    assert!(cache_path.is_file());

    // A fresh store with a client that answers nothing still has the agent.
    let offline = AgentRegistryStore::new(data_dir.path().to_path_buf(), FakeHttp::new());
    offline.load_cached().await.unwrap();
    assert_eq!(offline.agents().len(), 1);
    assert_eq!(offline.agent("some-cli").unwrap().version(), "1.2.3");
}

#[tokio::test]
async fn a_missing_cache_is_not_an_error() {
    let data_dir = tempfile::tempdir().unwrap();
    let store = AgentRegistryStore::new(data_dir.path().to_path_buf(), FakeHttp::new());
    store.load_cached().await.unwrap();
    assert!(store.agents().is_empty());
}

/// A refresh that fails must not empty the marketplace.
#[tokio::test]
async fn a_failed_refresh_keeps_the_previous_catalogue() {
    let data_dir = tempfile::tempdir().unwrap();
    let http = FakeHttp::new().with(
        REGISTRY_URL,
        200,
        index_with(NPX_DISTRIBUTION).into_bytes(),
    );
    let store = AgentRegistryStore::new(data_dir.path().to_path_buf(), http.clone());
    store.refresh().await.unwrap();
    assert_eq!(store.agents().len(), 1);

    http.with(REGISTRY_URL, 404, b"gone".to_vec());
    let error = store.refresh().await.unwrap_err();

    assert!(error.to_string().contains("404"), "unexpected error: {error:#}");
    assert_eq!(store.agents().len(), 1);
    assert!(store.fetch_error().is_some());
    assert!(!store.is_fetching());
}

#[tokio::test]
async fn a_body_that_is_not_a_registry_is_an_error() {
    let (store, _http, _dir) = store_serving("not json");
    assert!(store.refresh().await.is_err());
    assert!(store.agents().is_empty());
}

/// The throttle is what makes it safe to call `refresh_if_stale` on every
/// settings change.
#[tokio::test]
async fn refresh_if_stale_fetches_once_an_hour() {
    let (store, http, _dir) = store_serving(&index_with(NPX_DISTRIBUTION));

    store.refresh_if_stale().await;
    store.refresh_if_stale().await;
    store.refresh_if_stale().await;

    assert_eq!(http.request_count(REGISTRY_URL), 1);
}

/// The ticket's second acceptance criterion, against the real CDN.
///
/// Ignored by default: it is a network test and it downloads a real agent
/// archive, so it does not belong in CI. Run it with
/// `cargo test --test registry -- --ignored --nocapture` when the registry
/// contract itself is what is in question.
#[tokio::test]
#[ignore = "hits the real ACP registry CDN and downloads an agent"]
async fn fetches_the_real_registry_and_installs_a_binary_agent() {
    use atlas_acp_thread::AgentId;
    use atlas_agent_store::settings::{AgentServerSettings, AllAgentServersSettings};
    use atlas_agent_store::store::AgentServerStore;
    use atlas_agent_store::{InheritedProjectEnvironment, NodeRuntime, ReqwestClient};

    let data_dir = tempfile::tempdir().unwrap();
    let http = Arc::new(ReqwestClient::new("atlas-agent-store-test").unwrap());
    let registry = Arc::new(AgentRegistryStore::new(
        data_dir.path().to_path_buf(),
        http.clone(),
    ));

    registry.refresh().await.unwrap();
    let agents = registry.agents();
    assert!(!agents.is_empty(), "the real registry should list agents");
    println!("registry lists {} agents", agents.len());

    // The first binary distribution that runs on this machine, and whose `cmd`
    // is a path in the archive rather than the managed Node.
    let Some(agent) = agents.iter().find(|agent| match agent {
        RegistryAgent::Binary(binary) => {
            binary.supports_current_platform
                && binary
                    .targets
                    .get(current_platform_key().unwrap())
                    .is_some_and(|target| target.cmd != "node")
        }
        RegistryAgent::Npx(_) => false,
    }) else {
        println!("no binary agent for this platform; nothing to install");
        return;
    };
    let id = agent.id().clone();
    println!("installing {id} {}", agent.version());

    let store = AgentServerStore::new(
        data_dir.path().to_path_buf(),
        http,
        NodeRuntime::unavailable("this test installs a binary distribution"),
        Arc::new(InheritedProjectEnvironment),
        Some(registry.clone()),
    );
    store
        .set_settings(AllAgentServersSettings::from_iter([(
            id.as_str().to_string(),
            AgentServerSettings::registry(),
        )]))
        .await;

    let command = store
        .agent_server(&AgentId::new(id.as_str()))
        .unwrap()
        .get_command(Vec::new(), Default::default())
        .await
        .unwrap();

    println!("resolved {}", command.path.display());
    assert!(command.path.is_file());
    // The binary lives in a versioned directory under this agent's install dir.
    let version_dir = command.path.parent().unwrap();
    assert!(atlas_agent_store::registry_dir(data_dir.path())
        .join(atlas_agent_store::sanitize_path_component(id.as_str()))
        .ancestors()
        .any(|ancestor| version_dir.starts_with(ancestor)));
    assert!(version_dir
        .components()
        .any(|component| component.as_os_str().to_string_lossy().starts_with("v_")));
}

/// The regression behind "the marketplace said Registry unavailable until I hit
/// Refresh": boot starts a refresh, the marketplace mounts and starts its own,
/// and the second one used to return `Ok(())` immediately over an empty
/// in-memory catalogue. A caller that gets `Ok` must be able to read the
/// catalogue that `Ok` is about.
#[tokio::test]
async fn a_concurrent_refresh_waits_for_the_one_in_flight() {
    let data_dir = tempfile::tempdir().unwrap();
    let http = FakeHttp::new()
        .with(REGISTRY_URL, 200, index_with(NPX_DISTRIBUTION).into_bytes())
        .slow(std::time::Duration::from_millis(150));
    let store = Arc::new(AgentRegistryStore::new(
        data_dir.path().to_path_buf(),
        http.clone(),
    ));

    // Boot's refresh.
    let first = tokio::spawn({
        let store = store.clone();
        async move { store.refresh().await }
    });
    // Let it get as far as the (slow) request before the second caller arrives.
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    assert!(store.is_fetching(), "the first refresh should be in flight");

    // The marketplace's mount-time refresh.
    store.refresh().await.unwrap();
    assert_eq!(
        store.agents().len(),
        1,
        "the second caller was told the refresh succeeded, so the catalogue must be there"
    );

    first.await.unwrap().unwrap();
    assert_eq!(
        http.request_count(REGISTRY_URL),
        1,
        "joining an in-flight refresh must not issue a second request"
    );
}

/// The joined caller adopts the outcome, not just the timing: if the fetch it
/// waited on failed, it fails too rather than reporting a success it never saw.
#[tokio::test]
async fn a_concurrent_refresh_adopts_a_failure() {
    let data_dir = tempfile::tempdir().unwrap();
    let http = FakeHttp::new()
        .with(REGISTRY_URL, 500, b"boom".to_vec())
        .slow(std::time::Duration::from_millis(150));
    let store = Arc::new(AgentRegistryStore::new(
        data_dir.path().to_path_buf(),
        http.clone(),
    ));

    let first = tokio::spawn({
        let store = store.clone();
        async move { store.refresh().await }
    });
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;

    let error = store.refresh().await.unwrap_err();
    assert!(
        error.to_string().contains("500"),
        "unexpected error: {error:#}"
    );
    assert!(first.await.unwrap().is_err());
    assert_eq!(http.request_count(REGISTRY_URL), 1);
}
