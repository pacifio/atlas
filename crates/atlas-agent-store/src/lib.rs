//! Atlas's agent store — where an external agent comes from, and how its
//! command line gets resolved.
//!
//! It implements [`atlas_agent_servers::server::ExternalAgentServer`].
//!
//! Two pieces:
//!
//! - [`AgentRegistryStore`] — the ACP registry as data. Fetches
//!   `cdn.agentclientprotocol.com/registry/v1/latest/registry.json`, throttled
//!   to once an hour, cached on disk with its icons so the marketplace renders
//!   offline. It installs nothing and spawns nothing.
//! - [`AgentServerStore`] — the installed map as agents. Rebuilds its
//!   `external_agents` table from the settings map on every settings or
//!   registry change ([`AgentServerStore::reregister`]), and hands out an `ExternalAgentServer` per entry.
//!
//! # There is no spawn ladder, and there are no default agents
//!
//! LOCKED (research §D12-3, 2026-08-21). An external agent exists **iff** the
//! user's installed map has an entry for it. Empty map ⇒ empty
//! [`AgentServerStore::external_agents`] ⇒ a fresh install offers exactly the
//! native agent and the marketplace.
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
//! Atlas also has no promotion surface: no welcome page offers featured agents
//! as one-click installs.
//!
//! # Design decisions, and why
//!
//! - **No `Arc<dyn Fs>`.** Everything here that touches disk takes a directory, so tests run
//!   against a `tempfile::TempDir` instead. The HTTP side keeps its seam
//!   ([`HttpClient`]) because the alternative is tests that hit the network.
//! - **No UI-framework reactivity.** The host calls
//!   [`AgentServerStore::set_settings`] / [`AgentServerStore::registry_updated`]
//!   and watches [`AgentServerStore::updates`], a `watch` of a generation
//!   counter.
//! - **Version/loading channels are keyed by agent id, not carried on the
//!   server object.** `ExternalAgentServer` has no methods for handing a
//!   sender between rebuilt servers, because its `AgentServerDelegate` carries
//!   the channels instead. The store therefore owns one channel pair per agent
//!   id and keeps it across rebuilds. A version change notifies; an unchanged
//!   version does not.
//! - **Managed Node only.** There is no fallback to a system Node; the npx
//!   rung always uses the managed runtime, per research §D12-8, which is what
//!   retires `node_setup.rs`'s nvm flow. Registry `cmd == "node"` resolves to
//!   the same managed binary.
//! - **Archives are always staged to a file before extraction.** Staging
//!   first costs a temp file and buys one code path whether or not the registry
//!   published a checksum; the checksum path had to buffer anyway.
//! - **The registry index is parsed entry by entry, not all at once.**
//!   Deserializing `agents` as `Vec<RegistryEntry>` would let one publisher
//!   omitting one required field fail the whole document. Atlas LOCKED the
//!   decision to ship no builtin agent list and no featured-agents page, so
//!   such a failure would remove every route to an external agent. Entries that do not parse are dropped and logged; the document
//!   itself is still strict. See `registry::entries_that_parse`.
//!
//! # Trust model
//!
//! The ACP registry is **third-party data**, not a trusted channel. It is
//! fetched over TLS from a CDN Atlas does not run, and it describes assets on
//! hosts Atlas does not run either, published by dozens of unrelated authors.
//! A compromised or malicious entry is in scope; what follows is what that
//! buys an attacker, and what it does not.
//!
//! - **Checksums are best-effort, and that is a known gap.** The registry's
//!   own `sha256` wins; failing that, GitHub's recorded digest for the release
//!   asset. Roughly half the live catalogue publishes neither, and refusing
//!   those would remove real agents (Cursor, Antigravity, Cortex, Devin) from
//!   Atlas entirely. So an unverified install stays possible, and the
//!   marketplace marks it — the badge is the mitigation, not the checksum.
//!   Note a digest only proves the bytes are the ones the registry named: a
//!   hostile entry publishes the digest of its own payload and passes.
//! - **The managed Node runtime is the exception, and is verified.**
//!   nodejs.org publishes `SHASUMS256.txt` beside every release, so there is
//!   nothing to trade off. A runtime whose digest cannot be fetched is not
//!   installed. See `node::node_archive_digest`. Note what that buys and what
//!   it does not: the digest travels the same TLS connection as the tarball,
//!   so it catches a corrupted download or a swapped mirror, not a compromised
//!   nodejs.org and not somebody who already holds the TLS path. Detached
//!   signatures would be the answer to those, and this is not that.
//! - **Install cost is bounded regardless of trust.** A checksum says nothing
//!   about size, so the download, the expansion and the entry count each have
//!   a ceiling — see [`archive::InstallLimits`]. These are ceilings no real
//!   agent approaches; tripping one means the archive is wrong.
//! - **Extracted files are masked, not trusted.** Archive permission bits are
//!   attacker-controlled. Everything extracted is masked to `0o755`, which
//!   drops setuid, setgid, sticky and group/other write. Neither archive crate
//!   does this on its own, and what each one does has changed under us before,
//!   so it is pinned by tests rather than assumed.
//! - **Path containment is inherited, not implemented.** Neither zip-slip nor
//!   tar traversal is reachable, but that is a property of `zip` and `tar`,
//!   not of this crate. A dependency bump could remove it silently.
//!
//! # Where BYOK env lands
//!
//! Env is layered `project env < registry target env < extra env < settings env`,
//! plus one more source: the BYOK key store, pushed in with
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
pub mod npm_tree;
pub mod registry;
pub mod secrets;
pub mod servers;
pub mod settings;
pub mod store;

pub use archive::sanitize_path_component;
pub use detection::{detect_on_path, DetectedAgent};
pub use http::{HttpClient, HttpResponse, ReqwestClient};
pub use node::{npm_platform, NodeRuntime};
pub use npm_tree::{install_state, platform_optionals, InstallState, NpmPlatform, OptionalEntry};
pub use registry::{
    AgentRegistryStore, RegistryAgent, RegistryAgentMetadata, RegistryBinaryAgent,
    RegistryNpxAgent, RegistryTargetConfig, REGISTRY_URL,
};
pub use secrets::{SecretEnv, SecretSource};
pub use servers::{
    forget_npx_install_decision, installed_npx_version, npx_install_dir,
    InheritedProjectEnvironment, ProjectEnvironment,
};
pub use settings::{AgentServerSettings, AllAgentServersSettings, CustomModel, UserSettingsMut};
pub use store::{AgentServerStore, ExternalAgentEntry, ExternalAgentSource};

use std::path::{Path, PathBuf};

/// Everything this crate installs lives under one root. The app's data dir is
/// passed in, so the crate stays leaf-level and a test can point it at
/// a tempdir.
pub fn external_agents_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("external-agents")
}

/// The registry's own corner of that root: `registry.json`, `icons/`, and one
/// directory per installed registry agent.
pub fn registry_dir(data_dir: &Path) -> PathBuf {
    external_agents_dir(data_dir).join("registry")
}
