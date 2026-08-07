import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Trash2 } from "lucide-react";
import {
  usePdfAnnotationStore,
  newAnnotationId,
  type PdfAnnotation,
  type Point,
} from "../stores/pdf-annotation-store";

interface AnnotationLayerProps {
  pdfPath: string;
  page: number;
  /** Rendered pixel size of the PDF page this layer overlays. */
  pageW: number;
  pageH: number;
}

interface Draft {
  kind: "highlight" | "pencil";
  start: Point;
  rect?: { x: number; y: number; w: number; h: number };
  points?: Point[];
}

const HIGHLIGHT_OPACITY = 0.32;
const MIN_HIGHLIGHT = 0.005; // ignore stray taps

/**
 * SVG annotation overlay for a single rendered PDF page. Geometry is stored
 * normalized (0..1) and painted in pixel space (× pageW/H). When the active
 * tool is "none" the layer is click-through so PDF text selection/links work;
 * note pins stay interactive regardless so notes can always be read/edited.
 */
export function AnnotationLayer({ pdfPath, page, pageW, pageH }: AnnotationLayerProps) {
  const tool = usePdfAnnotationStore.use.tool();
  const color = usePdfAnnotationStore.use.color();
  const selectedId = usePdfAnnotationStore.use.selectedId();
  const byPath = usePdfAnnotationStore.use.byPath();
  const { add, remove, select, updateNoteText } = usePdfAnnotationStore.use.actions();

  const annotations = (byPath[pdfPath] ?? []).filter((a) => a.page === page);
  const [draft, setDraft] = useState<Draft | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const norm = (e: ReactPointerEvent): Point => {
    const r = svgRef.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (tool === "none" || tool === "erase") return; // erase handled per-shape
    e.preventDefault();
    svgRef.current?.setPointerCapture(e.pointerId);
    const p = norm(e);
    if (tool === "note") {
      add(pdfPath, {
        id: newAnnotationId(),
        kind: "note",
        page,
        color,
        x: p.x,
        y: p.y,
        text: "",
        createdAt: new Date().toISOString(),
      });
      return;
    }
    if (tool === "highlight") {
      setDraft({ kind: "highlight", start: p, rect: { x: p.x, y: p.y, w: 0, h: 0 } });
    } else if (tool === "pencil") {
      setDraft({ kind: "pencil", start: p, points: [p] });
    }
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    if (!draft) return;
    const p = norm(e);
    if (draft.kind === "highlight") {
      setDraft({
        ...draft,
        rect: {
          x: Math.min(draft.start.x, p.x),
          y: Math.min(draft.start.y, p.y),
          w: Math.abs(p.x - draft.start.x),
          h: Math.abs(p.y - draft.start.y),
        },
      });
    } else if (draft.kind === "pencil") {
      setDraft({ ...draft, points: [...(draft.points ?? []), p] });
    }
  };

  const onPointerUp = () => {
    if (!draft) return;
    if (
      draft.kind === "highlight" &&
      draft.rect &&
      draft.rect.w > MIN_HIGHLIGHT &&
      draft.rect.h > MIN_HIGHLIGHT
    ) {
      add(pdfPath, {
        id: newAnnotationId(),
        kind: "highlight",
        page,
        color,
        rect: draft.rect,
        createdAt: new Date().toISOString(),
      });
    } else if (draft.kind === "pencil" && draft.points && draft.points.length > 1) {
      add(pdfPath, {
        id: newAnnotationId(),
        kind: "pencil",
        page,
        color,
        points: draft.points,
        createdAt: new Date().toISOString(),
      });
    }
    setDraft(null);
  };

  const eraseClick = (a: PdfAnnotation) => {
    if (tool === "erase") remove(pdfPath, a.id);
  };

  const notes = annotations.filter(
    (a): a is Extract<PdfAnnotation, { kind: "note" }> => a.kind === "note",
  );
  const selectedNote = notes.find((n) => n.id === selectedId);

  return (
    // z-index 5 sits ABOVE react-pdf's text layer (z-index: 2) so the drawing
    // svg and note pins actually receive pointer events. The container itself
    // is click-through (`pointer-events: none`) so PDF text selection/links
    // still work in read mode; the svg/pins re-enable pointer-events as needed.
    <div
      className="absolute inset-0"
      style={{ width: pageW, height: pageH, zIndex: 5, pointerEvents: "none" }}
    >
      <svg
        ref={svgRef}
        width={pageW}
        height={pageH}
        className="absolute inset-0"
        style={{
          pointerEvents: tool === "none" ? "none" : "auto",
          cursor: tool === "pencil" ? "crosshair" : tool === "erase" ? "not-allowed" : "default",
          touchAction: "none",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {annotations.map((a) => {
          if (a.kind === "highlight") {
            return (
              <rect
                key={a.id}
                x={a.rect.x * pageW}
                y={a.rect.y * pageH}
                width={a.rect.w * pageW}
                height={a.rect.h * pageH}
                fill={a.color}
                opacity={HIGHLIGHT_OPACITY}
                style={{ pointerEvents: tool === "erase" ? "auto" : "none" }}
                onPointerDown={() => eraseClick(a)}
              />
            );
          }
          if (a.kind === "pencil") {
            return (
              <polyline
                key={a.id}
                points={a.points.map((p) => `${p.x * pageW},${p.y * pageH}`).join(" ")}
                fill="none"
                stroke={a.color}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ pointerEvents: tool === "erase" ? "auto" : "none" }}
                onPointerDown={() => eraseClick(a)}
              />
            );
          }
          return null;
        })}

        {/* In-progress draft */}
        {draft?.kind === "highlight" && draft.rect && (
          <rect
            x={draft.rect.x * pageW}
            y={draft.rect.y * pageH}
            width={draft.rect.w * pageW}
            height={draft.rect.h * pageH}
            fill={color}
            opacity={HIGHLIGHT_OPACITY}
          />
        )}
        {draft?.kind === "pencil" && draft.points && (
          <polyline
            points={draft.points.map((p) => `${p.x * pageW},${p.y * pageH}`).join(" ")}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </svg>

      {/* Note pins — always interactive (clickable in any tool, incl. none). */}
      {notes.map((n) => (
        <button
          key={n.id}
          type="button"
          onClick={() => (tool === "erase" ? remove(pdfPath, n.id) : select(n.id))}
          className="absolute flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-black/20 text-[10px] font-bold text-black/70 shadow-sm"
          style={{
            left: n.x * pageW,
            top: n.y * pageH,
            background: n.color,
            pointerEvents: "auto",
          }}
          title={n.text || "Note"}
        >
          {n.text ? "•" : "+"}
        </button>
      ))}

      {/* Note editor popover for the selected note on this page. */}
      {selectedNote && (
        <div
          className="absolute z-10 w-56 rounded-md border border-border-default bg-bg-elevated p-2 shadow-[var(--shadow-overlay)]"
          style={{
            left: Math.min(selectedNote.x * pageW + 12, pageW - 230),
            top: selectedNote.y * pageH + 12,
            pointerEvents: "auto",
          }}
        >
          <textarea
            autoFocus
            value={selectedNote.text}
            onChange={(e) => updateNoteText(pdfPath, selectedNote.id, e.target.value)}
            placeholder="Write a note…"
            className="h-20 w-full resize-none rounded-sm border border-border-default bg-bg-base p-1.5 text-[12px] text-text-primary outline-none placeholder:text-text-tertiary"
          />
          <div className="mt-1.5 flex items-center justify-between">
            <button
              type="button"
              onClick={() => remove(pdfPath, selectedNote.id)}
              className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] text-[var(--status-error)] hover:bg-[var(--status-error-muted)]"
            >
              <Trash2 size={11} /> Delete
            </button>
            <button
              type="button"
              onClick={() => select(null)}
              className="rounded-sm px-2 py-0.5 text-[11px] text-text-secondary hover:bg-bg-hover hover:text-text-primary"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
