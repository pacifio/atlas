import { useEffect, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Check, Copy, Loader2, MonitorSmartphone } from "lucide-react";

import { cn } from "@/lib/utils";
import { useAuthStore } from "../stores/auth-store";

/**
 * The connecting dialog.
 *
 * **The device code is the content.** It used to sit behind a "Trouble?"
 * disclosure, on the reasoning that the URL Atlas opened already carried the
 * code so nobody needed to read it. That reasoning was sound and the conclusion
 * was wrong: a link that carries the code is exactly what lets someone else's
 * grant be approved by a signed-in user who clicked a link. Atlas now opens the
 * *plain* approval page, so this code is the only way the browser can learn
 * which grant to approve — and the user reading it across is what guarantees
 * the approved grant is this one.
 *
 * So: the code up front, one button that copies it and says so, and the waiting
 * state underneath.
 */
export function ConnectDialog() {
  const open = useAuthStore.use.dialogOpen();
  const snapshot = useAuthStore.use.snapshot();
  const error = useAuthStore.use.error();
  const starting = useAuthStore.use.starting();
  const { cancelSignIn, closeDialog, beginSignIn } = useAuthStore.use.actions();

  const [copied, setCopied] = useState(false);

  const connecting = snapshot.status === "connecting" ? snapshot : null;
  const done = snapshot.status === "signed-in";

  // Revert the button to "Copy" a moment after a copy, so a user who returns to
  // this dialog to copy again is not looking at a tick that says it is done.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  const copyCode = async () => {
    if (!connecting) return;
    try {
      await navigator.clipboard.writeText(connecting.userCode);
      setCopied(true);
    } catch {
      // Clipboard access can be refused. The code is on screen and selectable,
      // so the fallback is the user reading it — no error worth raising.
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        // Closing the dialog abandons the attempt. Leaving a poll loop running
        // against a request the user visibly cancelled would be dishonest.
        if (!next) void cancelSignIn();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-overlay scrim backdrop-blur-sm" />
        <Dialog.Popup
          className={cn(
            "fixed left-1/2 top-[24%] z-modal -translate-x-1/2",
            "w-[440px] max-w-[92vw] rounded-lg border border-border bg-card",
            "shadow-md text-foreground",
          )}
        >
          <div className="flex items-start gap-2.5 border-b border-border px-4 py-3">
            <MonitorSmartphone className="mt-0.5 size-4 text-muted-foreground" />
            <div>
              <Dialog.Title className="text-sm font-medium">
                Connect your Atlas account
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-secondary-foreground">
                Approve this device in your browser to finish.
              </Dialog.Description>
            </div>
          </div>

          <div className="p-4">
            {done ? (
              <div className="flex items-center gap-2 px-1 py-5 text-xs text-secondary-foreground">
                <Check size={14} className="text-success" />
                Connected.
              </div>
            ) : error ? (
              <div className="px-1 py-4">
                <p className="text-xs text-error">{error}</p>
                <button
                  onClick={() => void beginSignIn()}
                  className="mt-3 rounded border border-border px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-element-hover"
                >
                  Try again
                </button>
              </div>
            ) : (
              <>
                {connecting ? (
                  <>
                    {/* `select-all` so a click-drag grabs the whole code and
                        nothing else — the clipboard button is the fast path,
                        not the only one, and it can be refused by the OS. */}
                    <div className="rounded border border-border bg-[var(--background)] px-3 py-4">
                      <p className="select-all text-center font-mono text-2xl tracking-[0.3em] text-foreground">
                        {connecting.userCode}
                      </p>
                      <button
                        onClick={() => void copyCode()}
                        className={cn(
                          "mx-auto mt-3 flex items-center gap-1.5 rounded border border-border",
                          "cursor-pointer px-2.5 py-1 text-xs transition-colors",
                          "text-secondary-foreground hover:bg-element-hover hover:text-foreground",
                        )}
                      >
                        {copied ? (
                          <>
                            <Check size={12} className="text-success" />
                            Copied
                          </>
                        ) : (
                          <>
                            <Copy size={12} />
                            Copy code
                          </>
                        )}
                      </button>
                    </div>

                    {/* "Approve" is the literal button label on the web page.
                        Naming it means the instruction ends at something the
                        user can point at rather than at a step they have to
                        recognise — and it has to be changed here whenever it
                        changes there. */}
                    <p className="mt-3 px-1 text-xs leading-relaxed text-muted-foreground">
                      Paste this at{" "}
                      <span className="font-mono text-secondary-foreground">
                        {connecting.verificationUri}
                      </span>
                      , which just opened in your browser, then press Approve.
                    </p>
                  </>
                ) : null}

                <div className="flex items-center gap-2 px-1 pt-4 text-xs text-secondary-foreground">
                  <Loader2 size={14} className="animate-spin" />
                  {starting ? "Starting…" : "Waiting for you to approve in the browser…"}
                </div>
              </>
            )}
          </div>

          <div className="flex justify-end gap-2 border-t border-border px-4 py-2.5">
            <button
              onClick={() => (done ? closeDialog() : void cancelSignIn())}
              className="rounded px-2.5 py-1 text-xs text-secondary-foreground transition-colors hover:bg-element-hover hover:text-foreground"
            >
              {done ? "Close" : "Cancel"}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
