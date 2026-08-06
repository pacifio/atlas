import * as Dialog from "@radix-ui/react-dialog";
import { OctagonX } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStopAgentsConfirmStore } from "../lib/stop-agents-confirm";

/** The app's pill-button language (matches the create-org dialog footer). */
const pillButton =
  "inline-flex items-center gap-1.5 rounded-full border border-[var(--border-default)] px-3 py-1.5 text-[11px] font-medium leading-none cursor-pointer transition-colors";

/**
 * Global "this will stop running agents" confirmation, driven by
 * `useStopAgentsConfirmStore.ask()` (org switch, workspace close). Mounted once
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
        <Dialog.Overlay className="fixed inset-0 z-[var(--z-max)] bg-black/45 backdrop-blur-xl" />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-1/2 z-[var(--z-max)] -translate-x-1/2 -translate-y-1/2",
            "w-[380px] max-w-[92vw] overflow-hidden rounded-xl border border-[var(--border-default)]",
            "bg-[var(--bg-elevated)]/60 backdrop-blur-2xl",
            "shadow-[var(--shadow-overlay)] animate-scale-in",
          )}
        >
          <div className="px-4 pt-3.5 pb-4">
            <Dialog.Title className="flex items-center gap-2 text-[13px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
              <OctagonX size={13} className="text-error" />
              {pending.count} running {pending.count === 1 ? "agent" : "agents"}
            </Dialog.Title>
            <p className="mt-2 text-[12px] leading-relaxed text-[var(--text-secondary)]">
              {pending.count} {plural} still working. {pending.actionLabel} will
              stop {pending.count === 1 ? "it" : "them"} — the conversation
              {pending.count === 1 ? " stays" : "s stay"} in history, but the
              in-flight work is cancelled.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                autoFocus
                onClick={() => settle(false)}
                className={cn(
                  pillButton,
                  "bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]",
                )}
              >
                Go back
              </button>
              <button
                onClick={() => settle(true)}
                className={cn(
                  pillButton,
                  "border-error/40 bg-[var(--bg-elevated)] text-error hover:bg-error/10",
                )}
              >
                <OctagonX size={12} />
                {pending.confirmLabel}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
