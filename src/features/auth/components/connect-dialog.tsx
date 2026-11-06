import { useAuthStore } from "../stores/auth-store";
import { ConnectDialogView } from "./views/connect-dialog-view";

/** The connecting dialog's container (see `ConnectDialogView` for why the
 *  device code is the content). Mounted once, in `App.tsx`. */
export function ConnectDialog() {
  const open = useAuthStore.use.dialogOpen();
  const snapshot = useAuthStore.use.snapshot();
  const error = useAuthStore.use.error();
  const starting = useAuthStore.use.starting();
  const { cancelSignIn, closeDialog, beginSignIn } = useAuthStore.use.actions();

  const connecting = snapshot.status === "connecting" ? snapshot : null;

  return (
    <ConnectDialogView
      open={open}
      onOpenChange={(next) => {
        // Closing the dialog abandons the attempt. Leaving a poll loop running
        // against a request the user visibly cancelled would be dishonest.
        if (!next) void cancelSignIn();
      }}
      done={snapshot.status === "signed-in"}
      error={error}
      code={connecting}
      starting={starting}
      onCopy={async () => {
        if (!connecting) return false;
        try {
          await navigator.clipboard.writeText(connecting.userCode);
          return true;
        } catch {
          // Clipboard access can be refused. The code is on screen and
          // selectable, so the fallback is the user reading it — no error
          // worth raising.
          return false;
        }
      }}
      onRetry={() => void beginSignIn()}
      onCancel={() => void cancelSignIn()}
      onClose={closeDialog}
    />
  );
}
