/**
 * A stable colour per Project, so the same repository keeps the same dot on
 * every row, every day, without anyone assigning it.
 *
 * A hue here is an IDENTITY, not a status: it says "this is atlas-mobile",
 * never "this went well". The status inks (success / warning / error) are a
 * different vocabulary and must not be borrowed for identity — a Project that
 * happened to hash to red would read as a failing one.
 *
 * The palette is the theme's five chart colours rather than a new `--hue-*`
 * family. Those are already themeable, already chosen to be told apart at a
 * glance, and adding eight more keys would mean regenerating the theme
 * registry, the Rust mirror, the schema and the docs to spell a dot.
 */

/** The identity palette, as Tailwind colour classes. */
const HUES = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"] as const;

/**
 * The hue for an arbitrary key. A plain FNV-style string hash — the point is
 * only that it is stable and spreads, not that it is cryptographic.
 */
export function hueFor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return HUES[hash % HUES.length]!;
}
