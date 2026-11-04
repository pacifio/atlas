import { Loader2, RefreshCw } from "lucide-react";

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
 * **The banner is the retry.** See `HealthDetail` for what the click runs.
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
  const tone = stopped ? "var(--status-error-foreground)" : "var(--status-warning-foreground)";

  return (
    <button
      type="button"
      onClick={onRetry}
      disabled={retrying}
      aria-label="Retry — restart capture for this project"
      className={cn(
        // The ants are drawn as background gradients, so the fill has to be a
        // background-COLOR or it would paint over them.
        "atlas-ants mb-2.5 block w-full cursor-pointer rounded-lg px-2.5 py-2 text-left transition-opacity",
        "hover:opacity-90 disabled:cursor-wait",
      )}
      style={{
        backgroundColor: stopped
          ? "var(--status-error-background)"
          : "var(--status-warning-background)",
        ["--atlas-ants-color" as string]: `color-mix(in oklab, ${tone} 55%, transparent)`,
      }}
    >
      <span className="flex flex-col gap-1">
        {health.issues.map((issue, index) => (
          // Index in the key: two issues can share their reason text.
          <span
            key={`${index}-${issue.reason}`}
            title={issue.nextStep || undefined}
            className={cn(
              "flex items-center gap-1.5 text-xs",
              issue.state === "stopped" ? "text-error" : "text-warning",
            )}
          >
            {index === 0 &&
              (retrying ? (
                <Loader2 size={10} className="shrink-0 animate-spin" />
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
