/**
 * The reader's footer pills.
 *
 * Every action on the open Session sits at its foot, in two capsules: hand it
 * on (share, export) and narrow it (filter) on the left, talk about it (ask,
 * comments) on the right. The sidebar's foot is the model (`app-sidebar.tsx`):
 * one `glass-rim` capsule per set, round ghost buttons inside it, no dividers.
 * They used to be split between a dock in the reader's header and two loose
 * round buttons down here, so the tab's actions lived in two places.
 *
 * The share and comments morphs sit IN a pill: their closed box is one of
 * these buttons, and the panel grows out of it over the pill (`inPill` on
 * each morph).
 */

import { HintGroup } from "@/ui/hint-group";

/** A button inside a {@link FooterPill}: the sidebar foot's `size-7` round
 *  ghost target. `data-popup-open` keeps a popover's trigger lit while open. */
export const PILL_BUTTON =
  "relative flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground outline-none " +
  "transition-colors duration-fast ease-out-strong hover:bg-element-hover hover:text-foreground focus-visible:bg-element-hover " +
  "disabled:cursor-default disabled:opacity-40 data-popup-open:bg-element-hover data-popup-open:text-foreground";

/** Applied on top of {@link PILL_BUTTON} while the control's mode is on. */
export const PILL_BUTTON_ACTIVE = "bg-element-active text-foreground hover:bg-element-active";

/** The glyph size inside a pill button — the sidebar foot's `md` icon. */
export const PILL_ICON = 14;

export function FooterPill({ children }: { children: React.ReactNode }) {
  return (
    // Tooltips above: the pills sit on the reader's bottom edge.
    <HintGroup side="top">
      <div className="glass-rim flex items-center gap-0.5 rounded-full p-0.5">{children}</div>
    </HintGroup>
  );
}
