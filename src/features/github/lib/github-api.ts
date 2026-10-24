// Bridge to the native GitHub repository commands (`commands/github.rs`):
// searching GitHub, cloning a repository into a project, and managing the
// clones under `<project>/.atlas/repos`. Rust takes these arguments in
// camelCase and answers in the snake_case shapes of `../types.ts`.

import { invoke } from "@tauri-apps/api/core";

import type { ClonedRepo, GithubRepo, RepoMeta } from "../types";

export function searchGithub(query: string): Promise<GithubRepo[]> {
  return invoke<GithubRepo[]>("search_github", { query });
}

export function cloneGithubRepo(
  projectPath: string,
  cloneUrl: string,
  repoName: string,
  meta: RepoMeta,
): Promise<string> {
  return invoke<string>("clone_github_repo", { projectPath, cloneUrl, repoName, meta });
}

export function listClonedRepos(projectPath: string): Promise<ClonedRepo[]> {
  return invoke<ClonedRepo[]>("list_cloned_repos", { projectPath });
}

/** GitHub's metadata for a clone made before Atlas cached any. */
export function fetchClonedRepoMeta(
  projectPath: string,
  repoName: string,
): Promise<ClonedRepo["meta"]> {
  return invoke<ClonedRepo["meta"]>("fetch_cloned_repo_meta", { projectPath, repoName });
}

export function listRemoteBranches(projectPath: string, repoName: string): Promise<string[]> {
  return invoke<string[]>("list_remote_branches", { projectPath, repoName });
}

export function switchClonedRepoBranch(
  projectPath: string,
  repoName: string,
  branch: string,
): Promise<string> {
  return invoke<string>("switch_cloned_repo_branch", { projectPath, repoName, branch });
}

/** Fetch and fast-forward a clone; answers the branch it is now on. */
export function updateClonedRepo(projectPath: string, repoName: string): Promise<string> {
  return invoke<string>("update_cloned_repo", { projectPath, repoName });
}

export function deleteClonedRepo(projectPath: string, repoName: string): Promise<void> {
  return invoke<void>("delete_cloned_repo", { projectPath, repoName });
}
