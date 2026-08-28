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
//! # Why the list is short
//!
//! It is not a translation of the upstream CLI's menu. Those were a *terminal
//! frontend's* commands, and most of them do things Atlas already does with a
//! button — switching model, switching mode, signing in. Publishing them would
//! give the user two ways to do the same thing, one of which is worse.
//!
//! What is here is what the engine exposes as a real protocol call **and**
//! Atlas has no better affordance for. Everything advertised is executed;
//! nothing is advertised that would arrive as prose the engine ignores.
//!
//! # The upstream CLI's menu, item by item
//!
//! The request was "codex's defaults, minus login" — so here is where each one
//! went, because most of them were never *agent* commands at all:
//!
//! - **`/login`, `/logout`** — signing into Atlas *is* signing into the agent:
//!   the credential is the account's own token (D10) and the engine's login
//!   surface is off. A login command would be a second, broken way to do
//!   something already done.
//! - **`/model`, `/approvals`** — the composer's model picker and mode picker.
//!   Same control, better surface; a command duplicating a visible button is
//!   two ways to do one thing.
//! - **`/new`, `/quit`** — terminal-session management. Atlas has tabs.
//! - **`/diff`, `/status`, `/mention`** — TUI display features with no engine
//!   call behind them; the engine cannot execute them, so advertising them
//!   would put rows in the picker that arrive as prose and do nothing.
//! - **`/review`** — real (`review/start`), but it opens a second model session
//!   pinned to hardwired sub-task model names the gateway does not serve, so
//!   today it is an advertised `403 model_not_allowed`. It joins the list the
//!   day the reviewer model is configurable to a catalogue model.
//! - **`/compact`, `/init`** — the two with a real execution path, below.

use agent_client_protocol::schema::v1 as acp;

/// What a slash command resolves to.
///
/// Two kinds, because the engine has two ways of doing things: a **protocol
/// call** (compaction is `thread/compact/start`, not something you say to the
/// model) and a **canned prompt** (init is a normal turn whose text the user
/// did not have to write — upstream's CLI implemented it the same way).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    /// Summarise the conversation — `thread/compact/start`.
    Compact,
    /// Set up an AGENTS.md for this repository — a canned turn.
    Init,
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

/// The commands the composer should offer.
pub fn available() -> Vec<acp::AvailableCommand> {
    vec![
        acp::AvailableCommand::new(
            "compact",
            "Summarise the conversation so far to free up context",
        ),
        acp::AvailableCommand::new("init", "Create or improve AGENTS.md for this repository"),
    ]
}

/// The command a prompt is asking for, if it is asking for one.
///
/// Matched on the whole trimmed prompt, not a prefix: "/compact" is a command,
/// and "/compact this function for me" is a sentence that happens to start with
/// one. Treating the second as a command would silently discard what the user
/// actually asked.
pub fn command_of(prompt: &str) -> Option<Command> {
    match prompt.trim() {
        "/compact" => Some(Command::Compact),
        "/init" => Some(Command::Init),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_list_is_not_empty_which_is_the_bug_this_file_fixes() {
        // The native agent published nothing while every external agent
        // published a list, so its picker was blank.
        assert!(!available().is_empty());
    }

    #[test]
    fn there_is_no_login_command() {
        // Signing into Atlas is signing into the agent. A login command would
        // be a second, broken way to do something already done.
        assert!(
            !available().iter().any(|c| c.name.contains("login")),
            "the account's own sign-in is the agent's sign-in (D10)",
        );
    }

    #[test]
    fn every_advertised_command_is_one_we_actually_execute() {
        // The rule that keeps this honest: a command in the picker that the
        // seam does not act on arrives at the engine as prose and is ignored,
        // which looks exactly like the feature being broken.
        for command in available() {
            assert!(
                command_of(&format!("/{}", command.name)).is_some(),
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
        assert_eq!(command_of("/compact"), Some(Command::Compact));
        assert_eq!(command_of("  /compact  "), Some(Command::Compact));
        assert_eq!(command_of("/init"), Some(Command::Init));
        assert_eq!(command_of("/compact this function for me"), None);
        assert_eq!(command_of("please compact"), None);
        assert_eq!(command_of(""), None);
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
