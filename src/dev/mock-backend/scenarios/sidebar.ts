// The sidebar at scale: eight projects and about 1,200 sessions across them,
// in every state the list draws — pinned (in their fractional-key order),
// active, unread, woke from a snooze, snoozed (on their own shelf), running in
// another process, on a branch with a pull request, shared with the team (with
// comments), and a long Settled shelf.
//
// Generated deterministically (a seeded PRNG), so screenshots compare. The
// lifecycle commands are the shared fake (`session-lifecycle.ts`), so pin,
// settle, snooze, rename and mark-unread behave as Rust's store does.

import { emit } from "@tauri-apps/api/event";
import type { ResumedThread, ThreadProject, ThreadRow } from "@/features/chat/lib/history-api";
import type { Comment, CommentThreads } from "@/features/artifacts/lib/comments-api";
import type { Project } from "@/features/projects/stores/project-store";
import type { Scenario } from "../types";
import { MOCK_ORG_ID, MOCK_PROJECT, appState } from "../project";
import { adoptSession } from "../fake-agent";
import { sessionLifecycleHandlers, withDerivedLifecycle } from "../session-lifecycle";
import { fixtureLink, sessionPullRequestHandlers } from "../session-pull-requests";

const PROJECT_NAMES = [
  "acme-app",
  "billing-service",
  "design-system",
  "mobile-shell",
  "data-pipeline",
  "infra-terraform",
  "docs",
  "acme-platform-migration-experiments",
];

const PROJECTS: Project[] = PROJECT_NAMES.map((name, i) =>
  i === 0
    ? MOCK_PROJECT
    : { id: `ws-side-${i}`, name, path: `/Users/dev/${name}`, orgId: MOCK_ORG_ID },
);

const AGENTS = ["atlas-agent", "claude-acp", "codex-acp", "opencode", "cursor"];
const BRANCHES = [
  "main",
  "feat/discount-codes",
  "fix/session-restore",
  "chore/bump-deps",
  "feat/v2-users",
  "refactor/billing-ledger",
  null,
];
const MODELS = ["Claude Sonnet 4.5", "Claude Opus 4.1", "GPT-5 Codex", "Gemini 2.5 Pro", null];
const VERBS = ["Fix", "Add", "Refactor", "Investigate", "Document", "Port", "Speed up", "Remove"];
const THINGS = [
  "the checkout total rounding",
  "retry on 5xx in the API client",
  "flaky snapshot tests",
  "dark-mode tokens for the toast",
  "the invoice PDF renderer",
  "session restore after a crash",
  "pagination in the admin table",
  "the Terraform state lock",
  "a slow query on the orders page",
  "the onboarding empty state",
  "webhook signature checks",
  "the ingest backfill job",
];

/** mulberry32: small, seedable, good enough for fixtures. */
function prng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const COUNT = 1_200;

function generate(): ThreadRow[] {
  const rand = prng(42);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const rows: ThreadRow[] = [];
  for (let i = 0; i < COUNT; i++) {
    // Skewed towards the first projects, as real use is.
    const project = PROJECTS[Math.min(PROJECTS.length - 1, Math.floor(rand() ** 1.6 * 8))]!;
    // Most recent first: row 0 is minutes old, the tail is months.
    const updated = now - Math.floor(i ** 1.35 * 9 * MINUTE + rand() * 20 * MINUTE);
    const branch = pick(BRANCHES);
    const row: ThreadRow = {
      threadId: `side-${String(i).padStart(4, "0")}`,
      sessionId: `side-sess-${i}`,
      agentId: pick(AGENTS),
      title: `${pick(VERBS)} ${pick(THINGS)}`,
      updatedAt: iso(updated),
      createdAt: iso(updated - Math.floor(rand() * 3 * HOUR)),
      settledAt: null,
      pinnedAt: null,
      pinOrder: null,
      snoozedUntil: null,
      snoozedAt: null,
      lastSnoozeWakeAt: null,
      lastViewedAt: iso(updated + MINUTE),
      lastTurnCompletedAt: iso(updated),
      unread: false,
      woke: false,
      projectName: project.name,
      folderPaths: [project.path],
      liveElsewhere: false,
      heldWorking: false,
      attachedProjects: [],
      pullRequests: [],
      forkedFromSessionId: null,
      branch,
      // Not drawn from the PRNG, so adding it moved no other fixture value.
      model: MODELS[i % MODELS.length] ?? null,
    };
    // Older than two weeks and not otherwise marked: settled (the idle sweep).
    if (now - updated > 14 * DAY && rand() < 0.85) row.settledAt = iso(updated + 3 * DAY);
    rows.push(row);
  }
  // Hand-placed states near the top, where a screenshot sees them.
  const at = (i: number) => rows[i]!;
  // Pinned, in key order a0 < a1 < a2 (one keyless, sorted after).
  for (const [i, key] of [
    [14, "a0"],
    [40, "a1"],
    [3, "a2"],
    [70, null],
  ] as const) {
    at(i).pinnedAt = new Date(now - i * HOUR).toISOString();
    at(i).pinOrder = key;
    at(i).settledAt = null;
  }
  // Unread: a turn finished after the last look.
  for (const i of [0, 5, 9, 22]) at(i).lastViewedAt = at(i).createdAt;
  // Woke from a snooze, not looked at since.
  at(2).lastSnoozeWakeAt = iso(now - 20 * MINUTE);
  at(2).lastViewedAt = iso(now - 2 * HOUR);
  at(11).lastSnoozeWakeAt = iso(now - 5 * MINUTE);
  at(11).lastViewedAt = iso(now - DAY);
  // Snoozed: on the Snoozed shelf until they wake (one wakes two minutes in).
  for (const [i, ms] of [
    [1, 2 * MINUTE],
    [6, 3 * HOUR],
    [17, 2 * DAY],
  ] as const) {
    at(i).snoozedAt = iso(now - HOUR);
    at(i).snoozedUntil = iso(now + ms);
  }
  // Running in another process (a terminal): the list shows it working.
  at(4).liveElsewhere = true;
  at(14).liveElsewhere = true;
  // Linked pull requests: three on the top row (opened from it, found on
  // its branch, linked by hand), one merged and one draft further down.
  at(0).pullRequests = [
    fixtureLink(412, "created", iso(now - 3 * HOUR)),
    fixtureLink(405, "detected", iso(now - 2 * HOUR)),
    fixtureLink(398, "manual", iso(now - HOUR)),
  ];
  at(3).pullRequests = [fixtureLink(398, "detected", iso(now - DAY))];
  at(5).pullRequests = [fixtureLink(401, "agent", iso(now - 4 * HOUR))];
  // A long title, to see truncation.
  at(7).title =
    "Investigate why the nightly ingest backfill double-counts refunds when a partial capture is retried across midnight UTC";
  return rows.map(withDerivedLifecycle);
}

let threads: ThreadRow[] = [];

/** Sessions shared with the team, and how many comments each has: the hover
 *  card reads both without the session being open. */
const SHARED: Record<string, number> = { "side-sess-0": 3, "side-sess-3": 0, "side-sess-14": 1 };

function sharedComments(sessionId: string): CommentThreads {
  const count = SHARED[sessionId] ?? 0;
  const session: Comment[] = Array.from({ length: count }, (_, i) => ({
    id: `${sessionId}-c${i}`,
    sessionId,
    anchorKind: "session",
    anchorId: sessionId,
    parentId: null,
    authorId: "user-mock",
    guestName: null,
    body: "Looks good",
    mentions: [],
    createdAt: new Date(Date.now() - i * HOUR).toISOString(),
    editedAt: null,
    deletedAt: null,
    resolvedAt: null,
    resolvedBy: null,
  }));
  return { byAnchor: {}, session };
}

function threadsChanged(): void {
  void emit("atlas:threads-changed");
}

function threadProjects(cwd: string | null): ThreadProject[] {
  const byProject = new Map<string, ThreadRow[]>();
  for (const thread of threads) {
    const rows = byProject.get(thread.projectName) ?? [];
    rows.push(thread);
    byProject.set(thread.projectName, rows);
  }
  const scoped = cwd !== null && cwd !== "";
  return [...byProject]
    .filter(([, rows]) => !scoped || rows.some((row) => row.folderPaths.includes(cwd)))
    .map(([name, rows]) => ({
      name,
      paths: [...new Set(rows.flatMap((row) => row.folderPaths))],
      isCurrent: scoped,
      threads: rows,
    }));
}

export const sidebar: Scenario = {
  name: "sidebar",
  description:
    "Eight projects, ~1,200 sessions in every sidebar state: pinned, woke, unread, snoozed, settled.",
  init: () => {
    threads = generate();
  },
  rawCommands: {
    bootstrap_app_state: () => appState({ workspaces: PROJECTS }),
    threads_history: (): ThreadRow[] => threads,
    threads_sync_project: () => 0,
    chat_comment_target: ({ nativeSessionId }) =>
      String(nativeSessionId) in SHARED
        ? { remoteProjectId: "rw-side", sessionId: String(nativeSessionId), entries: [] }
        : null,
    artifacts_cloud_comments: ({ sessionId }): CommentThreads => sharedComments(String(sessionId)),
    threads_projects: ({ cwd }): ThreadProject[] =>
      threadProjects(cwd === null || cwd === undefined ? null : String(cwd)),
    threads_resume: ({ threadId }): ResumedThread => {
      const thread = threads.find((candidate) => candidate.threadId === String(threadId));
      if (!thread) throw new Error(`no such thread: ${String(threadId)}`);
      const key = { agent_id: thread.agentId, session_id: thread.sessionId ?? thread.threadId };
      adoptSession(key, thread.agentId, thread.folderPaths[0] ?? "");
      return { key, resumedWithoutHistory: thread.agentId !== "atlas-agent" };
    },
    threads_delete: ({ threadId }): null => {
      threads = threads.filter((thread) => thread.threadId !== String(threadId));
      threadsChanged();
      return null;
    },
    ...sessionLifecycleHandlers({
      get: () => threads,
      set: (rows) => {
        threads = rows;
      },
      changed: threadsChanged,
    }),
    ...sessionPullRequestHandlers({
      get: () => threads,
      set: (rows) => {
        threads = rows;
      },
      changed: threadsChanged,
    }),
  },
};
