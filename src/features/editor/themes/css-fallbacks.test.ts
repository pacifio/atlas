import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { editorThemeCssVars } from "./apply-editor-theme";
import { DEFAULT_EDITOR_THEME_ID, getEditorTheme, resolveEditorColors } from "./themes";

/**
 * The editor palette exists in three places: the theme registry, and the
 * hand-written `var(--cm-…, #hex)` fallbacks in two stylesheets. The fallbacks
 * are what render when `applyEditorTheme` hasn't run or loses a production race
 * — the exact moment nobody is watching — so a drifted fallback shows up as a
 * half-restyled editor and nothing else.
 *
 * They had already drifted (`--cm-fold-fg` and `--cm-active-gutter-fg` were
 * still carrying pre-#75 greys after the palette was retuned), which is the
 * argument for checking them rather than trusting three copies to stay in step.
 */

const STYLES = join(__dirname, "../../../styles");

const SHEETS = ["globals.css", "diff-syntax.css"] as const;

/** Every `var(--cm-name, fallback)` in a stylesheet, as [name, fallback]. */
function cmFallbacks(css: string): Array<[string, string]> {
  // `[^);]+` stops at the closing paren of the var() itself; the only nested
  // parens in these fallbacks are rgba(), which is handled by the alternation.
  const pattern = /var\((--cm-[a-z-]+),\s*((?:rgba?\([^)]*\)|[^)])+)\)/g;
  return [...css.matchAll(pattern)].map(([, name, fallback]) => [name, fallback.trim()]);
}

/**
 * Reduce a CSS color to `r,g,b,a` so equal colors written differently compare
 * equal: `#666` = `#666666`, and `#ffffff0a` = `rgba(255, 255, 255, 0.04)`.
 * A stylesheet and a JS theme object reach for different notations for the same
 * value, and the point here is drift, not spelling.
 */
function normalizeColor(value: string): string {
  const v = value.trim().toLowerCase();

  const rgb = /^rgba?\(([^)]*)\)$/.exec(v);
  if (rgb) {
    const parts = rgb[1].split(/[,/\s]+/).filter(Boolean).map(Number);
    const [r, g, b, a = 1] = parts;
    return `${r},${g},${b},${a.toFixed(2)}`;
  }

  const hex = /^#([0-9a-f]{3,8})$/.exec(v);
  if (hex) {
    const h = hex[1];
    // Expand 3/4-digit shorthand to its 6/8-digit equivalent.
    const full = h.length <= 4 ? [...h].map((c) => c + c).join("") : h;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
    const a = full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1;
    return `${r},${g},${b},${a.toFixed(2)}`;
  }

  return v.replace(/\s+/g, " ");
}

const expected = editorThemeCssVars(resolveEditorColors(getEditorTheme(DEFAULT_EDITOR_THEME_ID)));

describe("stylesheet fallbacks track the default editor theme", () => {
  describe.each(SHEETS)("%s", (sheet) => {
    const css = readFileSync(join(STYLES, sheet), "utf8");
    const fallbacks = cmFallbacks(css);

    it("declares at least one --cm-* fallback (the regex still matches)", () => {
      expect(fallbacks.length).toBeGreaterThan(0);
    });

    it("names only custom properties applyEditorTheme actually sets", () => {
      const unknown = fallbacks.map(([name]) => name).filter((name) => !(name in expected));
      expect([...new Set(unknown)]).toEqual([]);
    });

    it("matches the default theme's value for every fallback", () => {
      const drifted = fallbacks
        .filter(([name, fallback]) => {
          const want = expected[name];
          // `--cm-bg`/`--cm-gutter-bg` resolve to `var(--bg-base)`, which a
          // fallback cannot restate; they hard-code the AMOLED base instead.
          if (want?.startsWith("var(")) return normalizeColor(fallback) !== normalizeColor("#000000");
          return normalizeColor(fallback) !== normalizeColor(want ?? "");
        })
        .map(([name, fallback]) => `${name}: ${fallback} (theme has ${expected[name]})`);
      expect(drifted).toEqual([]);
    });
  });
});
