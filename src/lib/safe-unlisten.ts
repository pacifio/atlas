import type { UnlistenFn } from "@tauri-apps/api/event";

/**
 * Call a Tauri `UnlistenFn`, swallowing the benign race where the listener is
 * already gone. Tauri's generated `unlisten_js_script` reads
 * `listeners[eventId].handlerId` guarded only by the per-event object existing,
 * not the entry itself — so unlistening an event whose entry was already
 * removed throws `undefined is not an object (… .handlerId)`. Because our
 * cleanups call the unlisten without a `.catch`, that bubbles up as an
 * "Unhandled Promise Rejection". It's harmless (the listener is gone either
 * way) and gets more likely with fast mount/unmount churn — e.g. split-view
 * columns mounting/unmounting terminals and browsers.
 *
 * `UnlistenFn` is typed `() => void` but is implemented as an async function,
 * so the call returns a promise we attach a no-op `.catch` to.
 */
export function safeUnlisten(un: UnlistenFn | null | undefined): void {
  if (!un) return;
  try {
    const r = (un as unknown as () => unknown)();
    if (r && typeof (r as Promise<unknown>).catch === "function") {
      (r as Promise<unknown>).catch(() => {});
    }
  } catch {
    /* listener already removed */
  }
}

/** Resolve a pending `listen(...)` promise and unlisten it safely. */
export function safeUnlistenPromise(
  p: Promise<UnlistenFn> | null | undefined,
): void {
  p?.then(safeUnlisten).catch(() => {});
}
