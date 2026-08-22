// @vitest-environment happy-dom
// The cache exists to make agent switching feel instant: an agent's advertised
// option SET is static, but learning it costs an npx cold start + ACP
// handshake (~2-3s). These pin the read guards, because a bad cache paints
// pickers that fail on click rather than simply missing.
import { beforeEach, describe, expect, it } from "vitest";
import { loadCachedAcpConfigOptions, saveCachedAcpConfigOptions } from "./acp-config-options-cache";
import type { AcpConfigOption } from "@/types/agents";

const effort: AcpConfigOption = {
  id: "reasoning_effort",
  name: "Reasoning Effort",
  category: "thought_level",
  type: "select",
  currentValue: "medium",
  options: [
    { value: "low", name: "Low" },
    { value: "high", name: "High" },
  ],
};

beforeEach(() => localStorage.clear());

describe("acp config-options cache", () => {
  it("round-trips per agent, keeping agents isolated", () => {
    saveCachedAcpConfigOptions("codex-acp", [effort]);
    expect(loadCachedAcpConfigOptions("codex-acp")).toEqual([effort]);
    // A different agent must not read codex's list — cross-agent bleed is how
    // the modes cache once poisoned a picker with another agent's ids.
    expect(loadCachedAcpConfigOptions("claude-acp")).toBeNull();
  });

  it("is a miss before an agent has ever been bound", () => {
    expect(loadCachedAcpConfigOptions("amp-acp")).toBeNull();
  });

  it("does not cache an empty advertisement", () => {
    // "advertises none" is already the correct render (the pill's Default
    // placeholder) and is indistinguishable from a miss on read.
    saveCachedAcpConfigOptions("gemini", []);
    expect(loadCachedAcpConfigOptions("gemini")).toBeNull();
  });

  it("treats a corrupt or id-less entry as a miss", () => {
    localStorage.setItem("atlas:acp-config-options:v1:x", "{not json");
    expect(loadCachedAcpConfigOptions("x")).toBeNull();
    // An option with no id can't be written back with set_config_option, so
    // painting it would produce a picker whose every click fails.
    saveCachedAcpConfigOptions("y", [{ id: "", currentValue: "low" }]);
    localStorage.setItem(
      "atlas:acp-config-options:v1:y",
      JSON.stringify([{ currentValue: "low" }]),
    );
    expect(loadCachedAcpConfigOptions("y")).toBeNull();
  });
});
