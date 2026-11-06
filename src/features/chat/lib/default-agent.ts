// Which coding agent a BRAND-NEW chat starts on.
//
// The `defaultAgent` setting — the current project's value when its
// `.atlas/config.toml` sets one — provided that agent is installed; the native
// agent otherwise. The native agent is in-process, so it needs no install, no
// sign-in and no probe: it is the one agent a fresh profile is guaranteed to
// have (ADR-0002: Atlas ships no ACP agents).
//
// The fallback is the point. This used to start on Claude Code whenever a
// probe said it was installed, and two things were wrong with that. It named an
// agent a fresh install does not have — and the agent switcher lives inside the
// composer that agent's absence disables, so the user could not switch away
// from it either. And the probe was asynchronous, which held off creating the
// session until it settled. So the answer stays synchronous: an agent the
// catalog doesn't list as installed (including before the catalog's first
// load) gets the native agent, never a session that cannot start.

import { NATIVE_AGENT_ID, type SwitchableAgent } from "@/types/agent";
import { useAppStore } from "@/features/app/stores/app-store";
import { useAgentRegistryStore } from "@/features/agents/stores/agent-registry-store";
import { projectSettingNow } from "@/features/settings/lib/use-scoped-setting";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { loadLastAgentPref } from "./last-agent-pref";

/** `wanted` when it names an installed agent; null otherwise. */
function installed(wanted: string | null): SwitchableAgent | null {
  const id = wanted?.trim();
  if (!id) return null;
  if (id === NATIVE_AGENT_ID) return NATIVE_AGENT_ID;
  const entry = useAgentRegistryStore.getState().catalogById[id];
  return entry?.installed ? entry.agentType : null;
}

/** The agent a new chat starts on. Synchronous and total: there is nothing to
 *  probe, so there is no "not decided yet". */
export function defaultAgentForNewSession(
  projectPath: string | null | undefined = useAppStore.getState().currentProject?.path,
): SwitchableAgent {
  return installed(projectSettingNow(projectPath, "defaultAgent")) ?? NATIVE_AGENT_ID;
}

/**
 * The agent a session the user starts opens on: the one they last picked in a
 * composer when `newSessionUsesLastAgent` is on and it is still installed,
 * else {@link defaultAgentForNewSession}. Sessions Atlas starts for a purpose
 * (a pull request guide) keep using the default.
 */
export function agentForNewSession(
  projectPath: string | null | undefined = useAppStore.getState().currentProject?.path,
): SwitchableAgent {
  const last = useSettingsStore.getState().settings.newSessionUsesLastAgent
    ? installed(loadLastAgentPref())
    : null;
  return last ?? defaultAgentForNewSession(projectPath);
}
