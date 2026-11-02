import { withCitesInline } from "./cited-text";
import type { MentionData } from "./mentions";
import { withPastesInline } from "./pasted-text";
import { withReviewCommentsInline } from "./review-comments";

/** A queued prompt's text with its pastes', cites' and review comments' text
 *  written in: the queue holds strings, so a bare `@paste:<id>` would reach
 *  the agent with nothing behind it. Appends — call it once per prompt. */
export function inlineQueuedText(text: string, mentions: readonly MentionData[]): string {
  return withReviewCommentsInline(
    withCitesInline(withPastesInline(text, mentions), mentions),
    mentions,
  );
}
