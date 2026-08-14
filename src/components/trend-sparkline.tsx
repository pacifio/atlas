import { useId, useMemo } from "react";

/**
 * Apple-Stocks-style inline sparkline: a thin polyline over a soft gradient
 * area, with a dotted horizontal reference at the window's opening value.
 * Pure SVG — dozens render per marketplace grid, so no charting library.
 *
 * Single series → no legend (the surrounding label names it); values/labels
 * around it stay in text tokens, only the mark carries the trend color.
 * Polarity drives the hue: up = success green, down = error red, matching the
 * Stocks reference the design copies.
 */
export function TrendSparkline({
  points,
  width = 72,
  height = 24,
  label,
}: {
  points: number[];
  width?: number;
  height?: number;
  /** Accessible summary, also the native hover tooltip. */
  label?: string;
}) {
  const gid = useId();
  const { linePath, areaPath, baselineY, color } = useMemo(() => {
    const n = points.length;
    if (n < 2) return { linePath: "", areaPath: "", baselineY: 0, color: "" };
    const min = Math.min(...points);
    const max = Math.max(...points);
    const span = max - min || 1;
    const pad = 2; // keeps the 1.5px stroke from clipping at the extremes
    const x = (i: number) => (i / (n - 1)) * width;
    const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);
    const pts = points.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    const up = points[n - 1] >= points[0];
    return {
      linePath: `M${pts.join(" L")}`,
      areaPath: `M${pts.join(" L")} L${width},${height} L0,${height} Z`,
      baselineY: y(points[0]),
      color: up ? "var(--status-success)" : "var(--status-error)",
    };
  }, [points, width, height]);

  if (!linePath) return null;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
      className="shrink-0"
    >
      {label && <title>{label}</title>}
      <defs>
        <linearGradient id={`${gid}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.32} />
          <stop offset="100%" stopColor={color} stopOpacity={0.02} />
        </linearGradient>
      </defs>
      {/* Opening-value reference, like Stocks' previous-close line. */}
      <line
        x1={0}
        x2={width}
        y1={baselineY}
        y2={baselineY}
        stroke={color}
        strokeOpacity={0.35}
        strokeWidth={1}
        strokeDasharray="2 3"
      />
      <path d={areaPath} fill={`url(#${gid}-fill)`} />
      <path
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
