// Pins the option-matching rules the composer's pickers hang off. The critical
// one: effort is matched by ACP CATEGORY, not id — the id is agent-specific
// (codex-acp: `reasoning_effort`, claude-agent-acp: `effort`), and an id-only
// match is exactly how codex's effort picker went missing while claude's
// worked (fixed 2026-08-22).
import { describe, expect, it } from "vitest";
import {
  displayModeName,
  isEffortOption,
  optionLabel,
  optionValue,
  optionValues,
} from "./acp-config-options";
import type { AcpConfigOption } from "@/types/agents";

// Live-probed shapes (codex-acp 1.6.2, claude-agent-acp 0.70.0).
const codexEffort: AcpConfigOption = {
  id: "reasoning_effort",
  name: "Reasoning Effort",
  category: "thought_level",
  type: "select",
  currentValue: "medium",
  options: [
    { value: "low", name: "Low" },
    { value: "medium", name: "Medium" },
    { value: "high", name: "High" },
    { value: "xhigh", name: "Xhigh" },
    { value: "max", name: "Max" },
    { value: "ultra", name: "Ultra" },
  ],
};
const claudeEffort: AcpConfigOption = {
  id: "effort",
  name: "Effort",
  category: "thought_level",
  type: "select",
  currentValue: "medium",
  options: [{ value: "low", name: "Low" }],
};

describe("isEffortOption", () => {
  it("matches by category across agent-specific ids", () => {
    expect(isEffortOption(codexEffort)).toBe(true);
    expect(isEffortOption(claudeEffort)).toBe(true);
    // An agent that omits category but uses the conventional id still matches.
    expect(isEffortOption({ id: "effort", currentValue: "low" })).toBe(true);
  });

  it("rejects the options the composer deliberately does not render", () => {
    for (const opt of [
      { id: "mode", category: "mode" },
      { id: "model", category: "model" },
      { id: "fast", category: "model_config" },
      { id: "agent", category: null },
      { id: "collaboration_mode", category: "collaboration_mode" },
    ] satisfies AcpConfigOption[]) {
      expect(isEffortOption(opt)).toBe(false);
    }
  });
});

describe("option value/label helpers", () => {
  it("reads choices from the ACP wire fields (options[].value, not values[])", () => {
    // Wrong field names fail SILENTLY (the Rust side deserializes the list
    // with DefaultOnError) — pin the correct ones.
    expect(optionValues(codexEffort).map((v) => v.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(optionValue(codexEffort)).toBe("medium");
    expect(optionLabel(codexEffort)).toBe("Medium");
  });

  it("labels a boolean option by state", () => {
    expect(optionLabel({ id: "thinking", name: "Thinking", currentValue: true })).toBe(
      "Thinking: On",
    );
  });

  it("title-cases bare lowercase ids but preserves real names", () => {
    expect(displayModeName("build")).toBe("Build");
    expect(displayModeName("Accept Edits")).toBe("Accept Edits");
  });
});
