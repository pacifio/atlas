// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  fileCacheKey,
  readRenderedPreference,
  renderedModeOf,
  writeRenderedPreference,
} from "./file-preview-mode";

afterEach(() => {
  localStorage.clear();
});

describe("renderedModeOf", () => {
  it.each([
    ["README.md", "markdown"],
    ["docs/page.MDX", "markdown"],
    ["data/orders.csv", "table"],
    ["data/metrics.tsv", "table"],
    ["public/landing.html", "html"],
    ["legacy/index.htm", "html"],
    ["src/main.ts", null],
    ["notes.md.bak", null],
  ])("%s → %s", (path, mode) => {
    expect(renderedModeOf(path)).toBe(mode);
  });
});

describe("the rendered preference", () => {
  it("defaults markdown to source and tables and pages to rendered", () => {
    expect(readRenderedPreference("markdown")).toBe(false);
    expect(readRenderedPreference("table")).toBe(true);
    expect(readRenderedPreference("html")).toBe(true);
  });

  it("remembers a choice per kind", () => {
    writeRenderedPreference("markdown", true);
    writeRenderedPreference("table", false);
    expect(readRenderedPreference("markdown")).toBe(true);
    expect(readRenderedPreference("table")).toBe(false);
    expect(readRenderedPreference("html")).toBe(true);
  });
});

describe("fileCacheKey", () => {
  it("changes with the contents, and only with them", () => {
    expect(fileCacheKey("a.ts", "x")).toBe(fileCacheKey("a.ts", "x"));
    expect(fileCacheKey("a.ts", "x")).not.toBe(fileCacheKey("a.ts", "y"));
    expect(fileCacheKey("a.ts", "x")).not.toBe(fileCacheKey("b.ts", "x"));
  });
});
