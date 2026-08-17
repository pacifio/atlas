import { describe, expect, it, beforeEach, vi } from "vitest";

// agent-meta reaches into two zustand stores. Stub both so the module under
// test is exercised without a Tauri runtime or a React tree.
type Entry = Partial<AgentCatalogEntry> & Pick<AgentCatalogEntry, "id">;

const registryState = {
  plugins: [] as { plugin_id: string; external: boolean }[],
  registryEntries: [],
  catalog: [] as AgentCatalogEntry[],
  catalogById: {} as Record<string, AgentCatalogEntry>,
};
const projectState = { settings: { disabledBuiltinAgents: [] as string[] } };

vi.mock("../stores/agent-registry-store", () => ({
  useAgentRegistryStore: Object.assign(() => undefined, { getState: () => registryState }),
}));
vi.mock("@/features/project/stores/project-store", () => ({
  useProjectStore: Object.assign(() => undefined, { getState: () => projectState }),
}));

const { switchableAgentIds, isAgentDisabled, agentMeta, isOptionalBuiltin, switchableAgentOf } =
  await import("./agent-meta");
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
    autoManaged: false,
    optional: false,
    disabled: false,
    supportsModes: true,
    supportsModels: true,
    transcript: "none",
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

/** Every first-party agent, as the backend would report them. */
const FIRST_PARTY: Entry[] = [
  { id: "claude-code-ts", agentType: "claude-code", kind: "builtin", source: "npx" },
  { id: "codex", agentType: "codex", kind: "builtin", source: "npx" },
  { id: "opencode", agentType: "opencode", kind: "builtin", source: "system-path", optional: true },
  { id: "cursor", agentType: "cursor", kind: "builtin", source: "managed-binary", optional: true },
  { id: "kilo", agentType: "kilo", kind: "builtin", source: "auto-acquire", optional: true },
  { id: "cersei", agentType: "cersei", kind: "native", source: "in-process" },
];

beforeEach(() => {
  registryState.plugins = [];
  setCatalog([]);
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

  // ── Catalog-driven behaviour ─────────────────────────────────────────────

  it("orders externals in bands: installed first, then merely detected", () => {
    // A detected agent is runnable but the user never asked Atlas for it, so
    // it ranks below the ones they did install — even alphabetically earlier.
    setCatalog([
      ...FIRST_PARTY,
      { id: "amp-acp", name: "Amp", installed: true },
      { id: "aaa-acp", name: "Aaa", installed: false, source: "system-path" },
      { id: "zed-acp", name: "Zed", installed: true },
    ]);
    expect(switchableAgentIds()).toEqual([
      "claude-code",
      "codex",
      "opencode",
      "cursor",
      "kilo",
      "cersei",
      "amp-acp",
      "zed-acp",
      "aaa-acp",
    ]);
  });

  it("excludes agents with nothing runnable behind them", () => {
    setCatalog([
      ...FIRST_PARTY,
      { id: "broken-acp", name: "Broken", installed: true, source: "unavailable" },
    ]);
    expect(switchableAgentIds()).not.toContain("broken-acp");
  });

  it("still honours the disabled setting once the catalog has landed", () => {
    setCatalog(FIRST_PARTY);
    projectState.settings.disabledBuiltinAgents = ["cursor"];
    expect(switchableAgentIds()).not.toContain("cursor");
  });

  it("falls back to exactly the old behaviour before hydration", () => {
    // Boot paths call this before any catalog exists; it must not go empty.
    registryState.plugins = [{ plugin_id: "amp-acp", external: true }];
    expect(switchableAgentIds()).toEqual([
      "claude-code",
      "codex",
      "opencode",
      "cursor",
      "kilo",
      "cersei",
      "amp-acp",
    ]);
  });
});

describe("agentMeta", () => {
  it("reports source and availability once the catalog has landed", () => {
    setCatalog(FIRST_PARTY);
    expect(agentMeta("cursor").source).toBe("managed-binary");
    expect(agentMeta("cursor").availability).toBe("ready");
    // An auto-managed built-in with nothing resolved downloads on first use.
    expect(agentMeta("kilo").availability).toBe("needs-download");
  });

  it("leaves source null before hydration, keeping first-party branding", () => {
    const meta = agentMeta("cursor");
    expect(meta.source).toBeNull();
    expect(meta.availability).toBeNull();
    expect(meta.label).toBe("Cursor");
    expect(meta.cssClass).toBe("agent-cursor");
  });

  it("prefers the catalog's name and icon for externals", () => {
    setCatalog([{ id: "amp-acp", name: "Amp", iconDataUrl: "data:image/svg+xml;base64,x" }]);
    expect(agentMeta("amp-acp").label).toBe("Amp");
    expect(agentMeta("amp-acp").iconDataUrl).toBe("data:image/svg+xml;base64,x");
  });

  it("resolves an entry by agentType as well as by plugin id", () => {
    setCatalog(FIRST_PARTY);
    // Sessions persist "claude-code"; the spec id is "claude-code-ts".
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
    for (const id of ["codex", "opencode", "cursor", "kilo", "cersei"]) {
      expect(switchableAgentOf(id)).toBe(id);
    }
  });

  it("collapses only the Claude aliases and legacy values", () => {
    expect(switchableAgentOf("claude-code")).toBe("claude-code");
    expect(switchableAgentOf("claude-code-ts")).toBe("claude-code");
    expect(switchableAgentOf("claude-code-rs")).toBe("claude-code");
    expect(switchableAgentOf("custom")).toBe("claude-code");
    expect(switchableAgentOf(undefined)).toBe("claude-code");
    expect(switchableAgentOf("")).toBe("claude-code");
  });
});

describe("isOptionalBuiltin", () => {
  it("follows the backend's answer when the catalog is loaded", () => {
    setCatalog(FIRST_PARTY);
    expect(isOptionalBuiltin("cursor")).toBe(true);
    expect(isOptionalBuiltin("claude-code")).toBe(false);
    expect(isOptionalBuiltin("amp-acp")).toBe(false);
  });

  it("falls back to the static list before hydration", () => {
    expect(isOptionalBuiltin("cursor")).toBe(true);
    expect(isOptionalBuiltin("claude-code")).toBe(false);
  });
});
