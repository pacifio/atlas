// Dynamic agent identity registry: which agents exist (the native agent,
// installed externals, and agents discovered on the user's PATH) and their
// metadata.
// Hydrated at startup and on every `atlas:agent-catalog:changed`; `agentMeta()`
// (lib/agent-meta) is the read surface every UI consumer goes through.
//
// Two answers, one authority: the `catalog` says which agents exist and how
// each would launch; `registryEntries` is the Marketplace's browse list (every
// published agent, installed or not) and nothing else reads it. The old
// `plugins` list was a third answer to the same question and is gone.
//
// Selector discipline: Record-of-objects selectors infinite-loop under
// useShallow (known Atlas trap) — components subscribe to the primitive
// `signature` string and read the arrays via `getState()`.

import { create } from "zustand";
import type { AgentCatalogEntry } from "@/types/agent-catalog";
import { agents, listenCatalogChanged } from "@/features/chat/lib/agents-api";
import { acpRegistry, type AcpRegistryEntry } from "../lib/agent-registry-api";

interface AgentRegistryState {
  registryEntries: AcpRegistryEntry[];
  catalog: AgentCatalogEntry[];
  /** Catalog entries keyed by BOTH `id` and `agentType`, so a lookup by either
   *  identity shape hits without the caller knowing which it holds. */
  catalogById: Record<string, AgentCatalogEntry>;
  /** Bumps whenever registryEntries/catalog change — the primitive selector
   *  components subscribe to instead of the arrays themselves. */
  signature: string;
  hydrated: boolean;

  // ── Registry listing status ────────────────────────────────────────────────
  // The marketplace renders from here rather than fetching on mount, so opening
  // Settings → Agents paints the prefetched listing instead of starting from
  // nothing. These are primitives on purpose: components subscribe to them
  // directly (the Record-of-objects selector trap only bites on the arrays).

  /** A listing call has returned at least once — distinguishes "still loading"
   *  from "loaded, and there is genuinely nothing here". */
  registryLoaded: boolean;
  /** A network refresh is in flight. Cached entries stay on screen underneath. */
  registryRefreshing: boolean;
  /** Last refresh failure, from the backend or the invoke itself. Cleared by a
   *  refresh that succeeds. */
  registryError: string | null;
  /** RFC3339 time of the last successful fetch; `null` = never confirmed
   *  against the network (cold boot, or disk cache only). */
  registryRefreshedAt: string | null;
}

function signatureOf(entries: AcpRegistryEntry[], catalog: AgentCatalogEntry[]): string {
  const e = entries.map((s) => `${s.id}:${s.installed ? 1 : 0}:${s.version}`).join(",");
  // Kinds only, never resolved paths: a discovery scan that re-resolves the
  // same binary to the same place must not re-render every agent surface.
  // `installed` is in here because it is what the agent picker is keyed off —
  // an agent joins it on install and leaves on uninstall.
  const c = catalog.map((s) => `${s.id}:${s.source}:${s.installed ? 1 : 0}`).join(",");
  return `${e}|${c}`;
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
  registryEntries: [],
  catalog: [],
  catalogById: {},
  signature: "",
  hydrated: false,
  registryLoaded: false,
  registryRefreshing: false,
  registryError: null,
  registryRefreshedAt: null,
}));

/** Re-fetch the agent catalog and the registry listing.
 *  Safe to call repeatedly; failures leave the previous state in place.
 *
 *  This is the marketplace's PREFETCH: App.tsx calls it at startup and again on
 *  every `atlas:agent-catalog:changed`, so by the time the user opens Settings →
 *  Agents the listing is already here. */
export async function hydrateAgentRegistry(): Promise<void> {
  try {
    const [listing, catalog] = await Promise.all([
      acpRegistry.list().catch(() => null),
      agents.catalog().catch(() => null),
    ]);
    const previous = useAgentRegistryStore.getState();
    const registryEntries = listing?.entries ?? previous.registryEntries;
    // A failed catalog call must KEEP the last good one. Emptying it would
    // read as "you have no agents installed", and every surface that lists
    // agents — the picker above all — would silently lose them until the next
    // successful hydrate.
    const entries = catalog?.entries ?? previous.catalog;
    useAgentRegistryStore.setState({
      registryEntries,
      catalog: entries,
      catalogById: indexCatalog(entries),
      signature: signatureOf(registryEntries, entries),
      hydrated: true,
      // A listing that arrived mid-fetch is provisional: `isFetching` says boot's
      // own refresh is still running, so this is not yet "loaded and empty".
      registryLoaded: previous.registryLoaded || (listing !== null && !listing.isFetching),
      registryRefreshing: previous.registryRefreshing || (listing?.isFetching ?? false),
      registryError: listing ? listing.lastError : previous.registryError,
      registryRefreshedAt: listing?.lastRefreshedAt ?? previous.registryRefreshedAt,
    });
  } catch {
    // Backend not up yet (early boot) — a later call re-hydrates.
  }
}

/** In-flight refresh, shared. A second caller joins the first rather than
 *  issuing a duplicate — the frontend half of the same rule the Rust store now
 *  follows (`AgentRegistryStore::refresh`). */
let pendingRefresh: Promise<void> | null = null;

/** Pull a fresh listing from the network, leaving the cached one on screen
 *  while it runs (stale-while-revalidate).
 *
 *  A failure never empties the list: the backend keeps the previous catalogue
 *  and we keep showing it, annotated with the error. */
export function refreshAgentRegistry(): Promise<void> {
  if (pendingRefresh) return pendingRefresh;
  useAgentRegistryStore.setState({ registryRefreshing: true });
  pendingRefresh = (async () => {
    try {
      const listing = await acpRegistry.refresh();
      const catalog = await agents.catalog().catch(() => null);
      const entries = catalog?.entries ?? useAgentRegistryStore.getState().catalog;
      useAgentRegistryStore.setState({
        registryEntries: listing.entries,
        catalog: entries,
        catalogById: indexCatalog(entries),
        signature: signatureOf(listing.entries, entries),
        hydrated: true,
        registryLoaded: true,
        registryError: listing.lastError,
        registryRefreshedAt: listing.lastRefreshedAt,
      });
    } catch (error) {
      useAgentRegistryStore.setState({
        // Loaded, just not from this attempt — whatever is cached is what the
        // user sees, and the error explains why it may be stale.
        registryLoaded: true,
        registryError: String(error),
      });
    } finally {
      useAgentRegistryStore.setState({ registryRefreshing: false });
      pendingRefresh = null;
    }
  })();
  return pendingRefresh;
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
