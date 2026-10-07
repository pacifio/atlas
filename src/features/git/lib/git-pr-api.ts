// Bridge to the native `git_repo_pull_requests` command — a repository's pull
// requests, one per head branch, read through the user's own GitHub CLI
// (`gh`), so private repositories work. Never an error: the result says why
// there is nothing (see `RepoPullRequests`).
//
// One `gh` call per repository, shared by every card in it: the agent sidebar
// mounts all its thread cards at once, and a call per branch was a burst of
// network-bound processes on every open.

import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

export interface BranchPullRequest {
  number: number;
  /** Lowercased from GitHub's `OPEN` / `CLOSED` / `MERGED`. */
  state: "open" | "closed" | "merged";
  title: string;
  /** The PR's page on GitHub. */
  url: string;
  isDraft: boolean;
}

/**
 * - `ok` — `gh` answered; `byBranch` holds the PR worth showing per head
 *   branch (an open one if there is one, else the most recently created).
 * - `unavailable` — `gh` is not installed or not signed in. True of every
 *   repository, so nothing asks again this session.
 * - `failed` — this repository could not be answered for (not a GitHub
 *   remote, offline, timed out).
 */
export type RepoPullRequests =
  | { kind: "ok"; byBranch: Record<string, BranchPullRequest> }
  | { kind: "unavailable" }
  | { kind: "failed" };

export function repoPullRequests(path: string): Promise<RepoPullRequests> {
  return invoke<RepoPullRequests>("git_repo_pull_requests", { path });
}

/** The query key for one repository's PRs — what a turn end invalidates. */
export function repoPullRequestsKey(cwd: string) {
  return ["repo-pull-requests", cwd] as const;
}

/** Set once any repository reports `gh` unavailable; stops every later query. */
let ghUnavailable = false;

/** Test seam: forget that `gh` was found unavailable. */
export function resetGhAvailabilityForTests(): void {
  ghUnavailable = false;
}

async function fetchRepoPullRequests(cwd: string): Promise<RepoPullRequests> {
  if (ghUnavailable) return { kind: "unavailable" };
  const result = await repoPullRequests(cwd);
  if (result.kind === "unavailable") ghUnavailable = true;
  return result;
}

/**
 * The PR for `branch` in the repository at `cwd`, or `null`. Every caller in
 * the same repository shares one query; `enabled: false` (a card not yet on
 * screen) asks nothing.
 */
export function useBranchPullRequest(
  cwd: string,
  branch: string | null,
  enabled: boolean,
): BranchPullRequest | null {
  const select = useCallback(
    (data: RepoPullRequests) =>
      data.kind === "ok" && branch ? (data.byBranch[branch] ?? null) : null,
    [branch],
  );
  const { data } = useQuery({
    queryKey: repoPullRequestsKey(cwd),
    queryFn: () => fetchRepoPullRequests(cwd),
    enabled: enabled && !!cwd && !!branch && !ghUnavailable,
    select,
    // A PR's number does not change; its state does, and a turn end
    // invalidates this key, which is when it is likely to have.
    staleTime: 5 * 60_000,
    retry: false,
  });
  return data ?? null;
}

/** Open a PR's page in the system browser. */
export function openPullRequest(url: string): void {
  void openUrl(url).catch(() => window.open(url, "_blank"));
}
