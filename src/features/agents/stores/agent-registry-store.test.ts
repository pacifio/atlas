import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentCatalogEntry } from "@/types/agent-catalog";

// Stub the whole IPC layer: these tests are about how the store folds the
// backend's two answers together, not about Tauri.
const api = {
  entries: [] as { id: string; installed: boolean; version: string }[],
  catalog: [] as AgentCatalogEntry[],
  catalogThrows: false,
  /** Backend-reported state of the listing `list()` hands back. */
  isFetching: false,
  lastError: null as string | null,
  lastRefreshedAt: null as string | null,
  /** What `refresh()` does: resolve with the current api state, or throw. */
  refreshThrows: null as string | null,
  refreshCalls: 0,
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
function listingNow() {
  return {
    entries: api.entries,
    lastRefreshedAt: api.lastRefreshedAt,
    lastError: api.lastError,
    isFetching: api.isFetching,
  };
}
vi.mock("../lib/agent-registry-api", () => ({
  acpRegistry: {
    list: () => Promise.resolve(listingNow()),
    refresh: () => {
      api.refreshCalls++;
      return api.refreshThrows
        ? Promise.reject(new Error(api.refreshThrows))
        : Promise.resolve(listingNow());
    },
  },
}));

const {
  useAgentRegistryStore,
  hydrateAgentRegistry,
  refreshAgentRegistry,
  startCatalogListener,
  stopCatalogListener,
} = await import("./agent-registry-store");

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
  api.isFetching = false;
  api.lastError = null;
  api.lastRefreshedAt = null;
  api.refreshThrows = null;
  api.refreshCalls = 0;
  catalogHandler = null;
  unlisten.mockClear();
  stopCatalogListener();
  useAgentRegistryStore.setState({
    registryEntries: [],
    catalog: [],
    catalogById: {},
    signature: "",
    hydrated: false,
    registryLoaded: false,
    registryRefreshing: false,
    registryError: null,
    registryRefreshedAt: null,
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

// ── The prefetch contract ────────────────────────────────────────────────────
// The marketplace renders from this store instead of fetching on mount, so
// these flags are what decide whether it shows a spinner, cached cards, or
// "couldn't reach the registry". Getting them wrong is what put "Registry
// unavailable" on screen while boot's own fetch was still running.

describe("registry listing status", () => {
  it("does not call an in-flight boot fetch 'loaded'", async () => {
    // An empty listing taken while the backend is still fetching means "not
    // yet", not "nothing" — reporting it as loaded is the empty-state bug.
    api.isFetching = true;
    api.entries = [];
    await hydrateAgentRegistry();
    const s = useAgentRegistryStore.getState();
    expect(s.registryLoaded).toBe(false);
    expect(s.registryRefreshing).toBe(true);
  });

  it("is loaded once a settled listing arrives", async () => {
    api.entries = [{ id: "amp-acp", installed: false, version: "1.0.0" }];
    await hydrateAgentRegistry();
    expect(useAgentRegistryStore.getState().registryLoaded).toBe(true);
  });

  it("keeps the cached entries when a refresh fails, and records why", async () => {
    // Stale beats empty: the backend keeps the previous catalogue on a failed
    // fetch, and so must we — with the error attached to explain the staleness.
    api.entries = [{ id: "amp-acp", installed: false, version: "1.0.0" }];
    await hydrateAgentRegistry();

    api.refreshThrows = "network is unreachable";
    await refreshAgentRegistry();

    const s = useAgentRegistryStore.getState();
    expect(s.registryEntries).toHaveLength(1);
    expect(s.registryError).toContain("network is unreachable");
    expect(s.registryRefreshing).toBe(false);
    expect(s.registryLoaded).toBe(true);
  });

  it("clears a previous error once a refresh succeeds", async () => {
    api.refreshThrows = "offline";
    await refreshAgentRegistry();
    expect(useAgentRegistryStore.getState().registryError).toBeTruthy();

    api.refreshThrows = null;
    api.entries = [{ id: "amp-acp", installed: false, version: "1.0.0" }];
    api.lastRefreshedAt = "2026-08-25T00:00:00Z";
    await refreshAgentRegistry();

    const s = useAgentRegistryStore.getState();
    expect(s.registryError).toBeNull();
    expect(s.registryRefreshedAt).toBe("2026-08-25T00:00:00Z");
  });

  it("joins a refresh already in flight instead of issuing a second", async () => {
    // Same rule as the Rust store: the marketplace's mount-time refresh and a
    // manual Refresh must not become two fetches.
    await Promise.all([refreshAgentRegistry(), refreshAgentRegistry(), refreshAgentRegistry()]);
    expect(api.refreshCalls).toBe(1);
  });
});
