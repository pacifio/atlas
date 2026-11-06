// The slot above the composer where an agent's question or permission card
// appears, and the way it arrives.
//
// It unrolls from behind the composer rather than appearing: the height grows
// from nothing while the card itself slides up the last few pixels, so the
// composer looks like the edge the card came out from. That reading is the
// whole point of putting it here instead of in a dialog — the question is part
// of the conversation, not an interruption to it, and a card that simply
// appeared at full height read as a modal without a scrim.
//
// `AnimatePresence` lives HERE, above the card, so the caller can hand it
// `null` and still get the card animated out. A caller that unmounts the
// drawer itself gets no exit — that is why both callers keep it mounted and
// change its child instead.

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { EASE_PANEL } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { CONTENT_COLUMN } from "../lib/row-metrics";

/** Long enough to read as an object moving, short enough not to delay an
 *  answer. Matches the panel timings the rest of the chrome uses. */
const OPEN_S = 0.26;
const CLOSE_S = 0.18;

/**
 * How far the drawer tucks under the composer.
 *
 * The composer holds the card off with two insets of its own, both in
 * `message-input.tsx`: the wrapper's `pt-2` (0.5rem) and the input's `m-1`
 * (0.25rem). Those 0.75rem are transparent, so they showed as a black band
 * between the card and the composer. 1rem clears them and leaves a 0.25rem
 * tuck — the composer paints after the card and is opaque, so the tucked strip
 * is simply covered, and no arithmetic can leave a hairline behind.
 *
 * In `rem`, not `px`: the app renders at a user-set UI scale by changing the
 * root font size, which is what makes `pt-2` 6.5px on one machine and 8px on
 * another. A px constant here would hold on one of them only.
 *
 * It belongs to the element that CLIPS (`overflow-hidden`), not the one
 * inside it. On the inner element the margin shrank the height `motion`
 * measures for `height: "auto"`, so the clipper cut exactly the strip that was
 * supposed to do the tucking: the card lost its bottom row AND kept its gap.
 */
const TUCK_REM = -1;

export function ComposerDrawer({ children }: { children: React.ReactNode }) {
  const reduce = useReducedMotion() ?? false;

  return (
    // `overflow-hidden` is what makes it a drawer: the card is clipped to the
    // growing height, so it emerges from the composer's edge instead of
    // sliding over it.
    <AnimatePresence initial={false}>
      {children ? (
        <motion.div
          key="composer-drawer"
          // A stable hook for the animation test: the drawer's whole point is
          // the height it is mid-way through, which no text or class can name.
          data-composer-drawer
          // `marginBottom` travels WITH the height rather than being a static
          // class: at height 0 a constant tuck would hoist the composer by its
          // whole depth the instant the card mounted, and drop it again as the
          // card grew. Animated, the two move as one object.
          initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0, marginBottom: "0rem" }}
          animate={
            reduce ? { opacity: 1 } : { height: "auto", opacity: 1, marginBottom: `${TUCK_REM}rem` }
          }
          exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0, marginBottom: "0rem" }}
          transition={{
            duration: reduce ? 0 : OPEN_S,
            ease: EASE_PANEL,
            opacity: { duration: reduce ? 0 : CLOSE_S },
          }}
          className="overflow-hidden"
        >
          <motion.div
            // The second, shorter travel. The height alone grows the box; this
            // moves the card inside it, which is what sells "it came from
            // under the composer" rather than "the box got taller".
            initial={reduce ? false : { y: 10 }}
            animate={{ y: 0 }}
            exit={reduce ? undefined : { y: 10 }}
            transition={{ duration: reduce ? 0 : OPEN_S, ease: EASE_PANEL }}
            className={cn(CONTENT_COLUMN, "pt-2")}
          >
            {children}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
