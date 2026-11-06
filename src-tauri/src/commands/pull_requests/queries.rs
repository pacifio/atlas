//! GitHub's GraphQL documents for the pull-request surface.
//!
//! Each is one string constant, sent whole through `gh api graphql`. Field
//! choices carry their reasons inline, because most of them are answers to a
//! cost or a permission GitHub imposes rather than taste.

/// The signed-in account and the repository the checkout's remote names —
/// the one read whose `$owner`/`$name` `gh` fills in from the checkout.
pub const REPOSITORY_CONTEXT: &str = r#"query RepositoryContext($owner: String!, $name: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    nameWithOwner
    url
    defaultBranchRef { name }
  }
}"#;

/// A check context of the head commit. `isRequired` is asked for on
/// github.com only (`$required`): an older Enterprise server may not know
/// it, and an unknown field fails the whole read.
const CHECK_CONTEXT: &str = r#"fragment CheckContext on StatusCheckRollupContext {
  __typename
  ... on StatusContext {
    context
    state
    targetUrl
    createdAt
    description
    isRequired(pullRequestNumber: $number) @include(if: $required)
  }
  ... on CheckRun {
    name
    status
    conclusion
    startedAt
    completedAt
    detailsUrl
    isRequired(pullRequestNumber: $number) @include(if: $required)
    checkSuite {
      workflowRun {
        workflow {
          name
        }
      }
    }
  }
}"#;

/// The detail of a pull request with the viewer's standing on it. The pull
/// ref (`$headRef` is `refs/pull/<number>/head`) lets the base comparison
/// share this read without first resolving a fork's branch.
/// `$requestedReviewers` drops to 0 when GitHub refuses the review requests
/// alone (a team behind `read:org`), rather than failing the whole read.
pub fn pull_request_core() -> String {
    format!(
        r#"query PullRequestCore(
  $owner: String!
  $name: String!
  $number: Int!
  $headRef: String!
  $required: Boolean!
  $requestedReviewers: Int!
) {{
  viewer {{ login }}
  repository(owner: $owner, name: $name) {{
    mergeCommitAllowed
    squashMergeAllowed
    rebaseMergeAllowed
    autoMergeAllowed
    viewerPermission
    pullRequest(number: $number) {{
      number
      title
      url
      body
      state
      isDraft
      mergeable
      mergeStateStatus
      reviewDecision
      additions
      deletions
      changedFiles
      createdAt
      updatedAt
      mergedAt
      closedAt
      headRefName
      baseRefName
      headRefOid
      baseRefOid
      isCrossRepository
      headRepositoryOwner {{ login }}
      headRepository {{
        nameWithOwner
        viewerPermission
      }}
      headRef {{ id }}
      author {{
        __typename
        login
        avatarUrl
        ... on User {{ id name }}
      }}
      autoMergeRequest {{ mergeMethod }}
      viewerCanUpdate
      viewerDidAuthor
      viewerCanUpdateBranch
      baseRef {{
        compare(headRef: $headRef) {{ behindBy }}
      }}
      reviewRequests(first: $requestedReviewers) {{
        nodes {{
          requestedReviewer {{
            __typename
            ... on User {{ login name avatarUrl }}
            ... on Bot {{ login avatarUrl }}
            ... on Team {{
              slug
              combinedSlug
              teamName: name
              teamAvatarUrl: avatarUrl
            }}
          }}
        }}
      }}
      latestReviews(first: 50) {{
        nodes {{
          state
          author {{ __typename login avatarUrl ... on User {{ name }} }}
        }}
      }}
      labels(first: 100) {{ nodes {{ name color }} }}
      assignees(first: 25) {{ nodes {{ login name avatarUrl }} }}
      totalCommits: commits {{ totalCount }}
      commits(last: 1) {{
        nodes {{
          commit {{
            statusCheckRollup {{
              contexts(first: 100) {{
                nodes {{ ...CheckContext }}
                pageInfo {{ hasNextPage }}
              }}
            }}
          }}
        }}
      }}
    }}
  }}
}}
{CHECK_CONTEXT}"#
    )
}

/// Every check context of the head commit, a page at a time, for a rollup
/// past the hundred the detail read carries.
pub fn pull_request_check_contexts() -> String {
    format!(
        r#"query PullRequestCheckContexts(
  $owner: String!
  $name: String!
  $number: Int!
  $required: Boolean!
  $after: String
) {{
  repository(owner: $owner, name: $name) {{
    pullRequest(number: $number) {{
      headRefOid
      commits(last: 1) {{
        nodes {{
          commit {{
            statusCheckRollup {{
              contexts(first: 100, after: $after) {{
                nodes {{ ...CheckContext }}
                pageInfo {{ hasNextPage endCursor }}
              }}
            }}
          }}
        }}
      }}
    }}
  }}
}}
{CHECK_CONTEXT}"#
    )
}

/// The conversation outside the review threads: who opened it, its issue
/// comments, its reviews and its newest commits. `viewerCanUpdate` and
/// `viewerCanDelete` are the host's own answer per remark, which is what the
/// edit and delete controls are shown on (a review is never deleted, so its
/// `viewerCanDelete` is not asked for). The two remark connections
/// page independently, so each is switched on only while it has more to
/// give; the first read (`$head`) asks for everything.
pub const PULL_REQUEST_ACTIVITY: &str = r#"query PullRequestActivity(
  $owner: String!
  $name: String!
  $number: Int!
  $head: Boolean!
  $withComments: Boolean!
  $commentsAfter: String
  $withReviews: Boolean!
  $reviewsAfter: String
) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      author @include(if: $head) {
        __typename
        login
        avatarUrl
        ... on User { name }
      }
      commits(last: 100) @include(if: $head) {
        nodes {
          commit {
            oid
            messageHeadline
            committedDate
            authors(first: 10) {
              nodes {
                name
                email
                user { login }
              }
            }
          }
        }
      }
      comments(first: 100, after: $commentsAfter) @include(if: $withComments) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          body
          createdAt
          lastEditedAt
          url
          viewerCanUpdate
          viewerCanDelete
          author {
            __typename
            login
            avatarUrl
            ... on User { name }
          }
        }
      }
      reviews(first: 100, after: $reviewsAfter) @include(if: $withReviews) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          body
          state
          submittedAt
          lastEditedAt
          url
          viewerCanUpdate
          author {
            __typename
            login
            avatarUrl
            ... on User { name }
          }
        }
      }
    }
  }
}"#;

/// A reaction group as every reactable node reports it. `reactors` is
/// bounded rather than paged: a hover says who reacted, and a hundred and
/// forty names is a count, not a sentence.
const REACTIONS: &str = r#"fragment Reactions on Reactable {
  reactionGroups {
    content
    viewerHasReacted
    reactors(first: 10) {
      totalCount
      nodes {
        ... on User { login }
        ... on Bot { login }
        ... on Organization { login }
        ... on Mannequin { login }
      }
    }
  }
}"#;

const THREAD_COMMENT: &str = r#"fragment ThreadComment on PullRequestReviewComment {
  id
  author {
    __typename
    login
    avatarUrl
  }
  body
  createdAt
  lastEditedAt
  url
  viewerCanUpdate
  viewerCanDelete
  ...Reactions
}"#;

/// One page of review threads with their comments, and the people on the
/// review.
///
/// Only ten comments ride with each thread: a hundred threads times a
/// hundred comments made GitHub reserve 10,000 nested rows; a longer thread
/// is followed from its own cursor by [`review_thread_comments`].
/// Reviewers come from here because `reviewRequests` holds only requests
/// still outstanding; `latestReviews` adds back whoever already reviewed.
/// `viewer` rides along: GitHub names who reacted but never says whether
/// that is the reader. Commits use `last`, so past a hundred the newest are
/// kept.
pub fn review_threads() -> String {
    format!(
        r#"query ReviewThreads(
  $owner: String!
  $name: String!
  $number: Int!
  $after: String
  $requestedReviewers: Int!
) {{
  viewer {{ login }}
  repository(owner: $owner, name: $name) {{
    pullRequest(number: $number) {{
      reviewThreads(first: 100, after: $after) {{
        totalCount
        pageInfo {{ hasNextPage endCursor }}
        nodes {{
          id
          isResolved
          isOutdated
          path
          line
          diffSide
          viewerCanResolve
          viewerCanUnresolve
          comments(first: 10) {{
            totalCount
            pageInfo {{ hasNextPage endCursor }}
            nodes {{ ...ThreadComment }}
          }}
        }}
      }}
      viewerCanUpdate
      viewerDidAuthor
      author {{
        __typename
        login
        avatarUrl
      }}
      ...Reactions
      comments(first: 100) {{
        nodes {{
          id
          lastEditedAt
          author {{ __typename login avatarUrl }}
          ...Reactions
        }}
      }}
      reviews(first: 100) {{
        nodes {{
          id
          lastEditedAt
          author {{ __typename login avatarUrl }}
          ...Reactions
        }}
      }}
      reviewRequests(first: $requestedReviewers) {{
        nodes {{
          requestedReviewer {{
            __typename
            ... on User {{ login name avatarUrl }}
            ... on Bot {{ login avatarUrl }}
            ... on Team {{
              combinedSlug
              teamName: name
              teamAvatarUrl: avatarUrl
            }}
          }}
        }}
      }}
      latestReviews(first: 50) {{
        nodes {{
          state
          author {{ __typename login avatarUrl }}
        }}
      }}
      reviewDismissals: timelineItems(itemTypes: [REVIEW_DISMISSED_EVENT], first: 100) {{
        pageInfo {{ hasNextPage endCursor }}
        nodes {{
          ... on ReviewDismissedEvent {{
            dismissalMessage
            review {{ id }}
          }}
        }}
      }}
      commits(last: 100) {{
        nodes {{
          commit {{
            oid
            messageHeadline
            committedDate
            additions
            deletions
            parents(first: 1) {{ totalCount }}
            authors(first: 3) {{
              nodes {{
                name
                avatarUrl
                user {{ login }}
              }}
            }}
          }}
        }}
      }}
    }}
  }}
}}
{REACTIONS}
{THREAD_COMMENT}"#
    )
}

/// The rest of one thread's conversation. GraphQL pages a nested connection
/// only from the inner node itself. The pull request's id rides along so a
/// thread named for one pull request cannot be read on another's behalf.
pub fn review_thread_comments() -> String {
    format!(
        r#"query ReviewThreadComments(
  $owner: String!
  $name: String!
  $number: Int!
  $threadId: ID!
  $after: String
) {{
  viewer {{ login }}
  repository(owner: $owner, name: $name) {{
    pullRequest(number: $number) {{ id }}
  }}
  node(id: $threadId) {{
    __typename
    ... on PullRequestReviewThread {{
      pullRequest {{ id }}
      comments(first: 100, after: $after) {{
        pageInfo {{ hasNextPage endCursor }}
        nodes {{ ...ThreadComment }}
      }}
    }}
  }}
}}
{REACTIONS}
{THREAD_COMMENT}"#
    )
}

/// Dismissal events past the page the thread read carries. Followed only
/// while that page reports more.
pub const REVIEW_DISMISSALS: &str = r#"query ReviewDismissals($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      timelineItems(itemTypes: [REVIEW_DISMISSED_EVENT], first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          ... on ReviewDismissedEvent {
            dismissalMessage
            review { id }
          }
        }
      }
    }
  }
}"#;

/// A pull request's history, a page of events at a time.
pub const PULL_REQUEST_TIMELINE: &str = r#"query PullRequestTimeline($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      createdAt
      author { __typename login avatarUrl ... on User { name } }
      timelineItems(
        first: 100
        after: $after
        itemTypes: [
          PULL_REQUEST_COMMIT
          ISSUE_COMMENT
          PULL_REQUEST_REVIEW
          MERGED_EVENT
          CLOSED_EVENT
          REOPENED_EVENT
          HEAD_REF_FORCE_PUSHED_EVENT
          READY_FOR_REVIEW_EVENT
          CONVERT_TO_DRAFT_EVENT
          REVIEW_REQUESTED_EVENT
          HEAD_REF_DELETED_EVENT
          LABELED_EVENT
          UNLABELED_EVENT
        ]
      ) {
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on PullRequestCommit {
            id
            commit {
              oid
              messageHeadline
              committedDate
              authors(first: 3) { nodes { name avatarUrl user { login } } }
            }
          }
          ... on IssueComment {
            id
            body
            url
            createdAt
            author { __typename login avatarUrl }
          }
          ... on PullRequestReview {
            id
            state
            body
            url
            submittedAt
            createdAt
            author { __typename login avatarUrl }
          }
          ... on MergedEvent {
            id
            createdAt
            mergeRefName
            commit { oid }
            actor { __typename login avatarUrl }
          }
          ... on ClosedEvent { id createdAt actor { __typename login avatarUrl } }
          ... on ReopenedEvent { id createdAt actor { __typename login avatarUrl } }
          ... on HeadRefForcePushedEvent {
            id
            createdAt
            actor { __typename login avatarUrl }
            beforeCommit { oid }
            afterCommit { oid }
          }
          ... on ReadyForReviewEvent { id createdAt actor { __typename login avatarUrl } }
          ... on ConvertToDraftEvent { id createdAt actor { __typename login avatarUrl } }
          ... on ReviewRequestedEvent {
            id
            createdAt
            actor { __typename login avatarUrl }
            requestedReviewer {
              __typename
              ... on User { login avatarUrl }
              ... on Bot { login avatarUrl }
              ... on Team { combinedSlug teamName: name teamAvatarUrl: avatarUrl }
            }
          }
          ... on HeadRefDeletedEvent { id createdAt actor { __typename login avatarUrl } }
          ... on LabeledEvent {
            id
            createdAt
            actor { __typename login avatarUrl }
            label { name color }
          }
          ... on UnlabeledEvent {
            id
            createdAt
            actor { __typename login avatarUrl }
            label { name color }
          }
        }
      }
    }
  }
}"#;

/// A pull request's commits, oldest first, a page at a time, with the same
/// per-commit fields the review read carries.
pub const PULL_REQUEST_COMMITS: &str = r#"query PullRequestCommits($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          commit {
            oid
            messageHeadline
            committedDate
            additions
            deletions
            parents(first: 1) { totalCount }
            authors(first: 3) {
              nodes {
                name
                avatarUrl
                user { login }
              }
            }
          }
        }
      }
    }
  }
}"#;

/// Which files the signed-in account has cleared. GraphQL only: the REST
/// files endpoint the patch is read from carries no viewed state.
pub const PULL_REQUEST_FILES_VIEWED: &str = r#"query PullRequestFilesViewed($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      files(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          path
          viewerViewedState
        }
      }
    }
  }
}"#;

/// A listing row. `first` on the inner connections is a bound, not a page.
/// The checks verdict is GitHub's one-enum rollup for the head commit rather
/// than the check list (measured at a hundred rows: 15 KB against 425 KB).
const PULL_REQUEST_ROW: &str = r#"fragment PullRequestRow on PullRequest {
  number
  title
  url
  author {
    __typename
    login
    avatarUrl
    ... on User { name }
  }
  headRefName
  baseRefName
  isCrossRepository
  headRepository { nameWithOwner }
  state
  isDraft
  mergeable
  reviewDecision
  latestReviews(first: 20) {
    nodes {
      state
      author { login }
    }
  }
  additions
  deletions
  createdAt
  updatedAt
  mergedAt
  reviewRequests(first: 20) {
    nodes {
      requestedReviewer {
        ... on User { login }
        ... on Team { slug }
      }
    }
  }
  labels(first: 20) {
    nodes { name color }
  }
  comments { totalCount }
  commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup { state }
      }
    }
  }
}"#;

/// A repository's pull requests through GitHub's search, which is what makes
/// state, involvement and text filters one request. `$first` is at most 100:
/// `search` refuses anything larger.
pub fn pull_request_search() -> String {
    format!(
        r#"query PullRequestSearch($q: String!, $first: Int!, $after: String) {{
  search(query: $q, type: ISSUE, first: $first, after: $after) {{
    pageInfo {{ hasNextPage endCursor }}
    nodes {{ ...PullRequestRow }}
  }}
}}
{PULL_REQUEST_ROW}"#
    )
}

/// Pull requests by number, as listing rows: one aliased field per number
/// (`p0`, `p1`, …), so a sweep over a session's links is one request. A
/// number the repository does not have answers `null` under its alias.
pub fn pull_requests_by_number(numbers: &[u64]) -> String {
    let fields: String = numbers
        .iter()
        .enumerate()
        .map(|(ix, number)| {
            format!("    p{ix}: pullRequest(number: {number}) {{ ...PullRequestRow }}\n")
        })
        .collect();
    format!(
        r#"query PullRequestsByNumber($owner: String!, $name: String!) {{
  repository(owner: $owner, name: $name) {{
{fields}  }}
}}
{PULL_REQUEST_ROW}"#
    )
}

/// The pull request's own node id, which a mutation on it is addressed by.
pub const PULL_REQUEST_NODE_ID: &str = r#"query PullRequestNodeId($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { id }
  }
}"#;

/// Who may be asked for a review, and who already has been. `assignableUsers`
/// is everyone with write access, which is who GitHub accepts a request for;
/// the pull request's own requests mark the ones already asked, teams
/// included, so a request to a team can be taken back from the same list.
pub const PULL_REQUEST_REVIEWER_CANDIDATES: &str = r#"query PullRequestReviewerCandidates($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    assignableUsers(first: 100) {
      pageInfo { hasNextPage }
      nodes { login name avatarUrl }
    }
    pullRequest(number: $number) {
      author { login }
      reviewRequests(first: 50) {
        nodes {
          requestedReviewer {
            __typename
            ... on User { login name avatarUrl }
            ... on Team {
              slug
              combinedSlug
              teamName: name
              teamAvatarUrl: avatarUrl
            }
          }
        }
      }
    }
  }
}"#;

/// The repository's labels, by name, and which the pull request carries.
pub const PULL_REQUEST_LABEL_CANDIDATES: &str = r#"query PullRequestLabelCandidates($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    labels(first: 100, orderBy: { field: NAME, direction: ASC }) {
      pageInfo { hasNextPage }
      nodes { name color description }
    }
    pullRequest(number: $number) {
      labels(first: 100) { nodes { name } }
    }
  }
}"#;

/// Where a client-given subject actually hangs: the pull request itself, or
/// the pull request a comment, line comment or review belongs to. Read
/// before a reaction reaches it, so a subject named for one pull request
/// cannot write on another's behalf.
pub const PULL_REQUEST_SUBJECT: &str = r#"query PullRequestSubject($owner: String!, $name: String!, $number: Int!, $subjectId: ID!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { id }
  }
  node(id: $subjectId) {
    __typename
    id
    ... on IssueComment {
      pullRequest { id }
    }
    ... on PullRequestReviewComment {
      reviewCommentPullRequest: pullRequest { id }
    }
    ... on PullRequestReview {
      reviewPullRequest: pullRequest { id }
    }
    ... on PullRequestReviewThread {
      threadPullRequest: pullRequest { id }
    }
  }
}"#;

/// What merging and updating the branch read first: the head as it stands
/// now and whether a merge queue decides the merge.
pub const PULL_REQUEST_ACTION_STATE: &str = r#"query PullRequestActionState($owner: String!, $name: String!, $number: Int!, $headRef: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      headRefOid
      isMergeQueueEnabled
      mergeStateStatus
      baseRef {
        compare(headRef: $headRef) { behindBy }
      }
    }
  }
}"#;

/// What deleting a closed pull request's source branch reads first.
pub const PULL_REQUEST_BRANCH_TO_DELETE: &str = r#"query PullRequestBranchToDelete($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state
      headRefName
      baseRefName
      headRefOid
      headRepository { id }
    }
  }
}"#;

/// The source branch as its own repository holds it now, beside that
/// repository's default branch, so a branch that moved on, or is the
/// default, is never deleted.
pub const PULL_REQUEST_SOURCE_BRANCH: &str = r#"query PullRequestSourceBranch($repositoryId: ID!, $ref: String!) {
  node(id: $repositoryId) {
    __typename
    ... on Repository {
      defaultBranchRef { name }
      ref(qualifiedName: $ref) {
        target { oid }
      }
    }
  }
}"#;

/// What a merge that rewrites its message reads first: GitHub's own message
/// for the method, the head it was written for, and whether a merge queue
/// will choose its own message instead.
pub const PULL_REQUEST_MERGE_MESSAGE: &str = r#"query PullRequestMergeMessage(
  $owner: String!
  $name: String!
  $number: Int!
  $method: PullRequestMergeMethod!
) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      isMergeQueueEnabled
      headRefOid
      viewerMergeBodyText(mergeType: $method)
    }
  }
}"#;

/// Where a pull request's head lives now, read before workflow runs are
/// approved and again before each one: a push (or a repointed fork) between
/// the two must not have its runs approved unseen.
pub const PULL_REQUEST_WORKFLOW_HEAD: &str = r#"query PullRequestWorkflowHead($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state
      isCrossRepository
      headRefName
      headRefOid
      headRepositoryOwner { login }
    }
  }
}"#;

/// Open pull requests whose head branch has one name, from whichever
/// repository it lives in. A run is named by branch and commit only, so
/// approval first checks that exactly one open pull request is that head.
pub const PULL_REQUEST_HEADS: &str = r#"query PullRequestHeads($owner: String!, $name: String!, $head: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 100, after: $after, states: [OPEN], headRefName: $head) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        headRefOid
        isCrossRepository
        headRepositoryOwner { login }
      }
    }
  }
}"#;

// ── mutations ────────────────────────────────────────────────────────────

pub const ADD_REVIEW_THREAD_REPLY: &str = r#"mutation AddReviewThreadReply($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
    comment { id }
  }
}"#;

pub const ADD_REACTION: &str = r#"mutation AddReaction($subjectId: ID!, $content: ReactionContent!) {
  addReaction(input: { subjectId: $subjectId, content: $content }) {
    reaction { content }
  }
}"#;

pub const REMOVE_REACTION: &str = r#"mutation RemoveReaction($subjectId: ID!, $content: ReactionContent!) {
  removeReaction(input: { subjectId: $subjectId, content: $content }) {
    reaction { content }
  }
}"#;

pub const RESOLVE_REVIEW_THREAD: &str = r#"mutation ResolveReviewThread($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { isResolved }
  }
}"#;

pub const UNRESOLVE_REVIEW_THREAD: &str = r#"mutation UnresolveReviewThread($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) {
    thread { isResolved }
  }
}"#;

/// Rewrites the pull request's own words. A variable the request does not
/// send puts no entry in the input, which leaves that field as it was.
pub const UPDATE_PULL_REQUEST: &str = r#"mutation UpdatePullRequest($pullRequestId: ID!, $title: String, $body: String) {
  updatePullRequest(input: { pullRequestId: $pullRequestId, title: $title, body: $body }) {
    pullRequest { id }
  }
}"#;

pub const MERGE_PULL_REQUEST: &str = r#"mutation MergePullRequest($input: MergePullRequestInput!) {
  mergePullRequest(input: $input) { clientMutationId }
}"#;

pub const ENABLE_AUTO_MERGE: &str = r#"mutation EnablePullRequestAutoMerge($input: EnablePullRequestAutoMergeInput!) {
  enablePullRequestAutoMerge(input: $input) { clientMutationId }
}"#;

pub const DISABLE_AUTO_MERGE: &str = r#"mutation DisablePullRequestAutoMerge($pullRequestId: ID!) {
  disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) { clientMutationId }
}"#;

pub const UPDATE_PULL_REQUEST_BRANCH: &str = r#"mutation UpdatePullRequestBranch(
  $pullRequestId: ID!
  $expectedHeadOid: GitObjectID!
  $updateMethod: PullRequestBranchUpdateMethod!
) {
  updatePullRequestBranch(
    input: { pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid, updateMethod: $updateMethod }
  ) { clientMutationId }
}"#;

pub const MARK_READY_FOR_REVIEW: &str = r#"mutation MarkPullRequestReadyForReview($pullRequestId: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) { clientMutationId }
}"#;

pub const CONVERT_TO_DRAFT: &str = r#"mutation ConvertPullRequestToDraft($pullRequestId: ID!) {
  convertPullRequestToDraft(input: { pullRequestId: $pullRequestId }) { clientMutationId }
}"#;

pub const CLOSE_PULL_REQUEST: &str = r#"mutation ClosePullRequest($pullRequestId: ID!) {
  closePullRequest(input: { pullRequestId: $pullRequestId }) { clientMutationId }
}"#;

pub const REOPEN_PULL_REQUEST: &str = r#"mutation ReopenPullRequest($pullRequestId: ID!) {
  reopenPullRequest(input: { pullRequestId: $pullRequestId }) { clientMutationId }
}"#;

pub const ADD_COMMENT: &str = r#"mutation AddComment($subjectId: ID!, $body: String!) {
  addComment(input: { subjectId: $subjectId, body: $body }) { clientMutationId }
}"#;

/// Opens a new pull request that reverses a merged one.
pub const REVERT_PULL_REQUEST: &str = r#"mutation RevertPullRequest($pullRequestId: ID!) {
  revertPullRequest(input: { pullRequestId: $pullRequestId }) {
    revertPullRequest { number url }
  }
}"#;

/// The comment mutations each name their subject differently; the variable
/// is spelled the same in all of them, so a rewrite sends one set of
/// variables whichever kind of remark it is.
pub const UPDATE_ISSUE_COMMENT: &str = r#"mutation UpdateIssueComment($commentId: ID!, $body: String!) {
  updateIssueComment(input: { id: $commentId, body: $body }) {
    issueComment { id }
  }
}"#;

pub const UPDATE_REVIEW_COMMENT: &str = r#"mutation UpdateReviewComment($commentId: ID!, $body: String!) {
  updatePullRequestReviewComment(input: { pullRequestReviewCommentId: $commentId, body: $body }) {
    pullRequestReviewComment { id }
  }
}"#;

pub const UPDATE_REVIEW: &str = r#"mutation UpdateReview($commentId: ID!, $body: String!) {
  updatePullRequestReview(input: { pullRequestReviewId: $commentId, body: $body }) {
    pullRequestReview { id }
  }
}"#;

pub const DELETE_ISSUE_COMMENT: &str = r#"mutation DeleteIssueComment($commentId: ID!) {
  deleteIssueComment(input: { id: $commentId }) { clientMutationId }
}"#;

pub const DELETE_REVIEW_COMMENT: &str = r#"mutation DeleteReviewComment($commentId: ID!) {
  deletePullRequestReviewComment(input: { id: $commentId }) { clientMutationId }
}"#;

/// Deletes a branch only while it still points at `beforeOid`.
pub const DELETE_PULL_REQUEST_BRANCH: &str = r#"mutation DeletePullRequestBranch($input: UpdateRefsInput!) {
  updateRefs(input: $input) { clientMutationId }
}"#;

/// Clears or restores a burst of files in one request. GitHub has no bulk
/// form of `markFileAsViewed`/`unmarkFileAsViewed`, so each file runs under
/// its own alias; top-level mutation fields run in order, so the last word
/// about a path is the one that sticks.
pub fn set_files_viewed(viewed: &[bool]) -> String {
    let mut params = String::from("$pullRequestId: ID!");
    let mut fields = String::new();
    for (i, &v) in viewed.iter().enumerate() {
        params.push_str(&format!(", $path{i}: String!"));
        let mutation = if v {
            "markFileAsViewed"
        } else {
            "unmarkFileAsViewed"
        };
        fields.push_str(&format!(
            "  f{i}: {mutation}(input: {{ pullRequestId: $pullRequestId, path: $path{i} }}) {{ clientMutationId }}\n"
        ));
    }
    format!("mutation SetFilesViewed({params}) {{\n{fields}}}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every document is balanced and names every fragment it spreads.
    fn well_formed(doc: &str) {
        let opens = doc.matches('{').count();
        let closes = doc.matches('}').count();
        assert_eq!(opens, closes, "unbalanced braces in:\n{doc}");
        for spread in doc.split("...").skip(1) {
            let name: String = spread
                .trim_start()
                .chars()
                .take_while(|c| c.is_alphanumeric())
                .collect();
            if name == "on" || name.is_empty() {
                continue;
            }
            assert!(
                doc.contains(&format!("fragment {name} on")),
                "fragment {name} is spread but not defined"
            );
        }
    }

    #[test]
    fn every_document_is_well_formed() {
        for doc in [
            REPOSITORY_CONTEXT.to_string(),
            pull_request_core(),
            pull_request_check_contexts(),
            PULL_REQUEST_ACTIVITY.to_string(),
            review_threads(),
            review_thread_comments(),
            REVIEW_DISMISSALS.to_string(),
            PULL_REQUEST_TIMELINE.to_string(),
            PULL_REQUEST_COMMITS.to_string(),
            PULL_REQUEST_FILES_VIEWED.to_string(),
            pull_request_search(),
            PULL_REQUEST_NODE_ID.to_string(),
            PULL_REQUEST_SUBJECT.to_string(),
            PULL_REQUEST_REVIEWER_CANDIDATES.to_string(),
            PULL_REQUEST_LABEL_CANDIDATES.to_string(),
            PULL_REQUEST_ACTION_STATE.to_string(),
            PULL_REQUEST_BRANCH_TO_DELETE.to_string(),
            PULL_REQUEST_SOURCE_BRANCH.to_string(),
            UPDATE_PULL_REQUEST_BRANCH.to_string(),
            PULL_REQUEST_MERGE_MESSAGE.to_string(),
            PULL_REQUEST_WORKFLOW_HEAD.to_string(),
            PULL_REQUEST_HEADS.to_string(),
            REVERT_PULL_REQUEST.to_string(),
            UPDATE_ISSUE_COMMENT.to_string(),
            UPDATE_REVIEW_COMMENT.to_string(),
            UPDATE_REVIEW.to_string(),
            DELETE_ISSUE_COMMENT.to_string(),
            DELETE_REVIEW_COMMENT.to_string(),
            set_files_viewed(&[true, false]),
            pull_requests_by_number(&[12, 7]),
        ] {
            well_formed(&doc);
        }
    }

    #[test]
    fn pull_requests_by_number_aliases_each_number_in_order() {
        let doc = pull_requests_by_number(&[12, 7]);
        assert!(doc.contains("p0: pullRequest(number: 12) { ...PullRequestRow }"));
        assert!(doc.contains("p1: pullRequest(number: 7) { ...PullRequestRow }"));
        assert!(doc.contains("comments { totalCount }"));
        // What the branch sweep tells a fork's same-named branch apart by.
        assert!(doc.contains("isCrossRepository"));
        assert!(doc.contains("headRepository { nameWithOwner }"));
    }

    #[test]
    fn files_viewed_aliases_each_file_with_its_own_mutation() {
        let doc = set_files_viewed(&[true, false]);
        assert!(doc.contains("$path0: String!, $path1: String!"));
        assert!(doc.contains(
            "f0: markFileAsViewed(input: { pullRequestId: $pullRequestId, path: $path0 })"
        ));
        assert!(doc.contains(
            "f1: unmarkFileAsViewed(input: { pullRequestId: $pullRequestId, path: $path1 })"
        ));
    }
}
