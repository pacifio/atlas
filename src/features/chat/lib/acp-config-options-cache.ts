// Persisted per-agent config-option LIST cache (#36).
//
// An agent's knobs (effort select, persona picker, toggles) arrive only after
// spawn + handshake + new_session — and on an app restart a restored tab shows
// its transcript without booting the agent at all, so nothing re-advertises.
// Modes and models survive that gap through their own caches; the knob list
// did not, so the Options pill vanished until the next live session. Same
// remedy, same posture: persist the last advertised list per agentType,
// render it optimistically, reconcile the moment a live session speaks.
//
// The LIST only. Which value is current is a per-session property the live
// session owns; the user's picks are persisted separately (`config-option-prefs`)
// and re-applied against what a live session actually advertises. The list is
// stored raw (the wire's `SessionConfigOption` JSON) so the same
// `parseConfigOptions` projection reads both paths.

// Versioned key (upstream 0.3.0-x convention, like `acp-modes:v2`) so a future
// shape change can abandon stale payloads instead of mis-reading them.
const key = (agentType: string) => `atlas:acp-config-options:v1:${agentType}`;

/** Last-advertised knob list for an agent, or null if none was ever seen. */
export function loadCachedAcpConfigOptions(agentType: string): unknown[] | null {
  try {
    const raw = localStorage.getItem(key(agentType));
    if (!raw) return null;
    const v = JSON.parse(raw) as unknown;
    // An entry without an id can't be written back with `set_config_option`,
    // so a partially-corrupt cache is a miss, not a picker that fails on
    // click (upstream's rule, kept through the merge).
    const usable =
      Array.isArray(v) &&
      v.every(
        (o) =>
          !!o &&
          typeof o === "object" &&
          typeof (o as Record<string, unknown>).id === "string" &&
          (o as Record<string, unknown>).id !== "",
      );
    if (usable && v.length > 0) return v;
  } catch {
    // corrupt / unavailable storage — treat as a cache miss
  }
  return null;
}

/** Persist the knobs a live session advertised (no-op for empty sets — an
 *  agent that advertises nothing must not erase what another session saw). */
export function saveCachedAcpConfigOptions(agentType: string, options: unknown[]): void {
  try {
    if (options.length > 0) {
      localStorage.setItem(key(agentType), JSON.stringify(options));
    }
  } catch {
    // storage full / unavailable — caching is best-effort
  }
}
