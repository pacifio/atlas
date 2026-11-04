// The header search: its results across every list, the arrow-key
// highlight, and Enter to open. The query itself lives in the sidebar store.

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { searchSidebarSessions, type SidebarSession } from "../lib/sidebar-sessions";
import { openSession } from "../lib/sidebar-actions";
import { useSidebarStore } from "../stores/sidebar-store";
import { searchResultId } from "../components/sidebar-session-header";

export function useSessionSearch(lists: {
  pinned: readonly SidebarSession[];
  active: readonly SidebarSession[];
  snoozed: readonly SidebarSession[];
  settled: readonly SidebarSession[];
}) {
  const { pinned, active, snoozed, settled } = lists;
  const search = useSidebarStore.use.search();
  const searchFocusRequest = useSidebarStore.use.searchFocusRequest();
  const sidebarActions = useSidebarStore.use.actions();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const deferredSearch = useDeferredValue(search);
  const isSearching = search.trim().length > 0;
  const results = useMemo(
    () =>
      isSearching
        ? searchSidebarSessions([...pinned, ...active, ...snoozed, ...settled], deferredSearch)
        : [],
    [isSearching, pinned, active, snoozed, settled, deferredSearch],
  );
  const [activeResultIndex, setActiveResultIndex] = useState(0);
  const resultsRef = useRef(results);
  useLayoutEffect(() => {
    resultsRef.current = results;
  }, [results]);
  useEffect(() => {
    if (searchFocusRequest === 0) return;
    const input = searchInputRef.current;
    input?.focus();
    input?.select();
  }, [searchFocusRequest]);

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const count = resultsRef.current.length;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (count === 0) return;
      setActiveResultIndex((i) => Math.min(i + 1, count - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveResultIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      const session = resultsRef.current[activeResultIndex];
      if (!session) return;
      event.preventDefault();
      openSession(session);
    } else if (event.key === "Escape") {
      if (!useSidebarStore.getState().search) return;
      event.preventDefault();
      event.stopPropagation();
      sidebarActions.setSearch("");
    }
  };

  // Keep the highlighted result in view as the arrows move it.
  useEffect(() => {
    if (!isSearching) return;
    document
      .getElementById(searchResultId(activeResultIndex))
      ?.scrollIntoView({ block: "nearest" });
  }, [activeResultIndex, isSearching]);

  /** The pointer moved over a result: it becomes the highlighted one. */
  const highlight = useCallback((threadId: string) => {
    const i = resultsRef.current.findIndex((row) => row.threadId === threadId);
    if (i !== -1) setActiveResultIndex(i);
  }, []);

  const setQuery = (value: string) => {
    sidebarActions.setSearch(value);
    setActiveResultIndex(0);
  };

  return {
    search,
    isSearching,
    results,
    activeResultIndex,
    searchInputRef,
    onSearchKeyDown,
    highlight,
    setQuery,
  };
}
