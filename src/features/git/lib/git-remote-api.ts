import { invoke } from "@tauri-apps/api/core";
import type { GitSnapshotWire, PullPreference } from "../stores/git-store";

/** What a plain `git pull` would do on a diverged branch in `path`, given its
 *  git config (`git_pull_preference`). An unanswered read (an older backend,
 *  the browser mock) falls back to `ask`. */
export async function pullPreference(path: string): Promise<PullPreference> {
  return (await invoke<PullPreference | null>("git_pull_preference", { path })) ?? "ask";
}

/** Whether the current branch in `path` has diverged from its upstream right
 *  now (one `git_snapshot`). False when unreadable or not a repository. */
export async function isDiverged(path: string): Promise<boolean> {
  const snap = await invoke<GitSnapshotWire | null>("git_snapshot", { path });
  return !!snap?.isRepo && snap.ahead > 0 && snap.behind > 0;
}

/** What a branch switch in `path` would disturb: the branch it is on, and
 *  whether its working tree has anything uncommitted (untracked files
 *  included). `null` when it is not a repository or cannot be read. */
export async function checkoutState(
  path: string,
): Promise<{ branch: string; dirty: boolean } | null> {
  const snap = await invoke<GitSnapshotWire | null>("git_snapshot", { path }).catch(() => null);
  if (!snap?.isRepo) return null;
  return { branch: snap.branch, dirty: snap.files.length > 0 };
}

/** Check out `branch` in `path`. Rejects with git's refusal. */
export async function checkoutBranch(path: string, branch: string): Promise<void> {
  await invoke("git_checkout", { path, branch });
}

/** Switch `path` to `branch` only if its working tree is clean, untracked
 *  files included: Rust checks and switches in one go, so nothing can dirty
 *  the tree in between. Rejects with a `GitErrorPayload` — code
 *  `uncommitted-changes` for a dirty tree, which is left alone. */
export async function switchBranchIfClean(path: string, branch: string): Promise<void> {
  await invoke("git_switch_if_clean", { path, branch });
}

/** Fetch `path`'s remotes now. A success resets the auto-fetch backoff and
 *  emits `atlas:git-autofetch`, which resolves an auto-fetch warning. Rejects
 *  with the `GitErrorPayload` on failure. */
export async function fetchRemote(path: string): Promise<void> {
  await invoke("git_fetch", { path, opId: null });
}
