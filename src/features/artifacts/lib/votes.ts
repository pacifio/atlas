// Votes on a comment: one per person, up or down. Clicking your own vote takes
// it back; clicking the other side switches it. A port of the web reader's
// `apps/web/src/lib/votes.ts`, so the two clients agree on every click.

import type { CommentVotes } from "./comments-api";

/** `1` up, `-1` down, `0` none. */
export type VoteValue = 1 | -1 | 0;

export const NO_VOTES: CommentVotes = { up: [], down: [] };

/** This person's vote on a comment. */
export function voteOf(votes: CommentVotes, who: string | null): VoteValue {
  if (who === null) return 0;
  if (votes.up.includes(who)) return 1;
  if (votes.down.includes(who)) return -1;
  return 0;
}

/** The vote a click on one side asks for: your current vote taken back,
 *  otherwise that side — which switches a vote the other way. */
export function nextVote(current: VoteValue, side: 1 | -1): VoteValue {
  return current === side ? 0 : side;
}

/** The votes with one person's set to `value`, as the server would store them:
 *  a switch joins the back of the other list. */
export function withVote(votes: CommentVotes, who: string, value: VoteValue): CommentVotes {
  const up = votes.up.filter((id) => id !== who);
  const down = votes.down.filter((id) => id !== who);
  if (value === 1) up.push(who);
  if (value === -1) down.push(who);
  return { up, down };
}
