// Shared numeric constants for transcript rows.
//
// This is what survives of the deterministic-height experiment. The transcript
// briefly predicted every row's height before layout so it could be virtualized;
// that lost to a plain windowed list (see the header of `transcript.tsx`), and
// with it went the height function, the canvas text measurement, and the dev
// drift assertion. Rows are real DOM now and the browser owns their size.
//
// What is left is the handful of numbers the components genuinely share with the
// stylesheet — currently just the user-bubble clamp, which has to agree with the
// `max-height` budget `useWholeLineClamp` (in `transcript-rows.tsx`) snaps to
// whole lines and with the "is this long enough to need a Show more" test.

/**
 * The turn rail shows at rest in a left gutter at least this wide; a narrower
 * one shows it only while hovered (`turn-rail.ts`). Here so the session
 * context dock (`context-dock.ts`), which slides the column left to clear its
 * card, can stop short of this gutter without importing the rail's chunk.
 */
export const TURN_RAIL_PERSISTENT_GUTTER = 48;

/**
 * The conversation's content frame: centred, `chatWidth` at most (760px unless
 * the user widened it, `--atlas-chat-column` in globals.css), padded the same on
 * both sides.
 *
 * Shared because the composer stack has to line up with the transcript text at
 * every width, not just the wide one. It used to be `px-4` around a 720px box,
 * which coincides with this frame only when the column is at least 760px wide;
 * a docked card's room (or a narrow window or split) put the composer's
 * left edge 7px outside the text above it. One string now frames the rows, the
 * composer, the cards tucked above it and the banners over it.
 */
export const CONTENT_COLUMN = "mx-auto w-full max-w-(--atlas-chat-column) px-6";

export const M = {
  /** Lines a user prompt shows before clamping behind "Show more". */
  userMaxLines: 12,
  /** Line height (px) of a user bubble, and the unit its clamp is measured in.
   *  Must agree with `.atlas-prose--user` in `globals.css` — the clamp is a
   *  `max-height`, so a stylesheet-only change would silently cut a partial
   *  line. */
  userLineHeight: 22,
} as const;
