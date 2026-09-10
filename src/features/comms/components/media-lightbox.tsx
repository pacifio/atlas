import { useCallback, useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, Download, Loader2, X } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { cn } from "@/lib/utils";
import { ImageZoomView } from "@/features/media/components/image-zoom-view";
import { attachmentPath, cachedAttachmentPath } from "../lib/attachment-cache";
import { useLightboxStore, type LightboxItem } from "../stores/lightbox-store";

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
        <Dialog.Overlay className="fixed inset-0 z-[var(--z-modal)] bg-black/80 animate-fade-in" />
        <Dialog.Content
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
            "fixed inset-0 z-[var(--z-modal)] m-auto h-[min(82vh,860px)] w-[min(88vw,1180px)]",
            "flex flex-col overflow-hidden rounded-xl border border-border-default bg-bg-base",
            "shadow-[var(--shadow-overlay)] animate-scale-in outline-none",
          )}
        >
          <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-border-default px-3">
            <Dialog.Title className="min-w-0 flex-1 truncate text-[11.5px] text-text-secondary">
              {item?.filename ?? ""}
            </Dialog.Title>
            {count > 1 && (
              <span className="shrink-0 text-[10.5px] tabular-nums text-text-ghost">
                {index + 1} / {count}
              </span>
            )}
            {path && item && (
              <a
                href={convertFileSrc(path)}
                download={item.filename}
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

          <div className="relative min-h-0 flex-1">
            {item && path && !failed ? (
              item.kind === "video" ? (
                <video
                  key={item.id}
                  src={convertFileSrc(path)}
                  controls
                  autoPlay
                  className="h-full w-full bg-black object-contain"
                />
              ) : (
                <ImageZoomView key={item.id} src={convertFileSrc(path)} alt={item.filename} fill />
              )
            ) : (
              <div className="flex h-full w-full items-center justify-center text-[11px] text-text-ghost">
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
        </Dialog.Content>
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
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={side === "left" ? "Previous  ←" : "Next  →"}
      className={cn(
        "absolute top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full",
        "border border-white/10 bg-[var(--bg-secondary)]/70 text-text-secondary backdrop-blur-xl",
        "transition-opacity hover:text-text-primary cursor-pointer",
        "disabled:cursor-default disabled:opacity-0",
        side === "left" ? "left-3" : "right-3",
      )}
    >
      <Icon size={16} />
    </button>
  );
}
