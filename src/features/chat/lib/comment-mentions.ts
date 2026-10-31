/**
 * Comments as composer references — "agent, look at this one".
 *
 * Only a chat whose session is in the cloud has comments to point at (synced
 * Organisation × Cloud-bound Project × captured session: `chat_comment_target`).
 * The chat already holds them — `ChatCommentsController` keeps
 * `chat-comments-store` current for the pane — so both ways in read that:
 *
 * - **`@`** — `searchCommentMentions`, recent first, filtered by author, body
 *   or what it hangs off.
 * - **the link button** in a comment's popover — `linkCommentToComposer`,
 *   which drops the chip into the composer of the chat that owns the comment.
 *
 * Every visible comment can be linked, root or reply, resolved or open.
 * Deleted ones cannot: there is nothing left to attend to.
 */

import type { Comment } from "@/features/artifacts/lib/comments-api";
import type { OrgDirectory } from "@/features/organisations/lib/use-org-directory";

import type { AnchorEntry } from "./comment-anchors";
import type { MentionComment } from "./org-mentions";
import type { MentionCitedText, MentionReviewComment } from "./mentions";
import { useChatCommentsStore, type TabComments } from "../stores/chat-comments-store";

/** How much of the body the chip shows after the author. */
const EXCERPT_CHARS = 48;

/** The window event the link button fires; the composer of `tabId` inserts.
 *  A reply passage's Cite rides the same event (`linkCiteToComposer`), and so
 *  does a comment on diff or file lines (`review-comments.ts`): each drops one
 *  chip, once, into one session's composer. */
export const COMMENT_LINK_EVENT = "atlas:chat-link-comment";

export interface CommentLinkDetail {
  tabId: string;
  mention: MentionComment | MentionCitedText | MentionReviewComment;
}

/**
 * One line, collapsed whitespace, `<@id>` written as the member's name.
 * Double quotes become single ones: a short form with whitespace is quoted
 * (`@comment:"Grace: …"`), and a `"` inside would end the token early for
 * the sent-message renderer.
 */
export function commentExcerpt(
  body: string,
  directory: OrgDirectory | null,
  max = EXCERPT_CHARS,
): string {
  const named = body.replace(
    /<@([A-Za-z0-9_.:-]{1,128})>/g,
    (_, id: string) => `@${directory?.byId.get(id)?.name ?? id}`,
  );
  const flat = named.replace(/\s+/g, " ").replace(/"/g, "'").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** What a comment hangs off, as a phrase: "the session", "a prompt", "a Bash call". */
export function anchorLabelFor(comment: Comment, entries: readonly AnchorEntry[]): string {
  if (comment.anchorKind === "session") return "the session";
  const entry = entries.find((e) => e.rowId === comment.anchorId);
  switch (entry?.kind ?? comment.anchorKind) {
    case "prompt":
      return "a prompt";
    case "response":
      return "a response";
    case "thinking":
      return "a thinking step";
    case "checkpoint":
      return "a checkpoint";
    case "tool_call":
      return entry?.toolName ? `a ${entry.toolName} call` : "a tool call";
    default:
      return "a message";
  }
}

/** The author as the roster names them; a guest by their own name. */
export function authorNameOf(comment: Comment, directory: OrgDirectory | null): string {
  if (comment.guestName) return comment.guestName;
  return directory?.byId.get(comment.authorId)?.name ?? "A member";
}

/** The mention a comment becomes, or `null` for one that cannot be linked. */
export function commentToMention(
  comment: Comment,
  tab: Pick<TabComments, "target" | "entries" | "directory">,
): MentionComment | null {
  if (!tab.target || comment.deletedAt || comment.body == null) return null;
  const authorName = authorNameOf(comment, tab.directory);
  return {
    kind: "comment",
    id: comment.id,
    displayName: `${authorName.replace(/"/g, "'")}: ${commentExcerpt(comment.body, tab.directory)}`,
    workspaceId: tab.target.remoteProjectId,
    sessionId: tab.target.sessionId,
    authorName,
    body: comment.body,
    anchorLabel: anchorLabelFor(comment, tab.entries),
    parentId: comment.parentId,
    resolved: comment.resolvedAt !== null,
    createdAt: comment.createdAt,
  };
}

/** Every linkable comment on the tab's session, newest first. */
export function listCommentMentions(tab: TabComments): MentionComment[] {
  const all: Comment[] = [...tab.session];
  for (const rowId in tab.byAnchor) all.push(...tab.byAnchor[rowId]);
  const out: MentionComment[] = [];
  for (const comment of all) {
    const mention = commentToMention(comment, tab);
    if (mention) out.push(mention);
  }
  // ISO timestamps from one server compare lexically; the id breaks a tie so
  // the order is stable across frames.
  return out.sort((a, b) =>
    a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt),
  );
}

/** `@` candidates for the chat tab, recent first, at most `limit`. */
export function searchCommentMentions(
  query: string,
  tabId: string | undefined,
  limit: number,
): MentionComment[] {
  if (!tabId) return [];
  const tab = useChatCommentsStore.getState().byTab[tabId];
  if (!tab?.target || !tab.actions) return [];
  const q = query.trim().toLowerCase();
  const all = listCommentMentions(tab);
  const hits = q
    ? all.filter(
        (m) =>
          m.authorName.toLowerCase().includes(q) ||
          m.body.toLowerCase().includes(q) ||
          m.anchorLabel.toLowerCase().includes(q),
      )
    : all;
  return hits.slice(0, limit);
}

/** Put a comment's chip in the composer of the chat that owns it. */
export function linkCommentToComposer(tabId: string, mention: MentionComment): void {
  window.dispatchEvent(
    new CustomEvent<CommentLinkDetail>(COMMENT_LINK_EVENT, { detail: { tabId, mention } }),
  );
}

/** Put a cited reply passage's chip in the composer of the session it is from. */
/**
 * Put a cited reply passage's chip in the composer of the session it is from.
 * True when a composer took it: the composer marks the event handled
 * (`preventDefault`), and one that is disabled or not mounted does not, so
 * the caller can keep the cite rather than close as if it landed.
 */
export function linkCiteToComposer(tabId: string, mention: MentionCitedText): boolean {
  const event = new CustomEvent<CommentLinkDetail>(COMMENT_LINK_EVENT, {
    detail: { tabId, mention },
    cancelable: true,
  });
  return !window.dispatchEvent(event);
}
