// Capture's state for one project, as the overlay's trigger and its Capture
// row read it.
//
// The binding comes from the shared project-facts cache (`project-facts.ts`),
// which the capture popover invalidates after every action — so turning
// capture on or off in the overlay's capture view moves the trigger's dot with
// no extra wiring. Health is read here: on mount, on project change, on
// `refresh()` (the popover's `onChanged`), and on capture's own change event,
// debounced, because the recorder emits one per turn written.

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { captureHealth } from "@/features/capture/lib/capture-api";
import { useProjectFacts } from "@/features/capture/lib/project-facts";
import type { Binding, CaptureHealth } from "@/features/capture/types";
import { activeProjectId } from "@/features/projects/lib/active-project";
import { safeUnlistenPromise } from "@/lib/safe-unlisten";

const HEALTH_DEBOUNCE_MS = 500;

export type CaptureTone = "success" | "warning" | "error" | "idle";

export interface CaptureState {
  binding: Binding | null;
  health: CaptureHealth | null;
  /** Capture is on for this project — what the trigger's dot means. */
  recording: boolean;
  /** The dot's colour: a fault keeps its own, never painted green. */
  tone: CaptureTone;
  refresh: () => void;
}

/** Same rule as the titlebar's `StatusDot`, as a value. */
export function captureTone(binding: Binding | null, health: CaptureHealth | null): CaptureTone {
  if (health?.state === "stopped") return "error";
  if (health?.state === "degraded") return "warning";
  return binding?.enabled ? "success" : "idle";
}

export function useCaptureState(projectPath: string | null): CaptureState {
  const facts = useProjectFacts(projectPath);
  const binding = facts?.binding ?? null;
  const [health, setHealth] = useState<CaptureHealth | null>(null);
  const seq = useRef(0);

  const refresh = useCallback(() => {
    const n = ++seq.current;
    if (!projectPath) {
      setHealth(null);
      return;
    }
    void captureHealth(projectPath, activeProjectId())
      .then((h) => {
        if (n === seq.current) setHealth(h);
      })
      .catch(() => {
        if (n === seq.current) setHealth(null);
      });
  }, [projectPath]);

  useEffect(() => {
    refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const un = listen("atlas:capture-changed", () => {
      clearTimeout(timer);
      timer = setTimeout(refresh, HEALTH_DEBOUNCE_MS);
    });
    return () => {
      clearTimeout(timer);
      safeUnlistenPromise(un);
    };
  }, [refresh]);

  return {
    binding,
    health,
    recording: !!binding?.enabled,
    tone: captureTone(binding, health),
    refresh,
  };
}
