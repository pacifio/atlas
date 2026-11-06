use std::collections::HashSet;

use serde_json::{json, Value};

use super::*;

/// A real answer, recorded from a public repository with the documents in
/// `queries.rs` and trimmed to its `data`.
fn fixture(name: &str) -> Value {
    let raw = match name {
        "detail-merged" => include_str!("../fixtures/detail-merged.json"),
        "detail-draft" => include_str!("../fixtures/detail-draft.json"),
        "check-contexts" => include_str!("../fixtures/check-contexts.json"),
        "activity" => include_str!("../fixtures/activity.json"),
        "review-threads" => include_str!("../fixtures/review-threads.json"),
        "thread-comments" => include_str!("../fixtures/thread-comments.json"),
        "subject" => include_str!("../fixtures/subject.json"),
        "timeline" => include_str!("../fixtures/timeline.json"),
        "timeline-labels" => include_str!("../fixtures/timeline-labels.json"),
        "commits" => include_str!("../fixtures/commits.json"),
        "search" => include_str!("../fixtures/search.json"),
        "files-viewed" => include_str!("../fixtures/files-viewed.json"),
        "files.rest" => include_str!("../fixtures/files.rest.json"),
        "pull.rest" => include_str!("../fixtures/pull.rest.json"),
        "activity-own" => include_str!("../fixtures/activity-own.json"),
        "review-threads-own" => include_str!("../fixtures/review-threads-own.json"),
        "merge-message" => include_str!("../fixtures/merge-message.json"),
        "workflow-head" => include_str!("../fixtures/workflow-head.json"),
        "pull-request-heads" => include_str!("../fixtures/pull-request-heads.json"),
        "actions-runs" => include_str!("../fixtures/actions-runs.json"),
        other => panic!("no fixture {other}"),
    };
    serde_json::from_str(raw).unwrap()
}

// ── recorded answers ────────────────────────────────────────────────────

#[test]
fn a_merged_pull_request_reads_whole() {
    let detail = to_detail(&fixture("detail-merged"), "cli/cli").unwrap();
    assert_eq!(detail.number, 14752);
    assert_eq!(detail.state, PrState::Merged);
    assert!(!detail.is_draft);
    assert_eq!(detail.review_decision, Some(PrReviewDecision::Approved));
    assert_eq!(detail.commit_count, 8);
    assert_eq!(detail.checks.len(), 11);
    assert_eq!(detail.checks_state, Some(PrChecksState::Passing));
    assert!(!detail.checks_truncated);
    // A closed pull request has no base comparison worth showing.
    assert_eq!(detail.base_comparison, PrBaseComparison::Unknown);
    assert_eq!(detail.behind_by, None);
    // Read access: comment and review, nothing that writes.
    assert!(!detail.viewer_permissions.can_merge);
    assert!(!detail.viewer_permissions.request_reviewers);
    assert!(detail.viewer_permissions.comment);
    assert_eq!(detail.viewer.as_deref(), Some("uzayer"));
    assert!(detail.head_sha.as_deref().is_some_and(is_commit_sha));
    assert!(detail
        .reviewers
        .iter()
        .any(|r| r.state == PrReviewerState::Requested));
}

#[test]
fn an_open_draft_reads_its_labels_and_how_far_behind_it_is() {
    let detail = to_detail(&fixture("detail-draft"), "cli/cli").unwrap();
    assert_eq!(detail.state, PrState::Open);
    assert!(detail.is_draft);
    assert_eq!(detail.mergeability, PrMergeability::Mergeable);
    assert_eq!(detail.merge_state_status.as_deref(), Some("BLOCKED"));
    assert_eq!(detail.base_comparison, PrBaseComparison::Behind);
    assert_eq!(detail.behind_by, Some(11));
    let labels: Vec<&str> = detail.labels.iter().map(|l| l.name.as_str()).collect();
    assert_eq!(labels, ["needs-triage", "external"]);
    // Twenty skipped and one success is a pass.
    assert_eq!(detail.checks_state, Some(PrChecksState::Passing));
    let names: HashSet<&str> = detail.checks.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names.len(), detail.checks.len(), "check names are unique");
}

#[test]
fn a_page_of_check_contexts_names_its_head() {
    let (head, contexts, next) = to_check_contexts_page(&fixture("check-contexts")).unwrap();
    assert!(is_commit_sha(&head));
    assert_eq!(contexts.len(), 21);
    assert_eq!(next, None);
}

#[test]
fn activity_keeps_reviews_with_words_or_a_verdict() {
    let page = to_activity_page(&fixture("activity")).unwrap();
    assert_eq!(
        page.author.as_ref().map(|a| a.login.as_str()),
        Some("babakks")
    );
    assert_eq!(page.commits.len(), 8);
    // Three commented reviews with a body and one bodiless approval; the
    // bodiless "commented" reviews are line-comment containers.
    assert_eq!(page.remarks.len(), 4);
    assert!(page
        .remarks
        .iter()
        .any(|r| r.review_state.as_deref() == Some("APPROVED") && r.body.is_empty()));
    assert!(page
        .remarks
        .windows(2)
        .all(|w| w[0].created_at <= w[1].created_at));
}

#[test]
fn review_threads_read_with_their_reviewers_and_commits() {
    let page = to_review_thread_page(&fixture("review-threads")).unwrap();
    assert_eq!(page.threads.len(), 5);
    assert_eq!(page.threads.iter().filter(|t| t.is_resolved).count(), 4);
    let first = &page.threads[0];
    assert_eq!(first.side, PrDiffSide::Right);
    assert_eq!(first.comment_count, 2);
    assert_eq!(first.can_resolve, Some(false));
    let reviewers: Vec<&str> = page.reviewers.iter().map(|r| r.login.as_str()).collect();
    assert_eq!(
        reviewers,
        ["williammartin", "copilot-pull-request-reviewer"]
    );
    assert_eq!(page.commits.len(), 8);
    assert!(page.commits.iter().all(|c| c.additions.is_some()));
    assert!(page.reactions.is_empty(), "groups nobody chose are dropped");
}

#[test]
fn activity_and_threads_merge_into_one_conversation() {
    let activity = to_activity_page(&fixture("activity")).unwrap();
    let mut page = to_review_thread_page(&fixture("review-threads")).unwrap();
    let threads = std::mem::take(&mut page.threads);
    let merged = merge_activity(
        activity.author,
        activity.commits,
        activity.remarks,
        threads,
        page,
        false,
    );
    let line_comments = merged
        .comments
        .iter()
        .filter(|c| c.kind == PrCommentKind::ReviewComment)
        .count();
    assert_eq!(line_comments, 10);
    assert_eq!(merged.comment_count, 4 + 10);
    assert!(!merged.comments_truncated);
    assert!(merged
        .comments
        .windows(2)
        .all(|w| w[0].created_at <= w[1].created_at));
}

#[test]
fn a_thread_page_says_whether_it_belongs_to_the_pull_request() {
    let data = fixture("thread-comments");
    let (belongs, page) = to_thread_comments_page(&data);
    assert!(belongs);
    assert_eq!(page.comments.len(), 2);
    let mut foreign = data;
    foreign["repository"]["pullRequest"]["id"] = json!("PR_other");
    assert!(!to_thread_comments_page(&foreign).0);
}

#[test]
fn a_subject_is_checked_against_the_pull_request() {
    let data = fixture("subject");
    assert!(is_subject_of_pull_request(&data));
    let mut foreign = data;
    foreign["repository"]["pullRequest"]["id"] = json!("PR_other");
    assert!(!is_subject_of_pull_request(&foreign));
    assert!(!is_subject_of_pull_request(
        &json!({ "repository": null, "node": null })
    ));
}

#[test]
fn the_timeline_opens_with_the_pull_request_itself() {
    let page = to_timeline_page(&fixture("timeline"), true).unwrap();
    assert_eq!(page.items.len(), 35);
    assert!(matches!(page.items[0], PrTimelineItem::Opened { .. }));
    let force_pushes = page
        .items
        .iter()
        .filter(|i| matches!(i, PrTimelineItem::ForcePushed { .. }))
        .count();
    assert_eq!(force_pushes, 13);
    assert!(page.items.iter().any(|i| matches!(
        i,
        PrTimelineItem::Merged {
            commit_oid: Some(_),
            ..
        }
    )));
    assert_eq!(page.next_cursor, None);
    let later = to_timeline_page(&fixture("timeline"), false).unwrap();
    assert_eq!(later.items.len(), 34);
}

#[test]
fn the_timeline_reads_labels_added_and_taken_off() {
    let page = to_timeline_page(&fixture("timeline-labels"), true).unwrap();
    let labeled: Vec<_> = page
        .items
        .iter()
        .filter_map(|i| match i {
            PrTimelineItem::Labeled { label, actor, .. } => Some((label, actor)),
            _ => None,
        })
        .collect();
    assert_eq!(labeled.len(), 3);
    assert_eq!(
        labeled[0].0,
        &PrLabel {
            name: "external".into(),
            color: Some("2700AF".into())
        }
    );
    assert!(labeled[0].1.as_ref().is_some_and(|a| a.is_bot));
    let unlabeled: Vec<_> = page
        .items
        .iter()
        .filter_map(|i| match i {
            PrTimelineItem::Unlabeled { label, .. } => Some(label.name.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(unlabeled, ["needs-triage"]);
}

/// An item type asked for but not read would arrive and vanish; one read
/// but not asked for would never arrive.
#[test]
fn the_timeline_reads_every_item_type_it_asks_for() {
    let doc = super::super::queries::PULL_REQUEST_TIMELINE;
    let list = doc
        .split("itemTypes: [")
        .nth(1)
        .and_then(|rest| rest.split(']').next())
        .unwrap();
    let asked: Vec<String> = list
        .split_whitespace()
        .map(|item| {
            item.split('_')
                .map(|word| {
                    let lower = word.to_lowercase();
                    let mut chars = lower.chars();
                    chars
                        .next()
                        .map(|c| c.to_uppercase().collect::<String>() + chars.as_str())
                        .unwrap_or_default()
                })
                .collect()
        })
        .collect();
    assert!(asked.len() > 10);
    let source = include_str!("../parse.rs");
    for typename in &asked {
        assert!(
            source.contains(&format!("\"{typename}\" =>")),
            "{typename} is asked for but never read"
        );
        assert!(
            doc.contains(&format!("... on {typename}")),
            "{typename} is asked for with no fields"
        );
    }
}

#[test]
fn a_label_event_whose_label_is_gone_is_left_out() {
    let data = json!({
        "repository": { "pullRequest": {
            "createdAt": "2026-10-17T15:00:00Z",
            "author": null,
            "timelineItems": {
                "pageInfo": { "hasNextPage": false, "endCursor": null },
                "nodes": [
                    { "__typename": "LabeledEvent", "id": "LE_1",
                      "createdAt": "2026-10-17T15:22:08Z", "actor": null, "label": null },
                    { "__typename": "UnlabeledEvent", "id": "UNLE_1",
                      "createdAt": "2026-10-17T15:22:09Z", "actor": null,
                      "label": { "name": "bug", "color": null } }
                ]
            }
        } }
    });
    let page = to_timeline_page(&data, false).unwrap();
    assert_eq!(
        page.items,
        [PrTimelineItem::Unlabeled {
            id: "UNLE_1".into(),
            actor: None,
            label: PrLabel {
                name: "bug".into(),
                color: None
            },
            at: "2026-10-17T15:22:09Z".into(),
        }]
    );
}

#[test]
fn commits_read_oldest_first() {
    let page = to_commits_page(&fixture("commits")).unwrap();
    assert_eq!(page.commits.len(), 8);
    assert_eq!(
        page.commits[0].oid,
        "30ce37dca5ca0b6311fee6bd7854e33688813627"
    );
    assert_eq!(
        page.commits[0].message_headline,
        "feat(debug): add build-gated internal debug configuration"
    );
    assert_eq!(page.next_cursor, None);
}

#[test]
fn a_search_page_reads_its_rows_and_cursor() {
    let (rows, next) = to_list_page(&fixture("search"), Some("uzayer"));
    assert_eq!(rows.len(), 5);
    assert!(next.is_some());
    assert_eq!(rows[0].number, 14804);
    assert_eq!(rows[0].state, PrState::Merged);
    assert!(rows[3].is_draft);
    assert!(rows
        .iter()
        .all(|r| r.checks_state == Some(PrChecksState::Passing)));
}

#[test]
fn a_by_number_answer_reads_each_alias_in_order_and_skips_the_missing() {
    let search = fixture("search");
    let nodes = search
        .pointer("/search/nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap();
    let mut second = nodes[1].clone();
    second["comments"] = serde_json::json!({ "totalCount": 4 });
    let data = serde_json::json!({
        "repository": { "p0": second, "p1": null, "p2": nodes[0] }
    });
    let rows = to_entries_by_alias(&data, 3, Some("uzayer"));
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].number, nodes[1]["number"].as_u64().unwrap());
    assert_eq!(rows[0].comment_count, 4);
    assert_eq!(rows[1].number, 14804);
    // A row whose answer did not count its comments reads as none.
    assert_eq!(rows[1].comment_count, 0);
    assert!(to_entries_by_alias(&serde_json::json!({}), 2, None).is_empty());
}

#[test]
fn viewed_state_reads_every_file() {
    let (files, next) = to_files_viewed_page(&fixture("files-viewed"));
    assert_eq!(files.len(), 15);
    assert!(files.iter().all(|f| f.state == PrFileViewedState::Unviewed));
    assert_eq!(next, None);
}

#[test]
fn a_files_page_becomes_a_patch_with_its_holes_named() {
    let entries = fixture("files.rest");
    let patch = to_files_patch(entries.as_array().unwrap());
    assert_eq!(patch.raw_count, 6);
    assert_eq!(patch.files.len(), 6);
    // The fixture blanks the two long patches, as GitHub does past its limit.
    assert!(patch.truncated);
    let omitted: Vec<&str> = patch.omitted.iter().map(|o| o.path.as_str()).collect();
    assert_eq!(
        omitted,
        ["internal/config/refreshable.go", "internal/debug/config.go"]
    );
    assert!(!patch.files[2].has_patch);
    assert!(patch
        .patch
        .starts_with("diff --git a/.github/workflows/go.yml b/.github/workflows/go.yml\n"));
    assert!(patch
        .patch
        .contains("new file mode 100644\n--- /dev/null\n+++ b/internal/debug/config.go\n"));
}

#[test]
fn a_pull_request_names_its_base_and_head_revisions() {
    let (base, head) = to_revisions(&fixture("pull.rest"), false);
    assert!(base.as_deref().is_some_and(is_commit_sha));
    assert!(head.as_deref().is_some_and(is_commit_sha));
    let commit = json!({ "sha": "abcdef1", "parents": [{ "sha": "1234567" }] });
    assert_eq!(
        to_revisions(&commit, true),
        (Some("1234567".into()), Some("abcdef1".into()))
    );
    assert_eq!(
        to_revisions(&json!({ "sha": "abcdef1", "parents": [] }), true).0,
        None
    );
}

// ── rules ───────────────────────────────────────────────────────────────

fn check_run(name: &str, workflow: &str, conclusion: Option<&str>, completed: &str) -> Value {
    json!({
        "__typename": "CheckRun",
        "name": name,
        "status": if conclusion.is_some() { "COMPLETED" } else { "IN_PROGRESS" },
        "conclusion": conclusion,
        "startedAt": "2026-10-01T00:00:00Z",
        "completedAt": completed,
        "checkSuite": { "workflowRun": { "workflow": { "name": workflow } } },
    })
}

#[test]
fn a_rerun_check_keeps_only_its_newest_run_and_failures_sort_first() {
    let contexts = [
        check_run("test", "CI", Some("FAILURE"), "2026-10-01T00:05:00Z"),
        check_run("test", "CI", Some("SUCCESS"), "2026-10-01T00:09:00Z"),
        check_run("lint", "CI", Some("SUCCESS"), "2026-10-01T00:02:00Z"),
        check_run("lint", "Docs", Some("FAILURE"), "2026-10-01T00:03:00Z"),
    ];
    let refs: Vec<&Value> = contexts.iter().collect();
    let checks = to_checks(&refs);
    let summary: Vec<(&str, PrCheckStatus)> =
        checks.iter().map(|c| (c.name.as_str(), c.status)).collect();
    assert_eq!(
        summary,
        [
            ("Docs / lint", PrCheckStatus::Failure),
            ("test", PrCheckStatus::Success),
            ("CI / lint", PrCheckStatus::Success),
        ]
    );
    assert_eq!(checks[1].duration_ms, Some(9 * 60_000));
    // The rerun replaced the failure, but another check still fails.
    assert_eq!(rollup_checks_state(&refs), Some(PrChecksState::Failing));
}

#[test]
fn a_run_still_going_outranks_a_finished_one_and_is_pending() {
    let contexts = [
        check_run("build", "CI", Some("SUCCESS"), "2026-10-01T00:05:00Z"),
        check_run("build", "CI", None, UNSET_TIMESTAMP),
    ];
    let refs: Vec<&Value> = contexts.iter().collect();
    let checks = to_checks(&refs);
    assert_eq!(checks.len(), 1);
    assert_eq!(checks[0].status, PrCheckStatus::Pending);
    assert_eq!(checks[0].completed_at, None);
    assert_eq!(rollup_checks_state(&refs), Some(PrChecksState::Pending));
}

#[test]
fn commit_statuses_read_their_state() {
    let status = json!({ "__typename": "StatusContext", "context": "ci/legacy", "state": "ERROR", "targetUrl": "https://ci.test/1" });
    let checks = to_checks(&[&status]);
    assert_eq!(checks[0].status, PrCheckStatus::Failure);
    assert_eq!(checks[0].url.as_deref(), Some("https://ci.test/1"));
    assert_eq!(rollup_checks_state(&[]), None);
    assert_eq!(
        rollup_checks_state(&[&json!({ "state": "PENDING" })]),
        Some(PrChecksState::Pending)
    );
}

#[test]
fn the_search_query_quotes_what_the_user_typed() {
    let query = PrListQuery {
        state: Some(PrListState::Closed),
        involvement: Some(PrInvolvement::Reviewing),
        search: Some(r#"fix "is:merged" \o/"#.into()),
        author: Some("@me".into()),
        draft: Some("hide".into()),
        labels: Some(vec!["bug fix".into(), "a\"b".into()]),
        ..Default::default()
    };
    assert_eq!(
        search_query("cli/cli", "uzayer", &query).unwrap(),
        r#"is:pr is:closed is:unmerged review-requested:uzayer "fix \"is:merged\" \\o/" author:"uzayer" draft:false label:"bug fix" label:"ab" sort:updated-desc repo:cli/cli"#
    );
    assert_eq!(
        search_query("cli/cli", "u", &PrListQuery::default()).unwrap(),
        "is:pr is:open sort:updated-desc repo:cli/cli"
    );
    assert_eq!(
        search_query("cli/cli repo:x/y", "u", &PrListQuery::default()),
        None
    );
}

#[test]
fn the_search_query_ors_a_label_group_and_excludes_labels() {
    let query = PrListQuery {
        label_groups: Some(vec![
            vec!["bug".into(), "help wanted".into()],
            vec![" ".into()],
        ]),
        excluded_labels: Some(vec!["wip".into(), "".into()]),
        ..Default::default()
    };
    assert_eq!(
        search_query("cli/cli", "u", &query).unwrap(),
        r#"is:pr is:open label:"bug","help wanted" -label:"wip" sort:updated-desc repo:cli/cli"#
    );
}

#[test]
fn the_search_query_narrows_to_one_head_branch_quoted() {
    let query = PrListQuery {
        state: Some(PrListState::All),
        head: Some(" uzayer/overlay \"x".into()),
        ..Default::default()
    };
    assert_eq!(
        search_query("cli/cli", "u", &query).unwrap(),
        r#"is:pr head:"uzayer/overlay x" sort:updated-desc repo:cli/cli"#
    );
}

#[test]
fn unusual_patch_paths_are_quoted_the_way_the_patch_format_does() {
    assert_eq!(quote_git_patch_path("a/src/main.rs"), "a/src/main.rs");
    assert_eq!(quote_git_patch_path("a/tab\there"), "\"a/tab\\there\"");
    assert_eq!(quote_git_patch_path("b/say \"hi\""), "\"b/say \\\"hi\\\"\"");
    assert_eq!(quote_git_patch_path("b/\u{1}"), "\"b/\\001\"");
    assert_eq!(quote_git_patch_path("b/ünï"), "b/ünï");
}

#[test]
fn renames_and_deletions_get_patch_headers() {
    let entries = [
        json!({ "filename": "new.rs", "previous_filename": "old.rs", "status": "renamed", "additions": 0, "deletions": 0 }),
        json!({ "filename": "gone.rs", "status": "removed", "additions": 0, "deletions": 2, "patch": "@@ -1,2 +0,0 @@\n-a\n-b" }),
        json!({ "filename": "logo.png", "status": "added", "additions": 0, "deletions": 0 }),
    ];
    let patch = to_files_patch(&entries);
    assert_eq!(
        patch.patch,
        "diff --git a/old.rs b/new.rs\nrename from old.rs\nrename to new.rs\n--- a/old.rs\n+++ b/new.rs\n\
         diff --git a/gone.rs b/gone.rs\ndeleted file mode 100644\n--- a/gone.rs\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n\
         diff --git a/logo.png b/logo.png\nnew file mode 100644\n--- /dev/null\n+++ b/logo.png\n"
    );
    // A pure rename and an empty binary have no hunks but hide nothing.
    assert!(!patch.truncated);
    assert_eq!(patch.files[0].previous_path.as_deref(), Some("old.rs"));
}

#[test]
fn an_author_may_only_comment_and_an_outsider_may_not_write() {
    let author = viewer_permissions(&ViewerAccess {
        can_write: false,
        can_delete_branch: false,
        can_triage: false,
        can_update: true,
        did_author: true,
        can_update_branch: false,
        can_merge_now: false,
        auto_merge_allowed: true,
        merged: true,
        open_from_fork: false,
    });
    assert_eq!(author.verdicts, [PrReviewVerdict::Comment]);
    // A revert needs push access, which an outside author does not have.
    assert!(!author.actions.contains(&PrAction::Revert));
    assert!(author.resolve);
    assert!(!author.can_merge);
    assert!(author.actions.contains(&PrAction::Close));
    assert!(!author.labels);

    let maintainer = viewer_permissions(&ViewerAccess {
        can_write: true,
        can_delete_branch: true,
        can_triage: true,
        can_update: true,
        did_author: false,
        can_update_branch: true,
        can_merge_now: false,
        auto_merge_allowed: true,
        merged: false,
        open_from_fork: true,
    });
    assert!(maintainer.can_merge);
    assert!(maintainer.actions.contains(&PrAction::ApproveWorkflows));
    assert!(!maintainer.actions.contains(&PrAction::Revert));
    assert!(maintainer.actions.contains(&PrAction::EnableAutoMerge));
    assert_eq!(maintainer.verdicts.len(), 3);
    assert_eq!(maintainer.update_methods.len(), 2);
}

#[test]
fn an_app_installation_with_no_permission_is_granted() {
    assert!(to_can_write(Some(&Value::Null)));
    assert!(to_can_write(Some(&json!("MAINTAIN"))));
    assert!(!to_can_write(Some(&json!("READ"))));
    assert!(!to_can_write(None));
    assert!(is_immediately_mergeable(Some("clean")));
    assert!(!is_immediately_mergeable(Some("BLOCKED")));
}

#[test]
fn only_a_refused_review_request_list_is_retried() {
    let refused = json!({ "type": "FORBIDDEN", "path": ["repository", "pullRequest", "reviewRequests", "nodes", 0] });
    let other = json!({ "type": "FORBIDDEN", "path": ["repository", "pullRequest", "labels"] });
    assert!(is_refused_requested_reviewers_only(std::slice::from_ref(
        &refused
    )));
    assert!(!is_refused_requested_reviewers_only(&[refused, other]));
    assert!(!is_refused_requested_reviewers_only(&[]));
}

#[test]
fn reactions_drop_empty_groups_and_leave_the_viewer_out_of_the_names() {
    let groups = json!([
        { "content": "HEART", "viewerHasReacted": true, "reactors": { "totalCount": 3, "nodes": [{ "login": "Uzayer" }, { "login": "a" }] } },
        { "content": "EYES", "viewerHasReacted": false, "reactors": { "totalCount": 0, "nodes": [] } },
        { "content": "NEW_ONE", "viewerHasReacted": false, "reactors": { "totalCount": 1, "nodes": [] } },
    ]);
    let reactions = to_reactions(Some(&groups), Some("uzayer"));
    assert_eq!(
        reactions,
        [PrReaction {
            content: PrReactionContent::Heart,
            count: 3,
            actors: vec!["a".into()],
            viewer_has_reacted: true,
        }]
    );
}

#[test]
fn a_dismissed_review_with_only_a_marker_reads_its_dismissal() {
    assert!(renders_empty("<!-- bot marker -->\n "));
    assert!(!renders_empty("<!-- x --> words"));
    let review = PrComment {
        id: "R1".into(),
        kind: PrCommentKind::Review,
        author: Some(PrActor {
            login: "bot".into(),
            name: None,
            avatar_url: None,
            is_bot: false,
        }),
        body: "<!-- marker -->".into(),
        created_at: "2026-10-01T00:00:00Z".into(),
        edited_at: None,
        url: None,
        path: None,
        review_state: Some("DISMISSED".into()),
        reactions: Vec::new(),
        can_edit: false,
        can_delete: false,
    };
    let mut page = ThreadPage::default();
    page.dismissals_by_review_id
        .insert("R1".into(), "Stale after the rewrite".into());
    page.bot_logins.insert("bot".into());
    page.avatars_by_login.insert(
        "bot".into(),
        "https://avatars.githubusercontent.com/u/1".into(),
    );
    let merged = merge_activity(None, Vec::new(), vec![review], Vec::new(), page, false);
    assert_eq!(merged.comments[0].body, "Stale after the rewrite");
    let author = merged.comments[0].author.as_ref().unwrap();
    assert!(author.is_bot);
    assert!(author.avatar_url.is_some());
}

#[test]
fn a_review_submission_places_each_comment_on_its_side() {
    let comments = [
        PrReviewCommentDraft {
            path: "a.rs".into(),
            position: PrReviewPosition::Added { new_line: 4 },
            body: "x".into(),
        },
        PrReviewCommentDraft {
            path: "b.rs".into(),
            position: PrReviewPosition::Context {
                old_line: 7,
                new_line: 9,
                side: PrDiffSide::Left,
            },
            body: "y".into(),
        },
    ];
    assert_eq!(
        build_review_submission(PrReviewVerdict::RequestChanges, "please", &comments),
        json!({
            "event": "REQUEST_CHANGES",
            "body": "please",
            "comments": [
                { "path": "a.rs", "line": 4, "side": "RIGHT", "body": "x" },
                { "path": "b.rs", "line": 7, "side": "LEFT", "body": "y" },
            ],
        })
    );
    assert_eq!(
        build_reviewer_request(&[
            PrReviewerRef {
                id: "octo".into(),
                kind: PrReviewerKind::User
            },
            PrReviewerRef {
                id: "core".into(),
                kind: PrReviewerKind::Team
            },
        ]),
        json!({ "reviewers": ["octo"], "team_reviewers": ["core"] })
    );
}

#[test]
fn only_shapes_github_issues_reach_a_request_path() {
    assert!(is_commit_sha("abcdef1"));
    assert!(!is_commit_sha("abcde"));
    assert!(!is_commit_sha("abcdefg"));
    assert!(!is_commit_sha("../../x"));
    assert_eq!(diff_cursor_page("2"), Some(2));
    assert_eq!(diff_cursor_page("0"), None);
    assert_eq!(diff_cursor_page("01"), None);
    assert_eq!(diff_cursor_page("12345678"), None);
    assert_eq!(diff_cursor_page("1e3"), None);
    assert!(is_node_id("PRRT_kwDODKw3uc6t-QaS"));
    assert!(!is_node_id("x y"));
    assert!(!is_node_id(""));
    assert!(is_repository_part("my.repo-1_x"));
    assert!(!is_repository_part("a b"));
}

#[test]
fn a_merged_at_wins_over_a_stale_state() {
    assert_eq!(
        to_state(&json!({ "state": "CLOSED", "mergedAt": "2026-01-01T00:00:00Z" })),
        PrState::Merged
    );
    assert_eq!(to_state(&json!({ "state": "closed" })), PrState::Closed);
    assert_eq!(to_state(&json!({})), PrState::Open);
}

#[test]
fn the_repository_context_names_its_host() {
    let ctx = to_repo_context(&json!({
        "viewer": { "login": "uzayer" },
        "repository": {
            "nameWithOwner": "cli/cli",
            "url": "https://github.com/cli/cli",
            "defaultBranchRef": { "name": "trunk" },
        },
    }))
    .unwrap();
    assert_eq!(ctx.repository(), "cli/cli");
    assert_eq!(ctx.host, "github.com");
    assert_eq!(ctx.viewer.as_deref(), Some("uzayer"));
    assert_eq!(ctx.default_branch.as_deref(), Some("trunk"));
    assert_eq!(to_repo_context(&json!({ "repository": null })), None);
}

#[test]
fn a_listing_row_says_where_its_head_lives() {
    let row = |extra: serde_json::Value| {
        let mut node = json!({
            "number": 3,
            "title": "t",
            "url": "https://github.com/acme/shop/pull/3",
            "headRefName": "main",
        });
        node.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let data = json!({ "search": { "nodes": [node] } });
        to_list_page(&data, None).0.remove(0)
    };
    let fork = row(json!({
        "isCrossRepository": true,
        "headRepository": { "nameWithOwner": "stranger/shop" },
    }));
    assert!(fork.is_cross_repository);
    assert_eq!(fork.head_repository.as_deref(), Some("stranger/shop"));
    let gone = row(json!({ "isCrossRepository": true, "headRepository": null }));
    assert_eq!(gone.head_repository, None);
    let own = row(json!({
        "isCrossRepository": false,
        "headRepository": { "nameWithOwner": "acme/shop" },
    }));
    assert!(!own.is_cross_repository);
    let wire = serde_json::to_value(&own).unwrap();
    assert_eq!(wire["headRepository"], "acme/shop");
    assert_eq!(wire["isCrossRepository"], false);
}

// ── pickers ─────────────────────────────────────────────────────────────

#[test]
fn reviewer_candidates_leave_out_the_author_and_put_the_asked_first() {
    let data = json!({
        "repository": {
            "assignableUsers": {
                "pageInfo": { "hasNextPage": true },
                "nodes": [
                    { "login": "zoe", "name": "Zoe", "avatarUrl": null },
                    { "login": "Author", "name": null, "avatarUrl": null },
                    { "login": "ana", "name": null, "avatarUrl": null },
                    { "login": "mo", "name": null, "avatarUrl": null }
                ]
            },
            "pullRequest": {
                "author": { "login": "author" },
                "reviewRequests": { "nodes": [
                    { "requestedReviewer": { "__typename": "User", "login": "Mo" } },
                    { "requestedReviewer": {
                        "__typename": "Team",
                        "slug": "web",
                        "combinedSlug": "acme/web",
                        "teamName": "Web",
                        "teamAvatarUrl": null
                    } }
                ] }
            }
        }
    });
    let read = to_reviewer_candidates(&data).unwrap();
    let rows: Vec<(&str, bool)> = read
        .candidates
        .iter()
        .map(|c| (c.id.as_str(), c.is_requested))
        .collect();
    assert_eq!(
        rows,
        [("mo", true), ("ana", false), ("zoe", false), ("web", true)]
    );
    assert_eq!(read.candidates[3].kind, PrReviewerKind::Team);
    assert_eq!(read.candidates[3].actor.login, "acme/web");
    assert!(read.truncated);
}

#[test]
fn label_candidates_mark_what_the_pull_request_carries() {
    let data = json!({
        "repository": {
            "labels": {
                "pageInfo": { "hasNextPage": false },
                "nodes": [
                    { "name": "bug", "color": "d73a4a", "description": "Something is broken" },
                    { "name": "docs", "color": "0075ca", "description": null }
                ]
            },
            "pullRequest": { "labels": { "nodes": [ { "name": "docs" } ] } }
        }
    });
    let read = to_label_candidates(&data).unwrap();
    assert_eq!(read.candidates.len(), 2);
    assert!(!read.candidates[0].is_applied);
    assert_eq!(
        read.candidates[0].description.as_deref(),
        Some("Something is broken")
    );
    assert!(read.candidates[1].is_applied);
    assert_eq!(read.candidates[1].color.as_deref(), Some("0075ca"));
    assert!(!read.truncated);
}

#[test]
fn candidates_for_a_missing_pull_request_read_as_none() {
    let data = json!({ "repository": { "pullRequest": null } });
    assert!(to_reviewer_candidates(&data).is_none());
    assert!(to_label_candidates(&data).is_none());
}

// ── edit, delete, revert, workflows, merge message ──────────────────────

/// Recorded as the repository's admin, who may rewrite and delete anyone's
/// comment; a submitted review is never deletable, whatever GitHub says.
#[test]
fn remarks_carry_what_the_viewer_may_do_to_them() {
    let page = to_activity_page(&fixture("activity-own")).unwrap();
    let comments: Vec<&PrComment> = page
        .remarks
        .iter()
        .filter(|c| c.kind == PrCommentKind::IssueComment)
        .collect();
    assert!(!comments.is_empty());
    assert!(comments.iter().all(|c| c.can_edit && c.can_delete));
    let review = page
        .remarks
        .iter()
        .find(|c| c.kind == PrCommentKind::Review)
        .unwrap();
    assert!(review.can_edit);
    assert!(!review.can_delete);

    let threads = to_review_thread_page(&fixture("review-threads-own")).unwrap();
    let line = &threads.threads[0].comments[0];
    assert!(line.can_edit && line.can_delete);
    // Through the merge, a line comment keeps them.
    let merged = merge_activity(
        None,
        Vec::new(),
        Vec::new(),
        threads.threads.clone(),
        threads,
        false,
    );
    let first = &merged.comments[0];
    assert_eq!(first.kind, PrCommentKind::ReviewComment);
    assert!(first.can_edit && first.can_delete);
}

/// An answer recorded before the fields were asked for (and so a host that
/// does not say) offers neither.
#[test]
fn a_remark_the_host_says_nothing_about_is_not_editable() {
    let page = to_activity_page(&fixture("activity")).unwrap();
    assert!(page.remarks.iter().all(|c| !c.can_edit && !c.can_delete));
}

#[test]
fn a_subject_names_its_type_for_the_mutation_that_fits_it() {
    assert_eq!(
        subject_typename(&fixture("subject")).as_deref(),
        Some("PullRequestReviewThread")
    );
    assert_eq!(
        comment_typename(PrCommentKind::IssueComment),
        "IssueComment"
    );
    assert_eq!(
        comment_typename(PrCommentKind::ReviewComment),
        "PullRequestReviewComment"
    );
    assert_eq!(comment_typename(PrCommentKind::Review), "PullRequestReview");
}

/// The mutation's answer, shaped as GitHub's schema returns it.
#[test]
fn a_revert_answers_the_pull_request_it_opened() {
    let data = json!({ "revertPullRequest": { "revertPullRequest": {
        "number": 15001, "url": "https://github.com/cli/cli/pull/15001"
    } } });
    assert_eq!(
        to_reverted(&data),
        Some(PrReverted {
            number: 15001,
            url: "https://github.com/cli/cli/pull/15001".into()
        })
    );
    assert_eq!(
        to_reverted(&json!({ "revertPullRequest": { "revertPullRequest": null } })),
        None
    );
}

#[test]
fn a_merge_message_reads_with_its_head_and_queue() {
    let message = to_merge_message(&fixture("merge-message")).unwrap();
    assert!(!message.queued);
    assert_eq!(
        message.head.as_deref(),
        Some("654d851d8145b2912fe474ceb0a47681854b37e2")
    );
    assert!(message.body.starts_with("Co-authored-by: Copilot App"));
    assert_eq!(
        crate::commands::pull_requests::merge_message::remove_agent_credits(&message.body),
        ""
    );
}

#[test]
fn a_fork_s_head_is_approved_only_while_it_is_the_one_open_head() {
    let head = to_workflow_head(&fixture("workflow-head")).unwrap();
    assert!(head.open && head.cross_repository);
    assert_eq!(head.branch, "release-download-verify");
    assert_eq!(head.owner.as_deref(), Some("mrecachinas"));
    assert!(head.is_same_head(&head.clone()));

    let (rows, next) = to_heads_page(&fixture("pull-request-heads")).unwrap();
    assert_eq!(next, None);
    assert!(is_only_open_head(&rows, 14783, &head));
    // Asked about another number, or with a twin open, it is refused.
    assert!(!is_only_open_head(&rows, 14784, &head));
    let mut twins = rows.clone();
    twins.push(HeadRow {
        number: 14790,
        ..rows[0].clone()
    });
    assert!(!is_only_open_head(&twins, 14783, &head));
    // A push moves the head: no longer the same.
    let moved = WorkflowHead {
        sha: Some("0000000000000000000000000000000000000001".into()),
        ..head.clone()
    };
    assert!(!moved.is_same_head(&head));
    let other_fork = WorkflowHead {
        owner: Some("someone-else".into()),
        ..head.clone()
    };
    assert!(!other_fork.is_same_head(&head));
}

#[test]
fn only_runs_of_this_head_waiting_on_approval_are_taken() {
    let body = fixture("actions-runs");
    let sha = "654d851d8145b2912fe474ceb0a47681854b37e2";
    let (runs, raw) = to_action_required_runs(&body, sha, "release-download-verify");
    assert_eq!(raw, 3);
    assert_eq!(runs.len(), 3);
    assert_eq!(runs[0].id, 39640741797);
    assert_eq!(runs[0].name, "Code Scanning");
    // Another branch or commit is someone else's run.
    let (none, raw) = to_action_required_runs(&body, sha, "main");
    assert!(none.is_empty());
    assert_eq!(raw, 3, "the page still counts every run it carried");
    let (none, _) = to_action_required_runs(
        &body,
        "1111111111111111111111111111111111111111",
        "release-download-verify",
    );
    assert!(none.is_empty());
}
