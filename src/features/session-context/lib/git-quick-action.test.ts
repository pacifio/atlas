import { describe, expect, it } from "vitest";

import {
  actionSteps,
  buildMenuItems,
  defaultBranchCopy,
  featureBranchName,
  requiresDefaultBranchConfirmation,
  resolveQuickAction,
  type GitActionInput,
} from "./git-quick-action";

const base: GitActionInput = {
  busy: false,
  branch: "feature",
  dirty: false,
  hasUpstream: true,
  hasRemote: true,
  isDefault: false,
  ahead: 0,
  behind: 0,
  aheadOfDefault: 0,
  hasOpenPr: false,
};

const label = (patch: Partial<GitActionInput>) => resolveQuickAction({ ...base, ...patch });

describe("resolveQuickAction", () => {
  it("is a disabled hint while busy or detached", () => {
    expect(label({ busy: true, dirty: true }).kind).toBe("hint");
    expect(label({ branch: null, dirty: true })).toMatchObject({ kind: "hint", label: "Commit" });
  });

  it("commits, pushes and opens a PR from a dirty feature branch", () => {
    expect(label({ dirty: true })).toMatchObject({
      action: "commit_push_pr",
      label: "Commit, push & PR",
    });
  });

  it("only commits and pushes when a PR is open or on the default branch", () => {
    expect(label({ dirty: true, hasOpenPr: true })).toMatchObject({ action: "commit_push" });
    expect(label({ dirty: true, isDefault: true })).toMatchObject({ action: "commit_push" });
  });

  it("only commits when there is nowhere to push", () => {
    expect(label({ dirty: true, hasUpstream: false, hasRemote: false })).toMatchObject({
      action: "commit",
    });
  });

  it("pushes a new branch on the way to its PR", () => {
    expect(label({ hasUpstream: false, aheadOfDefault: 2 })).toMatchObject({
      action: "create_pr",
      label: "Push & create PR",
    });
    expect(label({ hasUpstream: false, aheadOfDefault: 2, hasOpenPr: true })).toMatchObject({
      action: "push",
    });
    expect(label({ hasUpstream: false, aheadOfDefault: 0 }).kind).toBe("hint");
    expect(label({ hasUpstream: false, hasRemote: false }).kind).toBe("hint");
  });

  it("asks to sync a diverged branch and pulls a branch behind", () => {
    expect(label({ ahead: 1, behind: 1 })).toMatchObject({ kind: "hint", label: "Sync branch" });
    expect(label({ behind: 2 })).toMatchObject({ kind: "pull" });
  });

  it("prefers a push when a PR is open, else push and create one", () => {
    expect(label({ ahead: 1, hasOpenPr: true })).toMatchObject({ action: "push" });
    expect(label({ ahead: 1 })).toMatchObject({ action: "create_pr" });
  });

  it("offers Create PR for a synced branch ahead of the default branch", () => {
    expect(label({ aheadOfDefault: 3 })).toMatchObject({ action: "create_pr", label: "Create PR" });
    expect(label({ aheadOfDefault: 3, hasOpenPr: true }).kind).toBe("hint");
    expect(label({ aheadOfDefault: 0 }).kind).toBe("hint");
  });
});

describe("buildMenuItems", () => {
  const items = (patch: Partial<GitActionInput>) =>
    Object.fromEntries(
      buildMenuItems({ ...base, ...patch }).map((i) => [i.action, i.disabledReason]),
    );

  it("offers only Commit without a remote", () => {
    expect(buildMenuItems({ ...base, hasRemote: false }).map((i) => i.action)).toEqual(["commit"]);
  });

  it("drops Create PR while one is open", () => {
    expect(buildMenuItems({ ...base, hasOpenPr: true }).map((i) => i.action)).toEqual([
      "commit",
      "push",
    ]);
  });

  it("says why each item is off", () => {
    expect(items({})).toEqual({
      commit: "The working tree is clean.",
      push: "No local commits to push.",
      create_pr: "No local commits to include in a pull request.",
    });
    expect(items({ dirty: true }).push).toBe("Commit or stash local changes before pushing.");
    expect(items({ ahead: 1, behind: 1 }).push).toMatch(/behind/);
  });

  it("enables what can run", () => {
    expect(items({ dirty: true, ahead: 2, aheadOfDefault: 2 })).toEqual({
      commit: null,
      push: null,
      create_pr: null,
    });
  });
});

describe("default branch", () => {
  it("asks before anything that pushes from it", () => {
    expect(requiresDefaultBranchConfirmation("commit", true)).toBe(false);
    expect(requiresDefaultBranchConfirmation("push", true)).toBe(true);
    expect(requiresDefaultBranchConfirmation("push", false)).toBe(false);
  });

  it("never offers to open a PR from it in place", () => {
    expect(defaultBranchCopy("create_pr", "main").continueLabel).toBeNull();
    expect(defaultBranchCopy("commit_push", "main").continueLabel).toBe("Commit & push to main");
  });
});

describe("actionSteps", () => {
  it("maps each action to its steps", () => {
    expect(actionSteps("commit")).toEqual({ commit: true, push: false, pr: false });
    expect(actionSteps("create_pr")).toEqual({ commit: false, push: true, pr: true });
    expect(actionSteps("commit_push_pr")).toEqual({ commit: true, push: true, pr: true });
  });
});

describe("featureBranchName", () => {
  it("slugs the summary and avoids taken names", () => {
    expect(featureBranchName("Fix: the PDF drift!", [])).toBe("atlas/fix-the-pdf-drift");
    expect(featureBranchName("", ["atlas/changes", "Atlas/Changes-2"])).toBe("atlas/changes-3");
  });
});
