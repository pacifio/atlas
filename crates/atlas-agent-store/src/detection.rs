//! "Detected on your system" — and nothing else.
//!
//! # The invariant
//!
//! **A hit here is never a spawn rung, never a default, and never installs
//! anything.** It is data for one marketplace section, where the user can click
//! Install and get an ordinary `Custom` entry in the installed map. That entry
//! is what makes the agent exist; this module only shortens the typing.
//!
//! Zed has no PATH lookup at all (research §A3: "Resolution ladder (exact — no
//! PATH lookup exists)"). Atlas keeps this much of its old discovery because
//! the affordance is genuinely useful — a user who already has an agent CLI
//! should not have to find its path — but the thing that made the old version
//! wrong was never the probing. It was that a PATH hit *outranked* the user's
//! installed entry at spawn time (`atlas-registry/store.rs:709-725`, deleted
//! with this port). Keeping the data and deleting the ladder is the whole
//! change.
//!
//! Structurally, the invariant holds because nothing here implements
//! `ExternalAgentServer` and nothing here writes settings: a [`DetectedAgent`]
//! can only reach the store by way of a settings entry the user asked for.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use crate::registry::{current_platform_key, RegistryAgent};
use crate::settings::AgentServerSettings;

/// A registry agent that already appears to be installed on this machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetectedAgent {
    /// The registry id, so an install writes the same key the marketplace uses.
    pub id: String,
    pub name: String,
    /// The resolved absolute path of the executable found on `PATH`.
    pub program: PathBuf,
    /// The argv the registry says makes this program speak ACP over stdio.
    pub args: Vec<String>,
}

impl DetectedAgent {
    /// The installed-map entry this becomes if the user accepts it.
    ///
    /// A `Custom` entry, not a `Registry` one: the point of accepting a
    /// detection is to run *the copy the user already has*, which is exactly
    /// what `Custom` means. A `Registry` entry would ignore the find and
    /// download our own.
    pub fn install_entry(&self) -> AgentServerSettings {
        AgentServerSettings::custom(self.program.clone(), self.args.clone())
    }
}

/// Which registry agents are already on `PATH`.
///
/// `path_var` is passed in rather than read from the environment so this is
/// testable without mutating process state.
pub fn detect_on_path(agents: &[RegistryAgent], path_var: Option<&OsStr>) -> Vec<DetectedAgent> {
    let Some(path_var) = path_var else {
        return Vec::new();
    };
    agents
        .iter()
        .filter_map(|agent| detect_one(agent, path_var))
        .collect()
}

/// The same, against the current process's `PATH`.
pub fn detect_on_current_path(agents: &[RegistryAgent]) -> Vec<DetectedAgent> {
    detect_on_path(agents, std::env::var_os("PATH").as_deref())
}

fn detect_one(agent: &RegistryAgent, path_var: &OsStr) -> Option<DetectedAgent> {
    let (program_name, args) = probe_candidate(agent)?;
    let program = find_on_path(&program_name, path_var)?;
    let metadata = agent.metadata();
    Some(DetectedAgent {
        id: metadata.id.as_str().to_string(),
        name: metadata.name.clone(),
        program,
        args,
    })
}

/// The executable name worth looking for, and the args to pass it.
///
/// Skipped, deliberately:
///
/// - **npx distributions.** "Node exists" is not "this agent is installed", and
///   probing for `node` would report every agent as detected.
/// - **binary targets whose `cmd` is `"node"`** — same reason: the executable
///   to find would be `node`.
/// - **targets for other platforms.** Only the current platform's target
///   describes a program that could be running here.
fn probe_candidate(agent: &RegistryAgent) -> Option<(String, Vec<String>)> {
    let RegistryAgent::Binary(binary) = agent else {
        return None;
    };
    let target = binary.targets.get(current_platform_key()?)?;
    if target.cmd == "node" {
        return None;
    }

    let program_name = target
        .cmd
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())?;
    Some((program_name.to_string(), target.args.clone()))
}

/// Resolve a bare executable name against a `PATH`-shaped variable.
///
/// Deliberately dependency-free and deliberately dumb: first match wins, in
/// `PATH` order, exactly like a shell.
pub fn find_on_path(program: &str, path_var: &OsStr) -> Option<PathBuf> {
    if program.is_empty() {
        return None;
    }
    std::env::split_paths(path_var)
        .filter(|dir| !dir.as_os_str().is_empty())
        .flat_map(|dir| {
            executable_names(program)
                .into_iter()
                .map(move |name| dir.join(name))
        })
        .find(|candidate| is_executable_file(candidate))
}

/// On Windows an executable is found by extension; elsewhere the name is the
/// name.
fn executable_names(program: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        if Path::new(program).extension().is_some() {
            return vec![program.to_string()];
        }
        return ["exe", "cmd", "bat"]
            .iter()
            .map(|extension| format!("{program}.{extension}"))
            .collect();
    }
    #[cfg(not(windows))]
    {
        vec![program.to_string()]
    }
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// A convenience for the marketplace: detections keyed by registry id, so a
/// listing can ask "is this one already here?" without a linear scan.
pub fn detected_by_id(detected: Vec<DetectedAgent>) -> HashMap<String, DetectedAgent> {
    detected
        .into_iter()
        .map(|agent| (agent.id.clone(), agent))
        .collect()
}
