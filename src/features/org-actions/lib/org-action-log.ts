/**
 * An organisation call's row in the Logs panel — the audit trail of what an
 * agent did in the organisation, the same contract UI actions keep (ADR-0012,
 * ADR-0014): one row per call, naming the tool, what it was about and how it
 * ended. A refused or failed call is a row that says why; there is no toast.
 *
 * Rust makes the record (the organisation server never crosses to the
 * window); the line it is described by comes from the table the chat's tool
 * row uses.
 */

import { logEvent } from "@/features/log/lib/log";
import { orgFailureOf, orgRowSubject, orgToolRow } from "./org-tool-rows";
import type { OrgActionRecord } from "./types";

export function logOrgAction(record: OrgActionRecord): void {
  const subject = orgRowSubject(
    orgToolRow(record.tool, record.arguments, record.ok ? record.text : null),
  );
  const error = record.ok ? undefined : orgFailureOf(record.text);
  logEvent({
    source: "agent",
    kind: "agent-org-action",
    summary: `${record.agent} ${record.tool}: ${subject}${error === undefined ? "" : ` failed: ${error}`}`,
    status: record.ok ? "success" : "failure",
    payload: {
      agent: record.agent,
      sessionId: record.sessionId,
      tool: record.tool,
      args: record.arguments,
      subject,
      ...(error === undefined ? {} : { error }),
    },
  });
}
