import { useEffect } from "react";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { ACTION_BY_ID, scopeForTabType } from "../lib/actions";
import { comboFromEvent } from "../lib/combo";
import { isEditableTarget, isTypingRatherThanChord } from "../lib/dispatch";
import { runAction } from "../lib/handler-registry";
import { isChordRecording } from "../lib/recording";
import { lookupAction } from "../lib/resolve";
import { useKeybindingsStore } from "../stores/keybindings-store";

/**
 * The app's single keydown listener. Mounted once, at the root.
 *
 * Capture phase, because a bound chord has to reach its command before
 * CodeMirror, xterm or the webview's own defaults consume it — the reason the
 * handlers this replaces had each reached for capture on their own. The
 * keystroke is only swallowed once a command has actually run: an unbound
 * chord, or one whose command isn't mounted, passes through untouched to
 * whatever else wants it.
 *
 * Reads both stores through `getState()` rather than subscribing: this runs on
 * every keystroke, and a component that re-renders the whole app on each one
 * would cost far more than the lookup does.
 */
export function useKeybindingDispatcher(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isChordRecording()) return;
      const combo = comboFromEvent(e);
      if (!combo) return;

      const { activeTabId, tabs } = useLayoutStore.getState();
      const scope = scopeForTabType(tabs.find((t) => t.id === activeTabId)?.type);
      const actionId = lookupAction(useKeybindingsStore.getState().lookup, combo, scope);
      if (!actionId) return;

      const action = ACTION_BY_ID.get(actionId);
      if (!action) return;
      if (isTypingRatherThanChord(combo, action.scope, isEditableTarget(e.target))) return;
      if (!runAction(actionId, activeTabId)) return;

      e.preventDefault();
      e.stopPropagation();
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
