/**
 * Who actually runs a command.
 *
 * The keymap says which command a chord means; this says where that command is
 * implemented right now. They are separate because the implementation moves —
 * "find in chat" belongs to whichever chat pane the user is looking at, and
 * with a split view open there are two of them, both mounted, both registered.
 *
 * A handler registered with a `tabId` only runs while that tab is the focused
 * column's active tab. That is the same test `usePaneFind` already applies by
 * hand, for the reason documented there: clicking a non-focusable element
 * inside a pane moves *pane* focus without moving DOM focus, so an
 * `activeElement` check hands the keyboard to the pane the user just left.
 */

/** Returning `false` means "not right now" — the command is declared but has
 *  nothing to do in the component's current state, and the keystroke should
 *  carry on to whatever else wants it. Anything else counts as handled. */
type Handler = () => void | boolean;

interface Entry {
  tabId?: string;
  run: Handler;
}

const entries = new Map<string, Entry[]>();

/** Register a batch of handlers, returning the unregister for cleanup.
 *  Registering the same command twice for the same tab is normal across a
 *  remount; the later registration wins while it lives. */
export function registerHandlers(
  handlers: Record<string, Handler | undefined>,
  tabId?: string,
): () => void {
  const added: Array<{ actionId: string; entry: Entry }> = [];
  for (const [actionId, run] of Object.entries(handlers)) {
    if (!run) continue;
    const entry: Entry = { tabId, run };
    entries.set(actionId, [...(entries.get(actionId) ?? []), entry]);
    added.push({ actionId, entry });
  }
  return () => {
    for (const { actionId, entry } of added) {
      const remaining = (entries.get(actionId) ?? []).filter((e) => e !== entry);
      if (remaining.length) entries.set(actionId, remaining);
      else entries.delete(actionId);
    }
  };
}

/**
 * Run a command, or report that nothing is listening.
 *
 * The caller uses `false` to leave the keystroke alone: swallowing a chord
 * whose command isn't mounted would make ⌘F do nothing at all over a pane that
 * never bound it, rather than falling through to whatever else wants it.
 */
export function runAction(actionId: string, activeTabId: string | null): boolean {
  const candidates = entries.get(actionId);
  if (!candidates?.length) return false;
  // Most recently mounted first, so a remount can't leave a stale handler in
  // front of the live one.
  const ordered = [...candidates].reverse();
  const handler =
    (activeTabId ? ordered.find((e) => e.tabId === activeTabId) : undefined) ??
    ordered.find((e) => e.tabId === undefined);
  if (!handler) return false;
  return handler.run() !== false;
}

/** Test seam: nothing in the app unregisters everything at once. */
export function clearHandlersForTest(): void {
  entries.clear();
}
