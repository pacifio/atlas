// A tiny determinate ring, the titlebar's download-indicator geometry: 14px,
// r=6, rotated -90° so progress grows from 12 o'clock, round caps. When the
// server declared no content-length (`total === 0`) there is nothing honest to
// draw a fraction of, so the ring spins indeterminate instead (the same
// `atlas-arc-spin` treatment the plan-tasks pill uses).

export function ArcProgress({ got, total }: { got: number; total: number }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  if (total <= 0) {
    return (
      <svg width={14} height={14} viewBox="0 0 16 16" className="shrink-0">
        <g style={{ transformOrigin: "8px 8px", animation: "atlas-arc-spin 0.9s linear infinite" }}>
          <circle
            cx={8}
            cy={8}
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeDasharray="12 29"
          />
        </g>
      </svg>
    );
  }
  const frac = Math.min(1, Math.max(0, got / total));
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" className="-rotate-90 shrink-0">
      <circle
        cx={8}
        cy={8}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeOpacity={0.25}
      />
      <circle
        cx={8}
        cy={8}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - frac)}
        style={{ transition: "stroke-dashoffset 200ms ease-out" }}
      />
    </svg>
  );
}
