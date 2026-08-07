/**
 * Flush registry — the "save all pending UI state" coordinator used when
 * switching or closing workspaces (and on app quit).
 *
 * Many stores persist project-scoped state to `<project>/.atlas/*.json`
 * through their own *debounced* `invoke(...)` writes. None of them expose a
 * way to (a) cancel the pending debounce and (b) await the resulting write.
 * Without that, switching workspaces could drop the last few edits that were
 * still sitting in a debounce timer.
 *
 * Each store registers a `flush()` that MUST: cancel its debounce timer,
 * perform the save immediately, and return a promise that resolves only once
 * the underlying `invoke` settles. `flushAll()` awaits every registered
 * flush. It is intentionally resilient — one store throwing never blocks the
 * others (and therefore never blocks a workspace switch).
 */

/** Context passed to each flush so it writes to the OUTGOING workspace even
 *  after `currentProject` has already swapped to the incoming one. */
export interface FlushCtx {
  workspaceId: string | null;
  path: string | null;
  /** Why the flush is running. A `"switch"` stays on screen — a registrant
   *  holding non-user data (app-state metadata) may fire-and-forget to keep
   *  the switch's critical path short. Anything terminal (`"quit"`, close)
   *  must await everything. Defaults to `"quit"` semantics when absent so an
   *  unaware caller gets the safe behavior. */
  reason?: "switch" | "quit";
}

export type FlushFn = (ctx: FlushCtx) => Promise<void>;

interface Registration {
  /** Stable label, for dedupe + diagnostics. */
  id: string;
  flush: FlushFn;
}

const registry = new Map<string, Registration>();

/**
 * Register (or replace) a store's flush function. Returns an unregister
 * callback. Safe to call at module load — stores register once on import.
 */
export function registerFlush(id: string, flush: FlushFn): () => void {
  registry.set(id, { id, flush });
  return () => {
    const current = registry.get(id);
    if (current && current.flush === flush) registry.delete(id);
  };
}

/**
 * Flush every registered store for the given workspace. Resolves only after
 * ALL flushes settle, so callers can `await flushAll(ctx)` and be certain
 * pending writes have hit disk. Individual failures are swallowed (logged) so
 * a single bad store can't strand a workspace switch.
 */
export async function flushAll(ctx: FlushCtx = { workspaceId: null, path: null }): Promise<void> {
  const pending = Array.from(registry.values()).map((r) =>
    r.flush(ctx).catch((e) => {
      console.warn(`flushAll: "${r.id}" flush failed:`, e);
    }),
  );
  await Promise.all(pending);
}
