// A pull request's changed files, as its markdown's file chips need them: the
// paths only, relative to the checkout, for `file-chip-hast.ts` to match what
// the text names against.
//
// Read through `pr_list_stats`, the list's batched stats read: one small
// GraphQL request with up to a hundred file paths, where the Code tab's diff
// would carry every patch. Past a hundred files a name the read did not reach
// is still a chip, resolved against the checkout and opened in Atlas's viewer
// rather than the Code tab. A failed read is the same: no changed files, so
// every chip opens the checkout's file.
//
// The key sits under the pull request's own (`pullRequestKeys.pull`), so the
// panel's refresh, and an agent's turn end, re-read it with everything else.

import { useQuery } from "@tanstack/react-query";

import { prListStats } from "./pull-requests-api";
import { pullRequestKeys, STALE } from "./pull-requests-queries";
import type { PrListStat } from "./pull-requests-types";

export const changedFilesKey = (cwd: string, number: number) =>
  [...pullRequestKeys.pull(cwd, number), "changed-files"] as const;

/** Stable across reads that changed nothing, so the markdown is not re-parsed. */
function pathsOf(stats: PrListStat[] | undefined, number: number): readonly string[] {
  return stats?.find((s) => s.number === number)?.files.map((f) => f.path) ?? [];
}

/**
 * The changed files' paths, or null until they are known. The markdown draws
 * at once without them, then once more when they land.
 */
export function usePullRequestChangedFiles(cwd: string, number: number): readonly string[] | null {
  const query = useQuery<PrListStat[], unknown, readonly string[]>({
    queryKey: changedFilesKey(cwd, number),
    queryFn: () => prListStats(cwd, [number]),
    select: (stats) => pathsOf(stats, number),
    enabled: !!cwd && number > 0,
    staleTime: STALE.diff,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: false,
  });
  return query.data ?? null;
}
