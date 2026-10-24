import { Dialog } from "@base-ui/react/dialog";
import { cn } from "@/lib/utils";
import { useConfirmStore } from "@/lib/confirm";

/** The app's pill-button language (matches `StopAgentsDialog`). */
const pillButton =
  "inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] px-3 py-1.5 text-xs font-medium leading-none cursor-pointer transition-colors";

/** The question `confirm()` asks. Mounted once in App, and inside any dialog
 *  that asks one (`ConfirmPrompt.scope`). Escape and a click outside answer
 *  Cancel; Cancel has the focus, so Enter never destroys. */
export function ConfirmDialog({ scope }: { scope?: string }) {
  const pending = useConfirmStore.use.pending();
  const { settle } = useConfirmStore.use.actions();
  if (!pending || pending.scope !== scope) return null;

  return (
    <Dialog.Root open onOpenChange={(open) => !open && settle("cancel")}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-overlay scrim backdrop-blur-xl" />
        <Dialog.Popup
          className={cn(
            "fixed left-1/2 top-1/2 z-modal -translate-x-1/2 -translate-y-1/2",
            "w-[380px] max-w-[92vw] overflow-hidden rounded-xl border border-[var(--border)]",
            "bg-[var(--card)]/60 backdrop-blur-2xl",
            "shadow-md animate-scale-in",
          )}
        >
          <div className="px-4 pt-3.5 pb-4">
            <Dialog.Title className="text-base font-semibold tracking-[-0.01em] text-[var(--foreground)]">
              {pending.title}
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-sm leading-relaxed text-[var(--secondary-foreground)]">
              {pending.body}
            </Dialog.Description>
            <div className="mt-4 flex justify-end gap-2">
              <button
                autoFocus
                onClick={() => settle("cancel")}
                className={cn(
                  pillButton,
                  "bg-[var(--card)] text-[var(--secondary-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]",
                )}
              >
                Cancel
              </button>
              {pending.alternateLabel && (
                <button
                  onClick={() => settle("alternate")}
                  className={cn(
                    pillButton,
                    pending.alternateDestructive
                      ? "border-error/40 bg-[var(--card)] text-error hover:bg-error/10"
                      : "bg-[var(--card)] text-[var(--foreground)] hover:bg-[var(--atlas-element-hover)]",
                  )}
                >
                  {pending.alternateLabel}
                </button>
              )}
              <button
                onClick={() => settle("confirm")}
                className={cn(
                  pillButton,
                  pending.destructive
                    ? "border-error/40 bg-[var(--card)] text-error hover:bg-error/10"
                    : "bg-[var(--card)] text-[var(--foreground)] hover:bg-[var(--atlas-element-hover)]",
                )}
              >
                {pending.confirmLabel}
              </button>
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
