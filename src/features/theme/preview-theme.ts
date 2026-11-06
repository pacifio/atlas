import type { CSSProperties } from "react";
import {
  type Theme,
  type ThemeAppearance,
  resolveTheme,
  type Appearance,
} from "@tryatlas/design/theme";

/**
 * A theme resolved for a PREVIEW rather than for the app.
 *
 * `resolveTheme` is pure — it returns a variable map and touches no DOM — so a
 * theme can be shown without being applied: hand `vars` to one element's
 * `style` and every custom property in it inherits down that subtree only.
 * Markup inside resolves `var(--background)` and `var(--syntax-keyword)`
 * against THAT theme while the rest of the app stays on the active one. No
 * global write, no flicker, no "apply it and change back".
 *
 * ## Memoisation
 *
 * Fifteen built-ins × two appearances, re-filtered on every search keystroke,
 * is thirty resolutions per keystroke if nothing remembers them. The cache is a
 * `WeakMap` keyed on the `Theme` OBJECT, not on its id, which makes it
 * self-invalidating: the theme store drops its `loaded` map whenever Rust's
 * file watcher fires, so an edited theme arrives as a fresh object and misses
 * the cache by construction. An id-keyed cache would have to be told.
 */

export type ThemeVars = CSSProperties & Record<`--${string}`, string>;

export interface ThemePreview {
  /**
   * The appearance actually resolved, which is not always the one asked for:
   * a dark-only theme previewed in light mode falls back to its dark variant,
   * exactly as `applyTheme` would. The card labels what this says, not what it
   * requested.
   */
  appearance: Appearance;
  /** Every resolved custom property, ready for one element's `style`. */
  vars: ThemeVars;
  /** The three colours a swatch needs. */
  swatch: { background: string; foreground: string; primary: string };
}

const cache = new WeakMap<Theme, Partial<Record<Appearance, ThemePreview>>>();

function build(theme: Theme, requested: ThemeAppearance): ThemePreview {
  // Every base token is in `cssVars`, written or derived (ADR-0022), so
  // nothing inside a preview can inherit the active theme's value from `:root`.
  const resolved = resolveTheme(theme, requested);
  const vars = { ...resolved.cssVars } as ThemeVars;
  return {
    appearance: resolved.appearance,
    vars,
    swatch: {
      background: vars["--background"],
      foreground: vars["--foreground"],
      primary: vars["--primary"],
    },
  };
}

/** Resolve `theme` for `requested`, reusing the last answer for that pair. */
export function previewTheme(theme: Theme, requested: ThemeAppearance): ThemePreview {
  const byAppearance = cache.get(theme);
  const hit = byAppearance?.[requested];
  if (hit) return hit;
  const built = build(theme, requested);
  // Keyed by what was ASKED for: a dark-only theme answers the same object for
  // both, and looking it up by `built.appearance` would miss every light call.
  cache.set(theme, { ...byAppearance, [requested]: built });
  return built;
}
