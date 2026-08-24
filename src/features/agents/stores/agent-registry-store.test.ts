import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentCatalogEntry } from "@/types/agent-catalog";

// Stub the whole IPC layer: these tests are about how the store folds the
// backend's two answers together, not about Tauri.
const api = {
  entries: [] as { id: string; installed: boolean; version: string }[],
  catalog: [] as AgentCatalogEntry[],
  catalogThrows: false,
};
let catalogHandler: (() => void) | null = null;
const unlisten = vi.fn();

vi.mock("@/features/chat/lib/agents-api", () => ({
  agents: {
    catalog: () =>
      api.catalogThrows
        ? Promise.reject(new Error("backend down"))
        : Promise.resolve({
            entries: api.catalog,
            lastRefreshedAt: null,
            lastDiscoveredAt: null,
            lastError: null,
          }),
  },
  listenCatalogChanged: (h: () => void) => {
    catalogHandler = h;
    return Promise.resolve(unlisten);
  },
}));
vi.mock("../lib/agent-registry-api", () => ({
  acpRegistry: {
    list: () => Promise.resolve({ entries: api.entries, lastRefreshedAt: null, lastError: null }),
  },
}));

const { useAgentRegistryStore, hydrateAgentRegistry, startCatalogListener, stopCatalogListener } =
  await import("./agent-registry-store");

function entry(e: Partial<AgentCatalogEntry> & Pick<AgentCatalogEntry, "id">): AgentCatalogEntry {
  return {
    agentType: e.id,
    name: e.id,
    source: "installed",
    installed: true,
    resolvedPath: null,
    ...e,
  } as AgentCatalogEntry;
}

beforeEach(() => {
  api.entries = [];
  api.catalog = [];
  api.catalogThrows = false;
  catalogHandler = null;
  unlisten.mockClear();
  stopCatalogListener();
  useAgentRegistryStore.setState({
    registryEntries: [],
    catalog: [],
    catalogById: {},
    signature: "",
    hydrated: false,
  });
});

describe("hydrateAgentRegistry", () => {
  it("indexes catalog entries under BOTH id and agentType", () => {
    // Stored sessions carry "claude-code"; every command takes "claude-code-ts".
    // A lookup by either must hit.
    api.catalog = [entry({ id: "claude-code-ts", agentType: "claude-code" })];
    return hydrateAgentRegistry().then(() => {
      const { catalogById } = useAgentRegistryStore.getState();
      expect(catalogById["claude-code-ts"]).toBeDefined();
      expect(catalogById["claude-code"]).toBe(catalogById["claude-code-ts"]);
    });
  });

  it("still hydrates the registry listing when the catalog call fails", async () => {
    // An older backend, or a boot race — the Marketplace must still render.
    api.catalogThrows = true;
    api.entries = [{ id: "amp-acp", installed: false, version: "1.0.0" }];
    await hydrateAgentRegistry();
    const s = useAgentRegistryStore.getState();
    expect(s.hydrated).toBe(true);
    expect(s.registryEntries).toHaveLength(1);
    expect(s.catalog).toEqual([]);
  });

  it("keeps the last good catalog when a later call fails", async () => {
    // The agent picker is derived from the catalog, so emptying it on a
    // transient failure reads as "you have no agents installed" — every agent
    // the user installed would vanish from the switcher until the next
    // successful hydrate. Stale beats wrong.
    api.catalog = [entry({ id: "amp-acp" })];
    await hydrateAgentRegistry();
    api.catalogThrows = true;
    await hydrateAgentRegistry();
    expect(useAgentRegistryStore.getState().catalog.map((e) => e.id)).toEqual(["amp-acp"]);
  });
});

describe("signature", () => {
  async function signatureFor(catalog: AgentCatalogEntry[]) {
    api.catalog = catalog;
    await hydrateAgentRegistry();
    return useAgentRegistryStore.getState().signature;
  }

  it("ignores resolved paths so a re-scan doesn't re-render every surface", async () => {
    const a = await signatureFor([
      entry({ id: "opencode", resolvedPath: "/usr/local/bin/opencode" }),
    ]);
    const b = await signatureFor([
      entry({ id: "opencode", resolvedPath: "/opt/homebrew/bin/opencode" }),
    ]);
    expect(a).toBe(b);
  });

  it("changes when an agent's source changes", async () => {
    const base = await signatureFor([entry({ id: "opencode", source: "detected" })]);
    // A detection becoming a real install changes how it would launch, so the
    // signature has to move — that is what makes the UI re-render.
    expect(await signatureFor([entry({ id: "opencode", source: "installed" })])).not.toBe(base);
  });

  it("changes when an agent is installed or uninstalled", async () => {
    // What the agent picker is keyed off: an agent joins it on install and
    // leaves on uninstall, so this is the re-render that has to happen.
    const detected = await signatureFor([
      entry({ id: "cursor", source: "detected", installed: false }),
    ]);
    expect(
      await signatureFor([entry({ id: "cursor", source: "installed", installed: true })]),
    ).not.toBe(detected);
  });
});

/** Let every pending microtask (the hydrate chain) settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("startCatalogListener", () => {
  it("re-hydrates when the backend says the catalog changed", async () => {
    startCatalogListener();
    await flush();
    api.catalog = [entry({ id: "cursor", source: "detected" })];
    catalogHandler?.();
    await flush();
    expect(useAgentRegistryStore.getState().catalogById["cursor"]?.source).toBe("detected");
  });

  it("installs exactly one listener however many times it is called", async () => {
    // React StrictMode double-mounts; two listeners would double every
    // re-hydrate for the life of the app.
    startCatalogListener();
    await flush();
    const first = catalogHandler;
    startCatalogListener();
    startCatalogListener();
    await flush();
    expect(catalogHandler).toBe(first);
  });
});
