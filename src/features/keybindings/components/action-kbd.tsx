import { KbdKeys } from "@/ui/kbd";
import type { ActionId } from "../lib/actions";
import { useActionShortcut } from "../lib/use-action-shortcut";

/** The live keycaps for an action in the active profile; renders nothing
 *  when the action is unbound. */
export function ActionKbd({ id, className }: { id: ActionId; className?: string }) {
  const shortcut = useActionShortcut(id);
  if (!shortcut) return null;
  return <KbdKeys keys={shortcut.keys} className={className} />;
}
