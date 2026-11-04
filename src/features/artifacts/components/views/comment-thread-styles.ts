// The comment thread's shared measurements, so its blocks, rows and
// composers cannot drift apart.

/**
 * Rules and dividers, pulled 30% toward the surface behind them.
 *
 * `--border-strong` at full strength reads as structure competing with
 * the text; `--border` disappeared against the translucent panel entirely. The
 * same mix the Timeline nav uses for its rail, and for the same reason: a line
 * that only has to say "these are separate" should not be the loudest thing in
 * the popover.
 */
export const RULE = "color-mix(in srgb, var(--border-strong) 70%, var(--background))";

/** Diameter of every face in the thread — comments and both composers. */
export const AVATAR_PX = 18;
/** Gap between a face and the text beside it. */
export const AVATAR_GAP = 6;
/**
 * Padding shared by the thread blocks and the footer.
 *
 * From constants rather than classes so the two cannot drift: the footer used
 * `BLOCK_PAD_X` on all four sides and ended up visibly roomier than the blocks
 * above it.
 */
export const BLOCK_PAD_X = 10;
export const BLOCK_PAD_Y = 8;
/**
 * Where a reply sits.
 *
 * Aligned with the parent's *text*, not inset by an arbitrary amount — that
 * alignment is what says "this hangs off the comment above" now that there is
 * no rail drawing the connection.
 */
export const REPLY_INDENT = AVATAR_PX + AVATAR_GAP;
