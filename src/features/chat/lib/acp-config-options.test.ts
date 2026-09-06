import { describe, expect, it } from "vitest";
import { modeSelectOf, modelSelectOf, parseConfigOptions } from "./acp-config-options";

describe("modeSelectOf", () => {
  // The official Claude adapter's only live mode signal: `config_option_update`
  // with `id: "mode"` (no category) — never `current_mode_update`.
  it("reads the Claude adapter's id-keyed mode select", () => {
    const got = modeSelectOf([
      {
        id: "mode",
        name: "Mode",
        type: "select",
        currentValue: "auto",
        options: [
          { value: "default", name: "Manual" },
          { value: "auto", name: "Auto" },
        ],
      },
    ]);
    expect(got?.currentMode).toBe("auto");
    expect(got?.availableModes.map((m) => m.id)).toEqual(["default", "auto"]);
  });

  it("reads a category-keyed mode select and ignores other knobs", () => {
    const got = modeSelectOf([
      {
        id: "thinking",
        type: "select",
        currentValue: "low",
        options: [{ value: "low", name: "Low" }],
      },
      {
        id: "approval",
        category: "mode",
        type: "select",
        currentValue: "full",
        options: [{ value: "full", name: "Full" }],
      },
    ]);
    expect(got?.currentMode).toBe("full");
    expect(modeSelectOf([{ id: "thinking", type: "boolean", currentValue: true }])).toBeNull();
  });
});

describe("parseConfigOptions", () => {
  it("reads a boolean knob", () => {
    const [opt] = parseConfigOptions([
      { id: "web-search", name: "Web search", type: "boolean", currentValue: true },
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
        type: "select",
        currentValue: "medium",
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium", description: "Balanced" },
        ],
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
        type: "select",
        currentValue: "a",
        options: [{ value: "a", name: "A" }],
      },
      {
        id: "mo",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "b",
        options: [{ value: "b", name: "B" }],
      },
      {
        id: "t",
        name: "Thinking",
        category: "thought_level",
        type: "boolean",
        currentValue: false,
      },
    ]);
    expect(parsed.map((o) => o.id)).toEqual(["t"]);
  });

  /// ...but only when the owning surface can actually render it. The mode and
  /// model pickers are selects; a model-category knob of any other kind is
  /// claimed by nobody, and skipping it here would make it invisible AND
  /// unsettable — the same hole that hid model selection in the first place.
  it("keeps an owned-category option the dedicated picker cannot render", () => {
    const parsed = parseConfigOptions([
      {
        id: "model-thinking",
        name: "Extended thinking",
        category: "model",
        type: "boolean",
        currentValue: true,
      },
      {
        id: "mo",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "b",
        options: [{ value: "b", name: "B" }],
      },
    ]);
    expect(parsed.map((o) => o.id)).toEqual(["model-thinking"]);
  });

  /// The wire allows grouped select options; the composer popover is one flat
  /// list, and a nested menu would be a new visual pattern.
  it("flattens grouped select options", () => {
    const [opt] = parseConfigOptions([
      {
        id: "g",
        name: "Grouped",
        type: "select",
        currentValue: "b",
        options: [
          { group: "first", name: "First", options: [{ value: "a", name: "A" }] },
          { group: "second", name: "Second", options: [{ value: "b", name: "B" }] },
        ],
      },
    ]);
    if (opt.kind !== "select") throw new Error("unreachable");
    expect(opt.choices.map((c) => c.id)).toEqual(["a", "b"]);
  });

  /// A select with nothing to pick is a dead control — a menu that opens onto
  /// nothing is worse than no menu.
  it("drops a select with no choices", () => {
    expect(
      parseConfigOptions([{ id: "x", name: "X", type: "select", currentValue: "", options: [] }]),
    ).toEqual([]);
  });

  /// The shape is `#[non_exhaustive]` and the whole feature is unstable, so one
  /// bad entry must not blank every control in the composer.
  it("skips malformed entries without dropping the good ones", () => {
    const parsed = parseConfigOptions([
      null,
      "nonsense",
      { name: "no id", type: "boolean", currentValue: true },
      { id: "no-name", type: "boolean", currentValue: true },
      { id: "unknown-kind", name: "Unknown" },
      { id: "future-kind", name: "Future", type: "_colour", currentValue: "red" },
      { id: "ok", name: "OK", type: "boolean", currentValue: false },
    ]);
    expect(parsed.map((o) => o.id)).toEqual(["ok"]);
  });

  it("returns nothing for a non-array blob", () => {
    expect(parseConfigOptions(undefined)).toEqual([]);
    expect(parseConfigOptions({})).toEqual([]);
  });

  /// A missing `currentValue` must read as false, not as "unknown/on".
  it("treats an absent boolean value as off", () => {
    const [opt] = parseConfigOptions([{ id: "b", name: "B", type: "boolean" }]);
    expect(opt.kind === "boolean" && opt.value).toBe(false);
  });
});

describe("modelSelectOf", () => {
  const modelOption = {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "sonnet",
    options: [
      { value: "sonnet", name: "Sonnet", description: "Fast" },
      { value: "opus", name: "Opus" },
    ],
  };

  /// ACP has no `models` field: model selection IS a `category: "model"`
  /// select, and this is what fills the composer's model pill from a live
  /// `config_options_updated` delta.
  it("projects the model-category select into the picker's shape", () => {
    const select = modelSelectOf([
      { id: "t", name: "Thinking", type: "boolean", currentValue: true },
      modelOption,
    ]);
    expect(select).toEqual({
      currentModel: "sonnet",
      availableModels: [
        { id: "sonnet", name: "Sonnet", description: "Fast" },
        { id: "opus", name: "Opus", description: undefined },
      ],
    });
  });

  /// Gating is on the advertised category, never on which agent this is
  /// (ADR-0002). An agent that advertises no model select has no model pill.
  it("is null when no option advertises the model category", () => {
    expect(modelSelectOf([])).toBeNull();
    expect(modelSelectOf(undefined)).toBeNull();
    expect(
      modelSelectOf([
        { id: "t", name: "Thinking", category: "thought_level", type: "boolean" },
        // The right category, but not a select — nothing to list.
        { id: "model", name: "Model", category: "model", type: "boolean", currentValue: true },
        // A select with no category is unknowable, so not the model pill.
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "a",
          options: [{ value: "a", name: "A" }],
        },
      ]),
    ).toBeNull();
  });

  /// An empty list is a dead picker, same rule as the generic knobs.
  it("is null when the model select offers nothing", () => {
    expect(modelSelectOf([{ ...modelOption, currentValue: "", options: [] }])).toBeNull();
  });
});
