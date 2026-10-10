import { useRef, useState } from "react";
import { CopyGlyph } from "@/ui/animated-icon";
import { Dialog } from "@base-ui/react/dialog";
import { AlertTriangle } from "lucide-react";
import { useGitStore } from "../../stores/git-store";
import { gitErrorTitle } from "../../lib/git-errors";
import { copyText } from "@/lib/clipboard";

/**
 * Friendly dialog for actionable git failures (auth, rejected pushes, hook
 * rejections, lock files…). Leads with the typed error's human message; the
 * raw git output sits below in monospace — GitHub Desktop's split between
 * "what happened" and "what git actually said".
 *
 * A push rejected because the user rewrote commits they had pushed
 * (`history-rewritten`) offers the fix in place: a force push, which the
 * backend runs with `--force-with-lease --force-if-includes`.
 */
export function GitErrorDialog({ onForcePush }: { onForcePush?: () => void }) {
  const payload = useGitStore.use.errorDialog();
  const actions = useGitStore.use.actions();
  // Feedback for the copy button — without it a clipboard failure and a
  // success were indistinguishable (both looked like "nothing happened").
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canForcePush = payload?.code === "history-rewritten" && !!onForcePush;
  const onCopy = (text: string) => {
    void copyText(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <Dialog.Root open={payload !== null} onOpenChange={(o) => !o && actions.dismissErrorDialog()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 scrim z-overlay" />
        <Dialog.Popup className="fixed left-1/2 top-[24%] -translate-x-1/2 z-modal w-[440px] rounded-xl overflow-hidden bg-[var(--card)] border border-border shadow-md flex flex-col">
          {payload && (
            <>
              <div className="px-4 pt-3.5 pb-3 border-b border-border">
                <Dialog.Title className="text-base font-semibold text-foreground flex items-center gap-1.5">
                  <AlertTriangle
                    size={13}
                    className="text-[var(--atlas-status-error-foreground)] shrink-0"
                  />
                  {gitErrorTitle(payload)}
                </Dialog.Title>
                <Dialog.Description className="text-xs text-secondary-foreground mt-1.5">
                  {payload.message}
                </Dialog.Description>
                {payload.files && payload.files.length > 0 && (
                  <div className="mt-2 max-h-[96px] overflow-y-auto hide-scrollbar">
                    {payload.files.map((f) => (
                      <div key={f} className="font-mono text-2xs text-muted-foreground truncate">
                        {f}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {payload.rawStderr && (
                <div className="max-h-[180px] overflow-y-auto hide-scrollbar bg-[var(--background)] px-3 py-2">
                  <pre className="font-mono text-2xs leading-[15px] text-secondary-foreground whitespace-pre-wrap break-all">
                    {payload.rawStderr}
                  </pre>
                </div>
              )}

              <div className="border-t border-border px-3 py-2.5 flex items-center justify-between gap-2">
                <div className="min-w-0 flex items-center gap-2">
                  {payload.command && (
                    <span className="truncate font-mono text-2xs text-muted-foreground">
                      {payload.command}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {payload.rawStderr && (
                    <button
                      onClick={() => onCopy(payload.rawStderr)}
                      className="flex items-center gap-1 px-2 h-7 rounded text-xs text-secondary-foreground hover:bg-element-hover transition-colors"
                      title="Copy git output"
                    >
                      <CopyGlyph copied={copied} size="sm" />
                      {copied ? "Copied" : "Copy output"}
                    </button>
                  )}
                  {canForcePush && (
                    <button
                      onClick={() => actions.dismissErrorDialog()}
                      className="px-3 h-7 rounded text-xs text-secondary-foreground hover:bg-element-hover transition-colors"
                    >
                      Cancel
                    </button>
                  )}
                  <button
                    onClick={() => {
                      actions.dismissErrorDialog();
                      if (canForcePush) onForcePush();
                    }}
                    // `text-primary-foreground`, never the literal white utility: `--primary`
                    // IS white in this theme, so a white label on it renders an
                    // empty button. Every other filled accent button in the app
                    // pairs the fill with the inverse token for this reason.
                    className="px-3 h-7 rounded text-xs font-medium text-primary-foreground bg-primary hover:opacity-90 transition-colors"
                  >
                    {canForcePush ? "Force push" : "Dismiss"}
                  </button>
                </div>
              </div>
            </>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
