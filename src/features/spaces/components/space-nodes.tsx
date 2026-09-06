import { memo, useEffect, useRef, useState } from "react";
import { NodeResizer, type NodeProps } from "@xyflow/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { StickyNote, ImageOff, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { NodeHandles } from "@/features/canvas/components/node-handles";
import { moveNode, nodesMap, resizeNode, writeField, type SpaceShapeType } from "../lib/space-doc";
import { spacesApi } from "../lib/spaces-api";
import { useSpaceCanvas } from "./space-canvas-ctx";

// The realtime canvas's node renderers — the local canvas's visual language
// (glass cards, 4-way handles) over the SHARED document model. Display data
// arrives via xyflow `data` (rebuilt per doc revision); edits write straight
// into the Y.Doc through `writeField`, so two people typing in one note merge
// character-wise instead of clobbering.

export interface SpaceNodeCommonData extends Record<string, unknown> {
  title: string;
  body: string;
  text: string;
  color: string | null;
  shapeType: SpaceShapeType | null;
  mediaKind: "image" | "video" | null;
  contentHash: string | null;
  mime: string | null;
}

/**
 * An editable prose field bound to a node's Y.Text.
 *
 * Uncontrolled while focused: a remote update re-renders the node with new
 * `value`, and a controlled input would throw the local caret to the end on
 * every peer keystroke. While THIS client is focused its element owns the
 * text; remote values are only synced in when it is not.
 */
function useMergedField(nodeId: string, field: "title" | "body" | "text", value: string) {
  const { doc, readOnly } = useSpaceCanvas();
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (document.activeElement !== el && el.value !== value) el.value = value;
  }, [value]);

  const onChange = () => {
    const el = ref.current;
    if (!el || readOnly) return;
    const d = doc();
    if (!d) return;
    writeField(d, nodesMap(d).get(nodeId), field, el.value);
  };

  return { ref, onChange, readOnly };
}

// ---------------------------------------------------------------------------

export const SpaceNoteNode = memo(function SpaceNoteNode({ id, data, selected }: NodeProps) {
  const d = data as SpaceNodeCommonData;
  const title = useMergedField(id, "title", d.title);
  const body = useMergedField(id, "body", d.body);

  return (
    <div
      className={cn(
        "group relative flex h-full w-full flex-col overflow-visible rounded-2xl",
        "bg-[var(--bg-secondary)]/70 backdrop-blur-3xl backdrop-saturate-150",
        "border shadow-2xl transition-colors",
        selected ? "border-[var(--accent-primary)]/60" : "border-white/10 hover:border-white/20",
      )}
    >
      <div className="pointer-events-none absolute inset-0 rounded-2xl bg-gradient-to-b from-white/5 to-transparent opacity-60" />
      <NodeHandles selected={selected} />
      <div className="relative flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-white/10">
          <StickyNote size={12} className="text-white/80" />
        </div>
        <input
          ref={title.ref}
          defaultValue={d.title}
          onChange={title.onChange}
          readOnly={title.readOnly}
          placeholder="Untitled"
          className="nodrag min-w-0 flex-1 bg-transparent text-[13px] font-semibold text-[var(--text-primary)] outline-none placeholder:text-text-tertiary"
        />
      </div>
      <textarea
        ref={body.ref}
        defaultValue={d.body}
        onChange={body.onChange}
        readOnly={body.readOnly}
        placeholder="Write something…"
        className="nodrag relative min-h-0 flex-1 resize-none rounded-b-2xl bg-transparent px-3 py-2.5 text-[12px] leading-relaxed text-[var(--text-secondary)] outline-none placeholder:italic placeholder:text-text-tertiary"
      />
      <SpaceResizer id={id} selected={selected} minWidth={160} minHeight={100} />
    </div>
  );
});

// ---------------------------------------------------------------------------

export const SpaceTextNode = memo(function SpaceTextNode({ id, data, selected }: NodeProps) {
  const d = data as SpaceNodeCommonData;
  const text = useMergedField(id, "text", d.text);

  return (
    <div
      className={cn(
        "group relative h-full w-full rounded",
        selected && "outline outline-1 outline-[var(--accent-primary)]/50",
      )}
    >
      <NodeHandles selected={selected} />
      <textarea
        ref={text.ref}
        defaultValue={d.text}
        onChange={text.onChange}
        readOnly={text.readOnly}
        placeholder="Text"
        className="nodrag h-full w-full resize-none whitespace-pre-wrap break-words bg-transparent px-1 py-0.5 text-[15px] leading-snug text-[var(--text-primary)] caret-[var(--accent-primary)] outline-none placeholder:text-text-tertiary"
      />
      <SpaceResizer id={id} selected={selected} minWidth={80} minHeight={40} />
    </div>
  );
});

// ---------------------------------------------------------------------------

/** The local canvas's shape recipe, plus the contract's triangle. Normalized
 *  100×100 viewBox stretched to the box; non-scaling stroke. */
function ShapeSvg({ type, stroke }: { type: SpaceShapeType; stroke: string }) {
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
      ) : type === "triangle" ? (
        <polygon points="50,1 99,99 1,99" {...common} />
      ) : (
        <rect x={1} y={1} width={98} height={98} {...common} />
      )}
    </svg>
  );
}

export const SpaceShapeNode = memo(function SpaceShapeNode({ id, data, selected }: NodeProps) {
  const d = data as SpaceNodeCommonData;
  // Web parity: a shape's label is its `title` field, centered.
  const title = useMergedField(id, "title", d.title);
  const stroke = selected ? "var(--accent-primary)" : "rgba(255,255,255,0.25)";

  return (
    <div className="group relative h-full w-full">
      <SpaceResizer id={id} selected={selected} minWidth={40} minHeight={40} />
      <NodeHandles selected={selected} />
      <ShapeSvg type={d.shapeType ?? "rectangle"} stroke={stroke} />
      <div className="absolute inset-0 flex items-center justify-center p-3">
        <textarea
          ref={title.ref}
          defaultValue={d.title}
          onChange={title.onChange}
          readOnly={title.readOnly}
          rows={1}
          className="nodrag max-h-full w-full resize-none whitespace-pre-wrap break-words bg-transparent text-center text-[12px] leading-snug text-[var(--text-primary)] caret-[var(--accent-primary)] outline-none"
        />
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------

/** A titled frame. Containment is visual only — the contract has no grouping
 *  linkage, and inventing one would be invisible to the web client. */
export const SpaceGroupNode = memo(function SpaceGroupNode({ id, data, selected }: NodeProps) {
  const d = data as SpaceNodeCommonData;
  const title = useMergedField(id, "title", d.title);

  return (
    <div
      className={cn(
        "group relative h-full w-full rounded-xl border-2 border-dashed",
        selected ? "border-[var(--accent-primary)]/50" : "border-white/15",
        "bg-white/[0.02]",
      )}
    >
      <NodeHandles selected={selected} />
      <input
        ref={title.ref}
        defaultValue={d.title}
        onChange={title.onChange}
        readOnly={title.readOnly}
        placeholder="Group"
        className="nodrag absolute -top-6 left-1 bg-transparent text-[11px] font-medium text-text-tertiary outline-none placeholder:text-text-tertiary/60"
      />
      <SpaceResizer id={id} selected={selected} minWidth={120} minHeight={80} />
    </div>
  );
});

// ---------------------------------------------------------------------------

/** In-flight fetches and resolved paths, module-level: the object behind a
 *  hash is immutable, so one IPC round per hash per session is enough. */
const mediaPathCache = new Map<string, Promise<string>>();

export const SpaceMediaNode = memo(function SpaceMediaNode({ id, data, selected }: NodeProps) {
  const d = data as SpaceNodeCommonData;
  const { convId } = useSpaceCanvas();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const hash = d.contentHash;
  const mime = d.mime ?? "application/octet-stream";

  useEffect(() => {
    if (!hash) return;
    let alive = true;
    setFailed(false);
    let fetching = mediaPathCache.get(hash);
    if (!fetching) {
      fetching = spacesApi.mediaFetch(convId, hash, mime);
      mediaPathCache.set(hash, fetching);
      // A failed fetch must not poison the cache — the ticket path can 502.
      fetching.catch(() => mediaPathCache.delete(hash));
    }
    fetching
      .then((path) => alive && setUrl(convertFileSrc(path)))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [convId, hash, mime]);

  return (
    <div className="group relative h-full w-full">
      <NodeHandles selected={selected} />
      <div
        className={cn(
          "h-full w-full overflow-hidden rounded-xl border transition-colors",
          selected ? "border-[var(--accent-primary)]/60" : "border-white/10",
          "bg-black/30",
        )}
      >
        {failed ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-text-tertiary">
            <ImageOff size={16} />
            <span className="text-[10px]">Media unavailable</span>
          </div>
        ) : url === null ? (
          <div className="flex h-full w-full items-center justify-center text-text-tertiary">
            <Loader2 size={16} className="animate-spin" />
          </div>
        ) : d.mediaKind === "video" ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video src={url} controls className="h-full w-full object-contain" />
        ) : (
          <img src={url} alt="" draggable={false} className="h-full w-full object-contain" />
        )}
      </div>
      <SpaceResizer id={id} selected={selected} />
    </div>
  );
});

// ---------------------------------------------------------------------------

/** Size writes go through the doc's clamp (`max(40, round)`), and only while
 *  actively resizing — xyflow measurement passes must never write LWW sizes. */
function SpaceResizer({
  id,
  selected,
  minWidth = 60,
  minHeight = 40,
}: {
  id: string;
  selected?: boolean;
  minWidth?: number;
  minHeight?: number;
}) {
  const { doc, readOnly } = useSpaceCanvas();
  if (readOnly) return null;
  return (
    <NodeResizer
      isVisible={!!selected}
      minWidth={minWidth}
      minHeight={minHeight}
      lineClassName="!border-[var(--accent-primary)]/70"
      handleClassName="!bg-[var(--accent-primary)] !border-white/60 !w-2 !h-2 !rounded-sm"
      onResize={(_, p) => {
        const d = doc();
        if (!d || !id) return;
        // A left/top handle moves the box while sizing it.
        moveNode(d, id, { x: p.x, y: p.y });
        resizeNode(d, id, { width: p.width, height: p.height });
      }}
    />
  );
}

export const SPACE_NODE_TYPES = {
  note: SpaceNoteNode,
  text: SpaceTextNode,
  shape: SpaceShapeNode,
  media: SpaceMediaNode,
  group: SpaceGroupNode,
} as const;
