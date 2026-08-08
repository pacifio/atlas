import { DEFAULT_ATLAS_THEME_ID, buildThemeVars, getAtlasTheme } from "./themes";

// The full set of CSS custom properties a theme may override. Used to clear a
// prior theme's inline overrides before applying the next (and to reset to the
// tokens.css baseline for the Atlas Black default).
const THEME_VARS = Object.keys(buildThemeVars(getAtlasTheme(null).spec));

/**
 * Apply the given Atlas theme id by writing its palette as CSS custom properties
 * onto `document.documentElement`. Overriding the base tokens cascades through
 * both the Tailwind v4 `@theme` utilities and every direct `var(--…)` consumer,
 * so the whole UI reskins while staying dark.
 *
 * **Atlas Black** (default) clears all overrides → the pristine AMOLED tokens in
 * `tokens.css` apply verbatim (no regression to the signature look).
 *
 * Pure DOM, safe to call pre-mount. Mirrors `apply-editor-theme.ts`.
 */
export function applyAtlasTheme(id: string | undefined | null): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const theme = getAtlasTheme(id);

  if (theme.id === DEFAULT_ATLAS_THEME_ID) {
    for (const k of THEME_VARS) root.style.removeProperty(k);
    return;
  }

  const vars = buildThemeVars(theme.spec);
  for (const [k, v] of Object.entries(vars)) {
    root.style.setProperty(k, v);
  }
}
