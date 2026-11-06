// Vertical insets shared by the transcript's view and its window hook.

/** How far the header's blur band ramps BELOW the bar. Content must clear this
 *  too, or the first message renders permanently blurred. */
export const TOP_BLUR_RAMP = 34;

/** Without a header over it (the session's own view: its controls are in the
 *  title bar), only a short soft edge where rows scroll out under the bar. */
export const TOP_EDGE_RAMP = 16;

/** Breathing room between the last row and the composer. Applied as content
 *  padding rather than a spacer element so it scrolls with the thread and the
 *  bottom fade still has live content to dissolve into. */
export const BOTTOM_GAP = 28;
