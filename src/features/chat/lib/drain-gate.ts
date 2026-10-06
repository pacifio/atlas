/**
 * When the chat panel may hand the next parked message to `handleSend`.
 *
 * The panel's drain effect fires on every status / binding change and used
 * to treat any `running → not running` edge as "the turn ended, send the
 * next queued message". A bind that FAILS produces that same edge: the first
 * message is held as `pendingSend` with the status `running` ("Starting …"),
 * and the failure branch parks it back in the queue and drops the status to
 * `idle`. The drain then shifted it straight back out, `handleSend` saw an
 * unbound tab and re-held it (recording a second user bubble), kicked the
 * bind again, which failed again in ~10 ms — 491 connect attempts, a bubble
 * and an error toast per cycle, until Stop (2026-09-14, engine start
 * refused while the machine had no DNS).
 *
 * The rule this encodes: a queue only drains INTO A BOUND SESSION. A turn
 * can only have finished on one, and a message dispatched into an unbound
 * tab is the loop. The bind's own success (`justBound`) and the resume
 * path's falling edge (`justResumed`) are the other two legitimate moments,
 * both of which carry a session id by definition.
 *
 * And nothing drains while the gate is closed: a resume still loading, or one
 * that could not restore the user's mode (`curResuming`), or a session another
 * process is writing that the user has not said "Send anyway" to
 * (`curHeldElsewhere`, ADR-0001 amendment Rule 7). The gate's falling edge —
 * either cause clearing — is the release.
 */
export interface DrainEdgeInput {
  prevStatus: string | null;
  curStatus: string;
  prevAcp: string | undefined;
  curAcp: string | undefined;
  /** The send gate: resume pending, or a mode the resume could not restore. */
  prevResuming: boolean;
  curResuming: boolean;
  /** Live elsewhere and not overridden: sending would fork the session. */
  prevHeldElsewhere?: boolean;
  curHeldElsewhere?: boolean;
}

export interface DrainEdge {
  /** The binding just landed: the held first message goes out ahead of the queue. */
  justBound: boolean;
  /** The gate just opened on a bound session: an optimistic resume became
   *  sendable, a restored mode was picked, or a live-elsewhere hold lifted. */
  justResumed: boolean;
  /** A real turn ended on a bound session. */
  turnFinished: boolean;
  /** Whether the queue may shift its head into `handleSend` on this edge. */
  drainQueue: boolean;
}

export function drainEdge(input: DrainEdgeInput): DrainEdge {
  const { prevStatus, curStatus, prevAcp, curAcp } = input;
  const prevGated = input.prevResuming || !!input.prevHeldElsewhere;
  const curGated = input.curResuming || !!input.curHeldElsewhere;
  const justBound = !prevAcp && !!curAcp && !curGated;
  const justResumed = prevGated && !curGated && !!curAcp;
  // `curAcp` is the gate: with no session there is nothing a turn could
  // have finished on, and nothing the next message could go to.
  const turnFinished = prevStatus === "running" && curStatus !== "running" && !!curAcp && !curGated;
  return {
    justBound,
    justResumed,
    turnFinished,
    drainQueue: turnFinished || justBound || justResumed,
  };
}
