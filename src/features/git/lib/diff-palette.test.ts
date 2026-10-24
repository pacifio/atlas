// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DIFF_VIEW_CSS } from "../components/diff-viewer/styled-code-view";
import { DIFF_THEME } from "./diff-theme";
import {
  applyDisplaySettings,
  type DisplaySettings,
} from "@/features/settings/lib/display-settings";

/**
 * The `diffPalette` setting recolours the review diff and the editor's change
 * gutter live, with no reload and no re-render: `display-settings.ts` writes
 * `<html data-diff-palette>`, a `globals.css` rule under that attribute
 * restates the diff variables, and everything that draws a diff names only
 * those variables. These tests hold each link of that chain.
 */

const ROOT = path.resolve(__dirname, "../../../..");
const GLOBALS = readFileSync(path.join(ROOT, "src/styles/globals.css"), "utf8");
const GUTTER = readFileSync(path.join(ROOT, "src/features/editor/lib/file-decorations.ts"), "utf8");

const PALETTE_VARS = [
  "--atlas-diff-added-text",
  "--atlas-diff-removed-text",
  "--atlas-diff-changed-bar",
  "--atlas-diff-modified-text",
];

/** The body of the blue-orange rule. */
function paletteRule(): string {
  const start = GLOBALS.indexOf('html:root[data-diff-palette="blue-orange"]');
  expect(start, "the blue-orange rule").toBeGreaterThan(-1);
  return GLOBALS.slice(start, GLOBALS.indexOf("\n}", start));
}

const BASE: DisplaySettings = {
  uiFontFamily: "",
  codeFontFamily: "",
  composerFontFamily: "",
  terminalFontFamily: "",
  editorFontSize: 13,
  terminalFontSize: 13,
  chatWidth: "normal",
  wordWrap: true,
  diffPalette: "theme",
  timeFormat: "system",
} as DisplaySettings;

afterEach(() => {
  delete document.documentElement.dataset.diffPalette;
});

describe("the diff palette", () => {
  it("switches by attribute alone, so a change applies at once", () => {
    applyDisplaySettings(BASE);
    expect(document.documentElement.dataset.diffPalette).toBe("theme");
    applyDisplaySettings({ ...BASE, diffPalette: "blue-orange" });
    expect(document.documentElement.dataset.diffPalette).toBe("blue-orange");
  });

  it("restates every diff colour under blue-orange, outranking the theme block", () => {
    const rule = paletteRule();
    for (const name of PALETTE_VARS) expect(rule, name).toContain(`${name}:`);
    // The theme writes its variables under `html:root`; the attribute
    // selector must be the more specific one, or the theme wins.
    expect(rule.startsWith('html:root[data-diff-palette="blue-orange"]')).toBe(true);
    // Additions, removals and changes stay three different colours.
    const value = (name: string) => rule.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim();
    const marks = [
      value("--atlas-diff-added-text"),
      value("--atlas-diff-removed-text"),
      value("--atlas-diff-changed-bar"),
    ];
    expect(new Set(marks).size).toBe(3);
  });

  it("gives the two non-key diff colours a default outside the palette", () => {
    const root = GLOBALS.slice(GLOBALS.indexOf("--atlas-diff-changed-bar:") - 200);
    expect(root).toMatch(/:root\s*{[^}]*--atlas-diff-changed-bar:[^}]*--atlas-diff-modified-text:/);
  });

  it("is what the review diff draws with: variables only, no resolved colours", () => {
    for (const name of ["--atlas-diff-added-text", "--atlas-diff-removed-text"]) {
      expect(DIFF_VIEW_CSS).toContain(`var(${name})`);
    }
    expect(DIFF_VIEW_CSS).toContain(
      "--diffs-modified-color-override: var(--atlas-diff-modified-text)",
    );
    // Line tints mix the palette hue in, rather than leaving the viewer to
    // derive them from colours it read once.
    expect(DIFF_VIEW_CSS).toMatch(
      /--diffs-bg-addition-override:[^;]*var\(--atlas-diff-added-text\)/,
    );
    expect(DIFF_VIEW_CSS).toMatch(
      /--diffs-bg-deletion-override:[^;]*var\(--atlas-diff-removed-text\)/,
    );
    expect(DIFF_VIEW_CSS).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    const colors = DIFF_THEME.colors ?? {};
    expect(colors["gitDecoration.addedResourceForeground"]).toBe("var(--atlas-diff-added-text)");
    expect(colors["gitDecoration.deletedResourceForeground"]).toBe(
      "var(--atlas-diff-removed-text)",
    );
    expect(colors["gitDecoration.modifiedResourceForeground"]).toBe(
      "var(--atlas-diff-modified-text)",
    );
  });

  it("is what the file view's change bars draw with", () => {
    expect(GUTTER).toContain('"var(--atlas-diff-added-text)"');
    expect(GUTTER).toContain('"var(--atlas-diff-changed-bar)"');
    expect(GUTTER).toContain('"var(--atlas-diff-removed-text)"');
  });
});
