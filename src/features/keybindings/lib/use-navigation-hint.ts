import { isMac } from "@/lib/platform";
import type { ActionId } from "./actions";
import { ariaShortcut, NAVIGATION_TARGET_ATTR } from "./navigation-hints";
import { useNavigationBindings } from "./use-navigation-bindings";

/** Metadata on the real control; its accessible name and event handlers stay intact. */
export function useNavigationHint() {
  const bindings = useNavigationBindings();
  return (actions: readonly ActionId[]) => {
    const shortcuts = bindings
      .filter((b) => actions.includes(b.actionId))
      .map((b) => ariaShortcut(b.combo, isMac));
    return {
      [NAVIGATION_TARGET_ATTR]: actions.length ? actions.join(" ") : undefined,
      "aria-keyshortcuts": [...new Set(shortcuts)].join(" ") || undefined,
    };
  };
}
