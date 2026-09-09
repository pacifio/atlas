import { describe, expect, it } from "vitest";
import { pickPaneInDirection } from "./pane-navigation";

// A 2×2 grid:  A B
//              C D
const grid = {
  A: { left: 0, top: 0, width: 100, height: 100 },
  B: { left: 101, top: 0, width: 100, height: 100 },
  C: { left: 0, top: 101, width: 100, height: 100 },
  D: { left: 101, top: 101, width: 100, height: 100 },
};

describe("pickPaneInDirection", () => {
  it("moves along rows and columns", () => {
    expect(pickPaneInDirection(grid, "A", "right")).toBe("B");
    expect(pickPaneInDirection(grid, "B", "left")).toBe("A");
    expect(pickPaneInDirection(grid, "A", "down")).toBe("C");
    expect(pickPaneInDirection(grid, "D", "up")).toBe("B");
  });

  it("returns null at an edge", () => {
    expect(pickPaneInDirection(grid, "A", "left")).toBeNull();
    expect(pickPaneInDirection(grid, "A", "up")).toBeNull();
    expect(pickPaneInDirection(grid, "D", "right")).toBeNull();
  });

  it("prefers the neighbour with the larger overlap", () => {
    const rects = {
      X: { left: 0, top: 0, width: 100, height: 200 },
      small: { left: 101, top: 0, width: 100, height: 40 },
      big: { left: 101, top: 41, width: 100, height: 159 },
    };
    expect(pickPaneInDirection(rects, "X", "right")).toBe("big");
  });

  it("ignores panes with no orthogonal overlap", () => {
    const rects = {
      A: { left: 0, top: 0, width: 100, height: 100 },
      far: { left: 101, top: 300, width: 100, height: 100 },
    };
    expect(pickPaneInDirection(rects, "A", "right")).toBeNull();
  });
});
