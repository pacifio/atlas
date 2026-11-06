/** A split's sizes, keyed by column (group) id, in percent. */
export type SplitLayout = Record<string, number>;

/**
 * The layout a project's centre split mounts with, from the one saved for it.
 *
 * The split saves only what the person dragged (`ResizableSplit` reports a
 * layout when a drag ends, and nothing else). So the saved layout can show a
 * column the surfaces mode now hides: the pane was dragged wide, then hidden,
 * then the app quit. Mounted as saved, that column would paint at its old
 * width for a frame before `ColumnPanel` collapses it. This collapses it up
 * front instead, giving its share to the columns that stay.
 *
 * - Nothing saved, or a layout that is not one (a non-finite size, sizes not
 *   summing to 100, or not exactly these columns): `undefined`, and every
 *   column falls back to its `defaultSize`.
 * - A hidden column saved above 0: set to 0, its share spread over the shown
 *   columns in proportion to their saved sizes (evenly if those are all 0).
 * - Everything else is returned as saved, including the (unreachable) case of
 *   no column shown. A shown column saved at 0 is left to `ColumnPanel`'s
 *   expand, as it always was.
 */
export function initialCenterLayout(
  saved: SplitLayout | undefined,
  columns: readonly { id: string; shown: boolean }[],
): SplitLayout | undefined {
  if (!saved) return undefined;
  const keys = Object.keys(saved);
  if (keys.length !== columns.length || !columns.every((c) => c.id in saved)) return undefined;
  const sizes = columns.map((c) => saved[c.id]);
  if (!sizes.every(Number.isFinite)) return undefined;
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total < 99.5 || total > 100.5) return undefined;

  const freed = columns.reduce((sum, c, i) => (c.shown ? sum : sum + sizes[i]), 0);
  const shown = columns.filter((c) => c.shown);
  if (freed === 0 || shown.length === 0) return saved;

  const shownTotal = shown.reduce((sum, c) => sum + saved[c.id], 0);
  const out: SplitLayout = {};
  for (const c of columns) {
    if (!c.shown) out[c.id] = 0;
    else if (shownTotal === 0) out[c.id] = freed / shown.length;
    else out[c.id] = saved[c.id] + (freed * saved[c.id]) / shownTotal;
  }
  return out;
}
