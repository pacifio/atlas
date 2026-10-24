// The one git action the overlay offers up front: the split row's main
// button ("Create PR", "Push & create PR", "Pull", …).
//
// The decision table, read top to bottom: busy beats everything, then "is
// there a branch", then local changes, then upstream, then divergence,
// behind, ahead, and finally "nothing to push — open a pull request". Two
// rules shape it:
//
//  * A commit needs the summary the user writes, so "you have changes"
//    opens Source Control on its commit box rather than committing; the label
//    still says where it leads ("Commit, push & PR…").
//  * The default branch is never offered a pull request — it is what a pull
//    request merges into.
//
// Pure, so the whole table is a unit test.

export interface QuickActionInput {
  isRepo: boolean;
  branch: string;
  detached: boolean;
  /** Working-tree entries (staged or not). */
  changedFiles: number;
  /** `null` when the branch tracks nothing. */
  upstream: string | null;
  ahead: number;
  behind: number;
  /** A streaming git op (push, pull, commit hooks) is running. */
  busy: boolean;
  /** The branch already has an open pull request. */
  hasOpenPr: boolean;
  /** The branch is the repository's default (`main`): no PR from it. */
  isDefaultBranch: boolean;
}

export type QuickAction =
  | { kind: "push"; label: string }
  | { kind: "publish"; label: string }
  | { kind: "pull"; label: string }
  | { kind: "create-pr"; label: string }
  | { kind: "open-changes"; label: string }
  | { kind: "hint"; label: string; hint: string };

export function resolveQuickAction(input: QuickActionInput): QuickAction | null {
  if (!input.isRepo) return null;
  if (input.busy) return { kind: "hint", label: "Working…", hint: "A git action is in progress." };
  if (input.detached || !input.branch) {
    return {
      kind: "hint",
      label: "Commit",
      hint: "Check out a branch before pushing or opening a pull request.",
    };
  }
  const prDone = input.hasOpenPr || input.isDefaultBranch;
  if (input.changedFiles > 0) {
    return {
      kind: "open-changes",
      label: prDone ? (input.upstream ? "Commit & push…" : "Commit…") : "Commit, push & PR…",
    };
  }
  if (!input.upstream) {
    if (prDone) return { kind: "publish", label: "Publish branch" };
    // A new branch reaches the remote on the way to its pull request.
    return { kind: "create-pr", label: "Push & create PR" };
  }
  if (input.ahead > 0 && input.behind > 0) {
    return {
      kind: "hint",
      label: "Sync branch",
      hint: "The branch has diverged from its upstream. Rebase or merge first.",
    };
  }
  if (input.behind > 0) return { kind: "pull", label: "Pull" };
  if (input.ahead > 0) {
    return prDone
      ? { kind: "push", label: "Push" }
      : { kind: "create-pr", label: "Push & create PR" };
  }
  if (!prDone) return { kind: "create-pr", label: "Create PR" };
  return { kind: "hint", label: "Push", hint: "Up to date. Nothing to push." };
}
