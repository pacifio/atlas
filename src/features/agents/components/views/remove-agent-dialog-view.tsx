// "Remove this agent?" — the confirm Settings → Agents asks before removing
// one. Props only; `remove-agent-dialog.tsx` reads the ask/settle store.
//
// Keep holds focus when it opens, Esc is Keep, and so is a click on the
// backdrop. The package `AlertDialogContent` would ignore that click (an
// alert dialog must be answered), which is a proposed behaviour change not
// yet approved — so the popup is composed from the package's parts with the
// overlay's click answering Keep, as it always has.

import { useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  Icon,
  TrashGlyph,
} from "@tryatlas/design";

/**
 * The destructive button, split out so its hover state cannot outlive the
 * dialog.
 *
 * Hover, not the dialog's own open state: the lid lifting is the beat that says
 * "this one deletes", and it should land as the pointer arrives on Remove
 * rather than the moment the dialog appears.
 *
 * It has to be its own component: confirming (or pressing Esc) tears this
 * button out from under the pointer without ever firing `pointerleave`, so a
 * flag held anywhere that outlives the popup would still be set the next time
 * the dialog opened and the lid would render already tipped. Owning the state
 * here means it dies with the popup, no reset effect needed.
 */
function RemoveAction({ onRemove }: { onRemove: () => void }) {
  const [armed, setArmed] = useState(false);
  return (
    <AlertDialogAction
      onClick={onRemove}
      onPointerEnter={() => setArmed(true)}
      onPointerLeave={() => setArmed(false)}
      onFocus={() => setArmed(true)}
      onBlur={() => setArmed(false)}
    >
      <TrashGlyph armed={armed} size="xs" />
      Remove
    </AlertDialogAction>
  );
}

export function RemoveAgentDialogView({
  open,
  name,
  onKeep,
  onRemove,
}: {
  open: boolean;
  name: string;
  onKeep: () => void;
  onRemove: () => void;
}) {
  const keepRef = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onKeep()}>
      <AlertDialogPortal>
        <AlertDialogOverlay data-testid="remove-agent-backdrop" onClick={onKeep} />
        <AlertDialogPrimitive.Popup
          data-testid="remove-agent-dialog"
          initialFocus={keepRef}
          // `AlertDialogContent`'s surface, unchanged.
          className="fixed top-1/2 left-1/2 z-modal flex w-full max-w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-xl border border-border bg-card p-4 text-foreground shadow-lg outline-none data-open:animate-scale-in data-closed:animate-scale-out"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              <span className="flex items-center gap-2">
                <Icon icon={Trash2} size="sm" className="text-error" />
                Remove {name}?
              </span>
            </AlertDialogTitle>
            <AlertDialogDescription>
              Chats with this agent stay in history. Any chat currently using it will be asked to
              switch agents. You can install it again at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel ref={keepRef}>Keep</AlertDialogCancel>
            <RemoveAction onRemove={onRemove} />
          </AlertDialogFooter>
        </AlertDialogPrimitive.Popup>
      </AlertDialogPortal>
    </AlertDialog>
  );
}
