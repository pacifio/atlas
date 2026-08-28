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
//! The request was "codex's defaults, minus login". The upstream menu splits
//! three ways, and each third lands differently here:
//!
//! - **Commands the engine executes** — `/compact` (a protocol call) and
//!   `/init` (a canned turn). Advertised and executed.
//! - **Commands the upstream *frontend* executed itself** — `/diff` and
//!   `/status` never had an engine call behind them; the TUI ran git and read
//!   its own settings. This seam is Atlas's frontend to the engine, so it does
//!   exactly what the TUI did, in the same place the TUI did it. Advertised
//!   and executed.
//! - **Commands whose better surface Atlas already has** — everything else:
//!   - **`/login`, `/logout`** — signing into Atlas *is* signing into the
//!     agent (D10); a login command would be a second, broken way to do
//!     something already done.
//!   - **`/model`, `/approvals`** — the composer's model picker and mode
//!     picker. Same control, better surface.
//!   - **`/new`, `/quit`** — terminal-session management. Atlas has tabs.
//!   - **`/mention`** — the composer's `@` mention flow.
//!   - **`/review`** — real (`review/start`), but it opens a second model
//!     session pinned to hardwired sub-task model names the gateway does not
//!     serve, so today it is an advertised `403 model_not_allowed`. It joins
//!     the list the day the reviewer model is configurable to a catalogue
//!     model.
//!
//! Everything advertised is executed; nothing is advertised that would arrive
//! as prose the engine ignores.

use agent_client_protocol::schema::v1 as acp;

/// What a slash command resolves to.
///
/// Three kinds, because there are three ways of doing things: a **protocol
/// call** (compaction is `thread/compact/start`, not something you say to the
/// model), a **canned prompt** (init is a normal turn whose text the user did
/// not have to write — upstream's CLI implemented it the same way), and a
/// **frontend reply** (diff and status answer from this side without a model
/// turn — upstream's CLI implemented those the same way too).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    /// Summarise the conversation — `thread/compact/start`.
    Compact,
    /// Set up an AGENTS.md for this repository — a canned turn.
    Init,
    /// Show the working tree's uncommitted changes — answered locally.
    Diff,
    /// Show this session's model and working directory — answered locally.
    Status,
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
        acp::AvailableCommand::new("diff", "Show the uncommitted changes in this repository"),
        acp::AvailableCommand::new("init", "Create or improve AGENTS.md for this repository"),
        acp::AvailableCommand::new(
            "status",
            "Show this session's model and working directory",
        ),
    ]
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
/// Matched on the whole trimmed prompt, not a prefix: "/compact" is a command,
/// and "/compact this function for me" is a sentence that happens to start with
/// one. Treating the second as a command would silently discard what the user
/// actually asked.
pub fn command_of(prompt: &str) -> Option<Command> {
    match prompt.trim() {
        "/compact" => Some(Command::Compact),
        "/diff" => Some(Command::Diff),
        "/init" => Some(Command::Init),
        "/status" => Some(Command::Status),
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
