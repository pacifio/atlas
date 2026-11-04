// "Remove this agent?" — the confirm Settings → Agents asks before removing
// one. Props only; `remove-agent-dialog.tsx` reads the ask/settle store.
//
// Keep holds focus when it opens and Esc is Keep. A click on the backdrop does
// nothing: an alert dialog must be answered.

import { useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
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
      // Outlined, as today: the filled red is louder than this confirm has
      // ever been, and Keep — not Remove — is the default answer.
      variant="destructive-outline"
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
      <AlertDialogContent data-testid="remove-agent-dialog" initialFocus={keepRef} blur>
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
      </AlertDialogContent>
    </AlertDialog>
  );
}
