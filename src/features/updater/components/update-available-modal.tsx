import * as Dialog from "@radix-ui/react-dialog";
import { Loader2, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { AtlasIcon } from "@/components/atlas-icon";
import { useUpdaterStore } from "../stores/updater-store";
import { updater } from "../lib/updater-api";

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
  const { beginApply, dismissModal, setError } = useUpdaterStore.use.actions();

  const applying = phase === "applying";
  const isError = phase === "error";
  // Only the staged-ready, applying, and error phases have a modal.
  const open = modalOpen && (phase === "ready" || applying || isError);

  const restartNow = () => {
    beginApply();
    // On success the app restarts; failures arrive via the error listener.
    void updater.apply().catch((e) => setError(String(e)));
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o && !applying) dismissModal();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[var(--z-overlay)]" />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[var(--z-modal)]",
            "w-[300px] rounded-2xl overflow-hidden",
            // macOS-style vibrancy: translucent panel over a blurred backdrop.
            "bg-[var(--bg-elevated)]/70 backdrop-blur-2xl border border-white/10",
            "shadow-[var(--shadow-overlay)]",
            "px-5 pt-6 pb-5 flex flex-col items-center text-center",
          )}
        >
          {isError ? (
            <div className="w-[52px] h-[52px] rounded-2xl bg-white/10 border border-white/10 grid place-items-center">
              <AlertTriangle size={24} className="text-[var(--status-error)]" />
            </div>
          ) : (
            <AtlasIcon size={52} className="rounded-2xl" />
          )}

          <Dialog.Title className="mt-3 text-[15px] font-semibold text-text-primary">
            {isError ? "Update failed" : "Update Ready"}
          </Dialog.Title>

          <p className="mt-1 text-[12px] text-text-secondary leading-relaxed px-1">
            {isError ? (
              (error ?? "Something went wrong while installing the update.")
            ) : (
              <>
                Atlas{version ? ` ${version}` : ""} has been downloaded. Restart to finish updating.
              </>
            )}
          </p>

          {applying ? (
            <div className="mt-4 w-full inline-flex items-center justify-center gap-1.5 text-[11px] text-text-tertiary">
              <Loader2 size={12} className="animate-spin" /> Restarting…
            </div>
          ) : isError ? (
            <button
              type="button"
              onClick={dismissModal}
              className="mt-4 w-full h-9 rounded-lg text-[12px] font-medium bg-[var(--text-primary)] text-[var(--bg-base)] hover:opacity-90 transition-opacity"
            >
              Close
            </button>
          ) : (
            <div className="mt-4 w-full flex flex-col gap-2">
              <button
                type="button"
                autoFocus
                onClick={restartNow}
                className="w-full h-9 rounded-lg text-[12px] font-medium bg-[var(--text-primary)] text-[var(--bg-base)] hover:opacity-90 transition-opacity"
              >
                Restart now
              </button>
              <button
                type="button"
                onClick={dismissModal}
                className="w-full h-9 rounded-lg text-[12px] font-medium bg-white/10 text-text-primary border border-white/10 hover:bg-white/[0.15] transition-colors"
              >
                Later
              </button>
            </div>
          )}

          {!applying && !isError && (
            <p className="mt-3 text-[10px] text-text-tertiary leading-relaxed px-1">
              "Later" installs the update automatically the next time you quit Atlas.
            </p>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
