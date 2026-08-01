import { useRef } from "react";
import { useViewport } from "@xyflow/react";
import { Sparkles, Loader2 } from "lucide-react";
import { useCanvasStore, groupBounds } from "../stores/canvas-store";
import { useCanvasAiStore } from "../stores/canvas-ai-store";

/**
 * Overlay layer of ✨ pins (ref `3.png`) — one per AI group, anchored at the
 * group's bounding-box corner. Click a pin → open its chat thread + select the
 * group; drag a pin → move the whole group. A dashed frame outlines each group.
 * Positioned in pane/wrapper space via the live React Flow viewport transform.
 */
export function AiGroupMarkers({
  onOpenThread,
}: {
  onOpenThread: (groupId: string, screen: { x: number; y: number }) => void;
}) {
  const nodes = useCanvasStore.use.nodes();
  const aiGroups = useCanvasStore.use.aiGroups();
  const { moveGroup, selectGroup, beginInteraction } =
    useCanvasStore.use.actions();
  const streamingGroupId = useCanvasAiStore.use.streamingGroupId();
  const vp = useViewport(); // { x, y, zoom } — re-renders on pan/zoom

  // Per-drag bookkeeping (module-free; one active pin at a time).
  const drag = useRef<{
    id: string;
    lastX: number;
    lastY: number;
    moved: boolean;
  } | null>(null);

  const groupIds = Object.keys(aiGroups);
  if (groupIds.length === 0) return null;

  const toScreen = (fx: number, fy: number) => ({
    x: fx * vp.zoom + vp.x,
    y: fy * vp.zoom + vp.y,
  });

  return (
    <>
      {groupIds.map((gid) => {
        const b = groupBounds(nodes, gid);
        const anchor = aiGroups[gid].anchor;
        // Fall back to the seed anchor (with a nominal box) while the group has no
        // members yet (e.g. still generating).
        const flow = b ?? { x: anchor.x, y: anchor.y, width: 40, height: 40 };
        const tl = toScreen(flow.x, flow.y);
        const generating = streamingGroupId === gid;

        return (
          <div key={gid}>
            {/* Dashed frame is now a background React Flow node (see GroupFrameNode)
                so real nodes paint above it — here we only render the ✨ pin. */}
            {/* ✨ pin (interactive) */}
            <div
              className="absolute z-20 flex h-6 w-6 cursor-pointer items-center justify-center rounded-full rounded-bl-none bg-[var(--accent-primary)] text-[var(--bg-base)] shadow-lg"
              style={{ left: tl.x - 10, top: tl.y - 22 }}
              title="AI diagram — click to chat, drag to move"
              onPointerDown={(e) => {
                e.stopPropagation();
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                drag.current = {
                  id: gid,
                  lastX: e.clientX,
                  lastY: e.clientY,
                  moved: false,
                };
              }}
              onPointerMove={(e) => {
                const d = drag.current;
                if (!d || d.id !== gid) return;
                const dx = e.clientX - d.lastX;
                const dy = e.clientY - d.lastY;
                if (!d.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
                if (!d.moved) beginInteraction(); // one undo step for the whole move
                d.moved = true;
                d.lastX = e.clientX;
                d.lastY = e.clientY;
                moveGroup(gid, dx / vp.zoom, dy / vp.zoom);
              }}
              onPointerUp={(e) => {
                const d = drag.current;
                drag.current = null;
                if (d && !d.moved) {
                  selectGroup(gid);
                  onOpenThread(gid, { x: e.clientX, y: e.clientY });
                }
              }}
            >
              {generating ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Sparkles size={12} />
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}
