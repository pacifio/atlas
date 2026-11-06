// "Scroll this diff tab to that file" — from outside the tab.
//
// The Details card's Changes section asks for a file in a changes tab that may already be on
// screen or may only be mounting now (a fresh split). A request waits here
// until the tab's view takes it, so both cases are one path, and a view that is
// already mounted is told immediately. Not tab data: a tab's data is what it
// restores from, and a stale "jump to X" must not replay on every remount.

import { useEffect, useState } from "react";

export interface DiffJump {
  path: string;
  /** Distinct per request, so asking twice for one file scrolls twice. */
  nonce: number;
}

const pending = new Map<string, DiffJump>();
const listeners = new Map<string, Set<(jump: DiffJump) => void>>();
let nonce = 0;

export function requestDiffJump(tabId: string, path: string): void {
  const jump = { path, nonce: ++nonce };
  const subs = listeners.get(tabId);
  if (subs?.size) for (const fn of subs) fn(jump);
  else pending.set(tabId, jump);
}

/** The latest jump asked of `tabId`; consumes one that arrived before mount. */
export function useDiffJump(tabId: string): DiffJump | null {
  const [jump, setJump] = useState<DiffJump | null>(null);
  useEffect(() => {
    const queued = pending.get(tabId);
    if (queued) {
      pending.delete(tabId);
      setJump(queued);
    }
    let subs = listeners.get(tabId);
    if (!subs) listeners.set(tabId, (subs = new Set()));
    subs.add(setJump);
    return () => {
      subs.delete(setJump);
      if (subs.size === 0) listeners.delete(tabId);
    };
  }, [tabId]);
  return jump;
}
