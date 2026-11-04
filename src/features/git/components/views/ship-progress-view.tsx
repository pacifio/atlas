import { ExternalLink, GitPullRequestArrow, RotateCcw, X } from "lucide-react";
import { Button, IconButton, StatusIcon, type SessionStatusKind } from "@tryatlas/design";
import { cn } from "@/lib/utils";

export type ShipStepStatus = "pending" | "running" | "done" | "failed";

export interface ShipStepRow {
  id: string;
  label: string;
  /** What the step acts on: the branch, the commit summary, the base. */
  detail: string | null;
  status: ShipStepStatus;
}

export interface ShipProgressViewProps {
  title: string;
  steps: ShipStepRow[];
  phase: "running" | "failed" | "done";
  /** The failing step's complaint, in words. */
  error: string | null;
  /** The label of the step a retry starts at. */
  retryLabel: string | null;
  pr: { number: number; existing: boolean } | null;
  onRetry: () => void;
  onDismiss: () => void;
  onOpenPr: () => void;
  onOpenPrOnHost: () => void;
}

const GLYPH: Record<ShipStepStatus, SessionStatusKind> = {
  pending: "queued",
  running: "live",
  done: "done",
  failed: "failed",
};

/**
 * "Commit, push & PR" in place: one row per step in the timeline's own
 * language (the session status glyph, then what the step did), the failing
 * step's error under it with a retry from there, and the pull request it ended
 * on. Renders from its props alone.
 *
 * A step changes state by cross-fading its glyph and ink; nothing moves, so
 * the block reads the same with reduced motion.
 */
export function ShipProgressView({
  title,
  steps,
  phase,
  error,
  retryLabel,
  pr,
  onRetry,
  onDismiss,
  onOpenPr,
  onOpenPrOnHost,
}: ShipProgressViewProps) {
  return (
    <section
      aria-label={title}
      aria-live="polite"
      className="shrink-0 border-t border-border-subtle px-3 py-2"
    >
      <div className="flex h-control-sm items-center gap-2">
        <span className="eyebrow min-w-0 flex-1 truncate">{title}</span>
        {phase !== "running" && (
          <IconButton size="xs" icon={X} label="Dismiss" onClick={onDismiss} />
        )}
      </div>
      <ol className="mt-1 space-y-0.5">
        {steps.map((step) => (
          <li
            key={step.id}
            data-status={step.status}
            className={cn(
              "flex h-control-xs items-center gap-2 text-xs transition-colors duration-fast ease-out-strong",
              step.status === "pending" ? "text-muted-foreground" : "text-foreground",
              step.status === "failed" && "text-error",
            )}
          >
            <StatusIcon status={GLYPH[step.status]} className="size-3.5 shrink-0" />
            <span className="shrink-0 font-medium">{step.label}</span>
            {step.detail && (
              <span className="min-w-0 truncate font-mono text-2xs text-muted-foreground">
                {step.detail}
              </span>
            )}
          </li>
        ))}
      </ol>

      {phase === "failed" && error && (
        <div className="mt-2 space-y-2">
          <p className="text-xs whitespace-pre-wrap break-words text-error select-text">{error}</p>
          <Button size="sm" variant="outline" onClick={onRetry}>
            <RotateCcw size={12} />
            {retryLabel ?? "Retry"}
          </Button>
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
