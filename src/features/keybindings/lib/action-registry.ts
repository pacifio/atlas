/**
 * The keybinding commands, callable by id.
 *
 * `ACTIONS` is only the chord registry: which ids exist and which key runs
 * them. What an id *does* lives in closures the app shell builds on every
 * render (`useActionHotkeys` in `App.tsx`). This module is where those
 * closures are reachable from outside the keydown handler, so a chord and a
 * programmatic caller — the command palette, or Atlas Agent's `ui_command`
 * — run the identical code.
 *
 * Only `global` commands are runnable here. A focus-scoped one (terminal
 * find, knowledge-base save…) means something only on its surface and is
 * dispatched by `useScopedHotkeys` there.
 */

import { ACTION_BY_ID, ACTIONS, isActionId, type ActionId } from "./actions";

export type ActionHandlers = Partial<Record<ActionId, () => void>>;

export type RunActionResult =
  | { ok: true }
  | { ok: false; reason: "unknown-id" | "not-global" | "not-registered" };

/** A getter, not a map: the shell's closures are rebuilt every render, and
 *  the newest one is the one that sees current state. */
let source: (() => ActionHandlers) | null = null;
const listeners = new Set<() => void>();

/** Observe registration and changes to the ids supplied by the live getter. */
export function subscribeActionHandlers(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Handler closures can change without the shell registering a new getter. */
export function notifyActionHandlersChanged(): void {
  for (const listener of listeners) listener();
}

/** Make `get`'s handlers the runnable ones; returns the matching unregister,
 *  which leaves a newer registration alone. */
export function registerActionHandlers(get: () => ActionHandlers): () => void {
  source = get;
  notifyActionHandlersChanged();
  return () => {
    if (source === get) {
      source = null;
      notifyActionHandlersChanged();
    }
  };
}

export function hasActionHandler(id: ActionId): boolean {
  return !!source?.()[id];
}

/** Run the global command `id` as its chord would. */
export function runAction(id: string): RunActionResult {
  if (!isActionId(id)) return { ok: false, reason: "unknown-id" };
  if (ACTION_BY_ID[id].when !== "global") return { ok: false, reason: "not-global" };
  const handler = source?.()[id];
  if (!handler) return { ok: false, reason: "not-registered" };
  handler();
  return { ok: true };
}

/** The ids {@link runAction} would run right now, in registry order. */
export function runnableActionIds(): ActionId[] {
  const handlers = source?.() ?? {};
  return ACTIONS.filter((a) => a.when === "global" && handlers[a.id]).map((a) => a.id);
}
