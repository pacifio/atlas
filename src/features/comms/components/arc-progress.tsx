// A tiny determinate ring, the titlebar's download-indicator geometry: 14px,
// r=6, rotated -90° so progress grows from 12 o'clock, round caps. When the
// server declared no content-length (`total === 0`) there is nothing honest to
// draw a fraction of, so the ring spins indeterminate instead (the same
// `atlas-arc-spin` class the plan-tasks pill uses, which also steps the spin
// on Linux).
//
// A progressbar to assistive tech, named by `label`; the value is announced
// only while there is a fraction to announce.

export function ArcProgress({
  got,
  total,
  label = "Downloading",
}: {
  got: number;
  total: number;
  label?: string;
}) {
  const r = 6;
  const c = 2 * Math.PI * r;
  if (total <= 0) {
    return (
      <svg
        width={14}
        height={14}
        viewBox="0 0 16 16"
        className="shrink-0"
        role="progressbar"
        aria-label={label}
      >
        <g className="atlas-arc-spin">
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
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      className="-rotate-90 shrink-0"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(frac * 100)}
    >
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
        className="transition-[stroke-dashoffset] duration-base ease-out-strong"
      />
    </svg>
  );
}
