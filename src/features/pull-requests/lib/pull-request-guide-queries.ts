// The kept guide as a query: read from Atlas's own data (`pr_guide_read`),
// keyed under the pull request so its Refresh reads it again too.

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { parseStoredGuide, type PullRequestGuide } from "./pull-request-guide-types";
import { prGuideRead } from "./pull-requests-api";
import type { PrError } from "./pull-requests-types";

export const guideQueryKey = (cwd: string, number: number) =>
  ["pull-requests", cwd, "pull", number, "guide"] as const;

export function usePrGuide(
  cwd: string,
  repository: string | null,
  number: number,
): UseQueryResult<PullRequestGuide | null, PrError> {
  return useQuery<PullRequestGuide | null, PrError>({
    queryKey: guideQueryKey(cwd, number),
    queryFn: async () => parseStoredGuide(await prGuideRead(repository!, number)),
    enabled: !!repository,
    staleTime: Infinity,
    retry: false,
  });
}
