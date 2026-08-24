// The ONE agent-identity resolver: label / icon source / css class for any
// agent type or plugin id — first-party, native cersei, installed externals,
// and uninstalled-but-captured externals (registry metadata retained). Every
// surface (composer menu, pill, glyphs, sidebar, memory dropdown, timeline)
// resolves through here instead of hardcoded Records/if-ladders.

import {
  AGENT_LABEL,
  NATIVE_AGENT_ID,
  PLUGIN_ID_BY_AGENT,
  type AgentType,
  type FirstPartyAgent,
} from "@/types/agent";
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
 *  A missing id resolves to the NATIVE agent instead of throwing. It used to
 *  resolve to Claude Code; since the port there are no default ACP agents
 *  (ADR-0002), so naming one here would claim an agent the user may
 *  never have installed. The native agent is the only one always present. */
export function agentMeta(agentTypeOrPluginId: string | null | undefined): AgentMeta {
  const id =
    typeof agentTypeOrPluginId === "string" && agentTypeOrPluginId.length > 0
      ? agentTypeOrPluginId
      : NATIVE_AGENT_ID;
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
  const { registryEntries } = useAgentRegistryStore.getState();
  const entry = registryEntries.find((e) => e.id === id) ?? null;
  return {
    pluginId: id,
    agentType: id,
    // Catalog first (it already merged manifest + install + discovery), then
    // the registry listing, then a last-resort prettified id.
    label: catalog?.name ?? entry?.name ?? prettifyId(id),
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
 *  Two different jobs, deliberately kept apart:
 *
 *  - **Aliasing.** Any `claude*` spec id becomes `"claude-code"` — one agent
 *    under two names, so both must resolve to the identity sessions persist.
 *  - **Defaulting.** No identity at all (absent, or the retired `"custom"`)
 *    resolves to the NATIVE agent. It used to resolve to Claude Code, which
 *    since the port would name an ACP agent the user may never have installed
 *    (ADR-0002) — and this value is what the composer's picker highlights.
 *
 *  **Everything else passes through** — a registry-installed agent's plugin id
 *  IS its identity, and collapsing it loses that permanently.
 *
 *  Lives here because three surfaces had hand-rolled copies of this and one of
 *  them (the composer) was missing the pass-through, so every external agent
 *  rendered as "Claude Code" in the agent pill — wrong name, wrong icon, and
 *  the switcher highlighted the wrong row. One implementation, one behaviour. */
export function switchableAgentOf(agentType: string | undefined): AgentType {
  if (!agentType || agentType === "custom") return NATIVE_AGENT_ID;
  if (agentType.startsWith("claude")) return "claude-code";
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

/** Every external agent the user has installed AND that is runnable.
 *
 *  The single derivation of "an agent the user actually has" — the agent
 *  picker, the memory dropdown and the background pre-warm all read it, so
 *  they cannot disagree about what is installed. Excluded by construction:
 *  the native agent (it is not a Marketplace agent), an agent merely detected
 *  on `PATH` (an offer to install, never a spawn candidate), and one whose
 *  install resolves to nothing runnable. */
export function installedExternals(): AgentCatalogEntry[] {
  return useAgentRegistryStore
    .getState()
    .catalog.filter((e) => e.kind !== "native" && e.installed && e.source !== "unavailable");
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
