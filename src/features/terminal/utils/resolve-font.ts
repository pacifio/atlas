/**
 * Terminal font resolution, ported (and trimmed) from Athas's
 * `resolve-font.ts`. xterm.js measures the character cell from the *first*
 * resolvable font, so a broken/un-loaded primary font silently corrupts the
 * whole grid — and which fonts are "available" differs between the Vite dev
 * server (warm font cache, dev machine has the nice fonts installed) and a
 * shipped `.app` on a clean machine. We therefore:
 *   1. Build a family that always ends in a guaranteed-present native mono
 *      (`Menlo` on macOS) + the `monospace` generic, so rendering degrades
 *      identically everywhere.
 *   2. Verify the requested font actually loaded before init (the caller also
 *      awaits `document.fonts.ready`) so glyph metrics are stable.
 */

const MAC_FALLBACK = "Menlo";
const WINDOWS_FALLBACK = "Consolas";
const LINUX_FALLBACK = "Liberation Mono";

const CSS_GENERIC_FONT_FAMILIES = new Set([
  "monospace",
  "ui-monospace",
  "serif",
  "sans-serif",
  "system-ui",
]);

/** The app's preferred monospace identity. Used when actually installed;
 *  otherwise the resolver falls back to the platform native font. */
const TERMINAL_PRIMARY_FONT = "JetBrains Mono, SF Mono";

function getPlatformFallback(): string {
  if (typeof navigator === "undefined") return LINUX_FALLBACK;
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return WINDOWS_FALLBACK;
  if (/Mac/i.test(ua)) return MAC_FALLBACK;
  return LINUX_FALLBACK;
}

function stripWrappingQuotes(name: string): string {
  return name.trim().replace(/^['"]+|['"]+$/g, "");
}

function quoteFontName(name: string): string {
  const normalized = stripWrappingQuotes(name);
  if (!normalized) return "";
  if (CSS_GENERIC_FONT_FAMILIES.has(normalized.toLowerCase()))
    return normalized;
  return `"${normalized.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function splitFontFamilyList(fontFamily: string): string[] {
  return fontFamily.split(",").map(stripWrappingQuotes).filter(Boolean);
}

function uniqueFontFamilies(families: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const family of families) {
    const normalized = stripWrappingQuotes(family);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

/**
 * Build the terminal font-family string with a guaranteed native + generic
 * tail. Order matters: requested fonts → platform native → `monospace`.
 */
export function buildTerminalFontFamily(primaryFont: string): string {
  const requested = splitFontFamilyList(primaryFont).filter(
    (f) => !CSS_GENERIC_FONT_FAMILIES.has(f.toLowerCase()),
  );
  return uniqueFontFamilies([...requested, getPlatformFallback(), "monospace"])
    .map(quoteFontName)
    .filter(Boolean)
    .join(", ");
}

/** Load and verify a font is renderable. Returns false on failure/timeout. */
async function loadAndVerifyFont(
  fontName: string,
  fontSize: number,
): Promise<boolean> {
  const test = `${fontSize}px "${stripWrappingQuotes(fontName)}"`;
  try {
    await document.fonts.load(test);
  } catch {
    return false;
  }
  return document.fonts.check(test);
}

/**
 * Resolve the terminal font family. Awaits `document.fonts.ready`, then tries
 * to load the app's preferred mono; whether or not it loads, the returned
 * family always carries the native + generic fallback so metrics are stable
 * and rendering is identical between dev and a shipped build.
 */
export async function resolveTerminalFont(fontSize: number): Promise<string> {
  try {
    await document.fonts.ready;
  } catch {
    // Older WebViews may not expose the font-loading API — fall through.
  }
  // Probe the first concrete primary; success just means we keep it leading.
  const primary = splitFontFamilyList(TERMINAL_PRIMARY_FONT)[0] ?? MAC_FALLBACK;
  const loaded = await loadAndVerifyFont(primary, fontSize);
  return loaded
    ? buildTerminalFontFamily(TERMINAL_PRIMARY_FONT)
    : buildTerminalFontFamily(getPlatformFallback());
}
