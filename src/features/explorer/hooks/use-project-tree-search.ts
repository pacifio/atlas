import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { searchProjectFiles } from "@/features/file-picker/lib/file-picker-api";
import { useProjectStore } from "@/features/projects/stores/project-store";

import type { ProjectTreeModel, TreeSnapshot } from "../lib/project-tree-model";
import {
  buildSearchRows,
  collectMatches,
  literalIndexQuery,
  normalizeTreeQuery,
  SEARCH_DEBOUNCE_MS,
  SEARCH_INDEX_LIMIT,
  type TreeSearchState,
} from "../lib/tree-search";

/**
 * The project file tree's search: the field, the debounced ask of the
 * project's file index, and the rows filtered from its answer. Lifted out of
 * `ProjectFileTree` whole; its hooks run in the same order they did there.
 */
export function useProjectTreeSearch({
  model,
  root,
  snapshot,
  showHidden,
}: {
  model: ProjectTreeModel;
  root: string;
  snapshot: TreeSnapshot;
  showHidden: boolean;
}) {
  // ── Search ──────────────────────────────────────────────────────────────
  // The field updates on every keystroke; nothing else does. After a pause
  // the project's file index is asked, and the tree is filtered from its
  // answer plus the listings already loaded (`tree-search.ts`). Until then
  // the tree shows what it showed before, so typing never waits on a filter.
  //
  // The search belongs to the project root, not to this view: it is kept on
  // the root's model, so picking a hit on the Files surface (which hands off
  // to the file's tab) carries the search into that tab's tree.
  const workspaceId = useProjectStore((s) => s.projects.find((p) => p.path === root)?.id ?? null);
  const searchRef = useRef<HTMLInputElement>(null);
  const saved = model.view.search;
  const [query, setQuery] = useState(saved?.query ?? "");
  const [search, setSearch] = useState<TreeSearchState["applied"]>(saved?.applied ?? null);
  /** Folders closed by hand during this search; every other one is open. */
  const [searchCollapsed, setSearchCollapsed] = useState<ReadonlySet<string>>(
    () => saved?.collapsed ?? new Set(),
  );
  useEffect(() => {
    model.view.search = query ? { query, applied: search, collapsed: searchCollapsed } : null;
  }, [model, query, search, searchCollapsed]);
  const searchSeq = useRef(0);
  /** The query of the answer on screen. */
  const appliedRef = useRef(saved?.applied?.query ?? null);
  /** Bumped to ask the index again for the same query (refresh, disk change). */
  const [searchNonce, setSearchNonce] = useState(0);
  useEffect(() => {
    const q = normalizeTreeQuery(query);
    if (!q) {
      searchSeq.current++;
      appliedRef.current = null;
      setSearch(null);
      return;
    }
    const seq = ++searchSeq.current;
    const timer = setTimeout(() => {
      const answer = workspaceId
        ? searchProjectFiles(workspaceId, root, literalIndexQuery(q), SEARCH_INDEX_LIMIT).then(
            (hits) => hits.map((h) => h.rel),
            () => [] as string[],
          )
        : Promise.resolve([] as string[]);
      void answer.then((indexHits) => {
        if (seq !== searchSeq.current) return;
        // A new query starts with every folder open; the same one asked
        // again keeps what the user closed.
        if (appliedRef.current !== q) setSearchCollapsed(new Set());
        appliedRef.current = q;
        setSearch({ query: q, indexHits });
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, root, workspaceId, searchNonce]);
  const searching = search !== null;
  // The listings changed under a search (a file added, deleted, renamed):
  // ask the index again once things settle. Stale hits are already dropped
  // by `collectMatches`; this is what brings new ones in.
  const listingsChanged = useRef(snapshot);
  useEffect(() => {
    if (listingsChanged.current === snapshot) return;
    listingsChanged.current = snapshot;
    if (!searching) return;
    const timer = setTimeout(() => setSearchNonce((n) => n + 1), 300);
    return () => clearTimeout(timer);
  }, [snapshot, searching]);
  const searchResult = useMemo(
    () =>
      search
        ? buildSearchRows(
            collectMatches(model.listingMap(), search.indexHits, search.query, showHidden),
            searchCollapsed,
          )
        : null,
    // `snapshot` stands for the listings: a folder that loads or changes
    // during a search is searched too.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [model, search, searchCollapsed, showHidden, snapshot],
  );
  const rows = searchResult ? searchResult.rows : snapshot.rows;
  const clearSearch = useCallback(() => {
    setQuery("");
    searchSeq.current++;
    setSearch(null);
    setSearchCollapsed(new Set());
  }, []);

  return {
    saved,
    searchRef,
    query,
    setQuery,
    search,
    searchCollapsed,
    setSearchCollapsed,
    setSearchNonce,
    searching,
    searchResult,
    rows,
    clearSearch,
  };
}
