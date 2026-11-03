/**
 * Comments on a shared Session — the invoke wrappers and the anchor rule.
 *
 * Every call is org-scoped in Rust, which holds the Bearer; nothing here knows
 * a URL. Shapes mirror `atlas_artifacts::model` and
 * `commands::artifacts_cloud::CommentThreads`.
 *
 * # Anchors
 *
 * A comment is attached to an entry's `rowId`. That id is the one the local
 * store minted and pushed verbatim, so the id already on a `TimelineEntry` is
 * the anchor — there is no mapping table and nothing to look up.
 */

import { invoke } from "@tauri-apps/api/core";

import type { EntryKind } from "../types";

/** Where a comment is attached. Mirrors the server's `anchorKind` exactly. */
/** `thread_range` is a span of a shared Thread's transcript: never minted
 *  here, only read (an inbox entry on a Thread comment carries it). */
export type AnchorKind = "session" | "message" | "tool_call" | "checkpoint" | "thread_range";

/** The server's cap, enforced here so the composer can say so before sending. */
export const COMMENT_BODY_MAX = 4000;

export interface Comment {
  id: string;
  sessionId: string;
  anchorKind: AnchorKind;
  anchorId: string;
  /** Replies are exactly one level deep — a reply never parents another. */
  parentId: string | null;
  authorId: string;
  /** Non-null means a guest. Never render one as a member. */
  guestName: string | null;
  /** `null` once deleted; the row stays so replies keep their places. */
  body: string | null;
  /** Parsed server-side from `<@user-id>`. A client cannot send these. */
  mentions: string[];
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  /** Roots only — the server refuses to resolve a reply. */
  resolvedAt: string | null;
  resolvedBy: string | null;
  /** Who voted it up and who down — member ids, oldest first. Absent from a
   *  server older than votes; read it through `NO_VOTES`. */
  votes?: CommentVotes;
}

/** The people on each side, not two counts — so a reader can tell its own
 *  vote from the rest and name who agreed. Only members vote. */
export interface CommentVotes {
  up: string[];
  down: string[];
}

/**
 * One Session's comments, bucketed by what they hang off.
 *
 * Grouped in Rust because the server has neither a per-anchor count nor an
 * aggregate: this one read is both the threads and the counts, and bucketing on
 * two sides would let them disagree.
 */
export interface CommentThreads {
  /** Entry `rowId` → that entry's comments, oldest first, roots and replies. */
  byAnchor: Record<string, Comment[]>;
  /** Comments on the Session itself. */
  session: Comment[];
}

export const EMPTY_THREADS: CommentThreads = { byAnchor: {}, session: [] };

/**
 * The anchor kind for a timeline entry.
 *
 * Prompts, responses and thinking are all `agent_message` rows on the wire, so
 * all three anchor as `message` — the difference the viewer draws between them
 * is a `mode` on the row, not a different table.
 */
export function anchorKindFor(kind: EntryKind): AnchorKind {
  switch (kind) {
    case "tool_call":
      return "tool_call";
    case "checkpoint":
      return "checkpoint";
    default:
      return "message";
  }
}

export const comments = {
  list: (projectId: string, sessionId: string) =>
    invoke<CommentThreads>("artifacts_cloud_comments", { projectId, sessionId }),

  create: (
    projectId: string,
    sessionId: string,
    anchorKind: AnchorKind,
    anchorId: string,
    body: string,
    parentId: string | null = null,
  ) =>
    invoke<Comment>("artifacts_cloud_comment_create", {
      projectId,
      sessionId,
      anchorKind,
      anchorId,
      parentId,
      body,
    }),

  /** Edit a body (author only) or resolve a root (anyone who can read). */
  update: (
    projectId: string,
    sessionId: string,
    commentId: string,
    patch: { body?: string; resolved?: boolean },
  ) =>
    invoke<Comment>("artifacts_cloud_comment_update", {
      projectId,
      sessionId,
      commentId,
      body: patch.body ?? null,
      resolved: patch.resolved ?? null,
    }),

  /** One person's vote: `1` up, `-1` down, `0` takes it back. A value, not a
   *  toggle — a retry cannot undo itself. Members only. */
  vote: (projectId: string, sessionId: string, commentId: string, value: 1 | -1 | 0) =>
    invoke<Comment>("artifacts_cloud_comment_vote", { projectId, sessionId, commentId, value }),

  /** Answers with the comment, not nothing: the row survives with a null body. */
  remove: (projectId: string, sessionId: string, commentId: string) =>
    invoke<Comment>("artifacts_cloud_comment_delete", { projectId, sessionId, commentId }),
};

/**
 * Fold one comment into a bucketed set, in place of a refetch.
 *
 * The realtime channel sends **one** frame shape for post, edit, resolve and
 * delete, so this has to handle all four: an id already present is replaced
 * wherever it sits, and a new one is appended. Deletion arrives as a null body
 * on an existing row, which the replace covers.
 *
 * Ordering is the server's — oldest first — and a replacement keeps its
 * original position rather than jumping to the end.
 */
export function applyComment(threads: CommentThreads, comment: Comment): CommentThreads {
  const bucket =
    comment.anchorKind === "session" ? threads.session : threads.byAnchor[comment.anchorId];
  const existing = bucket ?? [];
  const at = existing.findIndex((c) => c.id === comment.id);
  const next = at >= 0 ? existing.map((c, i) => (i === at ? comment : c)) : [...existing, comment];

  if (comment.anchorKind === "session") {
    return { ...threads, session: next };
  }
  return { ...threads, byAnchor: { ...threads.byAnchor, [comment.anchorId]: next } };
}

/** A comment by id, wherever it hangs in a bucketed set. */
export function findComment(threads: CommentThreads, id: string): Comment | undefined {
  const hit = threads.session.find((c) => c.id === id);
  if (hit) return hit;
  for (const bucket of Object.values(threads.byAnchor)) {
    const found = bucket.find((c) => c.id === id);
    if (found) return found;
  }
  return undefined;
}

/**
 * How many comments to show on a node's button.
 *
 * Deleted rows are excluded but their replies are not: a thread whose opener
 * was removed is still a conversation, and showing `0` next to visible replies
 * would read as a bug.
 */
export function visibleCount(bucket: Comment[] | undefined): number {
  return bucket?.filter((c) => !c.deletedAt).length ?? 0;
}
