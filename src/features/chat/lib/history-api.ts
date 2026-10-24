import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { SessionKey } from "@/types/agents";

/**
 * Atlas's session history — the app-owned thread-metadata store (ADR-0001).
 *
 * History used to be assembled by reading each agent CLI's private storage and
 * re-reading it whenever a file changed. It is Atlas's own store now, and the
 * UI's only refresh signal is {@link THREADS_CHANGED_EVENT}: nothing here polls.
 *
 * Discovery (ADR-0001 amendment, ATL-421–424) feeds that store from outside
 * Atlas, metadata only — a transcript is never read for content; replay goes
 * through the agent. {@link syncProjectThreads} asks the agents for the open
 * project's sessions, and also arms a Rust watcher on that project's Claude
 * transcript directory (`session_watcher.rs`) that syncs new sessions and
 * bumps active ones. While any session is live elsewhere, a 30s ticker there
 * re-announces the change event when the clock alone changes `liveElsewhere`.
 */

/** Fired whenever a thread row is added, changed or removed. */
export const THREADS_CHANGED_EVENT = "atlas:threads-changed";

/**
 * Re-run `onChange` whenever history changes.
 *
 * The event carries no payload on purpose — several changes can collapse into
 * one, and re-reading the store is the right response to any of them.
 */
export function onThreadsChanged(onChange: () => void): Promise<UnlistenFn> {
  return listen(THREADS_CHANGED_EVENT, () => onChange());
}

/** One thread, as every history surface renders it. */
export interface ThreadRow {
  threadId: string;
  /** Absent while the thread is a draft — nothing has been sent yet. */
  sessionId: string | null;
  /** Which agent ran it: the row's icon, and who resumes it. */
  agentId: string;
  /** Already resolved: the user's rename, else the agent's title, else the default. */
  title: string;
  updatedAt: string;
  createdAt: string | null;
  /**
   * When the session was settled — moved to the sidebar's Settled shelf, still
   * listed and resumable — as RFC 3339. `null` while it is active. Set by the
   * user or by the idle sweep (`autoSettleAfterDays`); a send clears it.
   * Settling replaced archiving: there is no archived state.
   */
  settledAt: string | null;
  /** When the session was pinned (RFC 3339); `null` when it is not. Pinned
   *  sessions are never auto-settled. */
  pinnedAt: string | null;
  /** Its place among the pinned: a fractional key compared as a plain string
   *  (`pin-order.ts`). `null` sorts after every keyed pin. */
  pinOrder: string | null;
  /** When a snoozed session wakes on its own (RFC 3339); `null` when it is not
   *  snoozed. Rust clears it at that time, or earlier when the session raises
   *  its hand (a permission, a question, a failure). */
  snoozedUntil: string | null;
  snoozedAt: string | null;
  /** When it last woke from a snooze. */
  lastSnoozeWakeAt: string | null;
  /** When the user last opened or focused it. */
  lastViewedAt: string | null;
  /** When its latest turn completed, as Atlas saw it end. */
  lastTurnCompletedAt: string | null;
  /** Its latest turn completed after it was last viewed. Decided in Rust. */
  unread: boolean;
  /** It woke from a snooze and has not been viewed since ("Woke"). Decided in
   *  Rust. */
  woke: boolean;
  projectName: string;
  folderPaths: string[];
  /** Another process (typically `claude` in a terminal) wrote this session
   *  within the last ~90s and Atlas is not hosting it. Decided in Rust. */
  liveElsewhere: boolean;
  /**
   * The git branch the thread's working directory was on when it last started
   * a turn (or was opened). `null` when Atlas never saw one — a detached HEAD,
   * a folder outside any repository, or a row recorded before branches were.
   * Never guessed.
   */
  branch: string | null;
  /** The model its latest turn ran on, by the agent's display name. `null`
   *  when Atlas never saw one — an import, or a row older than the column. */
  model: string | null;
  /**
   * The projects attached to the session besides its own folder, in the order
   * they were attached. A project filter matches a session on these paths as
   * well as `folderPaths`. Empty for nearly every session.
   */
  attachedProjects: AttachedProject[];
  /**
   * The session this one was branched from ("Branch from here"), as the
   * parent's agent session id; `null` for a session not forked in Atlas.
   * The session context overlay's Lineage reads it both ways: this row's
   * parent, and the rows that name this one as theirs.
   */
  forkedFromSessionId: string | null;
  /**
   * The pull requests linked to the session — opened from it, found on its
   * branch, linked by the user or the agent — in the order they were linked,
   * each with the host's last reported state. Unlinked ones are left out.
   * Kept current by the sync sweep (`session_pull_requests_sync`).
   */
  pullRequests: PullRequestLink[];
}

/** How a pull request came to be linked to a session. */
export type PullRequestLinkSource = "manual" | "created" | "detected" | "agent";

/** A pull request linked to a session — Rust's `PullRequestLinkWire`. */
export interface PullRequestLink {
  /** `owner/name`. With `number`, the link's identity. */
  repository: string;
  number: number;
  url: string;
  source: PullRequestLinkSource;
  /** RFC 3339. */
  linkedAt: string;
  /** `null` until the host has been read. */
  snapshot: PullRequestLinkSnapshot | null;
  /** Atlas is watching it for the session, and wakes the session's agent
   *  when a check fails, the checks pass, someone comments or the branch
   *  conflicts. */
  watching: boolean;
}

/** The host's last reported state for a linked pull request. */
export interface PullRequestLinkSnapshot {
  state: "open" | "closed" | "merged";
  title: string;
  headBranch: string;
  baseBranch: string;
  isDraft: boolean;
  updatedAt: string | null;
  /** When it merged; `null` while it is not merged, or on a snapshot stored
   *  before the merge time was kept. Absent from older fakes. */
  mergedAt?: string | null;
  checksState: "passing" | "failing" | "pending" | null;
  reviewDecision: "approved" | "changes-requested" | "review-required" | null;
  commentCount: number | null;
  /** RFC 3339: when Atlas read it. */
  syncedAt: string;
}

/** What a session may do in an attached project. Read-only unless granted. */
export type ProjectAccess = "read_only" | "read_write";

/** How a project came to be attached: an `@` mention in the composer, the
 *  agent asking and the user approving, or a repo cloned from the composer. */
export type AttachSource = "mention" | "agent_request" | "clone";

/** A project attached to a session — Rust's `AttachedProjectWire`. */
export interface AttachedProject {
  /** Canonical absolute path. The identity: one entry per path. */
  path: string;
  displayName: string;
  access: ProjectAccess;
  /** RFC 3339. */
  attachedAt: string;
  source: AttachSource;
}

/** One project's threads, as the sidebar groups them. */
export interface ThreadProject {
  /** Already disambiguated: qualified with the parent directory when another
   *  project shares its basename. */
  name: string;
  paths: string[];
  /** This is the project passed as `cwd`. Decided in Rust against canonicalised
   *  paths — never re-derive it here by comparing path strings, which is what
   *  used to fail whenever the two spellings differed. */
  isCurrent: boolean;
  threads: ThreadRow[];
}

/**
 * The open project's threads — the chat history sidebar's only source.
 *
 * Scoped to `cwd`: the store holds every project's threads, but Atlas switches
 * projects inside one window, so listing all of them here mixed unrelated
 * conversations into the sidebar. {@link threadHistory} is the unscoped view.
 *
 * Passing an empty `cwd` (no project open) returns every project, since there
 * is nothing to scope to.
 */
export function threadProjects(cwd: string): Promise<ThreadProject[]> {
  return invoke<ThreadProject[]>("threads_projects", { cwd: cwd || null });
}

/**
 * Ask the agents Atlas already has history with for the recent sessions they
 * hold for `cwd`, and add them to the sidebar. Answers how many rows landed.
 *
 * Cheap to call often: the backend answers `0` for a project synced in the last
 * 30 seconds. The change event does the refreshing, so callers need not.
 */
export function syncProjectThreads(cwd: string): Promise<number> {
  return invoke<number>("threads_sync_project", { cwd });
}

/** Every session, newest-started first — the history view. */
export function threadHistory(): Promise<ThreadRow[]> {
  return invoke<ThreadRow[]>("threads_history");
}

/** A history row, now live. */
export interface ResumedThread {
  key: SessionKey;
  /**
   * The agent could only continue the session, not replay it — the old
   * messages are not coming back, and the user is told rather than left to
   * wonder where they went.
   */
  resumedWithoutHistory: boolean;
}

/**
 * Turn a history row into a live session: start the agent if it isn't running,
 * then `session/load` or `session/resume` by advertised capability.
 */
export function resumeThread(threadId: string): Promise<ResumedThread> {
  return invoke<ResumedThread>("threads_resume", { threadId });
}

/** Remove a history row. Always local; agent-side only when advertised. */
export function deleteThread(threadId: string): Promise<void> {
  return invoke<void>("threads_delete", { threadId });
}

/**
 * Move a session to the Settled shelf: done for now, still in the sidebar.
 * Rejects while a turn is running in it. Resolves whether anything changed —
 * `false` for a session already settled, gone, or sent to a moment ago.
 */
export function settleThread(threadId: string): Promise<boolean> {
  return invoke<boolean>("threads_settle", { threadId });
}

/** Take a session back off the Settled shelf. Resolves whether it was on it. */
export function unsettleThread(threadId: string): Promise<boolean> {
  return invoke<boolean>("threads_unsettle", { threadId });
}

/**
 * Pin a session. `orderKey` places it among the pinned (`pin-order.ts` mints
 * it); omitted, it sorts after every keyed pin. Pinning a settled or snoozed
 * session brings it back. Resolves whether anything changed.
 */
export function pinSession(threadId: string, orderKey?: string): Promise<boolean> {
  return invoke<boolean>("threads_pin", { threadId, orderKey: orderKey ?? null });
}

/** Unpin a session. Resolves whether it was pinned. */
export function unpinSession(threadId: string): Promise<boolean> {
  return invoke<boolean>("threads_unpin", { threadId });
}

/** Move a pinned session to `orderKey`. Resolves `false` for one not pinned. */
export function reorderPinnedSession(threadId: string, orderKey: string): Promise<boolean> {
  return invoke<boolean>("threads_reorder_pin", { threadId, orderKey });
}

/**
 * Snooze a session until `until` (an ISO time; `session-snooze.ts` has the
 * presets). Rejects for a time not in the future, and for a session with a
 * pending permission or question.
 */
export function snoozeSession(threadId: string, until: string): Promise<boolean> {
  return invoke<boolean>("threads_snooze", { threadId, until });
}

/** Wake a snoozed session now. Resolves whether it was snoozed. */
export function wakeSession(threadId: string): Promise<boolean> {
  return invoke<boolean>("threads_wake", { threadId });
}

/** Undo a snooze the user just set. Unlike {@link wakeSession} it leaves no
 *  "woke" mark. Resolves whether it was snoozed. */
export function unsnoozeSession(threadId: string): Promise<boolean> {
  return invoke<boolean>("threads_unsnooze", { threadId });
}

/** Rename a session. An empty title clears the rename, and the agent's own
 *  title shows again. */
export function renameThread(threadId: string, title: string): Promise<void> {
  return invoke<void>("threads_rename", { threadId, title });
}

/**
 * The chat tab running `sessionId` was opened or focused. Keyed by the live
 * session, which is what a tab knows. Debounced by the caller
 * (`useMarkActiveSessionViewed`); resolves whether a row was marked.
 */
export function markSessionViewed(sessionId: string): Promise<boolean> {
  return invoke<boolean>("threads_mark_viewed", { sessionId });
}

/** Make a session read as unread again. Rejects for one with no finished turn. */
export function markSessionUnread(threadId: string): Promise<boolean> {
  return invoke<boolean>("threads_mark_unread", { threadId });
}

/**
 * Fired once, ever: the first idle sweep that settled more than a handful of
 * sessions at a time, so the user learns where they went.
 */
export const SESSIONS_AUTO_SETTLED_EVENT = "atlas:sessions-auto-settled";

/** The first big idle sweep's payload: how many sessions it settled. */
export interface AutoSettledNotice {
  count: number;
}

export function onSessionsAutoSettled(
  handler: (notice: AutoSettledNotice) => void,
): Promise<UnlistenFn> {
  return listen<AutoSettledNotice>(SESSIONS_AUTO_SETTLED_EVENT, (e) => handler(e.payload));
}

/** Whether an agent can be imported from, and why not when it cannot. */
export type ImportStatus =
  | { kind: "ready"; importable: number }
  | { kind: "unsupported" }
  | { kind: "error"; message: string };

export interface ImportCandidate {
  pluginId: string;
  displayName: string;
  status: ImportStatus;
}

/**
 * Which installed agents can be imported from, and how much they have.
 *
 * Slow by nature: every installed agent is started to be asked, because the
 * capability only exists after `initialize`.
 */
export function importCandidates(): Promise<ImportCandidate[]> {
  return invoke<ImportCandidate[]>("threads_import_candidates");
}

/** Pull the chosen agents' sessions into history. Answers how many landed. */
export function importThreads(pluginIds: string[]): Promise<number> {
  return invoke<number>("threads_import", { pluginIds });
}
