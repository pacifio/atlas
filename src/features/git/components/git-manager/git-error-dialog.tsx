import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, Copy } from "lucide-react";
import { useGitStore } from "../../stores/git-store";
import { gitErrorTitle } from "../../lib/git-errors";
import { copyText } from "@/lib/clipboard";

/**
 * Friendly dialog for actionable git failures (auth, rejected pushes, hook
 * rejections, lock files…). Leads with the typed error's human message; the
 * raw git output sits below in monospace — GitHub Desktop's split between
 * "what happened" and "what git actually said".
 */
export function GitErrorDialog() {
  const payload = useGitStore.use.errorDialog();
  const actions = useGitStore.use.actions();

  return (
    <Dialog.Root open={payload !== null} onOpenChange={(o) => !o && actions.dismissErrorDialog()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 z-[var(--z-overlay)]" />
        <Dialog.Content className="fixed left-1/2 top-[24%] -translate-x-1/2 z-[var(--z-modal)] w-[440px] rounded-xl overflow-hidden bg-[var(--bg-elevated)] border border-border-default shadow-[var(--shadow-overlay)] flex flex-col">
          {payload && (
            <>
              <div className="px-4 pt-3.5 pb-3 border-b border-border-default">
                <Dialog.Title className="text-[13px] font-semibold text-text-primary flex items-center gap-1.5">
                  <AlertTriangle size={13} className="text-[var(--status-error)] shrink-0" />
                  {gitErrorTitle(payload)}
                </Dialog.Title>
                <Dialog.Description className="text-[11px] text-text-secondary mt-1.5">
                  {payload.message}
                </Dialog.Description>
                {payload.files && payload.files.length > 0 && (
                  <div className="mt-2 max-h-[96px] overflow-y-auto hide-scrollbar">
                    {payload.files.map((f) => (
                      <div key={f} className="font-mono text-[10px] text-text-tertiary truncate">
                        {f}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {payload.rawStderr && (
                <div className="max-h-[180px] overflow-y-auto hide-scrollbar bg-[var(--bg-base)] px-3 py-2">
                  <pre className="font-mono text-[10px] leading-[15px] text-text-secondary whitespace-pre-wrap break-all">
                    {payload.rawStderr}
                  </pre>
                </div>
              )}

              <div className="border-t border-border-default px-3 py-2.5 flex items-center justify-between gap-2">
                <div className="min-w-0 flex items-center gap-2">
                  {payload.command && (
                    <span className="truncate font-mono text-[10px] text-text-tertiary">
                      {payload.command}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {payload.rawStderr && (
                    <button
                      onClick={() => copyText(payload.rawStderr)}
                      className="flex items-center gap-1 px-2 h-7 rounded text-[11px] text-text-secondary hover:bg-bg-hover transition-colors"
                      title="Copy git output"
                    >
                      <Copy size={11} />
                      Copy output
                    </button>
                  )}
                  <button
                    onClick={() => actions.dismissErrorDialog()}
                    // `text-text-inverse`, never `text-white`: `--accent-primary`
                    // IS white in this theme, so a white label on it renders an
                    // empty button. Every other filled accent button in the app
                    // pairs the fill with the inverse token for this reason.
                    className="px-3 h-7 rounded text-[11px] font-medium text-text-inverse bg-accent hover:opacity-90 transition-colors"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
