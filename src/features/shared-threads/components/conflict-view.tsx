import { useState } from "react";
import { Bot, GitMerge, TriangleAlert } from "lucide-react";

import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { cn } from "@/lib/utils";

import {
  sharedThreadError,
  type ConflictSide,
  type SharedThreadConflict,
  type SharedThreadError,
} from "../lib/shared-threads-api";

/** How the person resolves one Conflict; `agent` hands it to an agent's Run. */
export type ConflictAction =
  | { side: Exclude<ConflictSide, "agent" | "edited"> }
  | { side: "edited"; text: string }
  | { side: "agent" };

/** `src/app.ts:19–20`, or just the path for a whole-file Conflict. */
export function conflictPlace(c: SharedThreadConflict): string {
  if (c.lines === null) return c.path;
  const first = c.lines.start + 1;
  const last = Math.max(first, c.lines.end);
  return first === last ? `${c.path}:${first}` : `${c.path}:${first}–${last}`;
}

/** Who and which agent stand behind each side. */
export function sideLabels(c: SharedThreadConflict): { canonical: string; run: string } {
  const others = c.canonicalBy.length > 0 ? c.canonicalBy.join(", ") : "someone";
  const otherAgents = c.canonicalAgents.length > 0 ? ` · ${c.canonicalAgents.join(", ")}` : "";
  const runner = c.runBy ?? "a teammate";
  return {
    canonical: `Now in the thread — ${others}${otherAgents}`,
    run: `Run by ${runner}${c.runAgent ? ` · ${c.runAgent}` : ""}`,
  };
}

/**
 * The thread's open Conflicts (ATL-410): where a Run's change met a change made
 * since it started. The rest of that Run already landed; each hunk here waits
 * for somebody — anybody who can edit — to choose.
 */
export function ConflictList({
  conflicts,
  mayEdit,
  onResolve,
}: {
  conflicts: SharedThreadConflict[];
  mayEdit: boolean;
  onResolve: (conflict: SharedThreadConflict, action: ConflictAction) => Promise<void>;
}) {
  const open = conflicts.filter((c) => c.status === "open");
  if (open.length === 0) return null;
  return (
    <section aria-label="Conflicts" className="flex flex-col gap-1.5">
      <span className="flex items-center gap-1.5 text-2xs uppercase tracking-wide text-warning">
        <TriangleAlert size={11} />
        {open.length} {open.length === 1 ? "Conflict" : "Conflicts"} to resolve
      </span>
      {open.map((c) => (
        <ConflictCard key={c.conflictId} conflict={c} mayEdit={mayEdit} onResolve={onResolve} />
      ))}
    </section>
  );
}

function ConflictCard({
  conflict,
  mayEdit,
  onResolve,
}: {
  conflict: SharedThreadConflict;
  mayEdit: boolean;
  onResolve: (conflict: SharedThreadConflict, action: ConflictAction) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState(conflict.proposed ?? "");
  const [busy, setBusy] = useState<ConflictSide | null>(null);
  const [error, setError] = useState<SharedThreadError | null>(null);
  const labels = sideLabels(conflict);

  async function act(action: ConflictAction) {
    setBusy(action.side);
    setError(null);
    try {
      await onResolve(conflict, action);
    } catch (e) {
      setError(sharedThreadError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      data-conflict={conflict.conflictId}
      className="flex flex-col gap-1.5 rounded border border-[var(--atlas-border-subtle)] bg-warning-muted px-2 py-1.5"
    >
      <button
        type="button"
        className="flex items-center gap-1.5 text-left"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <GitMerge size={11} className="shrink-0 text-warning" />
        <span className="min-w-0 flex-1 truncate font-mono text-[var(--foreground)]" title={conflict.path}>
          {conflictPlace(conflict)}
        </span>
        {conflict.binary && <Badge variant="secondary">Binary</Badge>}
        <Badge variant="warning">Open</Badge>
      </button>
      {expanded && (
        <div className="flex flex-col gap-1.5">
          {conflict.binary ? (
            <p className="text-[var(--secondary-foreground)]">
              Both sides changed this file. A binary file keeps one version or the other.
            </p>
          ) : (
            <Side label="Started as" text={conflict.base} muted />
          )}
          <Side label={labels.canonical} text={conflict.canonical} binary={conflict.binary} />
          <Side label={labels.run} text={conflict.run} binary={conflict.binary} />
          {!conflict.binary && mayEdit && (
            <label className="flex flex-col gap-1">
              <span className="text-[var(--muted-foreground)]">Result — edit before using it</span>
              <textarea
                aria-label="Merged result"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={Math.min(8, Math.max(2, draft.split("\n").length))}
                className="w-full resize-y rounded border border-[var(--atlas-border-subtle)] bg-[var(--background)] p-1.5 font-mono text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
              />
            </label>
          )}
          {mayEdit ? (
            <div className="flex flex-wrap gap-1.5">
              <Button size="xs" variant="outline" disabled={busy !== null} onClick={() => void act({ side: "canonical" })}>
                Keep current
              </Button>
              <Button size="xs" variant="outline" disabled={busy !== null} onClick={() => void act({ side: "run" })}>
                Take the Run&apos;s
              </Button>
              {!conflict.binary && (
                <>
                  <Button size="xs" variant="outline" disabled={busy !== null} onClick={() => void act({ side: "both" })}>
                    Keep both
                  </Button>
                  <Button
                    size="xs"
                    disabled={busy !== null || draft === ""}
                    onClick={() => void act({ side: "edited", text: draft })}
                  >
                    Use result
                  </Button>
                  <Button size="xs" variant="ghost" disabled={busy !== null} onClick={() => void act({ side: "agent" })}>
                    <Bot size={11} />
                    {busy === "agent" ? "Asking…" : "Ask an agent"}
                  </Button>
                </>
              )}
            </div>
          ) : (
            <p className="text-[var(--muted-foreground)]">Only people who can edit the thread resolve Conflicts.</p>
          )}
          {error && <p className="text-error">{error.message}</p>}
        </div>
      )}
    </div>
  );
}

function Side({
  label,
  text,
  muted = false,
  binary = false,
}: {
  label: string;
  text: string | null;
  muted?: boolean;
  binary?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[var(--muted-foreground)]">{label}</span>
      <pre
        className={cn(
          "max-h-32 overflow-auto whitespace-pre-wrap rounded bg-[var(--atlas-element-hover)] p-1.5 font-mono",
          muted ? "text-[var(--muted-foreground)]" : "text-[var(--foreground)]",
        )}
      >
        {text === null
          ? binary
            ? "(no file)"
            : ""
          : binary
            ? `version ${text.slice(0, 12)}`
            : text}
      </pre>
    </div>
  );
}
