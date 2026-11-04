/**
 * The gradient page covers a user picks from. These are document content,
 * like a highlighter colour, so they keep their own colours in every theme;
 * only the chrome around the picker is themed.
 *
 * The ids are persisted in `.atlas/knowledge/_meta.json` (`cover:
 * "gradient:dusk-1"`). Never change one: a renamed id is a page that loses its
 * cover.
 */
export const COVER_GRADIENTS = [
  {
    id: "gradient:slate-1",
    label: "Slate fade",
    css: "linear-gradient(135deg, #1f1f1f, #2a2a2a 60%, #161616)",
  },
  {
    id: "gradient:warm-1",
    label: "Warm ember",
    css: "linear-gradient(135deg, #2a1d18, #382318 60%, #1d1411)",
  },
  {
    id: "gradient:moss-1",
    label: "Moss",
    css: "linear-gradient(135deg, #1a2422, #1f2e2a 60%, #131c1a)",
  },
  {
    id: "gradient:dusk-1",
    label: "Dusk",
    css: "linear-gradient(135deg, #1d1d2a, #232336 60%, #14141d)",
  },
  {
    id: "gradient:rose-1",
    label: "Rose",
    css: "linear-gradient(135deg, #271922, #36202d 60%, #1a1218)",
  },
  {
    id: "gradient:gold-1",
    label: "Honey",
    css: "linear-gradient(135deg, #2a2317, #36301a 60%, #1a1610)",
  },
] as const;

export type CoverGradient = (typeof COVER_GRADIENTS)[number];

/** The CSS `background` for a gradient cover id, or `null` for any other ref. */
export function gradientCss(id: string): string | null {
  return COVER_GRADIENTS.find((g) => g.id === id)?.css ?? null;
}

/** Whether a stored cover ref names a gradient rather than an image file. */
export function isGradientCover(ref: string | null | undefined): boolean {
  return ref?.startsWith("gradient:") ?? false;
}
