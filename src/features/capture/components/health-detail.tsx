import { useState } from "react";

import { activeProjectId } from "@/features/projects/lib/active-project";

import { captureRetryWatcher } from "../lib/capture-api";
import type { CaptureHealth } from "../types";
import { HealthDetailView } from "./views/health-detail-view";

/**
 * The health banner's container: owns the retry and its in-flight state.
 *
 * **The banner is the retry.** Clicking it re-runs `capture_retry_watcher`,
 * which restarts the git watcher and answers with the health that *results* —
 * so the banner either clears or keeps saying what is still wrong, rather than
 * clearing optimistically and returning on the next poll. The retry is offered
 * for any unhealthy state rather than only the watcher issue: `HealthIssue`
 * carries prose, not a machine-readable code, and string-matching a sentence to
 * decide whether a button appears is the kind of thing that breaks silently the
 * next time the wording changes. Re-running health is harmless when the problem
 * was something else — it just tells the truth again.
 */
export function HealthDetail({
  health,
  projectPath,
  onRetried,
}: {
  health: CaptureHealth | null;
  projectPath: string;
  /** Re-read after a retry. `health` is owned by the titlebar, so the banner
   *  updates by asking it to re-read rather than by holding a second copy. */
  onRetried: () => void;
}) {
  const [retrying, setRetrying] = useState(false);

  if (!health || health.issues.length === 0) return null;

  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      await captureRetryWatcher(projectPath, activeProjectId());
      onRetried();
    } catch {
      // The banner is already saying something is wrong; a failed retry does
      // not need a second, competing error.
    } finally {
      setRetrying(false);
    }
  };

  return <HealthDetailView health={health} retrying={retrying} onRetry={() => void retry()} />;
}
