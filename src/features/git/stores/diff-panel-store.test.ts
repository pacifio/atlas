import { describe, expect, it } from "vitest";
import {
  MAX_REMEMBERED_SCOPES,
  migrateDiffPanelState,
  readStoredScope,
  SCOPE_LABEL,
  withRecent,
} from "./diff-panel-store";

describe("scope names and stored values", () => {
  it("names the scopes as the menu reads them", () => {
    expect(SCOPE_LABEL).toEqual({
      "branch-range": "Changes",
      "working-tree": "Uncommitted",
      turn: "Latest turn",
    });
  });

  it("keeps every stored value, folds the old session scope into Changes, and drops junk", () => {
    expect(readStoredScope("branch-range")).toBe("branch-range");
    expect(readStoredScope("working-tree")).toBe("working-tree");
    expect(readStoredScope("turn")).toBe("turn");
    expect(readStoredScope("session")).toBe("branch-range");
    expect(readStoredScope("nonsense")).toBeUndefined();
    expect(readStoredScope(undefined)).toBeUndefined();
  });

  it("migrates a version 0 state's scopes and leaves everything else as stored", () => {
    const migrated = migrateDiffPanelState({
      scope: { a: "session", b: "working-tree", c: "turn", d: "gone" },
      turn: { c: "latest" },
      baseRef: { "/repo": "origin/main" },
      layout: "split",
    });
    expect(migrated.scope).toEqual({ a: "branch-range", b: "working-tree", c: "turn" });
    expect(migrated.turn).toEqual({ c: "latest" });
    expect(migrated.baseRef).toEqual({ "/repo": "origin/main" });
    expect(migrated.layout).toBe("split");
    expect(migrateDiffPanelState(undefined).scope).toEqual({});
  });
});

describe("withRecent", () => {
  it("moves a re-set key to the end", () => {
    const next = withRecent({ a: 1, b: 2 }, "a", 3);
    expect(Object.entries(next)).toEqual([
      ["b", 2],
      ["a", 3],
    ]);
  });

  it("drops the oldest past the cap", () => {
    let record: Record<string, number> = {};
    for (let i = 0; i < MAX_REMEMBERED_SCOPES + 5; i++) record = withRecent(record, `tab${i}`, i);
    const keys = Object.keys(record);
    expect(keys).toHaveLength(MAX_REMEMBERED_SCOPES);
    expect(keys[0]).toBe("tab5");
    expect(keys[keys.length - 1]).toBe(`tab${MAX_REMEMBERED_SCOPES + 4}`);
  });
});
