// Bridge to the native `git_repo_avatars` command — GitHub's avatar per commit
// author email, read through the user's own GitHub CLI (`gh`). Never an error:
// the result says why there is nothing (see `RepoAvatars`).
//
// One `gh` call per repository, shared by every avatar in it through the query
// cache: the History list and the Git Graph mount dozens at once.

import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";

/**
 * - `ok` — `gh` answered; `byEmail` maps a lowercased author email to the
 *   GitHub avatar URL of the account it belongs to.
 * - `unavailable` — `gh` is not installed or not signed in. True of every
 *   repository, so nothing asks again for a while.
 * - `failed` — this repository could not be answered for (not a GitHub
 *   remote, offline, timed out).
 */
export type RepoAvatars =
  | { kind: "ok"; byEmail: Record<string, string> }
  | { kind: "unavailable" }
  | { kind: "failed" };

export function repoAvatars(path: string): Promise<RepoAvatars> {
  return invoke<RepoAvatars>("git_repo_avatars", { path });
}

/** How long a `gh` found missing or signed out stops every query — long
 *  enough not to spawn a doomed `gh` per repository, short enough that a
 *  `gh auth login` is picked up without restarting Atlas. */
const UNAVAILABLE_FOR_MS = 10 * 60_000;

/** When `gh` was last found unavailable; 0 = not known to be. */
let ghUnavailableAt = 0;

/** Test seam: forget that `gh` was found unavailable. */
export function resetGhAvatarsAvailabilityForTests(): void {
  ghUnavailableAt = 0;
}

export async function fetchRepoAvatars(path: string): Promise<RepoAvatars> {
  if (ghUnavailableAt && Date.now() - ghUnavailableAt < UNAVAILABLE_FOR_MS) {
    return { kind: "unavailable" };
  }
  const result = await repoAvatars(path);
  ghUnavailableAt = result.kind === "unavailable" ? Date.now() : 0;
  return result;
}

/** GitHub's avatar per author email for the repository at `repoPath`. */
export function useGithubAvatars(repoPath: string): Record<string, string> | undefined {
  const { data } = useQuery({
    queryKey: ["repo-avatars", repoPath],
    queryFn: () => fetchRepoAvatars(repoPath),
    enabled: !!repoPath,
    // Avatars change rarely; new authors show up on the next window. A miss
    // is asked again after the back-off, so a `gh auth login` lands in time.
    staleTime: (query) => (query.state.data?.kind === "ok" ? 30 * 60_000 : UNAVAILABLE_FOR_MS),
    retry: false,
  });
  return data?.kind === "ok" ? data.byEmail : undefined;
}
