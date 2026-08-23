// Persisted per-agent ACP model cache.
//
// An agent advertises its selectable models as a `category: "model"` session
// config option — but that only arrives after the agent process spawns + the
// ACP handshake + new_session complete (~3-4s on a fresh switch). The list is
// effectively static per agent, so we persist the last set we saw and
// optimistically pre-fill the composer's model picker the instant the user
// switches or resumes a session, then reconcile when a live session confirms.
// Keyed by agentType so each agent has its own cache. Mirrors `acp-modes-cache`.
//
// The LIST only, deliberately. Which model is current is a property of one
// session, not of the agent: caching it under the agent's key made a `/model`
// in one chat silently relabel every other chat on that agent — and because
// `setAcpModels` only seeds a current model when none is set, the real session's
// own value could never correct it. Sessions get their current model from the
// snapshot (which falls back to the agent's default) or the live delta.

import type { SessionModeInfo } from "@/types/agents";

const key = (agentType: string) => `atlas:acp-models:${agentType}`;

export interface CachedAcpModels {
  availableModels: SessionModeInfo[];
}

/** Last-seen models for an agent, or null if we've never bound one. */
export function loadCachedAcpModels(agentType: string): CachedAcpModels | null {
  try {
    const raw = localStorage.getItem(key(agentType));
    if (!raw) return null;
    const v = JSON.parse(raw) as CachedAcpModels;
    if (Array.isArray(v?.availableModels) && v.availableModels.length > 0) return v;
  } catch {
    // corrupt / unavailable storage — treat as a cache miss
  }
  return null;
}

/** Persist the models confirmed by a live session (no-op for empty sets). */
export function saveCachedAcpModels(agentType: string, models: CachedAcpModels): void {
  try {
    if (models.availableModels.length > 0) {
      localStorage.setItem(key(agentType), JSON.stringify(models));
    }
  } catch {
    // storage full / unavailable — caching is best-effort
  }
}
