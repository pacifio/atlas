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
//
// # Why v2 wraps the array
//
// v1 stored a bare array and treated an empty one as "no cache", which made
// "this agent advertises no knobs" indistinguishable from "we have never heard
// from this agent". The pill could only tell the two apart by waiting for a
// live session — which is the 3-4 second spinner on every cold start, for an
// answer that never changes. v2 stores an envelope, so an EMPTY list is a
// cached verdict in its own right and the pill can settle instantly.

const KEY_V2 = (agentType: string) => `atlas:acp-config-options:v2:${agentType}`;
// Read-only, for one upgrade hop: a v1 entry is still a truthful non-empty list.
const KEY_V1 = (agentType: string) => `atlas:acp-config-options:v1:${agentType}`;

/** An entry without an id can't be written back with `set_config_option`, so a
 *  partially-corrupt cache is a miss, not a picker that fails on click
 *  (upstream's rule, kept through the merge). */
function usableList(v: unknown): v is unknown[] {
  return (
    Array.isArray(v) &&
    v.every(
      (o) =>
        !!o &&
        typeof o === "object" &&
        typeof (o as Record<string, unknown>).id === "string" &&
        (o as Record<string, unknown>).id !== "",
    )
  );
}

/** What this agent last advertised.
 *
 *  - a list (possibly **empty** — a real answer meaning "no knobs")
 *  - `null` when nothing has ever been heard from this agent, which is the only
 *    state that justifies a loading pill. */
export function loadCachedAcpConfigOptions(agentType: string): unknown[] | null {
  try {
    const raw = localStorage.getItem(KEY_V2(agentType));
    if (raw) {
      const v = JSON.parse(raw) as unknown;
      const options = (v as { options?: unknown } | null)?.options;
      if (usableList(options)) return options;
    }
    const legacy = localStorage.getItem(KEY_V1(agentType));
    if (legacy) {
      const v = JSON.parse(legacy) as unknown;
      // v1 could not record an empty verdict, so an empty v1 payload is a miss.
      if (usableList(v) && v.length > 0) return v;
    }
  } catch {
    // corrupt / unavailable storage — treat as a cache miss
  }
  return null;
}

/** Persist what a live session settled on, empty lists included — that is the
 *  verdict the pill renders as "Default" without spinning first.
 *
 *  Callers pass what actually landed in the store, so the store's own
 *  "an empty snapshot must not erase a live list" guard governs both. */
export function saveCachedAcpConfigOptions(agentType: string, options: unknown[]): void {
  try {
    localStorage.setItem(KEY_V2(agentType), JSON.stringify({ options }));
  } catch {
    // storage full / unavailable — caching is best-effort
  }
}
