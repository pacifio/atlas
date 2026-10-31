// The pull-request surface tab, opened beside the session on load.
//
//  - `pull-request` — number 420: 300 comments, 100 checks and a long history
//    (label runs, review requests, a draft round trip, force-pushes, a close and
//    reopen, a dismissed review), for paging and scale;
//  - `pull-request-review` — number 412: changes requested, threads, behind its base;
//  - `pull-request-merged` — number 398; `pull-request-draft` — number 405;
//    `pull-request-conflict` — number 401, conflicting with a failing check;
//  - `pull-request-file-chips` — number 431: a body that names files in a
//    table, in code spans and in a code block, with hostile paths beside them;
//  - `pull-request-not-installed`, `-signed-out`, `-rate-limited`, `-offline`
//    — every read fails the way `gh` would, for the unavailable states;
//  - `pull-request-list` — the repository's list tab over about 150 pull
//    requests across Authored, Review requested and Others, every state, paged;
//    the sidebar's top session has three linked (created, detected, manual);
//    `pull-request-list-signed-out` is the list with `gh` signed out;
//  - `session-pull-requests` — the top session's pull request panel: three
//    linked, number 412 watched, number 405 chained on number 412's branch.
//
// Writes are real for the page's life (see `fixtures/pull-requests.ts`). The
// agent actions work too: Fix and Explain open a session with the task in its
// composer, and Write guide gets the fixture tour back (number 412 starts with one).

import type { PrError } from "@/features/pull-requests/lib/pull-requests-types";
import type { Scenario } from "../types";
import {
  answerGuidePrompt,
  crowdPullRequestList,
  failPullRequestReads,
} from "../fixtures/pull-requests";
import { setPromptHandler } from "../fake-agent";
import { MOCK_PROJECT } from "../project";

function pullRequestScenario(
  name: string,
  description: string,
  number: number,
  failure: PrError | null = null,
): Scenario {
  return {
    name,
    description,
    init: () => {
      failPullRequestReads(failure);
      // "Write guide" sends its prompt to a background session; answer it.
      setPromptHandler(answerGuidePrompt);
    },
    setup: async () => {
      const { openPullRequestTab } =
        await import("@/features/pull-requests/lib/open-pull-request-tab");
      openPullRequestTab({ repoPath: MOCK_PROJECT.path, number });
    },
    actions: {
      /** Let reads through again, as after `gh auth login`; then press Retry. */
      recover: () => failPullRequestReads(null),
    },
  };
}

export const pullRequest = pullRequestScenario(
  "pull-request",
  "A pull request tab on a long one: 300 comments, 100 checks, a long timeline.",
  420,
);
export const pullRequestReview = pullRequestScenario(
  "pull-request-review",
  "A pull request with changes requested, review threads, and a stale base.",
  412,
);
export const pullRequestMerged = pullRequestScenario(
  "pull-request-merged",
  "A merged pull request.",
  398,
);
export const pullRequestDraft = pullRequestScenario(
  "pull-request-draft",
  "A draft pull request with no checks.",
  405,
);
export const pullRequestConflict = pullRequestScenario(
  "pull-request-conflict",
  "A pull request that conflicts with its base.",
  401,
);
export const pullRequestFileChips = pullRequestScenario(
  "pull-request-file-chips",
  "A body naming files in a table and code spans: chips for the changed files and the checkout, collapse and copy on blocks, and hostile paths left as code.",
  431,
);
export const pullRequestNotInstalled = pullRequestScenario(
  "pull-request-not-installed",
  "The pull request tab without the GitHub CLI.",
  412,
  { kind: "notInstalled" },
);
export const pullRequestSignedOut = pullRequestScenario(
  "pull-request-signed-out",
  "The pull request tab with gh signed out.",
  412,
  { kind: "notAuthenticated" },
);
export const pullRequestRateLimited = pullRequestScenario(
  "pull-request-rate-limited",
  "The pull request tab past GitHub's rate limit.",
  412,
  { kind: "rateLimited", retryAt: Date.now() + 7 * 60_000 },
);
export const pullRequestOffline = pullRequestScenario(
  "pull-request-offline",
  "The pull request tab with GitHub unreachable.",
  412,
  { kind: "network" },
);

function pullRequestListScenario(
  name: string,
  description: string,
  failure: PrError | null = null,
): Scenario {
  return {
    name,
    description,
    init: () => {
      crowdPullRequestList(true);
      failPullRequestReads(failure);
    },
    setup: async () => {
      const { openPullRequestListTab } =
        await import("@/features/pull-requests/lib/open-pull-request-list-tab");
      openPullRequestListTab({ repoPath: MOCK_PROJECT.path, name: MOCK_PROJECT.name });
    },
    actions: {
      recover: () => failPullRequestReads(null),
    },
  };
}

export const pullRequestList = pullRequestListScenario(
  "pull-request-list",
  "The repository's pull request list: ~150 across every group and state, paged and virtualized.",
);
export const pullRequestListSignedOut = pullRequestListScenario(
  "pull-request-list-signed-out",
  "The pull request list with gh signed out.",
  { kind: "notAuthenticated" },
);

/** The top session's pull request panel (`session-pull-requests:th-01`):
 *  three linked, number 412 watched and number 405 chained on it. */
export const sessionPullRequests: Scenario = {
  name: "session-pull-requests",
  description:
    "The top session's pull request panel: three linked, one watched, two chained by base branch.",
  setup: async () => {
    const { openSessionPullRequestsTab } =
      await import("@/features/pull-requests/lib/open-session-pull-requests-tab");
    openSessionPullRequestsTab({
      threadId: "th-01",
      cwd: MOCK_PROJECT.path,
      title: "Move the user reads onto /v2 and keep the retry helper",
    });
  },
};

export const pullRequestScenarios: Scenario[] = [
  sessionPullRequests,
  pullRequestList,
  pullRequestListSignedOut,
  pullRequest,
  pullRequestReview,
  pullRequestMerged,
  pullRequestDraft,
  pullRequestConflict,
  pullRequestFileChips,
  pullRequestNotInstalled,
  pullRequestSignedOut,
  pullRequestRateLimited,
  pullRequestOffline,
];
