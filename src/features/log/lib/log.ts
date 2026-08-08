import { useLogStore, type LogSource } from "../stores/log-store";
import { useProjectStore } from "@/features/project/stores/project-store";

interface LogEventInput {
  source: LogSource;
  kind: string;
  summary: string;
  payload?: Record<string, unknown>;
  projectPath?: string;
  projectName?: string;
  /** Outcome marker. Surfaces in the panel as a colored chip and lets
   *  early users grep logs for failures without opening each row. */
  status?: "success" | "failure" | "pending";
}

/**
 * Push one entry into the global activity log. Cheap, fire-and-forget; the
 * store handles capping (500) and auto-fills project name from the current
 * project context. Safe to call from anywhere (renderer-only).
 *
 * The `atlas` source is gated by Settings → General → "Enable Atlas Logs"
 * so users who don't want internal-event noise (or who explicitly disabled
 * it for performance) can opt out without affecting the other sources.
 */
export function logEvent(entry: LogEventInput): void {
  try {
    if (entry.source === "atlas") {
      const enabled = useProjectStore.getState().settings.enableAtlasLogs;
      if (!enabled) return;
    }
    const { status, payload, ...rest } = entry;
    const merged: Record<string, unknown> | undefined =
      status !== undefined ? { ...payload, status } : payload;
    useLogStore.getState().actions.append({ ...rest, payload: merged });
  } catch {
    // Never let the log layer throw into the host call site.
  }
}
