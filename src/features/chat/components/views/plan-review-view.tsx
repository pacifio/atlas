// The plan review: the agent's proposed plan on the left, the options to
// approve or reject it on the right, in a modal.
//
// Props only. `plan` is a slot — the container renders the markdown into it,
// because the markdown renderer reaches the opener plugin. The container also
// owns the window keydown handler (digits, Enter, Esc) and the answer path;
// the handler stops Esc before it reaches the dialog's own `onOpenChange`,
// so one Esc sends one cancel.
//
// Composed from the package's dialog parts rather than `DialogContent`: the
// review is wider than any content size and anchored near the top, and it
// keeps the frosted scrim (`DialogOverlay blur`) the package reserves for
// blocking prompts, which `DialogContent`'s built-in overlay cannot carry.

import type { ReactNode } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { AlertTriangle, ClipboardList } from "lucide-react";
import {
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  Icon,
  Kbd,
} from "@tryatlas/design";
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
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogPortal>
        <DialogOverlay blur />
        <DialogPrimitive.Popup
          data-testid="plan-review"
          // Anchored near the top (not vertically centred) with a viewport
          // cap, so a long plan never pushes the dialog — and its Cancel
          // footer — below the window. The plan panel scrolls internally.
          // The surface is the package dialog's: `rounded-xl`, `shadow-lg`.
          className="fixed top-[5vh] left-1/2 z-modal flex max-h-[90vh] w-[880px] max-w-[94vw] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-card text-foreground shadow-lg outline-none data-open:animate-scale-in data-closed:animate-scale-out"
        >
          <div className="flex items-start gap-3 border-b border-border px-4 py-3">
            <Icon icon={ClipboardList} size="lg" className="mt-0.5 text-primary" />
            <DialogHeader className="min-w-0 flex-1">
              <DialogTitle>Review plan</DialogTitle>
              <DialogDescription>
                The agent proposed a plan before continuing. Review it, then approve or reject.
              </DialogDescription>
            </DialogHeader>
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
                  <div className="mt-2">
                    <Button
                      variant="outline"
                      size="lg"
                      onClick={() => onSelect(bypassOptionId, "bypassPermissions")}
                      className="h-auto min-h-9 w-full justify-start whitespace-normal text-left"
                    >
                      <Icon icon={AlertTriangle} size="md" className="text-error" />
                      <span className="min-w-0 flex-1 py-2">
                        Yes, and bypass permissions
                        <span className="block font-normal text-xs text-secondary-foreground">
                          Approve the plan and stop asking for the rest of this session.
                        </span>
                      </span>
                    </Button>
                  </div>
                )}
              </div>
              <div className="border-t border-border px-4 py-2.5">
                <DialogFooter>
                  <Button variant="ghost" size="sm" onClick={onCancel}>
                    Cancel <Kbd>esc</Kbd>
                  </Button>
                </DialogFooter>
              </div>
            </aside>
          </div>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
}
