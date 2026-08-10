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
// `-webkit-line-clamp` the bubble renders and with the "is this long enough to
// need a Show more" test.

export const M = {
  /** Lines a user prompt shows before clamping behind "Show more". */
  userMaxLines: 12,
  /** Line height (px) of a user bubble, and the unit its clamp is measured in.
   *  Must agree with `.atlas-prose--user` in `globals.css` — the clamp is a
   *  `max-height`, so a stylesheet-only change would silently cut a partial
   *  line. */
  userLineHeight: 22,
} as const;
