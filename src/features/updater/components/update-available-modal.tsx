import { Dialog } from "@base-ui/react/dialog";
import { Loader2, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { isWindows } from "@/lib/platform";
import { AtlasIcon } from "@/components/atlas-icon";
import { useUpdaterStore } from "../stores/updater-store";
import { restartToUpdate } from "../lib/restart-to-update";

/**
 * "Restart to update" prompt — a macOS-updater-style centered card shown only
 * once an update has been **downloaded, verified, and staged** in the
 * background (never during the silent download; that's a titlebar arc). Mounted
 * once at the app root.
 */
export function UpdateAvailableModal() {
  const phase = useUpdaterStore.use.phase();
  const version = useUpdaterStore.use.version();
  const error = useUpdaterStore.use.error();
  const modalOpen = useUpdaterStore.use.modalOpen();
  const { dismissModal } = useUpdaterStore.use.actions();

  const applying = phase === "applying";
  const isError = phase === "error";
  // Only the staged-ready, applying, and error phases have a modal.
  const open = modalOpen && (phase === "ready" || applying || isError);

  const restartNow = restartToUpdate;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o && !applying) dismissModal();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 scrim backdrop-blur-sm z-overlay" />
        <Dialog.Popup
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-modal",
            "w-[300px] rounded-2xl overflow-hidden",
            // macOS-style vibrancy: translucent panel over a blurred backdrop.
            "bg-[var(--card)]/70 backdrop-blur-2xl border border-border",
            "shadow-md",
            "px-5 pt-6 pb-5 flex flex-col items-center text-center",
          )}
        >
          {isError ? (
            <div className="w-[52px] h-[52px] rounded-2xl bg-element-active border border-border grid place-items-center">
              <AlertTriangle size={24} className="text-error" />
            </div>
          ) : (
            <AtlasIcon size={52} className="rounded-2xl" />
          )}

          <Dialog.Title className="mt-3 text-lg font-semibold text-foreground">
            {isError ? "Update failed" : "Update Ready"}
          </Dialog.Title>

          <p className="mt-1 text-sm text-secondary-foreground leading-relaxed px-1">
            {isError ? (
              (error ?? "Something went wrong while installing the update.")
            ) : (
              <>
                Atlas{version ? ` ${version}` : ""} has been downloaded. Restart to finish updating.
              </>
            )}
          </p>

          {applying ? (
            <div className="mt-4 w-full inline-flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 size={12} className="animate-spin" /> Restarting…
            </div>
          ) : isError ? (
            <button
              type="button"
              onClick={dismissModal}
              className="mt-4 w-full h-9 rounded-lg text-sm font-medium bg-[var(--foreground)] text-[var(--background)] hover:opacity-90 transition-opacity"
            >
              Close
            </button>
          ) : (
            <div className="mt-4 w-full flex flex-col gap-2">
              <button
                type="button"
                autoFocus
                onClick={restartNow}
                className="w-full h-9 rounded-lg text-sm font-medium bg-[var(--foreground)] text-[var(--background)] hover:opacity-90 transition-opacity"
              >
                Restart now
              </button>
              <button
                type="button"
                onClick={dismissModal}
                className="w-full h-9 rounded-lg text-sm font-medium bg-element-active text-foreground border border-border hover:bg-[var(--element-emphasis)] transition-colors"
              >
                Later
              </button>
            </div>
          )}

          {!applying && !isError && (
            <p className="mt-3 text-2xs text-muted-foreground leading-relaxed px-1">
              "Later" installs the update automatically the next time you quit Atlas.
              {isWindows && " Windows will ask for permission to install it."}
            </p>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
