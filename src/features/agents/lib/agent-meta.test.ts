import { describe, expect, it, beforeEach, vi } from "vitest";

// agent-meta reaches into the registry store. Stub it so the module under test
// is exercised without a Tauri runtime or a React tree.
const registryState = {
  plugins: [] as { plugin_id: string; display_name?: string; external: boolean }[],
  registryEntries: [] as { id: string; name: string; iconDataUrl?: string | null }[],
};

vi.mock("../stores/agent-registry-store", () => ({
  useAgentRegistryStore: Object.assign(() => undefined, { getState: () => registryState }),
}));

const { switchableAgentIds, agentMeta, skillToolIdForAgent } = await import("./agent-meta");

beforeEach(() => {
  registryState.plugins = [];
  registryState.registryEntries = [];
});

describe("switchableAgentIds", () => {
  it("is just the native agent on a fresh install", () => {
    // THE fresh-install invariant, mirroring Zed: nothing is built in, so
    // until the user installs something the picker offers one agent — the one
    // that needs no install, no download and no sign-in.
    expect(switchableAgentIds()).toEqual(["cersei"]);
  });

  it("lists installed agents after the native one, sorted by label", () => {
    registryState.plugins = [
      { plugin_id: "opencode", external: true },
      { plugin_id: "amp-acp", display_name: "Amp", external: true },
      { plugin_id: "claude-acp", external: true },
    ];
    registryState.registryEntries = [{ id: "amp-acp", name: "Amp" }];
    // Labels: "Amp" < "Claude Code" < "OpenCode".
    expect(switchableAgentIds()).toEqual(["cersei", "amp-acp", "claude-acp", "opencode"]);
  });

  it("gives no id precedence over another", () => {
    // The ids Atlas used to hardcode are ordinary entries now: absent when not
    // installed, present when installed, in the same label order as any other.
    registryState.plugins = [{ plugin_id: "amp-acp", display_name: "Amp", external: true }];
    expect(switchableAgentIds()).toEqual(["cersei", "amp-acp"]);
    for (const id of ["claude-acp", "codex-acp", "cursor", "kilo"]) {
      expect(switchableAgentIds()).not.toContain(id);
    }
  });

  it("drops an agent as soon as it is uninstalled", () => {
    registryState.plugins = [{ plugin_id: "cursor", external: true }];
    expect(switchableAgentIds()).toContain("cursor");
    registryState.plugins = [];
    expect(switchableAgentIds()).not.toContain("cursor");
  });
});

describe("agentMeta", () => {
  it("treats an agent id as opaque — no rewriting, no aliases", () => {
    // Identity IS the registry id. Nothing is remapped on the way through, so
    // an unknown id survives verbatim instead of being folded into a
    // hardcoded one.
    for (const id of ["claude-acp", "codex-acp", "amp-acp", "claude-code-ts"]) {
      expect(agentMeta(id).pluginId).toBe(id);
      expect(agentMeta(id).agentType).toBe(id);
    }
  });

  it("brands the agents Atlas draws a glyph for", () => {
    // Presentation only: a branded agent gets Atlas's own label and glyph, and
    // everything else renders from its registry metadata.
    expect(agentMeta("claude-acp").label).toBe("Claude Code");
    expect(agentMeta("claude-acp").firstPartyIcon).toBe("claude-acp");
    expect(agentMeta("amp-acp").firstPartyIcon).toBeNull();
  });

  it("falls back to the native agent rather than throwing on a missing id", () => {
    for (const bad of [null, undefined, ""]) {
      expect(agentMeta(bad).pluginId).toBe("cersei");
    }
  });

  it("labels an unknown agent from its registry metadata, then from its id", () => {
    registryState.registryEntries = [{ id: "amp-acp", name: "Amp" }];
    expect(agentMeta("amp-acp").label).toBe("Amp");
    // Fully purged from the registry: still readable, never blank.
    expect(agentMeta("some-agent-acp").label).toBe("Some Agent Acp");
  });

  it("marks every ACP agent external and the native agent not", () => {
    expect(agentMeta("cersei").external).toBe(false);
    for (const id of ["claude-acp", "codex-acp", "amp-acp"]) {
      expect(agentMeta(id).external).toBe(true);
    }
  });
});

describe("skillToolIdForAgent (agent id → skills tool target)", () => {
  it("bridges registry ids to the CLI config dirs their adapters read", () => {
    // The skills registry keys enablement on tool ids ("claude-code" /
    // "codex" / "atlas"), which name on-disk dirs (.claude/skills, .codex).
    // Post-port agent ids must bridge or every pack mention filters out.
    expect(skillToolIdForAgent("claude-acp")).toBe("claude-code");
    expect(skillToolIdForAgent("codex-acp")).toBe("codex");
  });

  it("passes agents with no skills target through unchanged", () => {
    for (const id of ["cersei", "opencode", "cursor", "kilo", "amp-acp"]) {
      expect(skillToolIdForAgent(id)).toBe(id);
    }
  });
});
