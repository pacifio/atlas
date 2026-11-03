import { GitCommitHorizontal } from "lucide-react";

import { CheckpointFindings } from "@/features/security/components/checkpoint-findings";
import { cn } from "@/lib/utils";

import type { TimelineEntry } from "../../types";

/**
 * A commit this Session produced — a card, because it is a boundary in the
 * Session rather than another row in it.
 *
 * The file list is the honest limit of what the store holds: Checkpoints carry
 * paths and a diffstat, never the patch. A diff viewer here would need the
 * commit re-read from git, which is a different feature.
 */
export function Checkpoint({
  entry,
  projectPath,
  sessionId,
}: {
  entry: TimelineEntry;
  projectPath: string;
  sessionId: string;
}) {
  const orphaned = entry.linkState === "orphaned";
  return (
    <div
      className={cn(
        "mt-2.5 overflow-hidden rounded-md border",
        orphaned
          ? "border-dashed border-[var(--atlas-border-strong)]"
          : "border-[var(--border)] bg-[var(--card)]",
      )}
    >
      <div className="flex items-center gap-2.5 border-b border-[var(--atlas-border-subtle)] bg-[var(--card)] px-3 py-2">
        <GitCommitHorizontal size={13} className="shrink-0 text-[var(--muted-foreground)]" />
        <span className="shrink-0 font-mono text-xs text-[var(--muted-foreground)]">
          {entry.commitSha?.slice(0, 7)}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm",
            orphaned ? "text-[var(--secondary-foreground)]" : "text-[var(--foreground)]",
          )}
        >
          {entry.commitSubject ?? (
            // The Checkpoint is a real record even when git can no longer
            // resolve it — a moved repository or a pruned commit must not
            // erase it.
            <span className="text-[var(--muted-foreground)]">
              {orphaned ? "Commit no longer reachable" : "Subject unavailable"}
            </span>
          )}
        </span>
        {/* A squash or a conflict-resolved rebase leaves the subject and the
         *  diffstat intact, so without saying so outright an orphaned
         *  Checkpoint reads exactly like a live one — the "wrong link" this
         *  whole subsystem exists to avoid. */}
        {orphaned && (
          <span
            className="shrink-0 rounded-full bg-[var(--atlas-status-warning-background)] px-2 py-px font-mono text-2xs text-[var(--atlas-status-warning-foreground)]"
            title="This commit is no longer in history — rewritten or squashed. The Session record is kept."
          >
            orphaned
          </span>
        )}
        {entry.insertions > 0 && (
          <span className="shrink-0 font-mono text-xs text-[var(--atlas-diff-added-text)]">
            +{entry.insertions}
          </span>
        )}
        {entry.deletions > 0 && (
          <span className="shrink-0 font-mono text-xs text-[var(--atlas-diff-removed-text)]">
            −{entry.deletions}
          </span>
        )}
      </div>

      {entry.files.length > 0 && (
        <ul className="px-3 py-2">
          {entry.files.slice(0, 12).map((file) => (
            <li
              key={file}
              className="truncate font-mono text-xs leading-[1.75] text-[var(--muted-foreground)]"
            >
              {file}
            </li>
          ))}
          {entry.files.length > 12 && (
            <li className="font-mono text-xs leading-[1.75] text-[var(--atlas-text-disabled)]">
              +{entry.files.length - 12} more
            </li>
          )}
        </ul>
      )}

      {entry.commitSha && !orphaned && (
        <CheckpointFindings
          projectPath={projectPath}
          sessionId={sessionId}
          commitSha={entry.commitSha}
        />
      )}

      {/* Suppressed when orphaned: the branch no longer contains this commit,
       *  so showing it would assert exactly the link that was lost. */}
      {entry.branch && !orphaned && (
        <p className="border-t border-[var(--atlas-border-subtle)] px-3 py-1.5 font-mono text-xs text-[var(--atlas-text-disabled)]">
          {entry.branch}
        </p>
      )}
    </div>
  );
}
