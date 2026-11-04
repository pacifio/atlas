import { AlertTriangle } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Spinner,
} from "@tryatlas/design";
import { AtlasIcon } from "@/components/atlas-icon";

export type UpdateModalState = "ready" | "applying" | "error";

export interface UpdateAvailableModalViewProps {
  open: boolean;
  state: UpdateModalState;
  version: string | null;
  error: string | null;
  isWindows: boolean;
  onRestart: () => void;
  onLater: () => void;
  onOpenChange: (open: boolean) => void;
}

/**
 * "Restart to update" prompt — a macOS-updater-style centred card shown only
 * once an update has been **downloaded, verified, and staged** in the
 * background (never during the silent download; that's a titlebar arc).
 */
export function UpdateAvailableModalView({
  open,
  state,
  version,
  error,
  isWindows,
  onRestart,
  onLater,
  onOpenChange,
}: UpdateAvailableModalViewProps) {
  const isError = state === "error";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="w-[300px] items-center text-center">
        {isError ? (
          <div className="w-[52px] h-[52px] rounded-2xl bg-element-active border border-border grid place-items-center">
            <AlertTriangle size={24} className="text-error" />
          </div>
        ) : (
          <AtlasIcon size={52} className="rounded-2xl" />
        )}

        <DialogTitle>{isError ? "Update failed" : "Update Ready"}</DialogTitle>

        <DialogDescription>
          {isError
            ? (error ?? "Something went wrong while installing the update.")
            : `Atlas${version ? ` ${version}` : ""} has been downloaded. Restart to finish updating.`}
        </DialogDescription>

        {state === "applying" ? (
          <div className="w-full inline-flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
            <Spinner size="xs" label="" /> Restarting…
          </div>
        ) : isError ? (
          <Button variant="secondary" size="lg" className="w-full" onClick={onLater}>
            Close
          </Button>
        ) : (
          <div className="w-full flex flex-col gap-2">
            <Button variant="default" size="lg" autoFocus className="w-full" onClick={onRestart}>
              Restart now
            </Button>
            <Button variant="outline" size="lg" className="w-full" onClick={onLater}>
              Later
            </Button>
          </div>
        )}

        {state === "ready" && (
          <p className="text-2xs text-muted-foreground leading-relaxed px-1">
            "Later" installs the update automatically the next time you quit Atlas.
            {isWindows && " Windows will ask for permission to install it."}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
