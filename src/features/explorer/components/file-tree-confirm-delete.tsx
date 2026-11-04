import { Dialog } from "@base-ui/react/dialog";
import { cn } from "@/lib/utils";
import { DialogOverlay } from "@/ui/dialog";

interface ConfirmDeleteProps {
  open: boolean;
  /** Display name in the prompt — file/folder basename (first item when
   *  deleting several). */
  name: string;
  /** Whether the target is a directory (changes the warning copy). */
  isDir: boolean;
  /** Number of items being deleted. >1 switches to the batch wording. */
  count?: number;
  /** Override the default "Delete …?" title (e.g. "Revert all changes?"). */
  title?: string;
  /** Override the default body copy. */
  body?: React.ReactNode;
  /** Override the confirm button label (default "Delete"). */
  confirmLabel?: string;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}

/**
 * Custom Radix dialog for delete confirmation. `window.confirm` would
 * steal focus and look like a default browser modal — not acceptable
 * for a destructive action on a polished surface like the file tree.
 */
export function FileTreeConfirmDelete({
  open,
  name,
  isDir,
  count = 1,
  title,
  body,
  confirmLabel = "Delete",
  onConfirm,
  onOpenChange,
}: ConfirmDeleteProps) {
  const multi = count > 1;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <DialogOverlay />
        <Dialog.Popup
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-[30%] -translate-x-1/2 z-modal",
            "w-[380px] rounded-xl overflow-hidden",
            "bg-[var(--card)] border border-[var(--border)]",
            "shadow-md",
            "p-4 flex flex-col gap-3",
          )}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onConfirm();
            }
          }}
        >
          <Dialog.Title className="text-base font-semibold text-foreground">
            {title ?? (multi ? `Delete ${count} items?` : `Delete ${isDir ? "folder" : "file"}?`)}
          </Dialog.Title>
          <p className="text-sm text-secondary-foreground leading-relaxed">
            {body ??
              (multi ? (
                <>
                  <span className="font-mono text-foreground">{name}</span> and {count - 1} other{" "}
                  {count - 1 === 1 ? "item" : "items"} will be permanently deleted. This can't be
                  undone.
                </>
              ) : (
                <>
                  <span className="font-mono text-foreground">{name}</span> will be permanently{" "}
                  {isDir ? "removed along with everything inside it" : "deleted"}. This can't be
                  undone.
                </>
              ))}
          </p>
          <div className="flex items-center justify-end gap-2 mt-1">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className={cn(
                "px-3 h-7 rounded text-xs",
                "text-secondary-foreground hover:bg-element-hover hover:text-foreground",
              )}
            >
              Cancel
            </button>
            {/* Red on a red wash, not black on solid red.

                The two destructive tokens are a pair and this button was
                wearing half of each: a fill of `--status-error-foreground`
                (the saturated status red) lettered in `--destructive-foreground`,
                which every dark theme defines as a near-black because it belongs
                on *that theme's* lighter `--destructive` chip. The result was a
                heavy black label on a bright red slab.

                The error background/foreground pair is the app's existing idiom
                for this — the same one the error banners use — so the label
                stays the red that means danger and every theme, light or dark,
                supplies both halves itself. */}
            <button
              type="button"
              autoFocus
              onClick={onConfirm}
              className={cn(
                "px-3 h-7 rounded text-xs font-medium",
                "border border-error/40 bg-error-muted text-error transition-colors hover:bg-error/20",
              )}
            >
              {confirmLabel}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
