import { describe, expect, it } from "vitest";
import { placeProjectNames } from "./sidebar-grouping";

const row = (projectName: string, elsewhere = false) => ({ projectName, elsewhere });

describe("placeProjectNames", () => {
  it("names nothing inside the open project", () => {
    expect(placeProjectNames([row("atlas"), row("atlas")], false)).toEqual([
      { heading: null, showProject: false },
      { heading: null, showProject: false },
    ]);
  });

  it("names a row from another project on its own card", () => {
    expect(placeProjectNames([row("atlas"), row("docs", true)], false)).toEqual([
      { heading: null, showProject: false },
      { heading: null, showProject: true },
    ]);
  });

  it("heads each run of a mixed list, and names no card", () => {
    const placed = placeProjectNames(
      [row("atlas", true), row("atlas", true), row("docs", true), row("atlas", true)],
      true,
    );
    expect(placed.map((p) => p.heading)).toEqual(["atlas", null, "docs", "atlas"]);
    expect(placed.every((p) => !p.showProject)).toBe(true);
  });

  it("heads a list with only one project when no project is open", () => {
    expect(placeProjectNames([row("atlas", true)], true)[0]!.heading).toBe("atlas");
  });

  it("heads what the filter left, not what it removed", () => {
    // The first "docs" row was filtered out; the next one still gets the heading.
    expect(placeProjectNames([row("atlas"), row("docs")], true).map((p) => p.heading)).toEqual([
      "atlas",
      "docs",
    ]);
  });
});
