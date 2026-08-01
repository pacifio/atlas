import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { createSelectors } from "@/lib/create-selectors";
import { logEvent } from "@/features/log/lib/log";
import { flushAll } from "../lib/flush-registry";
import {
  captureSnapshot,
  restoreSnapshot,
  evictSnapshot,
} from "../lib/workspace-snapshot";
import { revalidateWorkspace } from "../lib/workspace-revalidate";
import {
  useProjectStore,
  scheduleAppStateSave,
  loadProjectStores,
} from "@/features/project/stores/project-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { useTerminalStore } from "@/features/terminal/stores/terminal-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { isWorkspaceRunning } from "../lib/agent-activity";

/** The active org id, used to tag newly-created workspaces/groups so they
 *  belong to the org the user is currently in. Read lazily to avoid an
 *  import-time dependency cycle with the org store. */
const activeOrgId = (): string | undefined =>
  useOrgStore.getState().activeOrganisationId ?? undefined;

/** Default hot-set cap — how many workspaces stay mounted/resident at once.
 *  Set above a typical open-project count (users commonly keep ~7) so cycling
 *  through them doesn't LRU-evict one and force an expensive cold reload
 *  (re-index + re-analyze) on switch-back. Raise cautiously: each resident
 *  workspace keeps its subtree mounted. */
const DEFAULT_MAX_MOUNTED = 8;

/**
 * A single open workspace = one project + its UI-state identity. `id` is the
 * stable key that replaces the per-window `webview.label()` everywhere Rust
 * keyed state (file index, git watcher, mention cache, recent files). Mirrors
 * `src-tauri/src/state/app_state.rs:Workspace`.
 */
export interface Workspace {
  id: string;
  name: string;
  path: string;
  groupId: string | null;
  /** Owning Organisation (mirrors `app_state.rs:Workspace::org_id`). The
   *  sidebar shows only the active org's workspaces. Legacy/undefined is
   *  treated as belonging to the active org during the migration window. */
  orgId?: string;
  /** Optional git remote — the only field besides id/name that syncs to the
   *  server (`workspace_refs.git_url`) for one-click clone. */
  gitUrl?: string;
  color?: string;
  /** Pinned to the top of the sidebar + prioritized to stay in the hot set. */
  pinned?: boolean;
  /** ISO-8601 of the last time this was the active workspace. */
  lastActiveAt?: string;
}

/** A user-defined collapsible folder grouping workspaces in the sidebar. */
export interface WorkspaceGroup {
  id: string;
  name: string;
  order: number;
  /** Owning Organisation (mirrors `Workspace.orgId`). */
  orgId?: string;
  /** Pinned groups float to the top of the Recent tier. */
  pinned?: boolean;
}

interface WorkspaceState {
  /** The full project REGISTRY — every known project (opened, recent, or
   *  bookmarked-for-later). Unbounded; lightweight metadata only. */
  workspaces: Workspace[];
  groups: WorkspaceGroup[];
  activeWorkspaceId: string | null;
  /** The bounded HOT set: workspaces actually MOUNTED in CenterPanel + holding
   *  resident Rust state. CenterPanel renders only these. Capped at
   *  `maxMounted` (Chrome-style tab discarding). */
  mountedWorkspaceIds: string[];
  /** Hot-set cap. Beyond this, the LRU evictable (not active/pinned/running)
   *  workspace is discarded from RAM and cold-loads on revisit. */
  maxMounted: number;
  /** Cmd+. sidebar visibility. */
  sidebarOpen: boolean;
  /** When true the workspace sidebar is DOCKED (in-flow, pushes the layout)
   *  instead of the default OVERLAY. A user preference, persisted to
   *  localStorage. `sidebarOpen` still gates visibility in both modes. */
  sidebarPinned: boolean;
  /** Group whose header is currently in inline-rename mode (transient, not
   *  persisted). Lives in the store so it survives the virtualized row
   *  remounting and so a freshly-created group can open straight into rename. */
  editingGroupId: string | null;
  /** Workspace whose name is currently in inline-rename mode (transient, not
   *  persisted). Lives in the store — like `editingGroupId` — so it survives
   *  the virtualized row remounting. */
  editingWorkspaceId: string | null;
  /** Guards re-entrant switches while a flush/restore is in flight. */
  switching: boolean;
  /** OPTIMISTIC selection target — set the instant a workspace is clicked so the
   *  switcher highlight updates immediately, before the (slow) switch completes.
   *  The sidebar highlights `optimisticActiveId ?? activeWorkspaceId`; cleared
   *  when the switch settles. */
  optimisticActiveId: string | null;
  actions: {
    /** Add a workspace for `path`, or focus the existing one if `path` is
     *  already open. Returns the workspace id. Switches to it (mounts it). */
    addWorkspace: (path: string) => Promise<string>;
    /** Add a registry entry for `path` WITHOUT opening/mounting it — a
     *  bookmark for "open later". Returns the id (or the existing one). */
    addProjectEntry: (path: string) => string;
    /** Flush the outgoing workspace, then restore the incoming one. */
    switchTo: (id: string) => Promise<void>;
    /** Flush + remove a workspace from the registry, tearing down its state. */
    closeWorkspace: (id: string) => Promise<void>;
    /** Tear down EVERY mounted workspace + clear the active pointer, without
     *  touching the registry. Used by the org switch: the outgoing org's whole
     *  hot set is discarded (RAM freed, Rust watchers stopped) before the new
     *  org's workspaces load. Does NOT flush — the caller flushes the active
     *  workspace first (its layout mirror is the only unsaved state). */
    teardownForOrgSwitch: () => void;
    /** Purge every workspace + group belonging to `orgId` from the registry
     *  (tearing down any still mounted). Used by org deletion. */
    removeWorkspacesForOrg: (orgId: string) => void;
    /** Ensure `id` is in the hot set, evicting the LRU evictable workspace if
     *  that pushes the set over `maxMounted`. */
    ensureMounted: (id: string) => void;
    pin: (id: string) => void;
    unpin: (id: string) => void;
    setColor: (id: string, color: string | null) => void;
    rename: (id: string, name: string) => void;
    /** Enter inline-rename for a workspace row. */
    beginRenameWorkspace: (id: string) => void;
    /** Leave workspace inline-rename (commit or cancel). */
    endRenameWorkspace: () => void;
    /** Move a workspace into a group (or ungroup with `null`). */
    setGroup: (id: string, groupId: string | null) => void;
    reorder: (orderedIds: string[]) => void;
    addGroup: (name: string) => string;
    renameGroup: (id: string, name: string) => void;
    /** Enter inline-rename for a group header. */
    beginRenameGroup: (id: string) => void;
    /** Leave inline-rename (commit or cancel). */
    endRenameGroup: () => void;
    removeGroup: (id: string) => void;
    pinGroup: (id: string) => void;
    unpinGroup: (id: string) => void;
    toggleSidebar: () => void;
    setSidebarOpen: (open: boolean) => void;
    /** Toggle docked (pinned) vs overlay. Pinning also opens the sidebar so it
     *  docks into view immediately. */
    toggleSidebarPinned: () => void;
    setSidebarPinned: (pinned: boolean) => void;
    /** One-shot hydration from Rust `AppState` on boot. */
    hydrate: (payload: {
      workspaces: Workspace[];
      groups: WorkspaceGroup[];
      activeWorkspaceId: string | null;
    }) => void;
  };
}

const uuid = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `ws-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const nameOf = (path: string): string => path.split("/").pop() || path;

/** Latest workspace id clicked while a switch was already in flight. The current
 *  switch drains it in its `finally`, so rapid clicks coalesce to the last one
 *  (and are never dropped) instead of being ignored by the re-entrancy guard. */
let pendingSwitchTarget: string | null = null;

/**
 * Tear a workspace OUT of the hot set: free its heavy RAM (chat history,
 * terminal trees), drop its panel snapshot, unmount its CenterPanel subtree
 * (→ BlockTerminal closes its PTYs), and stop its resident Rust watchers.
 * Does NOT flush — a background workspace's editor-state was already persisted
 * at its last switch-away (and the layout mirror is the ACTIVE workspace's, so
 * flushing here would be wrong). Synchronous on the JS side; Rust teardown is
 * fire-and-forget. Does NOT touch `mountedWorkspaceIds`/`workspaces` — the
 * caller manages those.
 */
function teardownHot(id: string): void {
  const view = useLayoutStore.getState().viewsByWs[id];
  const tabIds = view ? view.tabs.map((t) => t.id) : [];
  if (tabIds.length) {
    useChatStore.getState().actions.removeSessions(tabIds);
    useTerminalStore.getState().actions.removeTabs(tabIds);
  }
  evictSnapshot(id);
  useLayoutStore.getState().actions.removeWorkspaceView(id);
  void invoke("fileindex_close_project", { workspaceId: id }).catch(() => {});
  void invoke("git_watch_stop", { workspaceId: id }).catch(() => {});
  void invoke("recent_files_close_project", { workspaceId: id }).catch(
    () => {},
  );
  void invoke("mention_cache_clear", { workspaceId: id }).catch(() => {});
}

const SIDEBAR_PINNED_KEY = "atlas.sidebar.pinned";
/** Read the persisted dock preference (localStorage — a self-contained UI pref,
 *  not part of the Rust-backed AppState). */
function readSidebarPinned(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_PINNED_KEY) === "1";
  } catch {
    return false;
  }
}

export const useWorkspaceStore = createSelectors(
  create<WorkspaceState>()((set, get) => ({
    workspaces: [],
    groups: [],
    activeWorkspaceId: null,
    mountedWorkspaceIds: [],
    maxMounted: DEFAULT_MAX_MOUNTED,
    sidebarOpen: false,
    sidebarPinned: readSidebarPinned(),
    switching: false,
    optimisticActiveId: null,
    editingGroupId: null,
    editingWorkspaceId: null,
    actions: {
      addWorkspace: async (path: string) => {
        const existing = get().workspaces.find((w) => w.path === path);
        if (existing) {
          await get().actions.switchTo(existing.id);
          return existing.id;
        }
        const ws: Workspace = {
          id: uuid(),
          name: nameOf(path),
          path,
          groupId: null,
          orgId: activeOrgId(),
        };
        set((s) => ({ workspaces: [...s.workspaces, ws] }));
        scheduleAppStateSave();
        await get().actions.switchTo(ws.id);
        return ws.id;
      },

      addProjectEntry: (path: string) => {
        const existing = get().workspaces.find((w) => w.path === path);
        if (existing) return existing.id;
        const ws: Workspace = {
          id: uuid(),
          name: nameOf(path),
          path,
          groupId: null,
          orgId: activeOrgId(),
        };
        set((s) => ({ workspaces: [...s.workspaces, ws] }));
        scheduleAppStateSave();
        return ws.id;
      },

      ensureMounted: (id: string) => {
        const st = get();
        if (st.mountedWorkspaceIds.includes(id)) return;
        let mounted = [...st.mountedWorkspaceIds, id];
        const byId = (wid: string) => st.workspaces.find((w) => w.id === wid);
        const evictable = (wid: string): boolean => {
          if (wid === id || wid === st.activeWorkspaceId) return false;
          const w = byId(wid);
          if (!w) return true;
          if (w.pinned) return false;
          if (isWorkspaceRunning(w.path)) return false;
          return true;
        };
        // Evict the least-recently-active evictable workspaces until under cap.
        // LRU-by-lastActiveAt naturally protects the just-left (2nd-newest)
        // workspace, so A→B→A stays warm.
        while (mounted.length > st.maxMounted) {
          const candidates = mounted
            .filter(evictable)
            .sort((a, b) =>
              (byId(a)?.lastActiveAt ?? "").localeCompare(
                byId(b)?.lastActiveAt ?? "",
              ),
            );
          if (candidates.length === 0) break; // all pinned/running — exceed cap
          const lru = candidates[0];
          teardownHot(lru);
          mounted = mounted.filter((x) => x !== lru);
        }
        set({ mountedWorkspaceIds: mounted });
      },

      pin: (id: string) => {
        set((s) => ({
          workspaces: s.workspaces.map((w) =>
            w.id === id ? { ...w, pinned: true } : w,
          ),
        }));
        // Pinning warms the workspace so it's instant.
        get().actions.ensureMounted(id);
        scheduleAppStateSave();
      },

      unpin: (id: string) => {
        set((s) => ({
          workspaces: s.workspaces.map((w) =>
            w.id === id ? { ...w, pinned: false } : w,
          ),
        }));
        scheduleAppStateSave();
      },

      switchTo: async (id: string) => {
        const { activeWorkspaceId, switching, workspaces } = get();
        const target = workspaces.find((w) => w.id === id);
        if (!target) return;

        // INSTANT UI response — before any guard or heavy work:
        //  • close the OVERLAY switcher (its slide-out animation covers the
        //    switch's eventual load latency). When DOCKED (pinned) the sidebar
        //    is a persistent panel, so we leave it open — closing it would make
        //    the whole layout jump on every switch.
        //  • optimistically highlight the selection so the clicked item updates
        //    immediately even though the real `activeWorkspaceId` lags behind.
        const pinnedNow = get().sidebarPinned;
        const wasOpen = get().sidebarOpen && !pinnedNow;
        set({
          optimisticActiveId: id,
          ...(pinnedNow ? {} : { sidebarOpen: false }),
        });

        // A switch already in flight → don't DROP the click; remember the latest
        // target and run it when the current one settles (coalesce). The close +
        // optimistic highlight above already gave instant feedback.
        if (switching) {
          pendingSwitchTarget = id;
          return;
        }
        if (id === activeWorkspaceId) {
          // Already active — make sure currentProject reflects it (covers
          // the very first switch after boot) but skip the flush dance.
          useProjectStore.getState().actions.setActiveProject({
            name: target.name,
            path: target.path,
          });
          set({ optimisticActiveId: null });
          return;
        }

        set({ switching: true });
        // Let the panel-close + optimistic highlight PAINT (and the slide-out
        // animation start) before the synchronous switch work seizes the main
        // thread — otherwise React batches the close with the heavy work and the
        // panel appears to hang. A macrotask (rAF) yields past paint; the
        // microtask from `await flushAll` would not. Skip when the panel was
        // already closed (keyboard/programmatic switch) — no animation to protect.
        if (wasOpen && typeof requestAnimationFrame === "function") {
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
        }
        try {
          // 1) Commit the OUTGOING workspace's tab/split VIEW into the layout
          //    store (its tab subtree stays MOUNTED + hidden in CenterPanel),
          //    snapshot its light panel-data, and kick its disk flush
          //    fire-and-forget. We do NOT reset chat/editor/terminal — they
          //    stay resident across switches so nothing remounts.
          const layout = useLayoutStore.getState().actions;
          const outgoingPath =
            useProjectStore.getState().currentProject?.path ?? null;
          if (activeWorkspaceId) {
            layout.commitWorkspaceView(activeWorkspaceId);
            // Flush the OUTGOING workspace's pending writes (notably the KB
            // editor's unsaved buffer) to disk BEFORE snapshotting and swapping.
            // Awaited — not fire-and-forget — so a note edited/saved in this
            // workspace can never be stranded or overwritten by the switch race.
            // The snapshot is then taken AFTER the flush so it reflects the
            // just-saved state. `flushAll` swallows per-store errors, so a bad
            // flush can't block the switch.
            await flushAll({
              workspaceId: activeWorkspaceId,
              path: outgoingPath,
            });
            captureSnapshot(activeWorkspaceId);
          }

          // 2) Make the switch authoritative.
          const nowIso = new Date().toISOString();
          set((s) => ({
            activeWorkspaceId: id,
            workspaces: s.workspaces.map((w) =>
              w.id === id ? { ...w, lastActiveAt: nowIso } : w,
            ),
          }));

          // 3) Point the project store at the incoming workspace. This sets
          //    `currentProject`, which the App-level effects observe to drive
          //    the per-workspace Rust lifecycle (file index, git watch,
          //    recent files) keyed by `activeWorkspaceId`.
          useProjectStore.getState().actions.setActiveProject({
            name: target.name,
            path: target.path,
          });

          // 4) Residency: a workspace already in the HOT set is instant; a
          //    cold one joins the hot set (evicting the LRU evictable if that
          //    exceeds the cap) and loads from disk/Rust.
          const wasHot = get().mountedWorkspaceIds.includes(id);
          get().actions.ensureMounted(id);

          if (wasHot) {
            // WARM: its subtree is already mounted — swap light panel data +
            // make its column-set visible. No remount.
            restoreSnapshot(id);
            layout.loadWorkspaceView(id);
            revalidateWorkspace(id, target.path);
          } else {
            // COLD: mount fresh. `loadEditorState` (inside loadProjectStores)
            // appends saved tabs by id — idempotent against the seeded view.
            layout.loadWorkspaceView(id);
            await loadProjectStores(target.path);
            captureSnapshot(id);
            layout.commitWorkspaceView(id);
          }

          scheduleAppStateSave();
          logEvent({
            source: "project",
            kind: "workspace-switch",
            summary: target.name,
            projectPath: target.path,
            projectName: target.name,
            payload: { workspaceId: id },
          });
        } finally {
          set({ switching: false });
          // Drain a coalesced click: jump straight to the LATEST target the user
          // selected while this switch ran. Keep the optimistic highlight on it
          // until that switch resolves; otherwise clear it (real active id wins).
          const next = pendingSwitchTarget;
          pendingSwitchTarget = null;
          if (next && next !== get().activeWorkspaceId) {
            void get().actions.switchTo(next);
          } else {
            set({ optimisticActiveId: null });
          }
        }
      },

      closeWorkspace: async (id: string) => {
        const { workspaces, activeWorkspaceId } = get();
        const closing = workspaces.find((w) => w.id === id);
        if (!closing) return;

        const isActive = id === activeWorkspaceId;
        const closingPath = closing.path;
        if (isActive) {
          // Active workspace: the layout mirror is its tabs, so flush is correct.
          await flushAll({ workspaceId: id, path: closingPath });
        }

        // Free RAM + unmount its subtree (closes PTYs) + stop Rust watchers,
        // then drop it from the hot set AND the registry.
        teardownHot(id);
        const remaining = workspaces.filter((w) => w.id !== id);
        set((s) => ({
          workspaces: remaining,
          mountedWorkspaceIds: s.mountedWorkspaceIds.filter((x) => x !== id),
        }));

        if (isActive) {
          // Switch to the most-recently-active remaining workspace, or clear.
          const next = [...remaining].sort((a, b) =>
            (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? ""),
          )[0];
          if (next) {
            set({ activeWorkspaceId: null });
            await get().actions.switchTo(next.id);
          } else {
            set({ activeWorkspaceId: null });
            useProjectStore.getState().actions.setActiveProject(null);
          }
        }
        scheduleAppStateSave();
      },

      teardownForOrgSwitch: () => {
        const { mountedWorkspaceIds } = get();
        for (const id of mountedWorkspaceIds) teardownHot(id);
        set({
          mountedWorkspaceIds: [],
          activeWorkspaceId: null,
          optimisticActiveId: null,
        });
      },

      removeWorkspacesForOrg: (orgId: string) => {
        const { workspaces, mountedWorkspaceIds } = get();
        const removedIds = new Set(
          workspaces.filter((w) => w.orgId === orgId).map((w) => w.id),
        );
        // Tear down any that are still mounted (defensive — a deleted org is
        // normally switched away from first, so its set is already cold).
        for (const id of mountedWorkspaceIds) {
          if (removedIds.has(id)) teardownHot(id);
        }
        set((s) => ({
          workspaces: s.workspaces.filter((w) => w.orgId !== orgId),
          groups: s.groups.filter((g) => g.orgId !== orgId),
          mountedWorkspaceIds: s.mountedWorkspaceIds.filter(
            (x) => !removedIds.has(x),
          ),
        }));
      },

      setColor: (id, color) => {
        set((s) => ({
          workspaces: s.workspaces.map((w) =>
            w.id === id ? { ...w, color: color ?? undefined } : w,
          ),
        }));
        scheduleAppStateSave();
      },
      rename: (id, name) => {
        set((s) => ({
          workspaces: s.workspaces.map((w) =>
            w.id === id ? { ...w, name } : w,
          ),
        }));
        scheduleAppStateSave();
      },
      beginRenameWorkspace: (id) => set({ editingWorkspaceId: id }),
      endRenameWorkspace: () => set({ editingWorkspaceId: null }),
      setGroup: (id, groupId) => {
        set((s) => ({
          workspaces: s.workspaces.map((w) =>
            w.id === id ? { ...w, groupId } : w,
          ),
        }));
        scheduleAppStateSave();
      },
      reorder: (orderedIds) => {
        set((s) => {
          const byId = new Map(s.workspaces.map((w) => [w.id, w]));
          const reordered = orderedIds
            .map((wid) => byId.get(wid))
            .filter((w): w is Workspace => Boolean(w));
          // Append any workspaces missing from the order list (defensive).
          for (const w of s.workspaces) {
            if (!orderedIds.includes(w.id)) reordered.push(w);
          }
          return { workspaces: reordered };
        });
        scheduleAppStateSave();
      },
      addGroup: (name) => {
        const group: WorkspaceGroup = {
          id: uuid(),
          name,
          order: get().groups.length,
          orgId: activeOrgId(),
        };
        // Open the new group straight into inline-rename so the user can name it.
        set((s) => ({
          groups: [...s.groups, group],
          editingGroupId: group.id,
        }));
        scheduleAppStateSave();
        return group.id;
      },
      renameGroup: (id, name) => {
        set((s) => ({
          groups: s.groups.map((g) => (g.id === id ? { ...g, name } : g)),
        }));
        scheduleAppStateSave();
      },
      beginRenameGroup: (id) => set({ editingGroupId: id }),
      endRenameGroup: () => set({ editingGroupId: null }),
      removeGroup: (id) => {
        set((s) => ({
          groups: s.groups.filter((g) => g.id !== id),
          // Ungroup any workspaces that belonged to it.
          workspaces: s.workspaces.map((w) =>
            w.groupId === id ? { ...w, groupId: null } : w,
          ),
        }));
        scheduleAppStateSave();
      },
      pinGroup: (id) => {
        set((s) => ({
          groups: s.groups.map((g) =>
            g.id === id ? { ...g, pinned: true } : g,
          ),
        }));
        scheduleAppStateSave();
      },
      unpinGroup: (id) => {
        set((s) => ({
          groups: s.groups.map((g) =>
            g.id === id ? { ...g, pinned: false } : g,
          ),
        }));
        scheduleAppStateSave();
      },
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      toggleSidebarPinned: () =>
        set((s) => {
          const sidebarPinned = !s.sidebarPinned;
          try {
            localStorage.setItem(SIDEBAR_PINNED_KEY, sidebarPinned ? "1" : "0");
          } catch {
            /* ignore */
          }
          // Pinning docks it into view immediately; unpinning leaves the
          // (now overlay) sidebar in whatever open state it was.
          return sidebarPinned
            ? { sidebarPinned, sidebarOpen: true }
            : { sidebarPinned };
        }),
      setSidebarPinned: (pinned) => {
        try {
          localStorage.setItem(SIDEBAR_PINNED_KEY, pinned ? "1" : "0");
        } catch {
          /* ignore */
        }
        set({ sidebarPinned: pinned });
      },

      hydrate: (payload) => {
        set({
          workspaces: payload.workspaces ?? [],
          groups: payload.groups ?? [],
          activeWorkspaceId: payload.activeWorkspaceId ?? null,
        });
      },
    },
  })),
);
