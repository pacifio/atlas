/**
 * Atlas Themes — complete dark palettes for the whole UI.
 *
 * This replaces the earlier "App Accent" picker: instead of only re-tinting the
 * accent over a fixed AMOLED-black base, a theme swaps the *entire* dark palette
 * — background, elevations, text tiers, borders AND accent — so Atlas can wear
 * popular editor palettes (One Dark, GitHub Dark, …) as a full skin. Everything
 * stays dark (dark-theme primitives only); we just move `#000` off pure black.
 *
 * Applied at runtime by `apply-atlas-theme.ts`, which writes each theme's tokens
 * as CSS custom properties on `document.documentElement` (same mechanism the old
 * accent picker used). The default **Atlas Black** clears all overrides so the
 * original AMOLED look is preserved byte-for-byte.
 *
 * The code-editor *syntax* theme ([[project_editor_themes]]) is independent and
 * composes on top — pick GitHub Dark chrome with One Dark syntax if you like.
 */
export type ThemeSpec = {
  /** --bg-base / --bg-surface — the main content background. */
  base: string;
  /** Sidebar / rail / file-tree panel surface (slightly off base). */
  panel: string;
  /** Raised cards / secondary surfaces. */
  elevated: string;
  /** Popovers / overlays / tertiary surfaces. */
  overlay: string;
  /** Input field background. */
  input: string;
  /** Active editor tab background. */
  tabActive: string;

  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textGhost: string;
  textMuted: string;

  borderDefault: string;
  borderSubtle: string;
  borderStrong: string;

  accent: string;
  accentHover: string;
  /** Text/icon color on a solid accent fill (primary buttons). */
  accentForeground: string;
};

export type AtlasTheme = {
  id: string;
  name: string;
  /** One-line character sketch shown beside the preview in the picker. */
  description: string;
  spec: ThemeSpec;
};

export const DEFAULT_ATLAS_THEME_ID = "atlas-black";

export const ATLAS_THEMES: AtlasTheme[] = [
  {
    id: "atlas-black",
    name: "Atlas Black",
    description: "Pure AMOLED black — maximum contrast, zero glare.",
    // Preview only — the applier CLEARS overrides for this id so the original
    // AMOLED tokens in tokens.css apply verbatim.
    spec: {
      base: "#000000",
      panel: "#0a0a0a",
      elevated: "#0f0f0f",
      overlay: "#1c1c1c",
      input: "#0a0a0a",
      tabActive: "#171717",
      textPrimary: "#ffffff",
      textSecondary: "#aaaaaa",
      textTertiary: "#777777",
      textGhost: "#333333",
      textMuted: "#585858",
      borderDefault: "#1e1e1e",
      borderSubtle: "#141414",
      borderStrong: "#3d3d3d",
      accent: "#ffffff",
      accentHover: "#cccccc",
      accentForeground: "#000000",
    },
  },
  {
    // Deep warm near-black + muted gold — cozy, very low glare.
    id: "chyral",
    name: "Chyral",
    description: "Warm near-black with muted gold — cozy, low glare.",
    spec: {
      // Warm near-black base (darkest, like Atlas Black's #000) with a raised
      // surface ladder + bright warm borders, so panes/cards stay distinct.
      base: "#080604",
      panel: "#100c07",
      elevated: "#171109",
      overlay: "#211a10",
      input: "#0d0a06",
      tabActive: "#1d1610",
      textPrimary: "#ece5d5",
      textSecondary: "#a99f8c",
      textTertiary: "#6f6656",
      textGhost: "#221c13",
      textMuted: "#4c4636",
      borderDefault: "#2a2114",
      borderSubtle: "#1a140c",
      borderStrong: "#473a22",
      accent: "#c9a35a",
      accentHover: "#d9b878",
      accentForeground: "#140f06",
    },
  },
  {
    // Deep neutral graphite + soft periwinkle — clean, restrained.
    id: "mirage",
    name: "Mirage",
    description: "Neutral graphite with soft periwinkle — clean, restrained.",
    spec: {
      // Cool graphite near-black base (darkest) with a raised surface ladder +
      // bright cool borders, mirroring Atlas Black's depth structure.
      base: "#08080a",
      panel: "#0e0e12",
      elevated: "#15151b",
      overlay: "#1f1f27",
      input: "#0b0b0f",
      tabActive: "#1b1b22",
      textPrimary: "#dcdde2",
      textSecondary: "#9b9ca6",
      textTertiary: "#63646d",
      textGhost: "#1e1e24",
      textMuted: "#484852",
      borderDefault: "#28282f",
      borderSubtle: "#17171c",
      borderStrong: "#44444f",
      accent: "#8b9cf0",
      accentHover: "#a3b1f5",
      accentForeground: "#090a12",
    },
  },
  {
    // AMOLED near-black + Rosé Pine's signature rose — soft, focused.
    id: "rose-pine",
    name: "Rosé Pine",
    description: "AMOLED near-black with a soft rose accent — calm, focused.",
    spec: {
      // Keep the recognizable Rosé Pine warmth while pulling its surfaces
      // toward black for OLED displays and preserving Atlas's depth ladder.
      base: "#08070a",
      panel: "#100e14",
      elevated: "#18151e",
      overlay: "#24202c",
      input: "#0d0b10",
      tabActive: "#1e1a25",
      textPrimary: "#e0def4",
      textSecondary: "#aaa6c2",
      textTertiary: "#7a7692",
      textGhost: "#292532",
      textMuted: "#56516a",
      borderDefault: "#302a39",
      borderSubtle: "#1b1721",
      borderStrong: "#51485f",
      accent: "#eb6f92",
      accentHover: "#f08ba7",
      accentForeground: "#16090e",
    },
  },
];

/** Look up a theme by id, falling back to the Atlas Black default. */
export function getAtlasTheme(id: string | undefined | null): AtlasTheme {
  return (
    ATLAS_THEMES.find((t) => t.id === id) ??
    ATLAS_THEMES.find((t) => t.id === DEFAULT_ATLAS_THEME_ID) ??
    ATLAS_THEMES[0]
  );
}

/** Expand a theme spec into the full CSS-custom-property map that reskins the
 *  UI. `--bg-hover/selected/active` are intentionally left as the tokens.css
 *  translucent-white overlays — they read correctly on any dark base. */
export function buildThemeVars(s: ThemeSpec): Record<string, string> {
  return {
    // Backgrounds (aliases --bg-primary/secondary/tertiary follow via var()).
    "--bg-base": s.base,
    "--bg-surface": s.base,
    "--bg-sidebar": s.panel,
    "--bg-rail": s.panel,
    "--bg-canvas": s.panel,
    "--bg-raised": s.elevated,
    "--bg-overlay": s.overlay,
    "--bg-input": s.input,
    "--bg-tab-active": s.tabActive,
    "--bg-elevated": s.elevated,
    "--bg-elevated-2": s.overlay,
    "--panel-rail-bg": s.panel,
    "--panel-bg": s.panel,
    "--panel-bg-2": s.elevated,

    // Text tiers.
    "--text-primary": s.textPrimary,
    "--text-secondary": s.textSecondary,
    "--text-tertiary": s.textTertiary,
    "--text-ghost": s.textGhost,
    "--text-muted": s.textMuted,
    "--text-inverse": s.base,

    // Borders.
    "--border-default": s.borderDefault,
    "--border-subtle": s.borderSubtle,
    "--border-strong": s.borderStrong,
    "--border-focus": s.borderStrong,
    "--border-variant": s.borderSubtle,

    // Accent + shadcn compat.
    "--accent-primary": s.accent,
    "--accent-primary-hover": s.accentHover,
    "--accent-primary-muted": `color-mix(in srgb, ${s.accent} 14%, transparent)`,
    "--accent-secondary": s.textTertiary,
    "--primary-foreground": s.accentForeground,
    "--muted": s.elevated,
    "--accent": s.elevated,
    "--ring": s.accent,
  };
}
