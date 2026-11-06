import { useEffect, useRef } from "react";
import { themeBase, themeColor, useThemeVersion } from "@/features/theme/theme-values";
import { withAlpha } from "@tryatlas/design/theme";

/**
 * Canvas/figma-style ruler overlay for the graph views. Draws a top + left
 * ruler in world coordinates that tracks the graph's pan/zoom. Pure overlay —
 * `pointer-events: none` so it never intercepts graph interaction.
 *
 * One `<canvas>` (not hundreds of DOM ticks) redrawn on viewport change.
 *
 * `fillStyle`/`strokeStyle` take a resolved CSS colour, not a custom-property
 * reference (same constraint as pixi/xterm — decision 14), so the ruler's
 * colours (and the mono font) are read through `theme-values.ts` at draw time and the effect
 * re-runs on `useThemeVersion()` rather than once at module scope.
 */

export interface Viewport {
  x: number; // pan, CSS px
  y: number;
  scale: number;
}

const BAND = 20; // ruler thickness, CSS px

/** Nearest "nice" step (1/2/5 × 10ⁿ) ≥ `raw`. */
function niceStep(raw: number): number {
  const exp = Math.floor(Math.log10(raw));
  const base = Math.pow(10, exp);
  const f = raw / base;
  const mult = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return mult * base;
}

export function GraphRuler({
  width,
  height,
  viewport,
}: {
  width: number;
  height: number;
  viewport: Viewport;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const themeVersion = useThemeVersion();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0 || height === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // The border ramp for ticks — `strong` on the labelled major tick, the
    // default border on the minor ones so the scale reads at a glance — muted
    // foreground for labels, the graph's own panel surface for the band fill
    // and `element.highlight` for the hairline edge (the same raised-edge
    // tint the rest of the app uses, so it stays legible in a light
    // appearance).
    const MAJOR_COL = themeColor("border.strong");
    const MINOR_COL = themeBase("border");
    const LABEL_COL = themeBase("muted-foreground");
    const BAND_BG = withAlpha(themeColor("panel.background"), 0.85);
    const BORDER_COL = themeColor("element.highlight");
    const mono =
      getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() ||
      "ui-monospace, monospace";

    const { x: vx, y: vy, scale } = viewport;
    // Target ~70px between major ticks on screen.
    const step = niceStep(70 / scale || 1);
    const screenStep = step * scale;
    const worldToScreenX = (wx: number) => wx * scale + vx;
    const worldToScreenY = (wy: number) => wy * scale + vy;

    ctx.font = `500 9px ${mono}`;
    ctx.textBaseline = "middle";

    // ── Band backgrounds ──
    ctx.fillStyle = BAND_BG;
    ctx.fillRect(0, 0, width, BAND); // top
    ctx.fillRect(0, 0, BAND, height); // left

    // ── Top ruler (X) ──
    const firstX = Math.ceil(-vx / scale / step) * step;
    const lastX = (width - vx) / scale;
    ctx.fillStyle = LABEL_COL;
    ctx.textAlign = "left";
    for (let wx = firstX; wx <= lastX; wx += step) {
      const sx = worldToScreenX(wx);
      if (sx < BAND) continue;
      ctx.strokeStyle = MAJOR_COL;
      ctx.beginPath();
      ctx.moveTo(sx + 0.5, BAND - 5);
      ctx.lineTo(sx + 0.5, BAND);
      ctx.stroke();
      ctx.fillText(String(Math.round(wx)), sx + 3, BAND / 2);
      // minor ticks
      for (let m = 1; m < 5; m++) {
        const mx = sx + (screenStep / 5) * m;
        ctx.strokeStyle = MINOR_COL;
        ctx.beginPath();
        ctx.moveTo(mx + 0.5, BAND - 2.5);
        ctx.lineTo(mx + 0.5, BAND);
        ctx.stroke();
      }
    }

    // ── Left ruler (Y) — rotated labels ──
    const firstY = Math.ceil(-vy / scale / step) * step;
    const lastY = (height - vy) / scale;
    for (let wy = firstY; wy <= lastY; wy += step) {
      const sy = worldToScreenY(wy);
      if (sy < BAND) continue;
      ctx.strokeStyle = MAJOR_COL;
      ctx.beginPath();
      ctx.moveTo(BAND - 5, sy + 0.5);
      ctx.lineTo(BAND, sy + 0.5);
      ctx.stroke();
      ctx.save();
      ctx.translate(BAND / 2, sy + 3);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = LABEL_COL;
      ctx.textAlign = "left";
      ctx.fillText(String(Math.round(wy)), 0, 0);
      ctx.restore();
      for (let m = 1; m < 5; m++) {
        const my = sy + (screenStep / 5) * m;
        ctx.strokeStyle = MINOR_COL;
        ctx.beginPath();
        ctx.moveTo(BAND - 2.5, my + 0.5);
        ctx.lineTo(BAND, my + 0.5);
        ctx.stroke();
      }
    }

    // Corner square to mask the band intersection.
    ctx.fillStyle = BAND_BG;
    ctx.fillRect(0, 0, BAND, BAND);

    // ── Subtle inner borders along the band edges ──
    ctx.strokeStyle = BORDER_COL;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, BAND + 0.5);
    ctx.lineTo(width, BAND + 0.5);
    ctx.moveTo(BAND + 0.5, 0);
    ctx.lineTo(BAND + 0.5, height);
    ctx.stroke();
  }, [width, height, viewport, themeVersion]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 z-panel h-full w-full"
    />
  );
}
