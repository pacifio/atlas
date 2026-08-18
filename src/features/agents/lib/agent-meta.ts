// The ONE agent-identity resolver: label / icon source / css class for any
// agent type or plugin id — first-party, native cersei, installed externals,
// and uninstalled-but-captured externals (registry metadata retained). Every
// surface (composer menu, pill, glyphs, sidebar, memory dropdown, timeline)
// resolves through here instead of hardcoded Records/if-ladders.

import {
  AGENT_LABEL,
  PLUGIN_ID_BY_AGENT,
  SWITCHABLE_AGENTS,
  isOptionalBuiltinAgent,
  type AgentType,
  type FirstPartyAgent,
} from "@/types/agent";
import { useProjectStore } from "@/features/project/stores/project-store";
import {
  availabilityOf,
  type AgentAvailability,
  type AgentCatalogEntry,
  type AgentSource,
} from "@/types/agent-catalog";
import { useAgentRegistryStore } from "../stores/agent-registry-store";

export interface AgentMeta {
  /** Canonical plugin id ("claude-code-ts", "codex", or an external id). */
  pluginId: string;
  /** The agentType-shaped identity UI state carries ("claude-code", external id…). */
  agentType: AgentType;
  label: string;
  /** First-party brand icon key, or null → use `iconDataUrl` / monogram. */
  firstPartyIcon: FirstPartyAgent | null;
  iconDataUrl: string | null;
  /** `.agent-*` token class for the amark badge ("" for externals). */
  cssClass: string;
  external: boolean;
  /** How a spawn would launch this agent right now — `null` before the catalog
   *  hydrates. Never treat as immutable: discovery lands asynchronously and
   *  corrects it via `atlas:agent-catalog:changed`. */
  source: AgentSource | null;
  /** Coarse readiness derived from `source`; `null` pre-hydration. */
  availability: AgentAvailability | null;
}

/** The catalog entry for an agentType OR plugin id (the index is keyed by
 *  both), or null before hydration / for a fully unknown id. */
export function catalogEntry(agentTypeOrPluginId: string): AgentCatalogEntry | null {
  return useAgentRegistryStore.getState().catalogById[agentTypeOrPluginId] ?? null;
}

const FIRST_PARTY_CSS: Record<FirstPartyAgent, string> = {
  "claude-code": "agent-claude",
  codex: "agent-codex",
  opencode: "agent-opencode",
  cursor: "agent-cursor",
  kilo: "agent-kilo",
  cersei: "agent-cersei",
};

/** Map an agentType OR plugin id to first-party identity, when it is one. */
function firstPartyOf(id: string): FirstPartyAgent | null {
  if (id in FIRST_PARTY_CSS) return id as FirstPartyAgent;
  if (id === "claude-code-ts" || id === "claude-code-rs" || id.startsWith("claude"))
    return "claude-code";
  return null;
}

/** Non-reactive resolver — safe from event handlers, stores, and render paths
 *  that already re-render on registry changes.
 *
 *  TOTAL by construction: this is the identity chokepoint every surface
 *  (glyphs, pills, sidebar, memory, timeline) funnels through, and a single
 *  non-string slipping in crashed the whole tree ("id.startsWith is not a
 *  function" inside AgentMark, caught only by the app-level error boundary).
 *  A missing id resolves to the Claude default instead of throwing — the same
 *  fallback the rest of the app uses for absent agent identity. */
export function agentMeta(agentTypeOrPluginId: string | null | undefined): AgentMeta {
  const id =
    typeof agentTypeOrPluginId === "string" && agentTypeOrPluginId.length > 0
      ? agentTypeOrPluginId
      : "claude-code";
  const catalog = catalogEntry(id);
  const firstParty = firstPartyOf(id);
  if (firstParty) {
    // First-party branding stays STATIC on purpose: labels, brand icons and
    // CSS tokens are Atlas's own design, not registry metadata, and this path
    // is called from non-reactive boot code before any catalog exists.
    return {
      pluginId: PLUGIN_ID_BY_AGENT[firstParty],
      agentType: firstParty,
      label: AGENT_LABEL[firstParty],
      firstPartyIcon: firstParty,
      iconDataUrl: null,
      cssClass: FIRST_PARTY_CSS[firstParty],
      external: false,
      source: catalog?.source ?? null,
      availability: catalog ? availabilityOf(catalog) : null,
    };
  }
  const { plugins, registryEntries } = useAgentRegistryStore.getState();
  const entry = registryEntries.find((e) => e.id === id) ?? null;
  const plugin = plugins.find((p) => p.plugin_id === id) ?? null;
  return {
    pluginId: id,
    agentType: id,
    // Catalog first (it already merged manifest + install + discovery), then
    // the older sources, then a last-resort prettified id.
    label: catalog?.name ?? entry?.name ?? plugin?.display_name ?? prettifyId(id),
    firstPartyIcon: null,
    iconDataUrl: catalog?.iconDataUrl ?? entry?.iconDataUrl ?? null,
    cssClass: "",
    external: true,
    source: catalog?.source ?? null,
    availability: catalog ? availabilityOf(catalog) : null,
  };
}

/** Normalise a session's stored `agentType` to the switchable identity the
 *  composer / transcript / sidebar key off.
 *
 *  The ONLY collapsing this does is legacy and Claude aliasing: `undefined`,
 *  the retired `"custom"`, and any `claude*` spec id all become `"claude-code"`.
 *  **Everything else passes through** — a registry-installed agent's plugin id
 *  IS its identity, and collapsing it loses that permanently.
 *
 *  Lives here because three surfaces had hand-rolled copies of this and one of
 *  them (the composer) was missing the pass-through, so every external agent
 *  rendered as "Claude Code" in the agent pill — wrong name, wrong icon, and
 *  the switcher highlighted the wrong row. One implementation, one behaviour. */
export function switchableAgentOf(agentType: string | undefined): AgentType {
  if (!agentType || agentType === "custom" || agentType.startsWith("claude")) {
    return "claude-code";
  }
  return agentType;
}

/** "some-agent-acp" → "Some Agent Acp" — last-resort label for ids with no
 *  registry metadata left (fully purged agents in old captures). */
function prettifyId(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/** Whether this agent can be turned off in Settings → Agents. Catalog-first
 *  (the backend's builtin table is the source of truth), falling back to the
 *  static list before hydration. */
export function isOptionalBuiltin(agentTypeOrPluginId: string): boolean {
  const catalog = catalogEntry(agentTypeOrPluginId);
  if (catalog) return catalog.optional;
  return isOptionalBuiltinAgent(agentTypeOrPluginId);
}

/** Whether the user turned this optional built-in off in Settings → Agents.
 *  Always false for Claude / Codex / Cersei and for external agents (which are
 *  uninstalled rather than disabled). Rust enforces the same rule at spawn —
 *  see `AppSettings::builtin_disabled`. */
export function isAgentDisabled(agentTypeOrPluginId: string): boolean {
  if (!isOptionalBuiltin(agentTypeOrPluginId)) return false;
  // `?? []`: settings hydrate async — a pre-hydration read must mean
  // "nothing disabled", never a crash.
  return (useProjectStore.getState().settings.disabledBuiltinAgents ?? []).includes(
    agentTypeOrPluginId,
  );
}

/** The dynamic switch list, in three bands:
 *
 *  1. First-party agents in their fixed order (Atlas's own, curated).
 *  2. Marketplace-installed externals, A–Z.
 *  3. Agents merely DISCOVERED on the user's system, A–Z — they're runnable,
 *     but they're not something the user asked Atlas to add, so they rank last.
 *
 *  Drives option+/ cycling and the composer "+" agent picker. Omitted: agents
 *  the user turned off (that is what "off" means everywhere the user picks an
 *  agent) and agents with nothing runnable behind them.
 *
 *  Pre-hydration (empty catalog) this degrades to exactly the previous
 *  behaviour: first-party order plus `plugins`-derived externals. */
export function switchableAgentIds(): string[] {
  const { plugins, catalog } = useAgentRegistryStore.getState();
  const byLabel = (a: string, b: string) => agentMeta(a).label.localeCompare(agentMeta(b).label);

  if (catalog.length === 0) {
    const externals = plugins
      .filter((p) => p.external)
      .map((p) => p.plugin_id)
      .sort(byLabel);
    return [...SWITCHABLE_AGENTS, ...externals].filter((id) => !isAgentDisabled(id));
  }

  const firstPartyIds = new Set<string>(SWITCHABLE_AGENTS);
  const externals = catalog.filter((e) => e.kind === "external" && !firstPartyIds.has(e.agentType));
  const installed = externals
    .filter((e) => e.installed)
    .map((e) => e.id)
    .sort(byLabel);
  const discovered = externals
    .filter((e) => !e.installed)
    .map((e) => e.id)
    .sort(byLabel);

  return [...SWITCHABLE_AGENTS, ...installed, ...discovered].filter((id) => {
    if (isAgentDisabled(id)) return false;
    // A first-party agent with no catalog entry yet is still offered — the
    // pre-hydration contract. Only an entry that says "unavailable" excludes.
    return catalogEntry(id)?.source !== "unavailable";
  });
}

/** Reactive variant for components that must re-render when agents are
 *  installed/uninstalled — or turned on/off, hence the settings subscription
 *  alongside the registry signature. */
export function useSwitchableAgents(): string[] {
  useAgentRegistryStore((s) => s.signature);
  useProjectStore((s) => s.settings.disabledBuiltinAgents);
  return switchableAgentIds();
}
