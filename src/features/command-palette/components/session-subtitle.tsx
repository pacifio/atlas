// A session row's second line in the palette: the project's badge and name,
// where it runs (the project's checkout, or a worktree of it), and the
// agent's mark — "AT atlas · Local · ✳".

import { normalizePath, type SidebarSession } from "@/features/sidebar/lib/sidebar-sessions";
import { ProjectBadge, SessionAgentIcon } from "@/features/sidebar/components/session-row-parts";

function MetaDot() {
  return <span className="shrink-0 text-muted-foreground">·</span>;
}

export function SessionSubtitle({
  session,
  isCurrent,
}: {
  session: Pick<SidebarSession, "projectName" | "projectPath" | "cwd" | "agent">;
  isCurrent: boolean;
}) {
  const inWorktree =
    session.cwd !== "" && normalizePath(session.cwd) !== normalizePath(session.projectPath);
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1 text-xs text-muted-foreground">
      <ProjectBadge name={session.projectName} path={session.projectPath} className="size-3.5" />
      <span className="min-w-0 truncate">{session.projectName}</span>
      <MetaDot />
      <span className="shrink-0">{inWorktree ? "Worktree" : "Local"}</span>
      <MetaDot />
      <SessionAgentIcon agent={session.agent} className="shrink-0" />
      {isCurrent && (
        <>
          <MetaDot />
          <span className="shrink-0">Current session</span>
        </>
      )}
    </span>
  );
}
