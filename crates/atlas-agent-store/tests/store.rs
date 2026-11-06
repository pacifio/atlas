//! The store's contract: an agent exists because it is in the installed map,
//! and for no other reason.
//!
//! Includes the version-notification cases.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use atlas_acp_thread::AgentId;
use atlas_agent_store::registry::{
    current_platform_key, AgentRegistryStore, RegistryAgent, RegistryAgentMetadata,
    RegistryBinaryAgent, RegistryNpxAgent, RegistryTargetConfig,
};
use atlas_agent_store::settings::{AgentServerSettings, AllAgentServersSettings};
use atlas_agent_store::store::{AgentServerStore, ExternalAgentSource};
use atlas_agent_store::{NodeRuntime, ProjectEnvironment};
use sha2::{Digest as _, Sha256};

mod fake_http;
use fake_http::FakeHttp;

const ARCHIVE_URL: &str = "https://example.test/agent";

// ------------------------------------------------------------------ fixtures

fn metadata(id: &str, version: &str) -> RegistryAgentMetadata {
    RegistryAgentMetadata {
        id: AgentId::new(id),
        name: format!("{id} (registry)"),
        description: String::new(),
        version: version.to_string(),
        repository: None,
        website: None,
        icon_path: None,
    }
}

fn npx_agent(id: &str, version: &str) -> RegistryAgent {
    RegistryAgent::Npx(RegistryNpxAgent {
        metadata: metadata(id, version),
        package: id.to_string(),
        args: Vec::new(),
        env: HashMap::new(),
    })
}

/// A binary agent whose only target is this platform, so the resolution path
/// under test is the one that actually runs here.
fn binary_agent(id: &str, version: &str, sha256: Option<String>) -> RegistryAgent {
    let target = RegistryTargetConfig {
        archive: ARCHIVE_URL.to_string(),
        cmd: "./agent".to_string(),
        args: vec!["--acp".to_string()],
        sha256,
        env: HashMap::from([("FROM_TARGET".into(), "target".into())]),
    };
    RegistryAgent::Binary(RegistryBinaryAgent {
        metadata: metadata(id, version),
        targets: HashMap::from([(current_platform_key().unwrap().to_string(), target)]),
        supports_current_platform: true,
    })
}

fn settings(entries: &[(&str, AgentServerSettings)]) -> AllAgentServersSettings {
    entries
        .iter()
        .map(|(id, entry)| (id.to_string(), entry.clone()))
        .collect()
}

struct Fixture {
    store: AgentServerStore,
    registry: Arc<AgentRegistryStore>,
    http: Arc<FakeHttp>,
    _data_dir: tempfile::TempDir,
}

fn fixture(agents: Vec<RegistryAgent>) -> Fixture {
    fixture_with_http(agents, FakeHttp::new())
}

fn fixture_with_http(agents: Vec<RegistryAgent>, http: Arc<FakeHttp>) -> Fixture {
    let data_dir = tempfile::tempdir().unwrap();
    let registry = Arc::new(AgentRegistryStore::new(
        data_dir.path().to_path_buf(),
        http.clone(),
    ));
    registry.set_agents(agents);

    // A fixed project env, so the layering assertions below are about layering
    // rather than about whatever the test runner was started with.
    let project_env: Arc<dyn ProjectEnvironment> = Arc::new(HashMap::from([
        ("FROM_PROJECT".to_string(), "project".to_string()),
        ("SHADOWED".to_string(), "project".to_string()),
    ]));

    let store = AgentServerStore::new(
        data_dir.path().to_path_buf(),
        http.clone(),
        NodeRuntime::unavailable("not needed by this test"),
        project_env,
        Some(registry.clone()),
    );

    Fixture {
        store,
        registry,
        http,
        _data_dir: data_dir,
    }
}

// ------------------------------------------------- the installed map is it

/// The whole "no default agents" decision, as one assertion: a full catalogue
/// and an empty installed map produce nothing.
#[tokio::test]
async fn an_empty_installed_map_registers_no_agents() {
    let fixture = fixture(vec![
        npx_agent("claude-code", "1.0.0"),
        npx_agent("codex", "1.0.0"),
        binary_agent("gemini", "1.0.0", None),
    ]);

    fixture
        .store
        .set_settings(AllAgentServersSettings::default())
        .await;

    assert!(fixture.store.external_agents().is_empty());
}

#[tokio::test]
async fn a_registry_agent_nobody_installed_is_not_registered() {
    let fixture = fixture(vec![npx_agent("catalogued", "1.0.0")]);

    fixture
        .store
        .set_settings(settings(&[(
            "installed",
            AgentServerSettings::custom("/bin/agent", vec![]),
        )]))
        .await;

    assert_eq!(
        fixture.store.external_agents(),
        vec![AgentId::new("installed")]
    );
    assert!(fixture.store.entry(&AgentId::new("catalogued")).is_none());
}

#[tokio::test]
async fn installing_and_uninstalling_follows_the_settings_map() {
    let fixture = fixture(vec![npx_agent("some-cli", "1.0.0")]);
    let id = AgentId::new("some-cli");

    fixture
        .store
        .set_settings(settings(&[("some-cli", AgentServerSettings::registry())]))
        .await;
    assert_eq!(
        fixture.store.agent_source(&id),
        Some(ExternalAgentSource::Registry)
    );
    assert_eq!(
        fixture.store.agent_display_name(&id).as_deref(),
        Some("some-cli (registry)")
    );

    fixture
        .store
        .set_settings(AllAgentServersSettings::default())
        .await;
    assert!(fixture.store.entry(&id).is_none());
    // The watch channels go with it — an uninstalled agent has nothing to watch.
    assert!(fixture.store.watch_new_version(&id).is_none());
}

#[tokio::test]
async fn a_binary_agent_without_a_target_for_this_platform_is_skipped() {
    let RegistryAgent::Binary(mut binary) = binary_agent("elsewhere", "1.0.0", None) else {
        unreachable!()
    };
    binary.targets.clear();
    binary.supports_current_platform = false;

    let fixture = fixture(vec![RegistryAgent::Binary(binary)]);
    fixture
        .store
        .set_settings(settings(&[("elsewhere", AgentServerSettings::registry())]))
        .await;

    assert!(fixture.store.external_agents().is_empty());
}

#[tokio::test]
async fn every_rebuild_bumps_the_update_generation() {
    let fixture = fixture(vec![npx_agent("some-cli", "1.0.0")]);
    let mut updates = fixture.store.updates();
    assert_eq!(*updates.borrow_and_update(), 0);

    fixture
        .store
        .set_settings(settings(&[("some-cli", AgentServerSettings::registry())]))
        .await;
    assert_eq!(*updates.borrow_and_update(), 1);

    // An identical map is not a change, so it is not a rebuild.
    fixture
        .store
        .set_settings(settings(&[("some-cli", AgentServerSettings::registry())]))
        .await;
    assert_eq!(*updates.borrow_and_update(), 1);
}

// ------------------------------------------------------------ custom entries

#[tokio::test]
async fn a_custom_entry_runs_the_command_the_user_wrote() {
    let fixture = fixture(vec![]);
    fixture
        .store
        .set_settings(settings(&[(
            "mine",
            AgentServerSettings::custom("/opt/agent", vec!["--acp".into()]),
        )]))
        .await;

    let server = fixture.store.agent_server(&AgentId::new("mine")).unwrap();
    let command = server
        .get_command(vec!["--extra".into()], HashMap::new())
        .await
        .unwrap();

    assert_eq!(command.path, PathBuf::from("/opt/agent"));
    assert_eq!(
        command.args,
        vec!["--acp".to_string(), "--extra".to_string()]
    );
    assert_eq!(server.version(), None);
}

/// `project < extra < BYOK < settings`, checked one shadow at a time.
#[tokio::test]
async fn env_layers_from_least_to_most_specific() {
    let fixture = fixture(vec![]);
    fixture.store.set_byok_env(HashMap::from([
        ("FROM_BYOK".to_string(), "byok".to_string()),
        ("SHADOWED".to_string(), "byok".to_string()),
    ]));
    fixture
        .store
        .set_settings(settings(&[(
            "mine",
            AgentServerSettings::Custom {
                path: "/opt/agent".into(),
                args: vec![],
                env: HashMap::from([("FROM_SETTINGS".to_string(), "settings".to_string())]),
                default_mode: Some("ask".to_string()),
                default_config_options: HashMap::new(),
                favorite_config_option_values: HashMap::new(),
                enabled: true,
                display_name: None,
                hidden_models: Vec::new(),
                model_order: Vec::new(),
                custom_models: Vec::new(),
                secret_env: Vec::new(),
            },
        )]))
        .await;

    let command = fixture
        .store
        .agent_server(&AgentId::new("mine"))
        .unwrap()
        .get_command(
            vec![],
            HashMap::from([
                ("FROM_EXTRA".to_string(), "extra".to_string()),
                ("SHADOWED".to_string(), "extra".to_string()),
            ]),
        )
        .await
        .unwrap();

    let env = command.env.unwrap();
    assert_eq!(env.get("FROM_PROJECT").unwrap(), "project");
    assert_eq!(env.get("FROM_EXTRA").unwrap(), "extra");
    assert_eq!(env.get("FROM_BYOK").unwrap(), "byok");
    assert_eq!(env.get("FROM_SETTINGS").unwrap(), "settings");
    // BYOK is above `extra` on purpose: `extra` carries the launcher's env
    // workarounds, and a key the user configured beats a workaround.
    assert_eq!(env.get("SHADOWED").unwrap(), "byok");

    assert_eq!(
        fixture
            .store
            .entry(&AgentId::new("mine"))
            .unwrap()
            .default_mode
            .as_deref(),
        Some("ask")
    );
}

#[tokio::test]
async fn a_custom_command_path_expands_a_leading_tilde() {
    let home = std::env::var("HOME").unwrap_or_default();
    let fixture = fixture(vec![]);
    fixture
        .store
        .set_settings(settings(&[(
            "mine",
            AgentServerSettings::custom("~/bin/agent", vec![]),
        )]))
        .await;

    let command = fixture
        .store
        .agent_server(&AgentId::new("mine"))
        .unwrap()
        .get_command(vec![], HashMap::new())
        .await
        .unwrap();

    assert_eq!(command.path, PathBuf::from(home).join("bin/agent"));
}

// -------------------------------------------------- registry binary resolution

/// The full archive rung through the store: download, verify, extract, resolve
/// `./agent` inside the versioned directory, layer the target's env.
#[tokio::test]
async fn a_registry_binary_agent_installs_on_first_resolution() {
    let contents = b"the agent";
    let digest = format!("{:x}", Sha256::digest(contents));
    let http = FakeHttp::new().with(ARCHIVE_URL, 200, contents.to_vec());
    let fixture = fixture_with_http(
        vec![binary_agent("some-cli", "1.0.0", Some(digest))],
        http.clone(),
    );

    fixture
        .store
        .set_settings(settings(&[("some-cli", AgentServerSettings::registry())]))
        .await;

    let command = fixture
        .store
        .agent_server(&AgentId::new("some-cli"))
        .unwrap()
        .get_command(vec![], HashMap::new())
        .await
        .unwrap();

    assert_eq!(command.path.file_name().unwrap(), "agent");
    assert_eq!(std::fs::read(&command.path).unwrap(), contents);
    assert_eq!(command.args, vec!["--acp".to_string()]);
    assert_eq!(command.env.unwrap().get("FROM_TARGET").unwrap(), "target");

    // A second resolution finds the versioned directory already there.
    fixture
        .store
        .agent_server(&AgentId::new("some-cli"))
        .unwrap()
        .get_command(vec![], HashMap::new())
        .await
        .unwrap();
    assert_eq!(fixture.http.request_count(ARCHIVE_URL), 1);
}

/// Arguments set in Settings → Agents go after the distribution's own and
/// before the caller's, so a registry agent keeps the flags it needs to speak
/// ACP whatever the user adds.
#[tokio::test]
async fn a_registry_agent_appends_the_users_arguments() {
    let contents = b"the agent";
    let digest = format!("{:x}", Sha256::digest(contents));
    let http = FakeHttp::new().with(ARCHIVE_URL, 200, contents.to_vec());
    let fixture = fixture_with_http(
        vec![binary_agent("some-cli", "1.0.0", Some(digest))],
        http.clone(),
    );
    let mut entry = AgentServerSettings::registry();
    entry.user_settings_mut().args.push("--verbose".into());
    fixture
        .store
        .set_settings(settings(&[("some-cli", entry)]))
        .await;

    let command = fixture
        .store
        .agent_server(&AgentId::new("some-cli"))
        .unwrap()
        .get_command(vec!["--from-caller".into()], HashMap::new())
        .await
        .unwrap();

    assert_eq!(command.args, ["--acp", "--verbose", "--from-caller"]);
}

#[tokio::test]
async fn a_registry_binary_agent_reports_a_bad_checksum_rather_than_running() {
    let http = FakeHttp::new().with(ARCHIVE_URL, 200, b"tampered".to_vec());
    let fixture = fixture_with_http(
        vec![binary_agent(
            "some-cli",
            "1.0.0",
            Some("0000000000000000000000000000000000000000000000000000000000000000".to_string()),
        )],
        http,
    );

    fixture
        .store
        .set_settings(settings(&[("some-cli", AgentServerSettings::registry())]))
        .await;

    let error = fixture
        .store
        .agent_server(&AgentId::new("some-cli"))
        .unwrap()
        .get_command(vec![], HashMap::new())
        .await
        .unwrap_err();

    assert!(
        error.to_string().contains("SHA-256 mismatch"),
        "unexpected error: {error:#}"
    );
}

/// Install progress reaches the UI's watcher while the download runs, and is
/// cleared once it is over — a status left behind reads "Installing …" forever.
#[tokio::test]
async fn installing_reports_progress_on_the_loading_channel() {
    let contents = b"the agent";
    let http = FakeHttp::new().with(ARCHIVE_URL, 200, contents.to_vec());
    let fixture = fixture_with_http(vec![binary_agent("some-cli", "2.1.0", None)], http);

    fixture
        .store
        .set_settings(settings(&[("some-cli", AgentServerSettings::registry())]))
        .await;

    let id = AgentId::new("some-cli");
    let mut loading = fixture.store.watch_loading_status(&id).unwrap();
    assert_eq!(*loading.borrow_and_update(), None);

    let mut command = fixture
        .store
        .agent_server(&id)
        .unwrap()
        .get_command(vec![], HashMap::new());

    tokio::select! {
        biased;
        changed = loading.changed() => changed.unwrap(),
        _ = &mut command => panic!("the install finished without reporting progress"),
    }
    assert_eq!(
        loading.borrow_and_update().as_deref(),
        Some("Installing 2.1.0…")
    );

    command.await.unwrap();
    assert_eq!(*loading.borrow_and_update(), None);
}

/// A failed install clears its progress too. It used to leave the status set,
/// so the tab kept reading "Installing …" after the error.
#[tokio::test]
async fn a_failed_install_clears_its_progress() {
    let http = FakeHttp::new().with(ARCHIVE_URL, 200, b"the agent".to_vec());
    let wrong_digest = Some("00".repeat(32));
    let fixture = fixture_with_http(vec![binary_agent("some-cli", "2.1.0", wrong_digest)], http);

    fixture
        .store
        .set_settings(settings(&[("some-cli", AgentServerSettings::registry())]))
        .await;

    let id = AgentId::new("some-cli");
    let mut loading = fixture.store.watch_loading_status(&id).unwrap();

    let result = fixture
        .store
        .agent_server(&id)
        .unwrap()
        .get_command(vec![], HashMap::new())
        .await;

    assert!(result.is_err(), "a checksum mismatch must fail the install");
    assert_eq!(*loading.borrow_and_update(), None);
}

// ------------------------------------------------- version-bump notification

#[tokio::test]
async fn a_version_change_notifies_the_live_connection() {
    let fixture = fixture(vec![npx_agent("test-agent", "1.0.0")]);
    let id = AgentId::new("test-agent");

    fixture
        .store
        .set_settings(settings(&[("test-agent", AgentServerSettings::registry())]))
        .await;
    assert_eq!(
        fixture.store.entry(&id).unwrap().version.as_deref(),
        Some("1.0.0")
    );

    let mut new_version = fixture.store.watch_new_version(&id).unwrap();
    assert_eq!(*new_version.borrow_and_update(), None);

    fixture
        .registry
        .set_agents(vec![npx_agent("test-agent", "2.0.0")]);
    fixture.store.registry_updated();

    assert_eq!(new_version.borrow_and_update().as_deref(), Some("2.0.0"));
}

#[tokio::test]
async fn an_unchanged_version_notifies_nobody() {
    let fixture = fixture(vec![npx_agent("test-agent", "1.0.0")]);
    let id = AgentId::new("test-agent");

    fixture
        .store
        .set_settings(settings(&[("test-agent", AgentServerSettings::registry())]))
        .await;
    let mut new_version = fixture.store.watch_new_version(&id).unwrap();

    fixture
        .registry
        .set_agents(vec![npx_agent("test-agent", "1.0.0")]);
    fixture.store.registry_updated();

    assert_eq!(*new_version.borrow_and_update(), None);
    // …and the watcher survives the rebuild, so the next real bump still lands.
    fixture
        .registry
        .set_agents(vec![npx_agent("test-agent", "3.0.0")]);
    fixture.store.registry_updated();
    assert_eq!(new_version.borrow_and_update().as_deref(), Some("3.0.0"));
}

/// A registry that republishes an older version is not offering an upgrade.
/// Honouring it would drop the live connection, forget the sessions, and
/// reinstall the older binary with nothing standing in the way.
#[tokio::test]
async fn a_downgrade_notifies_nobody() {
    let fixture = fixture(vec![npx_agent("test-agent", "2.0.0")]);
    let id = AgentId::new("test-agent");

    fixture
        .store
        .set_settings(settings(&[("test-agent", AgentServerSettings::registry())]))
        .await;
    let mut new_version = fixture.store.watch_new_version(&id).unwrap();

    fixture
        .registry
        .set_agents(vec![npx_agent("test-agent", "1.0.0")]);
    fixture.store.registry_updated();
    assert_eq!(*new_version.borrow_and_update(), None);

    // …and the agent is not left deaf: a genuine bump past 2.0.0 still lands.
    fixture
        .registry
        .set_agents(vec![npx_agent("test-agent", "3.0.0")]);
    fixture.store.registry_updated();
    assert_eq!(new_version.borrow_and_update().as_deref(), Some("3.0.0"));
}

/// `1.2.3` and `v1.2.3` are one release spelled two ways, and so are `2.0` and
/// `2.0.0`. Either reading as a change costs the user their session.
#[tokio::test]
async fn a_cosmetic_retag_notifies_nobody() {
    for (published, retagged) in [("1.2.3", "v1.2.3"), ("2.0", "2.0.0"), ("3.0.0", "3")] {
        let fixture = fixture(vec![npx_agent("test-agent", published)]);
        let id = AgentId::new("test-agent");

        fixture
            .store
            .set_settings(settings(&[("test-agent", AgentServerSettings::registry())]))
            .await;
        let mut new_version = fixture.store.watch_new_version(&id).unwrap();

        fixture
            .registry
            .set_agents(vec![npx_agent("test-agent", retagged)]);
        fixture.store.registry_updated();

        assert_eq!(
            *new_version.borrow_and_update(),
            None,
            "{published} -> {retagged} was treated as a new version"
        );
    }
}

/// Not every registry publishes semver. When neither side can be ordered there
/// is no direction to read, so any change is still a change.
#[tokio::test]
async fn an_unorderable_version_change_still_notifies() {
    let fixture = fixture(vec![npx_agent("test-agent", "latest")]);
    let id = AgentId::new("test-agent");

    fixture
        .store
        .set_settings(settings(&[("test-agent", AgentServerSettings::registry())]))
        .await;
    let mut new_version = fixture.store.watch_new_version(&id).unwrap();

    fixture
        .registry
        .set_agents(vec![npx_agent("test-agent", "nightly-2026-09-14")]);
    fixture.store.registry_updated();

    assert_eq!(
        new_version.borrow_and_update().as_deref(),
        Some("nightly-2026-09-14")
    );
}

#[tokio::test]
async fn agents_are_notified_independently() {
    let fixture = fixture(vec![
        npx_agent("agent-a", "1.0.0"),
        npx_agent("agent-b", "3.0.0"),
    ]);
    fixture
        .store
        .set_settings(settings(&[
            ("agent-a", AgentServerSettings::registry()),
            ("agent-b", AgentServerSettings::registry()),
        ]))
        .await;

    let mut a = fixture
        .store
        .watch_new_version(&AgentId::new("agent-a"))
        .unwrap();
    let mut b = fixture
        .store
        .watch_new_version(&AgentId::new("agent-b"))
        .unwrap();

    fixture.registry.set_agents(vec![
        npx_agent("agent-a", "2.0.0"),
        npx_agent("agent-b", "3.0.0"),
    ]);
    fixture.store.registry_updated();

    assert_eq!(a.borrow_and_update().as_deref(), Some("2.0.0"));
    assert_eq!(*b.borrow_and_update(), None);
}

/// Nobody watching is not a special case — the
/// version-comparison path used to assume a channel was there.
#[tokio::test]
async fn a_version_change_with_no_watcher_is_harmless() {
    let fixture = fixture(vec![npx_agent("test-agent", "1.0.0")]);
    fixture
        .store
        .set_settings(settings(&[("test-agent", AgentServerSettings::registry())]))
        .await;

    fixture
        .registry
        .set_agents(vec![npx_agent("test-agent", "2.0.0")]);
    fixture.store.registry_updated();

    assert_eq!(
        fixture
            .store
            .entry(&AgentId::new("test-agent"))
            .unwrap()
            .version
            .as_deref(),
        Some("2.0.0")
    );
}
