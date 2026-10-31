import { useState } from "react";

/**
 * The chat welcome's backdrop: a radial glow from the top edge, painted by
 * `.atlas-welcome-glow` in `globals.css`. Static CSS, so it costs nothing once
 * painted — it replaced a canvas dither field that repainted every frame.
 *
 * Each mount picks a hue from the palette, never the one the last mount
 * showed. The stylesheet maps every name to a dark and a light colour, so the
 * pick survives a theme switch without re-rolling.
 */
export const WELCOME_PALETTE = ["ember", "plum", "ocean", "moss", "amber", "teal"] as const;
export type WelcomePalette = (typeof WELCOME_PALETTE)[number];

let lastPick: WelcomePalette | null = null;

export function pickWelcomePalette(random: () => number = Math.random): WelcomePalette {
  const choices = WELCOME_PALETTE.filter((name) => name !== lastPick);
  const pick = choices[Math.floor(random() * choices.length)] ?? choices[0];
  lastPick = pick;
  return pick;
}

export function WelcomeGlow() {
  const [palette] = useState(pickWelcomePalette);
  return <div aria-hidden className="atlas-welcome-glow" data-palette={palette} />;
}
