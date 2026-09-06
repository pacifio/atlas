import { useEffect, useRef, type RefObject } from "react";
import type { ActionId } from "./actions";
import { matchesCombo } from "./combo";
import { useKeybindingsStore } from "../stores/keybindings-store";

/**
 * Does this keydown match any live chord for `id` in the active profile?
 * Non-hook, reads the store directly — for feature listeners that keep their
 * own `keydown` handler and only need the literal key check replaced.
 * Always false while the recorder popup owns the keyboard.
 */
export function matchesAction(e: KeyboardEvent, id: ActionId): boolean {
  const state = useKeybindingsStore.getState();
  if (state.recording) return false;
  const bindings = state.resolved.byAction.get(id);
  if (!bindings) return false;
  for (const b of bindings) if (matchesCombo(e, b.combo)) return true;
  return false;
}

export type ScopedHandler = (e: KeyboardEvent) => boolean | void;

export interface ScopedHotkeysOptions {
  /** Only fire while focus is inside this element (and it is displayed). */
  rootRef?: RefObject<HTMLElement | null>;
  requireFocusWithin?: boolean;
  /** Capture phase (default) pre-empts the global dispatcher — the terminal
   *  and hint-nav rely on this. Bubble keeps the historical ordering for
   *  handlers that never needed to shadow a global. */
  capture?: boolean;
  /** Return `false` to decline the event (it falls through to whoever is next,
   *  e.g. the global close-tab when the terminal has nothing to close). */
  handlers: Partial<Record<ActionId, ScopedHandler>>;
}

/**
 * Window-level dispatcher for a feature surface's shortcuts. On a match the
 * event is consumed (`preventDefault` + `stopImmediatePropagation`) unless the
 * handler returned `false`.
 */
export function useScopedHotkeys(options: ScopedHotkeysOptions) {
  const ref = useRef(options);
  ref.current = options;
  const capture = options.capture ?? true;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { rootRef, requireFocusWithin, handlers } = ref.current;
      if (requireFocusWithin) {
        const root = rootRef?.current;
        if (!root || root.offsetParent == null || !root.contains(document.activeElement)) return;
      }
      for (const id of Object.keys(handlers) as ActionId[]) {
        if (!matchesAction(e, id)) continue;
        const handled = handlers[id]?.(e);
        if (handled === false) continue;
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
    };
    window.addEventListener("keydown", onKey, { capture });
    return () => window.removeEventListener("keydown", onKey, { capture });
  }, [capture]);
}
