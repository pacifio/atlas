import { describe, expect, it, beforeEach, vi } from "vitest";

// agent-meta reaches into two zustand stores. Stub both so the module under
// test is exercised without a Tauri runtime or a React tree.
type Entry = Partial<AgentCatalogEntry> & Pick<AgentCatalogEntry, "id">;

const registryState = {
  registryEntries: [],
  catalog: [] as AgentCatalogEntry[],
  catalogById: {} as Record<string, AgentCatalogEntry>,
};

vi.mock("../stores/agent-registry-store", () => ({
  useAgentRegistryStore: Object.assign(() => undefined, { getState: () => registryState }),
}));

const { switchableAgentIds, agentMeta, switchableAgentOf } = await import("./agent-meta");
type AgentCatalogEntry = import("@/types/agent-catalog").AgentCatalogEntry;

/** Fill in the fields these tests don't care about. */
function entry(e: Entry): AgentCatalogEntry {
  return {
    agentType: e.id,
    name: e.id,
    description: null,
    version: null,
    kind: "external",
    source: "installed",
    resolvedPath: null,
    installed: true,
    supportsModes: true,
    supportsModels: true,
    transcript: "none",
    enabled: true,
    displayName: null,
    launch: { command: null, args: [], variables: [] },
    hiddenModels: [],
    modelOrder: [],
    customModels: [],
    login: null,
    iconDataUrl: null,
    helpUrl: null,
    repository: null,
    website: null,
    platformSupported: true,
    distributionKind: "binary",
    unverified: false,
    unsupportedReason: null,
    ...e,
  } as AgentCatalogEntry;
}

/** Install a catalog, indexed the way the real store does (by id AND type). */
function setCatalog(entries: Entry[]) {
  const full = entries.map(entry);
  registryState.catalog = full;
  registryState.catalogById = Object.fromEntries(
    full.flatMap((e) => [
      [e.id, e],
      [e.agentType, e],
    ]),
  );
}

/** The native agent, which every install has and no install can remove. */
const NATIVE: Entry = {
  id: "atlas-agent",
  agentType: "atlas-agent",
  name: "Atlas Agent",
  kind: "native",
  source: "in-process",
  installed: false,
};

/** A fresh profile after the user installed Claude Code and Codex from the
 *  Marketplace, with Cursor merely found on their PATH. Registry ids, whose
 *  agentType is the id itself (`agent_type_for` in `catalog.rs`). */
const AFTER_INSTALLS: Entry[] = [
  NATIVE,
  { id: "claude-acp", name: "Claude Code", source: "npx" },
  { id: "codex-acp", name: "Codex", source: "npx" },
  { id: "cursor", agentType: "cursor", name: "Cursor", source: "detected", installed: false },
];

beforeEach(() => {
  setCatalog([]);
});

describe("switchableAgentIds", () => {
  it("offers only the native agent on a fresh profile", () => {
    // ADR-0002. Atlas ships no ACP agents, so a fresh install has
    // exactly one thing to switch to — anything else would be a default agent.
    setCatalog([NATIVE]);
    expect(switchableAgentIds()).toEqual(["atlas-agent"]);
  });

  it("adds an agent once the user installs it, and drops it on uninstall", () => {
    setCatalog(AFTER_INSTALLS);
    expect(switchableAgentIds()).toContain("claude-acp");
    setCatalog([NATIVE]);
    expect(switchableAgentIds()).not.toContain("claude-acp");
  });

  it("keeps the native agent first, then installs A–Z by label", () => {
    setCatalog(AFTER_INSTALLS);
    expect(switchableAgentIds()).toEqual(["atlas-agent", "claude-acp", "codex-acp"]);
  });

  it("leaves a merely-detected agent out — it is an offer, not a spawn", () => {
    // `source: "detected"` means Atlas found it on PATH but the user never
    // asked for it. Installing it in the Marketplace is what adds it here.
    setCatalog(AFTER_INSTALLS);
    expect(switchableAgentIds()).not.toContain("cursor");
  });

  it("excludes an installed agent with nothing runnable behind it", () => {
    setCatalog([NATIVE, { id: "broken-acp", name: "Broken", source: "unavailable" }]);
    expect(switchableAgentIds()).toEqual(["atlas-agent"]);
  });

  it("leaves out an agent the user turned off in Settings", () => {
    setCatalog([NATIVE, { id: "claude-acp", name: "Claude Code", enabled: false }]);
    expect(switchableAgentIds()).toEqual(["atlas-agent"]);
  });

  it("names the native agent alone before the catalog hydrates", () => {
    // Boot paths call this before any catalog exists; it must not go empty,
    // and it must not guess at an ACP agent the user may not have.
    expect(switchableAgentIds()).toEqual(["atlas-agent"]);
  });
});

describe("agentMeta", () => {
  it("labels an agent with the name the user gave it", () => {
    setCatalog([
      NATIVE,
      { id: "claude-acp", name: "Claude Code", displayName: "Claude (work)" },
      { id: "acme", name: "Acme", displayName: "Acme staging" },
    ]);
    // Both paths: a first-party identity and an external one.
    expect(agentMeta("claude-acp").label).toBe("Claude (work)");
    expect(agentMeta("acme").label).toBe("Acme staging");
  });

  it("reports source and availability once the catalog has landed", () => {
    setCatalog(AFTER_INSTALLS);
    expect(agentMeta("claude-acp").source).toBe("npx");
    expect(agentMeta("claude-acp").availability).toBe("ready");
    // Detected-but-not-installed still has to be fetched before it can run.
    expect(agentMeta("cursor").availability).toBe("needs-download");
  });

  it("falls back to the native agent when there is no identity at all", () => {
    // Was Claude Code. A missing id must not name an ACP agent the user may
    // never have installed (ADR-0002) — the native agent is the only one that
    // is always there.
    setCatalog(AFTER_INSTALLS);
    for (const missing of [null, undefined, ""]) {
      expect(agentMeta(missing).agentType).toBe("atlas-agent");
      expect(agentMeta(missing).label).toBe("Atlas Agent");
    }
  });

  it("leaves source null before hydration, keeping first-party branding", () => {
    const meta = agentMeta("cursor");
    expect(meta.source).toBeNull();
    expect(meta.availability).toBeNull();
    expect(meta.label).toBe("Cursor");
    expect(meta.firstPartyIcon).toBe("cursor");
  });

  it("prefers the catalog's name and icon for externals", () => {
    setCatalog([{ id: "amp-acp", name: "Amp", iconDataUrl: "data:image/svg+xml;base64,x" }]);
    expect(agentMeta("amp-acp").label).toBe("Amp");
    expect(agentMeta("amp-acp").iconDataUrl).toBe("data:image/svg+xml;base64,x");
  });

  it("resolves an entry by agentType as well as by plugin id", () => {
    // The one alias left: the old built-in Claude spec "claude-code-ts", whose
    // sessions persisted "claude-code".
    setCatalog([
      NATIVE,
      { id: "claude-code-ts", agentType: "claude-code", name: "Claude Code", source: "npx" },
    ]);
    expect(agentMeta("claude-code").source).toBe("npx");
    expect(agentMeta("claude-code-ts").source).toBe("npx");
  });
});

describe("switchableAgentOf", () => {
  it("passes an external agent's id through untouched", () => {
    // The regression this fixes: the composer had a hardcoded list of the six
    // first-party agents and collapsed everything else to "claude-code", so a
    // registry-installed agent showed "Claude Code" in the pill, the wrong
    // icon, and highlighted the wrong row in the switcher.
    for (const id of ["autohand", "gemini", "amp-acp", "qwen-code"]) {
      expect(switchableAgentOf(id)).toBe(id);
    }
  });

  it("keeps every first-party agent as itself", () => {
    for (const id of ["codex", "opencode", "cursor", "kilo", "atlas-agent"]) {
      expect(switchableAgentOf(id)).toBe(id);
    }
  });

  it("aliases every Claude spec id to the one identity sessions persist", () => {
    expect(switchableAgentOf("claude-code")).toBe("claude-code");
    expect(switchableAgentOf("claude-code-ts")).toBe("claude-code");
    expect(switchableAgentOf("claude-code-rs")).toBe("claude-code");
  });

  it("gives Claude Code's mark to the real Claude ids only", () => {
    expect(agentMeta("claude-acp").firstPartyIcon).toBe("claude-code");
    expect(agentMeta("claude-code-ts").firstPartyIcon).toBe("claude-code");
    expect(agentMeta("claude-foo").firstPartyIcon).toBeNull();
  });

  it("does not fold other claude-prefixed ids into Claude Code", () => {
    // The registry's own adapter keeps its id (the switcher lists claude-acp),
    // and a third-party claude-* agent is itself.
    expect(switchableAgentOf("claude-acp")).toBe("claude-acp");
    expect(switchableAgentOf("claude-foo")).toBe("claude-foo");
  });

  it("defaults to the native agent when a session carries no identity", () => {
    // Was Claude Code, which since the port would highlight an ACP agent the
    // user may never have installed (ADR-0002). "custom" is the retired legacy
    // value and means the same thing: nothing was recorded.
    expect(switchableAgentOf(undefined)).toBe("atlas-agent");
    expect(switchableAgentOf("")).toBe("atlas-agent");
    expect(switchableAgentOf("custom")).toBe("atlas-agent");
  });
});
