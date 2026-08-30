//! The slash commands Atlas Agent advertises, and what they do.
//!
//! # Why this file exists
//!
//! The composer's picker renders whatever the connected agent published, and
//! the seam published nothing — so the native agent's list was empty while
//! every external agent had one. That is the whole bug: the app has had the
//! mechanism all along (`SessionUpdate::AvailableCommandsUpdate`), and nobody
//! sent it anything.
//!
//! # What made the cut
//!
//! The request was "codex's defaults, minus login". Each command lands by what
//! actually executes it:
//!
//! - **Protocol calls** — `/compact` (`thread/compact/start`), `/undo`
//!   (`thread/rollback`), `/goal` (`thread/goal/*`), `/review`
//!   (`review/start`, inline on this thread and on this thread's own model —
//!   `review_model` is deliberately left unset in our engine config, and the
//!   engine falls back to the parent thread's model, which the gateway
//!   serves).
//! - **A canned prompt** — `/init`: a normal turn whose text the user did not
//!   have to write.
//! - **Frontend replies** — `/diff` and `/status` answer from this side
//!   without a model turn, exactly as the upstream TUI answered them.
//! - **Skills** — whatever `skills/list` discovered for this session's cwd
//!   (user and repo scope only: the engine's bundled system skills lean on
//!   upstream services the gateway does not serve). Each runs as a turn whose
//!   input is `UserInput::Skill`.
//! - **Commands whose better surface Atlas already has** stay out of this
//!   module: `/login`/`/logout` (signing into Atlas IS signing into the agent,
//!   D10), `/model` and `/approvals` (the composer's pickers), `/new` (tabs),
//!   `/mention` (`@`). The composer synthesizes `/fork` and `/queue` itself —
//!   they drive Atlas affordances (a new tab; the send queue), not the engine.
//!
//! Everything advertised is executed; nothing is advertised that would arrive
//! as prose the engine ignores.

use std::path::PathBuf;

use agent_client_protocol::schema::v1 as acp;

/// What a slash command resolves to.
///
/// Several kinds, because there are several ways of doing things: a **protocol
/// call** (compaction, rollback, goals, review), a **canned prompt** (init — a
/// normal turn whose text the user did not have to write), a **frontend
/// reply** (diff and status answer from this side without a model turn), and a
/// **skill turn** (a turn whose input names a skill the engine discovered on
/// disk).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    /// Summarise the conversation — `thread/compact/start`.
    Compact,
    /// Set up an AGENTS.md for this repository — a canned turn.
    Init,
    /// Show the working tree's uncommitted changes — answered locally.
    Diff,
    /// Show this session's model and working directory — answered locally.
    Status,
    /// Rewind the conversation one exchange — `thread/rollback`.
    Undo,
    /// Set (`Some`) or show (`None`) the session's goal — `thread/goal/*`.
    Goal(Option<String>),
    /// Review changes — `review/start`, inline on this thread. `Some` carries
    /// custom instructions; `None` reviews the uncommitted working tree.
    Review(Option<String>),
    /// Run a discovered skill — a turn whose input is `UserInput::Skill`.
    Skill {
        name: String,
        path: PathBuf,
        args: Option<String>,
    },
}

/// A skill the engine discovered for this session's working directory.
///
/// Held per session (on `EngineSessions`) because skills are scoped to a cwd:
/// two tabs on two repositories advertise two different lists.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillRef {
    pub name: String,
    pub description: String,
    pub path: PathBuf,
}

/// The prompt `/init` runs.
///
/// The upstream CLI's `/init` was exactly this shape: a fixed instruction sent
/// as an ordinary turn. Kept as a turn rather than a protocol call because it
/// *is* agent work — it reads the repo and writes a file, with the usual
/// approval flow around the write.
pub const INIT_PROMPT: &str = "Create an AGENTS.md file for this repository if one does not \
exist, or improve the existing one. Explore the repository first. The file should briefly \
cover: what the project is, how the code is organized, how to build and test it, and any \
conventions a coding agent should follow. Keep it concise and factual — only include what \
you verified from the repository itself.";

/// The commands the composer should offer, skills included.
///
/// The static set first, then this session's discovered skills — each skill a
/// row of its own, exactly how Claude Code's skills reach its picker. A skill
/// whose name collides with a static command is dropped rather than shadowing
/// it: the static set is what the module documents and executes first.
pub fn available(skills: &[SkillRef]) -> Vec<acp::AvailableCommand> {
    let mut commands = vec![
        acp::AvailableCommand::new(
            "compact",
            "Summarise the conversation so far to free up context",
        ),
        acp::AvailableCommand::new("diff", "Show the uncommitted changes in this repository"),
        acp::AvailableCommand::new(
            "goal",
            "Set a goal the agent keeps in view for this session",
        )
        .input(acp::AvailableCommandInput::Unstructured(
            acp::UnstructuredCommandInput::new("objective"),
        )),
        acp::AvailableCommand::new("init", "Create or improve AGENTS.md for this repository"),
        acp::AvailableCommand::new(
            "review",
            "Review the uncommitted changes in this repository",
        ),
        acp::AvailableCommand::new(
            "status",
            "Show this session's model and working directory",
        ),
        acp::AvailableCommand::new("undo", "Rewind the conversation to before your last message"),
    ];
    for skill in skills {
        if commands.iter().any(|c| c.name == skill.name) {
            continue;
        }
        commands.push(acp::AvailableCommand::new(
            skill.name.clone(),
            skill.description.clone(),
        ));
    }
    commands
}

/// The `/diff` reply: `git diff HEAD` in the session's working directory.
///
/// Same command the upstream TUI ran for its `/diff`. Capped, because a
/// mid-refactor tree can produce megabytes and the transcript is not a pager —
/// the cap note says how to see the rest.
pub fn diff_reply(cwd: &str) -> String {
    const CAP: usize = 40_000;
    let output = std::process::Command::new("git")
        .args(["diff", "HEAD"])
        .current_dir(cwd)
        .output();
    let output = match output {
        Ok(output) => output,
        Err(e) => return format!("Could not run git in {cwd}: {e}"),
    };
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        let err = err.trim();
        // The common case is "not a git repository"; git already says it well.
        return if err.is_empty() {
            format!("git diff failed in {cwd}")
        } else {
            format!("git diff failed: {err}")
        };
    }
    let diff = String::from_utf8_lossy(&output.stdout);
    let diff = diff.trim_end();
    if diff.is_empty() {
        return "No uncommitted changes.".to_string();
    }
    let (shown, note) = match diff.char_indices().nth(CAP) {
        Some((cut, _)) => (
            &diff[..cut],
            "\n\n(Truncated — run `git diff HEAD` in a terminal for the rest.)",
        ),
        None => (diff, ""),
    };
    format!("```diff\n{shown}\n```{note}")
}

/// The `/status` reply. Only what this side actually knows — the model the
/// next turn will request and where the session is working — because a status
/// line that guesses is worse than a short one.
pub fn status_reply(model: &str, cwd: &str) -> String {
    format!("**Model:** {model}\n**Directory:** {cwd}")
}

/// The command a prompt is asking for, if it is asking for one.
///
/// Commands that take no input are matched on the whole trimmed prompt:
/// "/compact" is a command, and "/compact this function for me" is a sentence
/// that happens to start with one — treating the second as a command would
/// silently discard what the user actually asked. Commands that DO take input
/// (`/goal`, `/review`, skills) match on the first word, and the rest is the
/// input.
pub fn parse(prompt: &str, skills: &[SkillRef]) -> Option<Command> {
    let trimmed = prompt.trim();
    match trimmed {
        "/compact" => return Some(Command::Compact),
        "/diff" => return Some(Command::Diff),
        "/init" => return Some(Command::Init),
        "/status" => return Some(Command::Status),
        "/undo" => return Some(Command::Undo),
        _ => {}
    }
    let (head, rest) = match trimmed.split_once(char::is_whitespace) {
        Some((head, rest)) => (head, Some(rest.trim())),
        None => (trimmed, None),
    };
    let arg = rest.filter(|r| !r.is_empty()).map(str::to_string);
    match head {
        "/goal" => return Some(Command::Goal(arg)),
        "/review" => return Some(Command::Review(arg)),
        _ => {}
    }
    let name = head.strip_prefix('/')?;
    let skill = skills.iter().find(|s| s.name == name)?;
    Some(Command::Skill {
        name: skill.name.clone(),
        path: skill.path.clone(),
        args: arg,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_list_is_not_empty_which_is_the_bug_this_file_fixes() {
        // The native agent published nothing while every external agent
        // published a list, so its picker was blank.
        assert!(!available(&[]).is_empty());
    }

    #[test]
    fn there_is_no_login_command() {
        // Signing into Atlas is signing into the agent. A login command would
        // be a second, broken way to do something already done.
        assert!(
            !available(&[]).iter().any(|c| c.name.contains("login")),
            "the account's own sign-in is the agent's sign-in (D10)",
        );
    }

    #[test]
    fn every_advertised_command_is_one_we_actually_execute() {
        // The rule that keeps this honest: a command in the picker that the
        // seam does not act on arrives at the engine as prose and is ignored,
        // which looks exactly like the feature being broken.
        let skills = vec![SkillRef {
            name: "release-notes".into(),
            description: "Draft release notes".into(),
            path: PathBuf::from("/tmp/skills/release-notes"),
        }];
        for command in available(&skills) {
            assert!(
                parse(&format!("/{}", command.name), &skills).is_some(),
                "/{} is offered but never executed",
                command.name,
            );
        }
    }

    #[test]
    fn a_command_is_the_whole_prompt_or_it_is_not_a_command() {
        // "/compact this function for me" is a request about compacting code,
        // not a request to compact the conversation. Matching on the prefix
        // would throw the user's actual question away.
        assert_eq!(parse("/compact", &[]), Some(Command::Compact));
        assert_eq!(parse("  /compact  ", &[]), Some(Command::Compact));
        assert_eq!(parse("/init", &[]), Some(Command::Init));
        assert_eq!(parse("/compact this function for me", &[]), None);
        assert_eq!(parse("please compact", &[]), None);
        assert_eq!(parse("", &[]), None);
    }

    #[test]
    fn goal_and_review_split_head_from_input() {
        assert_eq!(parse("/goal", &[]), Some(Command::Goal(None)));
        assert_eq!(
            parse("/goal ship the port by friday", &[]),
            Some(Command::Goal(Some("ship the port by friday".into()))),
        );
        assert_eq!(parse("/review", &[]), Some(Command::Review(None)));
        assert_eq!(
            parse("/review focus on error handling", &[]),
            Some(Command::Review(Some("focus on error handling".into()))),
        );
    }

    #[test]
    fn a_discovered_skill_is_a_command_and_an_unknown_slash_word_is_prose() {
        let skills = vec![SkillRef {
            name: "release-notes".into(),
            description: "Draft release notes".into(),
            path: PathBuf::from("/tmp/skills/release-notes"),
        }];
        assert_eq!(
            parse("/release-notes", &skills),
            Some(Command::Skill {
                name: "release-notes".into(),
                path: PathBuf::from("/tmp/skills/release-notes"),
                args: None,
            }),
        );
        assert_eq!(
            parse("/release-notes for v0.4", &skills),
            Some(Command::Skill {
                name: "release-notes".into(),
                path: PathBuf::from("/tmp/skills/release-notes"),
                args: Some("for v0.4".into()),
            }),
        );
        // Not a skill, not a command → it is what the user typed, sent as-is.
        assert_eq!(parse("/release-notes", &[]), None);
    }

    #[test]
    fn a_skill_shadowing_a_static_command_is_dropped_not_ambiguous() {
        let skills = vec![SkillRef {
            name: "diff".into(),
            description: "A skill that stole a name".into(),
            path: PathBuf::from("/tmp/skills/diff"),
        }];
        let names: Vec<_> = available(&skills).iter().map(|c| c.name.clone()).collect();
        assert_eq!(
            names.iter().filter(|n| n.as_str() == "diff").count(),
            1,
            "one /diff row, and it is the static one: {names:?}",
        );
        // And parsing resolves to the static command, never the skill.
        assert_eq!(parse("/diff", &skills), Some(Command::Diff));
    }

    #[test]
    fn a_diff_outside_a_repository_reports_instead_of_pretending() {
        // The reply is the user's answer, so a failure has to say what
        // happened — an empty message or a fake "no changes" would read as
        // "your tree is clean", which is false.
        let dir = tempfile::tempdir().unwrap();
        let reply = diff_reply(&dir.path().to_string_lossy());
        assert!(
            reply.contains("failed") || reply.contains("Could not run"),
            "a non-repo must produce an error message, got: {reply}",
        );
    }

    #[test]
    fn the_status_reply_carries_the_model_and_the_directory() {
        let reply = status_reply("claude-sonnet-4-6", "/tmp/repo");
        assert!(reply.contains("claude-sonnet-4-6"));
        assert!(reply.contains("/tmp/repo"));
    }

    #[test]
    fn the_init_prompt_asks_for_verified_content_only() {
        // The canned turn is a prompt the user never sees, so its failure mode
        // is invisible: an AGENTS.md full of invented build commands. The
        // instruction to verify against the repo is the guard.
        assert!(INIT_PROMPT.contains("AGENTS.md"));
        assert!(INIT_PROMPT.contains("verified"));
    }
}
