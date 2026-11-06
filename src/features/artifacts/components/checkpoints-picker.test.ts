import { describe, expect, it } from "vitest";
import { sharedShas } from "./checkpoints-picker";

describe("sharedShas", () => {
  it("names the commits two Sessions produced, so their rows can say which Session", () => {
    const rows = [{ commitSha: "7d3e0a1" }, { commitSha: "3f6b8d0" }, { commitSha: "7d3e0a1" }];
    expect([...sharedShas(rows)]).toEqual(["7d3e0a1"]);
  });

  it("is empty when every commit has one Session", () => {
    expect(sharedShas([{ commitSha: "a" }, { commitSha: "b" }]).size).toBe(0);
  });
});
