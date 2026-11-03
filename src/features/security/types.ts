/**
 * The Security Agent's results as the UI reads them (ATL-985). Mirrors
 * `atlas_security::view` on the Rust side, which serialises camelCase.
 */

/** Ordered: `none` < `low` < `medium` < `high` < `critical`. */
export type SecurityLevel = "none" | "low" | "medium" | "high" | "critical";

export interface SecurityFinding {
  /** Stable across commits: the same issue on the same line. */
  fingerprint: string;
  level: SecurityLevel;
  /** Only the fixed rules block: a confirmed credential, a high or critical
   *  dependency advisory, disabled TLS, an any-command shell permission. */
  blocking: boolean;
  class: string;
  ruleId: string;
  /** Plain, fixed per class; never model-written. */
  reason: string;
  path: string;
  line: number;
  endLine: number;
  sha: string;
  testCode: boolean;
  /** Marked "Not useful": still listed, no longer counted. */
  notUseful: boolean;
}

/** Why a changed file was not scanned. `too_large` carries its size. */
export type SkipReason =
  | "binary"
  | "generated"
  | "deleted_file"
  | "time_budget"
  | "unsupported_lockfile"
  | { too_large: { added_lines: number } };

export interface NotScannedFile {
  path: string;
  reason: SkipReason;
}

export interface CheckpointSecurity {
  checkpointId: string;
  commitSha: string;
  status: "done" | "partial" | "failed";
  level: SecurityLevel;
  blocking: boolean;
  findings: SecurityFinding[];
  /** Changed paths in a sensitive area. Not findings. */
  floors: string[];
  notScanned: NotScannedFile[];
  /** Credential files the agent read earlier in the session. */
  sensitiveReads: string[];
  scannedAt: string;
  scanMs: number;
}

/** A Timeline row's badge. */
export interface SessionSecurity {
  sessionId: string;
  level: SecurityLevel;
  blocking: boolean;
  findings: number;
  scanned: number;
}

export interface ShipFixed {
  path: string;
  line: number;
  ruleId: string;
  reason: string;
  /** The later checkpoint that changed the file, when one did. */
  fixedIn: string | null;
}

export interface ShipArea {
  path: string;
  /** `dependencies`, `CI`, `permissions`, … */
  kind: string;
}

export interface ShipOverview {
  branch: string;
  checkpoints: number;
  level: SecurityLevel;
  blocking: boolean;
  open: SecurityFinding[];
  fixed: ShipFixed[];
  sensitive: ShipArea[];
  notScanned: NotScannedFile[];
}
