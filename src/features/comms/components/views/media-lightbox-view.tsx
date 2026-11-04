import { ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  Hint,
  HintGroup,
  HintItem,
  Icon,
  IconButton,
  Spinner,
} from "@tryatlas/design";
import { cn } from "@/lib/utils";
import { ImageZoomView } from "@/features/media/components/image-zoom-view";

/** One file in the gallery (mirrors the lightbox store's item). */
export interface LightboxViewItem {
  id: string;
  filename: string;
  kind: "image" | "video";
}

export interface MediaLightboxViewProps {
  open: boolean;
  items: LightboxViewItem[];
  index: number;
  /** The current file's URL, or `null` while it resolves. */
  src: string | null;
  failed: boolean;
  /** Ask for another index; the store clamps it. */
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

/**
 * Full-size view of chat media, as a gallery: the modal shell, the navigation
 * and nothing else. The zoom/pan behaviour is `ImageZoomView`, which the media
 * tab already uses; it fills its container rather than providing its own
 * chrome.
 *
 * The package dialog's `media` variant is the capped box this used to draw by
 * hand — centred with `inset-0 m-auto` rather than a translate, so the scale-in
 * never fights the centring.
 */
export function MediaLightboxView({
  open,
  items,
  index,
  src,
  failed,
  onIndexChange,
  onClose,
}: MediaLightboxViewProps) {
  const item = items[index] as LightboxViewItem | undefined;
  const count = items.length;
  const hasPrev = index > 0;
  const hasNext = index < count - 1;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      onIndexChange(index - 1);
    } else if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === " ") {
      e.preventDefault();
      onIndexChange(index + 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      onIndexChange(0);
    } else if (e.key === "End") {
      e.preventDefault();
      onIndexChange(count - 1);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        variant="media"
        showCloseButton={false}
        aria-describedby={undefined}
        onKeyDown={onKeyDown}
        data-media-lightbox=""
      >
        <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-border px-3">
          {/* A filename names the image rather than heading a task: one
              truncated line that fills the row beside its controls. */}
          <DialogTitle variant="quiet">{item?.filename ?? ""}</DialogTitle>
          {count > 1 && (
            <span className="shrink-0 text-xs tabular-nums text-disabled">
              {index + 1} / {count}
            </span>
          )}
          <HintGroup>
            {src && item && (
              <HintItem label="Save a copy">
                <IconButton
                  icon={Download}
                  label="Save a copy"
                  size="sm"
                  nativeButton={false}
                  render={<a href={src} download={item.filename} />}
                />
              </HintItem>
            )}
            <HintItem label="Close">
              <DialogClose render={<IconButton icon={X} label="Close" size="sm" />} />
            </HintItem>
          </HintGroup>
        </div>

        <div className="relative min-h-0 flex-1">
          {item && src && !failed ? (
            item.kind === "video" ? (
              <video
                key={item.id}
                src={src}
                controls
                autoPlay
                // The letterbox behind someone else's photo or video. Deliberately
                // theme-invariant (decision 3): a tinted matte would misreport the
                // image's own edges.
                // ratchet-allow: decision 3 — a matte behind someone else's video.
                className="h-full w-full bg-black object-contain"
              />
            ) : (
              <ImageZoomView key={item.id} src={src} alt={item.filename} fill />
            )
          ) : (
            <div className="flex h-full w-full items-center justify-center text-xs text-disabled">
              {failed ? "Could not load this file." : <Spinner size="lg" label="" />}
            </div>
          )}

          {count > 1 && (
            <>
              <NavButton side="left" disabled={!hasPrev} onClick={() => onIndexChange(index - 1)} />
              <NavButton
                side="right"
                disabled={!hasNext}
                onClick={() => onIndexChange(index + 1)}
              />
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
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
  return (
    // Unwrapped: the button is absolutely placed, and when disabled it is
    // invisible anyway, so there is no tooltip to keep. Translate centring is
    // safe here: Tailwind 4 compiles `-translate-y-1/2` to the `translate`
    // property, which nothing animates.
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
          "absolute top-1/2 z-10 flex size-9 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full",
          "border border-border bg-card/70 text-secondary-foreground backdrop-blur-xl",
          "transition-opacity duration-fast hover:text-foreground",
          "disabled:cursor-default disabled:opacity-0",
          side === "left" ? "left-3" : "right-3",
        )}
      >
        <Icon icon={side === "left" ? ChevronLeft : ChevronRight} size="lg" />
      </button>
    </Hint>
  );
}
