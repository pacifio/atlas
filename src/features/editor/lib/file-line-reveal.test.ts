import { describe, expect, it } from "vitest";
import { clampFileLine, resolveCenteredFileLineScrollTop } from "./file-line-reveal";

describe("resolveCenteredFileLineScrollTop", () => {
  it("corrects a stale estimate from the rendered line geometry", () => {
    expect(
      resolveCenteredFileLineScrollTop({
        scrollTop: 830,
        scrollHeight: 2_000,
        viewportTop: 100,
        viewportHeight: 400,
        fileTop: 20,
        estimatedLine: { top: 1_000, height: 20 },
        renderedLine: { top: 620, height: 20 },
      }),
    ).toBe(1_160);
  });

  it("centres an unrendered line on its estimate, clamped to the scroll range", () => {
    const base = {
      scrollTop: 0,
      scrollHeight: 2_000,
      viewportTop: 0,
      viewportHeight: 400,
      fileTop: 0,
    };
    expect(
      resolveCenteredFileLineScrollTop({ ...base, estimatedLine: { top: 1_000, height: 20 } }),
    ).toBe(810);
    expect(
      resolveCenteredFileLineScrollTop({ ...base, estimatedLine: { top: 1_990, height: 20 } }),
    ).toBe(1_600);
    expect(
      resolveCenteredFileLineScrollTop({ ...base, estimatedLine: { top: 40, height: 20 } }),
    ).toBe(0);
  });
});

describe("clampFileLine", () => {
  it("counts every line ending style", () => {
    expect(clampFileLine("a\nb\r\nc\rd", 99)).toBe(4);
  });

  it("keeps a line inside the file", () => {
    expect(clampFileLine("a\nb", 0)).toBe(1);
    expect(clampFileLine("a\nb", 2)).toBe(2);
  });
});
