import { memo, useEffect, useState } from "react";
import { type NodeProps } from "@xyflow/react";
import { CanvasMedia, CanvasNodeFrame } from "@tryatlas/design";
import { canvasMediaDataUrl } from "../lib/canvas-api";
import { NodeHandles } from "./node-handles";

export interface MediaNodeData extends Record<string, unknown> {
  src: string;
  projectPath: string;
  width?: number;
}

/** Media files are immutable once placed (a replace mints a new `src`), so the
 *  base64 payload only ever needs to cross IPC once per app session — without
 *  this, every canvas (re)mount re-transferred megabytes of JSON-serialized
 *  base64 per image node. Bounded FIFO so a media-heavy org can't grow the
 *  cache without limit (deleting a node keeps its file on disk, so there is
 *  no eviction event to hook). */
const mediaUrlCache = new Map<string, string>();
const MEDIA_CACHE_CAP = 64;

/** Image node. (Video was dropped — it made the canvas very slow.) Media lives
 *  under `.atlas/canvas-media/`, which the asset protocol 403s, so we fetch a
 *  base64 data URL via `canvas_media_data_url`. */
export const MediaNode = memo(function MediaNode({ data, selected }: NodeProps) {
  const d = data as MediaNodeData;
  const cacheKey = `${d.projectPath}|${d.src}`;
  const [url, setUrl] = useState<string | null>(() => mediaUrlCache.get(cacheKey) ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    const cached = mediaUrlCache.get(cacheKey);
    if (cached) {
      setUrl(cached);
      return;
    }
    let alive = true;
    void canvasMediaDataUrl(d.projectPath, d.src)
      .then((u) => {
        mediaUrlCache.delete(cacheKey);
        mediaUrlCache.set(cacheKey, u);
        if (mediaUrlCache.size > MEDIA_CACHE_CAP) {
          const oldest = mediaUrlCache.keys().next().value;
          if (oldest !== undefined) mediaUrlCache.delete(oldest);
        }
        if (alive) setUrl(u);
      })
      .catch(() => {
        if (!alive) return;
        setUrl(null);
        setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [cacheKey, d.projectPath, d.src]);

  return (
    // Root stays overflow-visible so the connection handles aren't clipped;
    // the media clips itself. The width is the node's and the image's own
    // aspect sets the height, so only the placeholder needs one.
    <div className="group relative" style={{ width: d.width ?? 320 }}>
      <NodeHandles selected={selected} />
      <CanvasNodeFrame kind="media" selected={selected}>
        <CanvasMedia
          state={failed ? "error" : url === null ? "loading" : "ready"}
          src={url ?? undefined}
          kind="image"
          alt=""
          loadingLabel="Loading image…"
          // At its own height the image must be a block, or the line box
          // leaves a descender gap under it.
          className={url ? "h-auto [&>img]:block" : "h-[160px]"}
        />
      </CanvasNodeFrame>
    </div>
  );
});
