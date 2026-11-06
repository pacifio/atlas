//! The list's line counts: each pull request's additions and deletions with
//! the changed files behind them, read for the rows on screen in one aliased
//! request per batch, so the list can split a change into code, tests, mocks
//! and generated files on hover without a request per row.
//!
//! The batch carries each pull request's first page of files. One with more
//! is then paged through on its own, up to [`FILES_MAX`] (the most GitHub
//! lists), so a description's file chips and a session's line counts see
//! every changed file. The paging is bounded three ways: each request by the
//! read timeout, the call by [`FOLLOW_UP_BUDGET`], and the call's follow-up
//! requests by [`FOLLOW_UP_PAGES_MAX`]. Whatever is left unread is reported
//! as `filesTruncated`, which the split already reads as partial.

use std::future::Future;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

use super::github::GitHub;
use super::{open, pull_number, PrError};

/// Aliased pull requests in one request. Each carries up to a hundred file
/// nodes, so this stays well under GraphQL's node limit.
const STATS_PER_REQUEST: usize = 25;
/// The most numbers one call reads: a screen of rows, with room.
const STATS_MAX_NUMBERS: usize = 100;
/// Files read per page, the most GitHub serves at once.
const FILES_PER_PAGE: usize = 100;
/// Files read per pull request: GitHub lists no more than this, so past it
/// the split is reported truncated.
const FILES_MAX: usize = 3000;
/// Wall time one call may spend paging past the first page of files. Each
/// request inside it is bounded by the read timeout too.
const FOLLOW_UP_BUDGET: Duration = Duration::from_secs(45);
/// Follow-up page reads one call may make, across its pull requests: three
/// pull requests' worth at [`FILES_MAX`]. A screen of huge pull requests
/// would otherwise spend the quota on hover counts.
const FOLLOW_UP_PAGES_MAX: usize = 3 * (FILES_MAX / FILES_PER_PAGE);

/// One pull request's files past the first page.
const FILES_PAGE_QUERY: &str = r#"query PullRequestListStatsFiles($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      files(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { path additions deletions }
      }
    }
  }
}"#;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrFileStat {
    pub path: String,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrListStat {
    pub number: u64,
    pub additions: u64,
    pub deletions: u64,
    pub files: Vec<PrFileStat>,
    /// More files changed than were read: the split would be partial.
    pub files_truncated: bool,
}

fn stats_query(numbers: &[u64]) -> String {
    let fields: String = numbers
        .iter()
        .enumerate()
        .map(|(ix, number)| {
            format!(
                "    p{ix}: pullRequest(number: {number}) {{\n      number\n      additions\n      deletions\n      files(first: {FILES_PER_PAGE}) {{\n        pageInfo {{ hasNextPage endCursor }}\n        nodes {{ path additions deletions }}\n      }}\n    }}\n"
            )
        })
        .collect();
    format!(
        "query PullRequestListStats($owner: String!, $name: String!) {{\n  repository(owner: $owner, name: $name) {{\n{fields}  }}\n}}"
    )
}

fn count(node: &Value, key: &str) -> u64 {
    node.get(key).and_then(Value::as_u64).unwrap_or(0)
}

/// One page of a `files` connection.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct FilesPage {
    files: Vec<PrFileStat>,
    /// GitHub says more files follow.
    has_next: bool,
    /// Where the next page starts, when GitHub named it.
    next: Option<String>,
}

fn parse_files(files: Option<&Value>) -> FilesPage {
    let page_info = files.and_then(|f| f.get("pageInfo"));
    let has_next = page_info
        .and_then(|p| p.get("hasNextPage"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let next = page_info
        .and_then(|p| p.get("endCursor"))
        .and_then(Value::as_str)
        .filter(|c| !c.is_empty())
        .map(str::to_string);
    let files = files
        .and_then(|f| f.get("nodes"))
        .and_then(Value::as_array)
        .map(|nodes| {
            nodes
                .iter()
                .filter_map(|file| {
                    Some(PrFileStat {
                        path: file.get("path").and_then(Value::as_str)?.to_string(),
                        additions: count(file, "additions"),
                        deletions: count(file, "deletions"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    FilesPage {
        files,
        has_next,
        next,
    }
}

/// The answered pull requests, in the order asked, each with where its next
/// page of files starts; a `null` alias (a number the repository does not
/// have) is left out.
fn parse_stats(data: &Value, asked: usize) -> Vec<(PrListStat, Option<String>)> {
    let Some(repository) = data.get("repository") else {
        return Vec::new();
    };
    (0..asked)
        .filter_map(|ix| repository.get(format!("p{ix}")))
        .filter(|node| !node.is_null())
        .filter_map(|node| {
            let number = node.get("number").and_then(Value::as_u64)?;
            let page = parse_files(node.get("files"));
            let next = page.next.filter(|_| page.has_next);
            Some((
                PrListStat {
                    number,
                    additions: count(node, "additions"),
                    deletions: count(node, "deletions"),
                    files: page.files,
                    files_truncated: page.has_next,
                },
                next,
            ))
        })
        .collect()
}

/// What one call may still spend on follow-up pages.
struct FollowUpBudget {
    deadline: Instant,
    pages_left: usize,
}

impl FollowUpBudget {
    fn new(now: Instant) -> Self {
        Self {
            deadline: now + FOLLOW_UP_BUDGET,
            pages_left: FOLLOW_UP_PAGES_MAX,
        }
    }
}

/// Pages `stat`'s files on from `cursor` through `fetch` until GitHub has no
/// more, [`FILES_MAX`] is reached or `budget` runs out, and records in
/// `files_truncated` whether any were left unread. A page that fails or runs
/// past the budget ends the paging with what was read: the first page
/// already answered, so the count is partial, not wrong.
async fn page_rest<F, Fut>(
    stat: &mut PrListStat,
    mut cursor: Option<String>,
    budget: &mut FollowUpBudget,
    mut fetch: F,
) where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<FilesPage, PrError>>,
{
    while let Some(after) = cursor.take() {
        let left = budget.deadline.saturating_duration_since(Instant::now());
        if stat.files.len() >= FILES_MAX || budget.pages_left == 0 || left.is_zero() {
            stat.files_truncated = true;
            break;
        }
        budget.pages_left -= 1;
        let page = match tokio::time::timeout(left, fetch(after.clone())).await {
            Ok(Ok(page)) => page,
            Ok(Err(e)) => {
                tracing::debug!(
                    number = stat.number,
                    error = ?e,
                    "a page of changed files could not be read"
                );
                stat.files_truncated = true;
                break;
            }
            Err(_) => {
                stat.files_truncated = true;
                break;
            }
        };
        stat.files.extend(page.files);
        stat.files_truncated = page.has_next;
        // A page that says more follow but names no new cursor would page
        // forever: stop, still truncated.
        cursor = page.next.filter(|next| page.has_next && *next != after);
    }
    if stat.files.len() > FILES_MAX {
        stat.files.truncate(FILES_MAX);
        stat.files_truncated = true;
    }
}

/// Line counts and changed files for the given pull requests, as many as the
/// repository has; a number it does not have is left out of the answer.
#[tauri::command]
pub async fn pr_list_stats(path: String, numbers: Vec<u64>) -> Result<Vec<PrListStat>, PrError> {
    let mut wanted: Vec<u64> = Vec::with_capacity(numbers.len().min(STATS_MAX_NUMBERS));
    for number in numbers {
        let number = pull_number(number)?;
        if !wanted.contains(&number) {
            wanted.push(number);
        }
        if wanted.len() == STATS_MAX_NUMBERS {
            break;
        }
    }
    if wanted.is_empty() {
        return Ok(Vec::new());
    }
    open(&path).await?.list_stats(&wanted).await
}

impl GitHub {
    /// The stats for up to [`STATS_MAX_NUMBERS`] distinct numbers, a batch
    /// of aliased reads at a time, then the files past each one's first page.
    pub(crate) async fn list_stats(&self, wanted: &[u64]) -> Result<Vec<PrListStat>, PrError> {
        let mut first = Vec::with_capacity(wanted.len());
        for chunk in wanted.chunks(STATS_PER_REQUEST) {
            match self.read_aliased(&stats_query(chunk)).await {
                Ok(data) => first.extend(parse_stats(&data, chunk.len())),
                // Every number in the batch was gone: nothing to count.
                Err(PrError::NotFound) => {}
                Err(e) => return Err(e),
            }
        }
        let mut budget = FollowUpBudget::new(Instant::now());
        let mut out = Vec::with_capacity(first.len());
        for (mut stat, cursor) in first {
            let number = stat.number;
            page_rest(&mut stat, cursor, &mut budget, |after| async move {
                let data = self
                    .read_in_repo(
                        FILES_PAGE_QUERY,
                        json!({ "number": number, "after": after }),
                    )
                    .await?;
                Ok(parse_files(
                    data.get("repository")
                        .and_then(|r| r.get("pullRequest"))
                        .and_then(|p| p.get("files")),
                ))
            })
            .await;
            out.push(stat);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::RefCell;

    fn files(prefix: &str, n: usize) -> Vec<PrFileStat> {
        (0..n)
            .map(|ix| PrFileStat {
                path: format!("{prefix}/{ix}.ts"),
                additions: 1,
                deletions: 0,
            })
            .collect()
    }

    fn first_page(n: usize) -> PrListStat {
        PrListStat {
            number: 7,
            additions: 0,
            deletions: 0,
            files: files("p0", n),
            files_truncated: true,
        }
    }

    #[test]
    fn the_query_aliases_each_number_once() {
        let query = stats_query(&[12, 7]);
        assert!(query.contains("p0: pullRequest(number: 12)"));
        assert!(query.contains("p1: pullRequest(number: 7)"));
        assert!(query.contains("files(first: 100)"));
        assert!(query.contains("pageInfo { hasNextPage endCursor }"));
        assert!(query.contains("$owner: String!, $name: String!"));
    }

    #[test]
    fn answers_are_read_in_order_and_missing_numbers_left_out() {
        let data = json!({
            "repository": {
                "p0": {
                    "number": 12,
                    "additions": 30,
                    "deletions": 4,
                    "files": {
                        "pageInfo": { "hasNextPage": true, "endCursor": "c1" },
                        "nodes": [
                            { "path": "src/a.ts", "additions": 20, "deletions": 4 },
                            { "path": "src/a.test.ts", "additions": 10, "deletions": 0 },
                            { "additions": 1 }
                        ]
                    }
                },
                "p1": null
            }
        });
        let stats = parse_stats(&data, 2);
        assert_eq!(stats.len(), 1);
        let (stat, next) = &stats[0];
        assert_eq!(stat.number, 12);
        assert_eq!((stat.additions, stat.deletions), (30, 4));
        assert!(stat.files_truncated);
        assert_eq!(next.as_deref(), Some("c1"));
        assert_eq!(stat.files.len(), 2);
        assert_eq!(stat.files[1].path, "src/a.test.ts");
        assert!(parse_stats(&json!({}), 1).is_empty());
    }

    #[test]
    fn a_last_page_names_no_next_cursor() {
        let data = json!({ "repository": { "p0": {
            "number": 3,
            "files": { "pageInfo": { "hasNextPage": false, "endCursor": "c9" }, "nodes": [] }
        } } });
        let stats = parse_stats(&data, 1);
        assert!(!stats[0].0.files_truncated);
        assert_eq!(stats[0].1, None);
    }

    #[tokio::test]
    async fn two_and_a_half_pages_are_read_whole() {
        let asked = RefCell::new(Vec::new());
        let mut stat = first_page(100);
        let mut budget = FollowUpBudget::new(Instant::now());
        page_rest(&mut stat, Some("c1".into()), &mut budget, |after| {
            asked.borrow_mut().push(after.clone());
            async move {
                Ok(match after.as_str() {
                    "c1" => FilesPage {
                        files: files("p1", 100),
                        has_next: true,
                        next: Some("c2".into()),
                    },
                    "c2" => FilesPage {
                        files: files("p2", 50),
                        has_next: false,
                        next: Some("c3".into()),
                    },
                    other => panic!("asked past the end: {other}"),
                })
            }
        })
        .await;
        assert_eq!(*asked.borrow(), ["c1", "c2"]);
        assert_eq!(stat.files.len(), 250);
        assert_eq!(stat.files[249].path, "p2/49.ts");
        assert!(!stat.files_truncated);
        assert_eq!(budget.pages_left, FOLLOW_UP_PAGES_MAX - 2);
    }

    #[tokio::test]
    async fn paging_stops_at_github_s_cap_and_says_so() {
        let calls = RefCell::new(0usize);
        let mut stat = first_page(100);
        let mut budget = FollowUpBudget::new(Instant::now());
        page_rest(&mut stat, Some("c0".into()), &mut budget, |after| {
            *calls.borrow_mut() += 1;
            async move {
                Ok(FilesPage {
                    files: files(&after, 100),
                    has_next: true,
                    next: Some(format!("{after}+")),
                })
            }
        })
        .await;
        assert_eq!(*calls.borrow(), FILES_MAX / FILES_PER_PAGE - 1);
        assert_eq!(stat.files.len(), FILES_MAX);
        assert!(stat.files_truncated);
    }

    #[tokio::test]
    async fn a_spent_budget_or_a_failed_page_keeps_what_was_read() {
        let mut stat = first_page(100);
        let mut budget = FollowUpBudget::new(Instant::now());
        budget.pages_left = 0;
        page_rest(&mut stat, Some("c1".into()), &mut budget, |_| async {
            panic!("no page may be read past the budget");
        })
        .await;
        assert_eq!(stat.files.len(), 100);
        assert!(stat.files_truncated);

        let mut stat = first_page(100);
        let mut budget = FollowUpBudget::new(Instant::now());
        page_rest(&mut stat, Some("c1".into()), &mut budget, |_| async {
            Err(PrError::Network {
                message: "offline".into(),
            })
        })
        .await;
        assert_eq!(stat.files.len(), 100);
        assert!(stat.files_truncated);
    }

    #[tokio::test]
    async fn a_cursor_that_does_not_move_ends_the_paging() {
        let calls = RefCell::new(0usize);
        let mut stat = first_page(100);
        let mut budget = FollowUpBudget::new(Instant::now());
        page_rest(&mut stat, Some("c1".into()), &mut budget, |after| {
            *calls.borrow_mut() += 1;
            async move {
                Ok(FilesPage {
                    files: files("again", 100),
                    has_next: true,
                    next: Some(after),
                })
            }
        })
        .await;
        assert_eq!(*calls.borrow(), 1);
        assert!(stat.files_truncated);
    }
}
