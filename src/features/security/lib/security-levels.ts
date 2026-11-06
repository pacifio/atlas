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

/** The `Badge` tone for a level: error for critical, severe (between error
 *  and warning) for high, warning for medium, info for low. */
export function badgeVariant(
  level: SecurityLevel,
): "destructive" | "severe" | "warning" | "info" | "secondary" {
  switch (level) {
    case "critical":
      return "destructive";
    case "high":
      return "severe";
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

/** What to do about a committed credential, wherever one is shown. */
export const ROTATE = "Remove it and rotate the key before you push.";

const SECRET_NAMES: Record<string, string> = {
  "secret.private_key": "Private key",
  "secret.provider_token": "Provider API token",
  "secret.credentialed_uri": "Password in a URL",
  "secret.connection_string": "Database connection string",
  "secret.credential_value": "Credential",
  "secret.entropy": "Secret-like value",
  "secret.vendor.jwt": "JSON web token",
};

const ACRONYMS = new Set(["aws", "gcp", "api", "jwt", "pat", "ssh", "npm", "oauth", "id", "url"]);

/** What kind of credential a secret finding is (`Stripe access token`), from
 *  its rule id; null for any other finding. */
export function secretLabel(ruleId: string): string | null {
  if (SECRET_NAMES[ruleId]) return SECRET_NAMES[ruleId];
  const vendor = ruleId.startsWith("secret.vendor.") ? ruleId.slice("secret.vendor.".length) : null;
  if (!vendor) return ruleId.startsWith("secret.") ? "Credential" : null;
  const words = vendor
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w));
  if (words.length === 0) return "Credential";
  const [first, ...rest] = words;
  return [first[0].toUpperCase() + first.slice(1), ...rest].join(" ");
}

/** `server/pay.ts, line 2` */
export function whereLabel(f: { path: string; line: number }): string {
  return f.line > 0 ? `${f.path}, line ${f.line}` : f.path;
}
