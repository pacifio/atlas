import { useEffect, useState } from "react";
import { Check, Copy, MonitorSmartphone } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Icon,
  Spinner,
} from "@tryatlas/design";

export interface DeviceCode {
  userCode: string;
  verificationUri: string;
}

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
 * state underneath. No corner close: Escape, a click outside and the footer
 * button are the ways out, and all of them abandon the grant.
 */
export function ConnectDialogView({
  open,
  onOpenChange,
  done,
  error,
  code,
  starting,
  onCopy,
  onRetry,
  onCancel,
  onClose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Signed in: the grant was approved. */
  done: boolean;
  error: string | null;
  /** The grant's code, once one is running. */
  code: DeviceCode | null;
  starting: boolean;
  /** Copies the code; resolves whether it landed. */
  onCopy: () => Promise<boolean>;
  onRetry: () => void;
  onCancel: () => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  // Revert the button to "Copy" a moment after a copy, so a user who returns to
  // this dialog to copy again is not looking at a tick that says it is done.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} data-connect-dialog="" className="gap-0 p-0">
        <div className="flex items-start gap-2.5 border-b border-border px-4 py-3">
          <Icon icon={MonitorSmartphone} size="lg" className="mt-0.5 text-muted-foreground" />
          <div>
            <DialogTitle>Connect your Atlas account</DialogTitle>
            <DialogDescription className="mt-0.5">
              Approve this device in your browser to finish.
            </DialogDescription>
          </div>
        </div>

        <div className="p-4">
          {done ? (
            <div className="flex items-center gap-2 px-1 py-5 text-xs text-secondary-foreground">
              <Icon icon={Check} size="md" className="text-success" />
              Connected.
            </div>
          ) : error ? (
            <div className="flex flex-col items-start gap-3 px-1 py-4">
              <p className="text-xs text-error">{error}</p>
              <Button variant="outline" size="sm" onClick={onRetry}>
                Try again
              </Button>
            </div>
          ) : (
            <>
              {code ? (
                <>
                  {/* `select-all` so a click-drag grabs the whole code and
                      nothing else — the clipboard button is the fast path,
                      not the only one, and it can be refused by the OS. */}
                  <div className="flex flex-col items-center gap-3 rounded-md border border-border bg-background px-3 py-4">
                    <p className="select-all text-center font-mono text-2xl tracking-widest text-foreground">
                      {code.userCode}
                    </p>
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => {
                        void onCopy().then((ok) => ok && setCopied(true));
                      }}
                    >
                      {copied ? (
                        <>
                          <Icon icon={Check} size="sm" className="text-success" />
                          Copied
                        </>
                      ) : (
                        <>
                          <Icon icon={Copy} size="sm" />
                          Copy code
                        </>
                      )}
                    </Button>
                  </div>

                  {/* "Approve" is the literal button label on the web page.
                      Naming it means the instruction ends at something the
                      user can point at rather than at a step they have to
                      recognise — and it has to be changed here whenever it
                      changes there. */}
                  <p className="mt-3 px-1 text-xs leading-relaxed text-muted-foreground">
                    Paste this at{" "}
                    <span className="font-mono text-secondary-foreground">
                      {code.verificationUri}
                    </span>
                    , which just opened in your browser, then press Approve.
                  </p>
                </>
              ) : null}

              <div className="flex items-center gap-2 px-1 pt-4 text-xs text-secondary-foreground">
                <Spinner size="md" label="" />
                {starting ? "Starting…" : "Waiting for you to approve in the browser…"}
              </div>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-4 py-2.5">
          <Button variant="ghost" size="sm" onClick={done ? onClose : onCancel}>
            {done ? "Close" : "Cancel"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
