// Persisted per-agent ACP mode cache.
//
// A non-Claude agent (Codex) advertises its permission modes (read-only / auto /
// full-access) in its `session/new` response — but that only arrives AFTER the
// agent process spawns (npx) and the ACP handshake + new_session complete, which
// is the ~3-4s a fresh switch pays. The modes are effectively static for a given
// agent, so we persist the last set we saw and optimistically pre-fill the
// composer's mode picker the instant the user switches, then reconcile when the
// real session confirms. Keyed by agentType so each agent has its own cache.

import type { SessionModeInfo } from "@/types/agents";

// v2: builds before this shipped a cache that could be written under the WRONG
// agent — a stale Claude binding snapshotted while the tab had already been
// relabelled to Codex stored Claude's modes (default/acceptEdits/plan/…) under
// `codex`. Seeding from that left Codex on a mode id it does not have, so the
// picker pill fell back to the literal "Mode" and every pick was rejected by the
// agent. The version segment retires those poisoned entries instead of asking
// people to clear storage; `setAcpModes` now gates the write on the snapshot's
// own plugin id so they cannot be rewritten.
const key = (agentType: string) => `atlas:acp-modes:v2:${agentType}`;

export interface CachedAcpModes {
  currentMode: string | null;
  availableModes: SessionModeInfo[];
}

/** Last-seen modes for an agent, or null if we've never bound one. */
export function loadCachedAcpModes(agentType: string): CachedAcpModes | null {
  try {
    const raw = localStorage.getItem(key(agentType));
    if (!raw) return null;
    const v = JSON.parse(raw) as CachedAcpModes;
    if (!Array.isArray(v?.availableModes) || v.availableModes.length === 0)
      return null;
    // A current mode that isn't one of the available ones is not usable: the
    // picker would render its "Mode" fallback and the first pick would push an
    // id the agent rejects. Keep the list, drop the orphan.
    if (
      v.currentMode &&
      !v.availableModes.some((m) => m.id === v.currentMode)
    ) {
      return { ...v, currentMode: null };
    }
    return v;
  } catch {
    // corrupt / unavailable storage — treat as a cache miss
  }
  return null;
}

/** Persist the modes confirmed by a live session (no-op for empty sets). */
export function saveCachedAcpModes(
  agentType: string,
  modes: CachedAcpModes,
): void {
  try {
    if (modes.availableModes.length > 0) {
      localStorage.setItem(key(agentType), JSON.stringify(modes));
    }
  } catch {
    // storage full / unavailable — caching is best-effort
  }
}
