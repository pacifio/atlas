import { Dialog } from "@base-ui/react/dialog";
import { useState } from "react";
import { Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useRemoveAgentConfirmStore } from "../lib/remove-agent-confirm";
import { TrashGlyph } from "@tryatlas/design";

/** The app's pill-button language (matches the stop-agents dialog). */
const pillButton =
  "inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] px-3 py-1.5 text-xs font-medium leading-none cursor-pointer transition-colors";

/**
 * The destructive button, split out so its hover state cannot outlive the
 * dialog.
 *
 * Hover, not the dialog's own open state: the lid lifting is the beat that says
 * "this one deletes", and it should land as the pointer arrives on Remove
 * rather than the moment the dialog appears.
 *
 * It has to be its own component because `RemoveAgentDialog` is mounted once in
 * App and only its *body* unmounts — a `useState` up there survives every open.
 * Confirming (or pressing Esc) tears this button out from under the pointer
 * without ever firing `pointerleave`, so the flag would still be set the next
 * time the dialog opened and the lid would render already tipped. Owning the
 * state here means it dies with the dialog, no reset effect needed.
 */
function RemoveButton({ onConfirm }: { onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      onClick={onConfirm}
      onPointerEnter={() => setArmed(true)}
      onPointerLeave={() => setArmed(false)}
      onFocus={() => setArmed(true)}
      onBlur={() => setArmed(false)}
      className={cn(pillButton, "border-error/40 bg-[var(--card)] text-error hover:bg-error/10")}
    >
      <TrashGlyph armed={armed} size="sm" />
      Remove
    </button>
  );
}

/**
 * "Remove this agent?" confirmation for Settings → Agents, driven by
 * `useRemoveAgentConfirmStore.ask()`. Mounted once in App. Radix handles
 * Esc/overlay-click as dismiss → treated as "Keep".
 */
export function RemoveAgentDialog() {
  const pending = useRemoveAgentConfirmStore.use.pending();
  const { settle } = useRemoveAgentConfirmStore.use.actions();
  if (!pending) return null;

  return (
    <Dialog.Root open onOpenChange={(open) => !open && settle(false)}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-overlay scrim backdrop-blur-xl" />
        <Dialog.Popup
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-1/2 z-modal -translate-x-1/2 -translate-y-1/2",
            "w-[380px] max-w-[92vw] overflow-hidden rounded-xl border border-[var(--border)]",
            "bg-[var(--card)]/60 backdrop-blur-2xl",
            "shadow-md animate-scale-in",
          )}
        >
          <div className="px-4 pt-3.5 pb-4">
            <Dialog.Title className="flex items-center gap-2 text-base font-semibold tracking-[-0.01em] text-[var(--foreground)]">
              <Trash2 size={13} className="text-error" />
              Remove {pending.name}?
            </Dialog.Title>
            <p className="mt-2 text-sm leading-relaxed text-[var(--secondary-foreground)]">
              Chats with this agent stay in history. Any chat currently using it will be asked to
              switch agents. You can install it again at any time.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                autoFocus
                onClick={() => settle(false)}
                className={cn(
                  pillButton,
                  "bg-[var(--card)] text-[var(--secondary-foreground)] hover:bg-element-hover hover:text-[var(--foreground)]",
                )}
              >
                Keep
              </button>
              <RemoveButton onConfirm={() => settle(true)} />
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
