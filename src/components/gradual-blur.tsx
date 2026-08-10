// Progressive ("gradual") blur for a scroll edge.
//
// A plain gradient fade hides content by painting the background colour over it.
// This instead blurs it, ramping from nothing to full over the band, so text
// dissolves rather than being curtained off. The technique (after
// reactbits.dev/animations/gradual-blur): stack N layers, each with a stronger
// `backdrop-filter`, and mask each one to a narrow horizontal band. Where the
// bands overlap the blurs composite, and the result reads as continuous.
//
// ── Cost, and why the defaults are conservative ────────────────────────────
//
// Every layer is a live `backdrop-filter`, which means the compositor re-samples
// what is behind it on every frame the content moves. Over a scrolling
// transcript that is per-frame work on the one surface we care most about.
// WKWebView is also where this codebase has been burned by blur before (see the
// `atlas-vibrant-panel` note in globals.css, and the one-element rule in the
// feedback panel).
//
// So: `layers` defaults to 5 and should not casually grow — the visual return
// past ~6 is nil and the cost is linear. A `contain` on the container keeps each
// layer's work scoped. If scrolling regresses, this component is the first thing
// to turn off, and `layers={0}` does exactly that.

import { memo, useMemo } from "react";

export type BlurEdge = "top" | "bottom";

interface GradualBlurProps {
  /** Which edge of the (positioned) parent to sit on. */
  position: BlurEdge;
  /** Band height, any CSS length. */
  height?: string;
  /** Peak blur radius in rem at the strongest layer. */
  strength?: number;
  /** How many masked layers to stack. 0 disables the effect entirely. */
  layers?: number;
  /**
   * Ramp shape across the band. `bezier` (smoothstep) eases in and out and is
   * the most natural for a reading edge; `linear` ramps evenly.
   */
  curve?: "linear" | "bezier" | "ease-in" | "ease-out";
  /** Bias the ramp so most of the blur happens near the edge. */
  exponential?: boolean;
  /**
   * Optional colour wash composited under the blur, so content also dims toward
   * the edge instead of staying legible-but-fuzzy. Pass a CSS colour.
   */
  tint?: string;
  className?: string;
  style?: React.CSSProperties;
}

const CURVES: Record<string, (p: number) => number> = {
  linear: (p) => p,
  bezier: (p) => p * p * (3 - 2 * p),
  "ease-in": (p) => p * p,
  "ease-out": (p) => 1 - Math.pow(1 - p, 2),
};

export const GradualBlur = memo(function GradualBlur({
  position,
  height = "5rem",
  strength = 2,
  layers = 5,
  curve = "bezier",
  exponential = true,
  tint,
  className,
  style,
}: GradualBlurProps) {
  // The mask runs FROM the edge we sit on, so band 1 (least blurred) is the one
  // furthest into the content and band N (most blurred) hugs the edge.
  const direction = position === "top" ? "to top" : "to bottom";

  const blurLayers = useMemo(() => {
    if (layers <= 0) return [];
    const step = 100 / layers;
    const curveFn = CURVES[curve] ?? CURVES.linear;
    const out: React.CSSProperties[] = [];

    for (let i = 1; i <= layers; i++) {
      const progress = curveFn(i / layers);
      const blur = exponential
        ? Math.pow(2, progress * 4) * 0.0625 * strength
        : 0.0625 * (progress * layers + 1) * strength;

      // Four stops per band: ramp up, hold, ramp down. Neighbouring bands
      // overlap by one step, which is what keeps the seams invisible.
      const p1 = Math.round((step * i - step) * 10) / 10;
      const p2 = Math.round(step * i * 10) / 10;
      const p3 = Math.round((step * i + step) * 10) / 10;
      const p4 = Math.round((step * i + step * 2) * 10) / 10;
      let stops = `transparent ${p1}%, black ${p2}%`;
      if (p3 <= 100) stops += `, black ${p3}%`;
      if (p4 <= 100) stops += `, transparent ${p4}%`;

      const mask = `linear-gradient(${direction}, ${stops})`;
      const filter = `blur(${blur.toFixed(3)}rem)`;
      out.push({
        position: "absolute",
        inset: 0,
        maskImage: mask,
        WebkitMaskImage: mask,
        backdropFilter: filter,
        WebkitBackdropFilter: filter,
      });
    }
    return out;
  }, [layers, curve, exponential, strength, direction]);

  if (layers <= 0 && !tint) return null;

  return (
    <div
      aria-hidden
      className={className}
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        [position]: 0,
        height,
        pointerEvents: "none",
        // Scope layout/paint so the stack can't invalidate the transcript, and
        // `isolate` so the layers composite among themselves.
        isolation: "isolate",
        contain: "layout paint",
        ...style,
      }}
    >
      {blurLayers.map((s, i) => (
        <div key={i} style={s} />
      ))}
      {/* Colour wash over the blur — blurred text is still legible, so the band
          needs to dim as well as soften.

          Deliberately NOT a plain two-stop ramp: spread evenly across the band
          it is barely there in the middle and never gets solid at the edge. This
          reaches full tint at 65% and holds it the rest of the way, so the strip
          nearest the edge (where a floating header sits) has a real backing
          while the transition into content stays gradual. */}
      {tint && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: `linear-gradient(${direction}, transparent 0%, ${tint} 65%, ${tint} 100%)`,
          }}
        />
      )}
    </div>
  );
});
