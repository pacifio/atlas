// Comments on diff or file lines, as composer chips.
//
// Beside a session, the reader picks lines in the diff (or in a file) and
// writes a comment. The comment becomes a `review_comment` chip in that
// session's composer, the way a cited reply passage does (`cited-text.ts`):
// the same link event drops it at the caret, the mention registry remembers
// it so the draft's `@review:<id>` token comes back as the chip, and
// `compose_prompt` (Rust) writes it into the prompt as the file, the range,
// the quoted lines and the comment. Nothing is posted anywhere.
//
// The composer's draft is the one record of which comments exist: the diff
// and the file view read it (`useComposerReviewComments`) to draw them back
// on their lines, so removing the chip removes the annotation, sending clears
// both, and deleting the annotation takes the chip out
// (`unlinkReviewComment`).
//
// Paths that carry plain text only — the send queue, and a send whose
// `compose_prompt` failed — get each comment written out after the prose
// (`withReviewCommentsInline`), as cites are.

import { useMemo } from "react";

import { useChatStore } from "../stores/chat-store";
import { cutText } from "./cited-text";
import { COMMENT_LINK_EVENT, type CommentLinkDetail } from "./comment-mentions";
import { mintedMention } from "./mention-registry";
import type { MentionData, MentionReviewComment } from "./mentions";

/** The longest comment a chip carries, as a cite's note is capped. */
export const REVIEW_TEXT_MAX_CHARS = 2000;
/** The most of the quoted lines a chip carries: the lines point the agent at
 *  the place, and it can read the file for more. A large paste's limit. */
export const REVIEW_DIFF_MAX_CHARS = 4000;

/** The window event that takes a review comment's chip back out of a
 *  session's composer (its annotation's delete). */
export const REVIEW_UNLINK_EVENT = "atlas:chat-unlink-review-comment";

export interface ReviewUnlinkDetail {
  tabId: string;
  id: string;
}

/** A fresh id: short, since it is visible in the prompt (`@review:<id>`). */
export function newReviewCommentId(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** A comment and its quote, capped, so every chip that exists is in budget. */
export function capReviewComment(mention: MentionReviewComment): MentionReviewComment {
  const diff =
    mention.diff.length > REVIEW_DIFF_MAX_CHARS
      ? `${cutText(mention.diff, REVIEW_DIFF_MAX_CHARS - 1)}…`
      : mention.diff;
  return { ...mention, diff, text: cutText(mention.text.trim(), REVIEW_TEXT_MAX_CHARS).trim() };
}

/** A fence neither the quote nor the comment can close. */
export function fenceFor(...bodies: string[]): string {
  let longest = 0;
  for (const body of bodies) {
    for (const run of body.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  }
  return "`".repeat(Math.max(3, longest + 1));
}

/** The comment as plain text: where it is, the quoted lines, then what the
 *  user wrote. Mirrors the block `compose_prompt` writes. */
export function reviewCommentAsText(m: MentionReviewComment): string {
  const fence = fenceFor(m.diff, m.text);
  return [
    `Review comment (@review:${m.id}) on \`${m.filePath}\`, ${m.rangeLabel} (${m.sectionTitle}):`,
    `${fence}${m.fenceLanguage}`,
    m.diff.trimEnd(),
    fence,
    "Comment:",
    fence,
    m.text,
    fence,
  ].join("\n");
}

/** Each review comment written out after the prose, so a path that carries a
 *  string does not reduce it to a token nothing can resolve. */
export function withReviewCommentsInline(text: string, mentions: readonly MentionData[]): string {
  const comments = mentions.filter((m): m is MentionReviewComment => m.kind === "review_comment");
  if (comments.length === 0) return text;
  return [text, ...comments.map(reviewCommentAsText)].join("\n\n");
}

const TOKEN_RE = /(?<![\w/])@review:([A-Za-z0-9_-]+)/g;

/** The review comment ids a draft holds, in order, joined by a space: a
 *  string, so a selector over it re-renders only when the set changes. */
export function reviewCommentIdsIn(draft: string | undefined): string {
  if (!draft || !draft.includes("@review:")) return "";
  const ids: string[] = [];
  for (const match of draft.matchAll(TOKEN_RE)) {
    if (!ids.includes(match[1])) ids.push(match[1]);
  }
  return ids.join(" ");
}

const NONE: readonly MentionReviewComment[] = [];

/**
 * The review comments in a session tab's composer draft, as the registry
 * minted them. One subscription per surface, and it re-renders that surface
 * only when the set of comments changes, never per keystroke. The draft
 * mirror is debounced (`useComposerDraft`); the link and unlink paths flush
 * it, so a comment shows the moment it is added or removed from here.
 */
export function useComposerReviewComments(tabId: string | null): readonly MentionReviewComment[] {
  const ids = useChatStore((s) => (tabId ? reviewCommentIdsIn(s.drafts[tabId]) : ""));
  return useMemo(() => {
    if (!ids) return NONE;
    return ids.split(" ").flatMap((id) => {
      const mention = mintedMention("review_comment", id);
      return mention ? [mention] : [];
    });
  }, [ids]);
}

/**
 * Put a review comment's chip in the composer of `tabId`. True when a
 * composer took it: one that is disabled or not mounted does not mark the
 * event handled, and the caller keeps the comment's box open.
 */
export function linkReviewCommentToComposer(tabId: string, mention: MentionReviewComment): boolean {
  const event = new CustomEvent<CommentLinkDetail>(COMMENT_LINK_EVENT, {
    detail: { tabId, mention: capReviewComment(mention) },
    cancelable: true,
  });
  return !window.dispatchEvent(event);
}

/**
 * Take a review comment's chip out of the composer of `tabId`. A composer
 * that is not mounted cannot, so its draft loses the token instead.
 */
export function unlinkReviewComment(tabId: string, id: string): void {
  const event = new CustomEvent<ReviewUnlinkDetail>(REVIEW_UNLINK_EVENT, {
    detail: { tabId, id },
    cancelable: true,
  });
  if (!window.dispatchEvent(event)) return;
  const chat = useChatStore.getState();
  const draft = chat.drafts[tabId];
  if (!draft) return;
  const token = new RegExp(`(?<![\\w/])@review:${id}(?![A-Za-z0-9_-]) ?`, "g");
  chat.actions.setDraft(tabId, draft.replace(token, ""));
}

/** The session tab whose agent session is `acpSessionId`, re-read as sessions
 *  bind. The diff beside a session knows the agent's session id; the
 *  composer is keyed by its tab. */
export function useChatTabOfSession(acpSessionId: string | null): string | null {
  return useChatStore((s) => {
    if (!acpSessionId) return null;
    for (const [tabId, session] of Object.entries(s.sessions)) {
      if (session.acpSessionId === acpSessionId) return tabId;
    }
    return null;
  });
}
