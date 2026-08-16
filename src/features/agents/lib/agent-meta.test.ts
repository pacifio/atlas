import { describe, expect, it, beforeEach, vi } from "vitest";

// agent-meta reaches into two zustand stores. Stub both so the module under
// test is exercised without a Tauri runtime or a React tree.
const registryState = {
  plugins: [] as { plugin_id: string; external: boolean }[],
  registryEntries: [],
};
const projectState = { settings: { disabledBuiltinAgents: [] as string[] } };

vi.mock("../stores/agent-registry-store", () => ({
  useAgentRegistryStore: Object.assign(() => undefined, { getState: () => registryState }),
}));
vi.mock("@/features/project/stores/project-store", () => ({
  useProjectStore: Object.assign(() => undefined, { getState: () => projectState }),
}));

const { switchableAgentIds, isAgentDisabled } = await import("./agent-meta");

beforeEach(() => {
  registryState.plugins = [];
  projectState.settings.disabledBuiltinAgents = [];
});

describe("isAgentDisabled", () => {
  it("is false for everything by default", () => {
    for (const id of ["cursor", "opencode", "kilo", "claude-code", "codex", "cersei"]) {
      expect(isAgentDisabled(id)).toBe(false);
    }
  });

  it("reports an optional built-in the user turned off", () => {
    projectState.settings.disabledBuiltinAgents = ["cursor"];
    expect(isAgentDisabled("cursor")).toBe(true);
    expect(isAgentDisabled("kilo")).toBe(false);
  });

  it("refuses to disable the agents Atlas is built around", () => {
    // Mirrors the Rust guard: a stale/hand-edited list naming these is ignored
    // rather than honoured, so Claude can never be switched off.
    projectState.settings.disabledBuiltinAgents = ["claude-code", "codex", "cersei"];
    expect(isAgentDisabled("claude-code")).toBe(false);
    expect(isAgentDisabled("codex")).toBe(false);
    expect(isAgentDisabled("cersei")).toBe(false);
  });

  it("has no say over external agents", () => {
    projectState.settings.disabledBuiltinAgents = ["amp-acp"];
    expect(isAgentDisabled("amp-acp")).toBe(false);
  });
});

describe("switchableAgentIds", () => {
  it("lists every built-in when nothing is turned off", () => {
    expect(switchableAgentIds()).toEqual([
      "claude-code",
      "codex",
      "opencode",
      "cursor",
      "kilo",
      "cersei",
    ]);
  });

  it("drops the agents the user turned off, keeping the rest in order", () => {
    projectState.settings.disabledBuiltinAgents = ["opencode", "kilo"];
    expect(switchableAgentIds()).toEqual(["claude-code", "codex", "cursor", "cersei"]);
  });

  it("still lists installed externals alongside the enabled built-ins", () => {
    registryState.plugins = [{ plugin_id: "amp-acp", external: true }];
    projectState.settings.disabledBuiltinAgents = ["cursor", "opencode", "kilo"];
    expect(switchableAgentIds()).toEqual(["claude-code", "codex", "cersei", "amp-acp"]);
  });
});
