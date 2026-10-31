// The sidebar's data: every session in the organisation's projects, sorted
// into sections, and which of them a live tab is running.
//
// History is Rust's (ADR-0001), read through one unscoped `threads_projects`
// query. Nothing polls: the store's change event says when to re-read. The
// live half is read off the chat store through a narrow signature — tab,
// session and status only — so a streaming chunk (which rewrites messages,
// never a status) re-renders nothing here.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { isBusyAgentStatus } from "@/types/agent";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useAppStore } from "@/features/app/stores/app-store";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { useActiveOrgProjects } from "@/features/projects/lib/org-scope";
import { invalidatePullRequestQueries } from "@/features/pull-requests/lib/pull-requests-queries";
import { syncSessionPullRequests } from "@/features/pull-requests/lib/session-pull-requests-api";
import {
  onThreadsChanged,
  syncProjectThreads,
  threadProjects,
} from "@/features/chat/lib/history-api";
import {
  nextSnoozeWake,
  partitionSidebarSessions,
  resolveScopeProjectId,
  type SidebarPartition,
  type SidebarProject,
} from "../lib/sidebar-sessions";
import type { SessionLiveStatus } from "../lib/session-row-status";
import { useSidebarStore } from "../stores/sidebar-store";

/** One key for every history list: the change event invalidates the prefix. */
export const THREAD_PROJECTS_KEY = ["thread-projects"] as const;

export interface LiveSession {
  status: Exclude<SessionLiveStatus, null>;
  tabId: string;
}

const EMPTY_PARTITION: SidebarPartition = { pinned: [], active: [], snoozed: [], settled: [] };

/** Every chat tab's live state, keyed by its session id. Re-computed only when
 *  a tab's session or status changes. */
export function useLiveSessions(): ReadonlyMap<string, LiveSession> {
  const signature = useChatStore((s) => {
    let sig = "";
    for (const tabId in s.sessions) {
      const session = s.sessions[tabId]!;
      if (!session.acpSessionId) continue;
      sig += `${tabId}|${session.acpSessionId}|${session.status}|${session.workingDirectory ?? ""}\n`;
    }
    return sig;
  });
  return useMemo(() => {
    const map = new Map<string, LiveSession>();
    for (const line of signature.split("\n")) {
      if (!line) continue;
      const [tabId, sessionId, status] = line.split("|") as [string, string, string];
      if (isBusyAgentStatus(status)) {
        map.set(sessionId, { status: status === "waiting" ? "waiting" : "running", tabId });
      } else if (status === "error") {
        map.set(sessionId, { status: "error", tabId });
      }
    }
    return map;
  }, [signature]);
}

/** The session the window is looking at: the active tab's, when it is a chat. */
export function useActiveSessionId(): string | null {
  const activeTabId = useLayoutStore((s) => s.activeTabId);
  return useChatStore((s) =>
    activeTabId ? (s.sessions[activeTabId]?.acpSessionId ?? null) : null,
  );
}

/** How often the linked pull requests are swept while the window is visible.
 *  Rust decides which are due (open ones every pass, quiet and closed ones
 *  less often, merged never) and holds back after a rate limit. */
const PULL_REQUEST_SWEEP_MS = 60_000;

interface SweptSession {
  threadId: string;
  sessionId: string;
}

/**
 * Keep the listed sessions' linked pull requests current: a sweep every
 * minute while the window is visible, and at once when it is focused.
 * Returns the forced sweep of one session, for a turn that just ended. A
 * sweep's changes arrive as `atlas:threads-changed`, which re-reads the list;
 * its errors (no `gh`, a rate limit) are the gh gate's to hold, and nothing
 * here shows them.
 */
function useSweepSessionPullRequests(
  sessions: readonly SweptSession[],
): (sessionId: string) => void {
  const latest = useRef<readonly SweptSession[]>(sessions);
  useEffect(() => {
    latest.current = sessions;
  }, [sessions]);
  useEffect(() => {
    const sweep = () => {
      const ids = latest.current.map((s) => s.threadId);
      if (document.visibilityState !== "visible" || ids.length === 0) return;
      void syncSessionPullRequests(ids).catch(() => {});
    };
    // The first pass waits for the list to settle after mount.
    const first = window.setTimeout(sweep, 1_500);
    const id = window.setInterval(sweep, PULL_REQUEST_SWEEP_MS);
    window.addEventListener("focus", sweep);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
      window.removeEventListener("focus", sweep);
    };
  }, []);
  return useCallback((sessionId: string) => {
    const threadId = latest.current.find((s) => s.sessionId === sessionId)?.threadId;
    if (!threadId || document.visibilityState !== "visible") return;
    void syncSessionPullRequests([threadId], true).catch(() => {});
  }, []);
}

/** A turn that just ended may have pushed a branch or opened a PR: hand its
 *  session to `onEnded`, and refresh any pull-request surface reads open for
 *  its repository. */
function useRefreshPullRequestsOnTurnEnd(onEnded: (sessionId: string) => void): void {
  const queryClient = useQueryClient();
  const busy = useChatStore((s) => {
    let sig = "";
    for (const tabId in s.sessions) {
      const session = s.sessions[tabId]!;
      if (isBusyAgentStatus(session.status)) {
        sig += `${tabId}|${session.acpSessionId ?? ""}|${session.workingDirectory ?? ""}\n`;
      }
    }
    return sig;
  });
  const previous = useRef("");
  useEffect(() => {
    const now = new Set(busy.split("\n").filter(Boolean));
    for (const line of previous.current.split("\n")) {
      if (!line || now.has(line)) continue;
      const [, sessionId = "", dir = ""] = line.split("|");
      if (sessionId) onEnded(sessionId);
      if (dir) void invalidatePullRequestQueries(queryClient, dir);
    }
    previous.current = busy;
  }, [busy, queryClient, onEnded]);
}

export interface SidebarSessions {
  partition: SidebarPartition;
  projects: SidebarProject[];
  scopeProjectId: string | null;
  isLoading: boolean;
  error: string | null;
}

export function useSidebarSessions(): SidebarSessions {
  const queryClient = useQueryClient();
  const orgProjects = useActiveOrgProjects();
  const projects = useMemo<SidebarProject[]>(
    () => orgProjects.map((p) => ({ id: p.id, name: p.name, path: p.path })),
    [orgProjects],
  );
  const storedScope = useSidebarStore.use.scopeProjectId();
  const scopeProjectId = resolveScopeProjectId(storedScope, projects);
  const sidebarSort = useSettingsStore((s) => s.settings.sidebarSort);

  const {
    data: groups,
    isLoading,
    error,
  } = useQuery({
    queryKey: [...THREAD_PROJECTS_KEY, "all"],
    queryFn: () => threadProjects(""),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    // A history store that failed to open fails the same way on a retry.
    retry: false,
  });

  useEffect(() => {
    const invalidate = () => void queryClient.invalidateQueries({ queryKey: THREAD_PROJECTS_KEY });
    const unlisten = onThreadsChanged(invalidate);
    window.addEventListener("focus", invalidate);
    return () => {
      void unlisten.then((u) => u());
      window.removeEventListener("focus", invalidate);
    };
  }, [queryClient]);

  // Pick up sessions started outside Atlas (a terminal) for the open project:
  // on open, on a project change, and on focus. The backend debounces per
  // cwd; the change event above refreshes the list when rows land.
  const cwd = useAppStore((s) => s.currentProject?.path ?? "");
  useEffect(() => {
    if (!cwd) return;
    const sync = () => void syncProjectThreads(cwd).catch(() => {});
    sync();
    window.addEventListener("focus", sync);
    return () => window.removeEventListener("focus", sync);
  }, [cwd]);

  // Re-partition when the soonest snooze ends, in case Rust's wake event is
  // late: the clock is state, moved only by that one timer.
  const [now, setNow] = useState(() => Date.now());
  const wakeAt = useMemo(() => (groups ? nextSnoozeWake(groups, now) : null), [groups, now]);
  useEffect(() => {
    if (wakeAt === null) return;
    const id = window.setTimeout(
      () => setNow(Date.now()),
      Math.min(Math.max(0, wakeAt - Date.now()) + 50, 2_147_483_647),
    );
    return () => window.clearTimeout(id);
  }, [wakeAt]);

  const partition = useMemo(
    () =>
      groups
        ? partitionSidebarSessions({
            groups,
            projects,
            scopeProjectId,
            now: Date.now(),
            sort: sidebarSort,
          })
        : EMPTY_PARTITION,
    // `now` re-runs the sort when a snooze ends.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [groups, projects, scopeProjectId, sidebarSort, now],
  );

  // The listed sessions that are not settled: what the sweep keeps current.
  const swept = useMemo(
    () => [...partition.pinned, ...partition.active, ...partition.snoozed],
    [partition],
  );
  const sweepNow = useSweepSessionPullRequests(swept);
  useRefreshPullRequestsOnTurnEnd(sweepNow);

  return {
    partition,
    projects,
    scopeProjectId,
    isLoading,
    error: error ? (error instanceof Error ? error.message : String(error)) : null,
  };
}
