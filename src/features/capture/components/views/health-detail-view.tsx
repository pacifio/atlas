import { RefreshCw } from "lucide-react";

import { Button, Callout, Icon, Spinner } from "@tryatlas/design";
import { cn } from "@/lib/utils";

import type { CaptureHealth } from "../../types";

/**
 * Why capture is degraded or stopped, and a Retry to try to fix it.
 *
 * Nothing renders while healthy or switched off — a permanent banner trains
 * people to stop reading the thing they are supposed to notice.
 *
 * **One line per issue.** It used to stack the reason over its `nextStep` as two
 * paragraphs, which turned a two-issue banner into four lines of red prose that
 * nobody finished reading. The reason is the line; the `nextStep` moves to the
 * title, so it is still reachable and no longer competing.
 *
 * **Retry is its own button.** The whole banner used to be the button: it had
 * no visible affordance (nothing said it could be clicked), and a screen reader
 * read its long label on every visit instead of the issues. The issues are
 * now plain text and Retry sits at the callout's end; see `HealthDetail` for
 * what it runs.
 */
export function HealthDetailView({
  health,
  retrying,
  onRetry,
}: {
  /** Non-null with at least one issue — the container renders nothing otherwise. */
  health: CaptureHealth;
  retrying: boolean;
  onRetry: () => void;
}) {
  const stopped = health.state === "stopped";
  const ink = stopped ? "var(--status-error-foreground)" : "var(--status-warning-foreground)";

  return (
    // The marching ants ride an overlay over the callout rather than the
    // callout itself: they are background gradients, and the callout's own
    // tinted fill is a background too.
    <div
      className="relative mb-2.5"
      style={{
        // A call-site tint of the banner's own tone, for the ants.
        ["--atlas-ants-color" as string]: `color-mix(in oklab, ${ink} 55%, transparent)`,
      }}
    >
      <Callout
        tone={stopped ? "error" : "warning"}
        icon={false}
        className="*:min-w-0"
        action={
          <Button
            variant="ghost"
            size="xs"
            onClick={onRetry}
            disabled={retrying}
            aria-label="Retry — restart capture for this project"
          >
            {retrying ? <Spinner size="xs" label="" /> : <Icon icon={RefreshCw} size="xs" />}
            Retry
          </Button>
        }
      >
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          {health.issues.map((issue, index) => (
            // Index in the key: two issues can share their reason text.
            <span
              key={`${index}-${issue.reason}`}
              title={issue.nextStep || undefined}
              className={cn(
                "min-w-0 truncate",
                issue.state === "stopped" ? "text-error" : "text-warning",
              )}
            >
              {issue.reason}
            </span>
          ))}
        </span>
      </Callout>
      <span aria-hidden className="atlas-ants pointer-events-none absolute inset-0 rounded-md" />
    </div>
  );
}
