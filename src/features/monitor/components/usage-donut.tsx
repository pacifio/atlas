export interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

/**
 * Hand-rolled SVG donut (no chart lib — consistent with the app's
 * SVG ring technique). Each segment is an arc drawn with
 * `stroke-dasharray` + a cumulative `strokeDashoffset`. Rotated -90° so
 * the first segment starts at 12 o'clock.
 */
export function UsageDonut({
  segments,
  size = 120,
  thickness = 14,
  children,
}: {
  segments: DonutSegment[];
  size?: number;
  thickness?: number;
  children?: React.ReactNode;
}) {
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const total = segments.reduce((s, seg) => s + Math.max(0, seg.value), 0);

  let offset = 0;
  const arcs =
    total > 0
      ? segments
          .filter((s) => s.value > 0)
          .map((seg) => {
            const frac = seg.value / total;
            const len = frac * c;
            // Tiny gap between segments for definition.
            const gap = segments.length > 1 ? Math.min(2, len * 0.15) : 0;
            const arc = (
              <circle
                key={seg.label}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={seg.color}
                strokeWidth={thickness}
                strokeDasharray={`${Math.max(0, len - gap)} ${c - Math.max(0, len - gap)}`}
                strokeDashoffset={-offset}
              />
            );
            offset += len;
            return arc;
          })
      : null;

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--border-default)"
          strokeWidth={thickness}
        />
        {arcs}
      </svg>
      {children && (
        <div className="absolute inset-0 flex flex-col items-center justify-center">{children}</div>
      )}
    </div>
  );
}
