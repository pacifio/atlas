//! macOS Seatbelt profile generation.
//!
//! The `.sbpl` policy data next to this file is vendored from Codex
//! (Apache-2.0); see `ATTRIBUTION.md`. This module is Atlas's own generator:
//! it composes that base with workspace-scoped write rules and a
//! sensitive-path read deny list, then produces the `sandbox-exec` argv.
//!
//! Two rules matter for correctness and are worth stating plainly:
//!
//! * **Paths are passed as `-D` parameters, never interpolated into the
//!   profile text.** A workspace path containing a quote or a paren would
//!   otherwise be able to close a policy expression and rewrite the rest of the
//!   profile. This is the same reason Codex uses parameters.
//! * **Later rules win.** The base opens with `(deny default)`; the allow rules
//!   follow; the sensitive-path denials come last so they override the broad
//!   read allowance.

use std::path::Path;

/// Only ever `/usr/bin/sandbox-exec`, never a PATH lookup: an attacker able to
/// put a fake `sandbox-exec` earlier on PATH would otherwise silently disable
/// the sandbox. (If `/usr/bin` itself has been tampered with, they already have
/// root and the question is moot.)
pub const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

const BASE_POLICY: &str = include_str!("base_policy.sbpl");
const NETWORK_POLICY: &str = include_str!("network_policy.sbpl");

/// Build the `sandbox-exec` argv that runs `argv` confined to `root`.
pub fn wrap(root: &Path, argv: Vec<String>) -> Vec<String> {
    let (policy, params) = profile(root);
    let mut out = Vec::with_capacity(argv.len() + params.len() + 4);
    out.push(SANDBOX_EXEC.to_string());
    out.push("-p".to_string());
    out.push(policy);
    for (key, value) in params {
        out.push(format!("-D{key}={value}"));
    }
    out.push("--".to_string());
    out.extend(argv);
    out
}

/// The generated profile plus the `-D` parameter bindings it references.
///
/// `root` is canonicalised first. Seatbelt matches against *resolved* paths, so
/// a profile written for `/var/folders/...` denies writes to the very workspace
/// it was built for, because the real path is `/private/var/folders/...`. The
/// policy already canonicalises its root; this repeats it because the failure
/// mode — the agent unable to write to its own workspace — is silent and
/// baffling.
fn profile(root: &Path) -> (String, Vec<(String, String)>) {
    let root = &root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let mut params: Vec<(String, String)> = Vec::new();
    let mut sections = vec![BASE_POLICY.to_string(), NETWORK_POLICY.to_string()];

    // Reads: broad, so toolchains work. Narrowed by the denials at the bottom.
    sections.push("; Atlas: read broadly so build tools work.\n(allow file-read*)".to_string());

    // Network. The vendored network policy grants the *supporting* rights — DNS
    // configuration, the security server, loopback system sockets — but not the
    // outbound connection itself: Codex injects that from its proxy layer, which
    // Atlas deliberately did not vendor (network mediation is out of scope).
    // Without this rule the base policy's `(deny default)` blocks every socket,
    // so `npm install`, `cargo fetch`, `pip install` and `git push` all fail —
    // and tier 0 is the default on macOS, so that is every user.
    sections.push(
        "; Atlas: the network is not mediated. Sandboxing bounds the filesystem;\n         ; it is not a firewall, and pretending otherwise breaks every build tool.\n         (allow network-outbound)\n(allow network-inbound (local ip))\n(allow system-socket)"
            .to_string(),
    );

    // Writes: the workspace, plus the temp directories every compiler uses.
    let mut writable: Vec<String> = Vec::new();
    params.push(("ATLAS_ROOT".to_string(), root.to_string_lossy().into_owned()));
    writable.push("(subpath (param \"ATLAS_ROOT\"))".to_string());

    for (index, dir) in temp_roots().into_iter().enumerate() {
        let key = format!("ATLAS_TMP_{index}");
        writable.push(format!("(subpath (param \"{key}\"))"));
        params.push((key, dir));
    }
    sections.push(format!(
        "; Atlas: write only inside the workspace and the temp dirs.\n(allow file-write*\n  {}\n)",
        writable.join("\n  ")
    ));
    // /dev/null and friends are how nearly every command discards output.
    sections.push(
        "(allow file-write-data file-ioctl\n  (literal \"/dev/null\")\n  (literal \"/dev/dtracehelper\")\n  (literal \"/dev/tty\")\n)"
            .to_string(),
    );

    // Denials last: later rules override the broad read allowance above.
    if let Some(home) = home_dir() {
        let mut denials: Vec<String> = Vec::new();
        for (index, name) in super::SENSITIVE_HOME_SUBPATHS.iter().enumerate() {
            let key = format!("ATLAS_DENY_{index}");
            let path = Path::new(&home).join(name);
            // A path that is not under the workspace anyway; if the user's
            // workspace *is* one of these, the workspace rule already lost.
            denials.push(format!("(subpath (param \"{key}\"))"));
            denials.push(format!("(literal (param \"{key}\"))"));
            params.push((key, path.to_string_lossy().into_owned()));
        }
        if !denials.is_empty() {
            sections.push(format!(
                "; Atlas: credentials and browser profiles stay unreadable.\n(deny file-read* file-write*\n  {}\n)",
                denials.join("\n  ")
            ));
        }
    }

    (sections.join("\n\n"), params)
}

/// Temp directories that must stay writable. `TMPDIR` on macOS is a per-user
/// path under `/var/folders`, which is where `cc`, `rustc` and `node` put
/// intermediates; without it almost nothing builds.
fn temp_roots() -> Vec<String> {
    let mut out = vec!["/tmp".to_string(), "/var/tmp".to_string()];
    if let Ok(tmpdir) = std::env::var("TMPDIR") {
        let trimmed = tmpdir.trim_end_matches('/');
        if !trimmed.is_empty() {
            out.push(trimmed.to_string());
        }
    }
    // `/private/tmp` is the real path `/tmp` symlinks to; the sandbox compares
    // resolved paths, so both are needed.
    out.push("/private/tmp".to_string());
    out.push("/private/var/tmp".to_string());
    out.sort();
    out.dedup();
    out
}

fn home_dir() -> Option<String> {
    std::env::var("HOME").ok().filter(|h| !h.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_never_interpolates_a_path_into_policy_text() {
        // A workspace whose name could close a policy expression must not be
        // able to rewrite the profile.
        let evil = Path::new("/tmp/a\") (allow file-write*) (deny nothing \"");
        let (policy, params) = profile(evil);
        assert!(
            !policy.contains("allow file-write*) (deny nothing"),
            "path text leaked into the profile"
        );
        assert!(params
            .iter()
            .any(|(k, v)| k == "ATLAS_ROOT" && v.as_str() == evil.to_string_lossy()));
    }

    #[test]
    fn workspace_is_writable_and_bound_by_parameter() {
        let (policy, params) = profile(Path::new("/Users/x/proj"));
        assert!(policy.contains("(subpath (param \"ATLAS_ROOT\"))"));
        assert!(policy.contains("(allow file-write*"));
        assert_eq!(
            params.iter().find(|(k, _)| k == "ATLAS_ROOT").map(|(_, v)| v.as_str()),
            Some("/Users/x/proj")
        );
    }

    #[test]
    fn denies_come_after_the_broad_read_allowance() {
        let (policy, _) = profile(Path::new("/Users/x/proj"));
        let allow = policy.find("(allow file-read*)").expect("read allowance");
        if let Some(deny) = policy.find("(deny file-read*") {
            assert!(deny > allow, "seatbelt takes the last matching rule");
        }
    }

    #[test]
    fn sensitive_paths_are_denied_when_home_is_known() {
        // Only meaningful when HOME is set, which it is in every real session
        // and in CI.
        if home_dir().is_none() {
            return;
        }
        let (policy, params) = profile(Path::new("/Users/x/proj"));
        assert!(policy.contains("(deny file-read* file-write*"));
        assert!(
            params.iter().any(|(_, v)| v.ends_with("/.ssh")),
            "the SSH key directory must be denied"
        );
    }

    #[test]
    fn wrap_puts_the_command_after_a_double_dash() {
        let argv = wrap(
            Path::new("/Users/x/proj"),
            vec!["sh".into(), "-c".into(), "echo hi".into()],
        );
        assert_eq!(argv[0], SANDBOX_EXEC);
        assert_eq!(argv[1], "-p");
        let sep = argv.iter().position(|a| a == "--").expect("separator");
        assert_eq!(&argv[sep + 1..], &["sh", "-c", "echo hi"]);
        // Everything between the policy and the separator is a -D binding.
        assert!(argv[3..sep].iter().all(|a| a.starts_with("-D")));
    }

    #[test]
    fn temp_roots_include_the_per_user_tmpdir() {
        let roots = temp_roots();
        assert!(roots.contains(&"/tmp".to_string()));
        if let Ok(t) = std::env::var("TMPDIR") {
            let t = t.trim_end_matches('/').to_string();
            if !t.is_empty() {
                assert!(roots.contains(&t), "TMPDIR must stay writable: {roots:?}");
            }
        }
    }
}
