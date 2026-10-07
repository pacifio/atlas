import { describe, expect, it } from "vitest";
import { NOMINAL_LINE_HEIGHT, highlightRect } from "./highlight-rect";

// Two consecutive lines of 11pt body text on a Letter page, x 72..360pt.
const LINES = [
  { top: 0.2288, bottom: 0.2427, left: 0.1176, right: 0.59 },
  { top: 0.249, bottom: 0.2629, left: 0.1176, right: 0.59 },
];

describe("highlightRect", () => {
  it("drops a tap", () => {
    expect(highlightRect({ x: 0.3, y: 0.23, w: 0.002, h: 0.002 }, LINES)).toBeNull();
  });

  it("keeps a box drag exactly as drawn", () => {
    const box = { x: 0.1, y: 0.2, w: 0.3, h: 0.05 };
    expect(highlightRect(box, LINES)).toEqual(box);
  });

  it("reads a flat drag along a line as that line", () => {
    const r = highlightRect({ x: 0.12, y: 0.236, w: 0.25, h: 0 }, LINES);
    expect(r).not.toBeNull();
    expect(r!.x).toBe(0.12);
    expect(r!.w).toBe(0.25);
    // Covers the whole glyph box of the first line, and nothing of the second.
    expect(r!.y).toBeLessThan(0.2288);
    expect(r!.y + r!.h).toBeGreaterThan(0.2427);
    expect(r!.y + r!.h).toBeLessThan(0.249);
  });

  it("gives a flat drag over no text a nominal line band centred on it", () => {
    const r = highlightRect({ x: 0.1, y: 0.5, w: 0.2, h: 0.001 }, LINES);
    expect(r!.h).toBeCloseTo(NOMINAL_LINE_HEIGHT);
    expect(r!.y + r!.h / 2).toBeCloseTo(0.5005);
  });

  it("keeps the nominal band on the page at its edges", () => {
    const r = highlightRect({ x: 0.1, y: 0, w: 0.2, h: 0 }, []);
    expect(r!.y).toBe(0);
    expect(r!.h).toBeCloseTo(NOMINAL_LINE_HEIGHT / 2);
  });

  it("takes the line in the column the stroke is in, not the other column's", () => {
    // Two columns whose baselines do not align: at y=0.307 the left column
    // has a line, and the right column is in the gap between two of its own.
    const twoColumn = [
      { top: 0.3, bottom: 0.314, left: 0.08, right: 0.46 },
      { top: 0.29, bottom: 0.304, left: 0.54, right: 0.92 },
      { top: 0.31, bottom: 0.324, left: 0.54, right: 0.92 },
    ];
    // A stroke across the right column there is over no line of ITS column,
    // so it gets the nominal band — never the left column's 0.300..0.314.
    const right = highlightRect({ x: 0.6, y: 0.307, w: 0.2, h: 0 }, twoColumn)!;
    expect(right.h).toBeCloseTo(NOMINAL_LINE_HEIGHT);
    // The same height in the left column snaps to the left column's line.
    const left = highlightRect({ x: 0.1, y: 0.307, w: 0.2, h: 0 }, twoColumn)!;
    expect(left.y).toBeLessThan(0.3);
    expect(left.y + left.h).toBeGreaterThan(0.314);
  });

  it("unions the runs of one line set in different fonts", () => {
    const mixed = [
      { top: 0.4, bottom: 0.414, left: 0.1, right: 0.3 },
      { top: 0.398, bottom: 0.416, left: 0.3, right: 0.5 }, // a bold, slightly larger run
    ];
    const r = highlightRect({ x: 0.15, y: 0.407, w: 0.3, h: 0 }, mixed)!;
    expect(r.y).toBeLessThan(0.398);
    expect(r.y + r.h).toBeGreaterThan(0.416);
  });

  it("is not stretched by a much taller run under the stroke", () => {
    // A drop cap (or a rotated margin label) spanning three lines.
    const withDropCap = [
      { top: 0.38, bottom: 0.43, left: 0.1, right: 0.14 },
      { top: 0.4, bottom: 0.414, left: 0.14, right: 0.6 },
    ];
    const r = highlightRect({ x: 0.1, y: 0.407, w: 0.4, h: 0 }, withDropCap)!;
    expect(r.y).toBeGreaterThan(0.38);
    expect(r.y + r.h).toBeLessThan(0.43);
  });
});
