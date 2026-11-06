import { describe, expect, it } from "vitest";
import { rowForCheckout } from "./board-key";

describe("rowForCheckout", () => {
  const shared = { id: "s1", projectPath: "/repo", remoteProjectId: "prj_1" };

  it("finds the shared row a commit's session card only knows by checkout", () => {
    expect(rowForCheckout([shared], "s1", "/repo")).toBe(shared);
  });

  it("finds nothing for a Session the checkout has no row for", () => {
    expect(rowForCheckout([shared], "s2", "/repo")).toBeUndefined();
    expect(rowForCheckout([shared], "s1", "/elsewhere")).toBeUndefined();
  });

  it("refuses to guess between two copies of a re-homed Project", () => {
    const moved = { ...shared, remoteProjectId: "prj_2" };
    expect(rowForCheckout([shared, moved], "s1", "/repo")).toBeUndefined();
  });
});
