//! Dynamic ACP agent registry for Atlas.
//!
//! Consumes the official ACP registry (the same CDN manifest Zed uses) and
//! turns installed entries into spawnable `atlas_acp::AgentSpec`s via the
//! `SpecSource` seam. Owns: manifest fetch/throttle/disk cache, icon cache,
//! the Rust-owned install store, and binary download/verify/extract.

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
pub use store::{RegistryEntryView, RegistryListing, RegistryStore, BUILTIN_REGISTRY_IDS};
