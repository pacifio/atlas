// The memory reconciler's last pass for a project, for the Memory panel's
// header line. The `atlas:memory-health` event only means "a pass finished";
// `memory_health_status` stays the source of truth (the code index status
// pill's shape: re-read on mount, focus and every event, debounced).

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type HealthIssue = { kind: string; [k: string]: unknown };

export type HealthStatus = {
  checkedAt: number;
  record: {
    checkedAt: number;
    found: HealthIssue[];
    repaired: HealthIssue[];
    deferred: HealthIssue[];
  };
  corpus: { rebuiltVectors: number; rebuiltFts: boolean; recreated: boolean };
  /** `[when, from a snapshot]` when an open restored a damaged record. */
  restored: [number, boolean] | null;
  /** Unused, unconfirmed memories moved to the archive by this pass. */
  archived?: number;
};

const DEBOUNCE_MS = 300;

/** The last reconciler pass for `projectPath`, or `null` before the first. */
export function useMemoryHealth(projectPath: string | null): HealthStatus | null {
  const [status, setStatus] = useState<HealthStatus | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    if (!projectPath) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unlisten: (() => void) | undefined;
    let alive = true;
    const refresh = async () => {
      const mine = ++seq.current;
      try {
        const next = await invoke<HealthStatus | null>("memory_health_status", { projectPath });
        if (alive && mine === seq.current) setStatus(next);
      } catch {
        // A failed read keeps the last answer.
      }
    };
    const soon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refresh(), DEBOUNCE_MS);
    };
    void refresh();
    void listen<{ cwd: string }>("atlas:memory-health", (e) => {
      if (e.payload.cwd === projectPath) soon();
    }).then((u) => {
      if (alive) unlisten = u;
      else u();
    });
    window.addEventListener("focus", soon);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      unlisten?.();
      window.removeEventListener("focus", soon);
    };
  }, [projectPath]);
  return status;
}

/** Whether the last pass found the memory history edited outside Atlas. */
export function chainBroken(s: HealthStatus | null): boolean {
  return !!s?.record.deferred.some((i) => i.kind === "chain_broken");
}

/** One line for the panel header, or `null` before the first pass. */
export function healthLine(s: HealthStatus | null): string | null {
  if (!s) return null;
  if (s.restored) {
    return s.restored[1]
      ? "Memory was damaged and restored from yesterday's snapshot"
      : "Memory was damaged and started fresh";
  }
  if (chainBroken(s)) return "Memory history was edited outside Atlas";
  if (s.record.deferred.length) {
    return `Memory needs attention: ${s.record.deferred.map((i) => i.kind).join(", ")}`;
  }
  const fixed =
    s.record.repaired.length + (s.corpus.rebuiltVectors > 0 || s.corpus.rebuiltFts ? 1 : 0);
  const base = fixed ? `Memory repaired ${fixed} issue${fixed === 1 ? "" : "s"}` : "Memory healthy";
  return s.archived ? `${base} · archived ${s.archived} unused` : base;
}
