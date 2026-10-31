// The pull-request surface (`commands/pull_requests`), faked for a browser.
//
// One fake repository, `northwind/northwind-shop`, answered for every
// checkout so the surface can be built against any scenario. Its pull
// requests are picked to cover the states the UI has to draw:
//
//  - #412 — open and big: 140 files across two pages of the files API, its
//    whole patch past what the host sends in one piece, failing and pending
//    checks, review threads (one resolved, one outdated, one past the first
//    page of comments) and changes requested;
//  - #398 — merged, approved, every check green, a timeline to page through;
//  - #405 — a draft, no checks yet, a team asked to review;
//  - #401 — open with a merge conflict and a failing required check;
//  - #377 — closed without merging;
//  - #420 — open and long: 300 comments and 100 checks, for the Summary's
//    paging, the checks list and the Timeline at scale (labels, force-pushes,
//    a close and reopen, a dismissed review).
//
// Writes are real for the life of the page: ticking a file viewed, resolving
// a thread, reacting, commenting and merging all change the next read. Like
// Rust, a failure rejects with a `PrError` object.

import type {
  PrActivity,
  PrActor,
  PrCapabilities,
  PrCheck,
  PrCheckLog,
  PrComment,
  PrCommit,
  PrCommitsPage,
  PrCreated,
  PrCreateDraft,
  PrDetail,
  PrDiffFile,
  PrDiffFileContents,
  PrDiffResult,
  PrError,
  PrFilesViewed,
  PrFileViewed,
  PrImage,
  PrLabelCandidates,
  PrListEntry,
  PrListResult,
  PrListStat,
  PrProvider,
  PrReaction,
  PrReactionContent,
  PrReverted,
  PrReviewerCandidates,
  PrReviewThread,
  PrThreadComment,
  PrThreadCommentsPage,
  PrTimelineItem,
  PrTimelinePage,
  PrViewerPermissions,
} from "@/features/pull-requests/lib/pull-requests-types";
import type { PrCheckout } from "@/features/pull-requests/lib/pull-requests-api";
import type {
  GeneratedGuide,
  GuideChange,
  GuideCheckout,
} from "@/features/pull-requests/lib/pull-request-guide-types";
import type { MockArgs, TypedHandlers, Unit } from "../types";
import { setStatus, streamText } from "../fake-agent";
import { mockCurrentBranchName } from "./git";

function fail(error: PrError): never {
  throw error;
}

const NOW = Date.parse("2026-10-20T15:00:00Z");
const HOUR = 3_600_000;
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();

const REPOSITORY = "northwind/northwind-shop";
const URL_BASE = `https://github.com/${REPOSITORY}/pull`;
const avatar = (id: number) => `https://avatars.githubusercontent.com/u/${id}?v=4`;

const actor = (login: string, name: string | null, id: number, isBot = false): PrActor => ({
  login,
  name,
  avatarUrl: avatar(id),
  isBot,
});

const VIEWER = actor("mara-k", "Mara Kovač", 1001);
const DEV = actor("theo-r", "Theo Ruiz", 1002);
const REVIEWER = actor("ines-p", "Inês Pereira", 1003);
const BOT = actor("northwind-ci", null, 1004, true);

const CAPABILITIES: PrCapabilities = {
  diff: true,
  comment: true,
  actions: [
    "merge",
    "ready",
    "draft",
    "close",
    "reopen",
    "delete-branch",
    "update-branch",
    "enable-auto-merge",
    "disable-auto-merge",
    "revert",
    "approve-workflows",
  ],
  mergeMethods: ["merge", "squash", "rebase"],
  deleteBranch: true,
  updateMethods: ["merge", "rebase"],
  search: true,
  reactions: true,
  viewedFiles: "host",
  review: {
    inlineComment: true,
    reply: true,
    resolve: true,
    verdicts: ["comment", "approve", "request-changes"],
  },
  reviewers: { request: true, listCandidates: true },
  edit: { changeRequest: true, comment: false },
  labels: true,
  fileContents: true,
  conditionalReads: true,
};

const PROVIDER: PrProvider = {
  kind: "github",
  host: "github.com",
  repository: REPOSITORY,
  viewer: VIEWER.login,
  capabilities: CAPABILITIES,
};

function permissions(open: boolean, authored: boolean): PrViewerPermissions {
  return {
    actions: open
      ? [
          "merge",
          "enable-auto-merge",
          "disable-auto-merge",
          "ready",
          "draft",
          "close",
          "update-branch",
        ]
      : ["delete-branch", "reopen"],
    comment: true,
    resolve: true,
    verdicts: authored ? ["comment"] : ["comment", "approve", "request-changes"],
    requestReviewers: true,
    updateMethods: open ? ["merge", "rebase"] : [],
    labels: true,
    editChangeRequest: true,
    canMerge: open,
  };
}

const check = (
  name: string,
  status: PrCheck["status"],
  minutes: number | null,
  extra: Partial<PrCheck> = {},
): PrCheck => ({
  name,
  status,
  description: null,
  // An Actions job link, so "View log" has a log to read.
  url: `https://github.com/${REPOSITORY}/actions/runs/${name.length * 7919}/job/${name.length * 104_729}`,
  required: null,
  workflow: "CI",
  startedAt: iso(2),
  completedAt: minutes === null ? null : iso(2 - minutes / 60),
  durationMs: minutes === null ? null : minutes * 60_000,
  ...extra,
});

// ── the pull requests ───────────────────────────────────────────────────────

interface FakePull {
  detail: PrDetail;
  entry: PrListEntry;
}

function pull(
  detail: Omit<PrDetail, "capabilities" | "repository" | "url" | "viewer" | "mergeCapabilities">,
): FakePull {
  const full: PrDetail = {
    ...detail,
    capabilities: CAPABILITIES,
    repository: REPOSITORY,
    url: `${URL_BASE}/${detail.number}`,
    viewer: VIEWER.login,
    mergeCapabilities: { merge: true, squash: true, rebase: false },
  };
  return {
    detail: full,
    entry: {
      number: full.number,
      title: full.title,
      url: full.url,
      author: full.author,
      headBranch: full.headBranch,
      baseBranch: full.baseBranch,
      state: full.state,
      isDraft: full.isDraft,
      mergeability: full.mergeability,
      additions: full.additions,
      deletions: full.deletions,
      createdAt: full.createdAt,
      updatedAt: full.updatedAt,
      mergedAt: full.mergedAt,
      viewerReviewRequested: full.reviewers.some(
        (r) => r.actor.login === VIEWER.login && r.state === "requested",
      ),
      labels: full.labels,
      reviewDecision: full.reviewDecision,
      checksState: full.checksState,
      commentCount: full.number % 7,
    },
  };
}

const BIG_FILES = 140;

/** #431's changed files: named in its body, so its chips open the Code tab. */
const FILE_CHIPS_CHANGED = [
  "config.default.toml",
  "crates/atlas-settings/settings-registry.toml",
  "crates/atlas-settings/src/settings_docs.gen.rs",
  "docs/reference/configuration.md",
  "docs/settings.json",
  "src/features/settings/lib/settings-registry.gen.ts",
];

/** #431's body: file names in prose, in a table, in a code block, and the
 *  paths a hostile body would try, which must stay plain code. */
const FILE_CHIPS_BODY = [
  "## What?",
  "",
  "`crates/atlas-settings/settings-registry.toml` is now the one hand-edited description of every key under `[settings]` in `config.toml`: type, default, bounds or values, status (`live` / `elsewhere` / `file-only` / `internal` / `legacy`), and the page, section, title and summary the Settings UI will render. `bun run settings:gen` writes everything derived from it:",
  "",
  "| Output | What it is |",
  "| --- | --- |",
  "| `crates/atlas-settings/src/settings_docs.gen.rs` | `SETTINGS_DOCS`, the comment above each key in a generated `config.toml` |",
  "| `src/features/settings/lib/settings-registry.gen.ts` | TS `AppSettings`, `DEFAULT_SETTINGS`, and per-key metadata; `app-settings.ts` re-exports them instead of a hand-written mirror |",
  "| `settings.json` | the same metadata for the docs site (`bun run sync:settings` in docs-atlas) |",
  "| `docs/reference/configuration.md` | the schema table, between `generated:settings` markers |",
  "",
  "The whole file a fresh install gets is committed as `config.default.toml`, so a change to what users see is a reviewable diff.",
  "",
  "Also:",
  "",
  "- the request helper in `src/lib/api.ts:12` reads the registry, not a copy;",
  "- tracked in https://dev.azure.com/acme/shop/_workitems/edit/17 and mirrored in https://dev.azure.com/acme/shop/_git/web/pullrequest/42.",
  "",
  "```ts",
  'export const SETTINGS = loadRegistry("crates/atlas-settings/settings-registry.toml");',
  "```",
  "",
  "## These stay code",
  "",
  "`/etc/passwd`, `../outside/x.ts`, `~/Desktop/setup.terminal`, `Calculator.app` and [a script](../../Desktop/setup.terminal).",
].join("\n");

const PULLS: FakePull[] = [
  pull({
    number: 412,
    title: "Checkout: split the payment step into a state machine",
    body: [
      "Replaces the payment step's nested `useEffect` chain with an explicit state machine.",
      "",
      "- `idle → authorising → confirming → done`, with `failed` reachable from each",
      "- retries are now a transition, not a re-render",
      "- the old step stays behind a flag for one release",
      "",
      "![State diagram](https://github.com/user-attachments/assets/7d0c9a3e-payment-states)",
    ].join("\n"),
    author: DEV,
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    mergeStateStatus: "BLOCKED",
    reviewDecision: "changes-requested",
    additions: 3214,
    deletions: 1876,
    changedFiles: BIG_FILES,
    commitCount: 23,
    headBranch: "theo/payment-state-machine",
    headRepository: REPOSITORY,
    headSha: "9f2c4e7a1b3d5f60718293a4b5c6d7e8f9012345",
    baseBranch: "main",
    baseSha: "1a2b3c4d5e6f708192a3b4c5d6e7f80912345678",
    isCrossRepository: false,
    createdAt: iso(70),
    updatedAt: iso(1),
    mergedAt: null,
    closedAt: null,
    reviewers: [
      { actor: VIEWER, kind: "user", state: "requested" },
      { actor: REVIEWER, kind: "user", state: "changes-requested" },
    ],
    labels: [
      { name: "checkout", color: "0e8a16" },
      { name: "needs-tests", color: "d93f0b" },
    ],
    assignees: [DEV],
    checks: [
      check("e2e / checkout-flow", "failure", 14, { required: true, description: "3 failing" }),
      check("lint", "success", 1),
      check("unit", "success", 6, { required: true }),
      check("typecheck", "success", 2),
      check("preview deploy", "pending", null, { workflow: "Deploy" }),
    ],
    checksState: "failing",
    checksTruncated: false,
    viewerPermissions: permissions(true, false),
    baseComparison: "behind",
    behindBy: 4,
    autoMergeEnabled: false,
    autoMergeMethod: null,
  }),
  pull({
    number: 405,
    title: "Search: typo-tolerant product lookup",
    body: "Early sketch — not ready for review.",
    author: VIEWER,
    state: "open",
    isDraft: true,
    mergeability: "unknown",
    mergeStateStatus: "DRAFT",
    reviewDecision: null,
    additions: 212,
    deletions: 18,
    changedFiles: 6,
    commitCount: 3,
    headBranch: "mara/fuzzy-search",
    headRepository: REPOSITORY,
    headSha: "4b5c6d7e8f90123459f2c4e7a1b3d5f607182930",
    baseBranch: "main",
    baseSha: "1a2b3c4d5e6f708192a3b4c5d6e7f80912345678",
    isCrossRepository: false,
    createdAt: iso(20),
    updatedAt: iso(3),
    mergedAt: null,
    closedAt: null,
    reviewers: [
      {
        actor: { login: "northwind/search", name: "Search", avatarUrl: avatar(2001), isBot: false },
        kind: "team",
        state: "requested",
      },
    ],
    labels: [{ name: "search", color: "1d76db" }],
    assignees: [VIEWER],
    checks: [],
    checksState: null,
    checksTruncated: false,
    viewerPermissions: permissions(true, true),
    baseComparison: "up-to-date",
    behindBy: 0,
    autoMergeEnabled: false,
    autoMergeMethod: null,
  }),
  pull({
    number: 401,
    title: "Cart: persist coupons across sessions",
    body: "Coupons were held in memory only; they now survive a reload.",
    author: REVIEWER,
    state: "open",
    isDraft: false,
    mergeability: "conflicting",
    mergeStateStatus: "DIRTY",
    reviewDecision: "review-required",
    additions: 96,
    deletions: 41,
    changedFiles: 5,
    commitCount: 4,
    headBranch: "ines/persist-coupons",
    headRepository: "ines-p/northwind-shop",
    headSha: "7e8f90123459f2c4e7a1b3d5f6071829304b5c6d",
    baseBranch: "main",
    baseSha: "1a2b3c4d5e6f708192a3b4c5d6e7f80912345678",
    isCrossRepository: true,
    createdAt: iso(48),
    updatedAt: iso(6),
    mergedAt: null,
    closedAt: null,
    reviewers: [{ actor: VIEWER, kind: "user", state: "requested" }],
    labels: [{ name: "cart", color: "fbca04" }],
    assignees: [],
    checks: [
      check("unit", "failure", 5, {
        required: true,
        description: "CouponStore › restores on load",
      }),
      check("lint", "success", 1),
      // A fork's workflow waiting for someone with write access.
      check("e2e", "action-required", null, { description: "Waiting for approval" }),
    ],
    checksState: "failing",
    checksTruncated: false,
    viewerPermissions: {
      ...permissions(true, false),
      actions: [...permissions(true, false).actions, "approve-workflows"],
    },
    baseComparison: "behind",
    behindBy: 12,
    autoMergeEnabled: null,
    autoMergeMethod: null,
  }),
  pull({
    number: 398,
    title: "Orders: show the delivery window on the receipt",
    body: "Adds the promised delivery window to the order receipt and its email.",
    author: DEV,
    state: "merged",
    isDraft: false,
    mergeability: "unknown",
    mergeStateStatus: null,
    reviewDecision: "approved",
    additions: 148,
    deletions: 22,
    changedFiles: 7,
    commitCount: 5,
    headBranch: "theo/delivery-window",
    headRepository: REPOSITORY,
    headSha: "c6d7e8f9012345a9f2c4e7a1b3d5f60718293a4b",
    baseBranch: "main",
    baseSha: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c",
    isCrossRepository: false,
    createdAt: iso(120),
    updatedAt: iso(96),
    mergedAt: iso(96),
    closedAt: iso(96),
    reviewers: [{ actor: VIEWER, kind: "user", state: "approved" }],
    labels: [{ name: "orders", color: "5319e7" }],
    assignees: [DEV],
    checks: [check("unit", "success", 5), check("lint", "success", 1), check("e2e", "success", 12)],
    checksState: "passing",
    checksTruncated: false,
    // Merged, with push access: it can be reverted.
    viewerPermissions: {
      ...permissions(false, false),
      actions: [...permissions(false, false).actions, "revert"],
    },
    baseComparison: "unknown",
    behindBy: null,
    autoMergeEnabled: null,
    autoMergeMethod: null,
  }),
  pull({
    number: 377,
    title: "Experiment: server-rendered category pages",
    body: "Closing in favour of the streaming approach.",
    author: DEV,
    state: "closed",
    isDraft: false,
    mergeability: "unknown",
    mergeStateStatus: null,
    reviewDecision: null,
    additions: 640,
    deletions: 310,
    changedFiles: 19,
    commitCount: 9,
    headBranch: "theo/ssr-categories",
    headRepository: REPOSITORY,
    headSha: "e8f9012345a9f2c4e7a1b3d5f60718293a4bc6d7",
    baseBranch: "main",
    baseSha: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c",
    isCrossRepository: false,
    createdAt: iso(400),
    updatedAt: iso(300),
    mergedAt: null,
    closedAt: iso(300),
    reviewers: [],
    labels: [],
    assignees: [],
    checks: [check("unit", "success", 4)],
    checksState: "passing",
    checksTruncated: false,
    viewerPermissions: permissions(false, false),
    baseComparison: "unknown",
    behindBy: null,
    autoMergeEnabled: null,
    autoMergeMethod: null,
  }),
  pull({
    number: 420,
    title: "Catalogue: move every product page onto the new design tokens",
    body: [
      "Moves all 214 product page components onto the token scale. No visual change is intended;",
      "the screenshots in each check's artifacts compare before and after.",
      "",
      "<details><summary>Components touched</summary>",
      "",
      "- `ProductCard`, `ProductGallery`, `PriceTag`",
      "- `ReviewStars`, `StockBadge`, `ShippingNote`",
      "",
      "</details>",
      "",
      "Follows #412. See 9f2c4e7a1b3d5f60718293a4b5c6d7e8f9012345 for the token map.",
    ].join("\n"),
    author: REVIEWER,
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    mergeStateStatus: "UNSTABLE",
    reviewDecision: "review-required",
    additions: 18_402,
    deletions: 16_977,
    changedFiles: 214,
    commitCount: 61,
    headBranch: "ines/catalogue-tokens",
    headRepository: REPOSITORY,
    headSha: "aa2c4e7a1b3d5f60718293a4b5c6d7e8f9012345",
    baseBranch: "main",
    baseSha: "1a2b3c4d5e6f708192a3b4c5d6e7f80912345678",
    isCrossRepository: false,
    createdAt: iso(200),
    updatedAt: iso(0.5),
    mergedAt: null,
    closedAt: null,
    reviewers: [
      { actor: VIEWER, kind: "user", state: "requested" },
      { actor: DEV, kind: "user", state: "commented" },
    ],
    labels: [
      { name: "design-system", color: "5319e7" },
      { name: "large", color: "b60205" },
      { name: "catalogue", color: "0e8a16" },
    ],
    assignees: [REVIEWER],
    checks: Array.from({ length: 100 }, (_, i) =>
      check(
        `visual / product-page-${String(i + 1).padStart(3, "0")}`,
        i === 7 || i === 41 ? "failure" : i > 94 ? "pending" : i % 23 === 5 ? "skipped" : "success",
        i > 94 ? null : 2 + (i % 9),
        { workflow: "Visual regression" },
      ),
    ),
    checksState: "failing",
    checksTruncated: true,
    viewerPermissions: permissions(true, false),
    baseComparison: "up-to-date",
    behindBy: 0,
    autoMergeEnabled: false,
    autoMergeMethod: null,
  }),
  pull({
    number: 431,
    title: "feat(settings): one registry generates every copy of the settings schema",
    body: FILE_CHIPS_BODY,
    author: VIEWER,
    state: "merged",
    isDraft: false,
    mergeability: "unknown",
    mergeStateStatus: null,
    reviewDecision: null,
    additions: 4110,
    deletions: 588,
    changedFiles: FILE_CHIPS_CHANGED.length,
    commitCount: 6,
    headBranch: "settings-registry",
    headRepository: REPOSITORY,
    headSha: "b1c2d3e4f5a60718293a4b5c6d7e8f9012345678",
    baseBranch: "main",
    baseSha: "1a2b3c4d5e6f708192a3b4c5d6e7f80912345678",
    isCrossRepository: false,
    createdAt: iso(60),
    updatedAt: iso(48),
    mergedAt: iso(48),
    closedAt: iso(48),
    reviewers: [],
    labels: [],
    assignees: [],
    checks: [check("unit", "success", 4), check("lint", "success", 1)],
    checksState: "passing",
    checksTruncated: false,
    viewerPermissions: permissions(true, false),
    baseComparison: "unknown",
    behindBy: null,
    autoMergeEnabled: null,
    autoMergeMethod: null,
  }),
];

function find(number: unknown): FakePull {
  const found = allPulls().find((p) => p.detail.number === Number(number));
  return found ?? fail({ kind: "notFound" });
}

// ── a crowded repository, for the list ─────────────────────────────────────

/** Extra pull requests a busy repository has, on for `?scenario=pull-request-list`.
 *  Generated from a seed, so screenshots compare. */
let crowd: FakePull[] = [];

const CROWD_TITLES = [
  "Orders: paginate the admin table",
  "Checkout: round totals half-even",
  "API: retry 5xx with jitter",
  "Search: index product synonyms",
  "Cart: keep the coupon after login",
  "Infra: pin the Node image",
  "Docs: document the webhook signatures",
  "Billing: ledger entries for refunds",
  "Auth: rotate session keys weekly",
  "Mobile: fix the safe-area inset",
  "Email: render receipts in dark mode",
  "Perf: memoise the price formatter",
];
const CROWD_LABELS = [
  { name: "bug", color: "d73a4a" },
  { name: "enhancement", color: "a2eeef" },
  { name: "checkout", color: "0e8a16" },
  { name: "dependencies", color: "0366d6" },
  { name: "needs-tests", color: "d93f0b" },
];

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

function generateCrowd(count: number): FakePull[] {
  const rand = seeded(469);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
  const people = [VIEWER, DEV, REVIEWER, BOT, actor("sam-o", "Sam Okafor", 1005)];
  return Array.from({ length: count }, (_, i) => {
    const number = 300 - i;
    const roll = rand();
    const state = roll < 0.55 ? "open" : roll < 0.85 ? "merged" : "closed";
    const author = pick(people);
    const open = state === "open";
    const checks = open ? pick(["passing", "failing", "pending", null] as const) : "passing";
    const updated = 2 + i * 5 + Math.floor(rand() * 4);
    const requested = open && author !== VIEWER && rand() < 0.25;
    const base = find(405).detail;
    return pull({
      ...base,
      number,
      title: `${pick(CROWD_TITLES)}${i >= CROWD_TITLES.length ? ` (${Math.floor(i / CROWD_TITLES.length) + 1})` : ""}`,
      body: "",
      author,
      state,
      isDraft: open && rand() < 0.15,
      mergeability: open && rand() < 0.1 ? "conflicting" : "mergeable",
      mergeStateStatus: "CLEAN",
      reviewDecision: open
        ? pick(["approved", "changes-requested", "review-required", null] as const)
        : "approved",
      additions: Math.floor(rand() * 900) + 1,
      deletions: Math.floor(rand() * 300),
      headBranch: `${author.login.split("-")[0]}/change-${number}`,
      createdAt: iso(updated + 24 + Math.floor(rand() * 200)),
      updatedAt: iso(updated),
      mergedAt: state === "merged" ? iso(updated) : null,
      closedAt: state === "open" ? null : iso(updated),
      reviewers: requested ? [{ actor: VIEWER, kind: "user", state: "requested" }] : [],
      labels:
        rand() < 0.6
          ? [pick(CROWD_LABELS), ...(rand() < 0.3 ? [pick(CROWD_LABELS)] : [])].filter(
              (l, j, all) => all.findIndex((m) => m.name === l.name) === j,
            )
          : [],
      checks: [],
      checksState: checks,
      viewerPermissions: permissions(open, author === VIEWER),
    });
  });
}

/** Give the repository a crowd of pull requests across every group and
 *  state, or take it away. */
export function crowdPullRequestList(on: boolean): void {
  crowd = on ? stackCrowd(generateCrowd(140)) : [];
}

/** Base the viewer's first three open pull requests on one another, so the
 *  list shows a stack (`2/3`) derived from their base branches. */
function stackCrowd(pulls: FakePull[]): FakePull[] {
  const mine = pulls.filter((p) => p.detail.state === "open" && p.detail.author === VIEWER);
  for (let i = 1; i < Math.min(3, mine.length); i++) {
    const base = mine[i - 1]!.detail.headBranch;
    mine[i]!.detail.baseBranch = base;
    mine[i]!.entry.baseBranch = base;
  }
  return pulls;
}

/** A pull request's line counts spread over code, tests, test support and a
 *  lockfile, adding up to its own totals, for the list's breakdown hover. */
function listStatOf(number: number): PrListStat | null {
  const entry = allPulls().find((p) => p.detail.number === number)?.entry;
  if (!entry) return null;
  if (number === 431) {
    const files = filesOf(number).map((f) => ({
      path: f.path,
      additions: f.additions,
      deletions: f.deletions,
    }));
    return {
      number,
      additions: entry.additions,
      deletions: entry.deletions,
      files,
      filesTruncated: false,
    };
  }
  const shares: Array<[string, number]> = [
    [`src/feature-${number}/index.ts`, 0.55],
    [`src/feature-${number}/view.tsx`, 0.15],
    [`src/feature-${number}/index.test.ts`, 0.18],
    [`src/feature-${number}/__fixtures__/rows.json`, 0.04],
    ...(number % 3 === 0 ? [["bun.lock", 0.08] as [string, number]] : []),
  ];
  const sum = shares.reduce((total, [, share]) => total + share, 0);
  const split = (total: number) => {
    const parts = shares.map(([, share]) => Math.floor((share / sum) * total));
    parts[0]! += total - parts.reduce((a, b) => a + b, 0);
    return parts;
  };
  const adds = split(entry.additions);
  const dels = split(entry.deletions);
  return {
    number,
    additions: entry.additions,
    deletions: entry.deletions,
    files: shares.map(([path], i) => ({ path, additions: adds[i]!, deletions: dels[i]! })),
    filesTruncated: number === 420,
  };
}

function allPulls(): FakePull[] {
  return [...PULLS, ...crowd];
}

/** One pull request's list row, for the session-link fakes. */
export function pullRequestEntry(number: number): PrListEntry | null {
  return allPulls().find((p) => p.detail.number === number)?.entry ?? null;
}

export const PULL_REQUEST_REPOSITORY = REPOSITORY;

// ── conversation ────────────────────────────────────────────────────────────

const reactions = new Map<string, PrReaction[]>([
  [
    "IC_412_1",
    [{ content: "rocket", count: 2, actors: ["ines-p", "theo-r"], viewerHasReacted: false }],
  ],
]);

/** The viewer may edit and delete what they wrote, as GitHub answers it. */
const mine = (author: PrActor | null) => {
  const own = author?.login === VIEWER.login;
  return { canEdit: own, canDelete: own };
};

const threadComment = (
  id: string,
  author: PrActor,
  body: string,
  hoursAgo: number,
): PrThreadComment => ({
  id,
  author,
  body,
  createdAt: iso(hoursAgo),
  editedAt: null,
  url: `${URL_BASE}/412#discussion_${id}`,
  reactions: reactions.get(id) ?? [],
  ...mine(author),
});

/** The long thread's comments past the ten the activity read carries. */
const LONG_THREAD_REST: PrThreadComment[] = Array.from({ length: 4 }, (_, i) =>
  threadComment(`RC_412_long_${i + 10}`, i % 2 ? DEV : REVIEWER, `Follow-up ${i + 1}.`, 20 - i),
);

const threads = new Map<number, PrReviewThread[]>([
  [
    412,
    [
      {
        id: "PRRT_412_retry",
        path: "src/checkout/payment-machine.ts",
        line: 88,
        side: "right",
        isResolved: false,
        isOutdated: false,
        comments: [
          threadComment(
            "RC_412_1",
            REVIEWER,
            "A retry from `failed` re-enters `authorising` without clearing the last error — the banner flashes the stale message.",
            30,
          ),
          threadComment("RC_412_2", DEV, "Good catch, clearing it on entry.", 28),
        ],
        commentCount: 2,
        nextCommentsCursor: null,
        canResolve: true,
      },
      {
        id: "PRRT_412_names",
        path: "src/checkout/payment-step.tsx",
        line: 14,
        side: "left",
        isResolved: true,
        isOutdated: false,
        comments: [threadComment("RC_412_3", VIEWER, "Nit: `PaymentStepLegacy`?", 40)],
        commentCount: 1,
        nextCommentsCursor: null,
        canResolve: true,
      },
      {
        id: "PRRT_412_old",
        path: "src/checkout/use-payment.ts",
        line: null,
        side: "right",
        isResolved: false,
        isOutdated: true,
        comments: [threadComment("RC_412_4", REVIEWER, "This hook goes away now, right?", 60)],
        commentCount: 1,
        nextCommentsCursor: null,
        canResolve: true,
      },
      {
        id: "PRRT_412_long",
        path: "src/checkout/payment-machine.test.ts",
        line: 120,
        side: "right",
        isResolved: false,
        isOutdated: false,
        comments: Array.from({ length: 10 }, (_, i) =>
          threadComment(
            `RC_412_long_${i}`,
            i % 2 ? DEV : REVIEWER,
            i === 0 ? "These timers should use fake time." : `Reply ${i}.`,
            36 - i,
          ),
        ),
        commentCount: 10 + LONG_THREAD_REST.length,
        nextCommentsCursor: "long-2",
        canResolve: true,
      },
    ],
  ],
]);

const remarks = new Map<number, PrComment[]>([
  [
    412,
    [
      {
        id: "IC_412_1",
        kind: "issue-comment",
        author: DEV,
        body: "Ready for another look — the flag defaults off.",
        createdAt: iso(26),
        editedAt: null,
        url: `${URL_BASE}/412#issuecomment-1`,
        path: null,
        reviewState: null,
        reactions: reactions.get("IC_412_1") ?? [],
        ...mine(DEV),
      },
      {
        id: "PRR_412_1",
        kind: "review",
        author: REVIEWER,
        body: "Close. The retry path needs a test before this lands.",
        createdAt: iso(24),
        editedAt: null,
        url: `${URL_BASE}/412#pullrequestreview-1`,
        path: null,
        reviewState: "CHANGES_REQUESTED",
        reactions: [],
        ...mine(REVIEWER),
      },
      {
        id: "IC_412_3",
        kind: "issue-comment",
        author: VIEWER,
        body: "I'll take the retry test if nobody else has started it.",
        createdAt: iso(20),
        editedAt: null,
        url: `${URL_BASE}/412#issuecomment-3`,
        path: null,
        reviewState: null,
        reactions: [],
        ...mine(VIEWER),
      },
      {
        id: "IC_412_2",
        kind: "issue-comment",
        author: BOT,
        body: "Preview deploy queued.",
        createdAt: iso(2),
        editedAt: null,
        url: `${URL_BASE}/412#issuecomment-2`,
        path: null,
        reviewState: null,
        reactions: [],
        ...mine(BOT),
      },
    ],
  ],
  [
    398,
    [
      {
        id: "PRR_398_1",
        kind: "review",
        author: VIEWER,
        body: "",
        createdAt: iso(97),
        editedAt: null,
        url: `${URL_BASE}/398#pullrequestreview-2`,
        path: null,
        reviewState: "APPROVED",
        reactions: [],
        ...mine(VIEWER),
      },
    ],
  ],
]);

const BIG_REMARKS = [
  "Looks right in the gallery. The `PriceTag` spacing moved by a pixel though.",
  "Rebased on main.",
  "```ts\nconst gap = token('space.2'); // was 6px\n```\nThis is the one I am unsure of.",
  "Checked the dark theme too — fine.",
  "Can we land the card first and the gallery after?",
];

remarks.set(
  420,
  Array.from({ length: 300 }, (_, i): PrComment => {
    const author = i % 7 === 3 ? BOT : [DEV, REVIEWER, VIEWER][i % 3];
    return {
      id: `IC_420_${i}`,
      kind: "issue-comment",
      author,
      body:
        author === BOT
          ? `<!-- visual-bot -->\nVisual run ${i}: **${i % 2 ? "no" : "2"} changes** against main.`
          : BIG_REMARKS[i % BIG_REMARKS.length],
      createdAt: iso(199 - i * 0.6),
      editedAt: null,
      url: `${URL_BASE}/420#issuecomment-${i}`,
      path: null,
      reviewState: null,
      reactions: [],
      ...mine(author),
    };
  }),
);

// #420's reviews, among its comments: one ruling since dismissed, one that
// only says something, and two line comments in threads.
remarks.get(420)!.push(
  {
    id: "PRR_420_1",
    kind: "review",
    author: DEV,
    body: "Blocking until the `PriceTag` spacing regression is explained.",
    createdAt: iso(150.3),
    editedAt: null,
    url: `${URL_BASE}/420#pullrequestreview-1`,
    path: null,
    reviewState: "DISMISSED",
    reactions: [],
    ...mine(DEV),
  },
  {
    id: "PRR_420_2",
    kind: "review",
    author: DEV,
    body: "Second pass done. The gallery is fine now; one question on the stock badge inline.",
    createdAt: iso(60.3),
    editedAt: iso(59),
    url: `${URL_BASE}/420#pullrequestreview-2`,
    path: null,
    reviewState: "COMMENTED",
    reactions: [],
    ...mine(DEV),
  },
);
remarks.get(420)!.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
reactions.set("PRR_420_2", [
  { content: "thumbs-up", count: 1, actors: ["ines-p"], viewerHasReacted: false },
]);
threads.set(420, [
  {
    id: "PRRT_420_badge",
    path: "src/catalogue/stock-badge.tsx",
    line: 31,
    side: "right",
    isResolved: false,
    isOutdated: false,
    comments: [
      {
        ...threadComment(
          "RC_420_1",
          DEV,
          "Does `StockBadge` still need its own `gap`, or does the token cover it?",
          60.25,
        ),
        url: `${URL_BASE}/420#discussion_RC_420_1`,
      },
      {
        ...threadComment("RC_420_2", REVIEWER, "The token covers it — dropping it.", 58),
        url: `${URL_BASE}/420#discussion_RC_420_2`,
      },
    ],
    commentCount: 2,
    nextCommentsCursor: null,
    canResolve: true,
  },
  {
    id: "PRRT_420_gallery",
    path: "src/catalogue/product-gallery.tsx",
    line: 112,
    side: "right",
    isResolved: true,
    isOutdated: true,
    comments: [
      {
        ...threadComment("RC_420_3", DEV, "This drops the 6px gutter on narrow screens.", 150.2),
        url: `${URL_BASE}/420#discussion_RC_420_3`,
      },
    ],
    commentCount: 1,
    nextCommentsCursor: null,
    canResolve: true,
  },
]);

/** Commits land in pushes of four, a couple of minutes apart, spread from
 *  the pull request's opening to its last update (or merge). */
function commitsOf(number: number): PrCommit[] {
  const detail = find(number).detail;
  const count = detail.commitCount;
  const start = Date.parse(detail.createdAt);
  const end = Date.parse(detail.mergedAt ?? detail.updatedAt);
  const pushes = Math.ceil(count / 4);
  return Array.from({ length: count }, (_, i) => ({
    // Spread across the first digits, so every short SHA differs.
    oid: (Math.imul(number * 64 + i + 1, 2_654_435_761) >>> 0)
      .toString(16)
      .padStart(8, "0")
      .repeat(5),
    messageHeadline: i === count - 1 ? "Address review feedback" : `Step ${i + 1} of the change`,
    committedDate: new Date(
      start + ((Math.floor(i / 4) + 0.5) / pushes) * (end - start) + (i % 4) * 120_000,
    ).toISOString(),
    additions: i === 3 ? null : 40 + i * 7,
    deletions: i === 3 ? null : 5 + i,
    authors: [i % 4 === 3 ? VIEWER : (detail.author ?? DEV)],
  }));
}

function activity(number: number): PrActivity {
  const detail = find(number).detail;
  const own = threads.get(number) ?? [];
  const lineComments: PrComment[] = own.flatMap((t) =>
    t.comments.map((c) => ({
      ...c,
      kind: "review-comment" as const,
      path: t.path,
      reviewState: null,
    })),
  );
  const comments = [...(remarks.get(number) ?? []), ...lineComments]
    .map((c) => ({ ...c, reactions: reactions.get(c.id) ?? c.reactions }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    author: detail.author,
    reviewers: detail.reviewers.map((r) => r.actor),
    comments,
    commentCount: (remarks.get(number)?.length ?? 0) + own.reduce((n, t) => n + t.commentCount, 0),
    commentsTruncated: own.some((t) => t.nextCommentsCursor !== null),
    reviewThreadsTruncated: false,
    reviewThreads: own,
    commits: commitsOf(number),
    reactions: reactions.get(`PR_${number}`) ?? [],
  };
}

const label = (name: string) => ({
  name,
  color: LABELS.find((l) => l.name === name)?.color ?? null,
});

/** State changes beyond opening, merging and closing, per pull request. */
function lifecycleOf(number: number): PrTimelineItem[] {
  const detail = find(number).detail;
  const author = detail.author;
  switch (number) {
    case 412:
      return [
        { kind: "labeled", id: "LE_412_1", actor: author, label: label("checkout"), at: iso(69.9) },
        { kind: "labeled", id: "LE_412_2", actor: author, label: label("large"), at: iso(69.9) },
        {
          kind: "force-pushed",
          id: "HRFP_412",
          actor: DEV,
          beforeOid: "0".repeat(40),
          afterOid: detail.headSha,
          at: iso(5),
        },
      ];
    case 420:
      return [
        // The bot's triage pass: labels on, one taken back off later.
        {
          kind: "labeled",
          id: "LE_420_1",
          actor: author,
          label: label("design-system"),
          at: iso(199.9),
        },
        { kind: "labeled", id: "LE_420_2", actor: author, label: label("large"), at: iso(199.9) },
        { kind: "labeled", id: "LE_420_3", actor: BOT, label: label("catalogue"), at: iso(199.8) },
        {
          kind: "labeled",
          id: "LE_420_4",
          actor: BOT,
          label: label("needs-tests"),
          at: iso(199.8),
        },
        { kind: "converted-to-draft", id: "CTD_420", actor: author, at: iso(199.7) },
        { kind: "ready-for-review", id: "RFR_420", actor: author, at: iso(181) },
        {
          kind: "unlabeled",
          id: "UNLE_420_1",
          actor: BOT,
          label: label("needs-tests"),
          at: iso(180.9),
        },
        {
          kind: "review-requested",
          id: "RRE_420_1",
          actor: author,
          reviewer: VIEWER,
          at: iso(180.8),
        },
        { kind: "review-requested", id: "RRE_420_2", actor: author, reviewer: DEV, at: iso(180.8) },
        // A rebase that took three tries.
        ...[0, 1, 2].map((n): PrTimelineItem => ({
          kind: "force-pushed",
          id: `HRFP_420_${n}`,
          actor: author,
          beforeOid: (0x4200 + n).toString(16).padStart(8, "0").repeat(5),
          afterOid: (0x4201 + n).toString(16).padStart(8, "0").repeat(5),
          at: iso(100.4 - n * 0.1),
        })),
        { kind: "closed", id: "CE_420", actor: author, at: iso(90.2) },
        { kind: "reopened", id: "RE_420", actor: author, at: iso(90.1) },
      ];
    default:
      return detail.reviewers.length
        ? [
            {
              kind: "review-requested",
              id: `RRE_${number}`,
              actor: author,
              reviewer: detail.reviewers[0].actor,
              at: new Date(Date.parse(detail.createdAt) + 60_000).toISOString(),
            },
          ]
        : [];
  }
}

/** The history as `pr_timeline` reads it: oldest first, comments and
 *  reviews among the events (line comments live in their threads). */
function timeline(number: number, cursor: string | null): PrTimelinePage {
  const detail = find(number).detail;
  const commits = commitsOf(number);
  const conversation = (remarks.get(number) ?? []).map((c): PrTimelineItem =>
    c.kind === "review"
      ? {
          kind: "review",
          id: c.id,
          actor: c.author,
          state: c.reviewState ?? "COMMENTED",
          body: c.body,
          url: c.url,
          at: c.createdAt,
        }
      : { kind: "comment", id: c.id, actor: c.author, body: c.body, url: c.url, at: c.createdAt },
  );
  const merged: PrTimelineItem[] =
    detail.state === "merged"
      ? [
          {
            kind: "merged",
            id: `ME_${number}`,
            actor: VIEWER,
            commitOid: detail.headSha,
            baseBranch: detail.baseBranch,
            at: detail.mergedAt!,
          },
          // GitHub records the close a merge implies beside it.
          { kind: "closed", id: `CE_${number}`, actor: VIEWER, at: detail.closedAt! },
          { kind: "head-ref-deleted", id: `HRD_${number}`, actor: VIEWER, at: detail.mergedAt! },
        ]
      : [];
  const closed: PrTimelineItem[] =
    detail.state === "closed"
      ? [{ kind: "closed", id: `CE_${number}`, actor: DEV, at: detail.closedAt! }]
      : [];
  const events: PrTimelineItem[] = [
    ...commits.map((c, i): PrTimelineItem => ({
      kind: "commit",
      id: `PRC_${number}_${i}`,
      oid: c.oid,
      messageHeadline: c.messageHeadline,
      authors: c.authors,
      at: c.committedDate,
    })),
    ...conversation,
    ...lifecycleOf(number),
    ...merged,
    ...closed,
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const items: PrTimelineItem[] = [
    { kind: "opened", actor: detail.author, at: detail.createdAt },
    ...events,
  ];
  // Pages of 100, as GitHub's; #420's history runs to several.
  const start = cursor ? Number(cursor) : 0;
  const page = items.slice(start, start + 100);
  return { items: page, nextCursor: start + 100 < items.length ? String(start + 100) : null };
}

// ── files and diffs ─────────────────────────────────────────────────────────
//
// Each file is laid out once (`layoutOf`): its old and new text and the hunks
// between them, so the patch `pr_diff` sends and the sides
// `pr_diff_file_contents` sends agree, and a hunk's collapsed context expands
// into the same lines. #420's 214 files add up to its +18,402 −16,977.

const DIRS = ["src/checkout", "src/checkout/steps", "src/cart", "src/ui", "tests/checkout"];
const CATALOGUE_DIRS = [
  "src/catalogue/product",
  "src/catalogue/product/gallery",
  "src/catalogue/listing",
  "src/catalogue/filters",
  "src/catalogue/price",
  "src/ui/tokens",
  "tests/catalogue",
];
const CATALOGUE_NAMES = [
  "product-card",
  "product-title",
  "price-tag",
  "badge-row",
  "gallery-strip",
  "swatch-picker",
  "size-grid",
  "stock-note",
  "listing-grid",
  "filter-chip",
  "sort-menu",
  "rating-stars",
  "promo-banner",
];

/** Spread `total` over `n` files by a deterministic weight, the last one
 *  taking the rounding, so the files add up to the pull request's counts. */
function spread(total: number, n: number, salt: number, zeroAt: (i: number) => boolean): number[] {
  const weights = Array.from({ length: n }, (_, i) =>
    zeroAt(i) ? 0 : 1 + ((Math.imul(i + 1, 2_654_435_761 + salt) >>> 0) % 1000) / 250,
  );
  const sum = weights.reduce((a, b) => a + b, 0);
  const counts = weights.map((w) => Math.floor((w / sum) * total));
  const rest = total - counts.reduce((a, b) => a + b, 0);
  let last = n - 1;
  while (last > 0 && zeroAt(last)) last--;
  counts[last] += rest;
  return counts;
}

const fileCache = new Map<number, PrDiffFile[]>();

function filesOf(number: number): PrDiffFile[] {
  const cached = fileCache.get(number);
  if (cached) return cached;
  const detail = find(number).detail;
  const n = detail.changedFiles;
  const big = number === 420;
  const statusOf = (i: number): PrDiffFile["status"] =>
    i === 0 ? "added" : i === 1 ? "renamed" : i === 2 ? "removed" : "modified";
  // A binary file, and one past the host's patch limit.
  const withheld = (i: number) => i === 7 || i === 11;
  const adds = big
    ? spread(detail.additions, n, 7, (i) => statusOf(i) === "removed")
    : Array.from({ length: n }, (_, i) => (statusOf(i) === "removed" ? 0 : 8 + (i % 13)));
  const dels = big
    ? spread(detail.deletions, n, 13, (i) => statusOf(i) === "added")
    : Array.from({ length: n }, (_, i) => (statusOf(i) === "added" ? 0 : i % 6));
  const named = number === 431 ? FILE_CHIPS_CHANGED : null;
  const files = Array.from({ length: n }, (_, i): PrDiffFile => {
    if (named) {
      return {
        path: named[i]!,
        previousPath: null,
        status: "modified",
        additions: adds[i]!,
        deletions: dels[i]!,
        hasPatch: true,
      };
    }
    const status = statusOf(i);
    const dir = big ? CATALOGUE_DIRS[i % CATALOGUE_DIRS.length] : DIRS[i % DIRS.length];
    const name = big
      ? `${CATALOGUE_NAMES[i % CATALOGUE_NAMES.length]}-${i}${dir.startsWith("tests") ? ".test" : ""}.tsx`
      : `module-${i}.ts`;
    return {
      path: i === 7 ? `${dir}/logo-${i}.png` : `${dir}/${name}`,
      previousPath: status === "renamed" ? `${dir}/old-${name}` : null,
      status,
      additions: adds[i],
      deletions: dels[i],
      hasPatch: !withheld(i),
    };
  }).sort((a, b) => a.path.localeCompare(b.path));
  fileCache.set(number, files);
  return files;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

interface Layout {
  oldText: string;
  newText: string;
  hunks: Hunk[];
}

/** Changed lines per run, and unchanged lines between runs: past six (three
 *  of context each side) they make separate hunks, with a collapsed gap. */
const RUN = 14;
const GAP = 18;
const CONTEXT = 3;

const layouts = new Map<string, Layout>();

function codeLine(kind: "same" | "old" | "new", n: number, seed: number): string {
  const k = (n + seed) % 9;
  if (kind === "same") {
    return [
      `export function Row${n}({ item }: RowProps) {`,
      `  const label = useLabel(item.id);`,
      `  if (!item.visible) return null;`,
      `  return (`,
      `    <div className="row" data-id={item.id}>`,
      `      <span>{label}</span>`,
      `    </div>`,
      `  );`,
      `}`,
    ][k];
  }
  if (kind === "old") {
    return [
      `  padding: "${6 + (n % 5)}px ${10 + (n % 3)}px",`,
      `  color: palette.slate${(n % 9) + 1}00,`,
      `  fontSize: ${12 + (n % 4)},`,
      `  gap: ${4 + (n % 6)},`,
      `  borderRadius: ${2 + (n % 4)},`,
      `  marginTop: ${n % 12},`,
      `  lineHeight: "${18 + (n % 6)}px",`,
      `  background: palette.shade${n % 9},`,
      `  boxShadow: shadows.card${n % 4},`,
    ][k];
  }
  return [
    `  padding: token("space.${n % 5}", "space.${2 + (n % 3)}"),`,
    `  color: token("text.subtle"),`,
    `  fontSize: token("type.${["xs", "sm", "md", "lg"][n % 4]}"),`,
    `  gap: token("space.${n % 6}"),`,
    `  borderRadius: token("radius.${["sm", "md", "lg", "xl"][n % 4]}"),`,
    `  marginTop: token("space.${n % 12}"),`,
    `  lineHeight: token("leading.${["tight", "snug", "normal"][n % 3]}"),`,
    `  background: token("surface.sunken"),`,
    `  boxShadow: token("elevation.${n % 4}"),`,
  ][k];
}

function layoutOf(file: PrDiffFile): Layout {
  const cached = layouts.get(file.path);
  if (cached) return cached;
  const seed = file.path.length;
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const hunks: Hunk[] = [];
  let same = 0;
  const pushSame = (count: number) => {
    for (let i = 0; i < count; i++) {
      const line = codeLine("same", same++, seed);
      oldLines.push(line);
      newLines.push(line);
    }
  };
  if (file.status === "added" || file.status === "removed") {
    const count = file.status === "added" ? file.additions : file.deletions;
    const lines = Array.from({ length: count }, (_, i) =>
      codeLine(file.status === "added" ? "new" : "old", i, seed),
    );
    if (file.status === "added") newLines.push(...lines);
    else oldLines.push(...lines);
    hunks.push({
      oldStart: file.status === "added" ? 0 : 1,
      oldCount: file.status === "added" ? 0 : count,
      newStart: file.status === "added" ? 1 : 0,
      newCount: file.status === "added" ? count : 0,
      lines: lines.map((l) => (file.status === "added" ? `+${l}` : `-${l}`)),
    });
  } else {
    let removeLeft = file.deletions;
    let addLeft = file.additions;
    let changed = 0;
    pushSame(8);
    while (removeLeft > 0 || addLeft > 0) {
      const removing = Math.min(RUN, removeLeft);
      const adding = Math.min(RUN, addLeft);
      const before = Math.min(CONTEXT, same);
      const oldStart = oldLines.length - before + 1;
      const newStart = newLines.length - before + 1;
      const lines = oldLines.slice(oldLines.length - before).map((l) => ` ${l}`);
      for (let i = 0; i < removing; i++) {
        const line = codeLine("old", changed + i, seed);
        oldLines.push(line);
        lines.push(`-${line}`);
      }
      for (let i = 0; i < adding; i++) {
        const line = codeLine("new", changed + i, seed);
        newLines.push(line);
        lines.push(`+${line}`);
      }
      changed += Math.max(removing, adding);
      removeLeft -= removing;
      addLeft -= adding;
      const gap = removeLeft > 0 || addLeft > 0 ? GAP : 6;
      pushSame(gap);
      const after = Math.min(CONTEXT, gap);
      for (const line of newLines.slice(newLines.length - gap, newLines.length - gap + after)) {
        lines.push(` ${line}`);
      }
      hunks.push({
        oldStart,
        oldCount: before + removing + after,
        newStart,
        newCount: before + adding + after,
        lines,
      });
    }
  }
  const layout = {
    oldText: oldLines.length ? `${oldLines.join("\n")}\n` : "",
    newText: newLines.length ? `${newLines.join("\n")}\n` : "",
    hunks,
  };
  layouts.set(file.path, layout);
  return layout;
}

function patchFor(files: PrDiffFile[]): string {
  return files
    .map((f) => {
      const old = f.previousPath ?? f.path;
      const head = [`diff --git a/${old} b/${f.path}`];
      if (f.status === "added") head.push("new file mode 100644");
      if (f.status === "removed") head.push("deleted file mode 100644");
      if (f.status === "renamed") head.push(`rename from ${old}`, `rename to ${f.path}`);
      head.push(
        `--- ${f.status === "added" ? "/dev/null" : `a/${old}`}`,
        `+++ ${f.status === "removed" ? "/dev/null" : `b/${f.path}`}`,
      );
      const body = f.hasPatch
        ? layoutOf(f)
            .hunks.map(
              (h) =>
                `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@\n${h.lines.join("\n")}\n`,
            )
            .join("")
        : "";
      return `${head.join("\n")}\n${body}`;
    })
    .join("");
}

/** The files one commit touched: a slice of the pull request's, by its place
 *  in the history. */
function commitFiles(number: number, commit: string): PrDiffFile[] {
  const commits = commitsOf(number);
  const at = Math.max(
    0,
    commits.findIndex((c) => c.oid === commit),
  );
  const files = filesOf(number);
  const step = Math.max(1, commits.length);
  return files.filter((_, i) => i % step === at % step || i % 17 === at % 17).slice(0, 14);
}

function diff(number: number, cursor: string | null, commit: string | null): PrDiffResult {
  const files = commit ? commitFiles(number, commit) : filesOf(number);
  // A small pull request arrives whole, like the host's one-piece diff.
  if (!cursor && !commit && files.length <= 100) {
    return {
      patch: patchFor(files),
      files: [],
      truncated: false,
      nextCursor: null,
      omittedFileStats: [],
    };
  }
  const page = cursor ? Number(cursor) : 1;
  const slice = files.slice((page - 1) * 100, page * 100);
  const omitted = slice
    .filter((f) => !f.hasPatch && f.additions + f.deletions > 0)
    .map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions }));
  return {
    patch: patchFor(slice),
    files: slice,
    truncated: omitted.length > 0,
    nextCursor: page * 100 < files.length ? String(page + 1) : null,
    omittedFileStats: omitted,
  };
}

function fileContents(number: number, newPath: string): PrDiffFileContents {
  if (newPath.endsWith(".png")) fail({ kind: "unsupported", message: "This file is binary." });
  const file = filesOf(number).find((f) => f.path === newPath);
  if (!file) fail({ kind: "notFound" });
  const layout = layoutOf(file);
  return { oldContents: layout.oldText, newContents: layout.newText };
}

/** A line inside a file's first hunk, on the side asked: where a review
 *  thread on #420 sits, so it lands on the diff. */
function lineInDiff(
  index: number,
  side: "left" | "right",
  offset = 4,
): { path: string; line: number } {
  const file = filesOf(420)[index];
  const hunk = layoutOf(file).hunks[0];
  return {
    path: file.path,
    line: (side === "left" ? hunk.oldStart : hunk.newStart) + offset,
  };
}

/** #420's review threads: on lines of the first and later pages, one on the
 *  old side, one resolved, one outdated (off the diff). */
function catalogueThreads(): PrReviewThread[] {
  const at = (
    id: string,
    index: number,
    side: "left" | "right",
    comments: PrThreadComment[],
    extra: Partial<PrReviewThread> = {},
  ): PrReviewThread => ({
    id,
    ...lineInDiff(index, side),
    side,
    isResolved: false,
    isOutdated: false,
    comments,
    commentCount: comments.length,
    nextCommentsCursor: null,
    canResolve: true,
    ...extra,
  });
  return [
    at("PRRT_420_spacing", 3, "right", [
      threadComment(
        "RC_420_1",
        REVIEWER,
        "`space.2` is 8px; this was 6px. Is the extra 2px intended here?",
        30,
      ),
      threadComment("RC_420_2", DEV, "Yes, the design review rounded every 6 up to 8.", 28),
    ]),
    at("PRRT_420_colour", 9, "left", [
      threadComment(
        "RC_420_3",
        VIEWER,
        "This colour was hand-tuned for the sale badge; check `text.subtle` keeps the contrast.",
        26,
      ),
    ]),
    at(
      "PRRT_420_radius",
      24,
      "right",
      [
        threadComment(
          "RC_420_4",
          REVIEWER,
          "Nit: `radius.md` reads better than `radius.lg` on a card this small.",
          22,
        ),
      ],
      { isResolved: true },
    ),
    at("PRRT_420_page2", 150, "right", [
      threadComment(
        "RC_420_5",
        REVIEWER,
        "This file is past the first page of the diff, so this thread appears once it loads.",
        12,
      ),
    ]),
    {
      id: "PRRT_420_outdated",
      path: filesOf(420)[40].path,
      line: null,
      side: "right",
      isResolved: false,
      isOutdated: true,
      comments: [
        threadComment("RC_420_6", REVIEWER, "Did this hover state go away on purpose?", 50),
      ],
      commentCount: 1,
      nextCommentsCursor: null,
      canResolve: true,
    },
  ];
}

const viewed = new Map<number, Map<string, PrFileViewed["state"]>>();

/** #420 starts part-way through a review: the first files viewed, two of them
 *  pushed to since (`dismissed`, which reads as "Changed"). */
function seededMarks(number: number): Map<string, PrFileViewed["state"]> {
  let marks = viewed.get(number);
  if (!marks) {
    marks = new Map();
    if (number === 420) {
      const files = filesOf(420);
      for (const i of [0, 2, 4, 5, 6, 8]) marks.set(files[i].path, "viewed");
      for (const i of [1, 10]) marks.set(files[i].path, "dismissed");
    }
    viewed.set(number, marks);
  }
  return marks;
}

function filesViewed(number: number): PrFilesViewed {
  const marks = seededMarks(number);
  return {
    files: filesOf(number).map((f) => ({ path: f.path, state: marks.get(f.path) ?? "unviewed" })),
    truncated: false,
  };
}

threads.set(420, catalogueThreads());

// A 1×1 PNG, so an image renders without a network.
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkqP9fDwAE/wH+gFJzSQAAAABJRU5ErkJggg==";

// ── handlers ────────────────────────────────────────────────────────────────

/** Set by a scenario to make every read fail the way `gh` would. */
let readFailure: PrError | null = null;

export function failPullRequestReads(error: PrError | null): void {
  readFailure = error;
}

function guard(): void {
  if (readFailure) fail(readFailure);
}

const PEOPLE: PrActor[] = [
  VIEWER,
  DEV,
  REVIEWER,
  actor("sam-o", "Sam Okafor", 1005),
  actor("lena-w", "Lena Weiß", 1006),
  actor("yuki-t", "Yuki Tanaka", 1007),
];

const LABELS: Array<{ name: string; color: string; description: string | null }> = [
  { name: "checkout", color: "0e8a16", description: "The checkout flow" },
  { name: "cart", color: "fbca04", description: null },
  { name: "catalogue", color: "0e8a16", description: "Product and category pages" },
  { name: "design-system", color: "5319e7", description: "Tokens and primitives" },
  { name: "large", color: "b60205", description: "Review in more than one sitting" },
  { name: "needs-tests", color: "d93f0b", description: null },
  { name: "orders", color: "5319e7", description: null },
  { name: "search", color: "1d76db", description: null },
];

function reviewerCandidates(number: number): PrReviewerCandidates {
  const detail = find(number).detail;
  const asked = new Set(
    detail.reviewers.filter((r) => r.state === "requested").map((r) => r.actor.login),
  );
  return {
    candidates: PEOPLE.filter((p) => p.login !== detail.author?.login).map((p) => ({
      id: p.login,
      kind: "user" as const,
      actor: p,
      isRequested: asked.has(p.login),
    })),
    truncated: false,
  };
}

function labelCandidates(number: number): PrLabelCandidates {
  const applied = new Set(find(number).detail.labels.map((l) => l.name));
  return {
    candidates: LABELS.map((l) => ({ ...l, isApplied: applied.has(l.name) })),
    truncated: false,
  };
}

const nothing = (): null => null;

function setReaction(id: string, content: PrReactionContent, reacted: boolean): void {
  const list = [...(reactions.get(id) ?? [])];
  const at = list.findIndex((r) => r.content === content);
  const current = at >= 0 ? list[at] : { content, count: 0, actors: [], viewerHasReacted: false };
  if (current.viewerHasReacted === reacted) return;
  const next = { ...current, count: current.count + (reacted ? 1 : -1), viewerHasReacted: reacted };
  if (at >= 0) list.splice(at, 1);
  if (next.count > 0) list.push(next);
  reactions.set(id, list);
}

// ── agent actions: checkouts and review guides ──────────────────────────────

/** The change a guide is fitted to, read off the fake diff: the same hunks
 *  `hunkFor` writes. */
function guideChange(number: number): GuideChange {
  const files = filesOf(number);
  const hunks: GuideChange["hunks"] = {};
  for (const f of files) {
    if (!f.hasPatch) continue;
    const layout = layoutOf(f);
    hunks[f.path] = {
      new: layout.hunks
        .filter((h) => h.newCount > 0)
        .map((h): [number, number] => [h.newStart, h.newStart + h.newCount - 1]),
      old: layout.hunks
        .filter((h) => h.oldCount > 0)
        .map((h): [number, number] => [h.oldStart, h.oldStart + h.oldCount - 1]),
    };
  }
  return { files: files.map((f) => f.path), hunks };
}

/** The new-side span of a file's first hunk, for an excerpt that shows. */
function firstHunk(file: PrDiffFile): { start: number; end: number } {
  const hunk = layoutOf(file).hunks[0];
  if (!hunk || hunk.newCount === 0) return { start: 1, end: 1 };
  return { start: hunk.newStart, end: hunk.newStart + hunk.newCount - 1 };
}

/** A guide an agent might write for the fake change: four stops through its
 *  first files, each with an excerpt the diff can show. */
function fixtureGuide(number: number): GeneratedGuide {
  const files = filesOf(number).filter((f) => f.hasPatch);
  const ofStatus = (status: PrDiffFile["status"]) => files.filter((f) => f.status === status);
  const modified = ofStatus("modified");
  const pick = (list: PrDiffFile[], i: number) => list[i % list.length] ?? files[0];
  const core = pick(modified, 0);
  const coreSpan = firstHunk(core);
  const ui = pick(modified, 1);
  const added = pick(ofStatus("added"), 0);
  return {
    stops: [
      {
        title: "Retries become machine events",
        summary:
          "The heart of the change. A failed step no longer calls `retry()` itself: it sends a `retry` event, so the state machine owns every transition and a retry shows up in its history like any other step.",
        attention: {
          kind: "contract",
          note: "Anything that listened for the old direct retry now has to subscribe to the machine instead. Decide whether that is a break worth calling out in the release notes.",
        },
        excerpts: [
          {
            path: core.path,
            side: "new",
            ...coreSpan,
            caption: "The step sends an event instead of retrying in place.",
          },
        ],
        files: [{ path: pick(modified, 2).path, note: "The same swap, in the payment step." }],
        notes: [
          {
            path: core.path,
            line: coreSpan.start + 4,
            title: "No retry limit here",
            body: "The cap lives in the machine's guard, so this call site stays simple.",
          },
        ],
        questions: ["Should a retry from the last step reset the payment intent?"],
      },
      {
        title: "A new entry point for checkout",
        summary:
          "A small module the rest of the change hangs off. It only exports a flag today; the follow-up wires the machine through it.",
        attention: null,
        excerpts: [
          { path: added.path, side: "new", ...firstHunk(added), caption: "The whole new module." },
        ],
        files: [],
        notes: [],
        questions: [],
      },
      {
        title: "Moves and removals",
        summary:
          "One module is renamed into `steps/` and one dead helper is removed. Neither changes behaviour.",
        attention: null,
        excerpts: [],
        files: [
          { path: pick(ofStatus("renamed"), 0).path, note: "Renamed, unchanged." },
          { path: pick(ofStatus("removed"), 0).path, note: "Removed: nothing imported it." },
        ],
        notes: [],
        questions: [],
      },
      {
        title: "The cart and UI follow along",
        summary:
          "Callers in the cart and the UI make the same one-line swap. Skim these; the tests cover them.",
        attention: {
          kind: "product",
          note: "A failed payment now shows the retry state for a moment before the button comes back. Confirm that is the feel you want.",
        },
        excerpts: [
          { path: ui.path, side: "new", ...firstHunk(ui), caption: "The UI's retry path." },
        ],
        files: [{ path: pick(modified, 3).path, note: "Tests for the new event." }],
        notes: [],
        questions: [],
      },
    ],
  };
}

/** Guides kept for the page's life, seeded with one for the review scenario. */
const guides = new Map<number, unknown>();
function storedGuide(number: number): unknown {
  if (!guides.has(number) && number === 412) {
    guides.set(412, {
      ...fixtureGuide(412),
      headSha: find(412).detail.headSha,
      generatedAt: iso(1),
      agent: "claude-code",
    });
  }
  return guides.get(number) ?? null;
}

/** Answers a guide run's prompt with the fixture guide as JSON, so "Write
 *  guide" completes in the browser. Other prompts are left to the echo. */
export function answerGuidePrompt(info: { sessionId: string; text: string }): boolean {
  const match = /guided tour of change request #(\d+)/.exec(info.text);
  if (!match) return false;
  const body = JSON.stringify(fixtureGuide(Number(match[1])), null, 2);
  void (async () => {
    await setStatus("running", info.sessionId);
    await streamText(`I read the change. Here is the tour.\n\n\`\`\`json\n${body}\n\`\`\``, {
      sessionId: info.sessionId,
      chunkMs: 4,
    });
    await setStatus("idle", info.sessionId);
  })();
  return true;
}

const CHECK_LOG = [
  "Run bun run test src/checkout",
  " RUN  v3.2.4 /home/runner/work/atlas/atlas",
  "",
  " ✓ src/checkout/payment-step.test.tsx (12 tests) 214ms",
  " ✗ src/checkout/payment-machine.test.ts > retry > clears the last error on re-entry",
  "   AssertionError: expected 'Card declined' to be null",
  "    ❯ src/checkout/payment-machine.test.ts:131:32",
  "      129|     machine.send({ type: 'retry' });",
  "      130|     await vi.advanceTimersByTimeAsync(50);",
  "      131|     expect(machine.state.error).toBeNull();",
  "         |                                ^",
  "",
  " Test Files  1 failed | 8 passed (9)",
  "      Tests  1 failed | 141 passed (142)",
  "##[error]Process completed with exit code 1.",
].join("\n");

export interface PullRequestsResponses {
  pr_provider: PrProvider;
  pr_list: PrListResult;
  pr_list_stats: PrListStat[];
  pr_detail: PrDetail;
  pr_activity: PrActivity;
  pr_thread_comments: PrThreadCommentsPage;
  pr_timeline: PrTimelinePage;
  pr_commits: PrCommitsPage;
  pr_diff: PrDiffResult;
  pr_diff_file_contents: PrDiffFileContents;
  pr_files_viewed: PrFilesViewed;
  pr_set_files_viewed: Unit;
  pr_comment: Unit;
  pr_reply_to_thread: Unit;
  pr_resolve_thread: Unit;
  pr_react: Unit;
  pr_submit_review: Unit;
  pr_action: Unit;
  pr_update: Unit;
  pr_request_reviewers: Unit;
  pr_set_labels: Unit;
  pr_image: PrImage;
  pr_edit_comment: Unit;
  pr_delete_comment: Unit;
  pr_revert: PrReverted;
  pr_check_log: PrCheckLog;
  pr_reviewer_candidates: PrReviewerCandidates;
  pr_label_candidates: PrLabelCandidates;
  pr_create_draft: PrCreateDraft;
  pr_create: PrCreated;
  pr_prepare_checkout: PrCheckout;
  pr_guide_read: unknown;
  pr_guide_write: Unit;
  pr_guide_prepare: GuideCheckout;
  pr_guide_finish: Unit;
}

function listMatches(entry: PrListEntry, args: MockArgs): boolean {
  const query = (args.query ?? {}) as {
    state?: string;
    search?: string;
    involvement?: string;
    head?: string | null;
    author?: string | null;
    draft?: string | null;
    labels?: string[] | null;
    labelGroups?: string[][] | null;
    excludedLabels?: string[] | null;
  };
  const held = new Set(entry.labels.map((l) => l.name.toLowerCase()));
  if (query.labelGroups?.some((group) => !group.some((l) => held.has(l.toLowerCase())))) {
    return false;
  }
  if (query.excludedLabels?.some((l) => held.has(l.toLowerCase()))) return false;
  if (query.author && entry.author?.login.toLowerCase() !== query.author.toLowerCase()) {
    return false;
  }
  if (query.draft === "only" && !entry.isDraft) return false;
  if (query.draft === "hide" && entry.isDraft) return false;
  const labels = entry.labels.map((l) => l.name.toLowerCase());
  if (query.labels?.some((l) => !labels.includes(l.toLowerCase()))) return false;
  const state = query.state ?? "open";
  if (state !== "all" && entry.state !== state) return false;
  if (query.head && entry.headBranch !== query.head) return false;
  if (query.involvement === "authored" && entry.author?.login !== VIEWER.login) return false;
  if (query.involvement === "reviewing" && !entry.viewerReviewRequested) return false;
  const text = query.search?.trim().toLowerCase();
  return (
    !text ||
    entry.title.toLowerCase().includes(text) ||
    entry.headBranch.toLowerCase().includes(text) ||
    `#${entry.number}` === text ||
    String(entry.number) === text
  );
}

export const pullRequestsHandlers: TypedHandlers<PullRequestsResponses> = {
  pr_provider: () => PROVIDER,
  // Pages of `limit` (all at once without one), as `gh` pages them.
  pr_list: (args) => {
    guard();
    const all = allPulls()
      .map((p) => p.entry)
      .filter((e) => listMatches(e, args))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const query = (args.query ?? {}) as { cursor?: string | null; limit?: number | null };
    const start = query.cursor ? Number(query.cursor) : 0;
    const limit = query.limit ?? all.length;
    return {
      provider: PROVIDER,
      entries: all.slice(start, start + limit),
      nextCursor: start + limit < all.length ? String(start + limit) : null,
    };
  },
  pr_list_stats: ({ numbers }) => {
    guard();
    return ((numbers ?? []) as number[]).flatMap((number) => listStatOf(Number(number)) ?? []);
  },
  pr_detail: ({ number }) => {
    guard();
    return find(number).detail;
  },
  pr_activity: ({ number }) => {
    guard();
    return activity(Number(number));
  },
  pr_reviewer_candidates: ({ number }) => reviewerCandidates(Number(number)),
  pr_label_candidates: ({ number }) => labelCandidates(Number(number)),
  pr_thread_comments: ({ number, threadId }) => {
    const thread = (threads.get(Number(number)) ?? []).find((t) => t.id === threadId);
    if (!thread)
      fail({ kind: "invalid", message: "That review thread belongs to another pull request." });
    return { comments: thread.id === "PRRT_412_long" ? LONG_THREAD_REST : [], nextCursor: null };
  },
  pr_timeline: ({ number, cursor }) => timeline(Number(number), (cursor as string | null) ?? null),
  // Pages of 25, so a long history pages in the Code tab's picker.
  pr_commits: ({ number, cursor }) => {
    const all = commitsOf(Number(number));
    const start = cursor ? Number(cursor) : 0;
    return {
      commits: all.slice(start, start + 25),
      nextCursor: start + 25 < all.length ? String(start + 25) : null,
    };
  },
  pr_diff: ({ number, cursor, commit }) =>
    diff(Number(number), (cursor as string | null) ?? null, (commit as string | null) ?? null),
  pr_diff_file_contents: ({ number, newPath }) => fileContents(Number(number), String(newPath)),
  pr_files_viewed: ({ number }) => filesViewed(Number(number)),
  pr_set_files_viewed: ({ number, files }) => {
    const marks = seededMarks(Number(number));
    for (const f of (files ?? []) as Array<{ path: string; viewed: boolean }>) {
      marks.set(f.path, f.viewed ? "viewed" : "unviewed");
    }
    viewed.set(Number(number), marks);
    return null;
  },
  pr_comment: ({ number, body }) => {
    const list = remarks.get(Number(number)) ?? [];
    list.push({
      id: `IC_${number}_${list.length + 10}`,
      kind: "issue-comment",
      author: VIEWER,
      body: String(body),
      createdAt: new Date().toISOString(),
      editedAt: null,
      url: null,
      path: null,
      reviewState: null,
      reactions: [],
      ...mine(VIEWER),
    });
    remarks.set(Number(number), list);
    return null;
  },
  pr_reply_to_thread: ({ number, threadId, body }) => {
    const thread = (threads.get(Number(number)) ?? []).find((t) => t.id === threadId);
    if (!thread) fail({ kind: "notFound" });
    thread.comments = [
      ...thread.comments,
      threadComment(`RC_reply_${thread.comments.length}`, VIEWER, String(body), 0),
    ];
    thread.commentCount += 1;
    return null;
  },
  pr_resolve_thread: ({ number, threadId, resolved }) => {
    const thread = (threads.get(Number(number)) ?? []).find((t) => t.id === threadId);
    if (!thread) fail({ kind: "notFound" });
    thread.isResolved = Boolean(resolved);
    return null;
  },
  pr_react: ({ number, subjectId, content, reacted }) => {
    setReaction(
      (subjectId as string | null) ?? `PR_${number}`,
      content as PrReactionContent,
      Boolean(reacted),
    );
    return null;
  },
  pr_submit_review: nothing,
  pr_action: ({ number, input }) => {
    const target = find(number);
    const action = (input as { action: string }).action;
    const now = new Date().toISOString();
    const set = (patch: Partial<PrDetail>) => {
      Object.assign(target.detail, patch);
      Object.assign(target.entry, {
        state: target.detail.state,
        isDraft: target.detail.isDraft,
        updatedAt: now,
      });
    };
    if (action === "merge") {
      if (target.detail.mergeability === "conflicting") {
        fail({
          kind: "failed",
          message: "Pull request is not mergeable: the merge commit cannot be cleanly created.",
        });
      }
      set({
        state: "merged",
        mergedAt: now,
        closedAt: now,
        viewerPermissions: permissions(false, false),
      });
    } else if (action === "close") set({ state: "closed", closedAt: now });
    else if (action === "reopen") set({ state: "open", closedAt: null });
    else if (action === "ready") set({ isDraft: false });
    else if (action === "draft") set({ isDraft: true });
    else if (action === "update-branch") set({ behindBy: 0, baseComparison: "up-to-date" });
    else if (action === "enable-auto-merge")
      set({ autoMergeEnabled: true, autoMergeMethod: "squash" });
    else if (action === "disable-auto-merge")
      set({ autoMergeEnabled: false, autoMergeMethod: null });
    // The waiting runs start: their checks go back to pending.
    else if (action === "approve-workflows")
      set({
        checks: target.detail.checks.map((c) =>
          c.status === "action-required" ? { ...c, status: "pending", description: null } : c,
        ),
      });
    return null;
  },
  pr_update: ({ number, title, body }) => {
    const target = find(number);
    if (typeof title === "string") target.detail.title = target.entry.title = title;
    if (typeof body === "string") target.detail.body = body;
    return null;
  },
  pr_request_reviewers: ({ number, reviewers, requested }) => {
    const target = find(number);
    for (const ref of (reviewers ?? []) as Array<{ id: string }>) {
      const person = PEOPLE.find((p) => p.login === ref.id);
      if (!person) continue;
      const rest = target.detail.reviewers.filter((r) => r.actor.login !== ref.id);
      target.detail.reviewers = requested
        ? [...rest, { actor: person, kind: "user", state: "requested" }]
        : rest;
    }
    return null;
  },
  pr_set_labels: ({ number, labels, applied }) => {
    const target = find(number);
    const names = (labels ?? []) as string[];
    const kept = target.detail.labels.filter((l) => !names.includes(l.name));
    target.detail.labels = applied
      ? [...kept, ...names.map((name) => ({ name, color: "c5def5" }))]
      : kept;
    target.entry.labels = target.detail.labels;
    return null;
  },
  pr_image: () => ({ contentType: "image/png", data: PIXEL }),
  pr_edit_comment: ({ number, commentId, body }) => {
    const now = new Date().toISOString();
    const remark = (remarks.get(Number(number)) ?? []).find((c) => c.id === commentId);
    if (remark) {
      Object.assign(remark, { body: String(body), editedAt: now });
      return null;
    }
    for (const thread of threads.get(Number(number)) ?? []) {
      const c = thread.comments.find((x) => x.id === commentId);
      if (c) {
        Object.assign(c, { body: String(body), editedAt: now });
        return null;
      }
    }
    return fail({ kind: "notFound" });
  },
  pr_delete_comment: ({ number, commentId }) => {
    const list = remarks.get(Number(number)) ?? [];
    const at = list.findIndex((c) => c.id === commentId);
    if (at >= 0) {
      list.splice(at, 1);
      return null;
    }
    for (const thread of threads.get(Number(number)) ?? []) {
      if (thread.comments.some((c) => c.id === commentId)) {
        thread.comments = thread.comments.filter((c) => c.id !== commentId);
        thread.commentCount -= 1;
        return null;
      }
    }
    return fail({ kind: "notFound" });
  },
  // Opens no pull request: answers with an existing one, so "Open" has a tab.
  pr_revert: ({ number }) => {
    const other = allPulls().find((p) => p.detail.number !== Number(number))!.detail.number;
    return { number: other, url: `${URL_BASE}/${other}` };
  },
  pr_check_log: ({ checkUrl }) => ({
    jobId: /job\/(\d+)/u.exec(String(checkUrl))?.[1] ?? "0",
    text: CHECK_LOG,
    truncated: true,
    foundError: true,
  }),
  // What `gh pr create --fill` would write for the fake repo's current branch.
  pr_create_draft: (): PrCreateDraft => {
    const head = mockCurrentBranchName();
    return {
      headBranch: head,
      baseBranch: "main",
      title: head === "main" ? "" : (head.split("/").pop() ?? head).replace(/-/g, " "),
      body: "- Keep highlight rects on rotate\n- Cover the rotated page in a test",
      commitCount: 2,
    };
  },
  pr_create: ({ input }): PrCreated => {
    const number = 500 + created++;
    const confirmed = (input ?? {}) as {
      title?: string;
      body?: string;
      base?: string | null;
      draft?: boolean;
    };
    // The new pull request is real for the page's life, so its tab renders.
    const opened = pull({
      ...find(405).detail,
      number,
      title: confirmed.title || mockCurrentBranchName(),
      body: confirmed.body ?? "",
      author: VIEWER,
      isDraft: confirmed.draft === true,
      mergeability: "mergeable",
      mergeStateStatus: "CLEAN",
      headBranch: mockCurrentBranchName(),
      baseBranch: confirmed.base ?? "main",
      reviewers: [],
      labels: [],
      checks: [check("lint", "pending", null), check("unit", "pending", null)],
      checksState: "pending",
      commitCount: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      viewerPermissions: permissions(true, true),
    });
    PULLS.push(opened);
    return { number, url: opened.detail.url };
  },
  pr_prepare_checkout: ({ path, number, headBranch, inPlace }): PrCheckout => {
    // In this repository: the fake checkout is always clean, so it switches.
    if (inPlace === true) {
      return {
        branch: String(headBranch),
        worktreePath: null,
        cwd: String(path),
        isOnPullRequestHead: true,
        reused: false,
      };
    }
    const worktreePath = `${String(path)}/.atlas-worktrees/pr-${Number(number)}`;
    return {
      branch: String(headBranch),
      worktreePath,
      cwd: worktreePath,
      isOnPullRequestHead: true,
      reused: false,
    };
  },
  pr_guide_read: ({ number }) => storedGuide(Number(number)),
  pr_guide_write: ({ number, guide }) => {
    guides.set(Number(number), guide);
    return null;
  },
  pr_guide_prepare: ({ path, number, headSha }): GuideCheckout => ({
    runId: `guide-${Number(number)}-${Date.now()}`,
    path: `${String(path)}/.atlas-guide-runs/pr-${Number(number)}`,
    baseCommit: find(number).detail.baseSha ?? "1a2b3c4d5e6f708192a3b4c5d6e7f80912345678",
    headCommit: String(headSha),
    change: guideChange(Number(number)),
  }),
  pr_guide_finish: () => null,
};

/** How many pull requests `pr_create` has opened this session. */
let created = 0;
