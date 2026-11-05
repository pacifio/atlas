import { memo, useCallback, useEffect, useRef, useState } from "react";
import { NodeResizer, type NodeProps } from "@xyflow/react";
import { CANVAS_FIELD_CLASS, CanvasNodeFrame, CanvasShape } from "@tryatlas/design";
import { cn } from "@/lib/utils";
import { useCanvasStore, type ShapeType } from "../stores/canvas-store";
import { NodeHandles } from "./node-handles";

export interface ShapeNodeData extends Record<string, unknown> {
  shapeType: ShapeType;
  text: string;
}

/** Geometric flowchart shape. Connectable from any side (shared handles); the
 *  only editable content is a centered text label (double-click to edit). */
export const ShapeNode = memo(function ShapeNode({ id, data, selected }: NodeProps) {
  const d = data as ShapeNodeData;
  const { updateNote, moveNote, beginInteraction } = useCanvasStore.use.actions();
  const ref = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) return;
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Programmatic focus() alone doesn't place a caret in a contentEditable —
    // set a collapsed range at the end so the blinking cursor is visible.
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, [editing]);

  const commit = useCallback(() => {
    setEditing(false);
    updateNote(id, { text: ref.current?.innerText ?? "" });
  }, [id, updateNote]);

  return (
    // React Flow owns the box size (so NodeResizer can drive it); the shape fills
    // it. Size is persisted to the store via onResize.
    <div className="group relative h-full w-full" onDoubleClick={() => setEditing(true)}>
      <NodeResizer
        isVisible={selected}
        minWidth={40}
        minHeight={40}
        onResizeStart={() => beginInteraction()}
        onResize={(_, p) => {
          moveNote(id, p.x, p.y);
          updateNote(id, { width: p.width, height: p.height });
        }}
      />
      <NodeHandles selected={selected} />
      <CanvasNodeFrame kind="shape" selected={selected}>
        {/* The outline is drawn bare; the label stays this node's own editable
            element below, because the caret logic needs its ref. */}
        <CanvasShape shape={d.shapeType} />
        <div className="absolute inset-0 flex items-center justify-center p-3">
          <div
            ref={ref}
            className={cn(
              CANVAS_FIELD_CLASS.shapeLabel,
              "max-w-full whitespace-pre-wrap break-words",
              // An empty contentEditable has no line box, so the caret can't render;
              // a min line-height gives it one when the shape has no text yet.
              "min-h-[1.25em] min-w-[2px]",
              editing ? "nodrag cursor-text select-text" : "cursor-default select-none",
            )}
            contentEditable={editing}
            suppressContentEditableWarning
            onBlur={commit}
          >
            {d.text}
          </div>
        </div>
      </CanvasNodeFrame>
    </div>
  );
});
