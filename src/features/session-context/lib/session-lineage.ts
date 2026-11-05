// The sessions related to this one: the session it was branched from, and the
// sessions branched from it ("Branch from here"). Subagents — the agents it
// delegated to — come from the transcript (`useSubagents`), not from here.
//
// The fork edges are Atlas's own record (`session_forks` in the thread
// store), carried on each history row as `forkedFromSessionId`. One history
// read answers both directions: this row's parent, and every row that names
// this session as its parent. It refreshes on the store's change event, the
// same signal the sidebar listens to.

import { useMemo, useSyncExternalStore } from "react";

import { onThreadsChanged, threadHistory, type ThreadRow } from "@/features/chat/lib/history-api";
import { openThread } from "@/features/chat/lib/open-thread";
import { sidebarAgentOf } from "@/features/chat/lib/sidebar-agents";

export type LineageRelation = "parent" | "fork";

export interface LineageEdge {
  relation: LineageRelation;
  row: ThreadRow;
}

/** The parent first, then the forks newest first. Pure, for the test. */
export function lineageEdges(rows: readonly ThreadRow[], sessionId: string | null): LineageEdge[] {
  if (!sessionId) return [];
  const self = rows.find((r) => r.sessionId === sessionId);
  const parentId = self?.forkedFromSessionId ?? null;
  const parent = parentId ? rows.find((r) => r.sessionId === parentId) : undefined;
  const forks = rows
    .filter((r) => r.forkedFromSessionId === sessionId && r.sessionId !== sessionId)
    .sort((a, b) => (b.createdAt ?? b.updatedAt).localeCompare(a.createdAt ?? a.updatedAt));
  return [
    ...(parent ? [{ relation: "parent" as const, row: parent }] : []),
    ...forks.map((row) => ({ relation: "fork" as const, row })),
  ];
}

// ── One shared history read ──────────────────────────────────────────────────
//
// The overlay reads the history twice while it is open (its lineage and its
// pull requests), and the store's change event fires in bursts: a turn ending
// renames, retitles and links in quick succession. So every reader shares one
// copy of the rows, one listener, and one read per burst — never one full
// history read per reader per event.

/** How long a burst of change events is gathered into one read. */
export const HISTORY_COALESCE_MS = 150;

const NO_ROWS: ThreadRow[] = [];
const history = {
  rows: NO_ROWS,
  readers: new Set<() => void>(),
  unlisten: null as Promise<() => void> | null,
  timer: null as ReturnType<typeof setTimeout> | null,
  loading: false,
  /** A change landed while a read was in flight: read again after it. */
  stale: false,
};

function readHistory(): void {
  if (history.loading) {
    history.stale = true;
    return;
  }
  history.loading = true;
  void threadHistory()
    .then((next) => {
      history.rows = next ?? NO_ROWS;
      for (const notify of history.readers) notify();
    })
    .catch(() => {})
    .finally(() => {
      history.loading = false;
      if (history.stale && history.readers.size > 0) {
        history.stale = false;
        readHistory();
      }
    });
}

function scheduleRead(): void {
  if (history.timer !== null) return;
  history.timer = setTimeout(() => {
    history.timer = null;
    readHistory();
  }, HISTORY_COALESCE_MS);
}

function subscribeHistory(notify: () => void): () => void {
  history.readers.add(notify);
  if (history.readers.size === 1) {
    readHistory();
    history.unlisten = onThreadsChanged(scheduleRead);
  }
  return () => {
    history.readers.delete(notify);
    if (history.readers.size > 0) return;
    void history.unlisten?.then((stop) => stop());
    history.unlisten = null;
    if (history.timer !== null) clearTimeout(history.timer);
    history.timer = null;
    history.stale = false;
  };
}

const noSubscription = () => () => {};

/** The history rows, shared by every reader and re-read (once per burst)
 *  whenever the thread store changes. */
export function useThreadHistory(enabled: boolean): ThreadRow[] {
  return useSyncExternalStore(enabled ? subscribeHistory : noSubscription, () =>
    enabled ? history.rows : NO_ROWS,
  );
}

/** Test seam: forget the shared rows. */
export function resetThreadHistoryForTests(): void {
  history.rows = NO_ROWS;
  history.loading = false;
  history.stale = false;
}

export function useSessionLineage(sessionId: string | null): LineageEdge[] {
  const rows = useThreadHistory(!!sessionId);
  return useMemo(() => lineageEdges(rows, sessionId), [rows, sessionId]);
}

/** Open a related session: its tab if one shows it, else resumed. */
export function openLineageSession(row: ThreadRow, fallbackProjectPath: string): void {
  const cwd = row.folderPaths[0] ?? fallbackProjectPath;
  void openThread({
    threadId: row.threadId,
    sessionId: row.sessionId ?? "",
    title: row.title,
    agent: sidebarAgentOf(row.agentId),
    cwd,
    projectPath: fallbackProjectPath || cwd,
  });
}
