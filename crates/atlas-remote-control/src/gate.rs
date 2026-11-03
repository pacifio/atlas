//! The desktop's half of the command gate (§10, §11.1): what the host checks
//! about a relayed command before it reaches the steering entry.
//!
//! Defence in depth — the relay already checked tier, driver and epoch, and
//! the desktop checks them again from its own view of the roster, because
//! neither side trusts the other (design review D6). Pure, so every rule is a
//! unit test.
//!
//! # The seat (R4)
//!
//! Exactly one *person* prompts at a time: the Driver. Steering — `submit`,
//! `set_mode`, `set_model`, `set_config_option`, `answer_elicitation`,
//! `answer_permission` — is the Driver's alone, **the owner included**: an
//! owner who handed the seat to Ada is refused `not_driver` from their phone
//! until they take it back (the app's steering entry refuses the owner's local
//! composer the same way). The owner's master powers are never seat-gated:
//! `stop` is the kill switch and always runs for the owner; kick, take-over
//! and close are control frames, not commands, and never reach this gate.
//!
//! # Widening (§11.1 gate 13)
//!
//! Nothing remote may widen what the agent does on the owner's machine
//! without asking. A bypass-style mode ([`WIDENING_MODE_WORDS`]) is refused
//! `widening` for **every** remote principal, the owner included: the
//! desktop's own picker is the one place such a mode is chosen (Claude Code's
//! own rule for its remote surface, and plan §5.4). A config option is
//! agent-defined, and some are sandbox or approval switches: for a Driver
//! who is not the owner, a key naming one ([`WIDENING_OPTION_WORDS`]) is
//! refused here, and the app — the side that holds the advertised option —
//! then allows only the categories a member may set (thinking level, model
//! and model configuration) and refuses the rest. A standing (`AllowAlways`)
//! permission grant is likewise the app's to refuse, since it knows the
//! option's kind.

use std::collections::{HashSet, VecDeque};

use crate::wire::{
    Capability, Command, CommandKind, Gate, HostCommand, PrincipalKind, Tier, WIDENING_MODE_WORDS,
};
use crate::{RC_COMMAND_VALUE_MAX_BYTES, RC_PROMPT_MAX};

/// How many `(from, commandId)` pairs a room remembers, so a repeat is a no-op.
pub const RECENT_COMMANDS: usize = 256;

/// Why the desktop refused a command: the gate, a stable code, and words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub gate: Gate,
    pub code: String,
    pub message: String,
}

impl Refusal {
    pub fn new(gate: Gate, message: impl Into<String>) -> Self {
        Self {
            gate,
            code: gate.as_str().to_owned(),
            message: message.into(),
        }
    }

    /// A refusal whose `code` says more than its gate does.
    pub fn with_code(gate: Gate, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            gate,
            code: code.into(),
            message: message.into(),
        }
    }
}

/// The last [`RECENT_COMMANDS`] `(from, commandId)` pairs, oldest evicted first.
#[derive(Debug, Default)]
pub struct RecentCommands {
    order: VecDeque<(String, String)>,
    seen: HashSet<(String, String)>,
}

impl RecentCommands {
    /// Record a command. `false` when it was already seen — a repeat, and a
    /// no-op.
    pub fn first_time(&mut self, from: &str, command_id: &str) -> bool {
        let key = (from.to_owned(), command_id.to_owned());
        if self.seen.contains(&key) {
            return false;
        }
        if self.order.len() == RECENT_COMMANDS {
            if let Some(old) = self.order.pop_front() {
                self.seen.remove(&old);
            }
        }
        self.order.push_back(key.clone());
        self.seen.insert(key);
        true
    }
}

/// What the host knows when a command arrives.
#[derive(Debug, Clone)]
pub struct GateView<'a> {
    /// The room owner's user id (from the create door).
    pub owner_user_id: &'a str,
    /// The driver epoch from the last `rc.welcome` / `rc.roster`.
    pub driver_epoch: u64,
    /// The driver's principal id from the same frame.
    pub driver_id: &'a str,
    /// What this desktop advertised.
    pub capabilities: &'a [Capability],
}

/// Words that mark a config option key as a sandbox, approval or trust
/// switch rather than a knob — one a Driver who is not the owner may not
/// touch, whatever category the agent gave it. Matched on the key,
/// case-insensitively. The app's category check is the second layer: a key
/// that passes here still has to be a thinking-level, model or
/// model-configuration option to be set by a member.
pub const WIDENING_OPTION_WORDS: &[&str] = &[
    "permission",
    "approve",
    "approval",
    "sandbox",
    "bypass",
    "network",
    "trust",
    "yolo",
    "danger",
];

/// Check a relayed command against the desktop's gates, in order: epoch,
/// seat, who the principal is, capability, widening, size. `Ok` means it may
/// go to the steering entry.
pub fn check(view: &GateView<'_>, command: &HostCommand) -> Result<(), Refusal> {
    let from = command.from.id.as_str();
    let is_owner = from == view.owner_user_id;
    let is_driver = from == view.driver_id;
    let kind = command.command.kind();

    if command.driver_epoch != view.driver_epoch {
        return Err(Refusal::new(
            Gate::EpochStale,
            format!("the driver changed; the epoch is {}", view.driver_epoch),
        ));
    }
    // The relay admits a link visitor or a guest to `steer` at most; what
    // needs `steer_approve` (consent for an action on this machine) or a
    // signed-in member (`RC_MEMBERS_ONLY_COMMANDS`) is checked again here
    // from the principal's kind, which the object stamped — a relay bug or a
    // forged tier must not be the only thing between a link and an approval.
    if command.from.kind != PrincipalKind::User
        && (kind.min_tier() == Tier::SteerApprove || kind.members_only())
    {
        return Err(Refusal::with_code(
            Gate::Tier,
            "members_only",
            format!("only a signed-in member may {}", kind.as_str()),
        ));
    }
    // `stop` is the owner's master power and the driver's steering; everything
    // else is the driver's alone, the owner included.
    let seated = if kind == CommandKind::Stop {
        is_owner || is_driver
    } else {
        is_driver
    };
    if !seated {
        return Err(if is_owner {
            Refusal::with_code(
                Gate::NotDriver,
                "not_driver",
                "someone else is driving; take over to steer",
            )
        } else {
            Refusal::new(Gate::NotDriver, "only the driver may steer")
        });
    }
    if !view.capabilities.contains(&kind.capability()) {
        return Err(Refusal::with_code(
            Gate::Tier,
            "capability",
            format!("this desktop does not take {} from a remote", kind.as_str()),
        ));
    }
    match &command.command {
        // Every remote origin, the owner included: see the module doc.
        Command::SetMode { mode_id } if mode_widens(mode_id) => {
            return Err(Refusal::new(
                Gate::Widening,
                "that mode lets the agent act without asking; choose it on the desktop",
            ));
        }
        Command::SetConfigOption { key, .. } if !is_owner && option_widens(key) => {
            return Err(Refusal::new(
                Gate::Widening,
                "only the owner may change this session's options",
            ));
        }
        _ => {}
    }
    size(&command.command)
}

/// Whether a mode id names a mode that widens what the agent may do.
pub fn mode_widens(mode_id: &str) -> bool {
    let id = mode_id.to_ascii_lowercase();
    WIDENING_MODE_WORDS.iter().any(|word| id.contains(word))
}

/// Whether a config option key names a switch a non-owner may not touch.
pub fn option_widens(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    WIDENING_OPTION_WORDS.iter().any(|word| key.contains(word))
}

fn size(command: &Command) -> Result<(), Refusal> {
    let too_big = |what: &str, max: usize| {
        Err(Refusal::with_code(
            Gate::Tier,
            "payload_too_large",
            format!("{what} is at most {max} bytes"),
        ))
    };
    match command {
        Command::Submit { content, .. } if content.len() > RC_PROMPT_MAX => {
            too_big("a prompt", RC_PROMPT_MAX)
        }
        Command::Submit { content, .. } if content.trim().is_empty() => Err(Refusal::with_code(
            Gate::Tier,
            "empty",
            "a prompt needs some text",
        )),
        Command::AnswerElicitation { answer: value, .. }
        | Command::SetConfigOption { value, .. }
            if serde_json::to_vec(value).map_or(0, |v| v.len()) > RC_COMMAND_VALUE_MAX_BYTES =>
        {
            too_big("a value", RC_COMMAND_VALUE_MAX_BYTES)
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{PrincipalKind, PrincipalRef};

    const ALL: &[Capability] = Capability::ALL;

    fn view() -> GateView<'static> {
        GateView {
            owner_user_id: "user_owner",
            driver_epoch: 1,
            driver_id: "user_owner",
            capabilities: ALL,
        }
    }

    fn from(id: &str, epoch: u64, command: Command) -> HostCommand {
        HostCommand {
            command_id: "01JB8Z5G7Q2W3E4R5T6Y7V8X9Z".into(),
            driver_epoch: epoch,
            from: PrincipalRef {
                id: id.into(),
                kind: PrincipalKind::User,
                name: None,
            },
            command,
        }
    }

    fn gate_of(r: Result<(), Refusal>) -> Option<Gate> {
        r.err().map(|e| e.gate)
    }

    #[test]
    fn the_owner_steers_and_answers() {
        let v = view();
        for command in [
            Command::Submit {
                content: "go".into(),
                client_message_id: None,
            },
            Command::Stop,
            Command::AnswerPermission {
                request_id: "r".into(),
                option_id: "allow_once".into(),
            },
            Command::SetMode {
                mode_id: "plan".into(),
            },
            Command::SetModel {
                model_id: "m".into(),
            },
            // The owner's options are not key-gated: a sandbox switch is
            // theirs to flip, agent-scoped rather than machine-scoped.
            Command::SetConfigOption {
                key: "sandbox_mode".into(),
                value: serde_json::json!(1),
            },
        ] {
            assert_eq!(check(&v, &from("user_owner", 1, command)), Ok(()));
        }
    }

    /// A bypass-style mode is the desktop picker's alone: no remote origin,
    /// the owner included, may choose it (plan §5.4; Claude Code's own rule).
    #[test]
    fn a_widening_mode_is_refused_from_every_remote_origin() {
        let owner = view();
        let member = GateView {
            driver_id: "user_member",
            ..view()
        };
        for mode_id in [
            "bypassPermissions",
            "full-access",
            "YOLO",
            "danger-full-access",
            "unrestricted",
            "auto",
        ] {
            let refusal = check(
                &owner,
                &from(
                    "user_owner",
                    1,
                    Command::SetMode {
                        mode_id: mode_id.into(),
                    },
                ),
            )
            .unwrap_err();
            assert_eq!(refusal.gate, Gate::Widening, "{mode_id} for the owner");
            assert!(refusal.message.contains("desktop"), "{}", refusal.message);
            let refusal = check(
                &member,
                &from(
                    "user_member",
                    1,
                    Command::SetMode {
                        mode_id: mode_id.into(),
                    },
                ),
            )
            .unwrap_err();
            assert_eq!(refusal.gate, Gate::Widening, "{mode_id} for a member");
        }
        for mode_id in ["plan", "default", "acceptEdits", "read-only"] {
            assert!(!mode_widens(mode_id), "{mode_id}");
            let plain = Command::SetMode {
                mode_id: mode_id.into(),
            };
            assert_eq!(check(&owner, &from("user_owner", 1, plain)), Ok(()));
        }
    }

    /// A member Driver may set a knob whose key is not a sandbox / approval /
    /// trust switch — the app then checks the agent's category; a key naming
    /// such a switch is refused here, whatever the agent calls it.
    #[test]
    fn a_member_may_set_a_plain_option_key_but_not_a_widening_one() {
        let v = GateView {
            driver_id: "user_member",
            ..view()
        };
        for key in [
            "thought_level",
            "thinking",
            "model",
            "effort",
            "reasoning_effort",
        ] {
            assert!(!option_widens(key), "{key}");
            let option = Command::SetConfigOption {
                key: key.into(),
                value: serde_json::json!("high"),
            };
            assert_eq!(check(&v, &from("user_member", 1, option)), Ok(()), "{key}");
        }
        for key in [
            "permission_mode",
            "autoApprove",
            "sandbox",
            "bypassPermissions",
            "network_access",
            "trust_workspace",
            "yolo",
            "dangerously_skip",
        ] {
            assert!(option_widens(key), "{key}");
            let option = Command::SetConfigOption {
                key: key.into(),
                value: serde_json::json!(true),
            };
            assert_eq!(
                gate_of(check(&v, &from("user_member", 1, option))),
                Some(Gate::Widening),
                "{key}"
            );
        }
    }

    /// The one denylist both sides share, by example: what it must refuse,
    /// what it must pass, and the id it is known not to catch.
    #[test]
    fn the_widening_words_catch_the_bypass_modes_agents_ship() {
        for id in [
            "bypassPermissions",
            "full-access",
            "yolo",
            "dangerously-skip-permissions",
            "auto-edit",
            "trusted",
            "skip_permissions",
            "unsafe",
            "allow-always",
            "UNRESTRICTED",
        ] {
            assert!(mode_widens(id), "{id} must be refused");
        }
        for id in ["default", "plan", "acceptEdits", "read-only", "ask"] {
            assert!(!mode_widens(id), "{id} must pass");
        }
        // Known gap: a mode id that names none of the words passes. Codex's
        // `acceptAll` is one — "accept" is not on the list because
        // `acceptEdits` must pass. A denylist on the id cannot tell the two
        // apart; the agent's own description is not consulted.
        assert!(!mode_widens("acceptAll"), "documented gap, not a guarantee");
    }

    /// A link visitor or a guest may be admitted to `steer` by the relay,
    /// never to an approval or a config option: the desktop checks the
    /// principal's kind itself.
    #[test]
    fn a_link_or_guest_driver_may_steer_but_not_approve_or_configure() {
        for kind in [PrincipalKind::Link, PrincipalKind::Guest] {
            let v = GateView {
                driver_id: "guest_1",
                ..view()
            };
            let as_guest = |command: Command| HostCommand {
                from: PrincipalRef {
                    id: "guest_1".into(),
                    kind,
                    name: Some("Visitor".into()),
                },
                ..from("guest_1", 1, command)
            };
            assert_eq!(check(&v, &as_guest(submit())), Ok(()), "{kind:?} steers");
            assert_eq!(check(&v, &as_guest(Command::Stop)), Ok(()));
            assert_eq!(
                check(
                    &v,
                    &as_guest(Command::SetMode {
                        mode_id: "plan".into()
                    })
                ),
                Ok(())
            );
            for command in [
                Command::AnswerPermission {
                    request_id: "r".into(),
                    option_id: "allow_once".into(),
                },
                Command::AnswerElicitation {
                    request_id: "r".into(),
                    answer: serde_json::json!({ "action": "accept" }),
                },
                Command::SetConfigOption {
                    key: "thought_level".into(),
                    value: serde_json::json!("high"),
                },
            ] {
                let refusal = check(&v, &as_guest(command)).unwrap_err();
                assert_eq!(refusal.gate, Gate::Tier, "{kind:?}");
                assert_eq!(refusal.code, "members_only");
            }
        }
    }

    #[test]
    fn a_stale_epoch_is_refused_before_anything_else() {
        let r = check(&view(), &from("user_owner", 2, Command::Stop));
        assert_eq!(gate_of(r), Some(Gate::EpochStale));
    }

    #[test]
    fn someone_who_is_not_the_driver_cannot_steer() {
        let r = check(&view(), &from("user_member", 1, Command::Stop));
        assert_eq!(gate_of(r), Some(Gate::NotDriver));
        let r = check(&view(), &from("user_member", 1, submit()));
        assert_eq!(gate_of(r), Some(Gate::NotDriver));
    }

    fn submit() -> Command {
        Command::Submit {
            content: "go".into(),
            client_message_id: None,
        }
    }

    #[test]
    fn the_owner_cannot_prompt_while_someone_else_drives_but_can_stop() {
        let v = GateView {
            driver_id: "user_member",
            ..view()
        };
        for command in [
            submit(),
            Command::SetMode {
                mode_id: "plan".into(),
            },
            Command::SetModel {
                model_id: "m".into(),
            },
            Command::SetConfigOption {
                key: "k".into(),
                value: serde_json::json!(1),
            },
            Command::AnswerElicitation {
                request_id: "r".into(),
                answer: serde_json::json!({ "action": "accept" }),
            },
            Command::AnswerPermission {
                request_id: "r".into(),
                option_id: "allow_once".into(),
            },
        ] {
            let refusal = check(&v, &from("user_owner", 1, command)).unwrap_err();
            assert_eq!(refusal.gate, Gate::NotDriver);
            assert!(refusal.message.contains("take over"), "{}", refusal.message);
        }
        assert_eq!(check(&v, &from("user_owner", 1, Command::Stop)), Ok(()));
    }

    #[test]
    fn the_driver_steers_and_answers_but_may_not_widen() {
        let v = GateView {
            driver_id: "user_member",
            ..view()
        };
        assert_eq!(check(&v, &from("user_member", 1, submit())), Ok(()));
        assert_eq!(check(&v, &from("user_member", 1, Command::Stop)), Ok(()));
        let answer = Command::AnswerPermission {
            request_id: "r".into(),
            option_id: "o".into(),
        };
        assert_eq!(check(&v, &from("user_member", 1, answer)), Ok(()));
        let plan = Command::SetMode {
            mode_id: "plan".into(),
        };
        assert_eq!(check(&v, &from("user_member", 1, plan)), Ok(()));
        let bypass = Command::SetMode {
            mode_id: "bypassPermissions".into(),
        };
        assert_eq!(
            gate_of(check(&v, &from("user_member", 1, bypass))),
            Some(Gate::Widening)
        );
        let option = Command::SetConfigOption {
            key: "approval_policy".into(),
            value: serde_json::json!(1),
        };
        assert_eq!(
            gate_of(check(&v, &from("user_member", 1, option))),
            Some(Gate::Widening)
        );
    }

    #[test]
    fn a_kind_the_desktop_did_not_advertise_is_refused() {
        let v = GateView {
            capabilities: &[Capability::Steer],
            ..view()
        };
        let mode = Command::SetMode {
            mode_id: "plan".into(),
        };
        assert_eq!(
            gate_of(check(&v, &from("user_owner", 1, mode))),
            Some(Gate::Tier)
        );
    }

    #[test]
    fn an_oversized_prompt_is_refused() {
        let big = Command::Submit {
            content: "x".repeat(RC_PROMPT_MAX + 1),
            client_message_id: None,
        };
        assert_eq!(
            gate_of(check(&view(), &from("user_owner", 1, big))),
            Some(Gate::Tier)
        );
    }

    #[test]
    fn a_repeat_is_remembered_and_old_ones_age_out() {
        let mut recent = RecentCommands::default();
        assert!(recent.first_time("a", "1"));
        assert!(!recent.first_time("a", "1"));
        // The same id from someone else is another command.
        assert!(recent.first_time("b", "1"));
        for n in 0..RECENT_COMMANDS {
            recent.first_time("c", &n.to_string());
        }
        assert!(recent.first_time("a", "1"), "evicted, so new again");
    }
}
