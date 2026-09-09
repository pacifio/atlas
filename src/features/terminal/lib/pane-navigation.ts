/**
 * Directional pane navigation over measured rectangles.
 *
 * Candidates are panes whose near edge lies beyond the current pane's far edge
 * in the requested direction AND whose orthogonal span overlaps the current
 * pane's. The nearest wins; ties go to the larger overlap. Pure, so the
 * geometry can be tested without a DOM.
 */
export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type Direction = "left" | "right" | "up" | "down";

export function pickPaneInDirection(
  rects: Record<string, RectLike>,
  from: string,
  dir: Direction,
): string | null {
  const a = rects[from];
  if (!a) return null;
  const aRight = a.left + a.width;
  const aBottom = a.top + a.height;
  let best: { id: string; gap: number; overlap: number } | null = null;
  for (const [id, b] of Object.entries(rects)) {
    if (id === from) continue;
    const bRight = b.left + b.width;
    const bBottom = b.top + b.height;
    let gap: number;
    let overlap: number;
    switch (dir) {
      case "left":
        gap = a.left - bRight;
        overlap = Math.min(aBottom, bBottom) - Math.max(a.top, b.top);
        break;
      case "right":
        gap = b.left - aRight;
        overlap = Math.min(aBottom, bBottom) - Math.max(a.top, b.top);
        break;
      case "up":
        gap = a.top - bBottom;
        overlap = Math.min(aRight, bRight) - Math.max(a.left, b.left);
        break;
      case "down":
        gap = b.top - aBottom;
        overlap = Math.min(aRight, bRight) - Math.max(a.left, b.left);
        break;
    }
    // A hairline separator sits between neighbours; allow a small negative gap.
    if (gap < -2 || overlap <= 0) continue;
    if (!best || gap < best.gap || (gap === best.gap && overlap > best.overlap)) {
      best = { id, gap, overlap };
    }
  }
  return best?.id ?? null;
}
