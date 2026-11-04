import type { Binding, CaptureHealth } from "../types";

/**
 * One status model for the capture indicator: what the titlebar dot and the
 * popover radar's label should say about a project.
 *
 * Pure, so the rule that matters most can be pinned in a test: **never show
 * the success tone or the word "Capturing" while capture is faulted.** A
 * stopped recorder painted green is the one lie this indicator cannot afford.
 *
 * Read by the titlebar dot (`StatusDot`) and the popover radar's label
 * (`CaptureRadar`), so the two always agree.
 */
export type CaptureIndicatorKind = "unbound" | "paused" | "capturing" | "degraded" | "stopped";

export type CaptureIndicatorTone = "success" | "warning" | "error" | "neutral";

export interface CaptureIndicator {
  kind: CaptureIndicatorKind;
  tone: CaptureIndicatorTone;
  /** Only while actually capturing. */
  live: boolean;
  label: string;
}

/**
 * Rules in order. `off` health on an enabled binding is not a fault (see
 * `HealthState`), and neither is a health read that has not answered yet —
 * both read as capturing, matching the titlebar dot.
 */
export function captureIndicator(
  binding: Binding | null,
  health: CaptureHealth | null,
): CaptureIndicator {
  if (!binding) return { kind: "unbound", tone: "neutral", live: false, label: "Not set up" };
  if (!binding.enabled) return { kind: "paused", tone: "neutral", live: false, label: "Paused" };
  if (health?.state === "stopped") {
    return { kind: "stopped", tone: "error", live: false, label: "Stopped" };
  }
  if (health?.state === "degraded") {
    return { kind: "degraded", tone: "warning", live: false, label: "Needs attention" };
  }
  return { kind: "capturing", tone: "success", live: true, label: "Capturing" };
}
