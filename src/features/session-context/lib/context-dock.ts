// Where the docked session Details card goes, and the room the transcript
// leaves for it.
//
// `resolveContextDock` answers, from the panel's width alone, the room the
// transcript must leave when the card is docked open. The chat panel applies
// it only while the card IS open: closed, the column centres in the whole
// panel (an empty lane on the right read as broken), and opening the card
// slides the column over to clear it. The card itself is drawn into that
// room as an absolutely positioned layer.
//
// The reservation: the column stays centred while its right edge clears the
// card; where it would not, it slides left, and only once it has slid as far
// as the turn rail's gutter does it narrow. On a wide panel that is no change
// at all — the centred column already ends short of the card. The gutter is
// kept because the rail hangs in the space left of the column, and a column
// slid flush to the panel's edge would leave it nowhere to show. A panel too
// narrow to keep a readable column between the gutter and the card does not
// dock: the card is a popover over the transcript there, which reserves
// nothing either.

import { TURN_RAIL_PERSISTENT_GUTTER } from "@/features/chat/lib/row-metrics";

/** The card's width (the popover's width too). */
export const CONTEXT_CARD_WIDTH = 300;
/** The gap between the card and the panel's edges. */
export const CONTEXT_CARD_GAP = 20;
/** Clear space between the transcript column and the card. Smaller than the
 *  edge gap was, so the card sits evenly between the two rather than hard
 *  against the window's edge. */
export const CONTEXT_CARD_CLEARANCE = 16;
/** Below this the column beside the card is too narrow to read; no dock. */
export const MIN_DOCKED_COLUMN = 560;
/** How far left the column may slide: it stops at the turn rail's gutter. */
export const CONTEXT_DOCK_LEFT_INSET = TURN_RAIL_PERSISTENT_GUTTER;

/** What a panel `width` px wide reserves on the right of its centred row. */
export const CONTEXT_DOCK_RESERVE = CONTEXT_CARD_WIDTH + CONTEXT_CARD_GAP + CONTEXT_CARD_CLEARANCE;

export interface ContextDock {
  /** Whether the card docks inline here, or falls back to the popover. */
  docked: boolean;
  /**
   * Right-hand room to give the centred transcript row and composer stack
   * (as padding / margin), so the column centred in what is left ends clear
   * of the card. `0` when the centred column already clears it, and when the
   * panel does not dock.
   */
  reserve: number;
  /**
   * Left-hand room, given the same way, once the column has to narrow: the
   * gutter it keeps for the turn rail. A column below its maximum width fills
   * whatever box it is centred in, so without this it would start flush at
   * the panel's edge. `0` while the column is at full width (centring places
   * it) and when the panel does not dock.
   */
  inset: number;
}

const NO_DOCK: ContextDock = { docked: false, reserve: 0, inset: 0 };

/**
 * The dock for a panel `width` px wide whose column is at most `columnMax`
 * px (`--atlas-chat-column`; `Infinity` for a full-width column).
 */
export function resolveContextDock(width: number, columnMax: number): ContextDock {
  if (!(width > 0)) return NO_DOCK;
  // Where the column must end, clear of the card.
  const room = width - CONTEXT_DOCK_RESERVE;
  // The gutter left of the column without the dock, kept up to the rail's
  // width. A full-width column has none, and is not given one.
  const undockedGutter = Math.max(0, (width - Math.min(columnMax, width)) / 2);
  const minLeft = Math.min(CONTEXT_DOCK_LEFT_INSET, undockedGutter);
  const widest = room - minLeft;
  if (widest < MIN_DOCKED_COLUMN) return NO_DOCK;
  if (columnMax <= widest) {
    // Full width: centred, or slid left until it clears the card. It never
    // reaches the gutter here, since `columnMax` fits between it and `room`.
    const left = Math.min((width - columnMax) / 2, room - columnMax);
    // Centred in `width - reserve`, a column `columnMax` wide starts at `left`.
    return {
      docked: true,
      reserve: Math.max(0, Math.round(width - 2 * left - columnMax)),
      inset: 0,
    };
  }
  // Narrowed: the column fills the box between the gutter and the card.
  return { docked: true, reserve: Math.round(width - room), inset: Math.round(minLeft) };
}

/** `--atlas-chat-column` as px: `760px` → 760; `100%` (or unset) → Infinity. */
export function parseColumnMax(value: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)px\s*$/.exec(value);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}
