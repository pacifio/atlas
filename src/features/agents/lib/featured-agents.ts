// The short list of agents Atlas puts in front of the user before they have
// installed anything.
//
// Atlas ships no ACP agents (ADR-0002), so a fresh profile can switch to
// exactly one thing: the native agent. That is correct as a *runtime* rule and
// terrible as a first impression — the picker looked like Atlas supported one
// agent. Zed solves it the same way: the switcher markets a handful of popular
// agents as one-click installs alongside the ones you have.
//
// This is marketing copy, not capability. Nothing here is spawnable, none of it
// is special-cased anywhere in the agent stack, and an id that the registry
// stops publishing simply stops appearing. Installing one writes the same
// installed-map entry the Marketplace writes — it is the same install, reached
// from a shorter path.

import { useAgentRegistryStore } from "../stores/agent-registry-store";
import { agentMeta, installedExternals } from "./agent-meta";

/** Registry ids, in the order they are offered. Registry ids, NOT agentTypes:
 *  these name rows in the ACP registry listing, which is what installs them. */
export const FEATURED_AGENT_IDS = [
  "claude-acp",
  "codex-acp",
  "opencode",
  "cursor",
  "pi-acp",
] as const;

export interface FeaturedAgentOffer {
  /** Registry id — what `acp_registry_install` takes. */
  id: string;
  label: string;
  iconDataUrl: string | null;
  /** False when the registry publishes no build for this platform; the offer is
   *  shown disabled rather than hidden, so the list does not silently differ
   *  between machines. */
  platformSupported: boolean;
}

/** Featured agents the user does NOT already have.
 *
 *  Excluded: anything already switchable (installed externals + the native
 *  agent), so an agent moves out of this list the moment it is installed and
 *  into the list above it. Also excluded: ids the registry listing has never
 *  heard of — offering an install we cannot perform is worse than a short list.
 *
 *  Pure, and takes the two store slices as arguments so the ordering rules are
 *  testable without a store or a DOM. */
export function featuredAgentOffers(
  registryEntries: RegistryRow[],
  alreadyHave: ReadonlySet<string>,
): FeaturedAgentOffer[] {
  return FEATURED_AGENT_IDS.filter((id) => !alreadyHave.has(id))
    .map((id) => registryEntries.find((e) => e.id === id))
    .filter((entry): entry is RegistryRow => !!entry && !entry.installed)
    .map((entry) => ({
      id: entry.id,
      label: entry.name,
      iconDataUrl: entry.iconDataUrl,
      platformSupported: entry.platformSupported,
    }));
}

/** The fields this module needs off a marketplace listing row. */
type RegistryRow = {
  id: string;
  name: string;
  iconDataUrl: string | null;
  installed: boolean;
  platformSupported: boolean;
};

/** Reactive variant for the composer's agent picker — re-runs whenever an agent
 *  is installed or uninstalled (the store's primitive `signature`). */
export function useFeaturedAgentOffers(): FeaturedAgentOffer[] {
  useAgentRegistryStore((s) => s.signature);
  const { registryEntries } = useAgentRegistryStore.getState();
  // An installed external is identified by BOTH its ids in different places, so
  // hold both: the catalog's `id` is the registry id, `agentType` is the
  // identity sessions persist.
  const have = new Set<string>();
  for (const entry of installedExternals()) {
    have.add(entry.id);
    have.add(entry.agentType);
  }
  return featuredAgentOffers(registryEntries, have);
}

/** The identity a session should be switched to once `registryId` is installed.
 *
 *  Resolved from the catalog AFTER the install lands, because that is the only
 *  thing that knows an agent's display alias (`claude-acp` is its own agentType;
 *  a first-party-branded one may differ). Falls back to the registry id, which
 *  is what the catalog uses when there is no alias. */
export function agentTypeForRegistryId(registryId: string): string {
  const entry = useAgentRegistryStore.getState().catalogById[registryId];
  return entry?.agentType ?? agentMeta(registryId).agentType;
}
