import { useEffect, useRef } from "react";
import { type Combo, matchesCombo, parseCombo } from "@/features/keybindings/lib/combo";
import type { ActionId } from "@/features/keybindings/lib/actions";
import { useKeybindingsStore } from "@/features/keybindings/stores/keybindings-store";
import {
  hasActionHandler,
  registerActionHandlers,
  runAction,
} from "@/features/keybindings/lib/action-registry";
import { evaluateWhen } from "@/features/keybindings/lib/when";
import { liveWhenContext } from "@/features/keybindings/lib/when-context";

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
 * follow it live. Dispatch order is registry order, and a binding whose
 * `when` is false right now is skipped, so the next match gets the key.
 *
 * The handlers are also registered with the action registry, so anything
 * else can run a global command by id through the very same closure.
 */
export function useActionHotkeys(handlers: Partial<Record<ActionId, () => void>>) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => registerActionHandlers(() => handlersRef.current), []);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const state = useKeybindingsStore.getState();
      if (state.recording) return;
      let context: ReturnType<typeof liveWhenContext> | null = null;
      for (const binding of state.resolved.list) {
        if (binding.when !== "global") continue;
        if (!hasActionHandler(binding.actionId)) continue;
        if (matchesCombo(e, binding.combo)) {
          if (binding.whenAst && !evaluateWhen(binding.whenAst, (context ??= liveWhenContext())))
            continue;
          e.preventDefault();
          runAction(binding.actionId);
          return;
        }
      }
    }

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
