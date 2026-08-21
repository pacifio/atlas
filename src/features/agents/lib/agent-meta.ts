// The ONE agent-identity resolver: label / icon source / css class for any
// agent type or plugin id — first-party, native cersei, installed externals,
// and uninstalled-but-captured externals (registry metadata retained). Every
// surface (composer menu, pill, glyphs, sidebar, memory dropdown, timeline)
// resolves through here instead of hardcoded Records/if-ladders.

import { AGENT_LABEL, NATIVE_AGENT, type AgentType, type BrandedAgent } from "@/types/agent";
import { useAgentRegistryStore } from "../stores/agent-registry-store";

export interface AgentMeta {
  /** Canonical registry id ("claude-acp", "amp-acp", "cersei"…). */
  pluginId: string;
  /** The agentType-shaped identity UI state carries — the same string. */
  agentType: AgentType;
  label: string;
  /** Branded glyph key, or null → use `iconDataUrl` / monogram. */
  firstPartyIcon: BrandedAgent | null;
  iconDataUrl: string | null;
  /** `.agent-*` token class for the amark badge ("" when unbranded). */
  cssClass: string;
  /** True for every ACP agent; false only for the native in-process agent. */
  external: boolean;
}

/** Presentation only — see `BrandedAgent`. An agent missing from this map is
 *  not lesser, it just renders with its own registry icon. */
const BRAND_CSS: Record<BrandedAgent, string> = {
  "claude-acp": "agent-claude",
  "codex-acp": "agent-codex",
  opencode: "agent-opencode",
  cursor: "agent-cursor",
  kilo: "agent-kilo",
  cersei: "agent-cersei",
};

function brandOf(id: string): BrandedAgent | null {
  return id in BRAND_CSS ? (id as BrandedAgent) : null;
}

/** Non-reactive resolver — safe from event handlers, stores, and render paths
 *  that already re-render on registry changes.
 *
 *  TOTAL by construction: this is the identity chokepoint every surface
 *  (glyphs, pills, sidebar, memory, timeline) funnels through, and a single
 *  non-string slipping in crashed the whole tree ("id.startsWith is not a
 *  function" inside AgentMark, caught only by the app-level error boundary).
 *  A missing id resolves to the native agent — the one agent that always
 *  exists — rather than throwing. */
export function agentMeta(agentTypeOrPluginId: string | null | undefined): AgentMeta {
  const id =
    typeof agentTypeOrPluginId === "string" && agentTypeOrPluginId.length > 0
      ? agentTypeOrPluginId
      : NATIVE_AGENT;
  const brand = brandOf(id);
  const { plugins, registryEntries } = useAgentRegistryStore.getState();
  const entry = registryEntries.find((e) => e.id === id) ?? null;
  const plugin = plugins.find((p) => p.plugin_id === id) ?? null;
  return {
    pluginId: id,
    agentType: id,
    label: brand ? AGENT_LABEL[brand] : (entry?.name ?? plugin?.display_name ?? prettifyId(id)),
    firstPartyIcon: brand,
    // A branded agent still prefers its own registry icon only when Atlas has
    // no glyph for it; the glyph is the higher-fidelity asset.
    iconDataUrl: brand ? null : (entry?.iconDataUrl ?? null),
    cssClass: brand ? BRAND_CSS[brand] : "",
    external: id !== NATIVE_AGENT,
  };
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

/** The dynamic switch list: the native agent first, then every installed ACP
 *  agent sorted by label. Drives option+/ cycling and the composer "+" agent
 *  picker.
 *
 *  There is no enable/disable filter any more and no fixed head of the list
 *  beyond the native agent — an agent appears here exactly when it is
 *  installed, and disappears when it is uninstalled. */
export function switchableAgentIds(): string[] {
  const { plugins } = useAgentRegistryStore.getState();
  const externals = plugins
    .filter((p) => p.external)
    .map((p) => p.plugin_id)
    .sort((a, b) => agentMeta(a).label.localeCompare(agentMeta(b).label));
  return [NATIVE_AGENT, ...externals];
}

/** Reactive variant for components that must re-render when agents are
 *  installed or uninstalled. */
export function useSwitchableAgents(): string[] {
  useAgentRegistryStore((s) => s.signature);
  return switchableAgentIds();
}

/** Agent identity → the skills-registry TOOL target whose config dirs the
 *  agent's CLI reads (`agents_list_skill_targets` ids: "claude-code" /
 *  "codex" / "atlas").
 *
 *  This is a capability namespace bridge, not agent special-casing — the same
 *  class of fact as `TranscriptKind`: any adapter fronting the Claude Code CLI
 *  reads `.claude/skills` whatever its registry id, and codex-acp fronts the
 *  Codex CLI's `.codex` dirs. Ids with no skills target pass through
 *  unchanged, which (as before the ACP port) simply never matches a pack's
 *  `enabledAgents` list. */
export function skillToolIdForAgent(agentType: string): string {
  if (agentType.startsWith("claude")) return "claude-code";
  if (agentType === "codex-acp" || agentType === "codex") return "codex";
  return agentType;
}
