import type { Theme, ThemeMode } from "./lib/theme-api";
import { resolveTheme, type ResolvedTheme, type ThemeOverride } from "./resolve-theme";

const STYLE_ID = "atlas-resolved-theme";
/**
 * The selector the resolved block is written under — here and, from the launch
 * cache, by `index.html`'s inline boot script.
 *
 * `html:root` rather than `:root` for the specificity. The boot script creates
 * this `<style>` inside `<head>` before any stylesheet exists, so on a cold
 * start it sits BEFORE `tokens.css`; at plain `:root` the compiled-in Atlas-dark
 * fallbacks there would win on source order and undo the replay. One extra type
 * selector makes the resolved theme win wherever the element sits.
 */
const THEME_SELECTOR = "html:root";

/**
 * The selector a surface sets on itself to be drawn in the OTHER appearance.
 *
 * A panel over the record — the session reader's share sheet, its comments —
 * reads as a layer rather than as more of the page when it is the opposite
 * colour. The web does this with `data-theme="light"` on the element; here the
 * active theme is written at runtime rather than declared per appearance in
 * CSS, so the inverted block is emitted alongside it from the same resolve.
 *
 * Its own attribute rather than reusing `data-theme`, which already carries
 * the theme's ID on `<html>` — one attribute, one meaning.
 */
const INVERT_SELECTOR = "[data-theme-invert]";
/**
 * Where `index.html` looks for the last theme at launch. Read by an inline
 * script before any module — and before `tokens.css` — so the first frame
 * paints in the theme the user chose instead of flashing black.
 */
const LAUNCH_CACHE_KEY = "atlas:launch-theme";
let activeTheme: ResolvedTheme | null = null;

/**
 * What the next cold start replays before any module has loaded.
 *
 * The seven named colours feed the boot skeleton's `--atlas-boot-*` inline
 * properties. `vars` is the WHOLE resolved map, which `index.html` writes into
 * the same `<style id="atlas-resolved-theme">` this module owns. It used to be
 * only the seven, and the app's first render — which happens three IPC round
 * trips before the first `applyTheme` — had no theme-key variable at all:
 * transparent surfaces, and a dark flash for anyone on a light theme. A couple
 * of hundred short strings is still nothing to parse on the critical path.
 */
function launchCache(resolved: ResolvedTheme) {
  return {
    id: resolved.id,
    appearance: resolved.appearance,
    background: resolved.base.background,
    chrome: resolved.base.sidebar,
    card: resolved.base.card,
    line: resolved.keys["border.subtle"],
    skeleton: resolved.keys["element.selected"],
    text: resolved.base["muted-foreground"],
    vars: resolved.cssVars,
  };
}

/** The resolved block's stylesheet text. `index.html` builds the identical
 *  string from the cached `vars`, so the two never disagree about a frame. */
export function resolvedThemeCss(cssVars: Record<string, string>): string {
  return `${THEME_SELECTOR}{${declarations(cssVars)}}`;
}

function declarations(cssVars: Record<string, string>): string {
  return Object.entries(cssVars)
    .map(([name, value]) => `${name}:${value}`)
    .join(";");
}

/**
 * The same theme resolved the other way round, scoped to anything carrying
 * `data-theme-invert`.
 *
 * Every variable is re-declared inside the scope, not only the ones that
 * differ: `var(--x)` resolves where it is DECLARED and is inherited already
 * resolved, so a half-declared scope would inherit the page's answers for
 * everything it left out — white text on a white panel.
 *
 * A theme with only one variant resolves to that variant both times, so the
 * panel simply does not invert. That is `resolveTheme`'s documented fallback
 * and is better than inventing a palette the theme's author never chose.
 */
export function invertedThemeCss(cssVars: Record<string, string>): string {
  return `${INVERT_SELECTOR}{${declarations(cssVars)}}`;
}

/**
 * Cache it for the next cold start. Failure is silent and harmless —
 * `index.html` falls back to `tokens.css` and the literals it has always had
 * (a blocked or full store, or a private window, all land there).
 */
function cacheLaunchTheme(cache: ReturnType<typeof launchCache>): void {
  try {
    localStorage.setItem(LAUNCH_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* an unavailable store just means the compiled-in fallbacks */
  }
}

/**
 * Re-run, against the theme being applied now, what `index.html`'s inline boot
 * script did at launch against the cached one.
 *
 * These are INLINE properties on `<html>`, set before any stylesheet loads, and
 * `index.html` binds the root `background` and — the part that matters — the
 * root `color-scheme` to them. An inline property on the element beats the
 * `:root{…}` block `applyTheme` writes into `<head>`, so leaving them alone
 * meant that after any runtime switch the page kept the PREVIOUS theme's
 * `color-scheme` and root background for the rest of the session: native
 * scrollbars, form controls, `<select>` popups and the caret all stayed on the
 * old appearance while everything Atlas draws itself had already changed.
 *
 * Kept byte-for-byte in step with the `set(…)` calls in `index.html` — the two
 * write the same property names from the same seven values, which is why both
 * go through `launchCache()`.
 */
function applyBootVars(root: HTMLElement, colors: ReturnType<typeof launchCache>): void {
  const set = (name: string, value: string | undefined) => {
    if (value) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  };
  set("--atlas-boot-bg", colors.background);
  set("--atlas-boot-chrome", colors.chrome);
  set("--atlas-boot-card", colors.card);
  set("--atlas-boot-line", colors.line);
  set("--atlas-boot-skeleton", colors.skeleton);
  set("--atlas-boot-text", colors.text);
  set("--atlas-boot-scheme", colors.appearance);
}

/**
 * Which appearance a mode resolves to.
 *
 * `system` asks the OS. It used to be forced to `dark` behind a
 * `LIGHT_APPEARANCE_ENABLED` flag while the light pass was unfinished —
 * hiding the Light button alone was not enough, because the OS decides what
 * `system` means and anyone on a light Mac was landed in the unfinished light
 * UI at boot, having never chosen it and with no visible control to get out.
 * Every folder has had its light pass now, so the flag is gone and `system`
 * means what it says.
 *
 * A theme with no light variant is NOT a reason to refuse: `resolveTheme`
 * falls back to the theme's other variant, which is the documented schema-1
 * behaviour.
 */
export function appearanceForMode(mode: ThemeMode): "dark" | "light" {
  if (mode !== "system") return mode;
  if (typeof matchMedia === "undefined") return "dark";
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** `interfaceContrast`, held here because every apply resolves through it;
 *  the settings store sets it before re-applying. */
let interfaceContrast = 100;

export function setInterfaceContrast(contrast: number): void {
  interfaceContrast = contrast;
}

export function applyTheme(
  theme: Theme,
  mode: ThemeMode,
  themeOverride: ThemeOverride = {},
  /** A preview (the theme editor's draft) paints the app but is not cached
   *  for the next launch, so quitting mid-edit never boots into a draft. */
  { preview = false }: { preview?: boolean } = {},
): ResolvedTheme {
  const resolved = resolveTheme(theme, appearanceForMode(mode), themeOverride, interfaceContrast);
  activeTheme = resolved;
  if (typeof document === "undefined") return resolved;

  const root = document.documentElement;
  root.classList.toggle("dark", resolved.appearance === "dark");
  root.dataset.theme = theme.id;
  root.dataset.themeAppearance = resolved.appearance;

  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.append(style);
  }
  // The page's own appearance, then the other one for any surface that asks.
  const inverted = resolveTheme(
    theme,
    resolved.appearance === "dark" ? "light" : "dark",
    themeOverride,
    interfaceContrast,
  );
  style.textContent = resolvedThemeCss(resolved.cssVars) + invertedThemeCss(inverted.cssVars);
  const cache = launchCache(resolved);
  applyBootVars(root, cache);
  if (!preview) cacheLaunchTheme(cache);
  window.dispatchEvent(new CustomEvent("atlas:theme-applied"));
  return resolved;
}

export function getActiveTheme(): ResolvedTheme | null {
  return activeTheme;
}
