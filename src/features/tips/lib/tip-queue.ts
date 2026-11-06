// Which tip, if any, should appear now. Pure: the tips host gathers the
// world (what's queued, what's seen, whether the user is busy, which anchors
// are on screen) and asks; the rules all live here so they can be tested.
//
// The rules, from ATL-989:
// - one tip at a time (the host only asks while none is showing);
// - at least TIP_GAP_MS between tips;
// - held while the user is busy (a turn streaming, text being typed) or the
//   window is not focused;
// - only while the tip's anchor is on screen — a tip never floats free;
// - moment tips go ahead of surface tips; otherwise first asked, first shown;
// - someone who upgraded gets moment tips only.
//
// A tip asked for by name (Show tip…) is the user's explicit request, so it
// skips the pacing, the busy hold, the seen check and the off switch. It
// still needs its anchor and a focused window, since there is nowhere to put
// it otherwise.

import type { TipDef } from "./tip-registry";
import type { TipCohort } from "./tips-api";

export const TIP_GAP_MS = 3 * 60_000;

export interface QueueInput {
  /** Requested tip ids, oldest first. */
  queue: readonly string[];
  /** A tip asked for by name, if any. */
  forced: string | null;
  seen: ReadonlySet<string>;
  cohort: TipCohort;
  /** The Show tips setting. */
  enabled: boolean;
  now: number;
  /** When the last tip appeared, in this window's clock. */
  lastShownAt: number | null;
  busy: boolean;
  focused: boolean;
  anchorVisible: (anchor: string) => boolean;
}

export function pickNextTip(
  input: QueueInput,
  registry: Readonly<Record<string, TipDef>>,
): string | null {
  if (!input.focused) return null;

  // Until its anchor is on screen, a tip asked for by name waits without
  // holding up the rest of the queue.
  const forced = input.forced ? registry[input.forced] : undefined;
  if (forced && input.anchorVisible(forced.anchor)) return forced.id;

  if (!input.enabled || input.busy) return null;
  if (input.lastShownAt !== null && input.now - input.lastShownAt < TIP_GAP_MS) return null;

  const eligible = input.queue
    .map((id) => registry[id])
    .filter((t): t is TipDef => t !== undefined)
    .filter((t) => !input.seen.has(t.id))
    .filter((t) => t.kind === "moment" || input.cohort === "fresh")
    .filter((t) => input.anchorVisible(t.anchor));

  const moment = eligible.find((t) => t.kind === "moment");
  return (moment ?? eligible[0])?.id ?? null;
}
