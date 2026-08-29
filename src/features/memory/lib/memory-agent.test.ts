import { describe, it, expect, beforeEach, vi } from "vitest";

// The bridge resolves through the real `agentMeta`, which reads the registry
// store. Stub the store so these tests describe the mapping, not the registry.
const registryState: {
  plugins: unknown[];
  registryEntries: unknown[];
  catalogById: Record<string, unknown>;
  signature: string;
} = {
  plugins: [],
  registryEntries: [],
  catalogById: {},
  signature: "",
};

vi.mock("@/features/agents/stores/agent-registry-store", () => ({
  useAgentRegistryStore: Object.assign(() => registryState.signature, {
    getState: () => registryState,
  }),
}));

import { agentMetaForSource, pluginIdForSource } from "./memory-agent";

beforeEach(() => {
  registryState.plugins = [];
  registryState.registryEntries = [];
  registryState.catalogById = {};
  registryState.signature = "";
});

describe("pluginIdForSource", () => {
  it("maps every legacy corpus spelling of a first-party agent onto one id", () => {
    // The corpus writes bare sources; capture stamped adapter ids before the
    // ACP port. Both must land on the SAME registry id, or the same agent
    // renders twice under two identities — the bug this bridge exists to fix.
    for (const s of ["claude", "claude-code", "claude-code-ts", "claude-code-rs"]) {
      expect(pluginIdForSource(s)).toBe("claude-acp");
    }
    expect(pluginIdForSource("codex")).toBe("codex-acp");
  });

  it("passes a registry id through untouched", () => {
    // A registry-installed agent already tags its rows with its plugin id.
    for (const id of ["amp-acp", "opencode", "cursor", "kilo", "claude-acp", "codex-acp"]) {
      expect(pluginIdForSource(id)).toBe(id);
    }
  });

  it("falls back to the native agent for a missing source", () => {
    for (const bad of [null, undefined, ""]) {
      expect(pluginIdForSource(bad)).toBe("cersei");
    }
  });

  it("leaves the native agent alone", () => {
    expect(pluginIdForSource("cersei")).toBe("cersei");
  });
});

describe("agentMetaForSource", () => {
  it("resolves a legacy corpus source to its branded identity", () => {
    // "claude" matches no plugin id, so before the bridge this fell through to
    // a monogram (or, in the timeline, a hardcoded Claude glyph for everyone).
    // On this branch any `claude*` id resolves to the FIRST-PARTY Claude
    // branding (`agent-meta`'s deliberate branding collapse), so the assertion
    // pins the branded identity, not the registry id spelling.
    const meta = agentMetaForSource("claude");
    expect(meta.agentType).toBe("claude-code");
    expect(meta.label).toBe("Claude Code");
    expect(meta.firstPartyIcon).toBe("claude-code");
  });

  it("gives a registry-installed agent its own name and icon", () => {
    registryState.registryEntries = [
      { id: "amp-acp", name: "Amp", iconDataUrl: "data:image/svg+xml,x" },
    ];
    const meta = agentMetaForSource("amp-acp");
    expect(meta.label).toBe("Amp");
    expect(meta.firstPartyIcon).toBeNull();
    expect(meta.iconDataUrl).toBe("data:image/svg+xml,x");
  });

  it("keeps an uninstalled agent's id legible rather than mislabelling it", () => {
    // No registry metadata left (agent purged, old capture rows remain): it
    // must NOT borrow another agent's identity.
    const meta = agentMetaForSource("some-agent-acp");
    expect(meta.pluginId).toBe("some-agent-acp");
    expect(meta.firstPartyIcon).toBeNull();
    expect(meta.label).toBe("Some Agent Acp");
  });
});
