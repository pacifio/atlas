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
//! # Two that are deliberately absent
//!
//! - **`/login`.** Signing into Atlas *is* signing into the agent — the
//!   credential is the account's own token (D10), and the engine's own login
//!   surface is switched off. A login command would offer a second, broken way
//!   to do something already done. The ACP adapter filters `/login` out of
//!   external agents' lists for the same reason; this list simply never has one.
//! - **`/review`.** `review/start` is real, but it opens a second model session
//!   pinned to hardwired sub-task model names the gateway does not serve — it
//!   would answer `403 model_not_allowed`. Advertising it would be advertising
//!   a `403`.

use agent_client_protocol::schema::v1 as acp;

/// Compact the conversation.
pub const COMPACT: &str = "compact";

/// The commands the composer should offer.
pub fn available() -> Vec<acp::AvailableCommand> {
    vec![acp::AvailableCommand::new(
        COMPACT,
        "Summarise the conversation so far to free up context",
    )]
}

/// The command a prompt is asking for, if it is asking for one.
///
/// Matched on the whole trimmed prompt, not a prefix: "/compact" is a command,
/// and "/compact this function for me" is a sentence that happens to start with
/// one. Treating the second as a command would silently discard what the user
/// actually asked.
pub fn command_of(prompt: &str) -> Option<&'static str> {
    match prompt.trim() {
        "/compact" => Some(COMPACT),
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
        assert_eq!(command_of("/compact"), Some(COMPACT));
        assert_eq!(command_of("  /compact  "), Some(COMPACT));
        assert_eq!(command_of("/compact this function for me"), None);
        assert_eq!(command_of("please compact"), None);
        assert_eq!(command_of(""), None);
    }
}
