/**
 * Pull requests linked to a session — the wrappers over
 * `session_pull_requests_*` (`src-tauri/src/commands/session_pull_requests.rs`).
 *
 * A link rides on the session row (`ThreadRow.pullRequests`) with how it came
 * to be (opened from the session, found on its branch, linked by the user or
 * the agent) and the host's last reported state. Every change fires
 * `atlas:threads-changed`, so history surfaces re-read without being told.
 *
 * Each call rejects with a `PrError` (see `pr-errors.ts`). The sync passes the
 * gh gate first, and notes how it ended, so a rate limit found here holds
 * every other pull-request read back too.
 */

import { invoke } from "@tauri-apps/api/core";

import type { PullRequestLink, PullRequestLinkSource } from "@/features/chat/lib/history-api";
import { classifyPrError, ghGate, noteGhOutcome } from "./pr-errors";

export type {
  PullRequestLink,
  PullRequestLinkSnapshot,
  PullRequestLinkSource,
} from "@/features/chat/lib/history-api";

/** What a link or unlink did — Rust's `SessionPullRequestsChange`. */
export interface SessionPullRequestsChange {
  /** The session's links after the change. */
  pullRequests: PullRequestLink[];
  /** `false` when it was already so. */
  changed: boolean;
}

/** What one sweep pass did — Rust's `SessionPullRequestsSync`. */
export interface SessionPullRequestsSync {
  /** Pull requests read from the host this pass. */
  read: number;
  /** Links added by detection. */
  detected: number;
  /** Sessions whose links changed. */
  changed: number;
  /** Another pass was already running; this one did nothing. */
  skipped: boolean;
}

/**
 * Link pull request `number` of the checkout at `repoPath` to the session.
 * Rejects with `notFound` for a number the repository does not have. Linking
 * one already linked changes nothing.
 */
export function linkSessionPullRequest(
  threadId: string,
  repoPath: string,
  number: number,
  source: Extract<PullRequestLinkSource, "manual" | "agent"> = "manual",
): Promise<SessionPullRequestsChange> {
  return invoke<SessionPullRequestsChange>("session_pull_requests_link", {
    threadId,
    repoPath,
    number,
    source,
  }).catch((raw: unknown) => {
    throw classifyPrError(raw);
  });
}

/** Unlink `repository#number`. The branch sweep does not bring it back. */
export function unlinkSessionPullRequest(
  threadId: string,
  repository: string,
  number: number,
): Promise<SessionPullRequestsChange> {
  return invoke<SessionPullRequestsChange>("session_pull_requests_unlink", {
    threadId,
    repository,
    number,
  }).catch((raw: unknown) => {
    throw classifyPrError(raw);
  });
}

/**
 * Start (`watching`) or stop watching `repository#number` for the session.
 * Rejects with `invalid` when it cannot be watched: watching is off in
 * Settings, the session is settled, it is not linked, or it is not open.
 */
export function watchSessionPullRequest(
  threadId: string,
  repository: string,
  number: number,
  watching: boolean,
): Promise<SessionPullRequestsChange> {
  return invoke<SessionPullRequestsChange>("session_pull_requests_watch", {
    threadId,
    repository,
    number,
    watching,
  }).catch((raw: unknown) => {
    throw classifyPrError(raw);
  });
}

/**
 * One sweep pass over `threadIds` (every unsettled session when `null`):
 * detect each session's branch pull requests, and read the links that are
 * due. `force` reads them whether due or not. Held back while the gh gate is
 * closed; a missing `gh`, a signed-out one or a rate limit closes it.
 */
export async function syncSessionPullRequests(
  threadIds: string[] | null,
  force = false,
): Promise<SessionPullRequestsSync> {
  const held = ghGate();
  if (held) throw held;
  try {
    const result = await invoke<SessionPullRequestsSync>("session_pull_requests_sync", {
      threadIds,
      force,
    });
    noteGhOutcome(null);
    return result;
  } catch (raw) {
    const error = classifyPrError(raw);
    noteGhOutcome(error);
    throw error;
  }
}
