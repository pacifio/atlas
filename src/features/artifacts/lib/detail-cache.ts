/**
 * A small LRU of already-read Session timelines.
 *
 * Opening a Session round-trips to SQLite, decodes a few hundred entries, and
 * hands them across the IPC boundary. That is fine once; it is not fine every
 * time someone steps back to the board and into the next row, which is exactly
 * how the Timeline is used. The read is *pure* for a finished Session — the same
 * store, the same id, the same bytes — so the second one is waste.
 *
 * Cached entries are served **synchronously on mount** and then refreshed in the
 * background, so a revisit paints immediately and a live Session still grows.
 * That ordering is the whole point: a cache that resolves in a promise is still
 * a frame of blank panel.
 *
 * Bounded because a Session's entries carry 2 KB of preview text each and a
 * long one runs to hundreds — a few dozen of them is real memory. Eviction is
 * insertion-order LRU via `Map`, which preserves it and lets a hit re-insert to
 * the young end in two lines.
 */

import type { SessionDetail } from "../types";
import { boardKey } from "./board-key";

/** How many Sessions stay resident. Roughly the depth of a browsing session. */
const CAPACITY = 24;

const cache = new Map<string, SessionDetail>();

/** Which Session, from where. The server Project is part of the key: a row
 *  from a Project with no checkout here has an empty `projectPath`, and one
 *  Session id can be held by two Projects — see `board-key.ts`. */
export interface DetailRef {
  sessionId: string;
  projectPath: string;
  remoteProjectId?: string | null;
}

function key(ref: DetailRef): string {
  return boardKey({
    id: ref.sessionId,
    projectPath: ref.projectPath,
    remoteProjectId: ref.remoteProjectId ?? null,
  });
}

export function readCachedDetail(ref: DetailRef): SessionDetail | undefined {
  const k = key(ref);
  const hit = cache.get(k);
  if (!hit) return undefined;
  // Re-insert so the most recently read is the last to be evicted.
  cache.delete(k);
  cache.set(k, hit);
  return hit;
}

export function writeCachedDetail(ref: DetailRef, detail: SessionDetail): void {
  const k = key(ref);
  cache.delete(k);
  cache.set(k, detail);
  if (cache.size > CAPACITY) {
    // `keys()` yields in insertion order, so the first is the oldest.
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
}

/**
 * Forget one Session, wherever it is held.
 *
 * The Timeline is live: a Session can grow while it is closed — its own agent
 * is still working, or a teammate's realtime frame says their copy changed.
 * A cache entry is a snapshot, and a snapshot of a session that has since
 * moved is exactly the thing this cache must not serve synchronously on the
 * next open.
 *
 * By Session id across every Project rather than by the full row key: a
 * realtime frame names the Session, not the checkout it is filed under here,
 * and the same id can be held by two Projects (`board-key.ts`).
 */
export function invalidateCachedDetail(sessionId: string): void {
  for (const k of cache.keys()) {
    // The row key is `project\0path\0id`, so the id is the last field.
    if (k.slice(k.lastIndexOf("\u0000") + 1) === sessionId) cache.delete(k);
  }
}

/**
 * Drop everything.
 *
 * Called on a Project or Organisation switch: the board is rebuilt from a
 * different set of projects, and a stale timeline surviving that would be the
 * cross-Project leak this feature spends its whole design avoiding.
 */
export function clearDetailCache(): void {
  cache.clear();
}
