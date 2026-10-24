import { describe, expect, it } from "vitest";
import { resolveQuickAction, type QuickActionInput } from "./quick-action";

const base: QuickActionInput = {
  isRepo: true,
  branch: "feat/x",
  detached: false,
  changedFiles: 0,
  upstream: "origin/feat/x",
  ahead: 0,
  behind: 0,
  busy: false,
  hasOpenPr: false,
  isDefaultBranch: false,
};

const kindOf = (patch: Partial<QuickActionInput>) =>
  resolveQuickAction({ ...base, ...patch })?.kind ?? null;
const labelOf = (patch: Partial<QuickActionInput>) =>
  resolveQuickAction({ ...base, ...patch })?.label ?? null;

describe("resolveQuickAction", () => {
  it("offers nothing outside a repository", () => {
    expect(resolveQuickAction({ ...base, isRepo: false })).toBeNull();
  });

  it("is a hint while a git op runs, whatever else is true", () => {
    expect(kindOf({ busy: true, ahead: 3 })).toBe("hint");
  });

  it("asks for a branch when HEAD is detached", () => {
    expect(kindOf({ detached: true, ahead: 1 })).toBe("hint");
  });

  it("sends local changes to Source Control, naming where they lead", () => {
    expect(resolveQuickAction({ ...base, changedFiles: 2 })).toEqual({
      kind: "open-changes",
      label: "Commit, push & PR…",
    });
    expect(labelOf({ changedFiles: 2, hasOpenPr: true })).toBe("Commit & push…");
    expect(labelOf({ changedFiles: 2, isDefaultBranch: true, upstream: null })).toBe("Commit…");
  });

  it("pushes a new branch on the way to its pull request", () => {
    expect(resolveQuickAction({ ...base, upstream: null })).toEqual({
      kind: "create-pr",
      label: "Push & create PR",
    });
    expect(kindOf({ upstream: null, hasOpenPr: true })).toBe("publish");
    expect(kindOf({ upstream: null, isDefaultBranch: true })).toBe("publish");
  });

  it("refuses to guess on a diverged branch", () => {
    expect(kindOf({ ahead: 1, behind: 1 })).toBe("hint");
  });

  it("pulls when behind", () => {
    expect(kindOf({ behind: 2 })).toBe("pull");
  });

  it("pushes and opens a PR when ahead, or only pushes when one is open", () => {
    expect(labelOf({ ahead: 2 })).toBe("Push & create PR");
    expect(kindOf({ ahead: 2, hasOpenPr: true })).toBe("push");
    expect(kindOf({ ahead: 2, isDefaultBranch: true })).toBe("push");
  });

  it("offers Create PR on a pushed branch without one", () => {
    expect(resolveQuickAction(base)).toEqual({ kind: "create-pr", label: "Create PR" });
  });

  it("says so when there is nothing to do", () => {
    expect(resolveQuickAction({ ...base, hasOpenPr: true })).toMatchObject({
      kind: "hint",
      label: "Push",
    });
  });
});
