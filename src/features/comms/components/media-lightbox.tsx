import * as Dialog from "@radix-ui/react-dialog";
import { Download, X } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ImageZoomView } from "@/features/media/components/image-zoom-view";

/**
 * Full-size view of a chat image.
 *
 * The zoom/pan behaviour is `ImageZoomView`, which the media tab already uses —
 * it fills its container rather than providing its own chrome, so this supplies
 * the modal shell and nothing else.
 */
export function MediaLightbox({
  open,
  onOpenChange,
  path,
  filename,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  path: string | null;
  filename: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[var(--z-modal)] bg-black/80 animate-fade-in" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-6 z-[var(--z-modal)] flex flex-col overflow-hidden rounded-xl border border-border-default bg-bg-base shadow-[var(--shadow-overlay)] animate-scale-in"
        >
          <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-border-default px-3">
            <Dialog.Title className="min-w-0 flex-1 truncate text-[11.5px] text-text-secondary">
              {filename}
            </Dialog.Title>
            {path && (
              <a
                href={convertFileSrc(path)}
                download={filename}
                title="Save a copy"
                className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary"
              >
                <Download size={13} />
              </a>
            )}
            <Dialog.Close
              title="Close"
              className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary cursor-pointer"
            >
              <X size={13} />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1">
            {path && <ImageZoomView src={convertFileSrc(path)} alt={filename} fill />}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
