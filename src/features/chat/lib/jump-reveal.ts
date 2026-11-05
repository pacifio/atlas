// Where a jump's target row is in the projection — or which fold hides it.
//
// A comment can hang off a row the projection has folded away: a tool call
// inside a collapsed run ("Read 3 files…"), or anything inside a settled turn's
// "Worked" section. Landing on the fold's header and stopping there left the
// thread unopenable — the row's comment button is not mounted until the fold
// is. The transcript asks this one fold at a time (the turn first, then the
// run inside it), re-projecting in between, until the row is shown.

import { RowKind, type Row } from "./turn-rows";

export type RevealStep =
  /** On screen: `rowId` is the `data-row-id` to land on — the row itself, or
   *  the open run that draws it (embedded markers carry no row id). */
  | { kind: "shown"; rowId: string }
  /** Hidden: open the fold `foldId`, re-project, and ask again. */
  | { kind: "open"; foldId: string }
  /** Not in this thread at all. */
  | { kind: "missing" };

/**
 * @param target  The row the jump is for (`u:` / `p:` / `th:` / `mk:` id).
 * @param workFoldId  The `wk:<turnId>` header of the turn holding it, when
 *   known — the outer fold, which hides the run and every other row of the
 *   turn but its answer.
 */
export function revealStep(
  rows: readonly Row[],
  target: string,
  workFoldId: string | undefined,
): RevealStep {
  for (const row of rows) {
    if (row.id === target) return { kind: "shown", rowId: row.id };
    if (row.kind === RowKind.MarkerGroup && row.markers.some((m) => m.id === target)) {
      return row.open ? { kind: "shown", rowId: row.id } : { kind: "open", foldId: row.id };
    }
  }
  if (workFoldId) {
    const header = rows.find((r) => r.id === workFoldId);
    if (header?.kind === RowKind.WorkHeader && header.foldable && !header.open) {
      return { kind: "open", foldId: workFoldId };
    }
  }
  return { kind: "missing" };
}
