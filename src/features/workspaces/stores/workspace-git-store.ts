import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createSelectors } from "@/lib/create-selectors";

export interface GitSummary {
  isRepo: boolean;
  branch: string;
  headSubject: string;
  dirty: boolean;
  additions: number;
  deletions: number;
}

interface State {
  /** Cached per-workspace git summaries, keyed by project path. */
  summaries: Record<string, GitSummary>;
  actions: {
    /** Fetch a workspace's summary the FIRST time only. Cached at module scope,
     *  so opening/closing the workspace switcher renders instantly from cache
     *  and never recalculates git status/diff. */
    ensure: (path: string) => void;
    /** Force a silent background refetch (used when git state changes). */
    refresh: (path: string) => void;
  };
}

// Module-level so the cache + fetched/in-flight bookkeeping survive the sidebar
// unmounting and remounting (the whole point: don't recompute on every open).
const fetched = new Set<string>();
const inflight = new Set<string>();
let listenerReady = false;

// Coalesce bursty working-tree edits (every keystroke-save fires the fs
// watcher) into one `git diff` per path. Cleared after the trailing refresh.
const debounce = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleRefresh(path: string, refresh: (p: string) => void) {
  const pending = debounce.get(path);
  if (pending) clearTimeout(pending);
  debounce.set(
    path,
    setTimeout(() => {
      debounce.delete(path);
      refresh(path);
    }, 250),
  );
}

export const useWorkspaceGitStore = createSelectors(
  create<State>((set, get) => {
    function ensureListener() {
      if (listenerReady) return;
      listenerReady = true;
      // One global listener for the app's lifetime: a git change to any project
      // silently refreshes that project's cached summary in the background. The
      // UI updates only if the sidebar happens to be mounted; otherwise the
      // fresh value is simply ready for the next open.
      //
      // `atlas:git-changed` only fires on commit / checkout / branch / stage
      // (the watcher watches .git/HEAD|refs|index, NOT the working tree), so a
      // plain unstaged edit (+N/-M) would never reach us. We ALSO listen to the
      // fs working-tree watcher (`atlas:explorer:changed`) so the live +/-
      // counts track uncommitted edits, mirroring the source-control panel.
      void listen<{ project?: string }>("atlas:git-changed", (e) => {
        const p = e.payload?.project;
        if (p && fetched.has(p)) get().actions.refresh(p);
      });
      void listen<{ dirs?: string[]; fullRefresh?: boolean }>("atlas:explorer:changed", (e) => {
        const refresh = get().actions.refresh;
        // Opaque batch (rename, etc.): we can't pinpoint dirs — refresh every
        // cached workspace.
        if (e.payload?.fullRefresh || !e.payload?.dirs?.length) {
          for (const p of fetched) scheduleRefresh(p, refresh);
          return;
        }
        // Match each touched dir to the workspace whose root contains it.
        for (const p of fetched) {
          const hit = e.payload.dirs.some((d) => d === p || d.startsWith(p + "/"));
          if (hit) scheduleRefresh(p, refresh);
        }
      });
    }

    async function load(path: string) {
      if (inflight.has(path)) return;
      inflight.add(path);
      try {
        const s = await invoke<GitSummary>("git_workspace_summary", { path });
        fetched.add(path);
        set((st) => ({ summaries: { ...st.summaries, [path]: s } }));
      } catch {
        // Leave it unfetched so a later `ensure` retries.
      } finally {
        inflight.delete(path);
      }
    }

    return {
      summaries: {},
      actions: {
        ensure: (path) => {
          ensureListener();
          if (!fetched.has(path)) void load(path);
        },
        refresh: (path) => void load(path),
      },
    };
  }),
);

/** Drop the fetched bookkeeping so the incoming org's paths refetch fresh on
 *  the next `ensure`. Called from `switchOrg()`. The `summaries` map itself is
 *  kept — it's path-keyed data that is org-agnostic and still valid; only the
 *  "already fetched, skip" flags go, so summaries re-validate after a switch. */
export function resetGitSummariesForOrgSwitch() {
  fetched.clear();
}
