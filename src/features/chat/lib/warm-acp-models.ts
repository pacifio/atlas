// Background model-list warming for the ACP agents (Claude Code / Codex /
// OpenCode).
//
// Models are advertised in a `session/new` response, so the only way to learn
// them is to open a session. To make the model picker instant — and to let the
// user switch to another agent with its models already populated — we warm
// each agent's model list in the background and persist it (acp-models-cache):
//
//   • When a chat is active on agent A, warm the other ACP agents the user has
//     touched before (so a switch is instant the first time too).
//   • On Atlas startup, silently refresh the agents we've cached before
//     (optimistic UI: the cache drives the picker, this just keeps it fresh).
//
// The harvested session has no tab bound to it (the frontend never createSession's
// it), so it's invisible to the UI and never persisted (no turn runs). Agents are
// pooled per plugin, so this is one cheap extra ACP session per agent per launch.

import { agents, ensureAgent } from "./agents-api";
import { ACP_AGENTS, pluginIdForAgent, type SwitchableAgent } from "@/types/agent";
import { isAgentDisabled } from "@/features/agents/lib/agent-meta";
import {
  loadCachedAcpModels,
  saveCachedAcpModels,
  isCachedAcpModelsFresh,
} from "./acp-models-cache";

/** How long a cached model list is trusted before a background re-warm. The
 *  catalog is effectively static (only changes on an agent update), so re-
 *  fetching it every launch — by spawning a throwaway ACP session — is pure
 *  waste. A week keeps it fresh enough while eliminating the per-launch spawns. */
const MODELS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function asAcpAgent(agentType: string): SwitchableAgent | null {
  return (ACP_AGENTS as string[]).includes(agentType) ? (agentType as SwitchableAgent) : null;
}

/** The ACP agents to prefetch when `agentType` is active: every other ACP
 *  agent the user has used before (has a persisted model cache). Warming
 *  never-touched agents would spawn CLIs the user may not even have installed.
 *  Agents the user turned off are skipped too — a disabled agent must not be
 *  spawned in the background (and a previously-used one still has a cache, so
 *  the `loadCachedAcpModels` test alone would let it through). */
export function otherAcpAgents(agentType: string): SwitchableAgent[] {
  if (!asAcpAgent(agentType)) return [];
  return ACP_AGENTS.filter(
    (a) => a !== agentType && !isAgentDisabled(a) && loadCachedAcpModels(a) !== null,
  );
}

// Warm at most once per agent per app session (a model list is static per
// agent); a failure clears the flag so a later trigger can retry.
const warmed = new Set<string>();

/**
 * Open a throwaway session for `agentType`, read its advertised models, and
 * persist them to the cache. No-op for non-ACP agents or if already warmed this
 * session. Best-effort + silent — never throws into the caller.
 */
export async function warmAcpModels(agentType: string, cwd: string): Promise<void> {
  const at = asAcpAgent(agentType);
  if (!at) return;
  // Turned off in Settings → Agents: never spawn it, not even for a throwaway
  // model-harvest session. (Also guarded in Rust — this just avoids the
  // pointless round-trip and its rejection.)
  if (isAgentDisabled(at)) return;
  if (warmed.has(at)) return;
  // TTL gate: if we already have a fresh cached list, DON'T spawn a throwaway
  // session to re-fetch a static catalog — the cache drives the picker and any
  // real chat session reconciles it. Don't mark `warmed` here, so clearing the
  // cache (or it aging out) lets a later trigger re-warm.
  if (isCachedAcpModelsFresh(at, MODELS_TTL_MS)) return;
  warmed.add(at);
  try {
    const agent = await ensureAgent(pluginIdForAgent(at));
    const key = await agents.newSession(agent.agent_id, cwd);
    const snap = await agents.snapshot(key);
    const models = snap.available_models ?? [];
    if (models.length > 0) {
      saveCachedAcpModels(at, {
        currentModel: snap.current_model,
        availableModels: models,
      });
    }
  } catch {
    warmed.delete(at); // allow a later retry
  }
}

/**
 * Startup refresh: silently re-warm every ACP agent we've cached before (i.e.
 * the user has used it), keeping the cache fresh without spawning agents the
 * user never touches. Deferred so it never blocks launch.
 */
export function refreshCachedAcpModels(cwd: string): void {
  for (const agentType of ACP_AGENTS) {
    if (loadCachedAcpModels(agentType)) {
      void warmAcpModels(agentType, cwd);
    }
  }
}
