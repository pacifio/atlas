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
