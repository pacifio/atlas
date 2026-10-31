// The Security Agent (ATL-985): the Timeline badge, the findings inside a
// Checkpoint card, and "Before you ship".
//
// Only the live Session in acme-app (`fixtures/artifacts.ts`) has scans, on
// its two Checkpoints. The first holds the three states a finding can be in:
// a blocking credential, a medium finding that is still open, and a high one
// the second Checkpoint fixed. Its branch has an open pull request (#431 in
// `fixtures/pull-requests.ts`), so the roll-up shows too. Every other Session
// is unscanned and shows nothing, which is the common case.
//
// "Not useful" is module state, so marking one dims it and lowers the badge
// until the page reloads.

import { emit } from "@tauri-apps/api/event";
import { SECURITY_SCAN_CHANGED } from "@/features/security/lib/security-api";
import type {
  CheckpointSecurity,
  SecurityFinding,
  SecurityLevel,
  SessionSecurity,
  ShipOverview,
} from "@/features/security/types";
import type { TypedHandlers, Unit } from "../types";
import { MOCK_PROJECT } from "../project";

const SESSION = "sess-8f21ac";
const FIRST = "4f21a9033c1d8e77b0a5f1c2d3e4b5a6c7d8e9f0";
const SECOND = "c0ffee11223344556677889900aabbccddeeff01";

const FINDINGS: SecurityFinding[] = [
  {
    fingerprint: "mock-secret",
    level: "critical",
    blocking: true,
    class: "secret",
    ruleId: "secret.vendor.stripe-access-token",
    reason: "A credential appears in the added code.",
    path: "src/lib/api.ts",
    line: 14,
    endLine: 14,
    sha: FIRST,
    testCode: false,
    notUseful: false,
  },
  {
    fingerprint: "mock-html",
    level: "medium",
    blocking: false,
    class: "xss",
    ruleId: "ts.html.inner",
    reason: "Content may be rendered as HTML without being sanitised.",
    path: "src/components/user-table.tsx",
    line: 42,
    endLine: 42,
    sha: FIRST,
    testCode: false,
    notUseful: false,
  },
  {
    fingerprint: "mock-eval",
    level: "high",
    blocking: false,
    class: "injection",
    ruleId: "ts.eval",
    reason: "Outside input may reach a shell command, query or code evaluation unchecked.",
    path: "src/lib/api.ts",
    line: 88,
    endLine: 88,
    sha: FIRST,
    testCode: false,
    notUseful: false,
  },
];

/** The committed lines "Show line" reads, already redacted as Rust does. */
const LINES: Record<string, string> = {
  "src/lib/api.ts:14": 'const STRIPE_KEY = "[REDACTED]";',
  "src/components/user-table.tsx:42": "cell.innerHTML = row.displayName;",
  "src/lib/api.ts:88": "return eval(response.body);",
};

const notUseful = new Set<string>();
const RANK: SecurityLevel[] = ["none", "low", "medium", "high", "critical"];

const marked = (f: SecurityFinding): SecurityFinding => ({
  ...f,
  notUseful: notUseful.has(f.fingerprint),
});

function checkpoints(): CheckpointSecurity[] {
  const findings = FINDINGS.map(marked);
  const counted = findings.filter((f) => !f.notUseful);
  const level = counted.reduce<SecurityLevel>(
    (max, f) => (RANK.indexOf(f.level) > RANK.indexOf(max) ? f.level : max),
    "none",
  );
  return [
    {
      checkpointId: `${SESSION}-e30`,
      commitSha: FIRST,
      status: "done",
      level,
      blocking: counted.some((f) => f.blocking),
      findings,
      floors: [],
      notScanned: [],
      sensitiveReads: [".env"],
      scannedAt: new Date(Date.now() - 40 * 60_000).toISOString(),
      scanMs: 118,
    },
    {
      checkpointId: `${SESSION}-e34`,
      commitSha: SECOND,
      status: "done",
      level: "none",
      blocking: false,
      findings: [],
      floors: [],
      notScanned: [{ path: "src/lib/api.generated.ts", reason: "generated" }],
      sensitiveReads: [".env"],
      scannedAt: new Date(Date.now() - 25 * 60_000).toISOString(),
      scanMs: 64,
    },
  ];
}

function sessions(): SessionSecurity[] {
  const cps = checkpoints();
  return [
    {
      sessionId: SESSION,
      level: cps[0].level,
      blocking: cps.some((c) => c.blocking),
      findings: cps.reduce((n, c) => n + c.findings.filter((f) => !f.notUseful).length, 0),
      scanned: cps.length,
    },
  ];
}

function overview(branch: string): ShipOverview | null {
  if (branch !== "feature/auth-v2") return null;
  const open = FINDINGS.filter(
    (f) => f.fingerprint !== "mock-eval" && !notUseful.has(f.fingerprint),
  );
  const level = open.reduce<SecurityLevel>(
    (max, f) => (RANK.indexOf(f.level) > RANK.indexOf(max) ? f.level : max),
    "none",
  );
  return {
    branch,
    checkpoints: 2,
    level,
    blocking: open.some((f) => f.blocking),
    open,
    fixed: notUseful.has("mock-eval")
      ? []
      : [
          {
            path: "src/lib/api.ts",
            line: 88,
            ruleId: "ts.eval",
            reason: "Outside input may reach a shell command, query or code evaluation unchecked.",
            fixedIn: SECOND,
          },
        ],
    sensitive: [{ path: "src/lib/api.ts", kind: "auth" }],
    notScanned: [{ path: "src/lib/api.generated.ts", reason: "generated" }],
  };
}

const inProject = (projectPath: unknown) => projectPath === MOCK_PROJECT.path;

/**
 * What the frontend reads from each command below — the type argument of its
 * `invoke<T>`.
 */
export interface SecurityResponses {
  security_project_sessions: SessionSecurity[] | null;
  security_session_checkpoints: CheckpointSecurity[] | null;
  security_ship_overview: ShipOverview | null;
  security_finding_line: string | null;
  security_set_not_useful: Unit;
}

export const securityHandlers: TypedHandlers<SecurityResponses> = {
  security_project_sessions: ({ projectPath }) => (inProject(projectPath) ? sessions() : []),
  security_session_checkpoints: ({ projectPath, sessionId }) =>
    inProject(projectPath) && sessionId === SESSION ? checkpoints() : [],
  security_ship_overview: ({ projectPath, branch }) =>
    inProject(projectPath) ? overview(String(branch)) : null,
  security_finding_line: ({ path, line }) => LINES[`${String(path)}:${Number(line)}`] ?? null,
  security_set_not_useful: ({ projectPath, fingerprint, notUseful: on }) => {
    if (on) notUseful.add(String(fingerprint));
    else notUseful.delete(String(fingerprint));
    // As Rust does after the write: the roll-up and open sessions re-read.
    void emit(SECURITY_SCAN_CHANGED, { projectPath });
    return null;
  },
};
