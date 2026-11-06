import { Skeleton } from "@tryatlas/design";

// The home view's shape, before the home view's data: search pill, section
// labels, seven avatar+text rows at CommsHome's own geometry, on the package
// `Skeleton` (muted fill, deterministic width jitter). The pulse is
// OPACITY-ONLY (`animate-pulse`) — this renders inside `atlas-vibrant-panel`,
// where transforms mis-composite. Rounded shapes clip the bar in a wrapper so
// the primitive keeps its own look.

export function CommsSkeleton() {
  return (
    <div data-view="comms-skeleton" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Search pill, at the sticky search box's size. */}
      <div className="px-2.5 pb-1 pt-2.5">
        <span className="block h-[30px] overflow-hidden rounded-lg">
          <Skeleton className="size-full" />
        </span>
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
      <Skeleton className="h-[10px]" style={{ width: w }} />
    </div>
  );
}

function Row({ i, glyph }: { i: number; glyph?: boolean }) {
  // Deterministic jitter, the PanelSkeleton trick — random widths would
  // reshuffle on every remount and read as flicker.
  const w = 78 + ((i * 37) % 90);
  return (
    <div className="flex items-center gap-2.5 py-[7px] pl-3.5 pr-2.5">
      {glyph ? (
        <Skeleton className="size-4 shrink-0" />
      ) : (
        <span className="size-[26px] shrink-0 overflow-hidden rounded-full">
          <Skeleton className="size-full" />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Skeleton className="h-[9px]" style={{ width: w }} />
        {!glyph && <Skeleton className="h-[7px]" style={{ width: w + 34 }} />}
      </div>
    </div>
  );
}
