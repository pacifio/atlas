import { useCallback, useEffect, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { ChevronLeft, ChevronRight, Download, Loader2, X } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { cn } from "@/lib/utils";
import { ImageZoomView } from "@/features/media/components/image-zoom-view";
import { attachmentPath, cachedAttachmentPath } from "../lib/attachment-cache";
import { useLightboxStore, type LightboxItem } from "../stores/lightbox-store";
import { HintGroup, HintItem, Hint } from "@tryatlas/design";

/**
 * Full-size view of chat media, as a gallery.
 *
 * One instance per comms panel (see `lightbox-store`). It walks the list it
 * was opened with — arrow keys, the edge chevrons, Home/End — and resolves
 * each item's local path lazily through the attachment cache, prefetching the
 * two neighbours so a keypress lands on a decoded file rather than a spinner.
 *
 * The zoom/pan behaviour is `ImageZoomView`, which the media tab already uses;
 * it fills its container rather than providing its own chrome, so this
 * supplies the modal shell, the navigation and nothing else.
 */
export function MediaLightbox() {
  const open = useLightboxStore((s) => s.open);
  const items = useLightboxStore((s) => s.items);
  const index = useLightboxStore((s) => s.index);
  const { goTo, close } = useLightboxStore.getState().actions;
  const item = items[index] as LightboxItem | undefined;
  const count = items.length;

  const [path, setPath] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // The current file, then its neighbours. Neighbour fetches are fire-and-
  // forget: the cache dedupes in-flight requests, so an arrow press that
  // arrives mid-download simply joins it.
  useEffect(() => {
    if (!open || !item) return;
    let alive = true;
    setFailed(false);
    const cached = cachedAttachmentPath(item.id);
    setPath(cached ?? null);
    if (!cached) {
      attachmentPath(item.id, item.filename)
        .then((p) => alive && setPath(p))
        .catch(() => alive && setFailed(true));
    }
    for (const n of [items[index - 1], items[index + 1]]) {
      if (n && !cachedAttachmentPath(n.id)) void attachmentPath(n.id, n.filename).catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [open, item, items, index]);

  const prev = useCallback(() => goTo(index - 1), [goTo, index]);
  const next = useCallback(() => goTo(index + 1), [goTo, index]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      prev();
    } else if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === " ") {
      e.preventDefault();
      next();
    } else if (e.key === "Home") {
      e.preventDefault();
      goTo(0);
    } else if (e.key === "End") {
      e.preventDefault();
      goTo(count - 1);
    }
  };

  const hasPrev = index > 0;
  const hasNext = index < count - 1;

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-modal scrim animate-fade-in" />
        <Dialog.Popup
          aria-describedby={undefined}
          onKeyDown={onKeyDown}
          className={cn(
            // A capped box, not a near-fullscreen sheet: at `inset-6` this ran
            // to 24px of every window edge and its title bar sat on top of the
            // app's own chrome and the traffic lights.
            //
            // `inset-0 m-auto` + a definite width/height centres it WITHOUT a
            // transform. That is load-bearing: `animate-scale-in` animates
            // `transform`, so translate-based centring (the other modals')
            // would be overwritten for the length of the animation and the
            // panel would fly in from the viewport's centre-bottom-right.
            "fixed inset-0 z-modal m-auto h-[min(82vh,860px)] w-[min(88vw,1180px)]",
            "flex flex-col overflow-hidden rounded-xl border border-border bg-background",
            "shadow-lg animate-scale-in outline-none",
          )}
        >
          <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-border px-3">
            <Dialog.Title className="min-w-0 flex-1 truncate text-sm text-secondary-foreground">
              {item?.filename ?? ""}
            </Dialog.Title>
            {count > 1 && (
              <span className="shrink-0 text-xs tabular-nums text-disabled">
                {index + 1} / {count}
              </span>
            )}
            <HintGroup>
              {path && item && (
                <HintItem label="Save a copy">
                  <a
                    href={convertFileSrc(path)}
                    download={item.filename}
                    className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-element-hover hover:text-foreground"
                  >
                    <Download size={13} />
                  </a>
                </HintItem>
              )}
              <HintItem label="Close">
                <Dialog.Close className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-element-hover hover:text-foreground cursor-pointer">
                  <X size={13} />
                </Dialog.Close>
              </HintItem>
            </HintGroup>
          </div>

          <div className="relative min-h-0 flex-1">
            {item && path && !failed ? (
              item.kind === "video" ? (
                <video
                  key={item.id}
                  src={convertFileSrc(path)}
                  controls
                  autoPlay
                  // The letterbox behind someone else's photo or video. Deliberately
                  // theme-invariant (decision 3): a tinted matte would misreport the
                  // image's own edges.
                  // ratchet-allow: decision 3 — a matte behind someone else's video.
                  className="h-full w-full bg-black object-contain"
                />
              ) : (
                <ImageZoomView key={item.id} src={convertFileSrc(path)} alt={item.filename} fill />
              )
            ) : (
              <div className="flex h-full w-full items-center justify-center text-xs text-disabled">
                {failed ? (
                  "Could not load this file."
                ) : (
                  <Loader2 size={16} className="animate-spin" />
                )}
              </div>
            )}

            {count > 1 && (
              <>
                <NavButton side="left" disabled={!hasPrev} onClick={prev} />
                <NavButton side="right" disabled={!hasNext} onClick={next} />
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
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    // Unwrapped: the button is absolutely placed, and when disabled it is
    // invisible anyway, so there is no tooltip to keep.
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
          "border border-border bg-[var(--card)]/70 text-secondary-foreground backdrop-blur-xl",
          "transition-opacity hover:text-foreground cursor-pointer",
          "disabled:cursor-default disabled:opacity-0",
          side === "left" ? "left-3" : "right-3",
        )}
      >
        <Icon size={16} />
      </button>
    </Hint>
  );
}
