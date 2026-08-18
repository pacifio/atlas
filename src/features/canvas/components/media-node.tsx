import { memo, useEffect, useState } from "react";
import { type NodeProps } from "@xyflow/react";
import { invoke } from "@tauri-apps/api/core";
import { cn } from "@/lib/utils";
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

  useEffect(() => {
    const cached = mediaUrlCache.get(cacheKey);
    if (cached) {
      setUrl(cached);
      return;
    }
    let alive = true;
    void invoke<string>("canvas_media_data_url", {
      projectPath: d.projectPath,
      src: d.src,
    })
      .then((u) => {
        mediaUrlCache.delete(cacheKey);
        mediaUrlCache.set(cacheKey, u);
        if (mediaUrlCache.size > MEDIA_CACHE_CAP) {
          const oldest = mediaUrlCache.keys().next().value;
          if (oldest !== undefined) mediaUrlCache.delete(oldest);
        }
        if (alive) setUrl(u);
      })
      .catch(() => alive && setUrl(null));
    return () => {
      alive = false;
    };
  }, [cacheKey, d.projectPath, d.src]);

  return (
    // Root stays overflow-visible so the connection handles aren't clipped; the
    // image is clipped by an inner rounded wrapper instead.
    <div className="group relative" style={{ width: d.width ?? 320 }}>
      <NodeHandles selected={selected} />
      <div
        className={cn(
          "rounded-xl overflow-hidden border shadow-2xl bg-[var(--bg-secondary)]/40",
          selected ? "border-[var(--accent-primary)]/60" : "border-white/10 hover:border-white/20",
        )}
      >
        {url ? (
          <img
            src={url}
            alt=""
            draggable={false}
            // WebKit initiates a native image drag that steals the pointer from
            // React Flow, so the node won't move — kill it with -webkit-user-drag.
            className="block w-full h-auto select-none [-webkit-user-drag:none]"
          />
        ) : (
          <div className="flex items-center justify-center h-[160px] text-[11px] text-text-tertiary">
            Loading image…
          </div>
        )}
      </div>
    </div>
  );
});
