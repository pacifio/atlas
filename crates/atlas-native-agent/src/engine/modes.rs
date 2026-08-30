//! Atlas's four permission modes, expressed to the engine.
//!
//! The modes are Atlas's, not the engine's, and the vocabulary is fixed by what
//! the mode picker already shows — this is a translation, not a redesign
//! (design-language invariant). The four ids also have to keep matching the
//! Cersei path's, because the picker is shared and a mode set on one engine has
//! to mean the same thing on the other.
//!
//! The engine expresses permission as two orthogonal things, and both are
//! needed to say what a mode means:
//!
//! - **`SandboxPolicy`** — what the process is physically allowed to touch.
//! - **`AskForApproval`** — when the engine stops and asks before escalating.
//!
//! Using only one of them is the trap. Sandbox alone cannot express "ask
//! first", and approval alone cannot stop a command that never asks.

use agent_client_protocol::schema::v1 as acp;
// The app-server protocol's own copies, not `codex_protocol`'s. They mirror
// each other, but `thread/settings/update` takes these, and converting at the
// call site would only add a layer that can be got wrong.
use codex_app_server_protocol::AskForApproval;
use codex_app_server_protocol::SandboxPolicy;

/// One of Atlas's modes, in the shape the picker renders.
pub struct AtlasMode {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
}

/// The four modes, in picker order.
///
/// Ids, names and descriptions are copied from the Cersei path verbatim. A
/// difference here would show as the picker changing when the switch flips,
/// which is exactly what "the app cannot tell the engine changed" forbids.
pub const MODES: [AtlasMode; 4] = [
    AtlasMode {
        id: "default",
        name: "Ask",
        description: "Prompt before edits and commands",
    },
    AtlasMode {
        id: "acceptEdits",
        name: "Accept edits",
        description: "Auto-approve file edits; prompt for shell",
    },
    AtlasMode {
        id: "plan",
        name: "Plan",
        description: "Read-only — no edits or commands",
    },
    AtlasMode {
        id: "bypass",
        name: "Bypass",
        description: "Run everything without prompting",
    },
];

pub const DEFAULT_MODE_ID: &str = "default";

/// Normalises a mode id, tolerating another agent's vocabulary.
///
/// Same reason the Cersei path does it: a picker seeded with cross-agent ids
/// can hand us Claude's `bypassPermissions` or Codex's `danger-full-access`.
/// Matching exactly meant "Bypass" silently fell through to prompting on every
/// action — a mode that looks set and does nothing.
fn normalise(mode: &str) -> &'static str {
    let m = mode.to_ascii_lowercase().replace(['-', '_', ' '], "");
    match m.as_str() {
        "bypass" | "bypasspermissions" | "dangerfullaccess" | "fullaccess" | "yolo" => "bypass",
        "plan" | "readonly" | "planmode" => "plan",
        "acceptedits" | "accept" | "autoedit" | "autoedits" | "auto" | "edit" => "acceptEdits",
        // "default" / "ask" / anything unrecognised → prompt. Failing safe
        // means failing *towards* asking the user.
        _ => "default",
    }
}

/// What a mode means to the engine.
///
/// The pairs are chosen so the four modes are actually distinct in behaviour,
/// not just in label:
///
/// - **Ask** — `UnlessTrusted` stops before a command the engine has not been
///   told to trust, which is what "prompt before edits and commands" says.
///   `OnRequest` would not: under a workspace-write sandbox it only asks when
///   something needs to *escalate*, so ordinary commands would run unasked.
/// - **Accept edits** — `OnRequest` plus workspace-write is exactly
///   "edits inside the workspace go through, anything that has to reach
///   outside asks".
/// - **Plan** — read-only *and* `Never`. The sandbox is what makes it
///   read-only; `Never` is what stops the engine offering to escalate out of
///   it, which would turn a read-only mode into a nagging one.
/// - **Bypass** — full access and no prompts. Both halves, or it is not bypass.
pub fn engine_policy(mode: &str) -> (AskForApproval, SandboxPolicy) {
    match normalise(mode) {
        "bypass" => (AskForApproval::Never, SandboxPolicy::DangerFullAccess),
        "plan" => (
            AskForApproval::Never,
            SandboxPolicy::ReadOnly {
                network_access: false,
            },
        ),
        "acceptEdits" => (AskForApproval::OnRequest, workspace_write()),
        _ => (AskForApproval::UnlessTrusted, workspace_write()),
    }
}

/// Write inside the workspace, nothing outside it, no network.
fn workspace_write() -> SandboxPolicy {
    SandboxPolicy::WorkspaceWrite {
        writable_roots: Vec::new(),
        network_access: false,
        exclude_tmpdir_env_var: false,
        exclude_slash_tmp: false,
    }
}

/// The mode list in the protocol's shape.
pub fn mode_state(current: &str) -> acp::SessionModeState {
    acp::SessionModeState::new(
        acp::SessionModeId::new(normalise(current)),
        MODES
            .iter()
            .map(|m| {
                acp::SessionMode::new(acp::SessionModeId::new(m.id), m.name)
                    .description(m.description.to_string())
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn is_read_only(policy: &SandboxPolicy) -> bool {
        matches!(policy, SandboxPolicy::ReadOnly { .. })
    }

    #[test]
    fn the_picker_offers_exactly_the_four_modes_the_cersei_path_does() {
        // The picker is shared. A fifth mode, a missing one, or a renamed one
        // would show as the UI changing when the switch flips.
        let ids: Vec<_> = MODES.iter().map(|m| m.id).collect();
        assert_eq!(ids, ["default", "acceptEdits", "plan", "bypass"]);
        assert_eq!(MODES[0].name, "Ask");
        assert_eq!(MODES[3].name, "Bypass");
    }

    #[test]
    fn plan_mode_cannot_write_and_is_not_asked_to() {
        // Read-only alone would leave the engine offering to escalate out of
        // plan mode, which turns a read-only mode into a nagging one.
        let (approval, sandbox) = engine_policy("plan");
        assert!(is_read_only(&sandbox), "plan mode must not be able to write");
        assert!(matches!(approval, AskForApproval::Never));
    }

    #[test]
    fn bypass_mode_is_both_halves_or_it_is_not_bypass() {
        // Full access with prompts still prompts; no prompts inside a sandbox
        // still blocks. Either half alone fails the mode's own description.
        let (approval, sandbox) = engine_policy("bypass");
        assert!(matches!(sandbox, SandboxPolicy::DangerFullAccess));
        assert!(matches!(approval, AskForApproval::Never));
    }

    #[test]
    fn ask_prompts_more_than_accept_edits_does() {
        // The distinction that makes them two modes rather than one label.
        // `OnRequest` under a workspace-write sandbox only asks when something
        // needs to escalate, so ordinary commands would run unasked — which is
        // "accept edits", not "ask".
        let (ask, _) = engine_policy("default");
        let (accept, _) = engine_policy("acceptEdits");
        assert!(matches!(ask, AskForApproval::UnlessTrusted));
        assert!(matches!(accept, AskForApproval::OnRequest));
        assert!(
            !matches!(ask, AskForApproval::OnRequest),
            "Ask and Accept-edits must differ in behaviour, not just in name",
        );
    }

    #[test]
    fn accept_edits_can_write_the_workspace_without_asking() {
        let (_, sandbox) = engine_policy("acceptEdits");
        assert!(matches!(sandbox, SandboxPolicy::WorkspaceWrite { .. }));
    }

    #[test]
    fn another_agents_mode_vocabulary_still_lands_in_the_right_mode() {
        // The bug this reproduces: matching ids exactly meant "Bypass" arriving
        // as `bypassPermissions` fell through to the default and silently
        // prompted on every action — a mode that looks set and does nothing.
        for alias in ["bypassPermissions", "danger-full-access", "YOLO", "full_access"] {
            let (approval, sandbox) = engine_policy(alias);
            assert!(
                matches!(sandbox, SandboxPolicy::DangerFullAccess)
                    && matches!(approval, AskForApproval::Never),
                "{alias} should be bypass",
            );
        }
        for alias in ["read-only", "planMode", "PLAN"] {
            assert!(is_read_only(&engine_policy(alias).1), "{alias} should be plan");
        }
        for alias in ["auto_edits", "AutoEdit", "accept"] {
            assert!(
                matches!(engine_policy(alias).0, AskForApproval::OnRequest),
                "{alias} should be acceptEdits",
            );
        }
    }

    #[test]
    fn an_unknown_mode_fails_towards_asking_rather_than_towards_running() {
        // The only safe direction for an unrecognised mode.
        let (approval, sandbox) = engine_policy("something-we-have-never-heard-of");
        assert!(matches!(approval, AskForApproval::UnlessTrusted));
        assert!(!matches!(sandbox, SandboxPolicy::DangerFullAccess));
    }

    #[test]
    fn the_mode_state_reports_the_current_mode_normalised() {
        let state = mode_state("bypassPermissions");
        assert_eq!(state.current_mode_id.to_string(), "bypass");
        assert_eq!(state.available_modes.len(), 4);
    }
}
