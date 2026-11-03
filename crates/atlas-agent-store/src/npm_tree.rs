//! Is an npx agent's `node_modules` actually complete?
//!
//! npm treats an `optionalDependencies` entry as best-effort: when the fetch or
//! extract fails, Arborist swallows the error (`reify.js`,
//! `_handleOptionalFailure`), logs one *verbose* line, and exits 0. For a
//! package like `@openai/codex` — whose entire binary is an optional,
//! platform-specific dependency (`@openai/codex-darwin-arm64`, a 220 MB
//! tarball) — a "successful" install can therefore be missing the one thing
//! it exists to ship, and the agent dies at spawn with
//! `Missing optional dependency @openai/codex-darwin-arm64`.
//!
//! Worse, npm remembers the failure. The hidden lockfile
//! `node_modules/.package-lock.json` marks the node `ideallyInert: true`,
//! and the next `npm install` trusts that file, copies the inertness onto
//! the ideal tree and skips extraction. A repeat install is a no-op for the
//! missing package until `node_modules` is wiped.
//!
//! So this module reads that same hidden lockfile as the verdict on what npm
//! actually landed. It is agent-agnostic: any optional entry whose `os`/`cpu`/
//! `libc` gates match the running platform must be present on disk and not
//! inert. Nothing here names `@openai/codex`.
//!
//! The hidden lockfile is written *after* every package is extracted
//! (`reify.js`: `_reifyPackages` → `_saveIdealTree` → hidden lockfile), so its
//! absence beside an existing `node_modules` is the signature of an install
//! that was killed part-way — which can leave the top-level package with a
//! valid `package.json` and `bin` and nothing else.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Deserialize;

/// The npm name for the platform a lockfile entry's `os`/`cpu`/`libc` gates
/// are compared against — `process.platform` / `process.arch` as Node reports
/// them, e.g. `("darwin", "arm64")` or `("win32", "x64")`, and on Linux the
/// libc family npm detects (`"glibc"` or `"musl"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NpmPlatform {
    pub os: &'static str,
    pub cpu: &'static str,
    /// `None` leaves a `libc` gate open. npm evaluates the gate only on
    /// Linux, and there it must be known: a package that ships both a glibc
    /// and a musl variant (`@anthropic-ai/claude-agent-sdk-linux-x64` and
    /// `…-linux-x64-musl`) gets exactly one installed, and treating the gate
    /// as open would demand the other one too.
    pub libc: Option<&'static str>,
}

/// What the hidden lockfile says about `node_modules`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallState {
    /// Every optional entry this platform needs is on disk and not inert.
    Complete,
    /// `node_modules` exists but `node_modules/.package-lock.json` does not:
    /// npm never finished writing the tree.
    NoLockfile,
    /// The hidden lockfile is there but could not be read as one.
    UnreadableLockfile(String),
    /// These lockfile keys (e.g. `node_modules/@openai/codex-darwin-arm64`)
    /// apply to this platform and are either marked inert by npm or missing
    /// from disk.
    MissingOptional(Vec<String>),
}

impl InstallState {
    /// The reinstall reason to log, or `None` when the tree is complete.
    pub fn reinstall_reason(&self) -> Option<String> {
        match self {
            Self::Complete => None,
            Self::NoLockfile => {
                Some("install incomplete: node_modules has no .package-lock.json".to_owned())
            }
            Self::UnreadableLockfile(error) => Some(format!(
                "install incomplete: .package-lock.json unreadable ({error})"
            )),
            Self::MissingOptional(keys) => Some(format!(
                "platform package(s) missing or inert: {}",
                keys.join(", ")
            )),
        }
    }
}

/// One platform-gated optional entry, as the diagnostics dump lists them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OptionalEntry {
    pub key: String,
    pub present: bool,
    pub inert: bool,
}

/// A `os`/`cpu`/`libc` gate: npm accepts a string or an array.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum Gate {
    One(String),
    Many(Vec<String>),
}

impl Gate {
    fn entries(&self) -> Vec<&str> {
        match self {
            Self::One(value) => vec![value.as_str()],
            Self::Many(values) => values.iter().map(String::as_str).collect(),
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LockEntry {
    #[serde(default)]
    optional: bool,
    #[serde(default)]
    ideally_inert: bool,
    #[serde(default)]
    link: bool,
    #[serde(default)]
    dev: bool,
    #[serde(default)]
    dev_optional: bool,
    #[serde(default)]
    peer: bool,
    #[serde(default)]
    extraneous: bool,
    #[serde(default)]
    in_bundle: bool,
    os: Option<Gate>,
    cpu: Option<Gate>,
    libc: Option<Gate>,
}

#[derive(Debug, Deserialize)]
struct HiddenLockfile {
    #[serde(default)]
    packages: BTreeMap<String, LockEntry>,
}

pub const HIDDEN_LOCKFILE: &str = ".package-lock.json";

/// npm's `checkList` (`npm-install-checks/lib/index.js`): `value` passes when
/// no entry is `!value`, and either some positive entry equals `value` (or
/// `any`) or every entry is a negation. An absent gate passes everything.
fn gate_allows(gate: Option<&Gate>, value: Option<&str>) -> bool {
    let Some(gate) = gate else { return true };
    // A gate we cannot evaluate (no libc detection) is treated as open.
    let Some(value) = value else { return true };
    let entries = gate.entries();
    if entries.is_empty() {
        return true;
    }
    let mut all_negated = true;
    let mut positive_match = false;
    for entry in entries {
        if let Some(negated) = entry.strip_prefix('!') {
            if negated == value {
                return false;
            }
        } else {
            all_negated = false;
            if entry == value || entry == "any" {
                positive_match = true;
            }
        }
    }
    positive_match || all_negated
}

fn entry_applies(key: &str, entry: &LockEntry, platform: NpmPlatform) -> bool {
    !key.is_empty()
        && entry.optional
        && !entry.link
        && !entry.dev
        && !entry.dev_optional
        && !entry.peer
        && !entry.extraneous
        && !entry.in_bundle
        && gate_allows(entry.os.as_ref(), Some(platform.os))
        && gate_allows(entry.cpu.as_ref(), Some(platform.cpu))
        && gate_allows(entry.libc.as_ref(), platform.libc)
}

async fn read_hidden_lockfile(install_dir: &Path) -> Result<Option<HiddenLockfile>, String> {
    let node_modules = install_dir.join("node_modules");
    if !tokio::fs::metadata(&node_modules)
        .await
        .map(|m| m.is_dir())
        .unwrap_or(false)
    {
        // Nothing installed at all: the caller's version check reports that
        // before this ever runs, so treat it as "no lockfile" for consistency.
        return Ok(None);
    }
    let path = node_modules.join(HIDDEN_LOCKFILE);
    match tokio::fs::read(&path).await {
        Ok(bytes) => serde_json::from_slice::<HiddenLockfile>(&bytes)
            .map(Some)
            .map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Every optional entry the hidden lockfile gates onto `platform`, with
/// whether it landed. Empty when there is no lockfile.
pub async fn platform_optionals(install_dir: &Path, platform: NpmPlatform) -> Vec<OptionalEntry> {
    let Ok(Some(lockfile)) = read_hidden_lockfile(install_dir).await else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (key, entry) in &lockfile.packages {
        if !entry_applies(key, entry, platform) {
            continue;
        }
        let present = tokio::fs::read(install_dir.join(key).join("package.json"))
            .await
            .ok()
            .is_some_and(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).is_ok());
        out.push(OptionalEntry {
            key: key.clone(),
            present,
            inert: entry.ideally_inert,
        });
    }
    out
}

/// The verdict on `<install_dir>/node_modules` for `platform`.
pub async fn install_state(install_dir: &Path, platform: NpmPlatform) -> InstallState {
    match read_hidden_lockfile(install_dir).await {
        Ok(None) => InstallState::NoLockfile,
        Err(error) => InstallState::UnreadableLockfile(error),
        Ok(Some(_)) => {
            let gaps: Vec<String> = platform_optionals(install_dir, platform)
                .await
                .into_iter()
                .filter(|entry| entry.inert || !entry.present)
                .map(|entry| entry.key)
                .collect();
            if gaps.is_empty() {
                InstallState::Complete
            } else {
                InstallState::MissingOptional(gaps)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DARWIN_ARM64: NpmPlatform = NpmPlatform {
        os: "darwin",
        cpu: "arm64",
        libc: None,
    };

    const LINUX_X64_GLIBC: NpmPlatform = NpmPlatform {
        os: "linux",
        cpu: "x64",
        libc: Some("glibc"),
    };

    /// The shape of `@anthropic-ai/claude-agent-sdk`: one package per
    /// os/cpu, and on Linux a glibc and a musl variant of each.
    const CLAUDE_SDK_LIKE: &str = r#"{
      "lockfileVersion": 3,
      "packages": {
        "": { "name": "root" },
        "node_modules/@anthropic-ai/claude-agent-sdk": { "version": "0.2.0" },
        "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64": { "optional": true, "ideallyInert": true, "os": ["darwin"], "cpu": ["arm64"] },
        "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64": { "optional": true, "os": ["linux"], "cpu": ["x64"], "libc": ["glibc"] },
        "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl": { "optional": true, "ideallyInert": true, "os": ["linux"], "cpu": ["x64"], "libc": ["musl"] }
      }
    }"#;

    fn tree(lockfile: Option<&str>, packages: &[&str]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let node_modules = dir.path().join("node_modules");
        std::fs::create_dir_all(&node_modules).unwrap();
        if let Some(lockfile) = lockfile {
            std::fs::write(node_modules.join(HIDDEN_LOCKFILE), lockfile).unwrap();
        }
        for key in packages {
            let package_dir = dir.path().join(key);
            std::fs::create_dir_all(&package_dir).unwrap();
            std::fs::write(package_dir.join("package.json"), r#"{"name":"x"}"#).unwrap();
        }
        dir
    }

    const CODEX_LIKE: &str = r#"{
      "lockfileVersion": 3,
      "packages": {
        "": { "name": "root" },
        "node_modules/@openai/codex": { "version": "0.153.4" },
        "node_modules/@openai/codex-darwin-arm64": { "optional": true, "os": ["darwin"], "cpu": ["arm64"] },
        "node_modules/@openai/codex-darwin-x64": { "optional": true, "ideallyInert": true, "os": ["darwin"], "cpu": ["x64"] },
        "node_modules/@openai/codex-linux-arm64": { "optional": true, "ideallyInert": true, "os": ["linux"], "cpu": ["arm64"] },
        "node_modules/@openai/codex-win32-arm64": { "optional": true, "ideallyInert": true, "os": ["win32"], "cpu": ["arm64"] }
      }
    }"#;

    #[tokio::test]
    async fn a_healthy_tree_is_complete() {
        let dir = tree(
            Some(CODEX_LIKE),
            &["node_modules/@openai/codex-darwin-arm64"],
        );
        assert_eq!(
            install_state(dir.path(), DARWIN_ARM64).await,
            InstallState::Complete
        );
    }

    #[tokio::test]
    async fn an_inert_platform_package_is_a_gap_even_when_its_directory_exists() {
        let lockfile = CODEX_LIKE.replace(
            r#""node_modules/@openai/codex-darwin-arm64": { "optional": true,"#,
            r#""node_modules/@openai/codex-darwin-arm64": { "optional": true, "ideallyInert": true,"#,
        );
        let dir = tree(
            Some(&lockfile),
            &["node_modules/@openai/codex-darwin-arm64"],
        );
        assert_eq!(
            install_state(dir.path(), DARWIN_ARM64).await,
            InstallState::MissingOptional(vec!["node_modules/@openai/codex-darwin-arm64".into()])
        );
    }

    #[tokio::test]
    async fn a_missing_platform_package_directory_is_a_gap() {
        let dir = tree(Some(CODEX_LIKE), &[]);
        let state = install_state(dir.path(), DARWIN_ARM64).await;
        assert_eq!(
            state,
            InstallState::MissingOptional(vec!["node_modules/@openai/codex-darwin-arm64".into()])
        );
        assert_eq!(
            state.reinstall_reason().as_deref(),
            Some("platform package(s) missing or inert: node_modules/@openai/codex-darwin-arm64")
        );
    }

    #[tokio::test]
    async fn foreign_platforms_are_not_required() {
        let dir = tree(
            Some(CODEX_LIKE),
            &["node_modules/@openai/codex-darwin-arm64"],
        );
        let listed = platform_optionals(dir.path(), DARWIN_ARM64).await;
        assert_eq!(
            listed,
            vec![OptionalEntry {
                key: "node_modules/@openai/codex-darwin-arm64".into(),
                present: true,
                inert: false,
            }]
        );
    }

    #[tokio::test]
    async fn on_glibc_the_musl_variant_is_not_required() {
        let dir = tree(
            Some(CLAUDE_SDK_LIKE),
            &["node_modules/@anthropic-ai/claude-agent-sdk-linux-x64"],
        );
        assert_eq!(
            install_state(dir.path(), LINUX_X64_GLIBC).await,
            InstallState::Complete
        );
    }

    #[tokio::test]
    async fn on_glibc_the_glibc_variant_is_still_required() {
        let dir = tree(Some(CLAUDE_SDK_LIKE), &[]);
        assert_eq!(
            install_state(dir.path(), LINUX_X64_GLIBC).await,
            InstallState::MissingOptional(vec![
                "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64".into()
            ])
        );
    }

    #[tokio::test]
    async fn node_modules_without_a_hidden_lockfile_is_incomplete() {
        let dir = tree(None, &["node_modules/@scope/agent"]);
        assert_eq!(
            install_state(dir.path(), DARWIN_ARM64).await,
            InstallState::NoLockfile
        );
    }

    #[tokio::test]
    async fn a_garbled_hidden_lockfile_is_reported_not_trusted() {
        let dir = tree(Some("{not json"), &[]);
        assert!(matches!(
            install_state(dir.path(), DARWIN_ARM64).await,
            InstallState::UnreadableLockfile(_)
        ));
    }

    #[tokio::test]
    async fn dev_link_peer_and_bundled_optionals_are_ignored_and_nested_keys_resolve() {
        let lockfile = r#"{ "packages": {
            "node_modules/a": { "optional": true, "dev": true, "os": ["darwin"] },
            "node_modules/b": { "optional": true, "link": true, "resolved": "../b" },
            "node_modules/c": { "optional": true, "peer": true },
            "node_modules/d": { "optional": true, "inBundle": true },
            "node_modules/e": { "optional": true, "devOptional": true },
            "node_modules/f": { "optional": true, "extraneous": true },
            "node_modules/g/node_modules/h": { "optional": true, "os": "darwin", "cpu": "arm64" }
        } }"#;
        let dir = tree(Some(lockfile), &["node_modules/g/node_modules/h"]);
        assert_eq!(
            install_state(dir.path(), DARWIN_ARM64).await,
            InstallState::Complete
        );

        let dir = tree(Some(lockfile), &[]);
        assert_eq!(
            install_state(dir.path(), DARWIN_ARM64).await,
            InstallState::MissingOptional(vec!["node_modules/g/node_modules/h".into()])
        );
    }

    #[test]
    fn gates_follow_npm_check_list_semantics() {
        let many = |v: &[&str]| Gate::Many(v.iter().map(|s| (*s).to_owned()).collect());
        assert!(gate_allows(None, Some("darwin")));
        assert!(gate_allows(
            Some(&Gate::One("darwin".into())),
            Some("darwin")
        ));
        assert!(!gate_allows(
            Some(&Gate::One("linux".into())),
            Some("darwin")
        ));
        assert!(gate_allows(Some(&many(&["any"])), Some("darwin")));
        assert!(gate_allows(Some(&many(&["!win32"])), Some("darwin")));
        assert!(!gate_allows(Some(&many(&["!darwin"])), Some("darwin")));
        assert!(!gate_allows(
            Some(&many(&["darwin", "!darwin"])),
            Some("darwin")
        ));
        assert!(!gate_allows(
            Some(&many(&["linux", "!win32"])),
            Some("darwin")
        ));
        assert!(gate_allows(Some(&many(&[])), Some("darwin")));
        // A libc gate we cannot evaluate never blocks.
        assert!(gate_allows(Some(&many(&["musl"])), None));
        assert!(!gate_allows(Some(&many(&["musl"])), Some("glibc")));
        assert!(gate_allows(Some(&many(&["glibc"])), Some("glibc")));
    }
}
