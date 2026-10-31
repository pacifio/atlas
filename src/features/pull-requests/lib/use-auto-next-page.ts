// Reading an infinite query's next page on its own while the reader wants
// it (the end of a list in view, a commit not found yet), and never again
// on its own once a page has failed.
//
// The failure gate is the point: `isFetchingNextPage` flips back when a page
// fails, which re-fires an effect keyed on it, so without the gate a failed
// page is asked for again as fast as it fails, spending the gh quota. The
// caller offers a Retry that calls `fetchNextPage` itself.

import { useEffect } from "react";

export interface NextPageQuery {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  fetchNextPage: () => Promise<unknown>;
  data?: { pages: readonly unknown[] } | undefined;
}

export function useAutoNextPage(query: NextPageQuery, wanted: boolean): void {
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = query;
  const go = wanted && hasNextPage && !isFetchingNextPage && !isFetchNextPageError;
  // The page count is a dependency so a page that lands without changing
  // anything else the caller watches (all of it filtered out, or still not
  // the commit looked for) still looks again.
  const pages = query.data?.pages.length ?? 0;
  useEffect(() => {
    if (go) void fetchNextPage();
  }, [go, pages, fetchNextPage]);
}
