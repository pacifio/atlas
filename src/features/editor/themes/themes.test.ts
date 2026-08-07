import { describe, expect, it } from "vitest";
import { ATLAS_THEMES } from "@/features/theme/themes";
import {
  DEFAULT_EDITOR_THEME_ID,
  EDITOR_THEMES,
  getEditorTheme,
  resolveEditorColors,
} from "./themes";
import type { EditorColorTheme, EditorThemeColors } from "./types";

/**
 * Legibility guard for the editor palettes (issue #75).
 *
 * The default theme shipped comments at `#555555` and keywords at `#585858`
 * on black — under 3:1, and two shades of the same grey — so highlighted code
 * arrived looking unhighlighted. A palette is data, so nothing but a rule like
 * this stops the next one from regressing the same way.
 *
 * These are contrast ratios, not screenshots: they cover the measurable half of
 * "is this readable" and run in CI. Hue relationships, and how a real file
 * actually reads, still need eyes on the app — the repo has no screenshot
 * infrastructure, so that half stays a manual check at review time.
 */

/** WCAG 2.1 relative luminance of an `#rrggbb` color. */
function luminance(hex: string): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const h = hex.replace("#", "");
  const [r, g, b] = [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)].map((p) => parseInt(p, 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.1 contrast ratio between two `#rrggbb` colors: 1 (none) to 21. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The syntax tokens — the ones a reader's eye lands on. Chrome (gutter, folds)
 * and the diff backgrounds are held to different, looser bars below.
 */
const SYNTAX_TOKENS = [
  "comment",
  "keyword",
  "string",
  "number",
  "type",
  "func",
  "variable",
  "operator",
  "tagName",
  "attributeName",
  "constant",
  "regexp",
  "escape",
  "definition",
  "propertyName",
  "bool",
  "null",
] as const satisfies readonly (keyof EditorThemeColors)[];

/**
 * Every editor theme renders on the *interface* background, never its own
 * (`resolveEditorColors`), so the bar is contrast against whichever base the
 * user's interface theme is on. Testing all of them means a new interface
 * theme with a lighter base can't quietly undercut the editor.
 */
const INTERFACE_BASES = ATLAS_THEMES.map((t) => ({ id: t.id, base: t.spec.base }));

/** WCAG AA for body text. The bar for the themes Atlas itself authors. */
const AA_TEXT = 4.5;

/**
 * The floor for the ported third-party palettes (Dracula, One Dark, Monokai).
 * Their point is fidelity to a known look, so their canonical comment greys —
 * One Dark's `#5c6370` is 3.47:1 on black — are kept as published rather than
 * "corrected" into something that is no longer One Dark. The floor still
 * guarantees nothing illegible can be added.
 */
const FLOOR = 3;

/** Themes Atlas authors, and therefore holds to AA. */
const ATLAS_AUTHORED = ["atlas", "atlas-mono"];

const byId = (id: string) => EDITOR_THEMES.find((t) => t.id === id) as EditorColorTheme;

describe("editor themes", () => {
  describe("registry", () => {
    it("has a unique id per theme", () => {
      const ids = EDITOR_THEMES.map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("defaults to a theme that exists", () => {
      expect(getEditorTheme(DEFAULT_EDITOR_THEME_ID).id).toBe(DEFAULT_EDITOR_THEME_ID);
    });

    it.each([
      ["unknown id", "no-such-theme"],
      ["undefined", undefined],
      ["null", null],
    ])("falls back to the default for %s", (_label, id) => {
      expect(getEditorTheme(id).id).toBe(DEFAULT_EDITOR_THEME_ID);
    });

    it("keeps every theme on the interface background, not its own", () => {
      // The behaviour the contrast assertions below depend on.
      for (const theme of EDITOR_THEMES) {
        const resolved = resolveEditorColors(theme);
        expect(resolved.bg).toBe("var(--bg-base)");
        expect(resolved.gutterBg).toBe("var(--bg-base)");
        expect(resolved.contextBg).toBe("var(--bg-base)");
      }
    });
  });

  describe("syntax contrast", () => {
    const cases = EDITOR_THEMES.flatMap((theme) =>
      INTERFACE_BASES.map((surface) => ({ theme, surface })),
    );

    it.each(cases)("$theme.id is readable on the $surface.id background", ({ theme, surface }) => {
      const min = ATLAS_AUTHORED.includes(theme.id) ? AA_TEXT : FLOOR;
      const failures = SYNTAX_TOKENS.filter(
        (token) => contrast(theme.colors[token], surface.base) < min,
      ).map((token) => `${token} ${theme.colors[token]}`);
      expect(failures).toEqual([]);
    });
  });

  describe("the default theme", () => {
    const theme = byId(DEFAULT_EDITOR_THEME_ID);

    it("is one Atlas authors, and so is held to AA", () => {
      expect(ATLAS_AUTHORED).toContain(theme.id);
    });

    it("draws comments subdued — dimmer than body text, still above AA", () => {
      const comment = contrast(theme.colors.comment, "#000000");
      expect(comment).toBeGreaterThanOrEqual(AA_TEXT);
      expect(comment).toBeLessThan(contrast(theme.colors.fg, "#000000"));
    });

    it("separates comments from keywords, which used to be a shade apart", () => {
      // #555555 vs #585858 in the old default: technically two colors, one
      // colour to the eye. Ratio between them, not against the background.
      expect(contrast(theme.colors.comment, theme.colors.keyword)).toBeGreaterThan(1.5);
    });

    it("gives each token family a distinguishable color", () => {
      // Not "all 17 differ" — several tokens share a color by design (numbers,
      // constants and booleans are one family). The families must differ.
      const families = [
        theme.colors.comment,
        theme.colors.keyword,
        theme.colors.string,
        theme.colors.number,
        theme.colors.type,
        theme.colors.func,
        theme.colors.variable,
      ];
      expect(new Set(families).size).toBe(families.length);
    });

    it("keeps the Atlas yellow on function names", () => {
      expect(theme.colors.func).toBe("#ffff00");
    });

    it("keeps line numbers visible without competing with the code", () => {
      const gutter = contrast(theme.colors.gutterFg, "#000000");
      expect(gutter).toBeGreaterThanOrEqual(FLOOR);
      expect(gutter).toBeLessThan(contrast(theme.colors.fg, "#000000"));
    });
  });

  describe("atlas-mono", () => {
    const theme = byId("atlas-mono");

    it("stays monochrome — greys and the one yellow accent, no other hue", () => {
      for (const token of SYNTAX_TOKENS) {
        const hex = theme.colors[token];
        if (hex === theme.colors.func) continue; // the #ffff00 accent
        const [r, g, b] = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)];
        expect(`${token}:${r}${g}${b}`).toBe(`${token}:${r}${r}${r}`);
      }
    });

    it("separates tokens by lightness, since it cannot use hue", () => {
      const steps = new Set(SYNTAX_TOKENS.map((t) => theme.colors[t]));
      expect(steps.size).toBeGreaterThanOrEqual(6);
    });
  });
});
