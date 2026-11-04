// The ONE agent-identity resolver over the LIVE registry: label / icon source /
// css class for any agent type or plugin id — first-party, native agent,
// installed externals, and uninstalled-but-captured externals (registry
// metadata retained). Every surface (composer menu, pill, glyphs, sidebar,
// memory dropdown, timeline) resolves through here instead of hardcoded
// Records/if-ladders.
//
// The resolution itself is pure and lives in `agent-identity.ts`
// (`resolveAgentMeta(id, snapshot)`); this module binds it to
// `useAgentRegistryStore` and re-exports the identity types, so its importers
// never need to know the split exists. A VIEW must not import this module (it
// reaches a store): it calls `useAgentMeta(id)` from `agent-meta-context.ts`,
// or takes an `AgentMeta` or a label as a prop.

import { NATIVE_AGENT_ID } from "@/types/agent";
import type { AgentCatalogEntry } from "@/types/agent-catalog";
import { useAgentRegistryStore } from "../stores/agent-registry-store";
import { resolveAgentMeta, type AgentMeta } from "./agent-identity";

export { switchableAgentOf, type AgentMeta } from "./agent-identity";

/** The catalog entry for an agentType OR plugin id (the index is keyed by
 *  both), or null before hydration / for a fully unknown id. */
export function catalogEntry(agentTypeOrPluginId: string): AgentCatalogEntry | null {
  return useAgentRegistryStore.getState().catalogById[agentTypeOrPluginId] ?? null;
}

/** Non-reactive resolver — safe from event handlers, stores, and render paths
 *  that already re-render on registry changes. Total: a missing id resolves to
 *  the native agent (see `resolveAgentMeta`). */
export function agentMeta(agentTypeOrPluginId: string | null | undefined): AgentMeta {
  return resolveAgentMeta(agentTypeOrPluginId, useAgentRegistryStore.getState());
}

/** Every external agent the user has installed AND that is runnable.
 *
 *  The single derivation of "an agent the user actually has" — the agent
 *  picker, the memory dropdown and the background pre-warm all read it, so
 *  they cannot disagree about what is installed. Excluded by construction:
 *  the native agent (it is not a Marketplace agent), an agent merely detected
 *  on `PATH` (an offer to install, never a spawn candidate), one the user
 *  turned off in Settings, and one whose install resolves to nothing runnable. */
export function installedExternals(): AgentCatalogEntry[] {
  return useAgentRegistryStore
    .getState()
    .catalog.filter(
      (e) => e.kind !== "native" && e.installed && e.enabled && e.source !== "unavailable",
    );
}

/** The agents the user can switch between: the native agent, then everything
 *  they installed from the Marketplace, A–Z by label.
 *
 *  Drives option+/ cycling and the composer "+" agent picker. What is NOT here
 *  is the point: an agent merely DETECTED on the user's PATH is an offer to
 *  install, not a spawn candidate (`catalog.rs`), and Atlas ships no ACP
 *  agents of its own (ADR-0002) — so a fresh profile offers exactly the
 *  native agent, and Claude Code appears the moment it is installed and
 *  disappears when it is removed.
 *
 *  Returns `agentType`s, not spec ids: that is the identity sessions persist
 *  and every picker compares against ("claude-code", not "claude-code-ts"). */
export function switchableAgentIds(): string[] {
  const { catalog } = useAgentRegistryStore.getState();
  // Pre-hydration (boot paths run before any catalog exists): the native agent
  // is in-process and needs no install, so it is always a truthful answer.
  if (catalog.length === 0) return [NATIVE_AGENT_ID];

  const byLabel = (a: string, b: string) => agentMeta(a).label.localeCompare(agentMeta(b).label);
  const native = catalog
    .filter((e) => e.kind === "native" && e.source !== "unavailable")
    .map((e) => e.agentType);
  const installed = installedExternals()
    .map((e) => e.agentType)
    .sort(byLabel);
  return [...native, ...installed];
}

/** Reactive variant for components that must re-render when agents are
 *  installed or uninstalled. */
export function useSwitchableAgents(): string[] {
  useAgentRegistryStore((s) => s.signature);
  return switchableAgentIds();
}
