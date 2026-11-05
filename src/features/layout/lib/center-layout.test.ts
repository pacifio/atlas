import { describe, expect, it } from "vitest";
import { initialCenterLayout } from "./center-layout";

const both = [
  { id: "main", shown: true },
  { id: "side", shown: true },
];
const sideHidden = [
  { id: "main", shown: true },
  { id: "side", shown: false },
];
const mainHidden = [
  { id: "main", shown: false },
  { id: "side", shown: true },
];

describe("initialCenterLayout", () => {
  it("passes nothing saved through as undefined", () => {
    expect(initialCenterLayout(undefined, both)).toBeUndefined();
  });

  it("drops a layout with a non-finite size", () => {
    expect(initialCenterLayout({ main: Number.NaN, side: 40 }, both)).toBeUndefined();
    expect(initialCenterLayout({ main: Infinity, side: 40 }, both)).toBeUndefined();
  });

  it("drops a layout that does not sum to 100", () => {
    expect(initialCenterLayout({ main: 60, side: 30 }, both)).toBeUndefined();
    expect(initialCenterLayout({ main: 60, side: 40.4 }, both)).toEqual({ main: 60, side: 40.4 });
  });

  it("drops a layout saved for a different set of columns", () => {
    expect(initialCenterLayout({ main: 60, other: 40 }, both)).toBeUndefined();
    expect(initialCenterLayout({ main: 100 }, both)).toBeUndefined();
    expect(initialCenterLayout({ main: 50, side: 25, third: 25 }, both)).toBeUndefined();
  });

  it("returns the saved layout as-is when every column is shown", () => {
    const saved = { main: 62, side: 38 };
    expect(initialCenterLayout(saved, both)).toBe(saved);
  });

  it("leaves a shown column saved at 0 for the panel to expand", () => {
    const saved = { main: 100, side: 0 };
    expect(initialCenterLayout(saved, both)).toBe(saved);
  });

  it("returns a hidden column already at 0 as saved", () => {
    const saved = { main: 100, side: 0 };
    expect(initialCenterLayout(saved, sideHidden)).toBe(saved);
  });

  it("collapses a hidden column and gives its share to the shown one", () => {
    expect(initialCenterLayout({ main: 60, side: 40 }, sideHidden)).toEqual({ main: 100, side: 0 });
    // Maximized surfaces: the session column is the hidden one.
    expect(initialCenterLayout({ main: 60, side: 40 }, mainHidden)).toEqual({ main: 0, side: 100 });
  });

  it("spreads a hidden column's share over the shown ones by their sizes", () => {
    const columns = [
      { id: "a", shown: false },
      { id: "b", shown: true },
      { id: "c", shown: true },
    ];
    expect(initialCenterLayout({ a: 40, b: 40, c: 20 }, columns)).toEqual({
      a: 0,
      b: 66.66666666666667,
      c: 33.333333333333336,
    });
  });

  it("spreads it evenly when the shown columns were all saved at 0", () => {
    const columns = [
      { id: "a", shown: false },
      { id: "b", shown: true },
      { id: "c", shown: true },
    ];
    expect(initialCenterLayout({ a: 100, b: 0, c: 0 }, columns)).toEqual({ a: 0, b: 50, c: 50 });
  });
});
