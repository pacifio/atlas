/**
 * The colours the two pixi force graphs draw with, resolved from the theme.
 *
 * `knowledge-graph.tsx` and `memory-graph-canvas.tsx` are deliberately separate
 * scene engines (see the note at the top of the memory one) — this is the one
 * thing they do share, because they are the same picture of the same kind of
 * data and a theme author would have to set two identical palettes otherwise.
 *
 * Everything here is RESOLVED (decision 14): pixi's `Graphics.fill({ color })`
 * takes a 24-bit integer and `TextStyle.fill` goes into a WebGL text atlas, so
 * neither can be handed a `var(--…)`. That is also why a graph has to repaint
 * itself on a theme switch rather than getting it for free: call
 * `graphPalette()` again from an `onThemeApplied` subscription and invalidate
 * whatever the render loop memoises on.
 *
 * Labels are kept as CSS colour strings (pixi's `TextStyle.fill` wants one)
 * while the shapes are integers, which is why each has both forms.
 */
import { themeBase, themeColor } from "@/features/theme/theme-values";
import { hexOf } from "@tryatlas/design/theme";

export interface GraphPalette {
  /** Focused node, its neighbours, and the highlighted label. */
  primary: number;
  /** Resting node and label. */
  secondary: number;
  /** Dimmed node and label when something else has focus. */
  muted: number;
  edgeDefault: number;
  edgeSelected: number;
  edgeDim: number;
  /** An explicit link rather than a similarity edge (memory graph only). */
  edgeLink: number;
  /** "Influenced this" — upstream in time (memory graph only). */
  ancestor: number;
  labelPrimary: string;
  labelSecondary: string;
  labelMuted: string;
}

export function graphPalette(): GraphPalette {
  const primary = themeBase("foreground");
  const secondary = themeBase("secondary-foreground");
  const muted = themeBase("muted-foreground");
  return {
    primary: hexOf(primary),
    secondary: hexOf(secondary),
    muted: hexOf(muted),
    // Edges read as structure, not as content, so they come off the border
    // ramp: `strong` at rest, `default` once dimmed, `muted` text for a link
    // edge that has to out-read an ordinary one.
    edgeDefault: hexOf(themeColor("border.strong")),
    edgeSelected: hexOf(secondary),
    edgeDim: hexOf(themeBase("border")),
    edgeLink: hexOf(muted),
    ancestor: hexOf(themeColor("status.info.foreground")),
    labelPrimary: primary,
    labelSecondary: secondary,
    labelMuted: muted,
  };
}
