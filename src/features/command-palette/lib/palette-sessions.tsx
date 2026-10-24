// The sessions the palette lists: the recent ones when the field is empty,
// every one when it searches.
//
// The same history read the sidebar makes (`threads_projects`, one shared
// query key), partitioned the same way — but none of the sidebar hook's side
// effects (its pull-request sweep, its project sync), which the sidebar
// already runs once for the window.

import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";
import { threadProjects } from "@/features/chat/lib/history-api";
import { useActiveOrgProjects } from "@/features/projects/lib/org-scope";
import {
  partitionSidebarSessions,
  type SidebarSession,
} from "@/features/sidebar/lib/sidebar-sessions";
import { THREAD_PROJECTS_KEY } from "@/features/sidebar/hooks/use-sidebar-sessions";
import { openSession } from "@/features/sidebar/lib/sidebar-actions";
import {
  pullRequestSearchTerms,
  pullRequestBadge,
} from "@/features/pull-requests/lib/session-pull-request-links";
import { STATE_PRESENTATION } from "@/features/pull-requests/components/pull-request-presentation";
import { timeAgo } from "@/lib/time-ago";
import { Icon } from "@/ui/icon";
import { SessionSubtitle } from "../components/session-subtitle";
import type { CommandPaletteActionItem } from "./command-palette-logic";

/** Every listed session in the organisation's projects, most recently
 *  active first: pinned and active, then snoozed, then settled. */
export function usePaletteSessions(): SidebarSession[] {
  const orgProjects = useActiveOrgProjects();
  const { data: groups } = useQuery({
    queryKey: [...THREAD_PROJECTS_KEY, "all"],
    queryFn: () => threadProjects(""),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    retry: false,
  });
  return useMemo(() => {
    if (!groups) return [];
    const { pinned, active, snoozed, settled } = partitionSidebarSessions({
      groups,
      projects: orgProjects.map((p) => ({ id: p.id, name: p.name, path: p.path })),
      scopeProjectId: null,
      now: Date.now(),
    });
    const live = [...pinned, ...active].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return [...live, ...snoozed, ...settled];
  }, [groups, orgProjects]);
}

/** A session as a palette row: the title (behind its pull request's glyph),
 *  then project · where · agent, and its age on the right. */
export function buildSessionActionItems(input: {
  sessions: readonly SidebarSession[];
  activeSessionId: string | null;
  limit?: number;
}): CommandPaletteActionItem[] {
  const visible = input.limit === undefined ? input.sessions : input.sessions.slice(0, input.limit);
  return visible.map((session) => {
    const badge = pullRequestBadge(session.pullRequests);
    const PullRequestIcon = badge ? STATE_PRESENTATION[badge.state].Icon : null;
    const updated = Date.parse(session.updatedAt);
    return {
      kind: "action",
      value: `session:${session.threadId}`,
      searchTerms: [
        session.title,
        ...pullRequestSearchTerms(session.pullRequests),
        session.projectName,
        session.branch ?? "",
        session.threadId,
      ],
      title: session.title || "Untitled session",
      description: (
        <SessionSubtitle
          session={session}
          isCurrent={session.sessionId !== "" && session.sessionId === input.activeSessionId}
        />
      ),
      timestamp: timeAgo(session.updatedAt, { suffix: true }),
      searchRecency: Number.isNaN(updated) ? 0 : updated,
      icon: <Icon icon={MessageSquare} size="lg" />,
      ...(PullRequestIcon
        ? {
            titleLeadingContent: (
              <PullRequestIcon
                aria-label="Has a pull request"
                className="size-3.5 shrink-0 text-muted-foreground"
              />
            ),
          }
        : {}),
      run: () => openSession(session),
    };
  });
}
