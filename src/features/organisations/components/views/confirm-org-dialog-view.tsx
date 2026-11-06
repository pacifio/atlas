import type { ReactNode } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Spinner,
} from "@tryatlas/design";

/**
 * A destructive confirmation for an organisation: delete it, or leave it.
 *
 * `Dialog`, not the package `AlertDialog`: a click on the backdrop has always
 * dismissed these, and `AlertDialog` refuses outside presses by design. While
 * `busy` nothing closes it — the action is mid-flight and cancelling the
 * dialog would not cancel that.
 */
export function ConfirmOrgDialogView({
  open,
  title,
  description,
  confirmLabel,
  busyLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  busyLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onCancel()}>
      <DialogContent showCloseButton={false} className="max-w-[min(25rem,92vw)]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="md" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" size="md" onClick={onConfirm} disabled={busy}>
            {busy && <Spinner size="sm" label="" />}
            {busy ? busyLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
