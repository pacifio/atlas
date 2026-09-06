import { useEffect, useRef } from "react";
import { type Combo, matchesCombo, parseCombo } from "@/features/keybindings/lib/combo";
import type { ActionId } from "@/features/keybindings/lib/actions";
import { useKeybindingsStore } from "@/features/keybindings/stores/keybindings-store";

/**
 * Global (window, bubble-phase) hotkey dispatcher. First match wins and the
 * event is consumed. Matching is exact on all four modifiers and keyed on the
 * physical key (`e.code`), so ⌥J never matches ⌘⌥J regardless of order and
 * macOS Option-diacritics are a non-issue — see `keybindings/lib/combo.ts`.
 *
 * Stays silent while the keybinding recorder owns the keyboard.
 */
export function useHotkeys(bindings: Array<{ combo: Combo | string; action: () => void }>) {
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (useKeybindingsStore.getState().recording) return;
      for (const { combo, action } of bindingsRef.current) {
        const parsed = typeof combo === "string" ? parseCombo(combo) : combo;
        if (!parsed) continue;
        if (matchesCombo(e, parsed)) {
          e.preventDefault();
          action();
          return;
        }
      }
    }

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}

/**
 * The app-level dispatcher: handlers keyed by action id; the chords come from
 * the active keybinding profile (registry defaults ⊕ user overrides) and
 * follow it live. Dispatch order is registry order.
 */
export function useActionHotkeys(handlers: Partial<Record<ActionId, () => void>>) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const state = useKeybindingsStore.getState();
      if (state.recording) return;
      for (const binding of state.resolved.list) {
        if (binding.when !== "global") continue;
        const action = handlersRef.current[binding.actionId];
        if (!action) continue;
        if (matchesCombo(e, binding.combo)) {
          e.preventDefault();
          action();
          return;
        }
      }
    }

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
