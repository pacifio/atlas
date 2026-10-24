// Per-viewer conveniences the pull-request tab remembers across restarts: the
// merge method last picked, and the Summary's comment filter. Browser storage
// only — losing either costs one click — and every access is guarded, since
// storage can be missing or throw.
//
// Also the pull request settings that are read per project
// (`pullRequestMergeMethod`, `removeAgentCreditsOnMerge`): the merge method
// a tab starts on is the setting's, "last" falling back to the stored pick.

import type { AppSettings } from "@/features/settings/lib/app-settings";
import { projectSettingNow } from "@/features/settings/lib/use-scoped-setting";

import type { PrMergeMethod } from "./pull-requests-types";

type PullRequestMergeMethodSetting = AppSettings["pullRequestMergeMethod"];
import type { CommentFilter } from "./pull-request-logic";

const MERGE_METHOD_KEY = "atlas:pull-request:merge-method:v1";
const COMMENT_FILTER_KEY = "atlas:pull-request:comment-filter:v1";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Unavailable: the choice lasts this session only.
  }
}

export function lastMergeMethod(): PrMergeMethod | null {
  const value = read(MERGE_METHOD_KEY);
  return value === "merge" || value === "squash" || value === "rebase" ? value : null;
}

export function rememberMergeMethod(method: PrMergeMethod): void {
  write(MERGE_METHOD_KEY, method);
}

/**
 * The method a pull request's Merge button starts on, from the
 * `pullRequestMergeMethod` setting (per project): the one it names, or for
 * "last" the one last picked on this device. `null` lets the repository's
 * own order decide (`resolveMergeMethod`).
 */
export function preferredMergeMethod(setting: PullRequestMergeMethodSetting): PrMergeMethod | null {
  return setting === "last" ? lastMergeMethod() : setting;
}

/** The project's preferred merge method, read once outside React. */
export function projectMergeMethod(projectPath: string): PrMergeMethod | null {
  return preferredMergeMethod(projectSettingNow(projectPath, "pullRequestMergeMethod"));
}

/** Whether a merge in `projectPath` strips agent credit trailers from its
 *  message (`removeAgentCreditsOnMerge`, per project). For the merge input's
 *  flag; the stripping itself happens where the merge is sent. */
export function removeAgentCreditsOnMerge(projectPath: string): boolean {
  return projectSettingNow(projectPath, "removeAgentCreditsOnMerge");
}

export const DEFAULT_COMMENT_FILTER: CommentFilter = { bots: false, resolved: false };

export function savedCommentFilter(): CommentFilter {
  const raw = read(COMMENT_FILTER_KEY);
  if (!raw) return DEFAULT_COMMENT_FILTER;
  try {
    const parsed = JSON.parse(raw) as Partial<CommentFilter>;
    return { bots: parsed.bots === true, resolved: parsed.resolved === true };
  } catch {
    return DEFAULT_COMMENT_FILTER;
  }
}

export function saveCommentFilter(filter: CommentFilter): void {
  write(COMMENT_FILTER_KEY, JSON.stringify(filter));
}
