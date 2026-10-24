// Reactions on a pull request or one of its comments: their order, glyphs,
// tooltip wording, and the optimistic overlay a press shows before GitHub
// answers.

import type { PrReaction, PrReactionContent } from "./pull-requests-types";

export const REACTION_ORDER: readonly PrReactionContent[] = [
  "thumbs-up",
  "thumbs-down",
  "laugh",
  "hooray",
  "confused",
  "heart",
  "rocket",
  "eyes",
];

const EMOJI: Record<PrReactionContent, string> = {
  "thumbs-up": "👍",
  "thumbs-down": "👎",
  laugh: "😄",
  hooray: "🎉",
  confused: "😕",
  heart: "❤️",
  rocket: "🚀",
  eyes: "👀",
};

const NAME: Record<PrReactionContent, string> = {
  "thumbs-up": "thumbs up",
  "thumbs-down": "thumbs down",
  laugh: "laugh",
  hooray: "hooray",
  confused: "confused",
  heart: "heart",
  rocket: "rocket",
  eyes: "eyes",
};

export function reactionEmoji(content: PrReactionContent): string {
  return EMOJI[content];
}

export function reactionName(content: PrReactionContent): string {
  return NAME[content];
}

const NAMED_ACTOR_LIMIT = 3;

function joinNames(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/** "You, ines-p and 2 others reacted with rocket emoji". The viewer reads as
 *  "You" and comes first; `actors` leaves the viewer out, so there is room
 *  for "You" only when `actors` does not already account for everyone. */
export function reactionTooltip(reaction: PrReaction): string {
  const viewerHasRoom = reaction.actors.length < reaction.count;
  const names =
    reaction.viewerHasReacted && viewerHasRoom ? ["You", ...reaction.actors] : [...reaction.actors];
  const shown = names.slice(0, Math.min(NAMED_ACTOR_LIMIT, reaction.count));
  const others = Math.max(0, reaction.count - shown.length);
  const rest =
    others > 0
      ? [
          shown.length > 0
            ? `${others} ${others === 1 ? "other" : "others"}`
            : `${others} ${others === 1 ? "person" : "people"}`,
        ]
      : [];
  return `${joinNames([...shown, ...rest])} reacted with ${reactionName(reaction.content)} emoji`;
}

/** The reactions as they will be once the pending presses land. */
export function applyPendingReactions(
  reactions: readonly PrReaction[],
  pending: ReadonlyMap<PrReactionContent, boolean>,
): PrReaction[] {
  if (pending.size === 0) return [...reactions];
  const byContent = new Map(reactions.map((reaction) => [reaction.content, reaction] as const));
  for (const [content, reacted] of pending) {
    const current = byContent.get(content);
    if (current === undefined) {
      if (reacted)
        byContent.set(content, { content, count: 1, actors: [], viewerHasReacted: true });
      continue;
    }
    if (current.viewerHasReacted === reacted) continue;
    const count = current.count + (reacted ? 1 : -1);
    if (count <= 0) byContent.delete(content);
    else byContent.set(content, { ...current, count, viewerHasReacted: reacted });
  }
  return REACTION_ORDER.flatMap((content) => byContent.get(content) ?? []);
}
