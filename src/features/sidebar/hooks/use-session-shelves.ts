// Which rows the Snoozed and Settled shelves show. Both are shut by default;
// shut, each still shows what must be seen, so the row the window is looking
// at never vanishes into a closed shelf.

import { useDeferredValue, useMemo, useState } from "react";
import {
  SETTLED_SHELF_FIRST_PAGE,
  SETTLED_SHELF_PAGE,
  searchSidebarSessions,
  type SidebarSession,
} from "../lib/sidebar-sessions";
import type { LiveSession } from "./use-sidebar-sessions";
import { useSidebarStore } from "../stores/sidebar-store";

export function useSessionShelves(input: {
  snoozed: readonly SidebarSession[];
  settled: readonly SidebarSession[];
  activeSessionId: string | null;
  live: ReadonlyMap<string, LiveSession>;
  scopeProjectId: string | null;
}) {
  const { snoozed, settled, activeSessionId, live, scopeProjectId } = input;
  const snoozedExpanded = useSidebarStore.use.snoozedExpanded();
  const settledExpanded = useSidebarStore.use.settledExpanded();
  const settledSearch = useSidebarStore.use.settledSearch();

  // ── The Snoozed shelf ───────────────────────────────────────────────────
  const snoozedRows = useMemo(
    () =>
      snoozedExpanded
        ? snoozed
        : snoozed.filter((row) => row.sessionId !== "" && row.sessionId === activeSessionId),
    [snoozed, snoozedExpanded, activeSessionId],
  );

  // ── The Settled shelf ───────────────────────────────────────────────────
  const [settledLimit, setSettledLimit] = useState(SETTLED_SHELF_FIRST_PAGE);
  const [shelfScope, setShelfScope] = useState(scopeProjectId);
  if (shelfScope !== scopeProjectId) {
    setShelfScope(scopeProjectId);
    setSettledLimit(SETTLED_SHELF_FIRST_PAGE);
  }
  const deferredSettledSearch = useDeferredValue(settledSearch);
  const settledFiltered = useMemo(
    () =>
      deferredSettledSearch.trim()
        ? searchSidebarSessions(settled, deferredSettledSearch)
        : settled,
    [settled, deferredSettledSearch],
  );
  // Collapsed, the shelf still shows what must be seen: the open session,
  // and any that came alive again. Outside activity does not un-settle a
  // session, but it must not be buried behind a shut shelf either.
  const shelfRows = useMemo(() => {
    if (deferredSettledSearch.trim()) return settledFiltered;
    if (settledExpanded) return settledFiltered.slice(0, settledLimit);
    return settledFiltered.filter(
      (row) =>
        (row.sessionId !== "" && row.sessionId === activeSessionId) ||
        row.liveElsewhere ||
        row.heldWorking ||
        live.has(row.sessionId),
    );
  }, [
    deferredSettledSearch,
    settledFiltered,
    settledExpanded,
    settledLimit,
    activeSessionId,
    live,
  ]);
  const hiddenSettledCount =
    settledExpanded && !deferredSettledSearch.trim()
      ? settledFiltered.length - shelfRows.length
      : 0;

  return {
    snoozedExpanded,
    snoozedRows,
    settledExpanded,
    settledSearch,
    shelfRows,
    hiddenSettledCount,
    /** Expanded, a search is typed, and nothing on the shelf matches it. */
    settledNoMatches: settledExpanded && !!deferredSettledSearch.trim() && shelfRows.length === 0,
    showMoreSettled: () => setSettledLimit((n) => n + SETTLED_SHELF_PAGE),
  };
}
