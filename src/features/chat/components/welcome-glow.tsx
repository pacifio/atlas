import { useState } from "react";
import { useSettingsStore } from "@/features/settings/stores/settings-store";

/**
 * The chat welcome's backdrop: a radial glow from the top edge, painted by
 * `.atlas-welcome-glow` in `globals.css`. Static CSS, so it costs nothing once
 * painted — it replaced a canvas dither field that repainted every frame.
 *
 * Two settings under Appearance shape it: `welcomeBackground` turns it off
 * for the plain background, and `welcomeGlowColor` fixes the hue. Left on
 * "random", each mount picks a hue from the palette, never the one the last
 * mount showed. The stylesheet maps every name to a dark and a light colour,
 * so the pick survives a theme switch without re-rolling.
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
  const background = useSettingsStore((s) => s.settings.welcomeBackground);
  const color = useSettingsStore((s) => s.settings.welcomeGlowColor);
  // Rolled once per mount, so a fixed colour switched back to "random" lands
  // on this mount's pick rather than re-rolling on every render.
  const [randomPick] = useState(pickWelcomePalette);
  if (background === "plain") return null;
  const palette = color === "random" ? randomPick : color;
  return <div aria-hidden className="atlas-welcome-glow" data-palette={palette} />;
}
