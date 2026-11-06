import { ExternalLink, GitPullRequestArrow, RotateCcw, X } from "lucide-react";
import { Button, IconButton, StepList, type StepListStep } from "@tryatlas/design";
import { FixWithAgentButton } from "@/features/ask-agent/components/ask-agent-button";
import type { ErrorContext } from "@/features/ask-agent/lib/agent-context";

export interface ShipProgressViewProps {
  title: string;
  steps: StepListStep[];
  phase: "running" | "failed" | "done";
  /** The failing step's complaint, in words. */
  error: string | null;
  /** The label of the step a retry starts at. */
  retryLabel: string | null;
  /** The failure as the agent gets it, for "Fix with agent". */
  fix: ErrorContext | null;
  pr: { number: number; existing: boolean } | null;
  onRetry: () => void;
  onDismiss: () => void;
  onOpenPr: () => void;
  onOpenPrOnHost: () => void;
}

/**
 * "Commit, push & PR" in place: the package's `StepList` (one row per step in
 * the timeline's own language, the failing step's error under it, one short
 * status sentence per change), then a retry from the failed step beside "Fix
 * with agent" (the step, its command and its output), and the pull request it
 * ended on. Renders from its props alone.
 *
 * The retry is drawn here rather than by `StepList` so it shares a row with
 * "Fix with agent".
 */
export function ShipProgressView({
  title,
  steps,
  phase,
  error,
  retryLabel,
  fix,
  pr,
  onRetry,
  onDismiss,
  onOpenPr,
  onOpenPrOnHost,
}: ShipProgressViewProps) {
  const doneMessage = pr
    ? pr.existing
      ? `Done. Pull request ${pr.number} was already open.`
      : `Done. Opened pull request ${pr.number}.`
    : "Done.";
  return (
    <section aria-label={title} className="shrink-0 border-t border-border-subtle px-3 py-2">
      <div className="flex h-control-sm items-center gap-2">
        <span className="eyebrow min-w-0 flex-1 truncate">{title}</span>
        {phase !== "running" && (
          <IconButton size="xs" icon={X} label="Dismiss" onClick={onDismiss} />
        )}
      </div>
      <StepList
        className="mt-1"
        steps={steps}
        error={phase === "failed" ? error : null}
        doneMessage={doneMessage}
      />

      {phase === "failed" && error && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="outline" onClick={onRetry}>
            <RotateCcw size={12} />
            {retryLabel ?? "Retry"}
          </Button>
          {fix && <FixWithAgentButton error={fix} />}
        </div>
      )}

      {phase === "done" && pr && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="outline" onClick={onOpenPr}>
            <GitPullRequestArrow size={12} />
            {pr.existing ? `#${pr.number} was already open` : `Opened #${pr.number}`}
          </Button>
          <Button size="sm" variant="ghost" onClick={onOpenPrOnHost}>
            <ExternalLink size={12} />
            On GitHub
          </Button>
        </div>
      )}
    </section>
  );
}
