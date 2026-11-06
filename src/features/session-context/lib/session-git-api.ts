// Git for one session's checkout, by path.
//
// The git store mirrors the ACTIVE project's repository and acts on it; the
// Details card describes a session, whose checkout may be another project's
// or a pull request's worktree. So the card talks to the same Rust commands
// with the session's own path, and never through the store.
//
// The verbs that run hooks or touch the network stream `atlas:git:op` under
// the op id passed here, which is how the Commit row shows their progress.

import { invoke } from "@tauri-apps/api/core";

import type { GitSnapshotWire } from "@/features/git/stores/git-store";

export type SessionGitSnapshot = GitSnapshotWire;

/** Where the branch stands against the default branch (`git_branch_compare`). */
export interface BranchCompare {
  defaultBranch: string | null;
  isDefault: boolean;
  hasRemote: boolean;
  aheadOfDefault: number | null;
  /** Since the branch left the default branch, uncommitted lines included. */
  additions: number;
  deletions: number;
}

export function gitSnapshot(path: string): Promise<SessionGitSnapshot> {
  return invoke<SessionGitSnapshot>("git_snapshot", { path });
}

export function gitBranchCompare(path: string): Promise<BranchCompare> {
  return invoke<BranchCompare>("git_branch_compare", { path });
}

export function newOpId(): string {
  return crypto.randomUUID();
}

export function gitCheckout(path: string, branch: string): Promise<void> {
  return invoke<void>("git_checkout", { path, branch });
}

/** Create `name` at HEAD and switch to it. */
export function gitCreateBranch(path: string, name: string): Promise<void> {
  return invoke<void>("git_create_branch", { path, name });
}

export function gitStage(path: string, files: string[]): Promise<void> {
  return invoke<void>("git_stage", { path, files });
}

export function gitUnstage(path: string, files: string[]): Promise<void> {
  return invoke<void>("git_unstage", { path, files });
}

export function gitCommit(
  path: string,
  summary: string,
  description: string | null,
  opId: string,
): Promise<void> {
  return invoke<void>("git_commit_v2", {
    path,
    summary,
    description,
    amend: false,
    coAuthors: null,
    opId,
  });
}

export function gitPush(path: string, opId: string): Promise<void> {
  return invoke<void>("git_push", {
    path,
    forceWithLease: false,
    followTags: false,
    remote: null,
    opId,
  });
}

/** Push the branch and set its upstream. */
export function gitPublishBranch(path: string, opId: string): Promise<void> {
  return invoke<void>("git_publish_branch", { path, remote: null, opId });
}

export function gitPull(path: string, opId: string): Promise<void> {
  return invoke<void>("git_pull", { path, strategy: "default", remote: null, opId });
}
