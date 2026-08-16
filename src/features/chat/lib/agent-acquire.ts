// Download progress for a built-in agent's managed binary (cursor / opencode /
// kilo — `atlas_acp::AUTO_MANAGED_BUILTIN_IDS`).
//
// Claude and Codex ship through `npx -y`, so npm fetches them on first run.
// These three are plain CLIs that Atlas downloads itself at spawn time
// (`RegistryStore::ensure_builtin`), which on a cold cache is a real ~20 s,
// tens-of-MB download. Without this the composer just sat there looking hung;
// with it the boot pill reads "Setting up Cursor… 42%".
//
// State lives at MODULE scope behind `useSyncExternalStore` (same shape as the
// agents marketplace) so an unmount mid-download — switching tabs while Cursor
// installs — doesn't lose the progress.

import { useSyncExternalStore } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface AgentAcquireProgress {
  agentId: string;
  received: number;
  total: number | null;
}

interface AgentAcquireDone {
  agentId: string;
  ready: boolean;
}

const progressByPlugin = new Map<string, AgentAcquireProgress>();
let version = 0;
const subs = new Set<() => void>();

function notify() {
  version++;
  subs.forEach((f) => f());
}

/** One process-wide listener pair, started on the first subscriber and kept
 *  for the app's lifetime — the download outlives any single component. */
let listeners: Promise<UnlistenFn[]> | null = null;
function ensureListeners() {
  if (listeners) return;
  listeners = Promise.all([
    listen<AgentAcquireProgress>("atlas:agent-acquire:progress", (e) => {
      progressByPlugin.set(e.payload.agentId, e.payload);
      notify();
    }),
    // Fires on every path — cache hit, finished download, and failure — so the
    // pill can never stick at 99%.
    listen<AgentAcquireDone>("atlas:agent-acquire:done", (e) => {
      if (progressByPlugin.delete(e.payload.agentId)) notify();
    }),
  ]);
}

function subscribe(cb: () => void) {
  ensureListeners();
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}

/** Live download progress for `pluginId`, or `null` when nothing is being
 *  acquired for it (the overwhelmingly common case: warm cache or an npx
 *  agent). */
export function useAgentAcquire(pluginId: string | undefined): AgentAcquireProgress | null {
  useSyncExternalStore(subscribe, () => version);
  if (!pluginId) return null;
  return progressByPlugin.get(pluginId) ?? null;
}

/** Whole-percent for a progress record, or `null` when the server sent no
 *  content-length. */
export function acquirePercent(p: AgentAcquireProgress | null): number | null {
  if (!p || !p.total) return null;
  return Math.min(100, Math.round((p.received / p.total) * 100));
}

/** Test seam — the module's state is process-wide by design, so the suite
 *  needs a way to drive and reset it without a React tree. */
export const __testing = {
  subscribe,
  get: (pluginId: string) => progressByPlugin.get(pluginId) ?? null,
  reset: () => {
    progressByPlugin.clear();
    subs.clear();
  },
};
