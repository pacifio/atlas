// The `northwind` scenario's repository: the files the explorer, the editor,
// Cmd+P and Cmd+Shift+F read, and the git panel's status, history, graph,
// diffs and blame — all for `northwind-shop` and nothing else.
//
// Every handler first asks whether the call is about the northwind project
// (its path, a path inside it, or its workspace id). If not, it hands the call
// to the default fixture's handler, so any other project keeps working exactly
// as it does in the default scenario.
//
// The files and their history are `fixtures/northwind-repo.ts`; the commits,
// people and times are `northwind-world.ts`. This file holds the state a take
// moves: edits saved from the editor, what is staged, the commits made from
// the git panel, and how far `main` is ahead of `origin/main`.
//
// Video 1, beat 2: the scripted run calls `setPending(changes, sessions)`. The
// changes show up here as an uncommitted working tree; staging and committing
// them from the panel makes a real commit (`addCommit`) whose "Produced by"
// names those sessions, and the files' HEAD text and blame move to match.

import { emit } from "@tauri-apps/api/event";
import type { FileEntry } from "@/features/explorer/stores/explorer-store";
import type {
  FileIndexStatus,
  FileMatch,
  FolderMatch,
} from "@/features/file-picker/lib/file-picker-api";
import type { RecentFile } from "@/features/chat/stores/recent-files-store";
import type { SearchResult } from "@/components/search-overlay";
import type { BlameLine } from "@/features/git/lib/git-blame-api";
import type { BranchPullRequest, RepoPullRequests } from "@/features/git/lib/git-pr-api";
import type { CommitFile, DiffLineStatus, FileDiff } from "@/features/git/lib/git-diff-api";
import type { GitErrorPayload } from "@/features/git/lib/git-errors";
import type { BuiltGraph, CommitRow, LaneSegment } from "@/features/git/lib/git-graph";
import type {
  BranchInfo,
  CommitDetail,
  GitBranch,
  GitLogEntry,
  GitOpEvent,
  GitSnapshotWire,
  InProgress,
  MergePreview,
  RemoteInfo,
  StashEntry,
} from "@/features/git/stores/git-store";
import type { ConflictState } from "@/features/git/components/git-manager/conflicts-view";
import type { CommitSession } from "@/features/git/components/git-manager/history-view";
import type { RawGitStatus } from "@/features/terminal/components/block-terminal";
import type { GitSummary } from "@/features/projects/stores/project-git-store";
import type { MockArgs, MockHandlers, MockResponses, TypedHandlers } from "../types";
import { buildFileDiff, lineStatusOf, unifiedDiff } from "../fixtures/diff";
import { fsHandlers, listDir } from "../fixtures/files";
import { gitHandlers } from "../fixtures/git";
import { NORTHWIND_LANE_COLOR, northwindFilesAt } from "../fixtures/northwind-repo";
import type { CommitContent } from "./northwind-content-types";
import {
  LOAD,
  PEOPLE,
  PROJECT,
  abs,
  addCommit,
  commits,
  nowWhen,
  onPendingChanged,
  pending,
  rel,
  session,
  sessionContent,
  setPending,
  whenMs,
} from "./northwind-world";

// ── Which calls are ours ──────────────────────────────────────────────────

/** True when `path` is the northwind project or anything inside it. */
const ours = (path: unknown): boolean => typeof path === "string" && rel(path) !== null;
/** True when a workspace-scoped call (file index, recents) is for northwind. */
const oursById = (workspaceId: unknown): boolean => workspaceId === PROJECT.id;

// ── HEAD ──────────────────────────────────────────────────────────────────

/** One committed file: its text and, per line, the key of the commit that wrote it. */
interface HeadFile {
  text: string;
  lineKeys: string[];
}

const linesOf = (text: string): string[] => text.replace(/\n$/, "").split("\n");

/** The commit keys that exist at load — `?video=1` leaves the on-camera one out. */
const seededKeys = new Set(commits().map((commit) => commit.key));

function expand(blame: [string, number][]): string[] {
  return blame.flatMap(([key, count]) => Array.from({ length: count }, () => key));
}

const head = new Map<string, HeadFile>(
  Object.entries(northwindFilesAt((key) => seededKeys.has(key))).map(([path, file]) => [
    path,
    { text: file.text, lineKeys: expand(file.blame) },
  ]),
);

const commitByKey = (key: string): CommitContent | undefined =>
  commits().find((commit) => commit.key === key);
const commitBySha = (sha: unknown): CommitContent | undefined => {
  const needle = String(sha ?? "");
  return needle ? commits().find((commit) => commit.sha.startsWith(needle)) : undefined;
};
const commitMs = (commit: CommitContent): number => whenMs(commit.when);

/**
 * `%cr`, as `git log` prints it: what `git_log`, the graph and the branch list
 * show (`commands/git.rs` asks git for exactly this, not a timestamp).
 */
function gitRelative(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"} ago`;
  if (s < 90) return unit(s, "second");
  const m = Math.round(s / 60);
  if (m < 90) return unit(m, "minute");
  const h = Math.round(m / 60);
  if (h < 36) return unit(h, "hour");
  const d = Math.round(h / 24);
  if (d < 14) return unit(d, "day");
  return unit(Math.round(d / 7), "week");
}

/** `--date=format:%Y-%m-%d %H:%M`, local time — what `git_show` asks git for. */
function gitShowDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const shortSha = (sha: string): string => sha.slice(0, 7);
const subjectOf = (commit: CommitContent): string => commit.subject;
const messageOf = (commit: CommitContent): string =>
  commit.body ? `${commit.subject}\n\n${commit.body}` : commit.subject;

// ── The working tree ──────────────────────────────────────────────────────

/** Files saved from the editor during the take: repo-relative path → text. */
const edits = new Map<string, { text: string; mtimeMs: number }>();
/** When the scripted run last left changes, for those files' mtime. */
let pendingAtMs = LOAD;

const pendingFor = (path: string) => pending.changes.find((change) => change.path === path);

/** The file as it is on disk right now, or `undefined` when it does not exist. */
function worktreeText(path: string): string | undefined {
  return pendingFor(path)?.after ?? edits.get(path)?.text ?? head.get(path)?.text;
}

function worktreePaths(): string[] {
  const paths = new Set<string>([...head.keys(), ...edits.keys()]);
  for (const change of pending.changes) paths.add(change.path);
  return [...paths].filter((path) => worktreeText(path) !== undefined).sort();
}

/** The latest commit time among a file's lines: what its mtime would be. */
function headMtime(path: string): number {
  const keys = new Set(head.get(path)?.lineKeys ?? []);
  let latest = 0;
  for (const key of keys) {
    const commit = commitByKey(key);
    if (commit) latest = Math.max(latest, commitMs(commit));
  }
  return latest || LOAD;
}

function mtimeOf(path: string): number {
  if (pendingFor(path)) return pendingAtMs;
  return edits.get(path)?.mtimeMs ?? headMtime(path);
}

interface Change {
  path: string;
  /** HEAD text; `null` for a file git has never seen. */
  before: string | null;
  after: string;
}

/** Every file whose working-tree text differs from HEAD. */
function changes(): Change[] {
  return worktreePaths().flatMap((path) => {
    const after = worktreeText(path) ?? "";
    const before = head.get(path)?.text ?? null;
    return before === after ? [] : [{ path, before, after }];
  });
}

const changeFor = (path: string) => changes().find((change) => change.path === path);

/** Staged paths. Everything else that changed is unstaged. */
const staged = new Set<string>();

function statusRows(): GitSnapshotWire["files"] {
  return changes().map((change) => {
    const isStaged = staged.has(change.path);
    const status = change.before === null ? (isStaged ? "added" : "untracked") : "modified";
    return { path: change.path, status, staged: isStaged, conflicted: false };
  });
}

function workingDiff(path: string): FileDiff {
  const change = changeFor(path);
  const text = worktreeText(path) ?? "";
  return change
    ? buildFileDiff(change.before ?? "", change.after, path)
    : buildFileDiff(text, text, path);
}

// ── History ───────────────────────────────────────────────────────────────

/** One side of a commit: repo-relative path → text, or `null` when absent. */
type Tree = Record<string, string | null>;

/** Before/after trees for commits made from the panel during the take. */
const liveTrees = new Map<string, { before: Tree; after: Tree }>();
const seededTrees = new Map<string, { before: Tree; after: Tree }>();

const textsOf = (files: Record<string, { text: string }>): Tree =>
  Object.fromEntries(Object.entries(files).map(([path, file]) => [path, file.text]));

/** What a commit changed, as before/after trees of only the files it touched. */
function commitTrees(commit: CommitContent): { before: Tree; after: Tree } {
  const live = liveTrees.get(commit.key);
  if (live) return live;
  const cached = seededTrees.get(commit.key);
  if (cached) return cached;
  const keys = commits()
    .map((c) => c.key)
    .filter((key) => seededKeys.has(key));
  const index = keys.indexOf(commit.key);
  const upTo = (n: number) => new Set(keys.slice(0, n));
  const beforeKeys = upTo(index);
  const afterKeys = upTo(index + 1);
  const before = textsOf(northwindFilesAt((key) => beforeKeys.has(key)));
  const after = textsOf(northwindFilesAt((key) => afterKeys.has(key)));
  const touched: { before: Tree; after: Tree } = { before: {}, after: {} };
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if ((before[path] ?? null) === (after[path] ?? null)) continue;
    touched.before[path] = before[path] ?? null;
    touched.after[path] = after[path] ?? null;
  }
  seededTrees.set(commit.key, touched);
  return touched;
}

function commitFiles(commit: CommitContent): CommitFile[] {
  const { before, after } = commitTrees(commit);
  return Object.keys(after)
    .sort()
    .map((path) => ({
      path,
      status: before[path] === null ? "A" : after[path] === null ? "D" : "M",
    }));
}

function commitDiff(commit: CommitContent): string {
  const { before, after } = commitTrees(commit);
  return Object.keys(after)
    .sort()
    .map((path) => unifiedDiff(before[path] ?? "", after[path] ?? "", path))
    .join("");
}

/** Newest first, as `git log` lists them. */
const newestFirst = (): CommitContent[] => [...commits()].reverse();
const headCommit = (): CommitContent => newestFirst()[0];

/** How far `main` is ahead of `origin/main`: commits made in the panel and not pushed. */
let ahead = 0;
/** Bumped by every write, so the graph's signature changes and it refetches. */
let epoch = 0;

const TAG = { name: "v0.1.0", commit: "c-check" };
const MERGED_BRANCH = { name: "server-discounts", commit: "c-validate" };

/**
 * The PR `server-discounts` went up as. Merged, because the branch is: its
 * commit is already on `main` (see `branches()`), so an open PR for it would
 * contradict the git panel. `main` has no PR, so every other branch is `null`.
 */
const MERGED_BRANCH_PR: BranchPullRequest = {
  number: 353,
  state: "merged",
  title: "Validate discount codes on the server",
  url: "https://github.com/northwind/northwind-shop/pull/353",
  isDraft: false,
};

function mainBranch(): BranchInfo {
  const tip = headCommit();
  return {
    name: "main",
    isCurrent: true,
    isRemote: false,
    upstream: "origin/main",
    ahead,
    behind: 0,
    subject: subjectOf(tip),
    date: gitRelative(commitMs(tip)),
  };
}

function branches(): BranchInfo[] {
  const main = mainBranch();
  const list = newestFirst();
  const originTip = list[ahead] ?? list[list.length - 1];
  const rows: BranchInfo[] = [main];
  const merged = commitByKey(MERGED_BRANCH.commit);
  if (merged) {
    const behind = list.indexOf(merged);
    const branch = {
      isRemote: false,
      upstream: `origin/${MERGED_BRANCH.name}`,
      ahead: 0,
      behind,
      subject: subjectOf(merged),
      date: gitRelative(commitMs(merged)),
    };
    rows.push({ ...branch, name: MERGED_BRANCH.name, isCurrent: false });
    rows.push({
      ...branch,
      name: `origin/${MERGED_BRANCH.name}`,
      isCurrent: false,
      isRemote: true,
      upstream: null,
      behind: 0,
    });
  }
  rows.push({
    name: "origin/main",
    isCurrent: false,
    isRemote: true,
    upstream: null,
    ahead: 0,
    behind: 0,
    subject: subjectOf(originTip),
    date: gitRelative(commitMs(originTip)),
  });
  return rows;
}

function graph(limit: number): BuiltGraph {
  const list = newestFirst();
  const originTip = list[ahead] ?? list[list.length - 1];
  const color = NORTHWIND_LANE_COLOR;
  const rows: CommitRow[] = list.slice(0, limit).map((commit, index) => {
    const refs: CommitRow["refs"] = [];
    if (index === 0) refs.push({ name: "main", kind: "branch", isCurrent: true });
    if (commit === originTip) refs.push({ name: "origin/main", kind: "remote", isCurrent: false });
    if (commit.key === MERGED_BRANCH.commit) {
      refs.push({ name: MERGED_BRANCH.name, kind: "branch", isCurrent: false });
      refs.push({ name: `origin/${MERGED_BRANCH.name}`, kind: "remote", isCurrent: false });
    }
    if (commit.key === TAG.commit) refs.push({ name: TAG.name, kind: "tag", isCurrent: false });
    const segments: LaneSegment[] = [];
    if (index > 0) segments.push({ fromLane: 0, toLane: 0, fromY: 0, toY: 0.5, color });
    if (index < list.length - 1) {
      segments.push({ fromLane: 0, toLane: 0, fromY: 0.5, toY: 1, color });
    }
    const person = PEOPLE[commit.author];
    return {
      sha: commit.sha,
      shortSha: shortSha(commit.sha),
      message: subjectOf(commit),
      author: person.name,
      email: person.email,
      date: gitShowDate(commitMs(commit)),
      refs,
      isHead: index === 0,
      commitLane: 0,
      commitColor: color,
      segments,
    };
  });
  return { rows, laneCount: 1, totalCommits: list.length };
}

/** "Produced by N sessions": each Session behind a commit, counted from its steps. */
function commitSessions(commit: CommitContent): CommitSession[] {
  return commit.sessions.flatMap((id) => {
    const content = session(id)?.content ?? sessionContent(id);
    if (!content) return [];
    const steps = session(id)?.steps ?? content.steps;
    const files = new Set<string>();
    for (const step of steps) {
      if (step.kind === "tool" && (step.tool === "edit" || step.tool === "write") && step.path) {
        files.add(step.path);
      }
    }
    return [
      {
        sessionId: id,
        title: content.title,
        messageCount: steps.filter((step) => step.kind === "prompt" || step.kind === "response")
          .length,
        toolCallCount: steps.filter((step) => step.kind === "tool").length,
        files: [...files],
      },
    ];
  });
}

// ── Blame ─────────────────────────────────────────────────────────────────

/**
 * For each line of `next`, the index of the same line in `prev`, or -1 when it
 * is new — a longest-common-subsequence match, which is what `git blame`
 * effectively does for one step of history. The files are small enough that
 * the full table is cheap.
 */
function matchLines(prev: string[], next: string[]): number[] {
  const rows = prev.length + 1;
  const cols = next.length + 1;
  const table = new Uint16Array(rows * cols);
  for (let i = prev.length - 1; i >= 0; i--) {
    for (let j = next.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        prev[i] === next[j]
          ? table[(i + 1) * cols + j + 1] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  const out = Array.from({ length: next.length }, () => -1);
  let i = 0;
  let j = 0;
  while (i < prev.length && j < next.length) {
    if (prev[i] === next[j]) {
      out[j] = i;
      i++;
      j++;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) i++;
    else j++;
  }
  return out;
}

const UNCOMMITTED: Omit<BlameLine, "line"> = {
  sha: "0000000000000000000000000000000000000000",
  shortSha: "0000000",
  author: "Not Committed Yet",
  timeMs: 0,
  summary: "Uncommitted changes",
  committed: false,
};

/** Per-line blame of the file on disk: HEAD's attribution, uncommitted lines marked. */
function blame(path: string): BlameLine[] {
  const file = head.get(path);
  const text = worktreeText(path);
  if (!file || text === undefined) return [];
  const headLines = linesOf(file.text);
  const nowLines = linesOf(text);
  const match = text === file.text ? nowLines.map((_, i) => i) : matchLines(headLines, nowLines);
  return nowLines.map((_, index) => {
    const from = match[index];
    const commit = from >= 0 ? commitByKey(file.lineKeys[from]) : undefined;
    if (!commit) return { line: index + 1, ...UNCOMMITTED };
    return {
      line: index + 1,
      sha: commit.sha,
      shortSha: shortSha(commit.sha),
      author: PEOPLE[commit.author].name,
      timeMs: commitMs(commit),
      summary: subjectOf(commit),
      committed: true,
    };
  });
}

// ── Notifications and streamed operations ─────────────────────────────────

/** What Rust's watcher does after any change to the repo: the panels refetch. */
function notifyChanged(): void {
  epoch += 1;
  void emit("atlas:git-changed", { project: PROJECT.path }).catch(() => {});
}

onPendingChanged(() => {
  pendingAtMs = Date.now();
  // A staged path whose change has gone (discarded, reverted) stops being staged.
  // Deleting the current entry while iterating a Set is safe.
  for (const path of staged) if (!changeFor(path)) staged.delete(path);
  notifyChanged();
});

function fail(code: GitErrorPayload["code"], message: string): GitErrorPayload {
  return { code, message, rawStderr: `fatal: ${message}`, command: "git" };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stream `atlas:git:op` the way Rust does when the caller passed an `opId`. */
async function runOp<T>(kind: string, opId: unknown, lines: string[], finish: () => T): Promise<T> {
  const id = typeof opId === "string" ? opId : null;
  type Phase = GitOpEvent extends infer E
    ? E extends GitOpEvent
      ? Omit<E, "opId" | "repo" | "kind">
      : never
    : never;
  const send = (event: Phase) => {
    if (!id) return;
    const payload: GitOpEvent = { opId: id, repo: PROJECT.path, kind, ...event };
    void emit("atlas:git:op", payload).catch(() => {});
  };
  send({ phase: "started" });
  for (const line of lines) {
    await sleep(140);
    send({ phase: "output", stream: "stderr", line });
  }
  try {
    const result = finish();
    send({ phase: "done", ok: true });
    notifyChanged();
    return result;
  } catch (error) {
    send({ phase: "done", ok: false, error: error as GitErrorPayload });
    throw error;
  }
}

// ── Committing from the panel ─────────────────────────────────────────────

let liveCount = 0;

function randomSha(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function commitStaged(summary: string, description: string, coAuthors: string[]): void {
  const toCommit = changes().filter((change) => staged.has(change.path));
  if (toCommit.length === 0) throw fail("nothing-to-commit", "No changes added to commit.");

  liveCount += 1;
  const key = `c-live-${liveCount}`;
  const trailers = coAuthors.map((author) => `Co-authored-by: ${author}`).join("\n");
  const body = [description, trailers].filter(Boolean).join("\n\n");
  const fromAgent = toCommit.some((change) => pendingFor(change.path));
  const before: Tree = {};
  const after: Tree = {};

  for (const change of toCommit) {
    before[change.path] = change.before;
    after[change.path] = change.after;
    const prev = head.get(change.path);
    const nextLines = linesOf(change.after);
    const match = prev ? matchLines(linesOf(prev.text), nextLines) : [];
    head.set(change.path, {
      text: change.after,
      lineKeys: nextLines.map((_, i) => (prev && match[i] >= 0 ? prev.lineKeys[match[i]] : key)),
    });
    edits.delete(change.path);
    staged.delete(change.path);
  }
  liveTrees.set(key, { before, after });

  addCommit({
    key,
    sha: randomSha(),
    subject: summary,
    body: body || undefined,
    author: "uzayer",
    when: nowWhen(),
    files: toCommit.map((change) => {
      const { stats } = buildFileDiff(change.before ?? "", change.after, change.path);
      return {
        path: change.path,
        status: change.before === null ? "A" : "M",
        insertions: stats.additions,
        deletions: stats.deletions,
      };
    }),
    sessions: fromAgent ? [...pending.sessions] : [],
  });
  ahead += 1;

  if (fromAgent) {
    const committed = new Set(toCommit.map((change) => change.path));
    const rest = pending.changes.filter((change) => !committed.has(change.path));
    // `setPending` notifies, which is what refreshes the panels.
    setPending(rest, rest.length > 0 ? pending.sessions : []);
  }
}

// ── Files: explorer, editor, Cmd+P, Cmd+Shift+F, recents ─────────────────

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/** `read_directory` for the northwind tree: directories first, then files, case-insensitively. */
function readDirectory(path: string): FileEntry[] {
  const at = rel(path) ?? "";
  if (head.has(at) || edits.has(at)) throw new Error(`Not a directory: ${path}`);
  const prefix = at ? `${at}/` : "";
  const dirs = new Set<string>();
  const files: FileEntry[] = [];
  for (const file of worktreePaths()) {
    if (!file.startsWith(prefix)) continue;
    const tail = file.slice(prefix.length);
    const slash = tail.indexOf("/");
    if (slash !== -1) {
      dirs.add(tail.slice(0, slash));
      continue;
    }
    const dot = tail.lastIndexOf(".");
    files.push({
      name: tail,
      path: abs(file),
      is_dir: false,
      is_symlink: false,
      size: byteLength(worktreeText(file) ?? ""),
      extension: dot > 0 ? tail.slice(dot + 1) : null,
    });
  }
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  const dirEntries: FileEntry[] = [...dirs]
    .map((name) => ({
      name,
      path: abs(`${prefix}${name}`),
      is_dir: true,
      is_symlink: false,
      size: 0,
      extension: null,
    }))
    .sort(byName);
  return [...dirEntries, ...files.sort(byName)];
}

function dirPaths(): string[] {
  const dirs = new Set<string>();
  for (const path of worktreePaths()) {
    const parts = path.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return [...dirs].sort();
}

/**
 * Subsequence match, ranked the way a picker should feel: a hit in the file
 * name beats a hit spread across the path, and shorter paths win ties — so
 * "products" offers `src/client/products.ts` before `data/products.json`, and
 * "disc" finds `src/server/discounts.ts` first.
 */
function fuzzyRank(query: string, path: string): number | null {
  const needle = query.toLowerCase().replace(/\s+/g, "");
  if (!needle) return path.length;
  const hay = path.toLowerCase();
  let at = 0;
  for (const ch of needle) {
    at = hay.indexOf(ch, at);
    if (at === -1) return null;
    at++;
  }
  const name = hay.slice(hay.lastIndexOf("/") + 1);
  // Shorter names first among name hits: `products.ts` before `products.json`.
  if (name.startsWith(needle)) return name.length * 100 + path.length;
  if (name.includes(needle)) return 10_000 + name.length * 100 + path.length;
  if (hay.includes(needle)) return 20_000 + path.length;
  return 30_000 + path.length;
}

function ranked(paths: string[], query: unknown, limit: unknown, fallback: number) {
  return paths
    .flatMap((path) => {
      const rank = fuzzyRank(String(query ?? ""), path);
      return rank === null ? [] : [{ path, rank }];
    })
    .sort((a, b) => a.rank - b.rank || a.path.localeCompare(b.path))
    .slice(0, Number(limit ?? fallback))
    .map(({ path }) => ({ path: abs(path), rel: path }));
}

/** What Rust's search walks (`search.rs`'s allowlist, trimmed to this repo's types). */
const SEARCHABLE = new Set(["ts", "tsx", "js", "json", "html", "css", "md", "txt", "toml", "yml"]);

function searchFiles(query: string, max: number): SearchResult[] {
  const needle = query.toLowerCase();
  const results: SearchResult[] = [];
  if (!needle) return results;
  for (const path of worktreePaths()) {
    if (results.length >= max) break;
    const segments = path.split("/");
    if (segments.some((name) => name.startsWith(".") || name === "node_modules")) continue;
    const name = segments[segments.length - 1];
    const dot = name.lastIndexOf(".");
    if (dot <= 0 || !SEARCHABLE.has(name.slice(dot + 1))) continue;
    for (const [index, line] of linesOf(worktreeText(path) ?? "").entries()) {
      if (results.length >= max) break;
      const at = line.toLowerCase().indexOf(needle);
      if (at === -1) continue;
      results.push({
        file_path: path,
        line: index + 1,
        content: line,
        match_start: at,
        match_end: at + needle.length,
      });
    }
  }
  return results;
}

let recents: RecentFile[] = [
  { absPath: abs("src/client/products.ts"), rel: "src/client/products.ts", touchedAt: 0 },
  { absPath: abs("src/server/discounts.ts"), rel: "src/server/discounts.ts", touchedAt: 0 },
  { absPath: abs("src/client/checkout.ts"), rel: "src/client/checkout.ts", touchedAt: 0 },
].map((entry, index) => ({ ...entry, touchedAt: LOAD - (index * 47 + 12) * 60_000 }));

// ── Handlers ──────────────────────────────────────────────────────────────

const summaryOf = (): GitSummary => {
  let additions = 0;
  let deletions = 0;
  for (const change of changes()) {
    const { stats } = buildFileDiff(change.before ?? "", change.after, change.path);
    additions += stats.additions;
    deletions += stats.deletions;
  }
  return {
    isRepo: true,
    branch: "main",
    headSubject: subjectOf(headCommit()),
    dirty: changes().length > 0,
    additions,
    deletions,
  };
};

const NO_OP_IN_PROGRESS: InProgress = {
  merge: false,
  rebase: false,
  cherryPick: false,
  revert: false,
};
const REMOTES: RemoteInfo[] = [
  { name: "origin", url: "git@github.com:northwind/northwind-shop.git" },
];
const NO_STASHES: StashEntry[] = [];

/** A write the scenario has no story for: accepted quietly, so nothing on screen breaks. */
const quietly =
  <K extends keyof MockResponses>(command: K) =>
  (args: MockArgs) =>
    ours(args.path)
      ? (notifyChanged(), null)
      : (gitHandlers as Partial<TypedHandlers<MockResponses>>)[command]!(args);

export const northwindGitCommands: Partial<TypedHandlers<MockResponses>> = {
  // ── files ───────────────────────────────────────────────────────────────
  read_file_content: (args): string | Promise<string> => {
    const path = rel(String(args.path));
    if (path === null) return fsHandlers.read_file_content(args);
    const text = worktreeText(path);
    if (text === undefined) throw new Error(`Failed to read ${String(args.path)}: not found`);
    return text;
  },
  write_file_content: (args) => {
    const path = rel(String(args.path));
    if (path === null) return fsHandlers.write_file_content(args);
    const text = String(args.content);
    if (head.get(path)?.text === text) edits.delete(path);
    else edits.set(path, { text, mtimeMs: Date.now() });
    notifyChanged();
    return null;
  },
  file_mtime_ms: (args) => {
    const path = rel(String(args.path));
    if (path === null) return fsHandlers.file_mtime_ms(args);
    return worktreeText(path) === undefined ? 0 : mtimeOf(path);
  },
  is_text_file: (args) => (ours(args.path) ? true : fsHandlers.is_text_file(args)),
  read_file_base64: (args) => {
    const path = rel(String(args.path));
    if (path === null) return fsHandlers.read_file_base64(args);
    const text = worktreeText(path);
    if (text === undefined) throw new Error(`Failed to read ${String(args.path)}: not found`);
    return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
  },

  fileindex_open_project: (args) =>
    ours(args.path) || oursById(args.workspaceId)
      ? worktreePaths().length
      : fsHandlers.fileindex_open_project(args),
  fileindex_status: (args): FileIndexStatus | Promise<FileIndexStatus> =>
    oursById(args.workspaceId)
      ? { indexed: true, count: worktreePaths().length, root: PROJECT.path }
      : fsHandlers.fileindex_status(args),
  fileindex_search: (args): FileMatch[] | Promise<FileMatch[]> =>
    oursById(args.workspaceId)
      ? ranked(worktreePaths(), args.query, args.limit, 100)
      : fsHandlers.fileindex_search(args),
  fileindex_search_dirs: (args): FolderMatch[] | Promise<FolderMatch[]> =>
    oursById(args.workspaceId)
      ? ranked(dirPaths(), args.query, args.limit, 30)
      : fsHandlers.fileindex_search_dirs(args),
  recent_files_open_project: (args) =>
    ours(args.projectPath) || oursById(args.workspaceId)
      ? recents
      : fsHandlers.recent_files_open_project(args),
  recent_files_push: (args) => {
    if (!oursById(args.workspaceId) && !ours(args.absPath))
      return fsHandlers.recent_files_push(args);
    recents = [
      { absPath: String(args.absPath), rel: String(args.rel), touchedAt: Date.now() },
      ...recents.filter((entry) => entry.absPath !== String(args.absPath)),
    ].slice(0, 20);
    void emit("atlas:recent-files-changed", {
      workspaceId: PROJECT.id,
      project: PROJECT.path,
      items: recents,
    }).catch(() => {});
    return recents;
  },
  search_in_files: (args) =>
    ours(args.path)
      ? searchFiles(String(args.query ?? ""), Number(args.maxResults ?? 100))
      : fsHandlers.search_in_files(args),

  // ── git: status ─────────────────────────────────────────────────────────
  git_workspace_summary: (args) =>
    ours(args.path) ? summaryOf() : gitHandlers.git_workspace_summary(args),
  git_snapshot: (args): GitSnapshotWire | Promise<GitSnapshotWire> =>
    ours(args.path)
      ? {
          isRepo: true,
          branch: "main",
          detached: false,
          upstream: "origin/main",
          ahead,
          behind: 0,
          files: statusRows(),
          branches: branches(),
          stashes: [],
          inProgress: null,
        }
      : gitHandlers.git_snapshot(args),
  git_status_fresh: (args): RawGitStatus | Promise<RawGitStatus> =>
    ours(args.path)
      ? {
          is_repo: true,
          branch: "main",
          files: statusRows().map(({ path, status, staged: isStaged }) => ({
            path,
            status,
            staged: isStaged,
          })),
          ahead,
          behind: 0,
        }
      : gitHandlers.git_status_fresh(args),
  git_inprogress: (args) =>
    ours(args.path) ? { ...NO_OP_IN_PROGRESS } : gitHandlers.git_inprogress(args),
  git_branches_full: (args) => (ours(args.path) ? branches() : gitHandlers.git_branches_full(args)),
  git_list_branches: (args): GitBranch[] | Promise<GitBranch[]> =>
    ours(args.path)
      ? branches()
          .filter((branch) => !branch.isRemote)
          .map((branch) => ({ name: branch.name, is_current: branch.isCurrent }))
      : gitHandlers.git_list_branches(args),
  git_stash_list: (args) => (ours(args.path) ? [...NO_STASHES] : gitHandlers.git_stash_list(args)),
  git_remotes: (args) =>
    ours(args.path) ? REMOTES.map((remote) => ({ ...remote })) : gitHandlers.git_remotes(args),
  git_tags: (args) =>
    ours(args.path) ? (commitByKey(TAG.commit) ? [TAG.name] : []) : gitHandlers.git_tags(args),
  git_autofetch_set_active: (args) =>
    ours(args.projectPath)
      ? { project: PROJECT.path, lastFetchedAt: LOAD - 4 * 60_000, lastError: null }
      : gitHandlers.git_autofetch_set_active(args),

  // ── git: history ────────────────────────────────────────────────────────
  git_log: (args): GitLogEntry[] | Promise<GitLogEntry[]> =>
    ours(args.path)
      ? newestFirst()
          .slice(0, Number(args.limit ?? 100))
          .map((commit) => ({
            hash: commit.sha,
            short_hash: shortSha(commit.sha),
            message: messageOf(commit),
            author: PEOPLE[commit.author].name,
            date: gitRelative(commitMs(commit)),
          }))
      : gitHandlers.git_log(args),
  git_show: (args): CommitDetail | Promise<CommitDetail> => {
    if (!ours(args.path)) return gitHandlers.git_show(args);
    const commit = commitBySha(args.sha);
    if (!commit) throw new Error(`bad object ${String(args.sha)}`);
    const person = PEOPLE[commit.author];
    return {
      hash: commit.sha,
      shortHash: shortSha(commit.sha),
      author: person.name,
      email: person.email,
      date: gitShowDate(commitMs(commit)),
      subject: commit.subject,
      body: commit.body ?? "",
      diff: commitDiff(commit),
    };
  },
  capture_commit_sessions: (args): CommitSession[] | Promise<CommitSession[]> => {
    if (!ours(args.projectPath)) return gitHandlers.capture_commit_sessions(args);
    const commit = commitBySha(args.commitSha);
    return commit ? commitSessions(commit) : [];
  },
  git_commit_changed_files: (args): CommitFile[] | Promise<CommitFile[]> => {
    if (!ours(args.path)) return gitHandlers.git_commit_changed_files(args);
    const commit = commitBySha(args.sha);
    return commit ? commitFiles(commit) : [];
  },
  git_graph_signature: (args) =>
    ours(args.path)
      ? `${headCommit().sha}:${ahead}:${epoch}`
      : gitHandlers.git_graph_signature(args),
  git_graph_build: (args) =>
    ours(args.path) ? graph(Number(args.limit ?? 1000)) : gitHandlers.git_graph_build(args),

  // ── git: diffs and blame ────────────────────────────────────────────────
  git_diff_structured: (args): FileDiff | Promise<FileDiff> => {
    if (!ours(args.path)) return gitHandlers.git_diff_structured(args);
    const file = String(args.file);
    const commit = args.commit ? commitBySha(args.commit) : undefined;
    if (commit) {
      const { before, after } = commitTrees(commit);
      return buildFileDiff(before[file] ?? "", after[file] ?? "", file);
    }
    return workingDiff(file);
  },
  git_diff_line_status: (args): DiffLineStatus | Promise<DiffLineStatus> =>
    ours(args.path)
      ? lineStatusOf(workingDiff(String(args.file)))
      : gitHandlers.git_diff_line_status(args),
  git_diff_file: (args) => {
    if (!ours(args.path)) return gitHandlers.git_diff_file(args);
    const change = changeFor(String(args.file));
    return change ? unifiedDiff(change.before ?? "", change.after, change.path) : "";
  },
  git_diff_all: (args) =>
    ours(args.path)
      ? changes()
          .map((change) => unifiedDiff(change.before ?? "", change.after, change.path))
          .join("")
      : gitHandlers.git_diff_all(args),
  git_blame_file: (args): BlameLine[] | Promise<BlameLine[]> =>
    ours(args.path) ? blame(String(args.file)) : gitHandlers.git_blame_file(args),
  git_repo_pull_requests: (args): RepoPullRequests | Promise<RepoPullRequests> =>
    ours(args.path)
      ? { kind: "ok", byBranch: { [MERGED_BRANCH.name]: MERGED_BRANCH_PR } }
      : gitHandlers.git_repo_pull_requests(args),

  // ── git: index and working tree ─────────────────────────────────────────
  git_stage: (args) => {
    if (!ours(args.path)) return gitHandlers.git_stage(args);
    for (const file of (args.files ?? []) as string[]) if (changeFor(file)) staged.add(file);
    notifyChanged();
    return null;
  },
  git_unstage: (args) => {
    if (!ours(args.path)) return gitHandlers.git_unstage(args);
    for (const file of (args.files ?? []) as string[]) staged.delete(file);
    notifyChanged();
    return null;
  },
  // Hunk staging stages the whole file here: the scenario never splits one.
  git_stage_hunk: (args) => {
    if (!ours(args.path)) return gitHandlers.git_stage_hunk(args);
    if (changeFor(String(args.file))) staged.add(String(args.file));
    notifyChanged();
    return null;
  },
  git_unstage_hunk: (args) => {
    if (!ours(args.path)) return gitHandlers.git_unstage_hunk(args);
    staged.delete(String(args.file));
    notifyChanged();
    return null;
  },
  git_discard: (args) => {
    if (!ours(args.path)) return gitHandlers.git_discard(args);
    discard((args.files ?? []) as string[]);
    return null;
  },
  git_delete_added: (args) => {
    if (!ours(args.path)) return gitHandlers.git_delete_added(args);
    discard((args.files ?? []) as string[]);
    return null;
  },

  // ── git: commit and remote ──────────────────────────────────────────────
  git_commit_v2: (args) => {
    if (!ours(args.path)) return gitHandlers.git_commit_v2(args);
    const anyStaged = changes().some((change) => staged.has(change.path));
    return runOp(
      "commit",
      args.opId,
      anyStaged ? ["bun test", " 35 pass", " 0 fail"] : [],
      (): null => {
        if (args.amend && !anyStaged) return null;
        const coAuthors = ((args.coAuthors ?? []) as string[]).filter(Boolean);
        commitStaged(
          String(args.summary ?? "").trim(),
          String(args.description ?? "").trim(),
          coAuthors,
        );
        return null;
      },
    );
  },
  git_push: (args) => {
    if (!ours(args.path)) return gitHandlers.git_push(args);
    return runOp(
      "push",
      args.opId,
      [
        "Enumerating objects: 9, done.",
        "Writing objects: 100% (5/5), 1.12 KiB | 1.12 MiB/s, done.",
        "To github.com:northwind/northwind-shop.git",
      ],
      (): null => {
        ahead = 0;
        return null;
      },
    );
  },
  git_pull: (args) =>
    ours(args.path)
      ? runOp("pull", args.opId, ["Already up to date."], (): null => null)
      : gitHandlers.git_pull(args),
  git_fetch: (args) =>
    ours(args.path) ? runOp("fetch", args.opId, [], (): null => null) : gitHandlers.git_fetch(args),
  git_merge_preview: (args): MergePreview | Promise<MergePreview> =>
    ours(args.path)
      ? { kind: "uptodate", commitCount: 0, conflictedFiles: 0 }
      : gitHandlers.git_merge_preview(args),
  git_conflict_state: (args): ConflictState | Promise<ConflictState> =>
    ours(args.path) ? { files: [], message: "" } : gitHandlers.git_conflict_state(args),

  // Branch surgery, stashes, tags, resets: nothing in the videos does these to
  // northwind, so they succeed without moving anything rather than leaking
  // into the default fixture's repository.
  git_publish_branch: quietly("git_publish_branch"),
  git_checkout: quietly("git_checkout"),
  git_create_branch: quietly("git_create_branch"),
  git_rename_branch: quietly("git_rename_branch"),
  git_branch_delete: quietly("git_branch_delete"),
  git_merge_branch: quietly("git_merge_branch"),
  git_rebase: quietly("git_rebase"),
  git_op_control: quietly("git_op_control"),
  git_resolve_file: quietly("git_resolve_file"),
  git_undo_commit: quietly("git_undo_commit"),
  git_squash_last: quietly("git_squash_last"),
  git_reset: quietly("git_reset"),
  git_revert: quietly("git_revert"),
  git_cherry_pick: quietly("git_cherry_pick"),
  git_create_tag: quietly("git_create_tag"),
  git_delete_tag: quietly("git_delete_tag"),
  git_remote_add: quietly("git_remote_add"),
  git_remote_remove: quietly("git_remote_remove"),
  git_discard_hunk: quietly("git_discard_hunk"),
  git_stash_push: quietly("git_stash_push"),
  git_stash_pop: quietly("git_stash_pop"),
  git_stash_apply: quietly("git_stash_apply"),
  git_stash_drop: quietly("git_stash_drop"),
};

/** `git restore` / deleting an added file: back to HEAD, agent changes included. */
function discard(files: string[]): void {
  const dropped = new Set(files);
  for (const file of files) {
    edits.delete(file);
    staged.delete(file);
  }
  const rest = pending.changes.filter((change) => !dropped.has(change.path));
  if (rest.length !== pending.changes.length) {
    setPending(rest, rest.length > 0 ? pending.sessions : []);
  } else {
    notifyChanged();
  }
}

/**
 * Commands no fixture declares a response type for: `read_directory` is an
 * inline handler in `base.ts`, so it is overridden here, untyped.
 */
export const northwindGitRawCommands: MockHandlers = {
  read_directory: ({ path }): FileEntry[] =>
    ours(path) ? readDirectory(String(path)) : listDir(String(path)),
};

/** The file on disk right now, for the scripted run that builds `pending` from it. */
export function northwindFileText(path: string): string | undefined {
  return worktreeText(path);
}
