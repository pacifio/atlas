import { KbdCombo } from "@/ui/kbd";
import type { ActionId } from "../lib/actions";
import { formatCombo, type Combo } from "../lib/combo";
import { primaryCombo } from "../lib/resolve";
import { useKeybindingsStore } from "../stores/keybindings-store";

/**
 * A command's current chord, wherever the UI wants to advertise one — the
 * command palette, a menu, a tooltip.
 *
 * Reading it from the store rather than a literal is the point: these used to
 * be hardcoded strings that quietly disagreed with what the keys actually did,
 * and a user who rebinds a command should see their own chord here.
 */
export function useActionCombo(actionId: ActionId): Combo | null {
  return useKeybindingsStore((s) =>
    primaryCombo(s.keymap.bindings.find((b) => b.action.id === actionId)),
  );
}

/** Renders nothing when the command is unbound — an empty slot says "no
 *  shortcut" more clearly than a placeholder does. */
export function ActionShortcut({
  actionId,
  className,
}: {
  actionId: ActionId;
  className?: string;
}) {
  const combo = useActionCombo(actionId);
  if (!combo) return null;
  return <KbdCombo combo={formatCombo(combo)} className={className} />;
}
