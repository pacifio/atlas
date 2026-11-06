import { describe, expect, it } from "vitest";
import { axisLabelAt } from "./daily-glyph-chart";

const labelled = (n: number, every: number) =>
  Array.from({ length: n }, (_, i) => i).filter((i) => axisLabelAt(i, n, every));

describe("axisLabelAt", () => {
  it("labels every nth day and always the last", () => {
    expect(labelled(30, 5)).toEqual([0, 5, 10, 15, 20, 25, 29]);
  });

  it("drops a regular label that would sit on top of the last one", () => {
    // 26 is one column before the last (27); its label would overlap.
    expect(labelled(28, 5)).toEqual([0, 5, 10, 15, 20, 27]);
  });

  it("labels a single day", () => {
    expect(labelled(1, 1)).toEqual([0]);
  });
});
