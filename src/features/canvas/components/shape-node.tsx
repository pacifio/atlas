import { memo, useCallback, useEffect, useRef, useState } from "react";
import { NodeResizer, type NodeProps } from "@xyflow/react";
import { cn } from "@/lib/utils";
import { useCanvasStore, type ShapeType } from "../stores/canvas-store";
import { NodeHandles } from "./node-handles";

export interface ShapeNodeData extends Record<string, unknown> {
  shapeType: ShapeType;
  text: string;
}

/** The shape outline, drawn in a normalized 100×100 viewBox stretched to the
 *  node box (`preserveAspectRatio: none`). `vector-effect: non-scaling-stroke`
 *  keeps the border an even width regardless of the box's aspect ratio. */
function ShapeSvg({ type, stroke }: { type: ShapeType; stroke: string }) {
  const common = {
    fill: "var(--bg-secondary)",
    fillOpacity: 0.7,
    stroke,
    strokeWidth: 1.5,
    vectorEffect: "non-scaling-stroke" as const,
  };
  return (
    <svg
      className="absolute inset-0 h-full w-full"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden
    >
      {type === "ellipse" ? (
        <ellipse cx={50} cy={50} rx={49} ry={49} {...common} />
      ) : type === "diamond" ? (
        <polygon points="50,1 99,50 50,99 1,50" {...common} />
      ) : (
        <rect
          x={1}
          y={1}
          width={98}
          height={98}
          rx={type === "rounded" ? 14 : 0}
          {...common}
        />
      )}
    </svg>
  );
}

/** Geometric flowchart shape. Connectable from any side (shared handles); the
 *  only editable content is a centered text label (double-click to edit). */
export const ShapeNode = memo(function ShapeNode({
  id,
  data,
  selected,
}: NodeProps) {
  const d = data as ShapeNodeData;
  const { updateNote, moveNote, beginInteraction } =
    useCanvasStore.use.actions();
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

  const stroke = selected ? "var(--accent-primary)" : "rgba(255,255,255,0.25)";

  return (
    // React Flow owns the box size (so NodeResizer can drive it); the shape fills
    // it. Size is persisted to the store via onResize.
    <div
      className="group relative h-full w-full"
      onDoubleClick={() => setEditing(true)}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={40}
        minHeight={40}
        lineClassName="!border-[var(--accent-primary)]/70"
        handleClassName="!bg-[var(--accent-primary)] !border-white/60 !w-2 !h-2 !rounded-sm"
        onResizeStart={() => beginInteraction()}
        onResize={(_, p) => {
          moveNote(id, p.x, p.y);
          updateNote(id, { width: p.width, height: p.height });
        }}
      />
      <NodeHandles selected={selected} />
      <ShapeSvg type={d.shapeType} stroke={stroke} />
      {/* Centered label overlay */}
      <div className="absolute inset-0 flex items-center justify-center p-3">
        <div
          ref={ref}
          className={cn(
            "max-w-full whitespace-pre-wrap break-words text-center outline-none",
            "text-[12px] leading-snug text-[var(--text-primary)] caret-[var(--accent-primary)]",
            // An empty contentEditable has no line box, so the caret can't render;
            // a min line-height gives it one when the shape has no text yet.
            "min-h-[1.25em] min-w-[2px]",
            editing
              ? "nodrag cursor-text select-text"
              : "cursor-default select-none",
          )}
          contentEditable={editing}
          suppressContentEditableWarning
          onBlur={commit}
        >
          {d.text}
        </div>
      </div>
    </div>
  );
});
