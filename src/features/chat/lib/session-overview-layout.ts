// How much of the session Details card shows, by the height it has.
//
// The card is one of two forms (docked beside the transcript, or a popover
// under its title-bar button; see `session-details-store.ts`), and in both it
// is capped at the height above the composer. Rather than scroll the moment
// it outgrows that, it first sheds what matters least, in steps:
//
//   full       every section, the Session section with its project rows
//   compact    drops the Projects section and the Session section's project
//              rows; keeps the workspace, version control and actions
//   essential  the session's own record only: changes, lineage, memory
//
// Each step's natural height is measured while it is showing, and the fullest
// step that fits is chosen. A step not yet measured counts as fitting, so the
// card starts full and only steps down once it has seen it does not fit. What
// still does not fit at `essential` scrolls inside the card.

export type OverviewDensity = "full" | "compact" | "essential";

/** The gap between the card and the edges it sits against. */
export const OVERVIEW_CARD_GAP = 12;

/** The measured natural heights of the two steps that can overflow. `0` is
 *  "not measured yet". */
export interface OverviewHeights {
  full: number;
  compact: number;
}

export const UNMEASURED: OverviewHeights = Object.freeze({ full: 0, compact: 0 });

/** The fullest step whose measured height fits `height`. */
export function resolveOverviewDensity(height: number, content: OverviewHeights): OverviewDensity {
  if (content.full === 0 || content.full <= height) return "full";
  if (content.compact === 0 || content.compact <= height) return "compact";
  return "essential";
}
