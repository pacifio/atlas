import { describe, expect, it } from "vitest";
import { currentChoiceLabel, parseConfigOptions } from "./acp-config-options";

describe("parseConfigOptions", () => {
  it("reads a boolean knob", () => {
    const [opt] = parseConfigOptions([
      { id: "web-search", name: "Web search", boolean: { currentValue: true } },
    ]);
    expect(opt).toEqual({
      kind: "boolean",
      id: "web-search",
      name: "Web search",
      description: null,
      value: true,
    });
  });

  it("reads a select knob with its choices", () => {
    const [opt] = parseConfigOptions([
      {
        id: "thinking",
        name: "Thinking",
        description: "How long to reason",
        select: {
          currentValue: "medium",
          options: [
            { id: "low", name: "Low" },
            { id: "medium", name: "Medium", description: "Balanced" },
          ],
        },
      },
    ]);
    expect(opt.kind).toBe("select");
    if (opt.kind !== "select") throw new Error("unreachable");
    expect(opt.currentValue).toBe("medium");
    expect(opt.choices).toHaveLength(2);
    expect(opt.choices[1].description).toBe("Balanced");
  });

  /// Mode and model already have dedicated composer pickers, normalised
  /// upstream. Rendering them here too would give the user two controls for one
  /// setting that could visibly disagree.
  it("skips categories that already own a composer surface", () => {
    const parsed = parseConfigOptions([
      {
        id: "m",
        name: "Mode",
        category: "mode",
        select: { currentValue: "a", options: [{ id: "a", name: "A" }] },
      },
      {
        id: "mo",
        name: "Model",
        category: "model",
        select: { currentValue: "b", options: [{ id: "b", name: "B" }] },
      },
      { id: "t", name: "Thinking", category: "thought_level", boolean: { currentValue: false } },
    ]);
    expect(parsed.map((o) => o.id)).toEqual(["t"]);
  });

  /// The wire allows grouped select options; the composer popover is one flat
  /// list, and a nested menu would be a new visual pattern.
  it("flattens grouped select options", () => {
    const [opt] = parseConfigOptions([
      {
        id: "g",
        name: "Grouped",
        select: {
          currentValue: "b",
          options: {
            groups: [
              { name: "First", options: [{ id: "a", name: "A" }] },
              { name: "Second", options: [{ id: "b", name: "B" }] },
            ],
          },
        },
      },
    ]);
    if (opt.kind !== "select") throw new Error("unreachable");
    expect(opt.choices.map((c) => c.id)).toEqual(["a", "b"]);
  });

  /// A select with nothing to pick is a dead control — a menu that opens onto
  /// nothing is worse than no menu.
  it("drops a select with no choices", () => {
    expect(
      parseConfigOptions([{ id: "x", name: "X", select: { currentValue: "", options: [] } }]),
    ).toEqual([]);
  });

  /// The shape is `#[non_exhaustive]` and the whole feature is unstable, so one
  /// bad entry must not blank every control in the composer.
  it("skips malformed entries without dropping the good ones", () => {
    const parsed = parseConfigOptions([
      null,
      "nonsense",
      { name: "no id", boolean: { currentValue: true } },
      { id: "no-name", boolean: { currentValue: true } },
      { id: "unknown-kind", name: "Unknown" },
      { id: "ok", name: "OK", boolean: { currentValue: false } },
    ]);
    expect(parsed.map((o) => o.id)).toEqual(["ok"]);
  });

  it("returns nothing for a non-array blob", () => {
    expect(parseConfigOptions(undefined)).toEqual([]);
    expect(parseConfigOptions({})).toEqual([]);
  });

  /// A missing `currentValue` must read as false, not as "unknown/on".
  it("treats an absent boolean value as off", () => {
    const [opt] = parseConfigOptions([{ id: "b", name: "B", boolean: {} }]);
    expect(opt.kind === "boolean" && opt.value).toBe(false);
  });
});

describe("currentChoiceLabel", () => {
  it("labels booleans", () => {
    expect(
      currentChoiceLabel({ kind: "boolean", id: "a", name: "A", description: null, value: true }),
    ).toBe("On");
  });

  it("resolves a select's current choice to its name", () => {
    expect(
      currentChoiceLabel({
        kind: "select",
        id: "t",
        name: "T",
        description: null,
        currentValue: "hi",
        choices: [{ id: "hi", name: "High", description: null }],
      }),
    ).toBe("High");
  });

  /// An agent can report a current value that is not in its own options list;
  /// showing the raw id beats showing nothing.
  it("falls back to the raw id when the choice is unknown", () => {
    expect(
      currentChoiceLabel({
        kind: "select",
        id: "t",
        name: "T",
        description: null,
        currentValue: "mystery",
        choices: [{ id: "hi", name: "High", description: null }],
      }),
    ).toBe("mystery");
  });
});
