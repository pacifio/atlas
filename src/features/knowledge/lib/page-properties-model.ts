// The page-properties strip's pure half: the presets, the collapsed summary
// line and the date format. No React, no store.

export const STATUS_PRESETS = ["Draft", "RFC", "Published", "Archived"] as const;

/** What the strip may change. Structurally assignable to the meta store's
 *  patch, which a view may not import. `null` clears a field. */
export type PagePropertiesPatch = {
  status?: string | null;
  owner?: string | null;
  tags?: string[];
};

export interface PagePropertiesMeta {
  status: string | null;
  owner: string | null;
  tags: string[];
  createdAt: string | null;
  updatedAt: string | null;
}

/** The one-line summary the collapsed strip shows: `status · @owner · #tag +n`,
 *  or the placeholder when nothing is set. */
export function propertiesSummary({
  status,
  owner,
  tags,
}: Pick<PagePropertiesMeta, "status" | "owner" | "tags">): string {
  const parts: string[] = [];
  if (status) parts.push(status);
  if (owner) parts.push(`@${owner}`);
  if (tags.length > 0) parts.push(`#${tags[0]}${tags.length > 1 ? ` +${tags.length - 1}` : ""}`);
  return parts.length > 0 ? parts.join(" · ") : "Add status, owner, tags…";
}

/** "Mar 4", or "Mar 4, 2025" when the year isn't `now`'s. `null` for an
 *  empty or unparseable date. */
export function formatPageDate(iso: string | null | undefined, now: Date): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
}
