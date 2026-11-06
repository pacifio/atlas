// The Code tab's "Viewed" boxes over GitHub's own record of them: what the
// host last said, and the reader's presses on top until a read that could
// have seen them comes back. Pure, so the hook (`use-pull-request-files-viewed.ts`)
// is only timing.

import type { PrFilesViewed, PrFileViewedState } from "./pull-requests-types";

export type FileViewedStates = ReadonlyMap<string, PrFileViewedState>;

/** Presses not yet answered for: path → the value pressed. */
export type FileViewedOverlay = ReadonlyMap<string, boolean>;

export const NO_OVERLAY: FileViewedOverlay = new Map();

export function toFileViewedStates(result: PrFilesViewed | undefined): FileViewedStates | null {
  if (!result) return null;
  return new Map(result.files.map((file) => [file.path, file.state]));
}

/** GitHub says `dismissed` for a file marked viewed and changed since: it is
 *  no longer viewed, and the box says "Changed". */
export function isStaleViewedState(state: PrFileViewedState | undefined): boolean {
  return state === "dismissed";
}

export function isFileViewed(
  path: string,
  states: FileViewedStates | null,
  overlay: FileViewedOverlay,
): boolean {
  return overlay.get(path) ?? states?.get(path) === "viewed";
}

/**
 * A press is held until a read that could have seen it comes back, rather
 * than cleared when the write succeeds: that read is a separate round trip,
 * and dropping the press in between flashes the box back.
 */
export function settleFileViewedOverlay(
  overlay: FileViewedOverlay,
  states: FileViewedStates | null,
  pending: ReadonlySet<string>,
  answered: ReadonlySet<string>,
): FileViewedOverlay {
  if (states === null || overlay.size === 0) return overlay;
  const next = new Map(overlay);
  for (const [path, pressed] of overlay) {
    if (pending.has(path)) continue;
    if (answered.has(path) || (states.get(path) === "viewed") === pressed) next.delete(path);
  }
  return next.size === overlay.size ? overlay : next;
}

/**
 * A failed write puts back only the boxes it still answers for (`owned`): a
 * path pressed again since belongs to a later write, and resetting it to the
 * host's answer would take a press out from under the reader's hand.
 */
export function revertFileViewedOverlay(
  overlay: FileViewedOverlay,
  batch: ReadonlyArray<{ path: string; viewed: boolean }>,
  owned: ReadonlySet<string>,
): FileViewedOverlay {
  const next = new Map(overlay);
  for (const { path, viewed } of batch) {
    if (!owned.has(path)) continue;
    if (next.get(path) === viewed) next.delete(path);
  }
  return next.size === overlay.size ? overlay : next;
}

export function toFileViewedBatch(
  overlay: FileViewedOverlay,
): Array<{ path: string; viewed: boolean }> {
  return [...overlay].map(([path, viewed]) => ({ path, viewed }));
}
