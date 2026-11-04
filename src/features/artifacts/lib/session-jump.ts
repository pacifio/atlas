/**
 * The event that moves a Session's timeline to an entry or a commit.
 *
 * A source chip in the Session chat fires it and the detail listens and jumps
 * — an event rather than a prop so the chat needs no handle on the detail's
 * internals, and a citation rendered anywhere works the same way. A window
 * `CustomEvent`, TS to TS, so `event-contract` does not see it.
 */
export const JUMP_EVENT = "atlas:session-chat-jump";

export interface JumpDetail {
  entryId?: string;
  commitSha?: string;
}

/** The one place this event is dispatched. */
export function jumpTo(detail: JumpDetail): void {
  window.dispatchEvent(new CustomEvent<JumpDetail>(JUMP_EVENT, { detail }));
}
