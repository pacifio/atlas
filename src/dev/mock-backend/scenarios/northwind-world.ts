// The `northwind` scenario's world: who exists, where the project lives, what
// time it is, and the state the live cues mutate. Every `northwind-*.ts`
// adapter reads from here, so a Session, its commit, its chat card and its
// comments can never disagree about an id or a time.
//
// The words are in `northwind-content.ts`; this file holds no prose.

import type {
  AgentKey,
  ChatMessageContent,
  CommentContent,
  CommitContent,
  MemoryContent,
  PersonKey,
  SessionContent,
  Step,
  When,
} from "./northwind-content-types";
import { CONTENT } from "./northwind-content";

// ── URL options ───────────────────────────────────────────────────────────

const params = new URLSearchParams(typeof location === "undefined" ? "" : location.search);

/**
 * `?video=1`: the state before video 1's live beat — the discount-code
 * Session and its commit do not exist yet; the scripted run creates them.
 * Anything else (or nothing) is the state after it, which every later video
 * starts from.
 */
export const VIDEO = params.get("video");
export const BEFORE_VIDEO_1 = VIDEO === "1";

/**
 * `?codex=1`: Codex is already installed, as it is after video 9 installs it
 * on camera. Video 11 needs it; video 9 must start without it.
 */
export const CODEX_INSTALLED = params.get("codex") === "1";

// ── The cast ──────────────────────────────────────────────────────────────

export interface Person {
  key: PersonKey;
  /** The server user id; `<@usr_…>` mentions use it. */
  userId: string;
  memberId: string;
  name: string;
  email: string;
  role: "admin" | "member";
  isOwner: boolean;
  /** Days ago they joined Northwind. */
  joinedDaysAgo: number;
}

export const PEOPLE: Record<PersonKey, Person> = {
  uzayer: {
    key: "uzayer",
    userId: "usr_uzayer",
    memberId: "mem_uzayer",
    name: "Uzayer Masud",
    email: "uzayer@northwind.dev",
    role: "admin",
    isOwner: true,
    joinedDaysAgo: 8,
  },
  zuhayer: {
    key: "zuhayer",
    userId: "usr_zuhayer",
    memberId: "mem_zuhayer",
    name: "Zuhayer Masud",
    email: "zuhayer@northwind.dev",
    role: "member",
    isOwner: false,
    joinedDaysAgo: 8,
  },
};

export const ME = PEOPLE.uzayer;
export const userIdOf = (key: PersonKey): string => PEOPLE[key].userId;
export const personByUserId = (userId: string): Person | undefined =>
  Object.values(PEOPLE).find((p) => p.userId === userId);

// ── Org and project ───────────────────────────────────────────────────────

/** Local org row id and its server id (`remoteId`). */
export const ORG_ID = "org-nw-local";
export const ORG_REMOTE_ID = "org_7Hq2nW4k";
export const ORG_NAME = "Northwind";
export const ORG_SLUG = "northwind";

export const PROJECT = {
  id: "ws-northwind-shop",
  name: "northwind-shop",
  path: "/Users/uzayer/Developer/northwind-shop",
  groupId: null,
  orgId: ORG_ID,
};

/** The server Project (Workspace) `northwind-shop` is bound to. */
export const REMOTE_PROJECT_ID = "rw_5c2e8b41";
export const HOME = "/Users/uzayer";

/** Repo-relative path → absolute, as Rust would report it. */
export const abs = (rel: string): string => `${PROJECT.path}/${rel}`;
/** Absolute → repo-relative, or `null` outside the project. */
export const rel = (path: string): string | null =>
  path === PROJECT.path
    ? ""
    : path.startsWith(`${PROJECT.path}/`)
      ? path.slice(PROJECT.path.length + 1)
      : null;

// ── Agents ────────────────────────────────────────────────────────────────

export const AGENT_LABEL: Record<AgentKey, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "atlas-agent": "Atlas Agent",
};

/** The capture `source` each agent records under — drives the row's glyph. */
export const AGENT_SOURCE: Record<AgentKey, string> = {
  "claude-code": "acp",
  codex: "acp",
  "atlas-agent": "atlas-agent",
};

// ── Time ──────────────────────────────────────────────────────────────────

/** Page load. Everything is placed relative to it. */
export const LOAD = Date.now();

/** A `When` as epoch ms, in local time. */
export function whenMs(when: When): number {
  // `@<epoch ms>`: a moment something happened during the take (see `nowWhen`).
  const stamped = when.at.match(/^@(\d+)$/);
  if (stamped) return Number(stamped[1]);
  const now = when.at.match(/^now-(\d+)$/);
  if (now) return LOAD - Number(now[1]) * 60_000;
  const [h, m] = when.at.split(":").map(Number);
  const d = new Date(LOAD);
  d.setDate(d.getDate() - when.daysAgo);
  d.setHours(h, m, 0, 0);
  // A wall-clock time later today than "now" would be in the future; pull it
  // back to an hour ago so a morning recording still reads sensibly.
  if (when.daysAgo === 0 && d.getTime() > LOAD) return LOAD - 60 * 60_000;
  return d.getTime();
}

export const iso = (ms: number): string => new Date(ms).toISOString();

/** This instant, as a `When` — for things that happen during a take. */
export const nowWhen = (): When => ({ daysAgo: 0, at: `@${Date.now()}` });

// ── Sessions ──────────────────────────────────────────────────────────────

export interface SessionState {
  content: SessionContent;
  startMs: number;
  /** Steps visible right now (seeded + any live steps streamed so far). */
  steps: Step[];
  /** Still being written: drives the pulsing dot. */
  live: boolean;
  /** Last write, epoch ms. A live Session's is stamped at read time. */
  lastMs: number;
}

const sessionState = new Map<string, SessionState>();

function initSession(content: SessionContent): SessionState {
  const startMs = whenMs(content.started);
  const steps = [...content.steps];
  const lastStep = Math.max(0, ...steps.map((s) => s.min));
  return {
    content,
    startMs,
    steps,
    live: Boolean(content.live),
    lastMs: content.live ? LOAD : startMs + Math.max(lastStep, content.durationMin) * 60_000,
  };
}

/** Whether a Session exists in the current world (video options applied). */
function exists(content: SessionContent): boolean {
  return !(BEFORE_VIDEO_1 && (content.createdOnCamera === "video1" || content.afterVideo1));
}

function seedSessions(): void {
  sessionState.clear();
  for (const content of CONTENT.sessions) {
    if (exists(content)) sessionState.set(content.id, initSession(content));
  }
}
seedSessions();

/** Every Session in the world, newest activity first. */
export function sessions(): SessionState[] {
  return [...sessionState.values()].sort((a, b) => b.lastMs - a.lastMs);
}

export function session(id: string): SessionState | undefined {
  return sessionState.get(id);
}

/** The Session's content even when it does not exist yet (video 1). */
export function sessionContent(id: string): SessionContent | undefined {
  return CONTENT.sessions.find((s) => s.id === id);
}

/** The timeline row id of a step — what comments anchor to. */
export const rowId = (sessionId: string, stepId: string): string => `${sessionId}:${stepId}`;

export const stepMs = (s: SessionState, step: Step): number => s.startMs + step.min * 60_000;

/** Bring a Session into existence now (video 1's live run). */
export function createSession(id: string, startMs: number): SessionState | undefined {
  const content = sessionContent(id);
  if (!content) return undefined;
  const state = initSession(content);
  const shift = startMs - state.startMs;
  state.startMs = startMs;
  state.lastMs += shift;
  sessionState.set(id, state);
  return state;
}

/** Reveal the next live step of a live Session; `false` once there are none. */
export function advanceLive(id: string): Step | null {
  const s = sessionState.get(id);
  const pending = s?.content.live?.liveSteps ?? [];
  if (!s) return null;
  const shown = s.steps.length - s.content.steps.length;
  const next = pending[shown];
  if (!next) {
    s.live = false;
    s.lastMs = Date.now();
    return null;
  }
  // Place it "now", so the detail reads as being written while you watch.
  const min = Math.max(next.min, (Date.now() - s.startMs) / 60_000);
  s.steps.push({ ...next, min });
  s.lastMs = Date.now();
  return next;
}

/** The live Session, if any is still being written. */
export function liveSession(): SessionState | undefined {
  return sessions().find((s) => s.live);
}

// ── Commits ───────────────────────────────────────────────────────────────

/** Is this content commit one that video 1 makes on camera, or one made after it? */
const notYetMade = (c: CommitContent): boolean =>
  c.sessions.some((id) => {
    const s = sessionContent(id);
    return s?.createdOnCamera === "video1" || s?.afterVideo1 === true;
  });

/**
 * Commits in the world, oldest first. `?video=1` leaves out the one video 1
 * makes on camera; the commit made from the git panel during the take takes
 * its place (`addCommit`).
 */
export function commits(): CommitContent[] {
  const seeded = BEFORE_VIDEO_1 ? CONTENT.commits.filter((c) => !notYetMade(c)) : CONTENT.commits;
  return [...seeded, ...extraCommits];
}

/** Commits made from the git panel during a take (video 1 beat 2). */
const extraCommits: CommitContent[] = [];
/** Session id → the key of the commit made for it on camera. */
const madeFor = new Map<string, string>();
export function addCommit(commit: CommitContent): void {
  extraCommits.push(commit);
  for (const id of commit.sessions) madeFor.set(id, commit.key);
}

/**
 * The commit a Session's checkpoint step names — or, for a Session whose
 * commit was made on camera, the one made then. `undefined` until it exists,
 * so the checkpoint row stays off the timeline until the commit does.
 */
export function checkpointCommit(sessionId: string, key: string): CommitContent | undefined {
  return commitByKey(key) ?? commitByKey(madeFor.get(sessionId) ?? "");
}

export const commitByKey = (key: string): CommitContent | undefined =>
  commits().find((c) => c.key === key);
export const commitBySha = (sha: string): CommitContent | undefined =>
  commits().find((c) => c.sha === sha || c.sha.startsWith(sha));

// ── Comments ──────────────────────────────────────────────────────────────

const extraComments: CommentContent[] = [];
const commentPatches = new Map<string, Partial<CommentContent> & { deleted?: boolean }>();

export function comments(): (CommentContent & { deleted?: boolean })[] {
  return [...CONTENT.comments, ...extraComments]
    .filter((c) => sessionState.has(c.session))
    .map((c) => ({ ...c, ...commentPatches.get(c.id) }));
}
export function addComment(comment: CommentContent): void {
  extraComments.push(comment);
}
export function patchComment(id: string, patch: Partial<CommentContent> & { deleted?: boolean }) {
  commentPatches.set(id, { ...commentPatches.get(id), ...patch });
}

// ── Chat ──────────────────────────────────────────────────────────────────

const extraMessages: ChatMessageContent[] = [];
export function chat(): ChatMessageContent[] {
  return [...CONTENT.chat, ...extraMessages].filter(
    (m) => !m.sessionRef || sessionState.has(m.sessionRef.session),
  );
}
export function addMessage(message: ChatMessageContent): void {
  extraMessages.push(message);
}

/** Who is online right now. Zuhayer comes online on the `zuhayerOnline` cue. */
export const presence = { online: new Set<PersonKey>(["uzayer"]) };

// ── Memory ────────────────────────────────────────────────────────────────

const extraMemory: MemoryContent[] = [];
export function memory(): MemoryContent[] {
  return [...CONTENT.memory, ...extraMemory];
}
export function addMemory(entry: MemoryContent): void {
  if (!extraMemory.some((m) => m.id === entry.id)) extraMemory.push(entry);
}

// ── Uncommitted work (video 1 beat 2) ────────────────────────────────────

/** One file an on-camera agent run changed and nobody has committed yet. */
export interface PendingChange {
  /** Repo-relative. */
  path: string;
  /** Full file text before and after. `before: null` = a new file. */
  before: string | null;
  after: string;
}

/**
 * What the scripted run left in the working tree, and the Sessions that
 * produced it. The git adapter lists these as changes; committing them from the
 * git panel turns them into a commit whose "Produced by" names `sessions`.
 */
export const pending: { changes: PendingChange[]; sessions: string[] } = {
  changes: [],
  sessions: [],
};

/** Listeners told when `pending` changes, so the git adapter can emit `atlas:git-changed`. */
const pendingListeners: (() => void)[] = [];
export function onPendingChanged(listener: () => void): void {
  pendingListeners.push(listener);
}
export function setPending(changes: PendingChange[], sessionIds: string[]): void {
  pending.changes = changes;
  pending.sessions = sessionIds;
  for (const listener of pendingListeners) listener();
}

// ── Reset ─────────────────────────────────────────────────────────────────
//
// There is no in-place reset: every piece of state above is module-level and
// seeded at load, so the `reset` cue reloads the page (keeping the URL, and so
// `?scenario=northwind&record=1&video=…`). That is the only reset that cannot
// miss a store.
