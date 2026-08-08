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
}

const key = (acpSessionId: string) => `atlas:context-usage:${acpSessionId}`;

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
      localStorage.setItem(key(acpSessionId), JSON.stringify(usage));
    }
  } catch {
    // storage full / unavailable — caching is best-effort
  }
}
