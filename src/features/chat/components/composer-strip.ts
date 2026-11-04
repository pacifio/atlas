/**
 * The strip tucked into the top of the chat composer — one construction for
 * every notice that explains the composer's state (no AI grant, agent
 * removed…), so they all read as part of the composer rather than as a stray
 * banner floating above it.
 *
 * Same construction as the artifacts composer's checkpoint scope picker:
 * inset by `mx-2` so the composer's box reads as the wider element,
 * `rounded-t-2xl` to match the agent composer's rounding, and `-mb-3.5`
 * against `pb-5` so the composer overlaps its lower half. `z-0` keeps it
 * behind — the composer carries `relative z-30`.
 */
export const COMPOSER_STRIP =
  "atlas-pill-in relative z-0 mx-2 -mb-3.5 flex items-center justify-between gap-3 " +
  "rounded-t-2xl bg-popover px-3.5 pt-1.5 pb-5 text-xs";

/** A text action on the strip's right: quiet until hovered. */
export const COMPOSER_STRIP_ACTION =
  "flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 transition-colors " +
  "text-secondary-foreground hover:bg-element-hover hover:text-foreground " +
  "disabled:cursor-default disabled:text-muted-foreground/40 disabled:hover:bg-transparent";
