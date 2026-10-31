// The Commit row's decisions, pure so each is a table test:
//
//  - `resolveQuickAction`: the one action the row's main button offers, read
//    top to bottom. Busy beats everything, then "is there a branch", then
//    uncommitted changes, then the upstream, divergence, behind, ahead, and
//    finally "nothing to push, open a pull request".
//  - `buildMenuItems`: the ▾ menu (Commit, Push, Create PR), each with the
//    reason it is off when it is.
//  - `requiresDefaultBranchConfirmation` and its copy: pushing to the default
//    branch asks first, offering a feature branch instead.
//
// A pull request is offered from a branch only while it has none open, and
// the default branch is never offered one by the main button: it is what a
// pull request merges into.

export type GitAction = "commit" | "push" | "create_pr" | "commit_push" | "commit_push_pr";

export interface GitActionInput {
  busy: boolean;
  /** `null` on a detached HEAD. */
  branch: string | null;
  /** Uncommitted changes, staged or not, untracked included. */
  dirty: boolean;
  hasUpstream: boolean;
  /** The repository has a remote to push to. */
  hasRemote: boolean;
  isDefault: boolean;
  ahead: number;
  behind: number;
  /** Commits the default branch does not have; `null` without one. */
  aheadOfDefault: number | null;
  hasOpenPr: boolean;
}

export type QuickActionIcon = "commit" | "push" | "pull" | "pr" | "info";

export type QuickAction =
  | { kind: "run"; action: GitAction; label: string; icon: QuickActionIcon }
  | { kind: "pull"; label: string; icon: QuickActionIcon }
  | { kind: "hint"; label: string; hint: string; icon: QuickActionIcon };

const hint = (label: string, text: string, icon: QuickActionIcon = "commit"): QuickAction => ({
  kind: "hint",
  label,
  hint: text,
  icon,
});

const run = (action: GitAction, label: string, icon: QuickActionIcon): QuickAction => ({
  kind: "run",
  action,
  label,
  icon,
});

/** Commits a push would send: past the upstream, or with no upstream yet,
 *  past the default branch. */
export function commitsToPush(input: GitActionInput): number {
  return input.hasUpstream ? input.ahead : (input.aheadOfDefault ?? 0);
}

export function resolveQuickAction(input: GitActionInput): QuickAction {
  if (input.busy) return hint("Commit", "A git action is in progress.");
  if (!input.branch) {
    return hint("Commit", "Check out a branch before committing or pushing.");
  }
  // Whether a pull request is already settled for this branch: it has one,
  // or it is the branch pull requests merge into.
  const prSettled = input.hasOpenPr || input.isDefault;
  if (input.dirty) {
    if (!input.hasUpstream && !input.hasRemote) return run("commit", "Commit", "commit");
    return prSettled
      ? run("commit_push", "Commit & push", "push")
      : run("commit_push_pr", "Commit, push & PR", "pr");
  }
  if (!input.hasUpstream) {
    if (!input.hasRemote) {
      return hint("Push", "This repository has no remote to push to.", "push");
    }
    if (commitsToPush(input) === 0) {
      return hint(prSettled ? "Push" : "Create PR", "No local commits to push.", "push");
    }
    return prSettled ? run("push", "Push", "push") : run("create_pr", "Push & create PR", "pr");
  }
  if (input.ahead > 0 && input.behind > 0) {
    return hint(
      "Sync branch",
      "The branch has diverged from its upstream. Rebase or merge first.",
      "info",
    );
  }
  if (input.behind > 0) return { kind: "pull", label: "Pull", icon: "pull" };
  if (input.ahead > 0) {
    return prSettled ? run("push", "Push", "push") : run("create_pr", "Push & create PR", "pr");
  }
  if (!prSettled && (input.aheadOfDefault ?? 0) > 0) return run("create_pr", "Create PR", "pr");
  return hint("Commit", "Up to date. There is nothing to commit or push.");
}

export interface GitMenuItem {
  action: "commit" | "push" | "create_pr";
  label: string;
  /** Why it is off; `null` when it can run. */
  disabledReason: string | null;
}

export function buildMenuItems(input: GitActionInput): GitMenuItem[] {
  const busy = input.busy ? "A git action is in progress." : null;
  const detached = input.branch ? null : "Check out a branch first.";
  const commit: GitMenuItem = {
    action: "commit",
    label: "Commit",
    disabledReason: busy ?? (input.dirty ? null : "The working tree is clean."),
  };
  if (!input.hasRemote) return [commit];

  const pending = commitsToPush(input);
  const push: GitMenuItem = {
    action: "push",
    label: "Push",
    disabledReason:
      busy ??
      detached ??
      (input.behind > 0
        ? "The branch is behind its upstream. Pull first."
        : pending > 0
          ? null
          : input.dirty
            ? "Commit or stash local changes before pushing."
            : "No local commits to push."),
  };
  if (input.hasOpenPr) return [commit, push];

  const prCommits = input.aheadOfDefault ?? input.ahead;
  const createPr: GitMenuItem = {
    action: "create_pr",
    label: "Create PR",
    disabledReason:
      busy ??
      detached ??
      (input.behind > 0
        ? "The branch is behind its upstream. Pull first."
        : prCommits > 0
          ? null
          : "No local commits to include in a pull request."),
  };
  return [commit, push, createPr];
}

/** Whether running `action` on this branch asks first: it would push to the
 *  default branch, or open a pull request from it. */
export function requiresDefaultBranchConfirmation(action: GitAction, isDefault: boolean): boolean {
  return isDefault && action !== "commit";
}

export interface DefaultBranchCopy {
  title: string;
  description: string;
  /** The button that carries on on the default branch; `null` when that
   *  makes no sense (a pull request needs a branch of its own). */
  continueLabel: string | null;
}

export function defaultBranchCopy(action: GitAction, branch: string): DefaultBranchCopy {
  const pr = action === "create_pr" || action === "commit_push_pr";
  const commit = action === "commit_push" || action === "commit_push_pr";
  if (pr) {
    return {
      title: commit
        ? "Commit, push & create PR from the default branch?"
        : "Create a PR from the default branch?",
      description: `"${branch}" is the branch pull requests merge into. Move the work onto a new branch and open the pull request from there.`,
      continueLabel: null,
    };
  }
  return {
    title: commit ? "Commit & push to the default branch?" : "Push to the default branch?",
    description: `This ${commit ? "commits and pushes your changes" : "pushes local commits"} straight to "${branch}". You can do that, or move the work onto a new branch first.`,
    continueLabel: commit ? `Commit & push to ${branch}` : `Push to ${branch}`,
  };
}

/** Why "Check out a feature branch & continue" is off: the branch carries
 *  the uncommitted changes over, so with none there is nothing to move. */
export function featureBranchUnavailableReason(dirty: boolean): string | null {
  return dirty ? null : "There are no uncommitted changes to move onto a new branch.";
}

/** The pull request action an action ends in, for the stacked runner. */
export function actionSteps(action: GitAction): {
  commit: boolean;
  push: boolean;
  pr: boolean;
} {
  return {
    commit: action === "commit" || action === "commit_push" || action === "commit_push_pr",
    push: action !== "commit",
    pr: action === "create_pr" || action === "commit_push_pr",
  };
}

/**
 * A new branch's name: `atlas/` and the commit summary as a slug, else
 * `atlas/changes`, with `-2`, `-3` … until it is free. Compared without case,
 * as a case-insensitive filesystem would.
 */
export function featureBranchName(summary: string, existing: readonly string[]): string {
  const slug = summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  const base = `atlas/${slug || "changes"}`;
  const taken = new Set(existing.map((b) => b.toLowerCase()));
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base}-${n}`;
  return name;
}
