// The plan review: the agent's proposed plan on the left, the options to
// approve or reject it on the right, in a modal.
//
// Props only. `plan` is a slot — the container renders the markdown into it,
// because the markdown renderer reaches the opener plugin. The container also
// owns the window keydown handler (digits, Enter, Esc) and the answer path.

import type { ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { AlertTriangle, ClipboardList } from "lucide-react";
import { DialogOverlay, Kbd } from "@tryatlas/design";
import { cn } from "@/lib/utils";
import { PermissionOptionList, type PermissionOptionItem } from "./permission-card-view";

export function PlanReviewView({
  plan,
  options,
  bypassOptionId,
  queueNote,
  onSelect,
  onCancel,
}: {
  plan: ReactNode;
  options: PermissionOptionItem[];
  /** When set, Atlas's own "Yes, and bypass permissions" action: approve with
   *  this option, then apply `bypassPermissions`. */
  bypassOptionId: string | null;
  queueNote: string | null;
  onSelect: (optionId: string, override?: "bypassPermissions") => void;
  onCancel: () => void;
}) {
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onCancel()}>
      <Dialog.Portal>
        <DialogOverlay blur />
        <Dialog.Popup
          className={cn(
            // Anchor near the top (not vertically centered) with a viewport
            // cap, so a long plan never pushes the modal — and its Cancel
            // footer — below the window. The plan panel scrolls internally.
            "fixed left-1/2 top-[5vh] z-modal -translate-x-1/2",
            "flex max-h-[90vh] w-[880px] max-w-[94vw] flex-col overflow-hidden",
            "rounded-md border border-border bg-card",
            "shadow-md animate-scale-in text-foreground",
          )}
        >
          <div className="flex items-start gap-3 border-b border-border px-4 py-3">
            <ClipboardList className="mt-0.5 size-4 text-primary" />
            <div className="flex-1">
              <Dialog.Title className="text-sm font-medium">Review plan</Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-secondary-foreground">
                The agent proposed a plan before continuing. Review it, then approve or reject.
              </Dialog.Description>
            </div>
            {queueNote && (
              <span className="shrink-0 rounded-sm bg-background px-2 py-0.5 text-xs text-secondary-foreground">
                {queueNote}
              </span>
            )}
          </div>
          <div className="flex min-h-0 flex-1">
            <section className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div className="min-h-0 min-w-0 flex-1 overflow-auto px-5 py-4">{plan}</div>
            </section>
            <aside className="flex w-[320px] shrink-0 flex-col border-l border-border">
              <div className="min-h-0 min-w-0 flex-1 overflow-auto px-4 py-3">
                <PermissionOptionList options={options} onSelect={(id) => onSelect(id)} />
                {bypassOptionId && (
                  <button
                    type="button"
                    onClick={() => onSelect(bypassOptionId, "bypassPermissions")}
                    className={cn(
                      "mt-2 flex w-full items-center gap-2 rounded-md border border-border px-2.5 py-2 text-left",
                      "text-sm text-foreground transition-colors hover:bg-background",
                    )}
                  >
                    <AlertTriangle className="size-3.5 shrink-0 text-error" />
                    <span className="flex-1">
                      Yes, and bypass permissions
                      <span className="block text-xs text-secondary-foreground">
                        Approve the plan and stop asking for the rest of this session.
                      </span>
                    </span>
                  </button>
                )}
              </div>
              <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">
                <button
                  type="button"
                  onClick={onCancel}
                  className="inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs text-secondary-foreground hover:bg-background hover:text-foreground transition-colors"
                >
                  Cancel <Kbd>esc</Kbd>
                </button>
              </div>
            </aside>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
