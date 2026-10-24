import { useSyncExternalStore } from "react";
import { isMac } from "@/lib/platform";
import { useHintStore } from "@/features/hint-nav/stores/hint-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useKeybindingsStore } from "../stores/keybindings-store";
import { runnableActionIds, subscribeActionHandlers } from "./action-registry";
import { activeScopedActions, subscribeScopedHotkeys } from "./use-scoped-hotkeys";
import { navigationBindings } from "./navigation-hints";
import type { ResolvedBinding, ResolvedState } from "./resolve";

let inputs:
  | {
      resolved: ResolvedState;
      registered: string;
      scoped: string;
      blocked: boolean;
      mac: boolean;
    }
  | undefined;
let snapshot: ResolvedBinding[] = [];

/** The same live ownership snapshot supplies both keycaps and aria-keyshortcuts. */
export function liveNavigationBindings(): ResolvedBinding[] {
  const { resolved, recording } = useKeybindingsStore.getState();
  const registered = runnableActionIds();
  const scoped = activeScopedActions();
  const registeredKey = registered.join(" ");
  const scopedKey = [...scoped].sort().join(" ");
  const blocked = recording || useHintStore.getState().open;
  if (
    inputs?.resolved === resolved &&
    inputs.registered === registeredKey &&
    inputs.scoped === scopedKey &&
    inputs.blocked === blocked &&
    inputs.mac === isMac
  )
    return snapshot;
  inputs = { resolved, registered: registeredKey, scoped: scopedKey, blocked, mac: isMac };
  const next = blocked ? [] : navigationBindings(resolved, isMac, new Set(registered), scoped);
  // React requires a stable snapshot. Irrelevant scope/focus changes need no render.
  if (next.length !== snapshot.length || next.some((binding, i) => binding !== snapshot[i]))
    snapshot = next;
  return snapshot;
}

const listeners = new Set<() => void>();
let stopListening: (() => void) | undefined;

function notify() {
  for (const listener of listeners) listener();
}

/** Share window/store listeners across the titlebar, all tab strips and the overlay. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    const stops = [
      subscribeActionHandlers(notify),
      subscribeScopedHotkeys(notify),
      useKeybindingsStore.subscribe(notify),
      useHintStore.subscribe(notify),
      useLayoutStore.subscribe((state, previous) => {
        if (state.activeTabId !== previous.activeTabId) notify();
      }),
    ];
    window.addEventListener("focusin", notify, true);
    window.addEventListener("focusout", notify, true);
    window.addEventListener("resize", notify);
    stopListening = () => {
      for (const stop of stops) stop();
      window.removeEventListener("focusin", notify, true);
      window.removeEventListener("focusout", notify, true);
      window.removeEventListener("resize", notify);
    };
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopListening?.();
      stopListening = undefined;
    }
  };
}

/** Registration happens in effects; subscribe even when no modifier is held. */
export function useNavigationBindings(): ResolvedBinding[] {
  return useSyncExternalStore(subscribe, liveNavigationBindings, liveNavigationBindings);
}
