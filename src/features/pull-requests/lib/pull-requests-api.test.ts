import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { ghGate, resetGhGateForTests } from "./pr-errors";
import {
  prAction,
  prDetail,
  prDiff,
  prDiffFileContents,
  prImage,
  prList,
  prReact,
  prSetFilesViewed,
} from "./pull-requests-api";

beforeEach(() => invoke.mockResolvedValue(null));
afterEach(() => {
  invoke.mockReset();
  resetGhGateForTests();
});

describe("pull-requests-api", () => {
  it("passes flat camelCase arguments, as the Rust commands name them", async () => {
    await prList("/repo", { state: "merged", limit: 10 });
    expect(invoke).toHaveBeenLastCalledWith("pr_list", {
      path: "/repo",
      query: { state: "merged", limit: 10 },
    });
    await prDiff("/repo", 7, "2");
    expect(invoke).toHaveBeenLastCalledWith("pr_diff", {
      path: "/repo",
      number: 7,
      cursor: "2",
      commit: null,
    });
    await prDiffFileContents("/repo", 7, "rename-changed", "a.ts", "b.ts");
    expect(invoke).toHaveBeenLastCalledWith("pr_diff_file_contents", {
      path: "/repo",
      number: 7,
      commit: null,
      changeType: "rename-changed",
      oldPath: "a.ts",
      newPath: "b.ts",
    });
    await prReact("/repo", 7, null, "heart", true);
    expect(invoke).toHaveBeenLastCalledWith("pr_react", {
      path: "/repo",
      number: 7,
      subjectId: null,
      content: "heart",
      reacted: true,
    });
    await prSetFilesViewed("/repo", 7, [{ path: "a.ts", viewed: true }]);
    expect(invoke).toHaveBeenLastCalledWith("pr_set_files_viewed", {
      path: "/repo",
      number: 7,
      files: [{ path: "a.ts", viewed: true }],
    });
    await prAction("/repo", 7, { action: "merge", mergeMethod: "squash" });
    expect(invoke).toHaveBeenLastCalledWith("pr_action", {
      path: "/repo",
      number: 7,
      input: { action: "merge", mergeMethod: "squash" },
    });
  });

  it("rejects with a classified PrError", async () => {
    invoke.mockRejectedValueOnce({ kind: "notFound" });
    await expect(prDetail("/repo", 1)).rejects.toEqual({ kind: "notFound" });
    invoke.mockRejectedValueOnce("connection reset");
    await expect(prDetail("/repo", 1)).rejects.toEqual({
      kind: "network",
      message: "connection reset",
    });
  });

  it("stops spawning gh for every repository once it is signed out", async () => {
    invoke.mockRejectedValueOnce({ kind: "notAuthenticated" });
    await expect(prDetail("/repo/a", 1)).rejects.toEqual({ kind: "notAuthenticated" });
    expect(ghGate()?.kind).toBe("notAuthenticated");
    await expect(prList("/repo/b")).rejects.toEqual({ kind: "notAuthenticated" });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("holds reads back until a rate limit's reset", async () => {
    const retryAt = Date.now() + 60_000;
    invoke.mockRejectedValueOnce({ kind: "rateLimited", retryAt });
    await expect(prList("/repo")).rejects.toMatchObject({ kind: "rateLimited" });
    await expect(prDetail("/repo", 2)).rejects.toEqual({ kind: "rateLimited", retryAt });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("leaves images out of the gate: an image is not an API read", async () => {
    invoke.mockRejectedValueOnce({ kind: "notAuthenticated" });
    await expect(prDetail("/repo", 1)).rejects.toBeTruthy();
    invoke.mockResolvedValueOnce({ contentType: "image/png", data: "AA==" });
    await expect(prImage("/repo", "https://camo.githubusercontent.com/x")).resolves.toEqual({
      contentType: "image/png",
      data: "AA==",
    });
  });
});
