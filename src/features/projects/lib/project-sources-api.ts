import { invoke } from "@tauri-apps/api/core";

/**
 * IPC seam for the palette's "Add project" sources (Rust
 * `commands::project_sources`): a folder browser, a new project from a name,
 * and a clone from a Git URL or a GitHub `owner/repo`. New and cloned
 * projects go in `~/.atlas/projects`; each call answers the folder, which
 * the caller adds as a project.
 */

/** Whether the GitHub CLI can publish and clone for the user. */
export type GhStatus = "missing" | "signedOut" | "ready";

export interface ProjectSourcesInfo {
  /** Where new and cloned projects go. */
  path: string;
  gh: GhStatus;
  /** The GitHub account `gh` is signed in to, when it is. */
  githubLogin: string | null;
  /** The package manager that can install `gh` here, when `gh` is missing. */
  installer: "brew" | "winget" | null;
}

export interface BrowseListing {
  path: string;
  parent: string | null;
  directories: string[];
}

/** A new project: its folder, and why publishing it failed when it did (the
 *  folder and its repository stand either way). */
export interface CreatedProject {
  path: string;
  warning: string | null;
}

export const projectSources = {
  info: () => invoke<ProjectSourcesInfo>("project_sources_info"),
  browse: (path: string) => invoke<BrowseListing>("project_browse", { path }),
  create: (name: string, githubPrivate: boolean) =>
    invoke<CreatedProject>("project_create", { name, githubPrivate }),
  clone: (url: string, github: boolean) => invoke<string>("project_clone", { url, github }),
};
