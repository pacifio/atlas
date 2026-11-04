/**
 * Reading the Timeline board: the session rows, and the retry that re-fetches
 * the cloud half after it failed.
 */

import { invoke } from "@tauri-apps/api/core";

import type { BoardPage, ProjectFilter } from "../types";

export function readBoard(projects: string[], filter: ProjectFilter | null): Promise<BoardPage> {
  return invoke<BoardPage>("artifacts_board", { projects, filter });
}

/** Resolves true when the cloud sessions loaded this time. */
export function refreshCloudBoard(): Promise<boolean> {
  return invoke<boolean>("artifacts_cloud_refresh");
}
