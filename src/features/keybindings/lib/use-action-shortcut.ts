import { useKeybindingsStore } from "../stores/keybindings-store";
import type { ActionId } from "./actions";
import { displayKeys, displayLabel } from "./combo";

export interface ActionShortcut {
  /** Keycaps for `<KbdKeys>`: ["⌘", "⇧", "B"]. */
  keys: string[];
  /** Compact form for `title=` strings: "⌘⇧B". */
  label: string;
}

/** The first live chord for an action in the active profile, or null when
 *  unbound. Re-renders when the profile changes. */
export function useActionShortcut(id: ActionId): ActionShortcut | null {
  const resolved = useKeybindingsStore.use.resolved();
  const first = resolved.byAction.get(id)?.[0];
  if (!first) return null;
  return { keys: displayKeys(first.combo), label: displayLabel(first.combo) };
}

/** Non-hook variant for labels built inside callbacks / memoised lists. */
export function shortcutLabel(id: ActionId): string | null {
  const first = useKeybindingsStore.getState().resolved.byAction.get(id)?.[0];
  return first ? displayLabel(first.combo) : null;
}
