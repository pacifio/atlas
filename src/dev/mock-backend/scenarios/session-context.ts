// The session Details card with every section filled: a feature branch with an
// upstream, three pull requests from it (the open one with passing checks,
// then a merged and a closed one behind "Show 2 more"), two project scripts,
// and a session that was branched from another and has two branches of its
// own. That session is the chat the app opens on, seeded with a short
// transcript (a resumed thread does not replay here), and the lineage rows
// hang off whatever id the fake agent mints for it. The header's ≡ button
// toggles the card: docked beside the transcript on a wide window, a popover
// on a narrow one.

import type { ThreadRow } from "@/features/chat/lib/history-api";
import { RESTING_LIFECYCLE } from "@/features/chat/lib/session-lifecycle";
import type { PrListEntry, PrState } from "@/features/pull-requests/lib/pull-requests-types";
import type { Scenario } from "../types";
import { text, user, t } from "../fixtures/chat";
import { seedCurrentBranch } from "../fixtures/git";
import { miscHandlers } from "../fixtures/misc";
import { pullRequestsHandlers } from "../fixtures/pull-requests";
import { setSessionSeeder } from "../fake-agent";
import { MOCK_PROJECT } from "../project";

const BRANCH = "fix/pdf-annotations";
const PARENT = "sess-pdf-root";
const TITLE = "Why does the PDF highlight drift after a rotate?";

/** The opened session's id, once the fake agent has minted it. */
let live: string | null = null;

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function pr(
  number: number,
  title: string,
  state: PrState,
  updatedHoursAgo: number,
  checksState: PrListEntry["checksState"],
): PrListEntry {
  return {
    number,
    title,
    url: `https://github.com/northwind/shop/pull/${number}`,
    author: { login: "mara-k", name: "Mara Kovač", avatarUrl: null, isBot: false },
    headBranch: BRANCH,
    baseBranch: "main",
    state,
    isDraft: false,
    mergeability: "mergeable",
    additions: 48,
    deletions: 12,
    createdAt: hoursAgo(updatedHoursAgo + 20),
    updatedAt: hoursAgo(updatedHoursAgo),
    mergedAt: state === "merged" ? hoursAgo(updatedHoursAgo) : null,
    viewerReviewRequested: false,
    labels: [],
    reviewDecision: null,
    checksState,
    commentCount: 0,
  };
}

const PULLS: PrListEntry[] = [
  pr(431, "fix(pdf): keep highlight rects on rotate", "open", 1, "passing"),
  pr(418, "fix(pdf): rotate the annotation layer with the page", "merged", 52, null),
  pr(409, "spike: redraw highlights after every transform", "closed", 120, null),
];

function thread(sessionId: string, title: string, hours: number, parent: string | null): ThreadRow {
  return {
    threadId: `th-${sessionId}`,
    sessionId,
    agentId: "claude-code",
    title,
    updatedAt: hoursAgo(hours),
    createdAt: hoursAgo(hours + 1),
    ...RESTING_LIFECYCLE,
    projectName: MOCK_PROJECT.name,
    folderPaths: [MOCK_PROJECT.path],
    liveElsewhere: false,
    heldWorking: false,
    pullRequests: [],
    forkedFromSessionId: parent,
    attachedProjects: [],
    model: "Claude Sonnet 4.5",
    branch: BRANCH,
  };
}

/** The base rows, with the opened session's lineage around it. */
function historyWithLineage(): ThreadRow[] {
  const base = miscHandlers.threads_history({}) as ThreadRow[];
  if (!live) return base;
  return [
    ...base,
    thread(live, TITLE, 0, PARENT),
    thread(PARENT, "Reproduce the PDF highlight drift on a rotated page", 30, null),
    thread("sess-pdf-matrix", "Try the transform-matrix fix instead", 2, live),
    thread("sess-pdf-test", "Write the rotate regression test", 4, live),
  ];
}

const transcript = [
  user(TITLE, t(0)),
  text(
    "The highlight rects are stored in page space but drawn after the viewport rotation, so they are rotated twice. I moved the transform onto the annotation layer and added a test that rotates a page with a highlight on it.",
    t(20),
  ),
  // Three turns, so the turn rail (two or more) hangs in the gutter too.
  user("Does it hold for a page rotated twice?", t(60)),
  text(
    "Yes: the layer takes the page's net rotation, so 180° reads the same as two 90° turns. The test now covers both.",
    t(80),
  ),
  user("Open a PR for it.", t(120)),
  text("Pushed the branch and opened pull request 431 against main.", t(140)),
];

export const sessionContext: Scenario = {
  name: "session-context",
  description: "The session Details card, every section filled: PRs, scripts, lineage.",
  init: () => {
    seedCurrentBranch(BRANCH);
    live = null;
    // The first session opens on the transcript; any later one starts empty.
    setSessionSeeder((info) => {
      if (live) return null;
      live = info.sessionId;
      return transcript;
    });
  },
  commands: {
    // The branch's own pull requests; every other list is the fixture's.
    pr_list: async (args) => {
      const base = await pullRequestsHandlers.pr_list(args);
      const query = (args.query ?? {}) as { head?: string | null };
      return query.head === BRANCH ? { ...base, entries: PULLS, nextCursor: null } : base;
    },
  },
  rawCommands: {
    threads_history: historyWithLineage,
  },
};
