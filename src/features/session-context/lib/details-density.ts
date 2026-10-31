// How much of the session Details card shows, by the height it has.
//
// The card is one of two forms (docked beside the transcript, or a popover
// under its title-bar button; see `session-details-store.ts`), and in both it
// is capped at the height above the composer. Rather than scroll the moment
// it outgrows that, it first sheds what matters least, in steps:
//
//   full       every row: the environment, Projects and Lineage included
//   compact    drops the environment row, Projects and Lineage; the Commit
//              row shows only while an action runs or has just landed
//   essential  also drops "Open in": the scripts and version control stay
//
// Each step's natural height is measured while it is showing, and the fullest
// step that fits is chosen. A step not yet measured counts as fitting, so the
// card starts full and only steps down once it has seen it does not fit. The
// pull request list is left out of the measure: opening "Show N more" must
// not take rows away. What still does not fit scrolls inside the card.

export type DetailsDensity = "full" | "compact" | "essential";

/** The gap between the card and the edges it sits against. */
export const DETAILS_CARD_GAP = 12;

/** The measured natural heights of the two steps that can overflow. `0` is
 *  "not measured yet". */
export interface DetailsHeights {
  full: number;
  compact: number;
}

export const UNMEASURED: DetailsHeights = Object.freeze({ full: 0, compact: 0 });

/** The fullest step whose measured height fits `height`. */
export function resolveDetailsDensity(height: number, content: DetailsHeights): DetailsDensity {
  if (content.full === 0 || content.full <= height) return "full";
  if (content.compact === 0 || content.compact <= height) return "compact";
  return "essential";
}
