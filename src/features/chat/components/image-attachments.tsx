import { memo, useMemo, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ImageZoomView } from "@/features/media/components/image-zoom-view";
import type { ImageAttachment } from "@/types/agents";
import { Hint, HintGroup, HintItem, Icon } from "@tryatlas/design";

/*
 * The one way an agent-chat image looks: a square tile, the same in the
 * composer (staged, removable) and in the sent message. Clicking a tile opens
 * the full image in a viewer that walks the whole strip.
 *
 * This replaces a thumbnail-plus-hover-preview pair in the composer, and
 * nothing at all in the transcript: a sent message kept only a COUNT of its
 * images, so what the agent received could not be looked at again.
 */

const dataUrl = (img: ImageAttachment) => `data:${img.mimeType};base64,${img.dataBase64}`;

export const ImageAttachmentStrip = memo(function ImageAttachmentStrip({
  images,
  onRemove,
  className,
}: {
  images: readonly ImageAttachment[];
  /** Staged images only: shows a remove button on each tile. */
  onRemove?: (index: number) => void;
  className?: string;
}) {
  const srcs = useMemo(() => images.map(dataUrl), [images]);
  // `open` apart from `index`: closing keeps the index, so the dialog doesn't
  // swap to the first image during the frames it takes to unmount.
  const [viewer, setViewer] = useState({ open: false, index: 0 });
  if (images.length === 0) return null;
  return (
    <>
      <div className={cn("flex flex-wrap gap-2", className)}>
        {srcs.map((src, i) => (
          <div key={i} className="group relative">
            <button
              type="button"
              onClick={() => setViewer({ open: true, index: i })}
              aria-label={`View image ${i + 1}`}
              className={cn(
                "block size-16 overflow-hidden rounded-lg border border-border cursor-zoom-in",
                "transition-[border-color,transform] duration-fast ease-out-strong",
                "hover:border-border-strong active:scale-[0.97]",
              )}
            >
              <img src={src} alt="" className="h-full w-full object-cover" draggable={false} />
            </button>
            {onRemove && (
              // Right, not top: a tooltip above would sit over the tile's row.
              <Hint label="Remove image" side="right">
                <button
                  type="button"
                  onClick={() => onRemove(i)}
                  aria-label="Remove image"
                  className={cn(
                    "absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full cursor-pointer",
                    "border border-border bg-card text-secondary-foreground hover:text-foreground",
                    // Hidden until the tile is hovered or keyboard-focused.
                    "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
                  )}
                >
                  <Icon icon={X} size="xs" />
                </button>
              </Hint>
            )}
          </div>
        ))}
      </div>
      <ImageViewer
        srcs={srcs}
        open={viewer.open}
        index={viewer.index}
        onIndexChange={(index) => setViewer({ open: true, index })}
        onClose={() => setViewer((v) => ({ ...v, open: false }))}
      />
    </>
  );
});

/** Full-size, zoomable view of one strip, arrow keys to walk it. The shell
 *  matches the comms `MediaLightbox`; the source is in memory, not on disk. */
function ImageViewer({
  srcs,
  open: openProp,
  index,
  onIndexChange,
  onClose,
}: {
  srcs: string[];
  open: boolean;
  index: number;
  onIndexChange: (i: number) => void;
  onClose: () => void;
}) {
  // A strip that shrank under an open viewer (a staged image removed) clamps.
  const i = Math.min(index, Math.max(srcs.length - 1, 0));
  const open = openProp && srcs.length > 0;
  const count = srcs.length;
  const go = (n: number) => onIndexChange(Math.min(Math.max(n, 0), count - 1));

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(i - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      go(i + 1);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-modal scrim animate-fade-in" />
        <Dialog.Popup
          aria-describedby={undefined}
          onKeyDown={onKeyDown}
          className={cn(
            // Centred without a transform (`inset-0 m-auto`): `animate-scale-in`
            // animates `transform`, which would fight translate-based centring.
            "fixed inset-0 z-modal m-auto h-[min(82vh,860px)] w-[min(88vw,1180px)]",
            "flex flex-col overflow-hidden rounded-xl border border-border bg-background",
            "shadow-lg animate-scale-in outline-none",
          )}
        >
          <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-border px-3">
            <Dialog.Title className="min-w-0 flex-1 truncate text-sm text-secondary-foreground">
              {count > 1 ? `Image ${i + 1} of ${count}` : "Image"}
            </Dialog.Title>
            <HintGroup>
              <HintItem label="Close">
                <Dialog.Close className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-element-hover hover:text-foreground cursor-pointer">
                  <Icon icon={X} size="md" />
                </Dialog.Close>
              </HintItem>
            </HintGroup>
          </div>
          <div className="relative min-h-0 flex-1">
            {open && <ImageZoomView key={i} src={srcs[i]} alt={`Image ${i + 1}`} checkerboard />}
            {count > 1 && (
              <>
                <NavButton side="left" disabled={i === 0} onClick={() => go(i - 1)} />
                <NavButton side="right" disabled={i === count - 1} onClick={() => go(i + 1)} />
              </>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function NavButton({
  side,
  disabled,
  onClick,
}: {
  side: "left" | "right";
  disabled: boolean;
  onClick: () => void;
}) {
  const glyph = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <Hint
      label={side === "left" ? "Previous" : "Next"}
      shortcut={side === "left" ? "←" : "→"}
      side={side === "left" ? "right" : "left"}
      wrap={false}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        className={cn(
          "absolute top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full",
          "border border-border bg-card/70 text-secondary-foreground backdrop-blur-xl",
          "transition-opacity hover:text-foreground cursor-pointer",
          "disabled:cursor-default disabled:opacity-0",
          side === "left" ? "left-3" : "right-3",
        )}
      >
        <Icon icon={glyph} size="lg" />
      </button>
    </Hint>
  );
}
