import type { ReactNode } from "react";

/**
 * The eyebrow over a group of source-control rows (Staged, Changes,
 * Conflicts): sticky on the panel's own surface with a hairline under it, so
 * the group reads as a section of the list rather than a band of another
 * colour.
 */
export function SectionHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="sticky top-0 z-panel flex h-control-md items-center justify-between gap-2 border-b border-border-subtle bg-card pr-1 pl-2">
      <span className="eyebrow tabular-nums">{title}</span>
      {children && <div className="flex shrink-0 items-center gap-0.5">{children}</div>}
    </div>
  );
}
