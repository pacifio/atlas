/**
 * "Is the reader actively scrolling the transcript right now?" — the scroll
 * sibling of `isTypingHot()` (chat-input-idle-lag lesson: gate heavy work on
 * input activity).
 *
 * Consumer: the agent-delta rAF flush in App.tsx. Applying a streaming batch
 * re-renders ChatPanel → Transcript → a reconcile over every mounted row, and
 * when that lands in the middle of a momentum-scroll frame WKWebView misses
 * its tile deadline — the viewport shows unpainted (black) stretches. Holding
 * the flush for the few hundred ms of an active fling keeps scroll frames
 * clean; the buffer keeps accumulating and lands the moment the gesture goes
 * quiet (bounded by the flush's own max-hold, so a continuous scroll can
 * never starve the stream indefinitely).
 */
let hotUntil = 0;

/** Call from scroll handlers (cheap; monotonic clock, no allocation). */
export function markScrollHot(ms = 160): void {
  const until = performance.now() + ms;
  if (until > hotUntil) hotUntil = until;
}

export function isScrollHot(): boolean {
  return performance.now() < hotUntil;
}
