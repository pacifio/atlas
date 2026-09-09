import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * A retro ordered-dither noise field that drifts like slow cloud cover — the
 * landing page's hero backdrop, brought home.
 *
 * Two modes over one field: `dots` prints the comms placeholder's 1.5px dots
 * on a 4px grid; `glyphs` prints a character per 12px cell whose weight
 * tracks the intensity — the ASCII variant the landing hero uses.
 *
 * Canvas, not DOM: the field is tens of thousands of cells. Stepped at ~12fps
 * because ordered dither reads as retro precisely because it snaps; tweened
 * it is just noise — and a backdrop does not get a 60fps budget. Each frame
 * is a plain pixel repaint with no transforms, so a vibrant panel's blend
 * layer sees a still element. Parks while the tab is hidden, while the
 * element is off screen, and entirely under prefers-reduced-motion (one
 * still frame). A 4×4 Bayer threshold turns intensity into density, and a
 * radial hollow keeps the middle calm so copy sits on black.
 */
export function DitherField({
  mode = "glyphs",
  hollow,
  ink = 1,
  className,
}: {
  mode?: "dots" | "glyphs";
  /** `[start, span]` of the radial hollow as fractions of the half-diagonal:
   *  nothing prints inside `start`, full density from `start + span` out. */
  hollow?: [number, number];
  /** Multiplier on the ink alpha. `1` is the landing page's own value, which
   *  is the reference — a surface that mattes the field behind a mask (the
   *  chat welcome does) loses contrast the landing never had, and turns this
   *  up to buy it back. Alpha only: density is the Bayer threshold's business,
   *  and raising THAT changes the pattern rather than its weight. */
  ink?: number;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const hollowStart = hollow?.[0];
  const hollowSpan = hollow?.[1];

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const GLYPHS = " .·:-=+*#";
    const BAYER = [
      [0, 8, 2, 10],
      [12, 4, 14, 6],
      [3, 11, 1, 9],
      [15, 7, 13, 5],
    ];
    const FRAME_MS = 80;
    const CELL = mode === "glyphs" ? 12 : 4;
    const [h0, h1] =
      hollowStart != null && hollowSpan != null
        ? [hollowStart, hollowSpan]
        : mode === "glyphs"
          ? [0.34, 0.5]
          : [0.22, 0.55];
    let raf = 0;
    let last = 0;
    let visible = document.visibilityState === "visible";
    let onScreen = true;

    const noiseAt = (x: number, y: number, phase: number) => {
      const a = Math.sin(x * 0.012 + Math.sin(y * 0.009 + phase) * 2.1);
      const b = Math.sin(y * 0.011 - Math.cos(x * 0.007 - phase) * 1.7);
      const c = Math.sin((x + y) * 0.004 + 1.3 + phase * 2);
      return (a + b + c) / 3; // -1..1
    };

    const draw = (t: number) => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      if (!w || !h) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const bw = Math.ceil(w * dpr);
      const bh = Math.ceil(h * dpr);
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      // Wind: mostly sideways, a little lift, plus a slow phase evolution so
      // shapes morph rather than only translate.
      const wx = t * 0.012;
      const wy = t * 0.003;
      const phase = t * 0.0004;
      const cx = w / 2;
      const cy = h / 2;
      const maxR = Math.hypot(cx, cy);
      // Landing parity: 0.3 for glyphs, 0.16 for dots (`landing/index.html`).
      const alpha = Math.min(1, (mode === "glyphs" ? 0.3 : 0.16) * ink);
      if (mode === "glyphs") {
        ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
        ctx.textBaseline = "top";
        ctx.fillStyle = `rgba(255,255,255,${alpha})`;
      } else {
        ctx.fillStyle = `rgba(255,255,255,${alpha})`;
      }
      for (let gy = 0; gy < h / CELL; gy++) {
        for (let gx = 0; gx < w / CELL; gx++) {
          const x = gx * CELL;
          const y = gy * CELL;
          let v = (noiseAt(x + wx, y + wy, phase) + 1) / 2;
          const r = Math.hypot(x - cx, y - cy) / maxR;
          v *= Math.min(1, Math.max(0, (r - h0) / h1));
          if (mode === "glyphs") {
            const i = Math.min(GLYPHS.length - 1, Math.floor(v * v * GLYPHS.length));
            if (i > 0 && v * 16 > BAYER[gy % 4][gx % 4] * 0.6) ctx.fillText(GLYPHS[i], x, y);
          } else if (v * 16 > BAYER[gy % 4][gx % 4]) {
            ctx.fillRect(x, y, 1.5, 1.5);
          }
        }
      }
    };

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      // Step gate: repaint only when a frame's worth of drift has accrued.
      if (now - last < FRAME_MS) return;
      last = now;
      draw(now);
    };
    const start = () => {
      if (!raf && visible && onScreen && !reduced) raf = requestAnimationFrame(tick);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
    const onVisibility = () => {
      visible = document.visibilityState === "visible";
      if (visible) start();
      else stop();
    };

    draw(0);
    document.addEventListener("visibilitychange", onVisibility);
    const io = new IntersectionObserver(
      (entries) => {
        onScreen = entries.some((e) => e.isIntersecting);
        if (onScreen) start();
        else stop();
      },
      { rootMargin: "80px" },
    );
    io.observe(canvas);
    const parent = canvas.parentElement;
    const ro = new ResizeObserver(() => draw(last));
    if (parent) ro.observe(parent);
    start();
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      io.disconnect();
      ro.disconnect();
    };
  }, [mode, hollowStart, hollowSpan, ink]);

  return (
    <canvas
      ref={ref}
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 h-full w-full", className)}
    />
  );
}
