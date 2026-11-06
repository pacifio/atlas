import { useEffect, useState } from "react";
import { comms } from "./comms-api";
import type { ChatFeatures } from "../types";

/**
 * The Organisation's features, for drawing the call buttons. Held in memory
 * per org and re-asked after a minute (the web client's `staleTime`), so the
 * two header buttons share one request and a plan change shows up on the
 * next conversation opened. Undefined until the first answer, and on failure
 * — `callButtonPlan` has the defaults for both.
 */
const STALE_MS = 60_000;
const cache = new Map<string, { at: number; value: ChatFeatures }>();
const inflight = new Map<string, Promise<ChatFeatures | undefined>>();

function load(orgId: string): Promise<ChatFeatures | undefined> {
  const pending = inflight.get(orgId);
  if (pending) return pending;
  const request = comms
    .features()
    .then((value) => {
      cache.set(orgId, { at: Date.now(), value });
      return value;
    })
    .catch((e: unknown) => {
      console.warn("comms: features failed:", e);
      return cache.get(orgId)?.value;
    })
    .finally(() => inflight.delete(orgId));
  inflight.set(orgId, request);
  return request;
}

export function useCallFeatures(orgId: string | null): ChatFeatures | undefined {
  const [features, setFeatures] = useState<ChatFeatures | undefined>(() =>
    orgId ? cache.get(orgId)?.value : undefined,
  );
  useEffect(() => {
    if (!orgId) {
      setFeatures(undefined);
      return;
    }
    const hit = cache.get(orgId);
    setFeatures(hit?.value);
    if (hit && Date.now() - hit.at < STALE_MS) return;
    let live = true;
    void load(orgId).then((value) => {
      if (live) setFeatures(value);
    });
    return () => {
      live = false;
    };
  }, [orgId]);
  return features;
}
