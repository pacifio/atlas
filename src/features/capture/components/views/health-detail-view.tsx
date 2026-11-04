import { RefreshCw } from "lucide-react";

import { calloutVariants, Spinner } from "@tryatlas/design";
import { cn } from "@/lib/utils";

import type { CaptureHealth } from "../../types";

/**
 * Why capture is degraded or stopped, and one click to try to fix it.
 *
 * Nothing renders while healthy or switched off — a permanent banner trains
 * people to stop reading the thing they are supposed to notice.
 *
 * **One line per issue.** It used to stack the reason over its `nextStep` as two
 * paragraphs, which turned a two-issue banner into four lines of red prose that
 * nobody finished reading. The reason is the line; the `nextStep` moves to the
 * title, so it is still reachable and no longer competing.
 *
 * **The banner is the retry.** See `HealthDetail` for what the click runs. It
 * wears the package `Callout` look (`calloutVariants`) but stays one button:
 * a separate Retry control is a proposed behaviour change awaiting review
 * (ATL-718), so the click target and its label are today's.
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
  const tone = stopped ? "error" : "warning";
  const ink = stopped ? "var(--status-error-foreground)" : "var(--status-warning-foreground)";

  return (
    <button
      type="button"
      onClick={onRetry}
      disabled={retrying}
      aria-label="Retry — restart capture for this project"
      className={cn(
        calloutVariants({ tone }),
        // The ants are drawn as background gradients, so the fill has to be a
        // background-COLOR (the callout's `bg-*-muted` is) or it would paint
        // over them.
        "atlas-ants mb-2.5 w-full cursor-pointer text-left transition-opacity",
        "hover:opacity-90 disabled:cursor-wait",
      )}
      style={{
        // A call-site tint of the banner's own tone, for the ants.
        ["--atlas-ants-color" as string]: `color-mix(in oklab, ${ink} 55%, transparent)`,
      }}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        {health.issues.map((issue, index) => (
          // Index in the key: two issues can share their reason text.
          <span
            key={`${index}-${issue.reason}`}
            title={issue.nextStep || undefined}
            className={cn(
              "flex items-center gap-1.5",
              issue.state === "stopped" ? "text-error" : "text-warning",
            )}
          >
            {index === 0 &&
              (retrying ? (
                <Spinner size="xs" label="" />
              ) : (
                <RefreshCw size={10} className="shrink-0 opacity-70" />
              ))}
            <span className="min-w-0 flex-1 truncate">{issue.reason}</span>
          </span>
        ))}
      </span>
    </button>
  );
}
