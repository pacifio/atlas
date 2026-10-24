// What the transcript and the composer say about a turn something cut into.
//
// Pure, so the wording is tested without rendering a row. The row says what
// happened and what it means for the reply, in that order, and stops: the
// agent's own error is a detail, folded behind the row, never the headline —
// after a sleep it is "error decoding response body", which names nothing the
// user did.

import type { TurnInterruption } from "@/types/agent";

/** "45s", "21m", "1h", "1h 3m" — a sleep is told in the unit a person would
 *  use; "21m 14s" reads as a stopwatch. */
export function formatSlept(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
}

/** The row's one line. */
export function interruptionHeadline(x: TurnInterruption): string {
  const slept = `Your computer slept for ${formatSlept(x.sleptSecs)}`;
  switch (x.outcome) {
    case "finished":
      return `${slept} during this reply — it may be incomplete.`;
    case "stopped":
      return `${slept} during this reply before it was stopped.`;
    case "failed":
      return `${slept} and the reply was cut off.`;
    case "disconnected":
      return `${slept} and the agent exited before finishing.`;
  }
}

/** The composer pill while the turn is still going after the wake. */
export function wokePillLabel(sleptSecs: number): string {
  return `Woke after ${formatSlept(sleptSecs)}`;
}

/** What Continue sends. In the user's voice, since it goes out as their
 *  message, and it names why, so the agent resumes rather than restarts. */
export const CONTINUE_AFTER_SLEEP =
  "Please continue — my computer went to sleep and your last reply may have been cut off.";
