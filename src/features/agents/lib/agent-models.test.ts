import { describe, expect, it } from "vitest";
import { arrangeModels } from "./agent-models";

const advertised = [
  { id: "a", name: "A" },
  { id: "b", name: "B" },
  { id: "c", name: "C" },
];

describe("arrangeModels", () => {
  it("keeps the agent's order when the user set none", () => {
    expect(
      arrangeModels({ modelOrder: [], customModels: [] }, advertised).map((m) => m.id),
    ).toEqual(["a", "b", "c"]);
  });

  it("puts the user's order first and the rest after, in the agent's order", () => {
    const ids = arrangeModels({ modelOrder: ["c", "a"], customModels: [] }, advertised).map(
      (m) => m.id,
    );
    expect(ids).toEqual(["c", "a", "b"]);
  });

  it("adds custom models the agent doesn't advertise, and only those", () => {
    const models = arrangeModels(
      { modelOrder: ["x"], customModels: [{ id: "x" }, { id: "a", name: "Dup" }] },
      advertised,
    );
    expect(models.map((m) => m.id)).toEqual(["x", "a", "b", "c"]);
    expect(models[0]).toMatchObject({ id: "x", name: "x", custom: true });
    expect(models[1]?.name).toBe("A");
  });
});
