// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
  values: {} as Record<string, Record<string, unknown>>,
}));
vi.mock("@/features/settings/lib/use-scoped-setting", () => ({
  projectSettingNow: (path: string, key: string) => settings.values[path]?.[key],
}));

import {
  preferredMergeMethod,
  projectMergeMethod,
  rememberMergeMethod,
  removeAgentCreditsOnMerge,
} from "./pull-request-prefs";

afterEach(() => {
  window.localStorage.clear();
  settings.values = {};
});

describe("the merge method a pull request starts on", () => {
  it("is the one the setting names", () => {
    rememberMergeMethod("rebase");
    expect(preferredMergeMethod("squash")).toBe("squash");
  });

  it("is the last one picked on this device for 'last'", () => {
    expect(preferredMergeMethod("last")).toBeNull();
    rememberMergeMethod("rebase");
    expect(preferredMergeMethod("last")).toBe("rebase");
  });

  it("follows the project's own setting", () => {
    settings.values["/shop"] = { pullRequestMergeMethod: "merge" };
    rememberMergeMethod("squash");
    expect(projectMergeMethod("/shop")).toBe("merge");
  });
});

describe("removeAgentCreditsOnMerge", () => {
  it("reads the project's setting", () => {
    settings.values["/shop"] = { removeAgentCreditsOnMerge: true };
    expect(removeAgentCreditsOnMerge("/shop")).toBe(true);
  });
});
