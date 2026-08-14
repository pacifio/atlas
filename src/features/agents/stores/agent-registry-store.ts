// Dynamic agent identity registry: which agents exist (first-party + installed
// externals) and their marketplace metadata. Hydrated at startup and after
// every install/uninstall; `agentMeta()` (lib/agent-meta) is the read surface
// every UI consumer goes through.
//
// Selector discipline: Record-of-objects selectors infinite-loop under
// useShallow (known Atlas trap) — components subscribe to the primitive
// `signature` string and read the arrays via `getState()`.

import { create } from "zustand";
import type { PluginSpec } from "@/types/agents";
import { agents } from "@/features/chat/lib/agents-api";
import { acpRegistry, type AcpRegistryEntry } from "../lib/agent-registry-api";

interface AgentRegistryState {
  plugins: PluginSpec[];
  registryEntries: AcpRegistryEntry[];
  /** Bumps whenever plugins/registryEntries change — the primitive selector
   *  components subscribe to instead of the arrays themselves. */
  signature: string;
  hydrated: boolean;
}

function signatureOf(plugins: PluginSpec[], entries: AcpRegistryEntry[]): string {
  const p = plugins.map((s) => s.plugin_id).join(",");
  const e = entries.map((s) => `${s.id}:${s.installed ? 1 : 0}:${s.version}`).join(",");
  return `${p}|${e}`;
}

export const useAgentRegistryStore = create<AgentRegistryState>(() => ({
  plugins: [],
  registryEntries: [],
  signature: "",
  hydrated: false,
}));

/** Re-fetch both the plugin list (spawnable agents) and the registry listing
 *  (marketplace metadata + icons). Safe to call repeatedly; failures leave the
 *  previous state in place. */
export async function hydrateAgentRegistry(): Promise<void> {
  try {
    const [plugins, listing] = await Promise.all([
      agents.listPlugins(),
      acpRegistry.list().catch(() => null),
    ]);
    const registryEntries = listing?.entries ?? [];
    useAgentRegistryStore.setState({
      plugins,
      registryEntries,
      signature: signatureOf(plugins, registryEntries),
      hydrated: true,
    });
  } catch {
    // Backend not up yet (early boot) — a later call re-hydrates.
  }
}
