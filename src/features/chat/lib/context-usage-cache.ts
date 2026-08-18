// Persisted per-session ACP context-window gauge.
//
// ACP agents (Claude Code / Codex) stream a cumulative context gauge
// (`used`/`size` tokens + cost) via `context_usage` deltas, but — unlike the
// transcript itself — that number lives only in the live worker and is NOT
// written to the session's JSONL on disk. Switching sessions reloads messages
// from disk, and an app restart drops the whole store, so without a cache the
// gauge vanishes. We persist the last-seen gauge keyed by `acpSessionId` (the
// stable transcript identity, == the JSONL filename stem) and re-attach it to
// the trailing assistant message when the transcript reloads.

export interface CachedContextUsage {
  used: number;
  size: number;
  cost: number;
  /** Last-write epoch ms — drives the startup prune. Absent on legacy entries. */
  t?: number;
}

const key = (acpSessionId: string) => `atlas:context-usage:${acpSessionId}`;
const KEY_PREFIX = "atlas:context-usage:";
/** Entries untouched for this long are swept at startup. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Last-seen context gauge for a session, or null if never seen. */
export function loadCachedContextUsage(acpSessionId: string): CachedContextUsage | null {
  try {
    const raw = localStorage.getItem(key(acpSessionId));
    if (!raw) return null;
    const v = JSON.parse(raw) as CachedContextUsage;
    if (typeof v?.used === "number" && typeof v?.size === "number") return v;
  } catch {
    // corrupt / unavailable storage — treat as a cache miss
  }
  return null;
}

/** Persist the latest gauge for a session (best-effort; skips empty gauges). */
export function saveCachedContextUsage(acpSessionId: string, usage: CachedContextUsage): void {
  try {
    if (usage.used > 0 || usage.size > 0) {
      localStorage.setItem(key(acpSessionId), JSON.stringify({ ...usage, t: Date.now() }));
    }
  } catch {
    // storage full / unavailable — caching is best-effort
  }
}

/**
 * Startup sweep: these keys had no removal path at all, so one ~60-byte record
 * per session ever opened accumulated forever. Entries untouched for 30 days
 * are dropped (a live session re-populates on its next `context_usage` delta);
 * legacy entries without a timestamp are stamped now and swept on a later pass.
 */
export function pruneContextUsageCache(): void {
  try {
    const now = Date.now();
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(KEY_PREFIX)) continue;
      try {
        const v = JSON.parse(localStorage.getItem(k) ?? "") as CachedContextUsage;
        if (typeof v?.t !== "number") {
          localStorage.setItem(k, JSON.stringify({ ...v, t: now }));
        } else if (now - v.t > MAX_AGE_MS) {
          stale.push(k);
        }
      } catch {
        stale.push(k); // corrupt entry — sweep it
      }
    }
    for (const k of stale) localStorage.removeItem(k);
  } catch {
    // storage unavailable — nothing to prune
  }
}
