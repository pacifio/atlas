import { useState } from "react";
import { Button } from "@/ui/button";
import { formatTime } from "@/lib/format-time";
import { cn } from "@/lib/utils";
import { securityFindingLine } from "../lib/security-api";
import { ROTATE, secretLabel, whereLabel } from "../lib/security-levels";
import { selectCheckpoints, useSecurityStore } from "../stores/security-store";
import type { SecurityFinding } from "../types";
import { SecurityLevelBadge } from "./session-security-badge";

/** Through `formatTime`: a cached formatter, and the user's 12h/24h setting. */
function clock(iso: string): string {
  return Number.isNaN(Date.parse(iso)) ? "" : formatTime(iso);
}

/** `The agent read .env and id_rsa earlier in this session. `, or nothing. */
function readNote(paths: string[]): string {
  if (paths.length === 0) return "";
  const list =
    paths.length === 1
      ? paths[0]
      : `${paths.slice(0, -1).join(", ")} and ${paths[paths.length - 1]}`;
  return `The agent read ${list} earlier in this session. `;
}

const NOT_SCANNED = "Not scanned: made before scanning was turned on for this project.";

function Footer({ children }: { children: React.ReactNode }) {
  return (
    <p className="border-t border-border px-3 py-1.5 font-mono text-2xs text-muted-foreground">
      {children}
    </p>
  );
}

function FindingRow({
  projectPath,
  sessionId,
  finding,
}: {
  projectPath: string;
  sessionId: string;
  finding: SecurityFinding;
}) {
  const [line, setLine] = useState<string | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const toggleLine = () => {
    setOpen((o) => !o);
    if (line === undefined) {
      void securityFindingLine(projectPath, finding.sha, finding.path, finding.line)
        .then(setLine)
        .catch(() => setLine(null));
    }
  };
  const secret = secretLabel(finding.ruleId);
  const mark = (notUseful: boolean) =>
    void useSecurityStore
      .getState()
      .actions.setNotUseful(projectPath, sessionId, finding, notUseful);

  return (
    <li
      data-not-useful={String(finding.notUseful)}
      className={cn(
        // A fixed level column, so every reason starts at the same place.
        "grid grid-cols-[5rem_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 border-t border-border px-3 py-2.5",
        finding.notUseful && "opacity-45",
      )}
    >
      <SecurityLevelBadge level={finding.level} />
      <div className="min-w-0">
        <p className="text-sm text-foreground">
          {secret ? `${finding.reason} ${ROTATE}` : finding.reason}
        </p>
        <p className="mt-0.5 font-mono text-xs text-muted-foreground">
          <button
            type="button"
            onClick={toggleLine}
            className="underline decoration-border underline-offset-2 hover:text-foreground"
          >
            {whereLabel(finding)}
          </button>
          {secret && <span>, {secret}</span>}
          {finding.testCode && <span>, in test code</span>}
          {finding.notUseful && <span>, marked not useful</span>}
        </p>
        {open && (
          <pre className="mt-1.5 overflow-x-auto rounded border border-border bg-background px-2.5 py-1.5 font-mono text-xs text-foreground">
            {line === undefined
              ? "Loading the line…"
              : (line ?? "The line is no longer in this commit.")}
          </pre>
        )}
      </div>
      <Button variant="ghost" size="xs" onClick={() => mark(!finding.notUseful)}>
        {finding.notUseful ? "Undo" : "Not useful"}
      </Button>
    </li>
  );
}

/**
 * A Checkpoint card's security findings, under its file list, and a quiet
 * footer: how it was scanned, or that it was not.
 */
export function CheckpointFindings({
  projectPath,
  sessionId,
  commitSha,
}: {
  projectPath: string;
  sessionId: string;
  commitSha: string;
}) {
  // This card's own checkpoint, not the session's list: a scan that re-reads
  // the session re-renders only the cards whose results changed (the store
  // keeps unchanged rows' identity), not every card in a long session.
  const checkpoint = useSecurityStore((s) =>
    selectCheckpoints(s, projectPath, sessionId)?.find((c) => c.commitSha === commitSha),
  );
  const sessionScanned = useSecurityStore(
    (s) => (selectCheckpoints(s, projectPath, sessionId)?.length ?? 0) > 0,
  );
  if (!checkpoint) {
    // Only said when the session has scans, so it never shows while scanning
    // is off.
    return sessionScanned ? <Footer>{NOT_SCANNED}</Footer> : null;
  }
  const at = clock(checkpoint.scannedAt);
  const notScanned = checkpoint.notScanned.length;
  return (
    <div>
      {checkpoint.findings.length > 0 && (
        <ul aria-label="Security findings">
          {checkpoint.findings.map((f) => (
            <FindingRow
              key={f.fingerprint}
              projectPath={projectPath}
              sessionId={sessionId}
              finding={f}
            />
          ))}
        </ul>
      )}
      <Footer>
        {checkpoint.status === "failed"
          ? "This commit could not be scanned."
          : `${readNote(checkpoint.sensitiveReads)}${checkpoint.findings.length === 0 ? "No security findings. " : ""}Scanned on this machine${
              at ? ` at ${at}` : ""
            }, in ${checkpoint.scanMs} ms.${
              notScanned > 0
                ? ` ${notScanned} ${notScanned === 1 ? "file" : "files"} not scanned.`
                : ""
            }`}
      </Footer>
    </div>
  );
}
