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

/** Image node. (Video was dropped — it made the canvas very slow.) Media lives
 *  under `.atlas/canvas-media/`, which the asset protocol 403s, so we fetch a
 *  base64 data URL via `canvas_media_data_url`. */
export const MediaNode = memo(function MediaNode({
  data,
  selected,
}: NodeProps) {
  const d = data as MediaNodeData;
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void invoke<string>("canvas_media_data_url", {
      projectPath: d.projectPath,
      src: d.src,
    })
      .then((u) => alive && setUrl(u))
      .catch(() => alive && setUrl(null));
    return () => {
      alive = false;
    };
  }, [d.projectPath, d.src]);

  return (
    // Root stays overflow-visible so the connection handles aren't clipped; the
    // image is clipped by an inner rounded wrapper instead.
    <div className="group relative" style={{ width: d.width ?? 320 }}>
      <NodeHandles selected={selected} />
      <div
        className={cn(
          "rounded-xl overflow-hidden border shadow-2xl bg-[var(--bg-secondary)]/40",
          selected
            ? "border-[var(--accent-primary)]/60"
            : "border-white/10 hover:border-white/20",
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
