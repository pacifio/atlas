//! OS-level sandboxing — the boundary that actually stops a dangerous command.
//!
//! The enforcement ladder (harness spec D3) selects the strongest thing the
//! host provides, at runtime, from one binary:
//!
//! | Tier | Enforcement                        | Reached when                    |
//! |------|------------------------------------|---------------------------------|
//! | 0    | OS sandbox + containment + approvals | macOS with `/usr/bin/sandbox-exec` |
//! | 1    | Containment + approvals            | sandbox unavailable             |
//! | 2    | Approvals only                     | not yet reachable — no setting selects it |
//! | 3    | Today's behaviour                  | never selected automatically     |
//!
//! Linux and Windows land on tier 1. Linux would need a separate sandbox
//! executable shipped as a packaged sidecar, which is a packaging workstream;
//! Windows has no path short of the dependency ADR-0001 rejects. Both are a
//! real improvement over the status quo, and — critically — the tier in force
//! is reported to the UI rather than degrading silently.
//!
//! Nothing in this module classifies. Classification decides how often the user
//! is interrupted; this decides what a command can actually touch.

use std::path::{Path, PathBuf};

#[cfg(target_os = "macos")]
mod seatbelt;

/// A configured OS sandbox for one workspace.
///
/// Only constructible on a host that actually has one — [`detect`] is the only
/// constructor and it returns `None` everywhere else. That is deliberate:
/// a `Sandbox` whose `wrap` silently handed back unsandboxed argv would be a
/// security control that reports success while doing nothing.
#[derive(Debug, Clone)]
pub struct Sandbox {
    kind: Kind,
    root: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// macOS `sandbox-exec`, driven by a generated Seatbelt profile.
    #[cfg(target_os = "macos")]
    Seatbelt,
}

/// Resolve the strongest sandbox this host supports for `root`, or `None`.
///
/// Detection is a filesystem probe rather than a compile-time decision, because
/// the same build ships to hosts that differ.
pub fn detect(root: &Path) -> Option<Sandbox> {
    #[cfg(target_os = "macos")]
    {
        if Path::new(seatbelt::SANDBOX_EXEC).is_file() {
            return Some(Sandbox {
                kind: Kind::Seatbelt,
                root: root.to_path_buf(),
            });
        }
        None
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = root;
        None
    }
}

impl Sandbox {
    pub fn kind(&self) -> &'static str {
        match self.kind {
            Kind::Seatbelt => "seatbelt",
        }
    }

    /// Wrap a command so it runs confined.
    ///
    /// `argv` is the full command line as it would otherwise be spawned (for
    /// the shell tool, `["sh", "-c", "<command>"]`). The returned vector is
    /// what to spawn instead. Writes are confined to the workspace and to the
    /// per-user temporary directory; reads are permitted broadly *except* for
    /// an explicit list of credential and browser-profile locations, because a
    /// read whitelist breaks every real build system while the deny list still
    /// answers the threat the user actually named.
    pub fn wrap(&self, argv: Vec<String>) -> Vec<String> {
        match self.kind {
            #[cfg(target_os = "macos")]
            Kind::Seatbelt => seatbelt::wrap(&self.root, argv),
        }
    }

    /// Whether a command's failure looks like the sandbox refusing it, rather
    /// than the command itself failing. Drives the escalation offer.
    pub fn looks_like_denial(&self, output: &str) -> bool {
        match self.kind {
            Kind::Seatbelt => {
                let lower = output.to_ascii_lowercase();
                lower.contains("operation not permitted")
                    || lower.contains("sandbox-exec")
                    || lower.contains("deny file-write")
                    || lower.contains("deny file-read")
            }
        }
    }
}

/// Paths never readable from inside the sandbox, relative to the user's home.
///
/// This is the list that answers "a misread instruction cannot reach my SSH
/// keys or browser profile". It is a deny list rather than a read whitelist on
/// purpose: a whitelist that is tight enough to be meaningful also breaks
/// `cargo`, `npm`, `go` and every toolchain that reads from outside the
/// workspace, and a sandbox users turn off protects nobody.
pub const SENSITIVE_HOME_SUBPATHS: &[&str] = &[
    ".ssh",
    ".aws",
    ".gnupg",
    ".kube",
    ".docker/config.json",
    ".config/gh",
    ".config/gcloud",
    ".netrc",
    ".npmrc",
    ".pypirc",
    ".cargo/credentials.toml",
    // Atlas's own store. `byok-keys.json` under the app's config directory is
    // the user's provider keys in plaintext; an agent able to read it could
    // exfiltrate the credential that pays for it.
    "Library/Application Support/com.atlas.app",
    "Library/Application Support/atlas",
    ".config/atlas",
    "Library/Application Support/Google/Chrome",
    "Library/Application Support/Firefox",
    "Library/Application Support/com.apple.TCC",
    "Library/Keychains",
    "Library/Cookies",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detection_is_a_runtime_probe_not_a_panic() {
        // Whatever this host is, detection must return an answer rather than
        // failing: the ladder degrades, it does not error.
        let _ = detect(Path::new("/"));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn non_macos_hosts_get_no_sandbox_and_that_is_tier_1() {
        assert!(detect(Path::new("/")).is_none());
    }
}
