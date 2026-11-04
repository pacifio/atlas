// Agent identity as a pure function of a registry snapshot.
//
// `resolveAgentMeta(id, snapshot)` answers label / icon source / availability
// for any agent type or plugin id without touching a store, so a view, a
// derivation lib or a unit test can resolve agents from data it was handed.
// `agent-meta.ts` is the store-bound front door (`agentMeta(id)` resolves over
// the live registry); `agent-meta-context.ts` hands a resolver to the React
// tree. Value imports stay limited to `@/types/*`: this module is on the
// view-purity contract's `PURE_SHARED_MODULES` list.

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
import type { AcpRegistryEntry } from "./agent-registry-api";

export interface AgentMeta {
  /** Canonical plugin id ("claude-code-ts", "codex", or an external id). */
  pluginId: string;
  /** The agentType-shaped identity UI state carries ("claude-code", external id…). */
  agentType: AgentType;
  label: string;
  /** First-party brand icon key, or null → use `iconDataUrl` / monogram. */
  firstPartyIcon: FirstPartyAgent | null;
  iconDataUrl: string | null;
  external: boolean;
  /** How a spawn would launch this agent right now — `null` before the catalog
   *  hydrates. Never treat as immutable: discovery lands asynchronously and
   *  corrects it via `atlas:agent-catalog:changed`. */
  source: AgentSource | null;
  /** Coarse readiness derived from `source`; `null` pre-hydration. */
  availability: AgentAvailability | null;
}

/** The slice of the agent registry identity resolution reads. The registry
 *  store satisfies it structurally, so `resolveAgentMeta(id, getState())`
 *  needs no adapter. */
export interface AgentRegistrySnapshot {
  /** Catalog entries keyed by BOTH `id` and `agentType`. */
  catalogById: Readonly<Record<string, AgentCatalogEntry>>;
  /** The Marketplace listing: the fallback name and icon for an agent the
   *  catalog no longer knows. */
  registryEntries: ReadonlyArray<Pick<AcpRegistryEntry, "id" | "name" | "iconDataUrl">>;
}

/** Nothing hydrated: first-party agents resolve from their static labels,
 *  externals to a prettified id and a monogram. */
export const EMPTY_AGENT_REGISTRY: AgentRegistrySnapshot = {
  catalogById: {},
  registryEntries: [],
};

/** Resolves an agent type or plugin id to its identity. */
export type AgentMetaResolver = (agentTypeOrPluginId: string | null | undefined) => AgentMeta;

/** The identities Atlas ships a brand mark and a fixed label for. Their chip
 *  is the neutral `agent.chip.*` pair; their MARK is tinted from
 *  `agent-brand.ts`, which is a constant rather than a theme key (ADR-0002). */
const FIRST_PARTY: readonly FirstPartyAgent[] = [
  "claude-code",
  "codex",
  "opencode",
  "cursor",
  "kilo",
  "atlas-agent",
];

/** Ids that ARE Claude Code: the retired built-in specs and the registry's
 *  ACP adapter. Deliberately a list, not `startsWith("claude")`. */
const CLAUDE_CODE_IDS: ReadonlySet<string> = new Set([
  "claude",
  "claude-code-ts",
  "claude-code-rs",
  "claude-acp",
]);

/** Map an agentType OR plugin id to first-party identity, when it is one. */
function firstPartyOf(id: string): FirstPartyAgent | null {
  if (FIRST_PARTY.includes(id as FirstPartyAgent)) return id as FirstPartyAgent;
  // The real Claude ids only — the registry's `claude-acp` is Claude Code and
  // keeps its mark, but a third-party `claude-*` agent must not borrow it.
  if (CLAUDE_CODE_IDS.has(id)) return "claude-code";
  return null;
}

/** Identity for `agentTypeOrPluginId`, read from `snapshot`.
 *
 *  TOTAL by construction: this is the identity chokepoint every surface
 *  (glyphs, pills, sidebar, memory, timeline) funnels through, and a single
 *  non-string slipping in crashed the whole tree ("id.startsWith is not a
 *  function" inside AgentMark, caught only by the app-level error boundary).
 *  A missing id resolves to the NATIVE agent instead of throwing. It used to
 *  resolve to Claude Code; since the port there are no default ACP agents
 *  (ADR-0002), so naming one here would claim an agent the user may
 *  never have installed. The native agent is the only one always present. */
export function resolveAgentMeta(
  agentTypeOrPluginId: string | null | undefined,
  snapshot: AgentRegistrySnapshot,
): AgentMeta {
  const id =
    typeof agentTypeOrPluginId === "string" && agentTypeOrPluginId.length > 0
      ? agentTypeOrPluginId
      : NATIVE_AGENT_ID;
  const catalog = snapshot.catalogById[id] ?? null;
  const firstParty = firstPartyOf(id);
  if (firstParty) {
    // First-party branding stays STATIC on purpose: labels and brand icons are
    // Atlas's own design, not registry metadata, and this path is called from
    // non-reactive boot code before any catalog exists.
    return {
      pluginId: PLUGIN_ID_BY_AGENT[firstParty],
      agentType: firstParty,
      label: catalog?.displayName ?? AGENT_LABEL[firstParty],
      firstPartyIcon: firstParty,
      iconDataUrl: null,
      external: false,
      source: catalog?.source ?? null,
      availability: catalog ? availabilityOf(catalog) : null,
    };
  }
  const entry = snapshot.registryEntries.find((e) => e.id === id) ?? null;
  return {
    pluginId: id,
    agentType: id,
    // Catalog first (it already merged manifest + install + discovery), then
    // the registry listing, then a last-resort prettified id.
    label: catalog?.displayName ?? catalog?.name ?? entry?.name ?? prettifyId(id),
    firstPartyIcon: null,
    iconDataUrl: catalog?.iconDataUrl ?? entry?.iconDataUrl ?? null,
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
  // Only the retired built-in spec ids alias to the persisted "claude-code".
  // `claude-acp` is a registry agent whose identity is its plugin id (see
  // `agentTypeFromPluginId`), and a third-party `claude-*` is its own agent.
  if (agentType === "claude-code-ts" || agentType === "claude-code-rs") return "claude-code";
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
