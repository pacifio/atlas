/**
 * Turning a Highlight-tool drag into the rectangle that gets stored.
 *
 * All geometry is normalized 0..1 of the page (see `pdf-annotation-store`).
 *
 * A highlighter is used the way a highlighter pen is: dragged ALONG a line of
 * text. That drag is wide and almost perfectly flat, and requiring it to also
 * be tall — the old rule — threw every such stroke away, so the tool appeared
 * to do nothing. A flat drag is therefore read as "this line": it takes the
 * vertical extent of the text line under the stroke, or a nominal line band
 * where there is no text (a scanned page has no text layer).
 */

export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One run of text on the page (a text-layer span), normalized. */
export interface LineBand {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Below this, a dimension is a stray tap rather than a drag. */
export const MIN_HIGHLIGHT = 0.005;

/** The band a flat drag gets where no text line is under it: about one line
 *  of 11pt body text on a Letter page, which is the common case. */
export const NOMINAL_LINE_HEIGHT = 0.018;

/** Air above and below the glyph box, as a fraction of the line's height, so
 *  the highlight reads as covering the line rather than clipping it. */
const LINE_PAD = 0.2;

/** A run more than this many times taller than the shortest run under the
 *  stroke is not part of that line — a drop cap, a rotated margin label, a
 *  figure caption set vertically — and must not stretch the band. */
const MAX_RUN_HEIGHT_RATIO = 2;

/**
 * The text line under a flat stroke: every run whose vertical extent holds the
 * stroke's midline AND which the stroke actually crosses horizontally. The
 * horizontal test is what keeps a two-column page honest — the other column's
 * lines sit at different heights, and a stroke over the right column must not
 * take the band of a left-column line that happens to cover the same y. Runs
 * of one line in different fonts (bold, a size change) are unioned.
 */
function lineUnder(drag: NormRect, mid: number, runs: readonly LineBand[]) {
  const left = drag.x;
  const right = drag.x + drag.w;
  const hits = runs.filter(
    (r) => r.top <= mid && mid <= r.bottom && r.left < right && left < r.right,
  );
  if (hits.length === 0) return null;
  const shortest = Math.min(...hits.map((r) => r.bottom - r.top));
  const line = hits.filter((r) => r.bottom - r.top <= shortest * MAX_RUN_HEIGHT_RATIO);
  return {
    top: Math.min(...line.map((r) => r.top)),
    bottom: Math.max(...line.map((r) => r.bottom)),
  };
}

export function highlightRect(drag: NormRect, runs: readonly LineBand[]): NormRect | null {
  if (drag.w <= MIN_HIGHLIGHT) return null;
  // A box drag is taken exactly as drawn.
  if (drag.h > MIN_HIGHLIGHT) return drag;

  const mid = drag.y + drag.h / 2;
  const line = lineUnder(drag, mid, runs);
  let top: number;
  let bottom: number;
  if (line) {
    const pad = (line.bottom - line.top) * LINE_PAD;
    top = line.top - pad;
    bottom = line.bottom + pad;
  } else {
    top = mid - NOMINAL_LINE_HEIGHT / 2;
    bottom = mid + NOMINAL_LINE_HEIGHT / 2;
  }
  top = Math.max(0, top);
  bottom = Math.min(1, bottom);
  return { x: drag.x, y: top, w: drag.w, h: bottom - top };
}
