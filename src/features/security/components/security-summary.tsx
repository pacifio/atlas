import { useEffect } from "react";
import { summarize } from "../lib/security-levels";
import { selectCheckpoints, useSecurityStore } from "../stores/security-store";
import { SecurityLevelBadge } from "./session-security-badge";

/**
 * The session's security line under the masthead's figures: how many
 * findings still count and whether any blocks shipping; nothing when none
 * do. Loads the session's checkpoint results, which the Checkpoint cards
 * below then read.
 */
export function SecuritySummary({
  projectPath,
  sessionId,
}: {
  projectPath: string;
  sessionId: string;
}) {
  useEffect(() => {
    if (projectPath) void useSecurityStore.getState().actions.loadSession(projectPath, sessionId);
  }, [projectPath, sessionId]);
  const cps = useSecurityStore((s) => selectCheckpoints(s, projectPath, sessionId));
  if (!cps) return null;
  // A clean session looks as it did before scanning; its Checkpoint cards say
  // "No security findings" in their footers.
  const { level, blocking, findings } = summarize(sessionId, cps);
  if (findings === 0) return null;
  const text = `${findings} ${findings === 1 ? "finding" : "findings"}, ${
    blocking ? "blocks shipping" : "nothing blocking"
  }`;
  return (
    <div className="mt-2 flex items-center justify-between gap-3 rounded-md border border-border bg-card px-3.5 py-2.5">
      <div className="min-w-0">
        <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Security
        </p>
        <p className="truncate text-sm text-foreground">{text}</p>
      </div>
      <SecurityLevelBadge level={level} />
    </div>
  );
}
