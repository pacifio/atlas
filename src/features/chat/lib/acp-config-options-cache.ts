// Persisted per-agent ACP config-options cache.
//
// An agent advertises its config options (reasoning effort, sub-agent, fast
// toggle…) in its `session/new` response — which only arrives AFTER the agent
// process spawns (npx cold start) and the ACP handshake + new_session
// complete. That is the 2-3s a fresh agent switch pays, during which the
// composer's effort pill sits in its loading state.
//
// The advertised SET is effectively static per agent (only the current VALUE
// moves), so the last-seen list is persisted and used to paint the picker
// optimistically the instant the user switches; the live session then confirms
// and reconciles. Same shape and rationale as `acp-modes-cache` — see there
// for the cross-agent poisoning incident that motivated the version segment
// and the source-gated writes.

import type { AcpConfigOption } from "@/types/agents";

const key = (agentType: string) => `atlas:acp-config-options:v1:${agentType}`;

/** Last-seen config options for an agent, or null if never bound / unusable. */
export function loadCachedAcpConfigOptions(agentType: string): AcpConfigOption[] | null {
  try {
    const raw = localStorage.getItem(key(agentType));
    if (!raw) return null;
    const v = JSON.parse(raw) as AcpConfigOption[];
    if (!Array.isArray(v) || v.length === 0) return null;
    // Entries without an id can't be written back with `set_config_option`,
    // so a partially-corrupt cache is treated as a miss rather than painting
    // pickers that would fail on click.
    if (v.some((o) => typeof o?.id !== "string" || !o.id)) return null;
    return v;
  } catch {
    // corrupt / unavailable storage — treat as a cache miss
  }
  return null;
}

/** Persist the options confirmed by a live session (no-op for empty sets).
 *
 *  Empty is deliberately NOT cached: "this agent advertises none" is already
 *  the correct render (the effort pill's Default placeholder), and writing it
 *  would be indistinguishable from a cache miss on read anyway. */
export function saveCachedAcpConfigOptions(agentType: string, options: AcpConfigOption[]): void {
  try {
    if (options.length > 0) {
      localStorage.setItem(key(agentType), JSON.stringify(options));
    }
  } catch {
    // storage full / unavailable — caching is best-effort
  }
}
