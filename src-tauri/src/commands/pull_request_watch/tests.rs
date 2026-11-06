//! The watch's decisions, ported case for case from the reference app's
//! `pullRequestWatch.test.ts`, then the wake text, read planning and the
//! settle rule.

use std::collections::HashSet;
use std::path::PathBuf;

use atlas_thread_metadata::{
    PathList, PullRequestLink, PullRequestLinkSource, PullRequestSnapshot, PullRequestWatch,
    ThreadId, ThreadMetadata,
};
use chrono::{DateTime, Duration, Utc};

use super::*;
use crate::commands::pull_requests::{PrActor, PrCheck, PrCheckStatus, PrComment, PrCommentKind};

const STARTED: &str = "2026-10-02T12:00:00Z";

fn at(rfc: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(rfc)
        .unwrap()
        .with_timezone(&Utc)
}

fn watch() -> PullRequestWatch {
    PullRequestWatch {
        started_at: at(STARTED),
        head_sha: None,
        failed_checks: vec![],
        passed: false,
        passed_checks: vec![],
        remarks_through: STARTED.into(),
        remark_ids: vec![],
        conflicting: false,
        wakes: 0,
    }
}

fn check(name: &str, status: PrCheckStatus) -> PrCheck {
    PrCheck {
        name: name.into(),
        status,
        description: None,
        url: Some(format!("https://ci.example/{name}")),
        required: None,
        workflow: None,
        started_at: None,
        completed_at: None,
        duration_ms: None,
    }
}

fn required(name: &str, status: PrCheckStatus) -> PrCheck {
    PrCheck {
        required: Some(true),
        ..check(name, status)
    }
}

/// An owned stand-in for a read pull request; `state()` borrows it.
#[derive(Clone)]
struct Detail {
    head_sha: Option<String>,
    checks: Vec<PrCheck>,
    mergeability: PrMergeability,
    viewer: Option<String>,
    author: Option<String>,
}

impl Detail {
    fn state(&self) -> WatchedState<'_> {
        WatchedState {
            head_sha: self.head_sha.as_deref(),
            checks: &self.checks,
            mergeability: self.mergeability,
            viewer: self.viewer.as_deref(),
            author: self.author.as_deref(),
        }
    }
}

fn detail() -> Detail {
    Detail {
        head_sha: Some("aaaaaaaaaa".into()),
        checks: vec![
            check("lint", PrCheckStatus::Success),
            check("test", PrCheckStatus::Pending),
        ],
        mergeability: PrMergeability::Mergeable,
        viewer: Some("agent-user".into()),
        author: Some("agent-user".into()),
    }
}

fn with_checks(checks: Vec<PrCheck>) -> Detail {
    Detail { checks, ..detail() }
}

fn remark(login: &str, created_at: &str, body: &str) -> PrComment {
    PrComment {
        id: format!("{login}-{created_at}"),
        kind: PrCommentKind::ReviewComment,
        author: Some(PrActor {
            login: login.into(),
            name: None,
            avatar_url: None,
            is_bot: false,
        }),
        body: body.into(),
        created_at: created_at.into(),
        edited_at: None,
        url: Some(format!("https://github.com/o/r/pull/1#{login}")),
        path: Some("src/index.ts".into()),
        review_state: None,
        reactions: vec![],
        can_edit: false,
        can_delete: false,
    }
}

fn rename(login: &str, created_at: &str) -> PrComment {
    remark(login, created_at, "Please rename this.")
}

const NO_REMARKS: Option<&[PrComment]> = Some(&[]);

fn eval(w: &PullRequestWatch, d: &Detail, remarks: Option<&[PrComment]>) -> WatchReport {
    evaluate(w, &d.state(), remarks)
}

#[test]
fn reports_each_failure_at_once_even_while_another_check_never_finishes() {
    let bot = check("CodeRabbit", PrCheckStatus::Pending);
    let first = with_checks(vec![
        check("lint", PrCheckStatus::Failure),
        check("test", PrCheckStatus::Pending),
        bot.clone(),
    ]);
    let lint = eval(&watch(), &first, NO_REMARKS);
    assert_eq!(
        lint.changes,
        vec![WatchChange::ChecksFailed(vec![check(
            "lint",
            PrCheckStatus::Failure
        )])]
    );
    assert!(eval(&lint.next, &first, NO_REMARKS).changes.is_empty());

    let second = with_checks(vec![
        check("lint", PrCheckStatus::Failure),
        check("test", PrCheckStatus::Failure),
        bot,
    ]);
    let test = eval(&lint.next, &second, NO_REMARKS);
    assert_eq!(
        test.changes,
        vec![WatchChange::ChecksFailed(vec![check(
            "test",
            PrCheckStatus::Failure
        )])]
    );

    let rerun = eval(&test.next, &first, NO_REMARKS);
    assert_eq!(eval(&rerun.next, &second, NO_REMARKS).changes.len(), 1);

    let pushed = Detail {
        head_sha: Some("bbbbbbbbbb".into()),
        ..second
    };
    assert_eq!(eval(&test.next, &pushed, NO_REMARKS).changes.len(), 1);
}

#[test]
fn reports_passed_once_the_required_checks_pass_whatever_the_others_do() {
    let green = with_checks(vec![
        required("test", PrCheckStatus::Success),
        required("lint", PrCheckStatus::Success),
        check("bot", PrCheckStatus::Pending),
    ]);
    let passed = eval(&watch(), &green, NO_REMARKS);
    assert_eq!(
        passed.changes,
        vec![WatchChange::ChecksPassed {
            count: 2,
            required: true
        }]
    );
    assert!(eval(&passed.next, &green, NO_REMARKS).changes.is_empty());

    let plain = with_checks(vec![
        check("test", PrCheckStatus::Success),
        check("bot", PrCheckStatus::Pending),
    ]);
    assert!(eval(&watch(), &plain, NO_REMARKS).changes.is_empty());
}

#[test]
fn reports_passed_again_when_a_required_check_shows_up_already_passed() {
    let tests = with_checks(vec![
        required("Tests", PrCheckStatus::Success),
        check("Smoke Tests", PrCheckStatus::Pending),
    ]);
    let first = eval(&watch(), &tests, NO_REMARKS);
    assert_eq!(
        first.changes,
        vec![WatchChange::ChecksPassed {
            count: 1,
            required: true
        }]
    );

    let gated = with_checks(vec![
        required("Tests", PrCheckStatus::Success),
        check("Smoke Tests", PrCheckStatus::Success),
        required("Smoke Tests Gate", PrCheckStatus::Success),
    ]);
    let second = eval(&first.next, &gated, NO_REMARKS);
    assert_eq!(
        second.changes,
        vec![WatchChange::ChecksPassed {
            count: 2,
            required: true
        }]
    );
    assert!(eval(&second.next, &gated, NO_REMARKS).changes.is_empty());

    let pending = with_checks(vec![
        required("Tests", PrCheckStatus::Success),
        required("Smoke Tests Gate", PrCheckStatus::Pending),
    ]);
    let waiting = eval(&first.next, &pending, NO_REMARKS);
    assert!(waiting.changes.is_empty());
    assert_eq!(
        eval(&waiting.next, &gated, NO_REMARKS).changes,
        vec![WatchChange::ChecksPassed {
            count: 2,
            required: true
        }]
    );
}

/// A watch that burned the rate limit re-reporting advisory bots.
#[test]
fn does_not_report_passed_again_for_a_new_passed_check_where_none_is_required() {
    let first = eval(
        &watch(),
        &with_checks(vec![check("test", PrCheckStatus::Success)]),
        NO_REMARKS,
    );
    assert_eq!(
        first.changes,
        vec![WatchChange::ChecksPassed {
            count: 1,
            required: false
        }]
    );
    let both = with_checks(vec![
        check("test", PrCheckStatus::Success),
        check("lint", PrCheckStatus::Success),
    ]);
    assert!(eval(&first.next, &both, NO_REMARKS).changes.is_empty());
}

#[test]
fn does_not_wake_a_watch_saved_before_passed_checks_were_recorded() {
    let green = with_checks(vec![required("test", PrCheckStatus::Success)]);
    let told = PullRequestWatch {
        head_sha: Some("aaaaaaaaaa".into()),
        passed: true,
        ..watch()
    };
    let saved = eval(&told, &green, NO_REMARKS);
    assert!(saved.changes.is_empty());
    assert_eq!(saved.next.passed_checks, vec!["test".to_string()]);
}

#[test]
fn keeps_remarks_for_a_later_pass_when_the_conversation_was_not_read_whole() {
    let comments = vec![rename("reviewer", "2026-10-02T12:06:00Z")];
    let partial = eval(&watch(), &detail(), None);
    assert!(partial.changes.is_empty());
    assert!(matches!(
        eval(&partial.next, &detail(), Some(&comments))
            .changes
            .first(),
        Some(WatchChange::Remarks(_))
    ));
}

#[test]
fn reports_a_remark_that_shows_up_late_with_the_same_time_as_a_reported_one() {
    let first = rename("reviewer", "2026-10-02T12:06:00Z");
    let late = PrComment {
        id: "late".into(),
        ..rename("bot", "2026-10-02T12:06:00Z")
    };
    let reported = eval(&watch(), &detail(), Some(std::slice::from_ref(&first)));
    let again = eval(
        &reported.next,
        &detail(),
        Some(&[first.clone(), late.clone()]),
    );
    assert_eq!(again.changes, vec![WatchChange::Remarks(vec![late])]);
    assert_eq!(again.next.remark_ids, vec![first.id, "late".to_string()]);
}

#[test]
fn reports_edits_after_the_watermark_once_and_counts_them_toward_the_wake_limit() {
    let old = rename("greptile[bot]", "2026-10-02T11:00:00Z");
    let watching = PullRequestWatch {
        head_sha: Some("aaaaaaaaaa".into()),
        remark_ids: vec![old.id.clone()],
        wakes: WAKE_LIMIT - 1,
        ..watch()
    };
    assert!(eval(&watching, &detail(), Some(std::slice::from_ref(&old)))
        .changes
        .is_empty());
    let edited = PrComment {
        edited_at: Some("2026-10-02T12:06:00Z".into()),
        ..old.clone()
    };
    let report = eval(&watching, &detail(), Some(std::slice::from_ref(&edited)));
    assert_eq!(
        report.changes,
        vec![WatchChange::Remarks(vec![edited.clone()])]
    );
    assert_eq!(report.next.remarks_through, "2026-10-02T12:06:00Z");
    assert_eq!(report.next.remark_ids, vec![old.id]);
    assert!(report.exhausted);
    assert!(
        eval(&report.next, &detail(), Some(std::slice::from_ref(&edited)))
            .changes
            .is_empty()
    );
    let late = PrComment {
        id: "late".into(),
        ..edited.clone()
    };
    assert_eq!(
        eval(&report.next, &detail(), Some(&[edited, late.clone()])).changes,
        vec![WatchChange::Remarks(vec![late])]
    );
}

#[test]
fn does_not_treat_a_failed_check_read_as_a_rerun() {
    let failed = with_checks(vec![check("lint", PrCheckStatus::Failure)]);
    let reported = eval(&watch(), &failed, NO_REMARKS);
    assert_eq!(reported.changes.len(), 1);
    let unreadable = eval(&reported.next, &with_checks(vec![]), NO_REMARKS);
    assert!(eval(&unreadable.next, &failed, NO_REMARKS)
        .changes
        .is_empty());
}

#[test]
fn wakes_for_the_pull_request_s_author_when_the_agent_is_someone_else() {
    let contributor = Detail {
        author: Some("contributor".into()),
        ..detail()
    };
    let reply = rename("contributor", "2026-10-02T12:06:00Z");
    assert_eq!(
        eval(&watch(), &contributor, Some(std::slice::from_ref(&reply))).changes,
        vec![WatchChange::Remarks(vec![reply.clone()])]
    );
    let no_viewer = Detail {
        viewer: None,
        ..contributor
    };
    assert!(eval(&watch(), &no_viewer, Some(&[reply]))
        .changes
        .is_empty());
}

#[test]
fn reports_remarks_from_others_once_and_never_the_agent_s_own() {
    let comments = vec![
        remark(
            "agent-user",
            "2026-10-02T12:05:00Z",
            "Fixed in the latest push.",
        ),
        rename("macroscope-app[bot]", "2026-10-02T12:06:00Z"),
        remark("reviewer", "2026-10-02T11:00:00Z", "Older than the watch."),
    ];
    let report = eval(&watch(), &detail(), Some(&comments));
    assert_eq!(
        report.changes,
        vec![WatchChange::Remarks(vec![comments[1].clone()])]
    );
    assert_eq!(report.next.remarks_through, "2026-10-02T12:06:00Z");
    assert!(eval(&report.next, &detail(), Some(&comments))
        .changes
        .is_empty());
}

#[test]
fn reports_a_conflict_once_until_the_branch_is_clean_again() {
    let conflicting = Detail {
        mergeability: PrMergeability::Conflicting,
        ..detail()
    };
    let first = eval(&watch(), &conflicting, NO_REMARKS);
    assert_eq!(first.changes, vec![WatchChange::Conflicting]);
    let recomputing = eval(
        &first.next,
        &Detail {
            mergeability: PrMergeability::Unknown,
            ..detail()
        },
        NO_REMARKS,
    );
    assert!(eval(&recomputing.next, &conflicting, NO_REMARKS)
        .changes
        .is_empty());
    let clean = eval(&first.next, &detail(), NO_REMARKS);
    assert_eq!(
        eval(&clean.next, &conflicting, NO_REMARKS).changes,
        vec![WatchChange::Conflicting]
    );
}

#[test]
fn does_not_spend_the_comment_wake_limit_on_check_results() {
    let tired = PullRequestWatch {
        head_sha: Some("aaaaaaaaaa".into()),
        wakes: WAKE_LIMIT - 1,
        ..watch()
    };
    let result = eval(
        &tired,
        &with_checks(vec![check("lint", PrCheckStatus::Failure)]),
        NO_REMARKS,
    );
    assert!(!result.exhausted);
    assert_eq!(result.next.wakes, 0);
}

#[test]
fn stops_after_the_wake_limit_unless_the_head_moves() {
    let comments = vec![rename("reviewer", "2026-10-02T12:10:00Z")];
    let tired = PullRequestWatch {
        head_sha: Some("aaaaaaaaaa".into()),
        wakes: WAKE_LIMIT - 1,
        ..watch()
    };
    assert!(eval(&tired, &detail(), Some(&comments)).exhausted);
    let pushed = eval(
        &tired,
        &Detail {
            head_sha: Some("cccccccccc".into()),
            ..detail()
        },
        Some(&comments),
    );
    assert!(!pushed.exhausted);
    assert_eq!(pushed.next.wakes, 1);
}

// ── the wake's words ────────────────────────────────────────────────────

#[test]
fn a_wake_lists_what_changed_and_says_how_to_hand_back() {
    let report = eval(
        &watch(),
        &Detail {
            mergeability: PrMergeability::Conflicting,
            ..with_checks(vec![
                check("lint", PrCheckStatus::Failure),
                check("e2e", PrCheckStatus::Cancelled),
            ])
        },
        Some(&[remark(
            "reviewer",
            "2026-10-02T12:06:00Z",
            "<!-- bot state -->Please   rename\nthis.",
        )]),
    );
    let wake = message(
        12,
        "https://github.com/o/r/pull/12",
        "main",
        Some("aaaaaaaaaa"),
        &report,
    );
    assert!(wake.text.starts_with(
        "Update on pull request #12 (https://github.com/o/r/pull/12), which Atlas is watching for you:"
    ));
    assert!(wake.text.contains("- Checks failed on aaaaaaa:"));
    assert!(wake.text.contains("  - lint https://ci.example/lint"));
    assert!(wake
        .text
        .contains("  - e2e (cancelled) https://ci.example/e2e"));
    assert!(wake
        .text
        .contains("  - reviewer on src/index.ts: \"Please rename this.\""));
    assert!(wake.text.contains("- The branch now conflicts with main."));
    assert!(wake.text.contains("call unwatch_pull_request first"));
    assert!(!wake.text.contains("thread"));
    assert_eq!(
        wake.summary,
        "#12: checks failed, new comments, merge conflict"
    );
    assert_eq!(wake.outcome, WakeOutcomeKind::Failed);
}

#[test]
fn a_long_list_is_cut_at_ten_and_a_long_comment_at_two_hundred_characters() {
    let failed: Vec<PrCheck> = (0..12)
        .map(|i| check(&format!("job-{i}"), PrCheckStatus::Failure))
        .collect();
    let report = eval(&watch(), &with_checks(failed), NO_REMARKS);
    let wake = message(1, "u", "main", None, &report);
    assert!(wake.text.contains("  - and 2 more"));
    assert!(!wake.text.contains("job-10"));
    let long = snippet(&"word ".repeat(100));
    assert_eq!(long.chars().count(), 200);
    assert!(long.ends_with("..."));
}

#[test]
fn passing_alone_reads_as_completed_and_the_limit_says_it_stopped() {
    let passed = eval(
        &watch(),
        &with_checks(vec![check("test", PrCheckStatus::Success)]),
        NO_REMARKS,
    );
    let wake = message(3, "u", "main", Some("abc"), &passed);
    assert_eq!(wake.outcome, WakeOutcomeKind::Completed);
    assert!(wake.text.contains("- All 1 check passed on abc."));

    let tired = PullRequestWatch {
        head_sha: Some("aaaaaaaaaa".into()),
        wakes: WAKE_LIMIT - 1,
        ..watch()
    };
    let report = eval(
        &tired,
        &detail(),
        Some(&[rename("reviewer", "2026-10-02T12:10:00Z")]),
    );
    let wake = message(3, "u", "main", None, &report);
    assert!(wake.text.contains("Atlas stopped watching after 10"));
    assert_eq!(wake.summary, "#3: new comments, stopped watching");
    assert_eq!(wake.outcome, WakeOutcomeKind::Updated);
}

// ── read planning ───────────────────────────────────────────────────────

#[test]
fn a_pull_request_is_read_only_when_it_might_have_news() {
    let watches: HashSet<String> = ["w1".to_string()].into();
    let now = 1_000_000_000;
    assert!(plan_read(&watches, "open", None, now), "never read");
    let last = LastRead {
        at: now - 60_000,
        fingerprint: "open".into(),
        in_flight: false,
        remarks_complete: true,
        watches: watches.clone(),
    };
    assert!(!plan_read(&watches, "open", Some(&last), now), "quiet");
    assert!(
        plan_read(&watches, "open passing", Some(&last), now),
        "moved"
    );
    let more: HashSet<String> = ["w1".to_string(), "w2".to_string()].into();
    assert!(plan_read(&more, "open", Some(&last), now), "a new watch");
    assert!(plan_read(
        &watches,
        "open",
        Some(&LastRead {
            in_flight: true,
            ..last.clone()
        }),
        now
    ));
    assert!(plan_read(
        &watches,
        "open",
        Some(&LastRead {
            remarks_complete: false,
            ..last.clone()
        }),
        now
    ));
    assert!(plan_read(
        &watches,
        "open",
        Some(&last),
        last.at + QUIET_REREAD_MS
    ));
}

// ── settle on merge ─────────────────────────────────────────────────────

fn session(interacted: &str) -> ThreadMetadata {
    let mut thread = ThreadMetadata::new(
        ThreadId::new(),
        "some-agent".into(),
        PathList::new(&[PathBuf::from("/work/app")]),
    );
    thread.session_id = Some(agent_client_protocol::schema::v1::SessionId::new("s1"));
    thread.created_at = Some(at("2026-10-01T00:00:00Z"));
    thread.interacted_at = Some(at(interacted));
    thread
}

fn linked(number: u32, linked_at: &str, state: Option<(&str, &str)>) -> PullRequestLink {
    let mut link = PullRequestLink::new(
        "acme/shop",
        number,
        format!("https://github.com/acme/shop/pull/{number}"),
        PullRequestLinkSource::Agent,
    );
    link.linked_at = at(linked_at);
    link.snapshot = state.map(|(state, updated)| PullRequestSnapshot {
        state: state.into(),
        title: "t".into(),
        head_branch: "f".into(),
        base_branch: "main".into(),
        is_draft: false,
        updated_at: Some(updated.into()),
        merged_at: None,
        checks_state: None,
        review_decision: None,
        comment_count: None,
        synced_at: Utc::now(),
    });
    link
}

fn merged_at(mut link: PullRequestLink, merged: &str) -> PullRequestLink {
    if let Some(s) = link.snapshot.as_mut() {
        s.merged_at = Some(merged.into());
    }
    link
}

#[test]
fn a_merge_is_dated_by_its_merge_time_not_a_later_update() {
    // Merged before the user spoke again, then touched after (a label, a
    // branch deleted): the merge time says it does not settle.
    let mut thread = session("2026-10-02T12:00:00Z");
    thread.pull_requests = vec![merged_at(
        linked(
            1,
            "2026-10-02T09:00:00Z",
            Some(("merged", "2026-10-02T13:00:00Z")),
        ),
        "2026-10-02T11:00:00Z",
    )];
    assert!(!settles(&thread, true));

    // Merged after the user's last word, whatever the update time says.
    let mut thread = session("2026-10-02T10:00:00Z");
    thread.pull_requests = vec![merged_at(
        linked(
            1,
            "2026-10-02T09:00:00Z",
            Some(("merged", "2026-10-02T13:00:00Z")),
        ),
        "2026-10-02T11:00:00Z",
    )];
    assert!(settles(&thread, true));
}

#[test]
fn a_watch_read_keeps_the_merge_time_on_the_snapshot() {
    let read = WatchedPr {
        state: PrState::Merged,
        title: "t".into(),
        head_branch: "f".into(),
        base_branch: "main".into(),
        is_draft: false,
        updated_at: "2026-10-02T13:00:00Z".into(),
        merged_at: Some("2026-10-02T11:00:00Z".into()),
        checks_state: None,
        review_decision: None,
        head_sha: None,
        checks: vec![],
        mergeability: PrMergeability::Unknown,
        viewer: None,
        author: None,
    };
    let snapshot = snapshot_of_detail(&read, None);
    assert_eq!(snapshot.merged_at.as_deref(), Some("2026-10-02T11:00:00Z"));
    assert_eq!(snapshot.done_at(), Some("2026-10-02T11:00:00Z"));

    let open = WatchedPr {
        state: PrState::Open,
        merged_at: None,
        ..read
    };
    assert_eq!(snapshot_of_detail(&open, None).merged_at, None);
}

#[test]
fn a_merge_time_before_the_link_means_the_link_records_finished_work() {
    // Linked at 10:00, merged at 09:00, updated at 11:00: by the update time
    // it would look merged after linking and settle the session.
    let mut thread = session("2026-10-02T08:00:00Z");
    thread.pull_requests = vec![merged_at(
        linked(
            1,
            "2026-10-02T10:00:00Z",
            Some(("merged", "2026-10-02T11:00:00Z")),
        ),
        "2026-10-02T09:00:00Z",
    )];
    assert!(!settles(&thread, true));
}

#[test]
fn a_merge_after_the_user_s_last_word_settles_the_session() {
    let mut thread = session("2026-10-02T10:00:00Z");
    thread.pull_requests = vec![linked(
        1,
        "2026-10-02T09:00:00Z",
        Some(("merged", "2026-10-02T11:00:00Z")),
    )];
    assert!(settles(&thread, true));
    assert!(!settles(&thread, false), "settle on merge off");
}

#[test]
fn a_merge_before_the_user_spoke_again_does_not() {
    let mut thread = session("2026-10-02T12:00:00Z");
    thread.pull_requests = vec![linked(
        1,
        "2026-10-02T09:00:00Z",
        Some(("merged", "2026-10-02T11:00:00Z")),
    )];
    assert!(!settles(&thread, true));
}

#[test]
fn a_close_settles_even_with_settle_on_merge_off() {
    let mut thread = session("2026-10-02T10:00:00Z");
    thread.pull_requests = vec![linked(
        1,
        "2026-10-02T09:00:00Z",
        Some(("closed", "2026-10-02T11:00:00Z")),
    )];
    assert!(settles(&thread, false));
}

#[test]
fn an_open_or_unread_pull_request_holds_the_session() {
    let mut thread = session("2026-10-02T10:00:00Z");
    let merged = linked(
        1,
        "2026-10-02T09:00:00Z",
        Some(("merged", "2026-10-02T11:00:00Z")),
    );
    thread.pull_requests = vec![
        merged.clone(),
        linked(
            2,
            "2026-10-02T09:00:00Z",
            Some(("open", "2026-10-02T11:00:00Z")),
        ),
    ];
    assert!(!settles(&thread, true));
    thread.pull_requests = vec![merged, linked(3, "2026-10-02T09:00:00Z", None)];
    assert!(!settles(&thread, true));
}

#[test]
fn a_pull_request_linked_after_it_was_done_neither_holds_nor_settles() {
    let mut thread = session("2026-10-02T08:00:00Z");
    // The agent merged it as asked, then linked it.
    thread.pull_requests = vec![linked(
        1,
        "2026-10-02T12:00:00Z",
        Some(("merged", "2026-10-02T11:00:00Z")),
    )];
    assert!(!settles(&thread, true));
}

#[test]
fn a_settled_pinned_or_snoozed_session_is_left_alone() {
    let mut thread = session("2026-10-02T10:00:00Z");
    thread.pull_requests = vec![linked(
        1,
        "2026-10-02T09:00:00Z",
        Some(("closed", "2026-10-02T11:00:00Z")),
    )];
    let mut pinned = thread.clone();
    pinned.pinned_at = Some(Utc::now());
    assert!(!settles(&pinned, true));
    let mut snoozed = thread.clone();
    snoozed.snoozed_until = Some(Utc::now() + Duration::hours(1));
    assert!(!settles(&snoozed, true));
    let mut settled = thread;
    settled.settled_at = Some(Utc::now());
    assert!(!settles(&settled, true));
}
