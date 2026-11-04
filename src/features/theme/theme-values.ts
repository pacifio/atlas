/**
 * Resolved theme values for the subsystems CSS cannot reach.
 *
 * Most of Atlas follows the theme for free: the applier writes every resolved
 * key to `:root` as a custom property and the markup reads it back through a
 * Tailwind utility or a `var(--…)`. Four subsystems cannot do that, because
 * they take a COLOUR as a JavaScript value rather than as a style:
 *
 *  - xterm — `ITheme` is 19 concrete strings handed to a WebGL renderer;
 *  - pixi — `Graphics.fill({ color })` wants a 24-bit integer;
 *  - recharts — every chart primitive takes `stroke`/`fill` props;
 *  - mermaid — `themeVariables` is an object, read once at `initialize`.
 *
 * Decision 14 is what this module implements: resolution happens in TypeScript
 * and non-CSS consumers get RESOLVED values, never a custom-property
 * reference, which would reach a WebGL context as literal text.
 *
 * The second half of the contract is staying current. `applyTheme` dispatches
 * `atlas:theme-applied` on `window` after every switch, so a consumer that
 * cached a colour subscribes with `onThemeApplied` (imperative: xterm, pixi) or
 * re-renders on `useThemeVersion` (React: recharts, mermaid). A subsystem that
 * only reads the right value at construction time is still theme-blind — it
 * just fails one reload later.
 */
import { useSyncExternalStore } from "react";
import { getActiveTheme } from "./apply-theme";
import {
  hexOf,
  DERIVED_VAR_REGISTRY,
  THEME_KEY_REGISTRY,
  type DerivedVar,
  type ThemeKey,
} from "@tryatlas/design/theme";

export const THEME_APPLIED_EVENT = "atlas:theme-applied";

/**
 * Last-resort values, taken from the registry's own per-appearance defaults so
 * this file never restates a colour. They are only reachable before the first
 * `applyTheme` — every code path here prefers the active theme.
 */
const DEFAULTS = Object.fromEntries(
  THEME_KEY_REGISTRY.map((definition) => [definition.key, definition.rule.atlasDefault.dark]),
) as Record<ThemeKey, string>;

/** The resolved colour for a theme key. Always a concrete CSS colour. */
export function themeColor(key: ThemeKey): string {
  return getActiveTheme()?.keys[key] ?? DEFAULTS[key];
}

/**
 * The resolved colour for a derived variable — one Atlas computes from a key
 * or a base token and no theme may set (`terminal.selection`, …).
 *
 * Before the first `applyTheme` there is nothing to transform, so this falls
 * back to the same per-appearance defaults `themeColor` uses, run through the
 * variable's own transform with an empty context.
 */
export function themeDerived(name: DerivedVar): string {
  const active = getActiveTheme();
  if (active) return active.derived[name];
  const definition = DERIVED_VAR_REGISTRY.find((entry) => entry.name === name);
  if (!definition) return "";
  const source = definition.from ? DEFAULTS[definition.from] : "";
  return definition.transform(source, { base: {}, palette: {}, appearance: "dark" });
}

/**
 * The resolved colour for a shadcn base token (`chart-1`, `border`, …).
 *
 * Base tokens differ from theme keys in that `tokens.css` defines the whole set
 * on `:root`, so the computed style is a real fallback rather than an empty
 * string when nothing has been applied yet.
 */
export function themeBase(token: string): string {
  const active = getActiveTheme()?.base[token];
  if (active) return active;
  if (typeof document === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(`--${token}`).trim();
}

/** A theme key as pixi's 24-bit colour integer. Alpha is dropped; see `alphaOf`. */
export function themeHex(key: ThemeKey): number {
  return hexOf(themeColor(key));
}

// ── Change notification ────────────────────────────────────────────────────

let version = 0;
const listeners = new Set<() => void>();

const g = globalThis as unknown as { __atlasThemeAppliedBound?: boolean };
if (typeof window !== "undefined" && !g.__atlasThemeAppliedBound) {
  g.__atlasThemeAppliedBound = true;
  window.addEventListener(THEME_APPLIED_EVENT, () => {
    version += 1;
    // Iterating the Set directly is safe: a listener that unsubscribes during
    // the notification is simply skipped, which is the behaviour we want.
    for (const listener of listeners) listener();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Run `callback` after every theme switch. For imperative owners — a live
 * xterm, a running pixi scene — that repaint themselves rather than re-render.
 */
export function onThemeApplied(callback: () => void): () => void {
  return subscribe(callback);
}

/**
 * A counter that changes on every theme switch. Put it in a dependency array
 * (or just read it) to make a component re-read resolved values.
 */
export function useThemeVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
}
