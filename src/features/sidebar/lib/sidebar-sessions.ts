// The sidebar's session list, as data: which sessions it shows, in which
// section, in what order, and what a search finds.
//
// One flat list across the organisation's projects. Pinned sessions first, in
// their fractional-key order (`pin-order.ts`); then active ones by recency;
// snoozed sessions wait on the Snoozed shelf, soonest to wake first, until
// Rust wakes them; settled ones go to the Settled shelf, most recently
// settled first. Every lifecycle rule is Rust's
// (`atlas-thread-metadata`) — `unread` and `woke` arrive already decided, and
// nothing here re-derives them. This module only sorts and filters.

import type {
  AttachedProject,
  PullRequestLink,
  ThreadProject,
  ThreadRow,
} from "@/features/chat/lib/history-api";
import { sortByPinOrder } from "@/features/chat/lib/pin-order";
import { isUnderRoot } from "@/features/chat/lib/session-roots";
import { sidebarAgentOf, type SidebarAgent } from "@/features/chat/lib/sidebar-agents";
import { pullRequestSearchTerms } from "@/features/pull-requests/lib/session-pull-request-links";

/** A project the sidebar can scope to: one of the active organisation's. */
export interface SidebarProject {
  /** The Atlas project id — what the scope filter remembers. */
  id: string;
  name: string;
  path: string;
}

export type SidebarSection = "pinned" | "active" | "snoozed" | "settled";

/** One session, as a sidebar row reads it. Every field is a primitive, or an
 *  array the history read keeps while it is unchanged, so a memoised row
 *  compares cheaply. */
export interface SidebarSession {
  threadId: string;
  /** The agent's session id; what a live tab is matched by. */
  sessionId: string;
  title: string;
  agent: SidebarAgent;
  /** The registry id the row was recorded with. */
  agentId: string;
  projectId: string;
  projectName: string;
  projectPath: string;
  /** The session's own working directory — where it resumes. */
  cwd: string;
  branch: string | null;
  /** The model the latest turn ran on, as Rust recorded it. */
  model: string | null;
  updatedAt: string;
  createdAt: string | null;
  settledAt: string | null;
  pinnedAt: string | null;
  pinOrder: string | null;
  /** When a snooze still running ends; `null` when the session is not on
   *  the Snoozed shelf. */
  snoozedUntil: string | null;
  unread: boolean;
  woke: boolean;
  liveElsewhere: boolean;
  /** Held open in Atlas with a turn running, no tab needed (Universal RC). */
  heldWorking: boolean;
  /** The projects attached to the session, as the row carries them. The
   *  row's own array (one shared empty one when none), so a memoised row
   *  compares it by identity. */
  attachedProjects: readonly AttachedProject[];
  /** Their names, joined — the row's "+N" title. Empty when none. */
  attachedNames: string;
  /** Listed because the scoped project is attached to it, not because it
   *  runs there: the row says "attached". */
  viaAttached: boolean;
  /** The pull requests linked to the session, as the row carries them (one
   *  shared empty array when none, as for `attachedProjects`). */
  pullRequests: readonly PullRequestLink[];
}

export interface SidebarPartition {
  pinned: SidebarSession[];
  active: SidebarSession[];
  /** Soonest to wake first. */
  snoozed: SidebarSession[];
  settled: SidebarSession[];
}

/** A path without its trailing separators, so `/a/b/` and `/a/b` agree. */
export function normalizePath(path: string): string {
  return path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
}

/** The organisation project a history group belongs to: the one whose folder
 *  holds one of the group's paths (`isUnderRoot`, so `\\` and `/` agree). The longest match wins, so a project nested
 *  in another claims its own sessions. */
export function matchProject(
  paths: readonly string[],
  projects: readonly SidebarProject[],
): SidebarProject | null {
  let best: SidebarProject | null = null;
  let bestLength = -1;
  for (const path of paths) {
    for (const project of projects) {
      const root = normalizePath(project.path);
      if (!isUnderRoot(path, root)) continue;
      if (root.length > bestLength) {
        best = project;
        bestLength = root.length;
      }
    }
  }
  return best;
}

const NO_ATTACHED: readonly AttachedProject[] = [];

/** `", "`-joined names, computed once per distinct array: the history read
 *  keeps an unchanged row's array, so a re-partition reuses the string. */
const namesCache = new WeakMap<readonly AttachedProject[], string>();
function attachedNamesOf(projects: readonly AttachedProject[]): string {
  if (projects.length === 0) return "";
  let names = namesCache.get(projects);
  if (names === undefined) {
    names = projects.map((p) => p.displayName).join(", ");
    namesCache.set(projects, names);
  }
  return names;
}

/** The scoped project is attached to `thread`: one of its attached paths is
 *  the project's folder or inside it, whichever separators either uses
 *  (`isUnderRoot`; a Windows path compares case-insensitively). */
function attachesProject(thread: ThreadRow, project: SidebarProject): boolean {
  const projects = thread.attachedProjects;
  if (!projects || projects.length === 0) return false;
  return projects.some((p) => isUnderRoot(p.path, project.path));
}

const NO_PULL_REQUESTS: readonly PullRequestLink[] = [];

/** The session last built from each row, with what else it was built from.
 *  React Query's structural sharing keeps an unchanged row's object across a
 *  refetch, so a row that did not change maps back to the very session it
 *  produced last time — and a memoised `SessionRow` skips the render. Without
 *  this every `atlas:threads-changed` re-rendered every mounted row. Keyed
 *  weakly: a row the history drops takes its session with it. */
const sessionCache = new WeakMap<ThreadRow, SidebarSession>();

function toSession(
  thread: ThreadRow,
  project: SidebarProject,
  snoozedUntil: string | null,
  viaAttached = false,
): SidebarSession {
  const cached = sessionCache.get(thread);
  if (
    cached !== undefined &&
    cached.projectId === project.id &&
    cached.projectName === project.name &&
    cached.projectPath === project.path &&
    cached.snoozedUntil === snoozedUntil &&
    cached.viaAttached === viaAttached
  ) {
    return cached;
  }
  const session = buildSession(thread, project, snoozedUntil, viaAttached);
  sessionCache.set(thread, session);
  return session;
}

function buildSession(
  thread: ThreadRow,
  project: SidebarProject,
  snoozedUntil: string | null,
  viaAttached: boolean,
): SidebarSession {
  const attached = thread.attachedProjects?.length ? thread.attachedProjects : NO_ATTACHED;
  const pullRequests = thread.pullRequests?.length ? thread.pullRequests : NO_PULL_REQUESTS;
  return {
    pullRequests,
    attachedProjects: attached,
    attachedNames: attachedNamesOf(attached),
    viaAttached,
    threadId: thread.threadId,
    sessionId: thread.sessionId ?? "",
    title: thread.title,
    agent: sidebarAgentOf(thread.agentId),
    agentId: thread.agentId,
    projectId: project.id,
    projectName: project.name,
    projectPath: project.path,
    cwd: thread.folderPaths[0] ?? project.path,
    branch: thread.branch ?? null,
    model: thread.model ?? null,
    updatedAt: thread.updatedAt,
    createdAt: thread.createdAt,
    settledAt: thread.settledAt,
    pinnedAt: thread.pinnedAt,
    pinOrder: thread.pinOrder,
    snoozedUntil,
    unread: thread.unread,
    woke: thread.woke,
    liveElsewhere: thread.liveElsewhere,
    heldWorking: thread.heldWorking,
  };
}

/** The `sidebarSort` setting: last activity, or when the session started. */
export type SidebarSort = "recent" | "created";

const byRecency = (a: SidebarSession, b: SidebarSession) =>
  b.updatedAt.localeCompare(a.updatedAt) || a.threadId.localeCompare(b.threadId);

const started = (session: SidebarSession) => session.createdAt ?? session.updatedAt;
const byCreated = (a: SidebarSession, b: SidebarSession) =>
  started(b).localeCompare(started(a)) || a.threadId.localeCompare(b.threadId);

/**
 * Sort the history into the sidebar's sections.
 *
 * `scopeProjectId` narrows the list to one project (the header's filter);
 * `null` is every project. `sort` orders the active list (the `sidebarSort`
 * setting); pinned keep their own order and the shelf its settle order. A group outside the organisation's projects is
 * left out — its sessions belong to another organisation, or to a folder this
 * one never opened. A thread with no session id is a draft and has nothing to
 * open yet. `now` decides which snoozes are still running, in case a wake has
 * not reached the row yet.
 */
export function partitionSidebarSessions(input: {
  groups: readonly ThreadProject[];
  projects: readonly SidebarProject[];
  scopeProjectId: string | null;
  now: number;
  sort?: SidebarSort;
}): SidebarPartition {
  const { groups, projects, scopeProjectId, now, sort = "recent" } = input;
  const pinned: SidebarSession[] = [];
  const active: SidebarSession[] = [];
  const snoozed: SidebarSession[] = [];
  const settled: SidebarSession[] = [];
  // Scoped to a project, a session elsewhere that has it attached is listed
  // too, marked. Only rows with attachments are looked at, so the scan is
  // over a handful of short arrays, not the history.
  const scoped =
    scopeProjectId !== null ? (projects.find((p) => p.id === scopeProjectId) ?? null) : null;
  for (const group of groups) {
    const project = matchProject(group.paths, projects);
    if (!project) continue;
    const inScope = scopeProjectId === null || project.id === scopeProjectId;
    if (!inScope && !scoped) continue;
    for (const thread of group.threads) {
      if (!thread.sessionId) continue;
      const viaAttached = !inScope && attachesProject(thread, scoped!);
      if (!inScope && !viaAttached) continue;
      const isSnoozed = thread.snoozedUntil !== null && Date.parse(thread.snoozedUntil) > now;
      const session = toSession(
        thread,
        project,
        isSnoozed ? thread.snoozedUntil : null,
        viaAttached,
      );
      if (isSnoozed) snoozed.push(session);
      else if (thread.settledAt !== null) settled.push(session);
      else if (thread.pinnedAt !== null) pinned.push(session);
      else active.push(session);
    }
  }
  active.sort(sort === "created" ? byCreated : byRecency);
  settled.sort(
    (a, b) => b.settledAt!.localeCompare(a.settledAt!) || a.threadId.localeCompare(b.threadId),
  );
  snoozed.sort(
    (a, b) =>
      a.snoozedUntil!.localeCompare(b.snoozedUntil!) || a.threadId.localeCompare(b.threadId),
  );
  return { pinned: sortByPinOrder(pinned), active, snoozed, settled };
}

/** The soonest snooze still running, so the list can re-partition when it
 *  ends even if Rust's wake event is late. `null` when nothing is snoozed. */
export function nextSnoozeWake(groups: readonly ThreadProject[], now: number): number | null {
  let soonest: number | null = null;
  for (const group of groups) {
    for (const thread of group.threads) {
      if (!thread.snoozedUntil) continue;
      const at = Date.parse(thread.snoozedUntil);
      if (at > now && (soonest === null || at < soonest)) soonest = at;
    }
  }
  return soonest;
}

/** Sessions whose title, project, branch or linked pull requests hold
 *  every word of `query`,
 *  case-insensitively. Title matches first, the rest after; each keeps the
 *  order it came in. Empty for an empty query. */
export function searchSidebarSessions(
  sessions: readonly SidebarSession[],
  query: string,
): SidebarSession[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const titleMatches: SidebarSession[] = [];
  const otherMatches: SidebarSession[] = [];
  for (const session of sessions) {
    const title = session.title.toLowerCase();
    if (words.every((word) => title.includes(word))) {
      titleMatches.push(session);
      continue;
    }
    const haystack = [
      title,
      session.projectName,
      session.branch ?? "",
      session.attachedNames,
      ...pullRequestSearchTerms(session.pullRequests),
    ]
      .join(" ")
      .toLowerCase();
    if (words.every((word) => haystack.includes(word))) otherMatches.push(session);
  }
  return [...titleMatches, ...otherMatches];
}

/** The remembered scope, if its project is still one of the organisation's;
 *  otherwise every project. */
export function resolveScopeProjectId(
  key: string | null,
  projects: readonly SidebarProject[],
): string | null {
  if (key === null) return null;
  return projects.some((project) => project.id === key) ? key : null;
}

/** Where to go once the open session is settled or snoozed: the next row
 *  below it, else the nearest above, else nowhere. */
export function nextAfterParking<T extends { threadId: string }>(
  rows: readonly T[],
  threadId: string,
): T | null {
  const index = rows.findIndex((row) => row.threadId === threadId);
  if (index === -1) return rows[0] ?? null;
  return rows[index + 1] ?? rows[index - 1] ?? null;
}

/** How many settled sessions the shelf shows when opened, and how many more
 *  each "Show more" adds. */
export const SETTLED_SHELF_FIRST_PAGE = 10;
export const SETTLED_SHELF_PAGE = 25;
