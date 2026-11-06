import type { InProgress } from "../stores/git-store";

export type InProgressKind = "merge" | "rebase" | "cherry-pick" | "revert";

/** The operation git is in the middle of, checked in this order; null when
 *  none. One copy, so the Changes banner, the history actions, the branch
 *  switcher and the merge dialog all name the same operation. */
export function inProgressLabel(ip: InProgress | null | undefined): InProgressKind | null {
  if (!ip) return null;
  if (ip.merge) return "merge";
  if (ip.rebase) return "rebase";
  if (ip.cherryPick) return "cherry-pick";
  if (ip.revert) return "revert";
  return null;
}

/** Tooltip for a control that is blocked while an operation is in progress. */
export function blockedByOperation(kind: InProgressKind): string {
  return `Finish the ${kind} in progress first`;
}
