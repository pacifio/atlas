import { useCallback, useEffect, useRef, useState } from "react";
import { ZoomIn, ZoomOut, Maximize } from "lucide-react";
import { cn } from "@/lib/utils";
import { HintGroup, HintItem } from "@/ui/hint-group";

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

// The transparency checkerboard. Two steps of the theme's own neutral ramp
// rather than two fixed greys: the pattern has to sit between the lightest and
// darkest thing the image can contain, and on a light theme a mid-grey ground
// is heavier than the picture on it.
const CHECKER: React.CSSProperties = {
  backgroundColor: "var(--muted)",
  backgroundImage:
    "linear-gradient(45deg, var(--accent) 25%, transparent 25%), linear-gradient(-45deg, var(--accent) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--accent) 75%), linear-gradient(-45deg, transparent 75%, var(--accent) 75%)",
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

      {/* Zoom controls — at the bottom of the view, so tooltips open upward. */}
      <HintGroup side="top">
        <div className="absolute bottom-3 right-3 flex items-center gap-0.5 rounded-md border border-[var(--border)] bg-[var(--card)] px-1 py-0.5 shadow-md">
          <HintItem label="Zoom out">
            <button
              type="button"
              onClick={zoomButton(1 / 1.3)}
              className="flex h-6 w-6 items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-element-hover hover:text-[var(--foreground)]"
            >
              <ZoomOut size={13} />
            </button>
          </HintItem>
          <span className="w-9 text-center text-2xs font-mono text-[var(--muted-foreground)]">
            {Math.round(scale * 100)}%
          </span>
          <HintItem label="Zoom in">
            <button
              type="button"
              onClick={zoomButton(1.3)}
              className="flex h-6 w-6 items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-element-hover hover:text-[var(--foreground)]"
            >
              <ZoomIn size={13} />
            </button>
          </HintItem>
          <HintItem label="Reset zoom">
            <button
              type="button"
              onClick={reset}
              className="flex h-6 w-6 items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-element-hover hover:text-[var(--foreground)]"
            >
              <Maximize size={12} />
            </button>
          </HintItem>
        </div>
      </HintGroup>
    </div>
  );
}
