import type { CheckpointSecurity, SecurityFinding, SecurityLevel, SessionSecurity } from "../types";

const RANK: Record<SecurityLevel, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

const LABEL: Record<SecurityLevel, string> = {
  none: "No findings",
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

export function levelLabel(level: SecurityLevel): string {
  return LABEL[level];
}

/** The `Badge` status role for a level: red only for critical, amber for
 *  high and medium (the label tells them apart), blue for low. */
export function badgeVariant(
  level: SecurityLevel,
): "destructive" | "warning" | "info" | "secondary" {
  switch (level) {
    case "critical":
      return "destructive";
    case "high":
    case "medium":
      return "warning";
    case "low":
      return "info";
    default:
      return "secondary";
  }
}

export function maxLevel(levels: SecurityLevel[]): SecurityLevel {
  return levels.reduce<SecurityLevel>((a, b) => (RANK[b] > RANK[a] ? b : a), "none");
}

/** A row gets a badge only when one of its findings still counts. */
export function shouldShowBadge(s: SessionSecurity | undefined): boolean {
  return !!s && s.findings > 0 && s.level !== "none";
}

const counted = (f: SecurityFinding) => !f.notUseful;

/** A checkpoint's level and block after a finding's "Not useful" changed,
 *  the same rule the Rust view applies. */
export function recount(cp: CheckpointSecurity): CheckpointSecurity {
  const live = cp.findings.filter(counted);
  return {
    ...cp,
    level: maxLevel(live.map((f) => f.level)),
    blocking: live.some((f) => f.blocking),
  };
}

/** A session's badge recomputed from its checkpoints. */
export function summarize(sessionId: string, cps: CheckpointSecurity[]): SessionSecurity {
  const live = cps.flatMap((c) => c.findings.filter(counted));
  return {
    sessionId,
    level: maxLevel(live.map((f) => f.level)),
    blocking: live.some((f) => f.blocking),
    findings: live.length,
    scanned: cps.length,
  };
}

/** `server/pay.ts, line 2` */
export function whereLabel(f: { path: string; line: number }): string {
  return f.line > 0 ? `${f.path}, line ${f.line}` : f.path;
}
