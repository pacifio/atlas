//! Dynamic ACP agent registry for Atlas.
//!
//! Consumes the official ACP registry (the same CDN manifest Zed uses) and
//! turns installed entries into spawnable `atlas_acp::AgentSpec`s via the
//! `SpecSource` seam. Owns: manifest fetch/throttle/disk cache, icon cache,
//! the Rust-owned install store, and binary download/verify/extract.
//!
//! This crate is the ONLY source of ACP agents in Atlas. No agent is built in,
//! pre-seeded, auto-acquired or granted precedence over another: an external
//! agent is spawnable if and only if there is an active entry in the install
//! store, exactly as Zed derives `external_agents` solely from its
//! `agent_servers` settings map.

mod binary;
mod cache;
mod error;
mod install_store;
mod manifest;
mod platform;
mod store;

pub use binary::ProgressFn;
pub use cache::REGISTRY_URL;
pub use error::{RegistryError, Result};
pub use install_store::{InstalledAgent, ResolvedBinary};
pub use manifest::{BinaryTarget, Distribution, PackageTarget, RegistryAgent, RegistryManifest};
pub use platform::platform_key;
pub use store::{RegistryEntryView, RegistryListing, RegistryStore};

