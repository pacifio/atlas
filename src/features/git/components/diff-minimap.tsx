import { memo, useEffect, useRef, type RefObject } from "react";
import type { DiffRow } from "../lib/git-diff-api";

interface DiffMinimapProps {
  rows: DiffRow[];
  /** The diff's scroll container. The minimap mirrors its scroll position and
   *  drives it on click / drag. */
  scrollRef: RefObject<HTMLDivElement | null>;
}

type Kind = "context" | "added" | "removed" | "changed";

const WIDTH = 120; // logical px — wide enough to read line shape
const CHAR_W = 1; // px per character
const LINE_H = 4; // minimap px per row (3px glyph + 1px interline)

// Text-blob colours, keyed by the row's change kind (Atom-style token blocks,
// but tinted by diff semantics rather than syntax so the change story reads).
const TEXT: Record<Kind, string> = {
  context: "rgba(165,170,180,0.55)",
  added: "rgba(52,211,153,0.85)",
  removed: "rgba(244,99,99,0.8)",
  changed: "rgba(245,190,90,0.9)",
};
// Faint full-row wash behind changed rows so clusters pop even on sparse lines.
const ROW_BG: Partial<Record<Kind, string>> = {
  added: "rgba(34,197,94,0.12)",
  removed: "rgba(244,63,63,0.12)",
  changed: "rgba(245,180,60,0.12)",
};

function rowKind(r: DiffRow): Kind {
  const side = r.right ?? r.left;
  return (side?.kind ?? "context") as Kind;
}

/**
 * A JetBrains/Atom-style code minimap for the diff. Each row is rendered as a
 * row of small blocks — one per non-whitespace run of the line's text — so the
 * developer sees the shape of the code (indentation, line lengths, gaps) and
 * where edits cluster, then clicks/drags to scroll straight there.
 *
 * Performance: the blobs are painted ONCE to a canvas when the diff changes;
 * scrolling only repositions the canvas + viewport indicator via direct style
 * mutation (no React re-render per scroll event). When the rendered content is
 * taller than the strip, the canvas pans with the editor scroll (Atom-style).
 */
export const DiffMinimap = memo(function DiffMinimap({
  rows,
  scrollRef,
}: DiffMinimapProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  // Geometry shared between the (rows-keyed) paint pass and the scroll handler.
  const geom = useRef({ lineH: LINE_H, contentH: 0 });

  useEffect(() => {
    const box = boxRef.current;
    const canvas = canvasRef.current;
    const indicator = indicatorRef.current;
    const scroller = scrollRef.current;
    if (!box || !canvas) return;

    const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));

    const paint = () => {
      const n = rows.length;
      if (n === 0) return;
      // Bound the canvas pixel height to a safe limit; shrink the line height
      // (denser blobs) for very large diffs rather than overflow the canvas.
      const maxLogical = Math.floor(16384 / dpr);
      const lineH =
        n * LINE_H > maxLogical
          ? Math.max(1, Math.floor(maxLogical / n))
          : LINE_H;
      const charH = Math.max(1, lineH - 1);
      const contentH = n * lineH;
      geom.current = { lineH, contentH };

      canvas.style.width = `${WIDTH}px`;
      canvas.style.height = `${contentH}px`;
      canvas.width = WIDTH * dpr;
      canvas.height = contentH * dpr;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, WIDTH, contentH);

      const runRe = /\S+/g;
      for (let i = 0; i < n; i++) {
        const row = rows[i];
        const kind = rowKind(row);
        const y = i * lineH;
        const wash = ROW_BG[kind];
        if (wash) {
          ctx.fillStyle = wash;
          ctx.fillRect(0, y, WIDTH, lineH);
        }
        const side = row.right ?? row.left;
        if (!side) continue;
        // Tabs → 2 cols so indentation reads; runs of non-space become blocks.
        const text = side.segments
          .map((s) => s.text)
          .join("")
          .replace(/\t/g, "  ");
        ctx.fillStyle = TEXT[kind];
        runRe.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = runRe.exec(text))) {
          const rx = m.index * CHAR_W;
          if (rx >= WIDTH) break;
          ctx.fillRect(
            rx,
            y,
            Math.min(m[0].length * CHAR_W, WIDTH - rx),
            charH,
          );
        }
      }
    };

    const reposition = () => {
      if (!scroller || !indicator) return;
      const { contentH } = geom.current;
      const boxH = box.clientHeight;
      const sH = scroller.scrollHeight || 1;
      const cH = scroller.clientHeight;
      const st = scroller.scrollTop;
      const over = Math.max(0, contentH - boxH);
      const ratio = sH - cH > 0 ? st / (sH - cH) : 0;
      const offset = over * ratio;
      canvas.style.transform = `translateY(${-offset}px)`;
      indicator.style.top = `${(st / sH) * contentH - offset}px`;
      indicator.style.height = `${Math.max(2, (cH / sH) * contentH)}px`;
    };

    paint();
    reposition();

    const onScroll = () => reposition();
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(reposition);
    if (scroller) ro.observe(scroller);
    ro.observe(box);
    return () => {
      scroller?.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [rows, scrollRef]);

  const scrollToClientY = (clientY: number) => {
    const box = boxRef.current;
    const scroller = scrollRef.current;
    if (!box || !scroller) return;
    const { contentH } = geom.current;
    const sH = scroller.scrollHeight;
    const cH = scroller.clientHeight;
    const over = Math.max(0, contentH - box.clientHeight);
    const ratio = sH - cH > 0 ? scroller.scrollTop / (sH - cH) : 0;
    const offset = over * ratio;
    const rect = box.getBoundingClientRect();
    const yInContent = clientY - rect.top + offset;
    const bufferY = (yInContent / (contentH || 1)) * sH;
    scroller.scrollTo({ top: Math.max(0, bufferY - cH / 2) });
  };

  if (rows.length === 0) return null;

  return (
    <div
      ref={boxRef}
      className="relative shrink-0 cursor-pointer overflow-hidden border-l border-[var(--border-default)] bg-[var(--bg-secondary)]"
      style={{ width: WIDTH }}
      title="Code map — click or drag to scroll"
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        scrollToClientY(e.clientY);
      }}
      onPointerMove={(e) => {
        if (dragging.current) scrollToClientY(e.clientY);
      }}
      onPointerUp={(e) => {
        dragging.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
    >
      <canvas
        ref={canvasRef}
        className="absolute left-0 top-0"
        style={{ willChange: "transform" }}
      />
      <div
        ref={indicatorRef}
        className="pointer-events-none absolute left-0 right-0 border-y border-white/25 bg-white/10"
      />
    </div>
  );
});
