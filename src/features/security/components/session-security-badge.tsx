import { ShieldAlert } from "lucide-react";
import { Badge } from "@/ui/badge";
import { badgeVariant, levelLabel, shouldShowBadge } from "../lib/security-levels";
import { useProjectSecurity } from "../lib/use-project-security";
import { useSecurityStore } from "../stores/security-store";
import type { SecurityLevel } from "../types";

/** A security level as a status pill with a shield. */
export function SecurityLevelBadge({ level, label }: { level: SecurityLevel; label?: string }) {
  return (
    <Badge variant={badgeVariant(level)} size="sm">
      <ShieldAlert size={10} aria-hidden />
      {label ?? levelLabel(level)}
    </Badge>
  );
}

/**
 * The shield on a Timeline row: the highest level among the session's
 * findings that still count. Nothing at all for a clean or unscanned
 * session, so rows without findings look exactly as before.
 */
export function SessionSecurityBadge({
  projectPath,
  sessionId,
}: {
  projectPath: string;
  sessionId: string;
}) {
  useProjectSecurity(projectPath);
  const summary = useSecurityStore((s) => s.sessions[projectPath]?.[sessionId]);
  if (!shouldShowBadge(summary) || !summary) return null;
  const title = `${summary.findings} security ${summary.findings === 1 ? "finding" : "findings"}${
    summary.blocking ? ", blocks shipping" : ""
  }`;
  return (
    <span className="inline-flex shrink-0" title={title}>
      <SecurityLevelBadge level={summary.level} />
    </span>
  );
}
