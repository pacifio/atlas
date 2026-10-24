// The card a sidebar row shows on hover: what the session is, where it runs,
// who runs it. Mounted only while open, so its store reads cost nothing for
// the rows that are merely on screen.
//
// Every line is something Atlas has; a line with no data is left out rather
// than shown empty. The model is the row's (Rust records it at each turn
// start); an open tab's current pick wins, being newer. Sharing and the
// comment count come from the open tab's comments controller when there is
// one, and otherwise from one lookup made while the card is open
// (`session-sharing.ts`).

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { CircleAlert, Eye, GitBranch, MessageSquare, Pencil, Users } from "lucide-react";
import { agentMeta } from "@/features/agents/lib/agent-meta";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { useChatCommentsStore } from "@/features/chat/stores/chat-comments-store";
import { AGENT_TYPE_BY_SIDEBAR } from "@/features/chat/lib/sidebar-agents";
import { cn } from "@/lib/utils";
import type { SidebarSession } from "../lib/sidebar-sessions";
import type { SessionRowStatus } from "../lib/session-row-status";
import { useClosedSessionSharing } from "../lib/session-sharing";
import { ProjectBadge, SessionAgentIcon } from "./session-row-parts";
import { SessionPullRequestLines } from "./session-pull-request";

/** The tab showing `sessionId`, as a selector-friendly primitive. */
function useTabForSession(sessionId: string): string | null {
  return useChatStore((s) => {
    if (!sessionId) return null;
    for (const tabId in s.sessions) {
      if (s.sessions[tabId]!.acpSessionId === sessionId) return tabId;
    }
    return null;
  });
}

function useModelLabel(tabId: string | null): string | null {
  return useChatStore((s) => {
    const session = tabId ? s.sessions[tabId] : undefined;
    const id = session?.acpCurrentModel;
    if (!id) return null;
    const known = session.acpAvailableModels?.find((model) => model.id === id);
    return known?.name ?? id;
  });
}

/** Sharing and comments: the open tab's, when the session is open, else one
 *  lookup. `null` when it is not a shared session. */
function useSharing(session: SidebarSession, tabId: string | null): { comments: number } | null {
  const count = useChatCommentsStore((s) => {
    const tab = tabId ? s.byTab[tabId] : undefined;
    return tab?.target ? tab.commentCount : -1;
  });
  const closed = useClosedSessionSharing(session.projectPath, session.sessionId, tabId === null);
  if (tabId === null) return closed;
  return count < 0 ? null : { comments: count };
}

function SessionHoverCardBody({
  session,
  status,
}: {
  session: SidebarSession;
  status: SessionRowStatus;
}) {
  const tabId = useTabForSession(session.sessionId);
  const model = useModelLabel(tabId) ?? session.model;
  const sharing = useSharing(session, tabId);
  const agentLabel = agentMeta(AGENT_TYPE_BY_SIDEBAR[session.agent] ?? session.agent).label;
  return (
    <div className="flex min-w-0 max-w-80 flex-col gap-2 px-1 py-2">
      <div className="min-w-0 truncate text-xs leading-tight font-medium text-foreground">
        {session.title}
      </div>
      <div className="grid gap-1.5 pl-0.5 text-xs text-muted-foreground">
        <div className="flex min-w-0 items-center gap-2">
          <ProjectBadge name={session.projectName} className="size-3 text-3xs" />
          <div className="min-w-0 truncate text-secondary-foreground">{session.projectName}</div>
        </div>
        {session.attachedProjects.map((project) => (
          <div key={project.path} className="flex min-w-0 items-center gap-2" title={project.path}>
            {project.access === "read_write" ? (
              <Pencil aria-label="Read and write" className="size-3 shrink-0" />
            ) : (
              <Eye aria-label="Read only" className="size-3 shrink-0" />
            )}
            <div className="min-w-0 truncate text-secondary-foreground">{project.displayName}</div>
            <div className="shrink-0">
              {project.access === "read_write" ? "read & write" : "read only"}
            </div>
          </div>
        ))}
        <div className="flex min-w-0 items-center gap-2">
          <SessionAgentIcon agent={session.agent} className="grayscale opacity-60" />
          <div className="min-w-0 truncate text-secondary-foreground">
            {model ? `${model} · ${agentLabel}` : agentLabel}
          </div>
        </div>
        {session.branch ? (
          <div className="flex min-w-0 items-center gap-2">
            <GitBranch aria-hidden className="size-3 shrink-0" />
            <div className="min-w-0 truncate text-secondary-foreground">{session.branch}</div>
          </div>
        ) : null}
        <SessionPullRequestLines session={session} />
        {sharing ? (
          <div className="flex min-w-0 items-center gap-2">
            <Users aria-hidden className="size-3 shrink-0" />
            <div className="min-w-0 truncate text-secondary-foreground">Shared with the team</div>
          </div>
        ) : null}
        {sharing && sharing.comments > 0 ? (
          <div className="flex min-w-0 items-center gap-2">
            <MessageSquare aria-hidden className="size-3 shrink-0" />
            <div className="min-w-0 truncate text-secondary-foreground">
              {sharing.comments} {sharing.comments === 1 ? "comment" : "comments"}
            </div>
          </div>
        ) : null}
        {session.liveElsewhere ? (
          <div className="flex min-w-0 items-center gap-2 text-info">
            <CircleAlert aria-hidden className="size-3 shrink-0" />
            <div className="min-w-0 truncate">Active in another process</div>
          </div>
        ) : null}
        {status === "failed" ? (
          <div className="flex min-w-0 items-center gap-2 text-error">
            <CircleAlert aria-hidden className="size-3 shrink-0" />
            <div className="min-w-0 truncate">Error occurred</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The card's popup, beside its row. The row is the tooltip's trigger. */
export function SessionHoverCardPopup({
  session,
  status,
}: {
  session: SidebarSession;
  status: SessionRowStatus;
}) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        side="right"
        align="start"
        sideOffset={4}
        className="isolate z-tooltip"
      >
        <TooltipPrimitive.Popup
          className={cn(
            "max-w-80 rounded-lg border border-border-subtle px-2 text-left whitespace-normal",
            "glass-hud backdrop-blur-glass bg-gradient-to-b from-popover/85 to-card/90",
            "origin-[var(--transform-origin)] animate-scale-in",
          )}
        >
          <SessionHoverCardBody session={session} status={status} />
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}
