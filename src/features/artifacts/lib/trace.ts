/**
 * The Trace read, as the `CheckpointTrace` block's props.
 *
 * Pure, so the rules that decide what the chart says — one row per Session
 * across the two halves, who a Checkpoint is whose, when a Session is still
 * running, who a missing author is — are tested without a renderer.
 */

import { initialsOf } from "@tryatlas/design";

import { avatarSrc } from "@/features/auth/components/account-avatar";
import type { TraceAuthor, TraceCheckpoint, TraceSession } from "../components/checkpoint-trace";
import type { TraceCheckpointRow, TraceSessionRow } from "../types";
import { authorOf, type AuthorDirectory } from "./author-directory";
import type { TraceRange } from "./trace-api";

/**
 * A person, as the chart names them.
 *
 * Keyed by the human's id so two Checkpoints by one person collapse to one
 * participant. `null` — a row read from this disk — is the signed-in account;
 * a colleague who left the Organisation keeps their id and reads as "A member".
 */
export function traceAuthor(authorId: string | null, directory: AuthorDirectory): TraceAuthor {
  const who = authorOf(authorId, directory);
  const id = who.isSelf ? (directory.currentUserId ?? "self") : (authorId ?? "unknown");
  // The photo when the roster has one; without it the block draws the
  // person's initials in their own hue.
  const author: TraceAuthor = {
    id,
    name: who.label,
    avatarUrl: avatarSrc(who.avatar?.avatarPath ?? null),
  };
  // The two stand-in labels make poor initials ("YO", "AM"): your own face
  // reads your real initials, and someone the roster cannot name reads "?".
  if (who.isSelf) {
    author.initials = who.avatar ? initialsOf(who.avatar.name, who.avatar.email) : "ME";
  } else if (!who.avatar) {
    author.initials = "?";
  }
  return author;
}

/**
 * One row per Session.
 *
 * Your own synced work arrives twice — from the server, and from this disk on
 * the first page. The server's row wins (it knows every participant); the
 * disk's adds the checkout and the commit subjects only git on this machine
 * can read, and any Checkpoint that has not drained yet.
 */
export function foldTraceRows(rows: TraceSessionRow[]): TraceSessionRow[] {
  const byId = new Map<string, TraceSessionRow>();
  for (const row of rows) {
    const seen = byId.get(row.id);
    if (!seen) {
      byId.set(row.id, row);
      continue;
    }
    const [remote, local] = row.projectPath === undefined ? [row, seen] : [seen, row];
    const subjects = new Map(local.checkpoints.map((c) => [c.commitSha, c.commitSubject]));
    const shas = new Set(remote.checkpoints.map((c) => c.commitSha));
    byId.set(row.id, {
      ...remote,
      projectPath: local.projectPath ?? remote.projectPath,
      // The disk's clock is the one still being written to.
      live: remote.live || local.live,
      checkpoints: [
        ...remote.checkpoints.map((c) => ({
          ...c,
          commitSubject: c.commitSubject ?? subjects.get(c.commitSha) ?? null,
        })),
        ...local.checkpoints.filter((c) => !shas.has(c.commitSha)),
      ],
      checkpointsTruncated: remote.checkpointsTruncated || local.checkpointsTruncated,
    });
  }
  return [...byId.values()];
}

/** The last path segment, for a checkout the server has no name for. */
function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function buildTrace({
  rows,
  directory,
  range,
  now = Date.now(),
  agentLabelOf,
  projectNames = new Map(),
  agent = null,
  people = [],
}: {
  /** Every page of the read, both halves. */
  rows: TraceSessionRow[];
  directory: AuthorDirectory;
  range: TraceRange;
  now?: number;
  agentLabelOf: (agent: string) => string;
  /** Workspace id → the name the Organisation gave it. */
  projectNames?: Map<string, string>;
  /** The board's Agent pill. */
  agent?: string | null;
  /** The board's People pill: empty is everyone, `null` is your own rows. */
  people?: (string | null)[];
}): TraceSession[] {
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  const chosen = new Set(people);
  // The pill names your own work `null`, as the board does; the server stamps
  // it with your id. One identity, whichever half the row came from.
  const whose = (authorId: string | null) =>
    authorId !== null && authorId === directory.currentUserId ? null : authorId;

  const out: TraceSession[] = [];
  for (const row of foldTraceRows(rows)) {
    if (agent && row.agent !== agent) continue;
    if (chosen.size > 0 && !chosen.has(whose(row.authorId))) continue;
    const start = Date.parse(row.startedAt);
    const end = row.live ? now : Date.parse(row.lastActivityAt);
    // Any overlap with the window: a Session that started last week and is
    // still running belongs on this week's chart.
    if (start > to || end < from) continue;

    const participants = new Map<string, TraceAuthor>();
    const meet = (authorId: string | null): TraceAuthor => {
      const who = traceAuthor(authorId, directory);
      const known = participants.get(who.id);
      if (known) return known;
      participants.set(who.id, who);
      return who;
    };
    // The author first, then everyone the server says took part.
    meet(row.authorId);
    for (const id of row.participants) meet(id);

    const checkpoints = [...row.checkpoints]
      // By instant, not by string: the two halves' ISO stamps need not share
      // a format (`Z` vs `+00:00`, with or without milliseconds).
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      .map((cp: TraceCheckpointRow): TraceCheckpoint => ({
        id: cp.id,
        sessionId: row.id,
        at: cp.at,
        // A Checkpoint names who drove the Session when it landed; one read
        // from this disk is this account's — the same rule as a board row.
        author: meet(cp.authorId),
        // The server has no subject; the block falls back to the short sha.
        title: cp.commitSubject ?? undefined,
        sha: cp.commitSha,
        branch: cp.branch,
        linkState: cp.linkState,
        additions: cp.insertions,
        deletions: cp.deletions,
        files: cp.files,
      }));

    out.push({
      id: row.id,
      title: row.title ?? "Untitled session",
      projectId: row.workspaceId || row.projectPath || null,
      projectName:
        projectNames.get(row.workspaceId) ??
        (row.projectPath ? folderName(row.projectPath) : row.workspaceSlug),
      agentLabel: row.agent ? agentLabelOf(row.agent) : null,
      startedAt: row.startedAt,
      // There is no stored end: a finished Session ends at its last activity.
      endedAt: row.live ? null : row.lastActivityAt,
      status: row.live ? "live" : "settled",
      participants: [...participants.values()],
      checkpoints,
      checkpointsTruncated: row.checkpointsTruncated,
    });
  }
  return out.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}
