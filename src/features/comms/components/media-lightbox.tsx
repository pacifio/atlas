import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { attachmentPath, cachedAttachmentPath } from "../lib/attachment-cache";
import { useLightboxStore, type LightboxItem } from "../stores/lightbox-store";
import { MediaLightboxView } from "./views/media-lightbox-view";

/**
 * Full-size view of chat media, as a gallery.
 *
 * One instance per comms panel (see `lightbox-store`). It walks the list it
 * was opened with — arrow keys, the edge chevrons, Home/End — and resolves
 * each item's local path lazily through the attachment cache, prefetching the
 * two neighbours so a keypress lands on a decoded file rather than a spinner.
 *
 * The zoom/pan behaviour is `ImageZoomView`, inside `MediaLightboxView`; this
 * container reads the store and resolves the files.
 */
export function MediaLightbox() {
  const open = useLightboxStore((s) => s.open);
  const items = useLightboxStore((s) => s.items);
  const index = useLightboxStore((s) => s.index);
  const { goTo, close } = useLightboxStore.getState().actions;
  const item = items[index] as LightboxItem | undefined;

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

  return (
    <MediaLightboxView
      open={open}
      items={items}
      index={index}
      src={path ? convertFileSrc(path) : null}
      failed={failed}
      onIndexChange={goTo}
      onClose={close}
    />
  );
}
