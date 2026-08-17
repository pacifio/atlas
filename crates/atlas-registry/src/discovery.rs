//! System-first agent discovery: which ACP agents are ALREADY installed on
//! this machine.
//!
//! Atlas used to learn availability only by a spawn failing, and its own
//! downloaded copy outranked whatever the user had installed. This module is
//! the other half of the inversion fix — it names the executables worth
//! looking for, and [`RegistryStore::discover`](crate::RegistryStore::discover)
//! resolves them through one batched login-shell probe.
//!
//! The candidate set is deliberately narrow: an agent counts as "installed"
//! only when there is a real executable to find. `npx`/`uvx` entries are
//! "runnable if Node/uv exists", which is a different claim and already
//! covered by the existing spawn path.

use std::collections::HashMap;

use crate::manifest::{Distribution, RegistryAgent, RegistryManifest};

/// An agent found on the user's `PATH`, ready to spawn without any download.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredAgent {
    /// The spec/plugin id this satisfies.
    pub spec_id: String,
    /// Absolute path to the executable.
    pub program: String,
    /// argv that makes it speak ACP over stdio.
    pub args: Vec<String>,
    /// Env the manifest declares for this agent (empty for built-ins, whose
    /// env comes from Atlas's BYOK layer instead).
    pub env: HashMap<String, String>,
    pub display_name: String,
    pub help_url: Option<String>,
}

/// One executable worth probing for, and what to do with a hit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeCandidate {
    pub spec_id: String,
    /// Bare executable name to resolve through the login shell.
    pub program: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub display_name: String,
    pub help_url: Option<String>,
}

/// Everything worth probing for: every built-in with a `path_program`, plus
/// every manifest agent that isn't one of those in disguise and publishes a
/// plain relative executable for this platform.
///
/// Skipped on purpose:
/// - `cmd == "node"` binary targets — the executable to find is `node`, which
///   says nothing about whether the *agent* is installed.
/// - npx/uvx-only entries — same reason.
/// - manifest ids that duplicate a built-in (`builtin_registry_ids`), which
///   would otherwise produce a second candidate for one agent.
pub fn probe_candidates(manifest: Option<&RegistryManifest>) -> Vec<ProbeCandidate> {
    let mut candidates: Vec<ProbeCandidate> = atlas_acp::BUILTIN_AGENTS
        .iter()
        .filter_map(|b| {
            let program = b.path_program?;
            let display_name = atlas_acp::AgentSpec::all_known()
                .into_iter()
                .find(|s| s.spec_id == b.spec_id)
                .map(|s| s.display_name)
                .unwrap_or_else(|| b.spec_id.to_string());
            Some(ProbeCandidate {
                spec_id: b.spec_id.to_string(),
                program: program.to_string(),
                args: b.acp_args.iter().map(|s| s.to_string()).collect(),
                // Built-ins get Atlas's BYOK env layered in at spec-synthesis
                // time instead — see `RegistryStore::discovered_specs`.
                env: HashMap::new(),
                display_name,
                help_url: None,
            })
        })
        .collect();

    let Some(manifest) = manifest else {
        return candidates;
    };
    let builtin_ids = atlas_acp::builtin_registry_ids();
    for agent in &manifest.agents {
        if builtin_ids.contains(&agent.id.as_str()) {
            continue;
        }
        if candidates.iter().any(|c| c.spec_id == agent.id) {
            continue;
        }
        let Some(candidate) = manifest_candidate(agent) else {
            continue;
        };
        candidates.push(candidate);
    }
    candidates
}

/// A manifest entry → probe candidate, when it publishes a real executable for
/// this platform. The program name is the archive-relative `cmd`'s basename:
/// a system install of the same agent puts that same name on `PATH`.
fn manifest_candidate(agent: &RegistryAgent) -> Option<ProbeCandidate> {
    let target = platform_binary(&agent.distribution)?;
    if target.cmd == "node" {
        return None; // "run this JS with node" — nothing agent-specific to find
    }
    let program = target
        .cmd
        .trim_start_matches("./")
        .rsplit('/')
        .next()
        .filter(|p| !p.is_empty())?;
    Some(ProbeCandidate {
        spec_id: agent.id.clone(),
        program: program.to_string(),
        args: target.args.clone(),
        env: target.env.clone(),
        display_name: agent.name.clone(),
        help_url: agent.repository.clone().or_else(|| agent.website.clone()),
    })
}

fn platform_binary(dist: &Distribution) -> Option<&crate::manifest::BinaryTarget> {
    dist.binary.as_ref()?.get(crate::platform::platform_key())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::{BinaryTarget, PackageTarget};
    use crate::platform::platform_key;

    fn binary_agent(id: &str, cmd: &str) -> RegistryAgent {
        RegistryAgent {
            id: id.into(),
            name: id.into(),
            version: "1.0.0".into(),
            description: None,
            repository: Some("https://example.com/repo".into()),
            website: None,
            authors: None,
            license: None,
            icon: None,
            distribution: Distribution {
                binary: Some(HashMap::from([(
                    platform_key().to_string(),
                    BinaryTarget {
                        archive: "https://x/y.tar.gz".into(),
                        cmd: cmd.into(),
                        args: vec!["acp".into()],
                        env: HashMap::new(),
                        sha256: None,
                    },
                )])),
                npx: None,
                uvx: None,
            },
        }
    }

    fn npx_agent(id: &str) -> RegistryAgent {
        let mut a = binary_agent(id, "./x");
        a.distribution = Distribution {
            binary: None,
            npx: Some(PackageTarget {
                package: format!("{id}@1.0.0"),
                args: vec!["--acp".into()],
                env: HashMap::new(),
            }),
            uvx: None,
        };
        a
    }

    fn ids(candidates: &[ProbeCandidate]) -> Vec<&str> {
        candidates.iter().map(|c| c.spec_id.as_str()).collect()
    }

    #[test]
    fn without_a_manifest_the_builtins_are_still_probed() {
        let c = probe_candidates(None);
        // claude-code-ts / codex are npx adapters — nothing to look for.
        assert_eq!(ids(&c), vec!["claude-code-rs", "opencode", "cursor", "kilo"]);
        let cursor = c.iter().find(|c| c.spec_id == "cursor").unwrap();
        assert_eq!(cursor.program, "cursor-agent");
        assert_eq!(cursor.args, vec!["acp"]);
        assert_eq!(cursor.display_name, "Cursor");
    }

    #[test]
    fn manifest_binaries_are_probed_by_their_basename() {
        let m = RegistryManifest {
            version: "1.0.0".into(),
            agents: vec![binary_agent("amp-acp", "./bin/amp-acp")],
        };
        let c = probe_candidates(Some(&m));
        let amp = c.iter().find(|c| c.spec_id == "amp-acp").unwrap();
        assert_eq!(amp.program, "amp-acp");
        assert_eq!(amp.args, vec!["acp"]);
        assert_eq!(amp.help_url.as_deref(), Some("https://example.com/repo"));
    }

    #[test]
    fn node_npx_and_uvx_entries_are_not_installable_things_to_find() {
        let m = RegistryManifest {
            version: "1.0.0".into(),
            agents: vec![binary_agent("node-agent", "node"), npx_agent("npx-agent")],
        };
        let c = probe_candidates(Some(&m));
        assert!(!ids(&c).contains(&"node-agent"));
        assert!(!ids(&c).contains(&"npx-agent"));
    }

    #[test]
    fn a_manifest_entry_that_duplicates_a_builtin_never_doubles_up() {
        // `cursor` in the manifest IS the built-in; `claude-acp` is the adapter
        // claude-code-ts already launches.
        let m = RegistryManifest {
            version: "1.0.0".into(),
            agents: vec![
                binary_agent("cursor", "./cursor-agent"),
                binary_agent("claude-acp", "./claude-agent-acp"),
            ],
        };
        let c = probe_candidates(Some(&m));
        assert_eq!(c.iter().filter(|c| c.spec_id == "cursor").count(), 1);
        assert!(!ids(&c).contains(&"claude-acp"));
        // …and the surviving cursor candidate is the BUILT-IN's, with Atlas's
        // own display name, not the manifest's.
        let cursor = c.iter().find(|c| c.spec_id == "cursor").unwrap();
        assert_eq!(cursor.display_name, "Cursor");
    }
}
