// The fake repository: a dirty working tree, a branch list, a stash, a commit
// graph, and real diffs for every changed file.
//
// The default scenario used to report a clean repo, which left the whole git
// column — status, graph, and the side-by-side diff view — with nothing to
// draw. The diff view is the most theme-sensitive surface Atlas has (added,
// removed, modified and context lines each get their own background, and the
// word-level `emph` spans sit on top of syntax highlighting), so it needs a
// working tree with all four line kinds in it before any theme work can be
// reviewed.
//
// HEAD content is derived from the working-tree text in `files.ts` by named
// substitutions rather than being pasted a second time: `atHead` throws when a
// substitution stops matching, so editing a fixture file can't silently turn a
// diff into a no-op.
//
// The writes are real too — see the "writes" section below. Every button in
// the panel moves this file's state and fires `atlas:git-changed`, so the
// panel reacts to a commit or a checkout the way it does against a repo;
// several of them fail the way git fails, because the error dialog, the
// conflict banner and the info toasts are states that no happy path reaches.

import { emit } from "@tauri-apps/api/event";
import type { BlameLine } from "@/features/git/lib/git-blame-api";
import type { RepoPullRequests } from "@/features/git/lib/git-pr-api";
import type { RepoAvatars } from "@/features/git/lib/git-avatars-api";
import type { CommitFile, DiffLineStatus, FileDiff } from "@/features/git/lib/git-diff-api";
import type { GitErrorCode, GitErrorPayload } from "@/features/git/lib/git-errors";
import type { BuiltGraph, CommitRow, LaneSegment } from "@/features/git/lib/git-graph";
import type {
  AutoFetchStatus,
  BranchInfo,
  CommitDetail,
  GitBranch,
  GitLogEntry,
  GitOpEvent,
  GitSnapshotWire,
  InProgress,
  MergePreview,
  PullPreference,
  RemoteInfo,
  StashEntry,
} from "@/features/git/stores/git-store";
import type {
  ConflictFile,
  ConflictState,
} from "@/features/git/components/git-manager/conflicts-view";
import type { CommitSession } from "@/features/git/components/commit-view";
import type { RawGitStatus } from "@/features/terminal/components/block-terminal";
import type { GitSummary } from "@/features/projects/stores/project-git-store";
import type { TypedHandlers, Unread } from "../types";
import { ALL_PROJECTS, MOCK_PROJECT } from "../project";
import { binaryFileDiff, buildFileDiff, lineStatusOf, unifiedDiff } from "./diff";
import { fileText } from "./files";

/** Apply ordered substitutions, refusing to produce a no-op diff silently. */
function atHead(rel: string, edits: [find: string, replace: string][]): string {
  let text = fileText(rel);
  if (!text) throw new Error(`[mock-backend] no working-tree text for ${rel}`);
  for (const [find, replace] of edits) {
    if (!text.includes(find)) {
      throw new Error(
        `[mock-backend] HEAD fixture for ${rel} no longer matches: ${find.slice(0, 40)}`,
      );
    }
    text = text.replace(find, replace);
  }
  return text;
}

// ── HEAD content ──────────────────────────────────────────────────────────

const HEAD_API_TS = () =>
  atHead("src/lib/api.ts", [
    // Removed in HEAD → shows as added lines.
    [
      `  createdAt: z.coerce.date(),\n  plan: z.enum(["free", "team", "enterprise"]),\n`,
      `  createdAt: z.coerce.date(),\n`,
    ],
    // Modified lines → `changed` rows with word-level spans.
    [
      `const BASE = import.meta.env.VITE_API_BASE ?? "https://api.acme.dev";`,
      `const BASE = "https://api.acme.dev";`,
    ],
    [`    credentials: "include",\n`, ``],
    [
      `    throw new ApiError(res.status, \`\${init?.method ?? "GET"} \${path} failed\`);`,
      `    throw new Error("request failed");`,
    ],
    [
      `  listUsers: (page = 0, size = 50) => request<User[]>(\`/users?page=\${page}&size=\${size}\`),`,
      `  listUsers: () => request<User[]>("/users"),`,
    ],
    // The whole retry helper is new work → a run of added lines.
    [
      `\n/** Retry a request with exponential backoff — 5xx and network errors only. */`,
      `\n/* TODO(ACME-1184): retry 5xx here. */`,
    ],
  ])
    .replace(/export async function withRetry[\s\S]*$/, "")
    .trimEnd() + "\n";

const HEAD_LIB_RS = () =>
  atHead("src-tauri/src/lib.rs", [
    [`use std::collections::BTreeMap;\n`, `use std::collections::HashMap;\n`],
    [`    users: Mutex<BTreeMap<String, User>>,`, `    users: Mutex<HashMap<String, User>>,`],
    [
      `        let mut guard = self.users.lock().expect("cache poisoned");\n        guard.insert(user.id.clone(), user)`,
      `        let mut guard = self.users.lock().unwrap();\n        guard.insert(user.id.clone(), user)`,
    ],
    // Removed in HEAD → added lines in the working tree.
    [
      `    pub fn len(&self) -> usize {\n        self.users.lock().map(|g| g.len()).unwrap_or(0)\n    }\n`,
      ``,
    ],
    [
      `#[tauri::command]\npub async fn seat_limit(plan: Plan) -> Result<Option<u32>, String> {\n    Ok(plan.seat_limit())\n}\n\n`,
      ``,
    ],
  ]);

const HEAD_TOKENS_CSS = () =>
  atHead("src/styles/tokens.css", [
    [`  --accent: #6e9cff;`, `  --accent: #4f7fe0;`],
    [`  --destructive: #f2555a;\n`, ``],
    [`  --font-mono: "JetBrains Mono", ui-monospace, monospace;\n`, ``],
    [`.card[data-state="disabled"] {\n  opacity: 0.45;\n  pointer-events: none;\n}\n`, ``],
  ]);

const HEAD_README_MD = () =>
  atHead("README.md", [
    [`| \`src/styles\` | Design tokens — the only place raw colours appear |\n`, ``],
    [
      `- Every colour is a token in \`src/styles/tokens.css\`. No hex literals in JSX.`,
      `- Keep colours in one place.`,
    ],
  ]);

/** Deleted in the working tree — its diff is every line removed. */
const LEGACY_AUTH_TS = `import { api } from "./api";

/** @deprecated Session cookies replaced this in 2.3. Delete after ACME-1184. */
export function readLegacyToken(): string | null {
  const raw = window.localStorage.getItem("acme.token");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(atob(raw.split(".")[1] ?? "")) as { exp?: number };
    if (parsed.exp && parsed.exp * 1000 < Date.now()) return null;
    return raw;
  } catch {
    return null;
  }
}

export async function migrateLegacySession(): Promise<boolean> {
  const token = readLegacyToken();
  if (!token) return false;
  await api.listUsers();
  window.localStorage.removeItem("acme.token");
  return true;
}
`;

// ── working-tree status ───────────────────────────────────────────────────

interface FakeChange {
  path: string;
  status: string;
  staged: boolean;
  /** Old and new text; `null` on either side means created / deleted. */
  before: () => string;
  after: () => string;
  binary?: boolean;
}

const SEED_CHANGES: FakeChange[] = [
  {
    path: "src/lib/api.ts",
    status: "modified",
    staged: false,
    before: HEAD_API_TS,
    after: () => fileText("src/lib/api.ts"),
  },
  {
    path: "src-tauri/src/lib.rs",
    status: "modified",
    staged: false,
    before: HEAD_LIB_RS,
    after: () => fileText("src-tauri/src/lib.rs"),
  },
  {
    path: "src/styles/tokens.css",
    status: "modified",
    staged: true,
    before: HEAD_TOKENS_CSS,
    after: () => fileText("src/styles/tokens.css"),
  },
  {
    path: "README.md",
    status: "modified",
    staged: true,
    before: HEAD_README_MD,
    after: () => fileText("README.md"),
  },
  {
    path: "src/components/badge.tsx",
    status: "untracked",
    staged: false,
    before: () => "",
    after: () => fileText("src/components/badge.tsx"),
  },
  {
    path: "src/legacy/auth.ts",
    status: "deleted",
    staged: true,
    before: () => LEGACY_AUTH_TS,
    after: () => "",
  },
  {
    path: "public/logo.png",
    status: "modified",
    staged: false,
    before: () => "",
    after: () => "",
    binary: true,
  },
];

/**
 * The live working tree. Commit / discard / reset / checkout all add and
 * remove entries, so this is a copy of the seed rather than the seed itself —
 * a scenario's `init()` can put it back.
 */
let CHANGES: FakeChange[] = SEED_CHANGES.map((change) => ({ ...change }));

/** Staged-ness is the one thing the panel mutates, so it lives apart. */
const staged = new Map(CHANGES.map((change) => [change.path, change.staged]));

/**
 * Files whose index AND working tree both hold changes — what partial hunk
 * staging leaves behind. Porcelain emits two rows for one of these, which is
 * why the panel can list the same file under Staged and Unstaged at once.
 */
const partial = new Set<string>();

const changeFor = (file: string) => CHANGES.find((change) => change.path === file);

/** Drop a path from the working tree entirely (discard, commit, checkout). */
function dropChange(file: string): void {
  CHANGES = CHANGES.filter((change) => change.path !== file);
  staged.delete(file);
  partial.delete(file);
}

/**
 * A working-tree change for a file that has none — what `reset` and
 * `undo commit` put back when a commit's contents return to the tree. Reuses
 * the seed's before/after when the path is one of the fixture's own, so the
 * restored entry opens on a real diff instead of an empty one.
 */
function changeForPath(path: string, status: string, isStaged: boolean): FakeChange {
  const seed = SEED_CHANGES.find((change) => change.path === path);
  if (seed) return { ...seed, status, staged: isStaged };
  const text = () => fileText(path);
  return {
    path,
    status,
    staged: isStaged,
    before: status === "added" ? () => "" : () => text().split("\n").slice(1).join("\n"),
    after: status === "deleted" ? () => "" : text,
  };
}

/** Put a path back into the working tree, without duplicating an entry. */
function restoreChange(path: string, status: string, isStaged: boolean): void {
  if (!changeFor(path)) CHANGES = [changeForPath(path, status, isStaged), ...CHANGES];
  staged.set(path, isStaged);
  partial.delete(path);
}

function diffFor(file: string): FileDiff {
  const change = changeFor(file);
  if (change) {
    return change.binary
      ? binaryFileDiff(file)
      : buildFileDiff(change.before(), change.after(), file);
  }
  // Not a file this fixture tracks as dirty (another scenario's status, say):
  // show it as if its first line had just been added, rather than blank.
  const text = fileText(file);
  return buildFileDiff(text.split("\n").slice(1).join("\n"), text, file);
}

// ── branches, stashes, commits ────────────────────────────────────────────

const SEED_BRANCHES: BranchInfo[] = [
  {
    name: "main",
    isCurrent: true,
    isRemote: false,
    upstream: "origin/main",
    ahead: 3,
    behind: 1,
    subject: "feat(api): move user reads onto /v2",
    date: "2026-09-17T09:12:00Z",
  },
  {
    name: "feature/auth-v2",
    isCurrent: false,
    isRemote: false,
    upstream: "origin/feature/auth-v2",
    ahead: 0,
    behind: 4,
    subject: "Switch API client to v2 endpoints",
    date: "2026-09-16T17:40:00Z",
  },
  {
    name: "renovate/design-tokens-and-the-entire-colour-system-rewrite",
    isCurrent: false,
    isRemote: false,
    // No upstream yet — the "publish branch" affordance.
    upstream: null,
    ahead: 12,
    behind: 0,
    subject:
      "chore(deps): bump every design-token package and regenerate the palette, including the dark-mode ramp",
    date: "2026-09-15T08:05:00Z",
  },
  {
    name: "fix/pdf-annotations",
    isCurrent: false,
    isRemote: false,
    upstream: "origin/fix/pdf-annotations",
    ahead: 0,
    behind: 0,
    subject: "fix(pdf): keep highlight rects on rotate",
    date: "2026-09-12T14:22:00Z",
  },
  {
    // Grafted-in history with no common ancestor: the one branch whose merge
    // preview comes back `invalid`, which is otherwise unreachable.
    name: "vendor/import-upstream-history",
    isCurrent: false,
    isRemote: false,
    upstream: null,
    ahead: 214,
    behind: 0,
    subject: "vendor: import upstream at 42b5f05",
    date: "2026-08-28T11:00:00Z",
  },
  {
    name: "origin/main",
    isCurrent: false,
    isRemote: true,
    upstream: null,
    ahead: 0,
    behind: 0,
    subject: "feat(api): move user reads onto /v2",
    date: "2026-09-17T09:12:00Z",
  },
  {
    name: "origin/feature/auth-v2",
    isCurrent: false,
    isRemote: true,
    upstream: null,
    ahead: 0,
    behind: 0,
    subject: "Switch API client to v2 endpoints",
    date: "2026-09-16T17:40:00Z",
  },
];

/** Live branch list: checkout, create, rename, delete and publish move it. */
let BRANCHES: BranchInfo[] = SEED_BRANCHES.map((branch) => ({ ...branch }));

const currentBranch = (): BranchInfo =>
  BRANCHES.find((branch) => branch.isCurrent && !branch.isRemote) ?? BRANCHES[0];

const branchByName = (name: string) => BRANCHES.find((branch) => branch.name === name);

const INITIAL_STASHES: StashEntry[] = [
  { index: 0, message: "WIP on main: 4f21a90 spike the token ramp", branch: "main" },
  {
    index: 1,
    message: "On feature/auth-v2: half-finished refresh-token flow",
    branch: "feature/auth-v2",
  },
  {
    index: 2,
    message:
      "On main: experiment — every surface on the shadcn base tokens before the derived keys land",
    branch: "main",
  },
];

let stashes: StashEntry[] = INITIAL_STASHES.map((stash) => ({ ...stash }));

interface FakeCommit {
  sha: string;
  message: string;
  author: string;
  email: string;
  date: string;
  /** Parents, newest-first in this list; a second parent makes it a merge. */
  parents: string[];
  lane: number;
  refs: CommitRow["refs"];
  files: CommitFile[];
}

const LANE_COLORS = ["#6e9cff", "#b07bff", "#4bd1a0", "#f2b955", "#f2555a"];

const COMMITS: FakeCommit[] = [
  {
    sha: "4f21a9033c1d8e77b0a5f1c2d3e4b5a6c7d8e9f0",
    message: "feat(api): move user reads onto /v2",
    author: "Dev",
    email: "dev@acme.dev",
    date: "2026-09-17T09:12:00Z",
    parents: ["9a1c2b3d4e5f60718293a4b5c6d7e8f901234567"],
    lane: 0,
    refs: [
      { name: "main", kind: "branch", isCurrent: true },
      { name: "origin/main", kind: "remote", isCurrent: false },
    ],
    files: [
      { path: "src/lib/api.ts", status: "M" },
      { path: "src/lib/utils.ts", status: "M" },
    ],
  },
  {
    sha: "9a1c2b3d4e5f60718293a4b5c6d7e8f901234567",
    message: "Merge branch 'fix/pdf-annotations'",
    author: "Dev",
    email: "dev@acme.dev",
    date: "2026-09-16T18:02:00Z",
    parents: [
      "1b2c3d4e5f60718293a4b5c6d7e8f9012345678a",
      "c0ffee11223344556677889900aabbccddeeff01",
    ],
    lane: 0,
    refs: [],
    files: [{ path: "src/components/header.tsx", status: "M" }],
  },
  {
    sha: "c0ffee11223344556677889900aabbccddeeff01",
    message: "fix(pdf): keep highlight rects on rotate",
    author: "Priya Raghunathan",
    email: "priya@acme.dev",
    date: "2026-09-16T11:48:00Z",
    parents: ["1b2c3d4e5f60718293a4b5c6d7e8f9012345678a"],
    lane: 1,
    refs: [{ name: "fix/pdf-annotations", kind: "branch", isCurrent: false }],
    files: [{ path: "src/components/button.tsx", status: "M" }],
  },
  {
    sha: "1b2c3d4e5f60718293a4b5c6d7e8f9012345678a",
    message: "refactor(tokens): one source of truth for colour",
    author: "Dev",
    email: "dev@acme.dev",
    date: "2026-09-15T16:30:00Z",
    parents: ["2c3d4e5f60718293a4b5c6d7e8f9012345678abc"],
    lane: 0,
    refs: [{ name: "v2.4.1", kind: "tag", isCurrent: false }],
    files: [{ path: "src/styles/tokens.css", status: "M" }],
  },
  {
    sha: "2c3d4e5f60718293a4b5c6d7e8f9012345678abc",
    message: "chore: drop the legacy token reader",
    author: "Sam Oyelaran",
    email: "sam@acme.dev",
    date: "2026-09-14T10:15:00Z",
    parents: ["3d4e5f60718293a4b5c6d7e8f9012345678abcde"],
    lane: 0,
    refs: [],
    files: [{ path: "src/legacy/auth.ts", status: "D" }],
  },
  {
    sha: "3d4e5f60718293a4b5c6d7e8f9012345678abcde",
    message:
      "feat(admin): paginate the user table, add the plan column, and stop refetching on window focus",
    author: "Dev",
    email: "dev@acme.dev",
    date: "2026-09-12T13:05:00Z",
    parents: ["4e5f60718293a4b5c6d7e8f9012345678abcdef0"],
    lane: 0,
    refs: [],
    files: [
      { path: "src/main.tsx", status: "M" },
      { path: "src/lib/api.ts", status: "M" },
    ],
  },
  {
    sha: "4e5f60718293a4b5c6d7e8f9012345678abcdef0",
    message: "build: move to Vite 6",
    author: "Priya Raghunathan",
    email: "priya@acme.dev",
    date: "2026-09-09T09:41:00Z",
    parents: ["5f60718293a4b5c6d7e8f9012345678abcdef012"],
    lane: 0,
    refs: [],
    files: [
      { path: "package.json", status: "M" },
      { path: "tsconfig.json", status: "M" },
    ],
  },
  {
    sha: "5f60718293a4b5c6d7e8f9012345678abcdef012",
    message: "docs: rewrite the README layout table",
    author: "Sam Oyelaran",
    email: "sam@acme.dev",
    date: "2026-09-05T15:20:00Z",
    parents: [],
    lane: 0,
    refs: [{ name: "v2.4.0", kind: "tag", isCurrent: false }],
    files: [{ path: "README.md", status: "M" }],
  },
];

const shortSha = (sha: string) => sha.slice(0, 7);

/**
 * A commit's diff. Files that are also dirty in the working tree reuse that
 * change (one fixture, two surfaces); the rest get a synthetic hunk — a block
 * from the middle of the file that this commit "added" — so no commit opens
 * empty and none reads as a one-line stub in screenshots.
 */
function commitDiff(commit: FakeCommit): string {
  return commit.files
    .map((file) => {
      const change = changeFor(file.path);
      if (change && !change.binary) return unifiedDiff(change.before(), change.after(), file.path);
      if (file.status === "D") return unifiedDiff(LEGACY_AUTH_TS, "", file.path);
      const text = fileText(file.path);
      return unifiedDiff(withoutMiddleBlock(text), text, file.path);
    })
    .join("");
}

/** `text` minus up to eight lines from its middle: the "before" of a commit
 *  that added them. Short files lose their last line instead. */
function withoutMiddleBlock(text: string): string {
  const lines = text.split("\n");
  if (lines.length < 6) return lines.slice(0, -1).join("\n");
  const size = Math.min(8, Math.max(2, Math.floor(lines.length / 5)));
  const start = Math.floor((lines.length - size) / 2);
  return [...lines.slice(0, start), ...lines.slice(start + size)].join("\n");
}

function graph(): BuiltGraph {
  const laneCount = Math.max(...COMMITS.map((commit) => commit.lane)) + 1;
  const rows: CommitRow[] = COMMITS.map((commit, index) => {
    const segments: LaneSegment[] = [];
    const color = LANE_COLORS[commit.lane % LANE_COLORS.length];
    // Incoming edge from the row above, unless this is the first row.
    if (index > 0) {
      segments.push({ fromLane: commit.lane, toLane: commit.lane, fromY: 0, toY: 0.5, color });
    }
    for (const parent of commit.parents) {
      const target = COMMITS.find((candidate) => candidate.sha === parent);
      if (!target) continue;
      segments.push({
        fromLane: commit.lane,
        toLane: target.lane,
        fromY: 0.5,
        toY: 1,
        color: LANE_COLORS[target.lane % LANE_COLORS.length],
      });
    }
    return {
      sha: commit.sha,
      shortSha: shortSha(commit.sha),
      message: commit.message,
      author: commit.author,
      email: commit.email,
      date: commit.date,
      refs: commit.refs,
      isHead: index === 0,
      commitLane: commit.lane,
      commitColor: color,
      segments,
    };
  });
  return { rows, laneCount, totalCommits: rows.length };
}

/** Per-line blame for the editor's inline annotation. */
function blame(file: string): BlameLine[] {
  const text = fileText(file);
  if (!text) return [];
  const change = changeFor(file);
  const lineCount = text.replace(/\n$/, "").split("\n").length;
  const touched = new Set(change && !change.binary ? lineStatusOf(diffFor(file)).changed : []);
  const added = new Set(change && !change.binary ? lineStatusOf(diffFor(file)).added : []);
  return Array.from({ length: lineCount }, (_, i) => {
    const line = i + 1;
    // Uncommitted lines are the ones this working tree changed.
    if (touched.has(line) || added.has(line)) {
      return {
        line,
        sha: "0000000000000000000000000000000000000000",
        shortSha: "0000000",
        author: "Not Committed Yet",
        timeMs: 0,
        summary: "Uncommitted changes",
        committed: false,
      };
    }
    const commit = COMMITS[(line * 7) % COMMITS.length];
    return {
      line,
      sha: commit.sha,
      shortSha: shortSha(commit.sha),
      author: commit.author,
      timeMs: Date.parse(commit.date),
      summary: commit.message,
      committed: true,
    };
  });
}

// ── writes ────────────────────────────────────────────────────────────────
//
// The read handlers above are pure views over the state in this file, so a
// write only has to move that state: the next refresh then shows it. What
// triggers the refresh is the same thing that triggers it for real — Rust's
// `emit_synthetic_change` fires `atlas:git-changed` after every mutation and
// the store re-runs `git_snapshot` / `git_log` / `git_diff_all` on it. Long
// operations additionally stream `atlas:git:op` (started → output → progress
// → done), which is what drives the commit busy state, the progress bar and
// the live output strip.
//
// Failures are first-class here: a fake that only ever succeeds leaves the
// error dialog, the toasts and the in-progress/conflict banner unreachable.
// Every `fail()` below is a state the real backend also produces.

/** Bumped by every mutation, so `git_graph_signature` changes and the graph
 *  query refetches instead of serving its `staleTime: Infinity` cache. */
let epoch = 0;

/**
 * Hand the frontend a copy of any row this file later mutates. Zustand's
 * immer middleware deep-FREEZES whatever it stores, so a fixture object that
 * reaches `git_snapshot`'s result can never be written to again — the second
 * push would throw on `branch.ahead += 1` instead of pushing.
 */
const copy = <T>(rows: T[]): T[] => rows.map((row) => ({ ...row }));

let inProgress: InProgress = { merge: false, rebase: false, cherryPick: false, revert: false };
let conflicts: ConflictFile[] = [];
/** Files the conflict itself put in the tree. `--abort` restores the tree the
 *  operation started from, so only these come back out — an edit that was
 *  already dirty before the merge survives aborting it. */
let conflictAdded: string[] = [];
/** `.git/MERGE_MSG` — the prepared message the conflicts view shows. */
let mergeMessage = "";

let tags = ["v2.4.1", "v2.4.0", "v2.3.7", "v2.3.6"];

let remotes: RemoteInfo[] = [
  { name: "origin", url: "git@github.com:acme/acme-app.git" },
  { name: "upstream", url: "https://github.com/acme-oss/acme-app.git" },
];

const anyInProgress = () =>
  inProgress.merge || inProgress.rebase || inProgress.cherryPick || inProgress.revert;

const clearInProgress = () => {
  inProgress = { merge: false, rebase: false, cherryPick: false, revert: false };
  conflicts = [];
  conflictAdded = [];
  mergeMessage = "";
};

/** What Rust's `emit_synthetic_change` does after every mutating command. */
function notifyChanged(): void {
  epoch += 1;
  void emit("atlas:git-changed", { project: MOCK_PROJECT.path });
}

/** A typed rejection, shaped exactly like `atlas_git::GitErrorPayload` —
 *  `handleGitError` routes on `code`, so the code decides whether the UI
 *  shows the error dialog, an error toast or a quiet info toast. */
function fail(
  code: GitErrorCode,
  message: string,
  extra: Partial<GitErrorPayload> = {},
): GitErrorPayload {
  return { code, message, rawStderr: `fatal: ${message}`, command: "git", ...extra };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One `atlas:git:op` event minus the fields `runOp` fills in, per phase. */
type OpPhase = GitOpEvent extends infer E
  ? E extends GitOpEvent
    ? Omit<E, "opId" | "repo" | "kind">
    : never
  : never;

interface OpStep {
  line?: string;
  stream?: "stdout" | "stderr";
  percent?: number;
  title?: string;
  delay?: number;
}

/**
 * Run one streaming operation. Without an `opId` Rust runs the command
 * buffered and emits nothing, so this does the same — the difference is what
 * makes the progress bar appear for a toolbar push but not for the merge
 * dialog's silent fetch-on-open.
 *
 * The steps run BEFORE `finish`, so a rejection lands after the output the
 * real git already printed: the op strip stays up with git's own complaint
 * above the error, which is the state that matters when a push is refused.
 */
async function runOp<T>(kind: string, opId: unknown, steps: OpStep[], finish: () => T): Promise<T> {
  const id = typeof opId === "string" ? opId : null;
  const send = (event: OpPhase) => {
    if (!id) return;
    const payload: GitOpEvent = { opId: id, repo: MOCK_PROJECT.path, kind, ...event };
    void emit("atlas:git:op", payload);
  };
  send({ phase: "started" });
  for (const step of steps) {
    await sleep(step.delay ?? 110);
    if (step.line !== undefined) {
      send({ phase: "output", stream: step.stream ?? "stderr", line: step.line });
    }
    if (step.percent !== undefined) {
      send({ phase: "progress", percent: step.percent, title: step.title ?? kind });
    }
  }
  try {
    const result = finish();
    send({ phase: "done", ok: true });
    notifyChanged();
    return result;
  } catch (error) {
    send({ phase: "done", ok: false, error: error as GitErrorPayload });
    notifyChanged();
    throw error;
  }
}

// ── commit graph writes ───────────────────────────────────────────────────

let shaCounter = 0;

/** Deterministic but distinct — a real sha is only ever compared, sliced to
 *  7 chars and used as a React key. */
function newSha(): string {
  shaCounter += 1;
  const stamp = (Date.now() * 64 + shaCounter).toString(16);
  return (stamp + "9f3b71c04ae25d8610fc4b72e93d5a8017cbe264").slice(0, 40);
}

const HEAD = () => COMMITS[0];

/** Move a ref (branch / tag / remote) onto `sha`, off wherever it was. */
function moveRef(name: string, kind: CommitRow["refs"][number]["kind"], sha: string | null): void {
  for (const commit of COMMITS) {
    commit.refs = commit.refs.filter((ref) => !(ref.kind === kind && ref.name === name));
  }
  const target = sha ? COMMITS.find((commit) => commit.sha === sha) : undefined;
  if (!target) return;
  target.refs = [
    ...target.refs,
    { name, kind, isCurrent: kind === "branch" && name === currentBranch().name },
  ];
}

/** Re-point every branch ref's `isCurrent` after a checkout / rename. */
function syncRefCurrency(): void {
  const head = currentBranch().name;
  for (const commit of COMMITS) {
    commit.refs = commit.refs.map((ref) =>
      ref.kind === "branch" ? { ...ref, isCurrent: ref.name === head } : ref,
    );
  }
}

interface NewCommit {
  message: string;
  author?: string;
  email?: string;
  parents?: string[];
  lane?: number;
  files?: CommitFile[];
}

/** Prepend a commit and drag the current branch's ref onto it. */
function addCommit(spec: NewCommit): FakeCommit {
  const commit: FakeCommit = {
    sha: newSha(),
    message: spec.message,
    author: spec.author ?? "Dev",
    email: spec.email ?? "dev@acme.dev",
    date: new Date().toISOString(),
    parents: spec.parents ?? [HEAD().sha],
    lane: spec.lane ?? 0,
    refs: [],
    files: spec.files ?? [],
  };
  COMMITS.unshift(commit);
  moveRef(currentBranch().name, "branch", commit.sha);
  currentBranch().subject = commit.message.split("\n")[0];
  currentBranch().date = commit.date;
  return commit;
}

/**
 * The tip of a branch that has no ref in the fixture graph (`feature/auth-v2`
 * and friends were authored as branch rows, not commit rows). Merging or
 * pulling one materialises its tip on its own lane, which is what makes the
 * resulting merge draw as a merge instead of a straight line.
 */
function materialiseTip(branch: BranchInfo, lane: number): FakeCommit {
  const existing = COMMITS.find((commit) =>
    commit.refs.some((ref) => ref.kind === "branch" && ref.name === branch.name),
  );
  if (existing) return existing;
  const tip: FakeCommit = {
    sha: newSha(),
    message: branch.subject,
    author: "Priya Raghunathan",
    email: "priya@acme.dev",
    date: branch.date,
    parents: [HEAD().sha],
    lane,
    refs: [{ name: branch.name, kind: "branch", isCurrent: false }],
    files: [{ path: "src/lib/api.ts", status: "M" }],
  };
  COMMITS.splice(1, 0, tip);
  return tip;
}

// ── conflict shaping ──────────────────────────────────────────────────────

/**
 * The branch whose merge/rebase/cherry-pick stops on conflicts — the same
 * story the `git-conflict` scenario tells, reachable from the default one by
 * clicking Merge. Without it the in-progress banner, the conflicts view and
 * `git_op_control` are all dead UI in the default scenario.
 */
const CONFLICTING_BRANCH = "feature/auth-v2";

const CONFLICT_FILES: ConflictFile[] = [
  { path: "src/lib/api.ts", markerCount: 3, xy: "UU" },
  { path: "src/components/header.tsx", markerCount: 1, xy: "UU" },
  // Both sides added it: the case where "ours"/"theirs" is the only way out.
  { path: "package.json", markerCount: 2, xy: "AA" },
];

function enterConflict(kind: "merge" | "rebase" | "cherryPick" | "revert", message: string): void {
  inProgress = {
    merge: kind === "merge",
    rebase: kind === "rebase",
    cherryPick: kind === "cherryPick",
    revert: kind === "revert",
  };
  conflicts = CONFLICT_FILES.map((file) => ({ ...file }));
  conflictAdded = conflicts.filter((file) => !changeFor(file.path)).map((file) => file.path);
  mergeMessage = message;
  for (const file of conflicts) restoreChange(file.path, "modified", false);
}

// ── merge previews ────────────────────────────────────────────────────────

/**
 * One entry per outcome `MergePreview.kind` can carry, so the dialog's four
 * reachable renderings (clean / conflicts / up-to-date / unrelated) can each
 * be seen by picking a branch. `unsupported` is deliberately absent: it means
 * "your git is older than 2.38", which is a property of the machine, not of
 * any branch, and nothing in the dialog can get you there.
 */
const MERGE_PREVIEWS: Record<string, MergePreview> = {
  "feature/auth-v2": { kind: "conflicts", commitCount: 4, conflictedFiles: 3 },
  "origin/feature/auth-v2": { kind: "conflicts", commitCount: 4, conflictedFiles: 3 },
  "renovate/design-tokens-and-the-entire-colour-system-rewrite": {
    kind: "clean",
    commitCount: 12,
    conflictedFiles: 0,
  },
  "vendor/import-upstream-history": { kind: "invalid", commitCount: 0, conflictedFiles: 0 },
};

// ── working-tree stats ────────────────────────────────────────────────────

let statsCache: { epoch: number; additions: number; deletions: number } | null = null;

/** Additions/deletions across the whole tree, for the sidebar summary.
 *  Recomputed only when something moved — it re-diffs every dirty file. */
function treeStats(): { additions: number; deletions: number } {
  if (statsCache?.epoch === epoch) return statsCache;
  let additions = 0;
  let deletions = 0;
  for (const change of CHANGES) {
    if (change.binary) continue;
    const stats = buildFileDiff(change.before(), change.after(), change.path).stats;
    additions += stats.additions;
    deletions += stats.deletions;
  }
  statsCache = { epoch, additions, deletions };
  return statsCache;
}

// ── handlers ──────────────────────────────────────────────────────────────

/** Per-project summaries: a dirty repo, a clean one, and a non-repo. */
const SUMMARIES: Record<string, GitSummary> = {
  [ALL_PROJECTS[1].path]: {
    isRepo: true,
    branch: "renovate/design-tokens-and-the-entire-colour-system-rewrite",
    headSubject: "chore(deps): bump every design-token package and regenerate the palette",
    dirty: false,
    additions: 0,
    deletions: 0,
  },
  [ALL_PROJECTS[2].path]: {
    isRepo: false,
    branch: "",
    headSubject: "",
    dirty: false,
    additions: 0,
    deletions: 0,
  },
};

/**
 * Branches whose tip touches these paths. Checking one out while the same
 * file is dirty is what git refuses with "local changes would be overwritten"
 * — the error dialog's most common real cause, and unreachable otherwise.
 */
const BRANCH_TOUCHES: Record<string, string[]> = {
  "feature/auth-v2": ["src/lib/api.ts"],
  "renovate/design-tokens-and-the-entire-colour-system-rewrite": ["src/styles/tokens.css"],
};

/** Porcelain rows. A partially-staged file appears TWICE — once for the index
 *  half, once for the worktree half — which is how the panel can list it in
 *  both sections at the same time. */
function statusRows(): GitSnapshotWire["files"] {
  return CHANGES.flatMap((change) => {
    const conflicted = conflicts.some((file) => file.path === change.path);
    if (partial.has(change.path)) {
      return [
        { path: change.path, status: change.status, staged: true, conflicted: false },
        { path: change.path, status: change.status, staged: false, conflicted: false },
      ];
    }
    return [
      {
        path: change.path,
        status: change.status,
        staged: staged.get(change.path) ?? false,
        conflicted,
      },
    ];
  });
}

/** A local branch tracking `remoteName`, as `git checkout origin/x` creates. */
function addTrackingBranch(short: string, remote: BranchInfo): BranchInfo {
  const branch: BranchInfo = {
    name: short,
    isCurrent: false,
    isRemote: false,
    upstream: remote.name,
    ahead: 0,
    behind: 0,
    subject: remote.subject,
    date: remote.date,
  };
  BRANCHES = [...BRANCHES, branch];
  return branch;
}

function switchTo(branch: BranchInfo): void {
  BRANCHES = BRANCHES.map((candidate) => ({
    ...candidate,
    isCurrent: candidate.name === branch.name && !candidate.isRemote,
  }));
  syncRefCurrency();
}

/** `git push`'s stderr, replayed as the progress steps the parser feeds on. */
const PUSH_STEPS: OpStep[] = [
  { line: "Enumerating objects: 27, done.", percent: 10, title: "Enumerating objects" },
  { line: "Counting objects: 100% (27/27), done.", percent: 30, title: "Counting objects" },
  { line: "Compressing objects: 100% (14/14), done.", percent: 60, title: "Compressing objects" },
  {
    line: "Writing objects: 100% (15/15), 2.41 KiB | 2.41 MiB/s, done.",
    percent: 90,
    title: "Writing objects",
  },
  { line: "remote: Resolving deltas: 100% (9/9), completed with 7 local objects.", percent: 100 },
];

const FETCH_STEPS: OpStep[] = [
  { line: "remote: Enumerating objects: 12, done.", percent: 20, title: "Enumerating objects" },
  { line: "remote: Counting objects: 100% (12/12), done.", percent: 55, title: "Counting objects" },
  { line: "Unpacking objects: 100% (7/7), done.", percent: 100, title: "Unpacking objects" },
  { line: "From github.com:acme/acme-app", stream: "stderr" },
];

/**
 * What the frontend reads from each command below — the type argument of its
 * `invoke<T>`, or `Unread` where it awaits only success or failure.
 */
export interface GitResponses {
  git_watch_start: Unread;
  git_watch_stop: Unread;
  git_autofetch_set_active: AutoFetchStatus | null;
  git_workspace_summary: GitSummary;
  git_snapshot: GitSnapshotWire;
  git_status_fresh: RawGitStatus;
  git_inprogress: InProgress;
  git_branches_full: BranchInfo[];
  git_list_branches: GitBranch[];
  git_stash_list: StashEntry[];
  git_stash_drop: Unread;
  git_stash_pop: Unread;
  git_stash_apply: Unread;
  git_stash_push: Unread;
  git_remotes: RemoteInfo[];
  git_tags: string[];
  git_log: GitLogEntry[];
  git_show: CommitDetail;
  capture_commit_sessions: CommitSession[];
  git_commit_changed_files: CommitFile[];
  git_graph_signature: string;
  git_graph_build: BuiltGraph;
  git_diff_structured: FileDiff;
  diff_structured_text: FileDiff;
  git_diff_line_status: DiffLineStatus;
  git_diff_file: string;
  git_diff_all: string;
  git_blame_file: BlameLine[];
  git_repo_pull_requests: RepoPullRequests;
  git_repo_avatars: RepoAvatars;
  git_stage: Unread;
  git_unstage: Unread;
  // `runHunkOp` in `changes-view.tsx` picks the command name at run time.
  git_stage_hunk: Unread;
  git_unstage_hunk: Unread;
  git_discard_hunk: Unread;
  git_discard: Unread;
  git_delete_added: Unread;
  git_commit_v2: Unread;
  git_push: Unread;
  git_pull: Unread;
  git_pull_preference: PullPreference;
  git_fetch: Unread;
  git_publish_branch: Unread;
  git_checkout: Unread;
  git_create_branch: Unread;
  git_rename_branch: Unread;
  git_branch_delete: Unread;
  git_merge_preview: MergePreview;
  git_merge_branch: Unread;
  git_rebase: Unread;
  git_op_control: Unread;
  git_conflict_state: ConflictState;
  git_resolve_file: Unread;
  git_undo_commit: Unread;
  git_squash_last: Unread;
  git_reset: Unread;
  git_revert: Unread;
  git_cherry_pick: Unread;
  git_create_tag: Unread;
  git_delete_tag: Unread;
  git_remote_add: Unread;
  git_remote_remove: Unread;
}

// ── console actions ──────────────────────────────────────────────────────
// Real git state the fake cannot reach by clicking: a saved `pull.rebase`,
// and pushed commits rewritten by a rebase in a terminal.

/** What `git_pull_preference` answers; "ask" is a fresh install. */
let pullPreference: PullPreference = "ask";
/** The remote still has old copies of commits HEAD has rewritten. */
let pushedCommitsRewritten = false;

/** As if `pull.rebase=true`: a diverged pull rebases without asking. */
export function gitPullPrefersRebase(): string {
  pullPreference = "rebase";
  return "pull.rebase=true — a diverged pull rebases without asking";
}

/** As if `pull.rebase=false`: a diverged pull merges without asking. */
export function gitPullPrefersMerge(): string {
  pullPreference = "merge";
  return "pull.rebase=false — a diverged pull merges without asking";
}

/** No saved preference (the default): a diverged pull asks. */
export function gitPullAsks(): string {
  pullPreference = "ask";
  return "no pull.rebase — a diverged pull asks";
}

/** As if the current branch's pushed commits were rebased elsewhere: the
 *  next plain push is rejected as `history-rewritten`, a force push lands. */
export function gitRewritePushedCommits(): string {
  const branch = currentBranch();
  pushedCommitsRewritten = true;
  branch.behind = Math.max(branch.behind, 2);
  branch.ahead = Math.max(branch.ahead, 2);
  notifyChanged();
  return `${branch.name}: pushed commits rewritten — Push to see the rejection`;
}

export const gitHandlers: TypedHandlers<GitResponses> = {
  // ── watcher ─────────────────────────────────────────────────────────────
  git_watch_start: () => null,
  // Fired on every project close. Nothing reads the result, but leaving it
  // unmocked puts a warning on the badge for an action that did work.
  git_watch_stop: () => null,
  // As if the project was auto-fetched a few minutes ago, so the Fetch
  // button's hint has something to say in `bun run dev`.
  git_autofetch_set_active: ({ projectPath }): AutoFetchStatus | null =>
    projectPath
      ? { project: String(projectPath), lastFetchedAt: Date.now() - 3 * 60_000, lastError: null }
      : null,

  // ── status ──────────────────────────────────────────────────────────────
  git_workspace_summary: ({ path }): GitSummary => {
    // The active project's summary is live: commit and the sidebar's
    // dirty dot / +N −M go quiet with the panel, rather than disagreeing.
    if (String(path) === MOCK_PROJECT.path) {
      const { additions, deletions } = treeStats();
      return {
        isRepo: true,
        branch: currentBranch().name,
        headSubject: HEAD().message.split("\n")[0],
        dirty: CHANGES.length > 0,
        additions,
        deletions,
      };
    }
    return (
      SUMMARIES[String(path)] ?? {
        isRepo: false,
        branch: "",
        headSubject: "",
        dirty: false,
        additions: 0,
        deletions: 0,
      }
    );
  },
  git_snapshot: (): GitSnapshotWire => {
    const branch = currentBranch();
    return {
      isRepo: true,
      branch: branch.name,
      detached: false,
      upstream: branch.upstream,
      ahead: branch.ahead,
      behind: branch.behind,
      files: statusRows(),
      branches: copy(BRANCHES),
      stashes: copy(stashes),
      inProgress: anyInProgress() ? { ...inProgress } : null,
    };
  },
  // The terminal's cwd badge, not the git panel — same state, older wire shape.
  git_status_fresh: (): RawGitStatus => ({
    is_repo: true,
    branch: currentBranch().name,
    files: statusRows().map((row) => ({
      path: row.path,
      status: row.status,
      staged: row.staged,
    })),
    ahead: currentBranch().ahead,
    behind: currentBranch().behind,
  }),
  git_inprogress: (): InProgress => ({ ...inProgress }),
  git_branches_full: (): BranchInfo[] => copy(BRANCHES),
  git_list_branches: (): GitBranch[] =>
    BRANCHES.filter((branch) => !branch.isRemote).map((branch) => ({
      name: branch.name,
      is_current: branch.isCurrent,
    })),
  git_stash_list: (): StashEntry[] => copy(stashes),
  git_stash_drop: ({ index }): null => {
    stashes = stashes.filter((stash) => stash.index !== Number(index));
    notifyChanged();
    return null;
  },
  git_stash_pop: ({ index }): null => {
    stashes = stashes.filter((stash) => stash.index !== Number(index));
    notifyChanged();
    return null;
  },
  git_stash_apply: (): null => {
    notifyChanged();
    return null;
  },
  git_stash_push: ({ message }): null => {
    stashes = [
      {
        index: 0,
        message: String(message ?? `WIP on ${currentBranch().name}`),
        branch: currentBranch().name,
      },
      ...stashes.map((stash) => ({ ...stash, index: stash.index + 1 })),
    ];
    // Stashing takes the working tree with it — the whole point of the button.
    CHANGES = [];
    staged.clear();
    partial.clear();
    notifyChanged();
    return null;
  },
  git_remotes: (): RemoteInfo[] => copy(remotes),
  git_tags: (): string[] => [...tags],

  git_log: () =>
    COMMITS.map((commit) => ({
      hash: commit.sha,
      short_hash: shortSha(commit.sha),
      message: commit.message,
      author: commit.author,
      email: commit.email,
      date: commit.date,
    })),
  git_show: ({ sha }): CommitDetail => {
    const commit = COMMITS.find((candidate) => candidate.sha.startsWith(String(sha)));
    if (!commit) throw new Error(`bad object ${String(sha)}`);
    const [subject, ...rest] = commit.message.split("\n");
    return {
      hash: commit.sha,
      shortHash: shortSha(commit.sha),
      author: commit.author,
      email: commit.email,
      date: commit.date,
      subject,
      body: rest.join("\n"),
      diff: commitDiff(commit),
    };
  },
  // Most commits have no recorded Session (capture off, or human work), which
  // is the empty state; the two newest carry one so the panel is visible too.
  capture_commit_sessions: ({ commitSha }): CommitSession[] => {
    const commit = COMMITS.find((candidate) => candidate.sha.startsWith(String(commitSha)));
    if (!commit || COMMITS.indexOf(commit) > 1) return [];
    const sessions: CommitSession[] = [
      {
        sessionId: `sess-${shortSha(commit.sha)}`,
        title: commit.message.split("\n")[0],
        messageCount: 24,
        toolCallCount: 61,
        files: commit.files.map((file) => file.path),
      },
    ];
    // The newest commit had two contributors, so "Produced by N sessions"
    // has a plural state to render.
    if (COMMITS.indexOf(commit) === 0) {
      sessions.push({
        sessionId: `sess-${shortSha(commit.sha)}-b`,
        title: "Keep the retry helper honest about ApiError",
        messageCount: 9,
        toolCallCount: 17,
        files: commit.files.slice(0, 1).map((file) => file.path),
      });
    }
    return sessions;
  },
  git_commit_changed_files: ({ sha }): CommitFile[] =>
    COMMITS.find((commit) => commit.sha.startsWith(String(sha)))?.files ?? [],

  // `epoch` is what makes the graph refetch after a write: the query keys off
  // this string and is otherwise `staleTime: Infinity`.
  git_graph_signature: (): string => `${HEAD().sha}:${BRANCHES.length}:${stashes.length}:${epoch}`,
  git_graph_build: (): BuiltGraph => graph(),

  git_diff_structured: ({ file }): FileDiff => diffFor(String(file)),
  diff_structured_text: ({ oldText, newText, file }): FileDiff =>
    buildFileDiff(String(oldText ?? ""), String(newText ?? ""), String(file)),
  git_diff_line_status: ({ file }): DiffLineStatus => lineStatusOf(diffFor(String(file))),
  git_diff_file: ({ file }): string => {
    const change = changeFor(String(file));
    if (!change || change.binary) return "";
    return unifiedDiff(change.before(), change.after(), change.path);
  },
  git_diff_all: (): string =>
    CHANGES.filter((change) => !change.binary)
      .map((change) => unifiedDiff(change.before(), change.after(), change.path))
      .join(""),
  git_blame_file: ({ file }): BlameLine[] => blame(String(file)),
  // The default repository has no GitHub remote, so `gh` has nothing to say.
  git_repo_pull_requests: (): RepoPullRequests => ({ kind: "failed" }),
  git_repo_avatars: (): RepoAvatars => ({ kind: "failed" }),

  // ── index ───────────────────────────────────────────────────────────────
  git_stage: ({ files }): null => {
    for (const file of (files ?? []) as string[]) {
      staged.set(file, true);
      // Staging the file wholesale ends any partial state.
      partial.delete(file);
    }
    notifyChanged();
    return null;
  },
  git_unstage: ({ files }): null => {
    for (const file of (files ?? []) as string[]) {
      staged.set(file, false);
      partial.delete(file);
    }
    notifyChanged();
    return null;
  },
  /**
   * Partial staging. `git apply --cached` puts ONE hunk in the index and
   * leaves the rest in the worktree, so the file is simultaneously staged and
   * unstaged — the state the panel renders as two rows and the only reason
   * `partial` exists. Which hunk was sent doesn't matter to the fixture; the
   * diff it shows is still the whole file's.
   */
  git_stage_hunk: ({ file }): null => {
    const path = String(file);
    if (!changeFor(path)) return null;
    staged.set(path, true);
    partial.add(path);
    notifyChanged();
    return null;
  },
  git_unstage_hunk: ({ file }): null => {
    const path = String(file);
    if (!changeFor(path)) return null;
    staged.set(path, false);
    partial.delete(path);
    notifyChanged();
    return null;
  },
  /** Reverting a hunk drops the worktree half; with nothing staged, the whole
   *  change is gone (the confirm dialog says exactly that). */
  git_discard_hunk: ({ file }): null => {
    const path = String(file);
    const wasPartial = partial.delete(path);
    if (!wasPartial && !staged.get(path)) dropChange(path);
    notifyChanged();
    return null;
  },

  // ── working tree ────────────────────────────────────────────────────────
  git_discard: ({ files }): null => {
    for (const file of (files ?? []) as string[]) {
      // `git restore` only touches TRACKED files; an untracked one survives.
      if (changeFor(file)?.status === "untracked") continue;
      dropChange(file);
    }
    notifyChanged();
    return null;
  },
  // Added files have no HEAD to restore to, so reverting one deletes it —
  // including `public/logo.png`, which has no diff to review first.
  git_delete_added: ({ files }): null => {
    for (const file of (files ?? []) as string[]) dropChange(file);
    notifyChanged();
    return null;
  },

  // ── commit ──────────────────────────────────────────────────────────────
  /**
   * Streams like the real one: `started`, the hook output the strip renders,
   * then `done`. Committing with an empty index fails as `nothing-to-commit`,
   * which `handleGitError` shows as a quiet INFO toast rather than an error —
   * the one code path where a "failure" is a normal outcome.
   */
  git_commit_v2: ({ summary, description, amend, coAuthors, opId }) =>
    runOp(
      "commit",
      opId,
      CHANGES.some((change) => staged.get(change.path))
        ? [
            { line: "husky - pre-commit hook", delay: 180 },
            { line: "↓ lint-staged" },
            { line: "  ✔ oxlint --fix" },
            { line: "  ✔ oxfmt --write" },
          ]
        : [],
      (): null => {
        const staging = CHANGES.filter((change) => staged.get(change.path));
        const amending = Boolean(amend);
        if (staging.length === 0 && !amending) {
          throw fail("nothing-to-commit", "No changes added to commit.");
        }

        const authors = ((coAuthors ?? []) as string[]).filter(Boolean);
        const trailers = authors.map((author) => `Co-authored-by: ${author}`).join("\n");
        const body = [String(description ?? "").trim(), trailers].filter(Boolean).join("\n\n");
        const text = String(summary ?? "").trim();
        const message = [text, body].filter(Boolean).join("\n\n");

        const files: CommitFile[] = staging.map((change) => ({
          path: change.path,
          status: change.status === "untracked" ? "A" : change.status === "deleted" ? "D" : "M",
        }));

        if (amending) {
          // Amend keeps HEAD's position: ahead doesn't move, the message does.
          const head = HEAD();
          head.message = message || head.message;
          head.files = [...head.files, ...files];
          head.date = new Date().toISOString();
        } else {
          addCommit({ message, files });
          currentBranch().ahead += 1;
        }
        for (const change of staging) dropChange(change.path);
        return null;
      },
    ),

  /**
   * THE deliberate failure. `main` starts one commit behind its upstream, so
   * the first Push is rejected non-fast-forward — a DIALOG code, which is the
   * only way to see `git-error-dialog.tsx` at all. Pull, then push again, and
   * it goes through: behind → 0 clears the guard.
   */
  git_push: ({ forceWithLease, opId }) =>
    runOp("push", opId, PUSH_STEPS, (): string => {
      const branch = currentBranch();
      if (!branch.upstream) {
        throw fail("no-upstream", `The current branch ${branch.name} has no upstream branch.`, {
          hint: `git push --set-upstream origin ${branch.name}`,
        });
      }
      // `gitRewritePushedCommits`: what Rust's `explain_rejection` reports
      // when every remote-only commit is one of ours, rewritten.
      if (pushedCommitsRewritten && !forceWithLease) {
        throw fail(
          "history-rewritten",
          "Your commits were rewritten (rebased or amended) after they were pushed, so the remote still has the old copies. Pulling would bring those back; force-push to replace them.",
          {
            rawStderr: ` ! [rejected]        ${branch.name} -> ${branch.name} (non-fast-forward)\nerror: failed to push some refs to '${remotes[0]?.url ?? "origin"}'`,
            command: "git push --progress",
            exitCode: 1,
          },
        );
      }
      if (pushedCommitsRewritten) {
        pushedCommitsRewritten = false;
        branch.behind = 0;
      }
      if (branch.behind > 0 && !forceWithLease) {
        throw fail(
          "non-fast-forward",
          "Updates were rejected because the remote contains work that you do not have locally.",
          {
            rawStderr: ` ! [rejected]        ${branch.name} -> ${branch.name} (fetch first)\nerror: failed to push some refs to '${remotes[0]?.url ?? "origin"}'`,
            command: "git push --progress",
            exitCode: 1,
            hint: "Pull the remote changes first.",
          },
        );
      }
      // The remote-tracking ref catches up with HEAD — the graph's `main` and
      // `origin/main` chips land on the same row, which is the visible
      // difference between "3 ahead" and "pushed".
      branch.ahead = 0;
      moveRef(branch.upstream, "remote", HEAD().sha);
      return `To ${remotes[0]?.url ?? "origin"}\n   ${shortSha(HEAD().sha)}..${shortSha(HEAD().sha)}  ${branch.name} -> ${branch.name}\n`;
    }),

  // A fresh install: no `pull.rebase`, so a diverged pull asks. The
  // `gitPullPrefers*` console actions stand in for a saved preference.
  git_pull_preference: (): PullPreference => pullPreference,

  git_pull: ({ strategy = "default", opId }) =>
    runOp("pull", opId, FETCH_STEPS, (): string => {
      const branch = currentBranch();
      if (!branch.upstream) {
        throw fail("no-upstream", `There is no tracking information for the current branch.`);
      }
      if (branch.behind === 0) return "Already up to date.\n";
      // A plain pull follows the saved preference, as git does.
      if (strategy === "default" && pullPreference !== "ask") strategy = pullPreference;
      // Diverged with no strategy: what real git does when `pull.rebase` is
      // unset — the panel asks up front, so this is the fallback path.
      if (strategy === "default" && branch.ahead > 0) {
        throw fail(
          "divergent-branches",
          "Your branch and the remote both have new commits. Choose whether to rebase your commits on top of the remote's or merge the two.",
          {
            rawStderr:
              "hint: You have divergent branches and need to specify how to reconcile them.\nfatal: Need to specify how to reconcile divergent branches.\n",
            command: "git pull --progress",
          },
        );
      }
      const incoming = branch.behind;
      branch.behind = 0;
      if (strategy === "rebase" || branch.ahead === 0) {
        // Fast-forward / rebase: the upstream commit just lands on the lane,
        // and the remote ref sits on it with ours.
        const pulled = addCommit({
          message: "fix(admin): guard the seat-limit banner on an empty plan",
          author: "Sam Oyelaran",
          email: "sam@acme.dev",
          files: [{ path: "src/main.tsx", status: "M" }],
        });
        moveRef(branch.upstream, "remote", pulled.sha);
        return `Updating ${shortSha(pulled.sha)}\nFast-forward ${incoming} commit(s)\n`;
      }
      // Diverged: git makes a merge commit, and the graph grows a second
      // lane — the case worth being able to see without a real remote.
      const upstream = COMMITS[0];
      const remoteTip: FakeCommit = {
        sha: newSha(),
        message: "fix(admin): guard the seat-limit banner on an empty plan",
        author: "Sam Oyelaran",
        email: "sam@acme.dev",
        date: new Date().toISOString(),
        parents: [upstream.sha],
        lane: 1,
        refs: [],
        files: [{ path: "src/main.tsx", status: "M" }],
      };
      COMMITS.unshift(remoteTip);
      addCommit({
        message: `Merge branch '${branch.upstream}' into ${branch.name}`,
        parents: [upstream.sha, remoteTip.sha],
      });
      branch.ahead += 1;
      // The remote ref stays on what the remote actually has — the merge
      // commit is ours and unpushed, which is why ahead goes up, not down.
      moveRef(branch.upstream, "remote", remoteTip.sha);
      return `Merge made by the 'ort' strategy — ${incoming} commit(s) brought in.\n`;
    }),

  /**
   * Fetch moves refs, never the working tree. It reports movement only when
   * there is unpushed work to be behind (`ahead > 0, behind === 0`), so
   * re-opening the merge dialog — which fetches on every open — can't inflate
   * the behind count forever.
   */
  git_fetch: ({ path, opId }) =>
    runOp("fetch", opId, FETCH_STEPS, (): string => {
      // Rust reports a successful manual fetch to the auto-fetch hint too.
      const status: AutoFetchStatus = {
        project: String(path),
        lastFetchedAt: Date.now(),
        lastError: null,
      };
      void emit("atlas:git-autofetch", status);
      const now = new Date().toISOString();
      for (const branch of BRANCHES) if (branch.isRemote) branch.date = now;
      const branch = currentBranch();
      if (branch.upstream && branch.ahead > 0 && branch.behind === 0) {
        branch.behind = 1;
        return `From github.com:acme/acme-app\n   ${shortSha(HEAD().sha)}..e4c1a90  ${branch.name} -> ${branch.upstream}\n`;
      }
      return "";
    }),

  git_publish_branch: ({ opId }) =>
    runOp("push", opId, PUSH_STEPS, (): string => {
      const branch = currentBranch();
      const remote = String(remotes[0]?.name ?? "origin");
      branch.upstream = `${remote}/${branch.name}`;
      branch.ahead = 0;
      branch.behind = 0;
      BRANCHES = [
        ...BRANCHES,
        {
          name: branch.upstream,
          isCurrent: false,
          isRemote: true,
          upstream: null,
          ahead: 0,
          behind: 0,
          subject: branch.subject,
          date: branch.date,
        },
      ];
      moveRef(branch.upstream, "remote", HEAD().sha);
      return `Branch '${branch.name}' set up to track '${branch.upstream}'.\n`;
    }),

  // ── branches ────────────────────────────────────────────────────────────
  git_checkout: ({ branch }): null => {
    const name = String(branch);
    if (name === currentBranch().name) return null; // git: "Already on 'main'"
    let target = branchByName(name);
    // Checking out a remote-tracking ref creates the local tracking branch,
    // which is how the switcher's `origin/…` rows are meant to work.
    if (target?.isRemote) {
      const short = name.replace(/^[^/]+\//, "");
      target = branchByName(short) ?? addTrackingBranch(short, target);
    }
    if (!target) {
      throw fail("unknown-ref", `pathspec '${name}' did not match any file(s) known to git`);
    }
    const blocking = (BRANCH_TOUCHES[target.name] ?? []).filter((file) => changeFor(file));
    if (blocking.length > 0) {
      throw fail(
        "local-changes-overwritten",
        "Your local changes to the following files would be overwritten by checkout.",
        { files: blocking, hint: "Commit, stash or discard them first." },
      );
    }
    switchTo(target);
    notifyChanged();
    return null;
  },
  // `checkout -b`: creates AND switches, which is what Rust runs.
  git_create_branch: ({ name }): null => {
    const branch = String(name);
    if (branchByName(branch)) {
      throw fail("branch-already-exists", `A branch named '${branch}' already exists.`);
    }
    const created: BranchInfo = {
      name: branch,
      isCurrent: false,
      isRemote: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      subject: HEAD().message.split("\n")[0],
      date: new Date().toISOString(),
    };
    BRANCHES = [...BRANCHES, created];
    switchTo(created);
    moveRef(branch, "branch", HEAD().sha);
    notifyChanged();
    return null;
  },
  git_rename_branch: ({ oldName, newName }): null => {
    const from = String(oldName);
    const to = String(newName);
    if (!branchByName(from)) throw fail("unknown-ref", `branch '${from}' not found.`);
    if (branchByName(to)) {
      throw fail("branch-already-exists", `A branch named '${to}' already exists.`);
    }
    BRANCHES = BRANCHES.map((branch) =>
      branch.name === from ? { ...branch, name: to, upstream: null } : branch,
    );
    for (const commit of COMMITS) {
      commit.refs = commit.refs.map((ref) =>
        ref.kind === "branch" && ref.name === from ? { ...ref, name: to } : ref,
      );
    }
    notifyChanged();
    return null;
  },
  /**
   * Two refusals, both real: git will not delete the branch you are standing
   * on, and `-d` will not delete one whose commits aren't merged anywhere.
   * The panel only ever passes `force: false`, so the unmerged branch
   * (`renovate/…`, 12 commits, no upstream) is a dead end by design.
   */
  git_branch_delete: ({ name, force }): null => {
    const branch = branchByName(String(name));
    if (!branch) throw fail("unknown-ref", `branch '${String(name)}' not found.`);
    if (branch.isCurrent) {
      throw fail(
        "generic",
        `Cannot delete branch '${branch.name}' checked out at '${MOCK_PROJECT.path}'`,
      );
    }
    if (!force && !branch.upstream && branch.ahead > 0) {
      throw fail("generic", `The branch '${branch.name}' is not fully merged.`, {
        hint: `If you are sure you want to delete it, run 'git branch -D ${branch.name}'.`,
      });
    }
    BRANCHES = BRANCHES.filter((candidate) => candidate.name !== branch.name);
    moveRef(branch.name, "branch", null);
    notifyChanged();
    return null;
  },

  // ── merge / rebase ──────────────────────────────────────────────────────
  git_merge_preview: ({ branch }): MergePreview => {
    const name = String(branch);
    const known = branchByName(name);
    if (!known) throw fail("unknown-ref", `branch '${name}' not found`);
    return (
      MERGE_PREVIEWS[name] ??
      (known.ahead === 0
        ? { kind: "uptodate", commitCount: 0, conflictedFiles: 0 }
        : { kind: "clean", commitCount: known.ahead, conflictedFiles: 0 })
    );
  },
  git_merge_branch: ({ branch }): string => {
    const name = String(branch);
    const source = branchByName(name);
    if (!source) throw fail("unknown-ref", `merge: ${name} - not something we can merge`);
    if (name === CONFLICTING_BRANCH || name === `origin/${CONFLICTING_BRANCH}`) {
      enterConflict("merge", `Merge branch '${CONFLICTING_BRANCH}'`);
      notifyChanged();
      throw fail("merge-conflicts", "Automatic merge failed; fix conflicts and then commit.", {
        files: conflicts.map((file) => file.path),
      });
    }
    const base = HEAD().sha;
    const tip = materialiseTip(source, 1);
    addCommit({
      message: `Merge branch '${name}' into ${currentBranch().name}`,
      parents: [base, tip.sha],
      files: [{ path: "src/lib/api.ts", status: "M" }],
    });
    currentBranch().ahead += 1;
    notifyChanged();
    return `Merge made by the 'ort' strategy.\n`;
  },
  git_rebase: ({ base, opId }) =>
    runOp(
      "rebase",
      opId,
      [
        { line: "Rebasing (1/3)", percent: 33 },
        { line: "Rebasing (2/3)", percent: 66 },
        { line: "Rebasing (3/3)", percent: 100 },
      ],
      (): string => {
        const name = String(base);
        const target = branchByName(name);
        if (!target) throw fail("unknown-ref", `invalid upstream '${name}'`);
        if (name === CONFLICTING_BRANCH || name === `origin/${CONFLICTING_BRANCH}`) {
          enterConflict("rebase", `Rebase ${currentBranch().name} onto ${name}`);
          throw fail(
            "rebase-conflicts",
            "Could not apply — resolve all conflicts manually, then run 'git rebase --continue'.",
            { files: conflicts.map((file) => file.path) },
          );
        }
        // A rebase rewrites every commit it replays, so the shas above the
        // base all change. Walk upwards so each child's parent link can be
        // repointed at its rewritten parent — otherwise the graph loses the
        // edges between the replayed rows.
        for (let i = currentBranch().ahead - 1; i >= 0; i--) {
          const replayed = COMMITS[i];
          if (!replayed) continue;
          const before = replayed.sha;
          replayed.sha = newSha();
          const child = COMMITS[i - 1];
          if (child) {
            child.parents = child.parents.map((parent) =>
              parent === before ? replayed.sha : parent,
            );
          }
        }
        currentBranch().behind = 0;
        moveRef(currentBranch().name, "branch", HEAD().sha);
        return `Successfully rebased and updated refs/heads/${currentBranch().name}.\n`;
      },
    ),
  /**
   * Abort / continue for an in-progress merge, rebase, cherry-pick or revert.
   * NOT a cancel channel for push/pull — the Rust command takes
   * `kind: merge|rebase|cherry-pick|revert` and shells out to `--abort` /
   * `--continue`, and nothing in the frontend can interrupt a network op.
   *
   * Succeeds even when this fixture has no operation of its own in flight:
   * the `git-conflict` scenario serves its own (static) merge status and
   * resolves through its own handlers, and rejecting its Continue would be an
   * error the user can't act on.
   */
  git_op_control: ({ kind, action }): string => {
    const mine = anyInProgress();
    if (mine && action === "continue" && conflicts.length > 0) {
      throw fail("merge-conflicts", "Committing is not possible because you have unmerged files.", {
        files: conflicts.map((file) => file.path),
      });
    }
    if (mine && action === "continue") {
      const message = mergeMessage || `Merge branch '${CONFLICTING_BRANCH}'`;
      const resolved = CHANGES.filter((change) => staged.get(change.path));
      addCommit({
        message,
        files: resolved.map((change) => ({ path: change.path, status: "M" })),
      });
      currentBranch().ahead += 1;
      for (const change of resolved) dropChange(change.path);
    }
    if (mine && action === "abort") {
      for (const path of conflictAdded) dropChange(path);
    }
    clearInProgress();
    notifyChanged();
    return `${String(kind)} ${String(action)}\n`;
  },

  // ── conflicts ───────────────────────────────────────────────────────────
  // The `git-conflict` scenario overrides both of these with its own file
  // list; these serve the merge a user starts from the default scenario.
  git_conflict_state: (): ConflictState => ({ files: copy(conflicts), message: mergeMessage }),
  git_resolve_file: ({ file }): null => {
    const path = String(file);
    conflicts = conflicts.filter((entry) => entry.path !== path);
    // Resolving is `git add`: the file leaves the conflict list staged.
    if (changeFor(path)) staged.set(path, true);
    notifyChanged();
    return null;
  },

  // ── history rewrites ────────────────────────────────────────────────────
  git_undo_commit: (): null => {
    if (COMMITS.length < 2) {
      throw fail("generic", "The first commit of a repository can't be undone.");
    }
    if (currentBranch().ahead === 0) {
      throw fail("generic", "This commit is already pushed. Revert it instead of undoing it.");
    }
    // `reset --soft HEAD~1`: the commit's files come back STAGED.
    const undone = COMMITS.shift();
    for (const file of undone?.files ?? []) {
      restoreChange(file.path, file.status === "A" ? "untracked" : "modified", true);
    }
    currentBranch().ahead -= 1;
    moveRef(currentBranch().name, "branch", HEAD().sha);
    notifyChanged();
    return null;
  },
  git_squash_last: ({ count, summary, description }): null => {
    const n = Number(count);
    if (n < 2) throw fail("generic", "Squash needs at least 2 commits.");
    if (n > COMMITS.length) throw fail("generic", "Not enough commits to squash.");
    if (n > currentBranch().ahead) {
      throw fail(
        "generic",
        "Some of these commits are already pushed — squashing would rewrite shared history.",
      );
    }
    const squashed = COMMITS.splice(0, n);
    const message = [String(summary ?? "").trim(), String(description ?? "").trim()]
      .filter(Boolean)
      .join("\n\n");
    addCommit({ message, files: squashed.flatMap((commit) => commit.files) });
    currentBranch().ahead -= n - 1;
    notifyChanged();
    return null;
  },
  /**
   * `reset --soft` puts the dropped commits' files back in the index,
   * `--mixed` in the worktree, `--hard` throws them away — three visibly
   * different Changes panels from the same menu.
   */
  git_reset: ({ target, mode }): null => {
    const at = COMMITS.findIndex((commit) => commit.sha.startsWith(String(target)));
    if (at === -1) throw fail("unknown-ref", `ambiguous argument '${String(target)}'`);
    if (at === 0) return null;
    const dropped = COMMITS.splice(0, at);
    if (mode !== "hard") {
      for (const commit of dropped) {
        for (const file of commit.files) {
          restoreChange(file.path, file.status === "A" ? "untracked" : "modified", mode === "soft");
        }
      }
    }
    currentBranch().ahead = Math.max(0, currentBranch().ahead - dropped.length);
    moveRef(currentBranch().name, "branch", HEAD().sha);
    notifyChanged();
    return null;
  },
  git_revert: ({ sha }): string => {
    const commit = COMMITS.find((candidate) => candidate.sha.startsWith(String(sha)));
    if (!commit) throw fail("unknown-ref", `bad revision '${String(sha)}'`);
    addCommit({
      message: `Revert "${commit.message.split("\n")[0]}"\n\nThis reverts commit ${commit.sha}.`,
      files: commit.files,
    });
    currentBranch().ahead += 1;
    notifyChanged();
    return `[${currentBranch().name} ${shortSha(HEAD().sha)}] Revert\n`;
  },
  /**
   * Cherry-picking the tokens refactor onto a tree that already has
   * `tokens.css` staged is the one pick that stops on a conflict — the route
   * to a cherry-pick-in-progress banner, which differs from the merge one.
   */
  git_cherry_pick: ({ sha }): string => {
    const commit = COMMITS.find((candidate) => candidate.sha.startsWith(String(sha)));
    if (!commit) throw fail("unknown-ref", `bad revision '${String(sha)}'`);
    if (commit.files.some((file) => file.path === "src/styles/tokens.css")) {
      enterConflict("cherryPick", commit.message.split("\n")[0]);
      notifyChanged();
      throw fail("merge-conflicts", "Cherry-pick stopped: conflicts in the working tree.", {
        files: conflicts.map((file) => file.path),
      });
    }
    addCommit({ message: commit.message, files: commit.files });
    currentBranch().ahead += 1;
    notifyChanged();
    return `[${currentBranch().name} ${shortSha(HEAD().sha)}] ${commit.message.split("\n")[0]}\n`;
  },

  // ── tags / remotes ──────────────────────────────────────────────────────
  git_create_tag: ({ name, target }): null => {
    const tag = String(name);
    if (tags.includes(tag)) throw fail("tag-already-exists", `tag '${tag}' already exists`);
    const at = target ? String(target) : HEAD().sha;
    const commit = COMMITS.find((candidate) => candidate.sha.startsWith(at));
    if (!commit) throw fail("unknown-ref", `Failed to resolve '${at}' as a valid ref.`);
    tags = [tag, ...tags];
    moveRef(tag, "tag", commit.sha);
    notifyChanged();
    return null;
  },
  git_delete_tag: ({ name }): null => {
    const tag = String(name);
    if (!tags.includes(tag)) throw fail("unknown-ref", `tag '${tag}' not found.`);
    tags = tags.filter((candidate) => candidate !== tag);
    moveRef(tag, "tag", null);
    notifyChanged();
    return null;
  },
  git_remote_add: ({ name, url }): null => {
    const remote = String(name);
    if (remotes.some((candidate) => candidate.name === remote)) {
      throw fail("generic", `remote ${remote} already exists.`);
    }
    remotes = [...remotes, { name: remote, url: String(url) }];
    notifyChanged();
    return null;
  },
  git_remote_remove: ({ name }): null => {
    const remote = String(name);
    if (!remotes.some((candidate) => candidate.name === remote)) {
      throw fail("remote-not-found", `No such remote: '${remote}'`);
    }
    remotes = remotes.filter((candidate) => candidate.name !== remote);
    notifyChanged();
    return null;
  },
};
