// The open pull request row's one action: Resolve on a conflict, Ready on a
// draft, Merge once checks pass, and nothing while checks run or fail, or
// where the viewer may not act.

import { describe, expect, it } from "vitest";

import { resolvePullRequestRowAction } from "./pull-request-rows";

type Detail = Parameters<typeof resolvePullRequestRowAction>[0];

const detail = (over: Partial<Detail> = {}): Detail =>
  ({
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    checksState: "passing",
    capabilities: { actions: ["ready", "merge"], mergeMethods: ["squash", "merge"] },
    viewerPermissions: { actions: ["ready", "merge"] },
    mergeCapabilities: { squash: true, merge: false, rebase: false },
    ...over,
  }) as Detail;

describe("resolvePullRequestRowAction", () => {
  it("merges an open pull request whose checks pass", () => {
    expect(resolvePullRequestRowAction(detail())).toBe("merge");
  });

  it("resolves a conflict before anything else, draft or not", () => {
    expect(
      resolvePullRequestRowAction(detail({ mergeability: "conflicting", isDraft: true })),
    ).toBe("resolve");
  });

  it("marks a draft ready, where the viewer may", () => {
    expect(resolvePullRequestRowAction(detail({ isDraft: true }))).toBe("ready");
    expect(
      resolvePullRequestRowAction(
        detail({ isDraft: true, viewerPermissions: { actions: [] } as never }),
      ),
    ).toBeNull();
  });

  it("offers nothing while checks run or fail, or with no merge method allowed", () => {
    expect(resolvePullRequestRowAction(detail({ checksState: "pending" }))).toBeNull();
    expect(resolvePullRequestRowAction(detail({ checksState: "failing" }))).toBeNull();
    expect(
      resolvePullRequestRowAction(
        detail({ mergeCapabilities: { squash: false, merge: false, rebase: false } as never }),
      ),
    ).toBeNull();
  });

  it("offers nothing on a merged or closed pull request", () => {
    expect(resolvePullRequestRowAction(detail({ state: "merged" }))).toBeNull();
    expect(resolvePullRequestRowAction(detail({ state: "closed" }))).toBeNull();
  });
});
