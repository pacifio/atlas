/**
 * The session status glyph.
 *
 * Circles, because a status dot is a circle everywhere else a person has seen
 * one — and one thing that is not a circle: a running session is a
 * `ThinkingOrb`, a dotted sphere in constant motion. "Running" is the only
 * state where something is actually happening, so it is the only one that
 * moves; everything at rest is a still dot.
 *
 *   attention  a hollow ring in the error ink — it stopped and wants you
 *   live       the `composing` orb — work in progress
 *   imported   a hollow ring in muted ink — read in, never run here
 *   done       a solid dot in muted ink — history, and it should recede
 *
 * The orb is monochrome, follows the theme on its own, and renders a still
 * frame under `prefers-reduced-motion`. It is drawn at its 20px preset and
 * fitted to the 14px glyph box, so its dots are thickened to keep the same
 * weight as the solid dots beside them.
 */

import { ThinkingOrb } from "thinking-orbs";
import { cn } from "@/lib/utils";
import type { SessionState } from "../lib/board";

/** What each state is called, for the glyph's accessible name and tooltips. */
export const STATE_LABEL: Record<SessionState, string> = {
  attention: "Needs attention",
  live: "Running",
  imported: "Imported",
  done: "Done",
};

const TONE: Record<SessionState, string> = {
  attention: "text-error",
  live: "text-foreground",
  imported: "text-muted-foreground",
  done: "text-muted-foreground",
};

/** The hollow states — nothing ran here, or it stopped short. */
const HOLLOW: Record<SessionState, boolean> = {
  attention: true,
  live: false,
  imported: true,
  done: false,
};

export function SessionStatusIcon({
  state,
  className,
}: {
  state: SessionState;
  className?: string;
}) {
  if (state === "live") {
    return (
      <span
        data-slot="status-icon"
        data-status={state}
        role="img"
        aria-label={STATE_LABEL[state]}
        className={cn("inline-block size-3.5 shrink-0", className)}
      >
        <ThinkingOrb
          state="composing"
          size={20}
          dotSize={1.4}
          aria-hidden
          style={{ width: "100%", height: "100%" }}
        />
      </span>
    );
  }

  return (
    <svg
      data-slot="status-icon"
      data-status={state}
      viewBox="0 0 14 14"
      width="14"
      height="14"
      fill="none"
      role="img"
      aria-label={STATE_LABEL[state]}
      className={cn("size-3.5 shrink-0", TONE[state], className)}
    >
      {HOLLOW[state] ? (
        <circle cx="7" cy="7" r="3.75" stroke="currentColor" strokeWidth="1.5" />
      ) : (
        <circle cx="7" cy="7" r="4.25" fill="currentColor" />
      )}
    </svg>
  );
}
