import { useEffect, useRef, type RefObject } from "react";
import type { ActionId } from "./actions";
import { matchesCombo } from "./combo";
import { useKeybindingsStore } from "../stores/keybindings-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";

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
  /** Only fire while this tab is the active tab of the focused split column.
   *  Prefer it to `requireFocusWithin` for anything that lives in a tab:
   *  clicking a non-focusable element in a pane moves PANE focus without
   *  moving DOM focus, so an activeElement check leaves the keyboard with the
   *  pane the user just left — and a persistent tab that is mounted but
   *  hidden would otherwise keep answering its chords. */
  tabId?: string;
  /** Capture phase (default) pre-empts the global dispatcher — the terminal
   *  and hint-nav rely on this. Bubble keeps the historical ordering for
   *  handlers that never needed to shadow a global. */
  capture?: boolean;
  /** Return `false` to decline the event (it falls through to whoever is next,
   *  e.g. the global close-tab when the terminal has nothing to close). */
  handlers: Partial<Record<ActionId, ScopedHandler>>;
}

const scopedSources = new Set<{ current: ScopedHotkeysOptions }>();
const scopeListeners = new Set<() => void>();

function scopeIsActive({ rootRef, requireFocusWithin, tabId }: ScopedHotkeysOptions): boolean {
  if (tabId !== undefined && useLayoutStore.getState().activeTabId !== tabId) return false;
  if (requireFocusWithin) {
    const root = rootRef?.current;
    if (!root || root.offsetParent == null || !root.contains(document.activeElement)) return false;
  }
  return true;
}

/** Read-only ownership for hints. A handler may decline; never invoke it to find out. */
export function activeScopedActions(): Set<ActionId> {
  const actions = new Set<ActionId>();
  for (const source of scopedSources) {
    if (!scopeIsActive(source.current)) continue;
    for (const id of Object.keys(source.current.handlers) as ActionId[]) actions.add(id);
  }
  return actions;
}

/** Only a visible hint overlay subscribes to changes in mounted shortcut scopes. */
export function subscribeScopedHotkeys(listener: () => void): () => void {
  scopeListeners.add(listener);
  return () => {
    scopeListeners.delete(listener);
  };
}

function notifyScopes() {
  for (const listener of scopeListeners) listener();
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
    scopedSources.add(ref);
    notifyScopes();
    const onKey = (e: KeyboardEvent) => {
      const { handlers } = ref.current;
      if (!scopeIsActive(ref.current)) return;
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
    return () => {
      window.removeEventListener("keydown", onKey, { capture });
      scopedSources.delete(ref);
      notifyScopes();
    };
  }, [capture]);

  useEffect(notifyScopes, [options]);
}
