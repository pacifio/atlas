//! Atlas's port of Zed's agent store — where an external agent comes from, and
//! how its command line gets resolved.
//!
//! Source of truth: `~/Codes/zed-ref/crates/project/src/{agent_server_store.rs,
//! agent_registry_store.rs}`. This is stage 2 of
//! `plans/atlas-acp-zed-port-plan.md`; it implements
//! [`atlas_agent_servers::server::ExternalAgentServer`], the seam stage 1 left
//! open, and nothing links it yet.
//!
//! Two pieces:
//!
//! - [`AgentRegistryStore`] — the ACP registry as data. Fetches
//!   `cdn.agentclientprotocol.com/registry/v1/latest/registry.json`, throttled
//!   to once an hour, cached on disk with its icons so the marketplace renders
//!   offline. It installs nothing and spawns nothing.
//! - [`AgentServerStore`] — the installed map as agents. Rebuilds its
//!   `external_agents` table from the settings map on every settings or
//!   registry change ([`AgentServerStore::reregister`], Zed's
//!   `reregister_agents`), and hands out an `ExternalAgentServer` per entry.
//!
//! # There is no spawn ladder, and there are no default agents
//!
//! LOCKED (research §D12-3, 2026-08-21). An external agent exists **iff** the
//! user's installed map has an entry for it. Empty map ⇒ empty
//! [`AgentServerStore::external_agents`] ⇒ a fresh install offers exactly the
//! native agent (Cersei) and the marketplace.
//!
//! What that rules out, permanently:
//!
//! - **No `BUILTIN_AGENTS` table.** There is no list of agents Atlas ships,
//!   knows how to install, or suggests. Adding an id to a table must never
//!   again be how an agent appears.
//! - **No auto-acquire on spawn.** A missing binary is an error, not a trigger
//!   to go download something.
//! - **No spawn precedence ladder.** The old stack tried PATH, then its managed
//!   copy, then the installed entry. Here the installed entry *is* the answer:
//!   a `Custom` entry resolves to its own command, a `Registry` entry to its
//!   archive or npx install. Nothing else is consulted.
//! - **PATH discovery is not a spawn rung.** It survives only as
//!   [`detection`] — data behind the marketplace's "Detected on your system"
//!   list, which the user can turn into an ordinary `Custom` entry. See that
//!   module's invariant.
//!
//! Zed itself has one promotion surface Atlas deliberately does not copy: its
//! Welcome page offers four featured agents as one-click installs
//! (`onboarding/src/basics_page.rs:539-540`). Atlas ships no equivalent.
//!
//! # Divergences from Zed, and why
//!
//! - **No `Arc<dyn Fs>`.** Zed injects a filesystem so tests can run against a
//!   fake. Everything here that touches disk takes a directory, so tests run
//!   against a `tempfile::TempDir` instead. The HTTP side keeps its seam
//!   ([`HttpClient`]) because the alternative is tests that hit the network.
//! - **No GPUI reactivity.** Zed's store observes `SettingsStore` and the
//!   registry entity and re-registers on `cx.notify`. Here the host calls
//!   [`AgentServerStore::set_settings`] / [`AgentServerStore::registry_updated`]
//!   and watches [`AgentServerStore::updates`], a `watch` of a generation
//!   counter, in place of `cx.emit(AgentServersUpdated)`.
//! - **Version/loading channels are keyed by agent id, not carried on the
//!   server object.** Zed moves a `watch::Sender` between rebuilt server
//!   structs with `take_new_version_available_tx`/`set_…`; stage 1's
//!   `ExternalAgentServer` has no such methods, because its
//!   `AgentServerDelegate` carries the channels instead. The store therefore
//!   owns one channel pair per agent id and keeps it across rebuilds. Behaviour
//!   is the same one Zed's tests pin: a version change notifies, an unchanged
//!   version does not.
//! - **Managed Node only.** Zed can fall back to a system Node; the npx rung
//!   here always uses the managed runtime, per research §D12-8, which is what
//!   retires `node_setup.rs`'s nvm flow. Registry `cmd == "node"` resolves to
//!   the same managed binary, exactly as Zed does it.
//! - **Archives are always staged to a file before extraction.** Zed streams
//!   the response straight into the extractor when the registry published no
//!   checksum. Staging first costs a temp file and buys one code path for both
//!   cases; the checksum path had to buffer anyway.
//!
//! # Where BYOK env lands
//!
//! Zed layers `project env < registry target env < extra env < settings env`.
//! Atlas has one more source: the BYOK key store, pushed in with
//! [`AgentServerStore::set_byok_env`] (the `sync_builtin_agent_env` touchpoint,
//! research §C8b). It sits between `extra` and `settings`:
//!
//! ```text
//! project < registry target < extra < BYOK < settings
//! ```
//!
//! Above `extra` because `extra` carries the launcher's env workarounds — one
//! of which blanks `ANTHROPIC_API_KEY` so a subscription is billed instead of a
//! key — and a user who has configured a key in Atlas is asking for that key to
//! be used. Below `settings` because a value the user typed for this specific
//! agent is the most specific thing anyone said.

pub mod archive;
pub mod detection;
pub mod http;
pub mod node;
pub mod registry;
pub mod servers;
pub mod settings;
pub mod store;

pub use archive::sanitize_path_component;
pub use detection::{detect_on_path, DetectedAgent};
pub use http::{HttpClient, HttpResponse, ReqwestClient};
pub use node::NodeRuntime;
pub use registry::{
    AgentRegistryStore, RegistryAgent, RegistryAgentMetadata, RegistryBinaryAgent,
    RegistryNpxAgent, RegistryTargetConfig, REGISTRY_URL,
};
pub use servers::{InheritedProjectEnvironment, ProjectEnvironment};
pub use settings::{AgentServerSettings, AllAgentServersSettings};
pub use store::{AgentServerStore, ExternalAgentEntry, ExternalAgentSource};

use std::path::{Path, PathBuf};

/// Everything this crate installs lives under one root, mirroring Zed's
/// `paths::external_agents_dir()`. Zed reads it off a global; Atlas passes the
/// app's data dir in, so the crate stays leaf-level and a test can point it at
/// a tempdir.
pub fn external_agents_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("external-agents")
}

/// The registry's own corner of that root: `registry.json`, `icons/`, and one
/// directory per installed registry agent.
pub fn registry_dir(data_dir: &Path) -> PathBuf {
    external_agents_dir(data_dir).join("registry")
}
