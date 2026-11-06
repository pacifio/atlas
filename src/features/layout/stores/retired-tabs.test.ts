// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
// The store's own predicate, not a copy — see org-tabs.test.ts.
import { isRetiredTab } from "./layout-store";

/**
 * The standalone Git Diff module (a blank "diff" tab with a file tree and a
 * commit picker) was retired for the commit tab. Layouts saved before that
 * still hold one; restoring it would bring back a surface no menu opens.
 */
describe("isRetiredTab", () => {
  it("drops a Git Diff tab with no file — the old module", () => {
    expect(isRetiredTab({ type: "diff", data: {} })).toBe(true);
    expect(isRetiredTab({ type: "diff", data: { file: "" } })).toBe(true);
    expect(isRetiredTab({ type: "diff" })).toBe(true);
  });

  it("keeps a Git Diff tab for one file", () => {
    expect(isRetiredTab({ type: "diff", data: { repoPath: "/r", file: "src/a.ts" } })).toBe(false);
  });

  it("keeps every other tab type, data or not", () => {
    expect(isRetiredTab({ type: "commit", data: { repoPath: "/r", sha: "abc" } })).toBe(false);
    expect(isRetiredTab({ type: "terminal", data: {} })).toBe(false);
  });
});
