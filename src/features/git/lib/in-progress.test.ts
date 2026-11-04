import { describe, expect, it } from "vitest";
import { blockedByOperation, inProgressLabel } from "./in-progress";

const none = { merge: false, rebase: false, cherryPick: false, revert: false };

describe("inProgressLabel", () => {
  it("names each operation", () => {
    expect(inProgressLabel({ ...none, merge: true })).toBe("merge");
    expect(inProgressLabel({ ...none, rebase: true })).toBe("rebase");
    expect(inProgressLabel({ ...none, cherryPick: true })).toBe("cherry-pick");
    expect(inProgressLabel({ ...none, revert: true })).toBe("revert");
  });

  it("is null with no operation", () => {
    expect(inProgressLabel(null)).toBeNull();
    expect(inProgressLabel(undefined)).toBeNull();
    expect(inProgressLabel(none)).toBeNull();
  });

  it("checks merge before the rest", () => {
    expect(inProgressLabel({ merge: true, rebase: true, cherryPick: true, revert: true })).toBe(
      "merge",
    );
  });

  it("builds the blocked tooltip", () => {
    expect(blockedByOperation("rebase")).toBe("Finish the rebase in progress first");
  });
});
