//! Tool approvals: the engine's requests through Atlas's existing dialog.
//!
//! The vocabulary the ticket names — accept, accept-for-session, decline,
//! cancel — is not something Atlas has to invent here. The engine already
//! speaks exactly it (`FileChangeApprovalDecision`,
//! `CommandExecutionApprovalDecision`), and Atlas's dialog already speaks its
//! own three-option form plus a cancel that comes from the dialog being
//! dismissed rather than from a button. This module is the join.
//!
//! # The asymmetry worth knowing
//!
//! Atlas's dialog offers **three** options and produces a **fourth** outcome.
//! `PermissionOptionKind` has `AllowOnce`, `AllowAlways` and `RejectOnce`;
//! "cancel" is `RequestPermissionOutcome::Cancelled`, which arrives when the
//! turn is interrupted or the dialog is dismissed — never as a selection. So
//! the option list has three entries and the decision mapping has four arms,
//! and that is correct rather than an oversight.
//!
//! # Decline and cancel are not the same answer
//!
//! The engine draws a line Atlas must not blur: *"User denied … The agent will
//! continue the turn"* versus *"User denied … The turn will also be
//! immediately interrupted"*. Collapsing them would either strand a user who
//! dismissed the dialog inside a turn that keeps running, or kill a turn the
//! user only meant to steer away from one action.

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::{PermissionOptions, RequestPermissionOutcome};
use codex_app_server_protocol::CommandExecutionApprovalDecision;
use codex_app_server_protocol::FileChangeApprovalDecision;

/// What the user answered, before it is shaped for a particular request kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Accept,
    AcceptForSession,
    Decline,
    Cancel,
}

/// Option ids Atlas mints for the engine's prompts.
///
/// Internal: the dialog renders from `PermissionOptionKind`, and these only
/// have to round-trip back to us intact.
const ALLOW_ONCE: &str = "allow-once";
const ALLOW_ALWAYS: &str = "allow-always";
const REJECT: &str = "reject";

/// The options Atlas's dialog shows for an engine approval.
pub fn options() -> PermissionOptions {
    PermissionOptions::Flat(vec![
        acp::PermissionOption::new(
            acp::PermissionOptionId::new(ALLOW_ONCE),
            "Allow",
            acp::PermissionOptionKind::AllowOnce,
        ),
        acp::PermissionOption::new(
            acp::PermissionOptionId::new(ALLOW_ALWAYS),
            "Allow for this session",
            acp::PermissionOptionKind::AllowAlways,
        ),
        acp::PermissionOption::new(
            acp::PermissionOptionId::new(REJECT),
            "Decline",
            acp::PermissionOptionKind::RejectOnce,
        ),
    ])
}

/// What the user's answer means to the engine.
///
/// Read from the option's **kind**, not its id. The id is ours and could be
/// anything; the kind is what the dialog rendered and what the user actually
/// pressed, so it is the honest source. An unrecognised selection declines —
/// the only safe direction, since the alternative is running something the
/// user did not clearly approve.
pub fn decision_for(outcome: &RequestPermissionOutcome) -> Decision {
    match outcome {
        // Dismissed, or the turn went away underneath it. Not a decline: the
        // user did not answer, and the engine's `Cancel` is the arm that says
        // "stop the turn too".
        RequestPermissionOutcome::Cancelled
        | RequestPermissionOutcome::InterruptedByFollowUp => Decision::Cancel,
        RequestPermissionOutcome::Selected(selected) => match selected.option_kind {
            acp::PermissionOptionKind::AllowOnce => Decision::Accept,
            acp::PermissionOptionKind::AllowAlways => Decision::AcceptForSession,
            acp::PermissionOptionKind::RejectOnce
            | acp::PermissionOptionKind::RejectAlways => Decision::Decline,
            _ => Decision::Decline,
        },
    }
}

impl Decision {
    pub fn for_command(self) -> CommandExecutionApprovalDecision {
        match self {
            Self::Accept => CommandExecutionApprovalDecision::Accept,
            Self::AcceptForSession => CommandExecutionApprovalDecision::AcceptForSession,
            Self::Decline => CommandExecutionApprovalDecision::Decline,
            Self::Cancel => CommandExecutionApprovalDecision::Cancel,
        }
    }

    pub fn for_file_change(self) -> FileChangeApprovalDecision {
        match self {
            Self::Accept => FileChangeApprovalDecision::Accept,
            Self::AcceptForSession => FileChangeApprovalDecision::AcceptForSession,
            Self::Decline => FileChangeApprovalDecision::Decline,
            Self::Cancel => FileChangeApprovalDecision::Cancel,
        }
    }
}

/// The tool call the dialog describes, in the shape the thread wants.
///
/// `title` is what the user reads when deciding, so a command approval shows
/// the command. Falling back to the reason, and then to a generic line, keeps
/// the dialog from ever rendering an empty prompt — a permission dialog with
/// nothing in it is one a user cannot answer responsibly.
pub fn tool_call(
    item_id: &str,
    kind: acp::ToolKind,
    title: Option<String>,
    reason: Option<String>,
) -> acp::ToolCallUpdate {
    let title = title
        .filter(|t| !t.trim().is_empty())
        .or_else(|| reason.clone().filter(|r| !r.trim().is_empty()))
        .unwrap_or_else(|| "The agent is asking for permission".to_string());

    let mut fields = acp::ToolCallUpdateFields::default();
    fields.title = Some(title);
    fields.kind = Some(kind);
    acp::ToolCallUpdate::new(acp::ToolCallId::new(item_id), fields)
}

#[cfg(test)]
mod tests {
    use super::*;
    use atlas_acp_thread::SelectedPermissionOutcome;

    fn selected(kind: acp::PermissionOptionKind, id: &str) -> RequestPermissionOutcome {
        RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
            acp::PermissionOptionId::new(id),
            kind,
        ))
    }

    #[test]
    fn the_dialog_offers_allow_allow_for_session_and_decline() {
        let PermissionOptions::Flat(options) = options() else {
            panic!("the engine's prompts are a flat option list");
        };
        let kinds: Vec<_> = options.iter().map(|o| o.kind).collect();
        assert_eq!(
            kinds,
            [
                acp::PermissionOptionKind::AllowOnce,
                acp::PermissionOptionKind::AllowAlways,
                acp::PermissionOptionKind::RejectOnce,
            ],
        );
    }

    #[test]
    fn each_of_the_four_answers_maps_to_its_own_engine_decision() {
        // The vocabulary the ticket names, end to end.
        assert_eq!(
            decision_for(&selected(acp::PermissionOptionKind::AllowOnce, ALLOW_ONCE)),
            Decision::Accept,
        );
        assert_eq!(
            decision_for(&selected(acp::PermissionOptionKind::AllowAlways, ALLOW_ALWAYS)),
            Decision::AcceptForSession,
        );
        assert_eq!(
            decision_for(&selected(acp::PermissionOptionKind::RejectOnce, REJECT)),
            Decision::Decline,
        );
        assert_eq!(
            decision_for(&RequestPermissionOutcome::Cancelled),
            Decision::Cancel,
        );
    }

    #[test]
    fn declining_and_cancelling_are_different_answers() {
        // The engine's own distinction: a decline lets the turn continue, a
        // cancel interrupts it. Collapsing them either strands a user who
        // dismissed the dialog inside a running turn, or kills a turn they
        // only meant to steer away from one action.
        let decline = decision_for(&selected(acp::PermissionOptionKind::RejectOnce, REJECT));
        let cancel = decision_for(&RequestPermissionOutcome::Cancelled);
        assert_ne!(decline, cancel);
        assert_eq!(decline.for_command(), CommandExecutionApprovalDecision::Decline);
        assert_eq!(cancel.for_command(), CommandExecutionApprovalDecision::Cancel);
        assert_eq!(decline.for_file_change(), FileChangeApprovalDecision::Decline);
        assert_eq!(cancel.for_file_change(), FileChangeApprovalDecision::Cancel);
    }

    #[test]
    fn an_interrupted_prompt_cancels_rather_than_declining() {
        // The turn went away underneath the dialog. Answering "decline" would
        // tell the engine to carry on with a turn that is already over.
        assert_eq!(
            decision_for(&RequestPermissionOutcome::InterruptedByFollowUp),
            Decision::Cancel,
        );
    }

    #[test]
    fn the_answer_is_read_from_the_kind_the_user_pressed_not_from_our_id() {
        // The id is ours to choose; the kind is what the dialog rendered. If
        // these ever disagree, the button the user actually saw wins.
        assert_eq!(
            decision_for(&selected(acp::PermissionOptionKind::AllowOnce, "something-else")),
            Decision::Accept,
        );
    }

    #[test]
    fn a_prompt_with_nothing_to_say_still_says_something() {
        // A permission dialog rendering an empty title is one a user cannot
        // answer responsibly.
        let call = tool_call("item-1", acp::ToolKind::Execute, None, None);
        assert!(call.fields.title.is_some_and(|t| !t.trim().is_empty()));

        let blank = tool_call("item-1", acp::ToolKind::Execute, Some("   ".into()), None);
        assert_eq!(
            blank.fields.title.as_deref(),
            Some("The agent is asking for permission"),
        );
    }

    #[test]
    fn the_command_is_what_the_user_reads_when_there_is_one() {
        let call = tool_call(
            "item-1",
            acp::ToolKind::Execute,
            Some("rm -rf /tmp/scratch".into()),
            Some("needs write access".into()),
        );
        assert_eq!(call.fields.title.as_deref(), Some("rm -rf /tmp/scratch"));
    }

    #[test]
    fn the_reason_carries_the_prompt_when_there_is_no_command() {
        let call = tool_call(
            "item-1",
            acp::ToolKind::Edit,
            None,
            Some("needs write access outside the workspace".into()),
        );
        assert_eq!(
            call.fields.title.as_deref(),
            Some("needs write access outside the workspace"),
        );
    }
}
