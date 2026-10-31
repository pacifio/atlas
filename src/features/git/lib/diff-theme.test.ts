import { beforeAll, describe, expect, it } from "vitest";
import {
  getSharedHighlighter,
  renderFileWithHighlighter,
  type DiffsHighlighter,
} from "@pierre/diffs";
import { DIFF_THEME_NAMES, ensureDiffTheme } from "./diff-theme";

/**
 * The viewer's shadow root takes its `color-scheme` from the rendered result's
 * `baseThemeType` when there is one, and from `themeType` only when there is
 * not. A single theme name sets `baseThemeType` to that theme's registered
 * type, which pinned every diff, PR Code tab and file view to dark under a
 * light Atlas theme. These hold the fix: a pair, so `themeType` decides.
 */

let highlighter: DiffsHighlighter;

beforeAll(async () => {
  ensureDiffTheme();
  highlighter = await getSharedHighlighter({
    themes: [DIFF_THEME_NAMES.light, DIFF_THEME_NAMES.dark],
    langs: ["text", "typescript"],
    preferredHighlighter: "shiki-js",
  });
});

describe("the diff theme", () => {
  it("is a light/dark pair, each half registered with its own type", () => {
    expect(typeof DIFF_THEME_NAMES).toBe("object");
    expect(highlighter.getTheme(DIFF_THEME_NAMES.light).type).toBe("light");
    expect(highlighter.getTheme(DIFF_THEME_NAMES.dark).type).toBe("dark");
  });

  it("leaves the colour scheme to themeType, so a light Atlas theme renders light", () => {
    const result = renderFileWithHighlighter(
      { name: "a.ts", contents: "export const a = 1; // note\n" },
      highlighter,
      { theme: DIFF_THEME_NAMES, useTokenTransformer: true, tokenizeMaxLineLength: 1_000 },
    );
    expect(result.baseThemeType).toBeUndefined();
    // Both halves colour tokens from the active Atlas theme's syntax keys, so
    // light mode gets the light theme's code colours and nothing re-tokenizes.
    const html = JSON.stringify(result.code);
    expect(html).toMatch(/--diffs-token-light:var\(--atlas-syntax-keyword\)/);
    expect(html).toMatch(/--diffs-token-dark:var\(--atlas-syntax-keyword\)/);
  });
});
