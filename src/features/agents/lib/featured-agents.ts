// One-click install suggestions for the composer's agent picker — Atlas's
// version of Zed's onboarding `FEATURED_AGENT_IDS` (basics_page.rs:539).
//
// These are INSTALL SHORTCUTS, not defaults: nothing here is spawnable,
// pre-seeded, or granted precedence. A featured id is exactly the marketplace
// row's Install button relocated next to the picker — clicking it writes the
// same install-store entry, and until then the agent stays uninstallable dead
// weight. Once installed it leaves this list (the real entry replaces it).

import { useSyncExternalStore } from "react";
import { acpRegistry } from "./agent-registry-api";
import { hydrateAgentRegistry, useAgentRegistryStore } from "../stores/agent-registry-store";

/** Popular agents surfaced with a download affordance, in display order.
 *  Purely promotional — absent from every spawn/identity path. */
export const FEATURED_AGENT_IDS = ["claude-acp", "codex-acp", "opencode", "cursor"] as const;

/** Featured ids not yet installed — the rows the picker should suggest.
 *  Reactive: rows disappear the moment their install lands. */
export function useSuggestedAgents(): string[] {
  useAgentRegistryStore((s) => s.signature);
  const installed = new Set(useAgentRegistryStore.getState().plugins.map((p) => p.plugin_id));
  return FEATURED_AGENT_IDS.filter((id) => !installed.has(id));
}

// ── Module-scope install tracking ───────────────────────────────────────────
// Survives the menu unmounting mid-download (binary agents take ~20-40s on a
// cold cache) — same pattern as the marketplace's install map.

const installing = new Set<string>();
let version = 0;
const subs = new Set<() => void>();
function notify() {
  version++;
  subs.forEach((f) => f());
}

export function useInstallingAgents(): Set<string> {
  useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => version,
  );
  return installing;
}

/**
 * Install a featured agent — the exact flow the marketplace Install button
 * runs — then refresh the identity registry so pickers update. Throws with a
 * user-facing message on failure.
 *
 * A fresh boot may not have the registry manifest cached yet (the marketplace
 * fetches it on open; the composer must not depend on that visit having
 * happened), so an unknown-agent failure refreshes once and retries.
 */
export async function installFeaturedAgent(id: string): Promise<void> {
  if (installing.has(id)) return;
  installing.add(id);
  notify();
  try {
    try {
      await acpRegistry.install(id);
    } catch {
      await acpRegistry.refresh();
      await acpRegistry.install(id);
    }
    await hydrateAgentRegistry();
  } finally {
    installing.delete(id);
    notify();
  }
}
