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
 *  that already re-render on registry changes. */
export function agentMeta(agentTypeOrPluginId: string): AgentMeta {
  const id = agentTypeOrPluginId;
  const firstParty = firstPartyOf(id);
  if (firstParty) {
    return {
      pluginId: PLUGIN_ID_BY_AGENT[firstParty],
      agentType: firstParty,
      label: AGENT_LABEL[firstParty],
      firstPartyIcon: firstParty,
      iconDataUrl: null,
      cssClass: FIRST_PARTY_CSS[firstParty],
      external: false,
    };
  }
  const { plugins, registryEntries } = useAgentRegistryStore.getState();
  const entry = registryEntries.find((e) => e.id === id) ?? null;
  const plugin = plugins.find((p) => p.plugin_id === id) ?? null;
  return {
    pluginId: id,
    agentType: id,
    label: entry?.name ?? plugin?.display_name ?? prettifyId(id),
    firstPartyIcon: null,
    iconDataUrl: entry?.iconDataUrl ?? null,
    cssClass: "",
    external: true,
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

/** Whether the user turned this optional built-in off in Settings → Agents.
 *  Always false for Claude / Codex / Cersei and for external agents (which are
 *  uninstalled rather than disabled). Rust enforces the same rule at spawn —
 *  see `AppSettings::builtin_disabled`. */
export function isAgentDisabled(agentTypeOrPluginId: string): boolean {
  if (!isOptionalBuiltinAgent(agentTypeOrPluginId)) return false;
  return useProjectStore.getState().settings.disabledBuiltinAgents.includes(agentTypeOrPluginId);
}

/** The dynamic switch list: first-party agents in their fixed order, then
 *  installed external plugin ids sorted by label. Drives option+/ cycling and
 *  the composer "+" agent picker. Agents the user turned off are omitted —
 *  that is what "off" means everywhere the user picks an agent. */
export function switchableAgentIds(): string[] {
  const { plugins } = useAgentRegistryStore.getState();
  const externals = plugins
    .filter((p) => p.external)
    .map((p) => p.plugin_id)
    .sort((a, b) => agentMeta(a).label.localeCompare(agentMeta(b).label));
  return [...SWITCHABLE_AGENTS, ...externals].filter((id) => !isAgentDisabled(id));
}

/** Reactive variant for components that must re-render when agents are
 *  installed/uninstalled — or turned on/off, hence the settings subscription
 *  alongside the registry signature. */
export function useSwitchableAgents(): string[] {
  useAgentRegistryStore((s) => s.signature);
  useProjectStore((s) => s.settings.disabledBuiltinAgents);
  return switchableAgentIds();
}
