// The home view's shape, before the home view's data: search pill, section
// labels, seven avatar+text rows at CommsHome's own geometry. Bars follow the
// house PanelSkeleton (bg-elevated at half opacity, deterministic width
// jitter). The pulse is OPACITY-ONLY, per the atlas-marker-shimmer precedent —
// this renders inside `atlas-vibrant-panel`, where transforms mis-composite.

export function CommsSkeleton() {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      style={{ animation: "atlas-marker-shimmer 1.4s ease-in-out infinite" }}
    >
      {/* Search pill, at the sticky search box's size. */}
      <div className="px-2.5 pb-1 pt-2.5">
        <div className="h-[30px] rounded-lg bg-[var(--bg-elevated)] opacity-50" />
      </div>

      <SectionBar w={72} />
      {[0, 1, 2].map((i) => (
        <Row key={`c${i}`} i={i} glyph />
      ))}

      <SectionBar w={110} />
      {[3, 4, 5, 6].map((i) => (
        <Row key={`d${i}`} i={i} />
      ))}
    </div>
  );
}

function SectionBar({ w }: { w: number }) {
  return (
    <div className="px-3 pb-1.5 pt-3.5">
      <div className="h-[10px] rounded bg-[var(--bg-elevated)] opacity-50" style={{ width: w }} />
    </div>
  );
}

function Row({ i, glyph }: { i: number; glyph?: boolean }) {
  // Deterministic jitter, the PanelSkeleton trick — random widths would
  // reshuffle on every remount and read as flicker.
  const w = 78 + ((i * 37) % 90);
  return (
    <div className="flex items-center gap-2.5 py-[7px] pl-3.5 pr-2.5">
      <div
        className={
          glyph
            ? "h-4 w-4 rounded bg-[var(--bg-elevated)] opacity-50"
            : "h-[26px] w-[26px] shrink-0 rounded-full bg-[var(--bg-elevated)] opacity-50"
        }
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="h-[9px] rounded bg-[var(--bg-elevated)] opacity-50" style={{ width: w }} />
        {!glyph && (
          <div
            className="h-[7px] rounded bg-[var(--bg-elevated)] opacity-35"
            style={{ width: w + 34 }}
          />
        )}
      </div>
    </div>
  );
}
