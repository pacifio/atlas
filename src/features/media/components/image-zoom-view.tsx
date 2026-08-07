import { useCallback, useEffect, useRef, useState } from "react";
import { ZoomIn, ZoomOut, Maximize } from "lucide-react";
import { cn } from "@/lib/utils";

interface ImageZoomViewProps {
  src: string;
  alt: string;
  /** Scale the image UP to fill the container (for vector/SVG, whose intrinsic
   *  size is tiny). Raster images keep `max-*` so they're never blown up. */
  fill?: boolean;
  /** Neutral checkerboard backdrop so any-color content — incl. black
   *  `currentColor` SVGs and transparency — stays visible on the dark UI. */
  checkerboard?: boolean;
}

// Two mid-grays: black AND white SVG content both read against it.
const CHECKER: React.CSSProperties = {
  backgroundColor: "#7c7c7c",
  backgroundImage:
    "linear-gradient(45deg, #6a6a6a 25%, transparent 25%), linear-gradient(-45deg, #6a6a6a 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #6a6a6a 75%), linear-gradient(-45deg, transparent 75%, #6a6a6a 75%)",
  backgroundSize: "20px 20px",
  backgroundPosition: "0 0, 0 10px, 10px -10px, -10px 0",
};

const MIN_SCALE = 1;
const MAX_SCALE = 8;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Zoomable / pannable image. Wheel (or ⌘/Ctrl-wheel) zooms toward the cursor,
 * drag pans when zoomed in, double-click resets to fit. Scale is clamped to
 * [1, 8]; at 1× the image snaps back to centered/fit.
 */
export function ImageZoomView({ src, alt, fill, checkerboard }: ImageZoomViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const reset = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  // Reset when the image changes.
  useEffect(() => {
    reset();
  }, [src, reset]);

  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    setScale((prev) => {
      const next = clamp(prev * factor, MIN_SCALE, MAX_SCALE);
      const ratio = next / prev;
      if (next === MIN_SCALE) {
        setOffset({ x: 0, y: 0 });
      } else {
        setOffset((o) => ({
          x: cx - ratio * (cx - o.x),
          y: cy - ratio * (cy - o.y),
        }));
      }
      return next;
    });
  }, []);

  // Non-passive wheel listener so we can preventDefault the page scroll.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      // Proportional to the scroll delta (clamped) so a trackpad's many small
      // events feel smooth instead of snapping. ~0.4% per delta unit.
      const d = Math.max(-60, Math.min(60, e.deltaY));
      zoomAt(Math.pow(1.004, -d), cx, cy);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (scale <= 1) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setOffset({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) });
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };

  const zoomButton = (factor: number) => () => zoomAt(factor, 0, 0);

  return (
    <div
      ref={containerRef}
      className="relative flex h-full w-full items-center justify-center overflow-hidden"
      style={{
        cursor: scale > 1 ? (dragRef.current ? "grabbing" : "grab") : "default",
        ...(checkerboard ? CHECKER : null),
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={reset}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        className={cn(
          "select-none object-contain",
          fill ? "h-full w-full p-8" : "max-h-full max-w-full",
        )}
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          transformOrigin: "center center",
          // Snap transitions for button zoom; instant for wheel/drag feel.
          transition: dragRef.current ? "none" : "transform 0.08s ease-out",
        }}
      />

      {/* Zoom controls */}
      <div className="absolute bottom-3 right-3 flex items-center gap-0.5 rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated)] px-1 py-0.5 shadow-[var(--shadow-overlay)]">
        <button
          type="button"
          onClick={zoomButton(1 / 1.3)}
          title="Zoom out"
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <ZoomOut size={13} />
        </button>
        <span className="w-9 text-center text-[10px] font-mono text-[var(--text-tertiary)]">
          {Math.round(scale * 100)}%
        </span>
        <button
          type="button"
          onClick={zoomButton(1.3)}
          title="Zoom in"
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <ZoomIn size={13} />
        </button>
        <button
          type="button"
          onClick={reset}
          title="Reset zoom"
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <Maximize size={12} />
        </button>
      </div>
    </div>
  );
}
