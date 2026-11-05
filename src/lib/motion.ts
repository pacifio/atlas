/**
 * The motion vocabulary, as constants `motion` can take directly.
 *
 * These numbers are what make the chrome feel like one object rather than a
 * set of components that each picked their own curve. They are the Standards
 * design system's values verbatim, so a surface ported from the web moves the
 * way its original does.
 *
 *   SPRING_RAIL       a rail changing width, a dock opening
 *   SPRING_INDICATOR  a segmented pill or underline sliding between options
 *   SPRING_PILL       an active row sliding between destinations
 *   EASE_PANEL        a panel entering; the CSS `--ease-out-strong` as an array
 *
 * Springs, layout and presence belong to `motion`. Hover and state colour
 * transitions, Base UI `data-open` keyframes and ScrollFade stay in CSS —
 * the same split Standards uses.
 */

export const SPRING_RAIL = { type: "spring", stiffness: 420, damping: 40 } as const;
export const SPRING_DOCK = { type: "spring", stiffness: 380, damping: 40 } as const;
export const SPRING_INDICATOR = { type: "spring", stiffness: 520, damping: 38 } as const;
export const SPRING_PILL = { type: "spring", stiffness: 560, damping: 42 } as const;

/** The panel ease, matching `--ease-out-strong` in `globals.css`. */
export const EASE_PANEL = [0.22, 1, 0.36, 1] as const;
