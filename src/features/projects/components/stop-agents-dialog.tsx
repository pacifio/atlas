import { Dialog } from "@base-ui/react/dialog";
import { OctagonX } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStopAgentsConfirmStore } from "../lib/stop-agents-confirm";

/** The app's pill-button language (matches the create-org dialog footer). */
const pillButton =
  "inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] px-3 py-1.5 text-xs font-medium leading-none cursor-pointer transition-colors";

/**
 * Global "this will stop running agents" confirmation, driven by
 * `useStopAgentsConfirmStore.ask()` (org switch, project close). Mounted once
 * in App. Radix handles Esc/overlay-click as dismiss → treated as "Go back".
 */
export function StopAgentsDialog() {
  const pending = useStopAgentsConfirmStore.use.pending();
  const { settle } = useStopAgentsConfirmStore.use.actions();
  if (!pending) return null;

  const plural = pending.count === 1 ? "agent is" : "agents are";
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
              <OctagonX size={13} className="text-error" />
              {pending.count} running {pending.count === 1 ? "agent" : "agents"}
            </Dialog.Title>
            <p className="mt-2 text-sm leading-relaxed text-[var(--secondary-foreground)]">
              {pending.count} {plural} still working. {pending.actionLabel} will stop{" "}
              {pending.count === 1 ? "it" : "them"} — the conversation
              {pending.count === 1 ? " stays" : "s stay"} in history, but the in-flight work is
              canceled.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                autoFocus
                onClick={() => settle(false)}
                className={cn(
                  pillButton,
                  "bg-[var(--card)] text-[var(--secondary-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]",
                )}
              >
                Go back
              </button>
              <button
                onClick={() => settle(true)}
                className={cn(
                  pillButton,
                  "border-error/40 bg-[var(--card)] text-error hover:bg-error/10",
                )}
              >
                <OctagonX size={12} />
                {pending.confirmLabel}
              </button>
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
