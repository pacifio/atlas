//! Which set of on-disk data this Atlas process owns.
//!
//! A contributor runs the released Atlas on their real projects **and** a
//! source build (`bun run dev:app`) on the same machine and often the same
//! folders. Without a separation the two share every byte Atlas persists — the
//! thread history, the session record, shared memory, `config.toml` — so a dev
//! build mid-migration, or simply a buggy one, corrupts the app the person
//! actually works in. A **profile** is the set of names those stores live
//! under:
//!
//! | | [`Profile::Default`] | [`Profile::Dev`] |
//! |---|---|---|
//! | bundle identifier (app config/data/log dirs, WebView data) | `dev.atlas.ide` | `dev.atlas.ide.dev` |
//! | per-project and home dot-directory | `.atlas/` | `.atlas-dev/` |
//! | `~/.config/<name>/` (`config.toml`, user themes) | `atlas` | `atlas-dev` |
//!
//! ## One switch: the bundle identifier
//!
//! The profile is *derived from* the identifier the app was built with, never
//! chosen separately. `dev:app` passes `src-tauri/tauri.dev.conf.json`, which
//! overrides `identifier`; `lib.rs` reads it back out of the generated context
//! and calls [`init`] before anything else runs. An environment variable was
//! the obvious alternative and was rejected for two reasons:
//!
//! - **It can half-apply.** Tauri resolves the app config dir from the
//!   identifier, not from anything Atlas controls, so an env var alone would
//!   split the project dirs but still share `threads.db`; the identifier alone
//!   would do the reverse. Deriving one from the other leaves nothing to forget.
//! - **It leaks.** Every child Atlas starts — the integrated terminal's shell,
//!   every agent — inherits the environment, so a released Atlas launched from
//!   a dev build's terminal would have quietly adopted the dev profile. The
//!   identifier is baked into the binary at compile time and cannot travel.
//!
//! A release build is therefore structurally the default profile: its
//! identifier is `dev.atlas.ide`, and nothing at runtime can change that.
//!
//! ## Outside the app
//!
//! Crates read the profile through [`current`] and its shorthands. Nothing but
//! the app calls [`init`], so a crate's own tests, a `cargo test` anywhere, and
//! any tool built from these crates all see [`Profile::Default`] — exactly the
//! paths they saw before profiles existed.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The released app's bundle identifier — `identifier` in
/// `src-tauri/tauri.conf.json`. `tests/dev-profile.test.ts` holds the two in
/// step.
pub const DEFAULT_IDENTIFIER: &str = "dev.atlas.ide";

/// The dev profile's bundle identifier — `identifier` in
/// `src-tauri/tauri.dev.conf.json`. It starts with [`DEFAULT_IDENTIFIER`] so
/// anything that recognises Atlas by searching for its identifier (the Linux
/// CLI helper's binary probe) still recognises a dev build.
pub const DEV_IDENTIFIER: &str = "dev.atlas.ide.dev";

/// Which set of on-disk names this process uses. See the module docs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Profile {
    /// The released app's data. What every build and every test gets unless
    /// the app was built with [`DEV_IDENTIFIER`].
    #[default]
    Default,
    /// A source build's own data, beside the released app's and never in it.
    Dev,
}

impl Profile {
    /// The profile an app built with `identifier` runs under. Anything other
    /// than [`DEV_IDENTIFIER`] is the default profile: a fork that renames the
    /// bundle keeps today's directory names rather than inventing new ones.
    pub fn from_identifier(identifier: &str) -> Self {
        if identifier == DEV_IDENTIFIER {
            Self::Dev
        } else {
            Self::Default
        }
    }

    pub fn is_dev(self) -> bool {
        self == Self::Dev
    }

    /// The bundle identifier this profile's app is built with — and therefore
    /// the directory name Tauri gives its app config, data and log dirs.
    pub fn identifier(self) -> &'static str {
        match self {
            Self::Default => DEFAULT_IDENTIFIER,
            Self::Dev => DEV_IDENTIFIER,
        }
    }

    /// The product name the window and the OS show. Matches `productName` in
    /// the profile's Tauri config.
    pub fn product_name(self) -> &'static str {
        match self {
            Self::Default => "Atlas",
            Self::Dev => "Atlas Dev",
        }
    }

    /// Atlas's own dot-directory, both inside a project (`<project>/.atlas`)
    /// and in the home directory (`~/.atlas`). One name for both because they
    /// have always been one name; a second function would only be a second
    /// place for them to drift apart.
    pub fn dir_name(self) -> &'static str {
        match self {
            Self::Default => ".atlas",
            Self::Dev => ".atlas-dev",
        }
    }

    /// The directory under `~/.config` (or `$XDG_CONFIG_HOME`) holding
    /// `config.toml` and the user's themes. Named for the product, not the
    /// bundle id, for the reason `state::atlas_config::config_root` gives.
    pub fn config_dir_name(self) -> &'static str {
        match self {
            Self::Default => "atlas",
            Self::Dev => "atlas-dev",
        }
    }
}

static CURRENT: OnceLock<Profile> = OnceLock::new();

/// Fix this process's profile. Called once, by the app, before anything reads
/// it.
///
/// # Panics
///
/// When the profile was already fixed to a different value — by an earlier
/// [`init`], or by a [`current`] that ran first and so settled on the default.
/// Either means some code resolved a path before the app knew whose data it
/// owns, and carrying on would write that code's data into the other profile's
/// directories. A release build cannot reach this: its only profile is the
/// default one, which is also what an early read settles on.
pub fn init(profile: Profile) {
    let fixed = *CURRENT.get_or_init(|| profile);
    assert_eq!(
        fixed, profile,
        "atlas-profile: the profile was read as {fixed:?} before init({profile:?})"
    );
}

/// This process's profile: what [`init`] set, or [`Profile::Default`] when
/// nothing did (every test, every non-app consumer).
pub fn current() -> Profile {
    *CURRENT.get_or_init(Profile::default)
}

/// Shorthand for `current().is_dev()`.
pub fn is_dev() -> bool {
    current().is_dev()
}

/// Shorthand for `current().dir_name()`: `.atlas` or `.atlas-dev`.
pub fn dir_name() -> &'static str {
    current().dir_name()
}

/// Shorthand for `current().config_dir_name()`: `atlas` or `atlas-dev`.
pub fn config_dir_name() -> &'static str {
    current().config_dir_name()
}

/// `<root>/.atlas` (or `<root>/.atlas-dev`): Atlas's directory inside a project
/// root, or inside the home directory when `root` is the home directory.
pub fn dir_in(root: impl AsRef<Path>) -> PathBuf {
    root.as_ref().join(dir_name())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_profile_keeps_every_name_the_released_app_uses() {
        let p = Profile::Default;
        assert!(!p.is_dev());
        assert_eq!(p.identifier(), "dev.atlas.ide");
        assert_eq!(p.product_name(), "Atlas");
        assert_eq!(p.dir_name(), ".atlas");
        assert_eq!(p.config_dir_name(), "atlas");
    }

    #[test]
    fn the_dev_profile_renames_every_one_of_them() {
        let d = Profile::Dev;
        let p = Profile::Default;
        assert!(d.is_dev());
        assert_eq!(d.identifier(), "dev.atlas.ide.dev");
        assert_eq!(d.product_name(), "Atlas Dev");
        assert_eq!(d.dir_name(), ".atlas-dev");
        assert_eq!(d.config_dir_name(), "atlas-dev");
        // The point of a profile: no name is shared.
        assert_ne!(d.identifier(), p.identifier());
        assert_ne!(d.dir_name(), p.dir_name());
        assert_ne!(d.config_dir_name(), p.config_dir_name());
    }

    #[test]
    fn only_the_dev_identifier_selects_the_dev_profile() {
        assert_eq!(Profile::from_identifier(DEV_IDENTIFIER), Profile::Dev);
        assert_eq!(
            Profile::from_identifier(DEFAULT_IDENTIFIER),
            Profile::Default
        );
        // A fork's own identifier, or anything near-miss, keeps today's names.
        for other in [
            "com.example.atlas",
            "dev.atlas.ide.devel",
            "",
            "DEV.ATLAS.IDE.DEV",
        ] {
            assert_eq!(Profile::from_identifier(other), Profile::Default, "{other}");
        }
    }

    #[test]
    fn identifiers_round_trip() {
        for p in [Profile::Default, Profile::Dev] {
            assert_eq!(Profile::from_identifier(p.identifier()), p);
        }
    }

    /// Nothing in this test binary calls `init`, which is exactly the position
    /// every crate's tests and every non-app consumer are in.
    #[test]
    fn an_uninitialised_process_is_the_default_profile() {
        assert_eq!(current(), Profile::Default);
        assert!(!is_dev());
        assert_eq!(dir_name(), ".atlas");
        assert_eq!(config_dir_name(), "atlas");
        assert_eq!(dir_in(Path::new("/p")), Path::new("/p").join(".atlas"));
    }
}
