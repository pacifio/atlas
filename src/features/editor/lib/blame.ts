/**
 * What the file view says about a line's last commit: git's relative date,
 * and the coloured runs of "Author, 3 days ago · summary".
 */

import type { BlameLine } from "@/features/git/lib/git-blame-api";

/**
 * git's own relative date (`show_date_relative` in git's `date.c`), the `%cr`
 * that Source Control → History prints for the same commit. Each step rounds
 * to nearest and has git's thresholds; the floor-everything version this
 * replaced put "22 hours ago" on the line and "23 hours ago" in History.
 */
export function relativeTime(ms: number, now = Date.now()): string {
  if (!ms) return "";
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"} ago`;
  let diff = Math.max(0, Math.floor((now - ms) / 1000));
  if (diff < 90) return unit(diff, "second");
  diff = Math.floor((diff + 30) / 60);
  if (diff < 90) return unit(diff, "minute");
  diff = Math.floor((diff + 30) / 60);
  if (diff < 36) return unit(diff, "hour");
  diff = Math.floor((diff + 12) / 24);
  if (diff < 14) return unit(diff, "day");
  if (diff < 70) return unit(Math.floor((diff + 3) / 7), "week");
  if (diff < 365) return unit(Math.floor((diff + 15) / 30), "month");
  if (diff < 1825) {
    const totalMonths = Math.floor((diff * 12 * 2 + 365) / (365 * 2));
    const years = Math.floor(totalMonths / 12);
    const months = totalMonths % 12;
    const y = `${years} year${years === 1 ? "" : "s"}`;
    return months ? `${y}, ${unit(months, "month")}` : `${y} ago`;
  }
  return unit(Math.floor((diff + 183) / 365), "year");
}

/** One coloured run of the attribution. */
export type BlamePart = {
  kind: "author" | "time" | "summary" | "uncommitted" | "sep";
  text: string;
};

/** Each run's colour: syntax keys, so the parts read apart by hue. */
export const BLAME_PART_COLOR: Record<BlamePart["kind"], string> = {
  author: "var(--atlas-syntax-function)",
  time: "var(--atlas-syntax-number)",
  summary: "var(--atlas-syntax-string)",
  uncommitted: "var(--atlas-syntax-keyword)",
  sep: "var(--atlas-syntax-comment)",
};

/** The runs for a line: its commit's, or "You · Uncommitted changes" when git
 *  has none for it (or the line was edited since). */
export function blameParts(line: BlameLine | undefined): BlamePart[] {
  if (!line) {
    return [
      { kind: "author", text: "You" },
      { kind: "sep", text: " · " },
      { kind: "uncommitted", text: "Uncommitted changes" },
    ];
  }
  const when = relativeTime(line.timeMs);
  const parts: BlamePart[] = [{ kind: "author", text: line.author }];
  if (when) parts.push({ kind: "sep", text: ", " }, { kind: "time", text: when });
  parts.push({ kind: "sep", text: " · " }, { kind: "summary", text: line.summary });
  return parts;
}

export const samePartsAs = (a: BlamePart[] | null, b: BlamePart[] | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.length === b.length &&
    a.every((p, i) => p.kind === b[i].kind && p.text === b[i].text));
