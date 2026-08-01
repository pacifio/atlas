/**
 * In-RAM per-workspace snapshot of the LIGHT panel-data stores
 * (explorer/git/analysis/knowledge) — part of the fast-switch path.
 *
 * Heavy tab content (editor/terminal/chat) and the tab/split layout are NOT
 * snapshotted here: they stay RESIDENT in their own stores while the workspace
 * is in the hot set (its CenterPanel subtree stays mounted), and the layout
 * view is restored via `layout-store.loadWorkspaceView`. So this cache only
 * needs to carry the cheap panel slices, restored synchronously via `setState`
 * on a warm switch. On a cache miss (first visit / discarded) the cold loaders
 * run instead.
 *
 * Intentionally NOT a Zustand store: it must never trigger React renders. It's
 * a plain Map keyed by workspace id, capped LRU.
 */

import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useExplorerStore } from "@/features/explorer/stores/explorer-store";
import { useGitStore } from "@/features/git/stores/git-store";
import { useKnowledgeStore } from "@/features/knowledge/stores/knowledge-store";
import { useKnowledgeMetaStore } from "@/features/knowledge/stores/knowledge-meta-store";

/** Max number of workspace snapshots kept warm in RAM. Beyond this we evict
 *  the least-recently-restored (never the active one). These are now just the
 *  lightweight PANEL-data slices (explorer/git/analysis/knowledge) — the heavy
 *  tab content (editor/terminal/chat) and the tab/split layout stay RESIDENT in
 *  their own stores across switches, so they aren't snapshotted here at all. */
const LRU_CAP = 8;

interface Snapshot {
  explorer: Record<string, unknown>;
  git: Record<string, unknown>;
  knowledge: Record<string, unknown>;
  knowledgeMeta: Record<string, unknown>;
  /** Hash of the persist-relevant slices, for write dedup. */
  persistHash: string;
  /** Monotonic touch counter for LRU. */
  touchedAt: number;
}

const cache = new Map<string, Snapshot>();
let clock = 0;

/**
 * Deep-clone a pure-data slice (`actions` already stripped by `dataSlice`).
 * `structuredClone` is a single native pass — roughly 2× faster than the old
 * `JSON.parse(JSON.stringify(...))` round-trip and it doesn't stringify the
 * whole tree, so capturing a large explorer/git/analysis slice on every switch
 * costs less main-thread time. Falls back to the JSON round-trip if
 * `structuredClone` is unavailable or hits a stray non-cloneable value (where
 * JSON silently drops it, matching the previous behaviour).
 */
function clone<T>(value: T): T {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      // Fall through to the JSON path.
    }
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Strip the `actions` key, then JSON-clone the rest of a store's state. */
function dataSlice(state: unknown): Record<string, unknown> {
  const { actions: _actions, ...data } = state as {
    actions?: unknown;
    [k: string]: unknown;
  };
  return clone(data);
}

/** Cheap, stable string hash (djb2). */
function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Capture the active stores into the cache under `workspaceId`. Synchronous +
 * cheap (a few JSON clones). Call this BEFORE resetting the stores on a switch.
 */
export function captureSnapshot(workspaceId: string): void {
  const explorer = dataSlice(useExplorerStore.getState());
  const git = dataSlice(useGitStore.getState());
  const knowledge = dataSlice(useKnowledgeStore.getState());
  const knowledgeMeta = dataSlice(useKnowledgeMetaStore.getState());

  // Tabs/split layout drive the persisted editor-state, so dedup on the
  // mirror's persisted fields only (NOT viewsByWs, which is the whole map).
  const ls = useLayoutStore.getState();
  const layoutForHash = {
    tabs: ls.tabs.map((t) => ({
      id: t.id,
      type: t.type,
      groupId: t.groupId,
      data: t.data,
    })),
    groupOrder: ls.groupOrder,
    activeByGroup: ls.activeByGroup,
    focusedGroupId: ls.focusedGroupId,
  };

  const snapshot: Snapshot = {
    explorer,
    git,
    knowledge,
    knowledgeMeta,
    persistHash: hashString(
      JSON.stringify([layoutForHash, knowledge, knowledgeMeta]),
    ),
    touchedAt: ++clock,
  };

  cache.set(workspaceId, snapshot);
  evictIfNeeded(workspaceId);
}

/**
 * Restore a workspace's stores from the cache. Returns false on a miss (caller
 * runs the cold loader path). Synchronous — React re-renders once after the
 * batched setStates.
 */
export function restoreSnapshot(workspaceId: string): boolean {
  const snap = cache.get(workspaceId);
  if (!snap) return false;

  // Light PANEL-data stores only: merge the data slice back (actions untouched).
  // Tab content (editor/terminal/chat) + tab/split layout are resident in their
  // own stores and are restored via `loadWorkspaceView`, not here.
  useExplorerStore.setState(snap.explorer);
  useGitStore.setState(snap.git);
  useKnowledgeStore.setState(snap.knowledge);
  useKnowledgeMetaStore.setState(snap.knowledgeMeta);

  snap.touchedAt = ++clock;
  return true;
}

/** Drop a workspace's snapshot entirely (on close). */
export function evictSnapshot(workspaceId: string): void {
  cache.delete(workspaceId);
}

/**
 * The persist hash captured for this workspace, or null if no snapshot. Used by
 * the flush coordinator to skip redundant disk writes when nothing changed.
 */
export function persistHashOf(workspaceId: string): string | null {
  return cache.get(workspaceId)?.persistHash ?? null;
}

/** Evict the least-recently-restored snapshot when over the cap. The `keep`
 *  workspace (the one just captured/active) is never evicted. Chat sessions —
 *  the memory hog — are dropped first by virtue of dropping the whole entry. */
function evictIfNeeded(keep: string): void {
  while (cache.size > LRU_CAP) {
    let oldestId: string | null = null;
    let oldest = Infinity;
    for (const [id, snap] of cache) {
      if (id === keep) continue;
      if (snap.touchedAt < oldest) {
        oldest = snap.touchedAt;
        oldestId = id;
      }
    }
    if (!oldestId) break;
    cache.delete(oldestId);
  }
}
