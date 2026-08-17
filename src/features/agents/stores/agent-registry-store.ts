// Dynamic agent identity registry: which agents exist (first-party + installed
// externals + agents discovered on the user's PATH) and their metadata.
// Hydrated at startup and on every `atlas:agent-catalog:changed`; `agentMeta()`
// (lib/agent-meta) is the read surface every UI consumer goes through.
//
// The `catalog` is the authoritative source; `plugins` / `registryEntries` are
// retained because several boot-path callers run before the catalog lands and
// because the marketplace still renders from the registry listing.
//
// Selector discipline: Record-of-objects selectors infinite-loop under
// useShallow (known Atlas trap) — components subscribe to the primitive
// `signature` string and read the arrays via `getState()`.

import { create } from "zustand";
import type { PluginSpec } from "@/types/agents";
import type { AgentCatalogEntry } from "@/types/agent-catalog";
import { agents, listenCatalogChanged } from "@/features/chat/lib/agents-api";
import { acpRegistry, type AcpRegistryEntry } from "../lib/agent-registry-api";

interface AgentRegistryState {
  plugins: PluginSpec[];
  registryEntries: AcpRegistryEntry[];
  catalog: AgentCatalogEntry[];
  /** Catalog entries keyed by BOTH `id` and `agentType`, so a lookup by either
   *  identity shape hits without the caller knowing which it holds. */
  catalogById: Record<string, AgentCatalogEntry>;
  /** Bumps whenever plugins/registryEntries/catalog change — the primitive
   *  selector components subscribe to instead of the arrays themselves. */
  signature: string;
  hydrated: boolean;
}

function signatureOf(
  plugins: PluginSpec[],
  entries: AcpRegistryEntry[],
  catalog: AgentCatalogEntry[],
): string {
  const p = plugins.map((s) => s.plugin_id).join(",");
  const e = entries.map((s) => `${s.id}:${s.installed ? 1 : 0}:${s.version}`).join(",");
  // Kinds only, never resolved paths: a discovery scan that re-resolves the
  // same binary to the same place must not re-render every agent surface.
  const c = catalog.map((s) => `${s.id}:${s.source}:${s.disabled ? 1 : 0}`).join(",");
  return `${p}|${e}|${c}`;
}

function indexCatalog(catalog: AgentCatalogEntry[]): Record<string, AgentCatalogEntry> {
  const byId: Record<string, AgentCatalogEntry> = {};
  for (const entry of catalog) {
    byId[entry.id] = entry;
    byId[entry.agentType] = entry;
  }
  return byId;
}

export const useAgentRegistryStore = create<AgentRegistryState>(() => ({
  plugins: [],
  registryEntries: [],
  catalog: [],
  catalogById: {},
  signature: "",
  hydrated: false,
}));

/** Re-fetch the agent catalog, the plugin list and the registry listing.
 *  Safe to call repeatedly; failures leave the previous state in place. */
export async function hydrateAgentRegistry(): Promise<void> {
  try {
    const [plugins, listing, catalog] = await Promise.all([
      agents.listPlugins(),
      acpRegistry.list().catch(() => null),
      agents.catalog().catch(() => null),
    ]);
    const registryEntries = listing?.entries ?? [];
    const entries = catalog?.entries ?? [];
    useAgentRegistryStore.setState({
      plugins,
      registryEntries,
      catalog: entries,
      catalogById: indexCatalog(entries),
      signature: signatureOf(plugins, registryEntries, entries),
      hydrated: true,
    });
  } catch {
    // Backend not up yet (early boot) — a later call re-hydrates.
  }
}

let unlistenCatalog: (() => void) | null = null;

/** Subscribe to `atlas:agent-catalog:changed` and re-hydrate on every one.
 *  Idempotent — a second call is a no-op, so React StrictMode's double-mount
 *  can't install two listeners. Called once from App.tsx beside the initial
 *  hydrate. */
export function startCatalogListener(): void {
  if (unlistenCatalog) return;
  // Claim the slot synchronously so a second call during the await can't race
  // in a duplicate listener.
  unlistenCatalog = () => {};
  void listenCatalogChanged(() => {
    void hydrateAgentRegistry();
  }).then((un) => {
    unlistenCatalog = un;
  });
}

/** Test/teardown seam — drops the listener so the next start re-subscribes. */
export function stopCatalogListener(): void {
  unlistenCatalog?.();
  unlistenCatalog = null;
}
