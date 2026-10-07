import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { createSelectors } from "@/lib/create-selectors";
import { basename } from "@/lib/paths";
import { toast } from "sonner";
import { logEvent } from "@/features/log/lib/log";
import { flushAll } from "../lib/flush-registry";
import { captureSnapshot, restoreSnapshot, evictSnapshot } from "../lib/project-snapshot";
import { revalidateProject } from "../lib/project-revalidate";
import {
  useAppStore,
  scheduleAppStateSave,
  loadProjectStores,
} from "@/features/app/stores/app-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { useTerminalStore } from "@/features/terminal/stores/terminal-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { isProjectRunning } from "../lib/agent-activity";
import {
  busySessions,
  cancelBusySessions,
  useStopAgentsConfirmStore,
} from "../lib/stop-agents-confirm";
import { markFileIndexClosedFor } from "@/features/file-picker/lib/file-picker-api";
import { instructionSync } from "../lib/instruction-sync-api";

/** The org id used to tag newly-created projects/groups so they belong to
 *  the org the user is currently in. Read lazily to avoid an import-time
 *  dependency cycle with the org store. Falls back to the first org when no
 *  active org is set (org store mid-hydration) — an untagged row would render
 *  in EVERY org's sidebar under the strict per-org filters, so creation must
 *  never mint `orgId: undefined`. Returns undefined only when the org store
 *  holds zero orgs (pre-bootstrap race; Rust always seeds "Personal"), and
 *  callers refuse to create in that case. */
const requireActiveOrgId = (): string | undefined => {
  const org = useOrgStore.getState();
  return org.activeOrganisationId ?? org.organisations[0]?.id;
};

/** The refusal above used to be a log line and nothing else — and that log
 *  entry is only persisted once a project exists, so a fresh install where
 *  the Rust seed had not run showed "Open Folder" doing nothing at all. Say
 *  so on screen: the state is not recoverable from inside the app, since the
 *  org switcher hides itself with no active org. */
const NO_ORG_MESSAGE =
  "Atlas couldn't find an organisation to own this. Restart Atlas and try again.";

const refuseWithoutOrg = (summary: string, payload?: Record<string, unknown>): null => {
  logEvent({ source: "project", kind: "project-add-refused", summary, payload });
  toast.error(NO_ORG_MESSAGE);
  return null;
};

/** Default hot-set cap — how many projects stay mounted/resident at once.
 *  Set above a typical open-project count (users commonly keep ~7) so cycling
 *  through them doesn't LRU-evict one and force an expensive cold reload
 *  (re-index + re-analyze) on switch-back. Raise cautiously: each resident
 *  project keeps its subtree mounted. */
const DEFAULT_MAX_MOUNTED = 8;

/**
 * A single open project = one project + its UI-state identity. `id` is the
 * stable key that replaces the per-window `webview.label()` everywhere Rust
 * keyed state (file index, git watcher, mention cache, recent files). Mirrors
 * `src-tauri/src/state/app_state.rs:Project`.
 */
export interface Project {
  id: string;
  name: string;
  path: string;
  groupId: string | null;
  /** Owning Organisation (mirrors `app_state.rs:Project::org_id`). Every
   *  render surface filters STRICTLY by `orgId === activeOrganisationId` —
   *  an untagged row is invisible. Creation always tags (see
   *  `requireActiveOrgId`), Rust `migrate()` backfills legacy null rows at
   *  boot, and the add actions adopt an in-memory null row in place. The
   *  field stays optional only because rows can transit through JSON where
   *  `undefined` is dropped. */
  orgId?: string;
  /** Optional git remote — the only field besides id/name that syncs to the
   *  server (`project_refs.git_url`) for one-click clone. */
  gitUrl?: string;
  color?: string;
  /** Pinned to the top of the sidebar + prioritized to stay in the hot set. */
  pinned?: boolean;
  /** ISO-8601 of the last time this was the active project. */
  lastActiveAt?: string;
}

/** A user-defined collapsible folder grouping projects in the sidebar. */
export interface ProjectGroup {
  id: string;
  name: string;
  order: number;
  /** Owning Organisation (mirrors `Project.orgId`). */
  orgId?: string;
  /** Pinned groups float to the top of the Recent tier. */
  pinned?: boolean;
}

interface ProjectState {
  /** The full project REGISTRY — every known project (opened, recent, or
   *  bookmarked-for-later). Unbounded; lightweight metadata only. */
  projects: Project[];
  groups: ProjectGroup[];
  activeProjectId: string | null;
  /** The bounded HOT set: projects actually MOUNTED in CenterPanel + holding
   *  resident Rust state. CenterPanel renders only these. Capped at
   *  `maxMounted` (Chrome-style tab discarding). */
  mountedProjectIds: string[];
  /** Hot-set cap. Beyond this, the LRU evictable (not active/pinned/running)
   *  project is discarded from RAM and cold-loads on revisit. */
  maxMounted: number;
  /** Cmd+. sidebar visibility. */
  sidebarOpen: boolean;
  /** When true the project sidebar is DOCKED (in-flow, pushes the layout)
   *  instead of the default OVERLAY. A user preference, persisted to
   *  localStorage. `sidebarOpen` still gates visibility in both modes. */
  sidebarPinned: boolean;
  /** Group whose header is currently in inline-rename mode (transient, not
   *  persisted). Lives in the store so it survives the virtualized row
   *  remounting and so a freshly-created group can open straight into rename. */
  editingGroupId: string | null;
  /** Project whose name is currently in inline-rename mode (transient, not
   *  persisted). Lives in the store — like `editingGroupId` — so it survives
   *  the virtualized row remounting. */
  editingProjectId: string | null;
  /** Guards re-entrant switches while a flush/restore is in flight. */
  switching: boolean;
  /** OPTIMISTIC selection target — set the instant a project is clicked so the
   *  switcher highlight updates immediately, before the (slow) switch completes.
   *  The sidebar highlights `optimisticActiveId ?? activeProjectId`; cleared
   *  when the switch settles. */
  optimisticActiveId: string | null;
  actions: {
    /** Add a project for `path`, or focus the existing one if `path` is
     *  already open. Returns the project id. Switches to it (mounts it). */
    addProject: (path: string) => Promise<string | null>;
    /** Add a registry entry for `path` WITHOUT opening/mounting it — a
     *  bookmark for "open later". Returns the id (or the existing one). */
    addProjectEntry: (path: string) => string | null;
    /** Flush the outgoing project, then restore the incoming one. */
    switchTo: (id: string) => Promise<void>;
    /** Flush + remove a project from the registry, tearing down its state. */
    closeProject: (id: string) => Promise<void>;
    /** Tear down EVERY mounted project + clear the active pointer, without
     *  touching the registry. Used by the org switch: the outgoing org's whole
     *  hot set is discarded (RAM freed, Rust watchers stopped) before the new
     *  org's projects load. Does NOT flush — the caller flushes the active
     *  project first (its layout mirror is the only unsaved state). */
    teardownForOrgSwitch: () => void;
    /** Purge every project + group belonging to `orgId` from the registry
     *  (tearing down any still mounted). Used by org deletion. */
    removeProjectsForOrg: (orgId: string) => void;
    /** Ensure `id` is in the hot set, evicting the LRU evictable project if
     *  that pushes the set over `maxMounted`. */
    ensureMounted: (id: string) => void;
    pin: (id: string) => void;
    unpin: (id: string) => void;
    setColor: (id: string, color: string | null) => void;
    rename: (id: string, name: string) => void;
    /** Enter inline-rename for a project row. */
    beginRenameProject: (id: string) => void;
    /** Leave project inline-rename (commit or cancel). */
    endRenameProject: () => void;
    /** Move a project into a group (or ungroup with `null`). */
    setGroup: (id: string, groupId: string | null) => void;
    reorder: (orderedIds: string[]) => void;
    addGroup: (name: string) => string | null;
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
      projects: Project[];
      groups: ProjectGroup[];
      activeProjectId: string | null;
    }) => void;
  };
}

const uuid = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `ws-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const nameOf = (path: string): string => basename(path);

/** Latest project id clicked while a switch was already in flight. The current
 *  switch drains it in its `finally`, so rapid clicks coalesce to the last one
 *  (and are never dropped) instead of being ignored by the re-entrancy guard. */
let pendingSwitchTarget: string | null = null;

/**
 * Tear a project OUT of the hot set: free its heavy RAM (chat history,
 * terminal trees), drop its panel snapshot, unmount its CenterPanel subtree
 * (→ BlockTerminal closes its PTYs), and stop its resident Rust watchers.
 * Does NOT flush — a background project's editor-state was already persisted
 * at its last switch-away (and the layout mirror is the ACTIVE project's, so
 * flushing here would be wrong). Synchronous on the JS side; Rust teardown is
 * fire-and-forget. Does NOT touch `mountedProjectIds`/`projects` — the
 * caller manages those.
 */
function teardownHot(id: string): void {
  // For the ACTIVE project the layout mirror is the live tab set and
  // `viewsByWs[id]` may be stale (it's only refreshed on switch-away) — commit
  // first, or tabs opened since the last switch are missed and their chat
  // sessions leak as headless backend actors.
  if (id === useProjectStore.getState().activeProjectId) {
    useLayoutStore.getState().actions.commitProjectView(id);
  }
  const view = useLayoutStore.getState().viewsByWs[id];
  const tabIds = view ? view.tabs.map((t) => t.id) : [];
  if (tabIds.length) {
    useChatStore.getState().actions.removeSessions(tabIds);
    useTerminalStore.getState().actions.removeTabs(tabIds);
  }
  evictSnapshot(id);
  useLayoutStore.getState().actions.removeProjectView(id);
  // The picker's no-IPC fast path must stop vouching for an index that is
  // about to be torn down.
  const path = useProjectStore.getState().projects.find((w) => w.id === id)?.path;
  if (path) {
    markFileIndexClosedFor(path);
    // Memory registry is keyed by cwd, not projectId — releases the engine,
    // its recursive FS watcher and the debounce task for this project.
    void invoke("memory_indexer_close_project", { cwd: path }).catch(() => {});
  }
  // `workspaceId` is the frozen IPC argument name for a project id — every
  // one of these commands has taken it since the multi-project model landed.
  void invoke("fileindex_close_project", { workspaceId: id }).catch(() => {});
  void invoke("git_watch_stop", { workspaceId: id }).catch(() => {});
  void instructionSync.stop(id).catch(() => {});
  void invoke("recent_files_close_project", { workspaceId: id }).catch(() => {});
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
/** Read once at module init so `sidebarOpen` and `sidebarPinned` below cannot
 *  disagree: pinned means DOCKED, and a docked sidebar that starts closed is
 *  invisible until the user opens it manually — the pin looked forgotten. */
const initialSidebarPinned = readSidebarPinned();

export const useProjectStore = createSelectors(
  create<ProjectState>()((set, get) => ({
    projects: [],
    groups: [],
    activeProjectId: null,
    mountedProjectIds: [],
    maxMounted: DEFAULT_MAX_MOUNTED,
    // Pinned restores OPEN — `toggleSidebarPinned` opens on pin, so the
    // persisted preference means "docked and showing" across restarts too.
    sidebarOpen: initialSidebarPinned,
    sidebarPinned: initialSidebarPinned,
    switching: false,
    optimisticActiveId: null,
    editingGroupId: null,
    editingProjectId: null,
    actions: {
      addProject: async (path: string) => {
        // Dedup by (path, ORG) — not path alone. Project identity is
        // per-organisation in the tag-in-place model: the sidebar filters by
        // `orgId === activeOrganisationId`, so matching a same-path project
        // that belongs to ANOTHER org and switching to it left the project
        // rendered in the center panel (currentProject is not org-filtered)
        // while invisible in the new org's switcher — the "added a project in
        // a fresh org and it never appeared" bug. Opening the same folder
        // from a second org now creates that org's own project row.
        const org = requireActiveOrgId();
        if (!org) {
          return refuseWithoutOrg("no organisation available to own a new project", { path });
        }
        const existing = get().projects.find((w) => w.path === path && w.orgId === org);
        if (existing) {
          await get().actions.switchTo(existing.id);
          return existing.id;
        }
        // Legacy untagged row for this path (predates the Rust org backfill):
        // adopt it into the active org in place instead of duplicating it.
        const legacy = get().projects.find((w) => w.path === path && w.orgId == null);
        if (legacy) {
          set((s) => ({
            projects: s.projects.map((w) => (w.id === legacy.id ? { ...w, orgId: org } : w)),
          }));
          scheduleAppStateSave();
          await get().actions.switchTo(legacy.id);
          return legacy.id;
        }
        const ws: Project = {
          id: uuid(),
          name: nameOf(path),
          path,
          groupId: null,
          orgId: org,
        };
        set((s) => ({ projects: [...s.projects, ws] }));
        scheduleAppStateSave();
        await get().actions.switchTo(ws.id);
        return ws.id;
      },

      addProjectEntry: (path: string) => {
        // Same (path, org) identity + legacy-adopt rules as addProject above.
        const org = requireActiveOrgId();
        if (!org) {
          return refuseWithoutOrg("no organisation available to own a new project entry", { path });
        }
        const existing = get().projects.find((w) => w.path === path && w.orgId === org);
        if (existing) return existing.id;
        const legacy = get().projects.find((w) => w.path === path && w.orgId == null);
        if (legacy) {
          set((s) => ({
            projects: s.projects.map((w) => (w.id === legacy.id ? { ...w, orgId: org } : w)),
          }));
          scheduleAppStateSave();
          return legacy.id;
        }
        const ws: Project = {
          id: uuid(),
          name: nameOf(path),
          path,
          groupId: null,
          orgId: org,
        };
        set((s) => ({ projects: [...s.projects, ws] }));
        scheduleAppStateSave();
        return ws.id;
      },

      ensureMounted: (id: string) => {
        const st = get();
        if (st.mountedProjectIds.includes(id)) return;
        let mounted = [...st.mountedProjectIds, id];
        const byId = (wid: string) => st.projects.find((w) => w.id === wid);
        const evictable = (wid: string): boolean => {
          if (wid === id || wid === st.activeProjectId) return false;
          const w = byId(wid);
          if (!w) return true;
          if (w.pinned) return false;
          if (isProjectRunning(w.path)) return false;
          return true;
        };
        // Evict the least-recently-active evictable projects until under cap.
        // LRU-by-lastActiveAt naturally protects the just-left (2nd-newest)
        // project, so A→B→A stays warm.
        while (mounted.length > st.maxMounted) {
          const candidates = mounted
            .filter(evictable)
            .sort((a, b) =>
              (byId(a)?.lastActiveAt ?? "").localeCompare(byId(b)?.lastActiveAt ?? ""),
            );
          if (candidates.length === 0) break; // all pinned/running — exceed cap
          const lru = candidates[0];
          teardownHot(lru);
          mounted = mounted.filter((x) => x !== lru);
        }
        set({ mountedProjectIds: mounted });
      },

      pin: (id: string) => {
        set((s) => ({
          projects: s.projects.map((w) => (w.id === id ? { ...w, pinned: true } : w)),
        }));
        // Pinning warms the project so it's instant.
        get().actions.ensureMounted(id);
        scheduleAppStateSave();
      },

      unpin: (id: string) => {
        set((s) => ({
          projects: s.projects.map((w) => (w.id === id ? { ...w, pinned: false } : w)),
        }));
        scheduleAppStateSave();
      },

      switchTo: async (id: string) => {
        const { activeProjectId, switching, projects } = get();
        const target = projects.find((w) => w.id === id);
        if (!target) return;

        // INSTANT UI response — before any guard or heavy work:
        //  • close the OVERLAY switcher (its slide-out animation covers the
        //    switch's eventual load latency). When DOCKED (pinned) the sidebar
        //    is a persistent panel, so we leave it open — closing it would make
        //    the whole layout jump on every switch.
        //  • optimistically highlight the selection so the clicked item updates
        //    immediately even though the real `activeProjectId` lags behind.
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
        if (id === activeProjectId) {
          // Already active — make sure currentProject reflects it (covers
          // the very first switch after boot) but skip the flush dance.
          useAppStore.getState().actions.setActiveProject({
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
          // 1) Commit the OUTGOING project's tab/split VIEW into the layout
          //    store (its tab subtree stays MOUNTED + hidden in CenterPanel),
          //    snapshot its light panel-data, and kick its disk flush
          //    fire-and-forget. We do NOT reset chat/editor/terminal — they
          //    stay resident across switches so nothing remounts.
          const layout = useLayoutStore.getState().actions;
          const outgoingPath = useAppStore.getState().currentProject?.path ?? null;
          if (activeProjectId) {
            layout.commitProjectView(activeProjectId);
            // Flush the OUTGOING project's pending writes (notably the KB
            // editor's unsaved buffer) to disk BEFORE snapshotting and swapping.
            // Awaited — not fire-and-forget — so a note edited/saved in this
            // project can never be stranded or overwritten by the switch race.
            // The snapshot is then taken AFTER the flush so it reflects the
            // just-saved state. `flushAll` swallows per-store errors, so a bad
            // flush can't block the switch.
            await flushAll({
              projectId: activeProjectId,
              path: outgoingPath,
              reason: "switch",
            });
            captureSnapshot(activeProjectId);
          }

          // 2) Make the switch authoritative.
          const nowIso = new Date().toISOString();
          set((s) => ({
            activeProjectId: id,
            projects: s.projects.map((w) => (w.id === id ? { ...w, lastActiveAt: nowIso } : w)),
          }));

          // 3) Point the project store at the incoming project. This sets
          //    `currentProject`, which the App-level effects observe to drive
          //    the per-project Rust lifecycle (file index, git watch,
          //    recent files) keyed by `activeProjectId`.
          useAppStore.getState().actions.setActiveProject({
            name: target.name,
            path: target.path,
          });

          // 4) Residency: a project already in the HOT set is instant; a
          //    cold one joins the hot set (evicting the LRU evictable if that
          //    exceeds the cap) and loads from disk/Rust.
          const wasHot = get().mountedProjectIds.includes(id);
          get().actions.ensureMounted(id);

          if (wasHot) {
            // WARM: its subtree is already mounted — swap light panel data +
            // make its column-set visible. No remount.
            restoreSnapshot(id);
            layout.loadProjectView(id);
            revalidateProject(id, target.path);
          } else {
            // COLD: mount fresh. `loadEditorState` (inside loadProjectStores)
            // appends saved tabs by id — idempotent against the seeded view.
            layout.loadProjectView(id);
            await loadProjectStores(target.path);
            captureSnapshot(id);
            layout.commitProjectView(id);
          }

          scheduleAppStateSave();
          logEvent({
            source: "project",
            kind: "project-switch",
            summary: target.name,
            projectPath: target.path,
            projectName: target.name,
            // `projectId`, not the `workspaceId` this used to say. The frozen
            // storage keys are frozen because a READER exists on the other
            // side; the activity log has none — the payload is free-form JSON
            // rendered for a human, and nothing groups, filters or joins on it.
            // Historic rows therefore reconcile exactly as well either way,
            // and keeping the old spelling would leave the only frontend
            // surface still saying "workspace" without a reason.
            payload: { projectId: id },
          });
        } finally {
          set({ switching: false });
          // Drain a coalesced click: jump straight to the LATEST target the user
          // selected while this switch ran. Keep the optimistic highlight on it
          // until that switch resolves; otherwise clear it (real active id wins).
          const next = pendingSwitchTarget;
          pendingSwitchTarget = null;
          if (next && next !== get().activeProjectId) {
            void get().actions.switchTo(next);
          } else {
            set({ optimisticActiveId: null });
          }
        }
      },

      closeProject: async (id: string) => {
        const { projects, activeProjectId } = get();
        const closing = projects.find((w) => w.id === id);
        if (!closing) return;

        const isActive = id === activeProjectId;
        const closingPath = closing.path;

        // Closing kills this project's running agents — confirm, then cancel
        // their turns so the adapters actually stop (drop alone leaves them
        // editing files headless).
        const busy = busySessions(closingPath).length;
        if (busy > 0) {
          const ok = await useStopAgentsConfirmStore.getState().actions.ask({
            count: busy,
            actionLabel: "Closing this project",
            confirmLabel: "Stop agents & close",
          });
          if (!ok) return;
          await cancelBusySessions(closingPath);
        }

        if (isActive) {
          // Active project: the layout mirror is its tabs, so flush is correct.
          await flushAll({ projectId: id, path: closingPath });
        }

        // Free RAM + unmount its subtree (closes PTYs) + stop Rust watchers,
        // then drop it from the hot set AND the registry.
        teardownHot(id);
        const remaining = projects.filter((w) => w.id !== id);
        set((s) => ({
          projects: remaining,
          mountedProjectIds: s.mountedProjectIds.filter((x) => x !== id),
        }));

        if (isActive) {
          // Switch to the most-recently-active remaining project, or clear.
          const next = [...remaining].sort((a, b) =>
            (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? ""),
          )[0];
          if (next) {
            set({ activeProjectId: null });
            await get().actions.switchTo(next.id);
          } else {
            set({ activeProjectId: null });
            useAppStore.getState().actions.setActiveProject(null);
          }
        }
        scheduleAppStateSave();
      },

      teardownForOrgSwitch: () => {
        const { mountedProjectIds } = get();
        for (const id of mountedProjectIds) teardownHot(id);
        set({
          mountedProjectIds: [],
          activeProjectId: null,
          optimisticActiveId: null,
        });
      },

      removeProjectsForOrg: (orgId: string) => {
        const { projects, mountedProjectIds } = get();
        const removedIds = new Set(projects.filter((w) => w.orgId === orgId).map((w) => w.id));
        // Tear down any that are still mounted (defensive — a deleted org is
        // normally switched away from first, so its set is already cold).
        for (const id of mountedProjectIds) {
          if (removedIds.has(id)) teardownHot(id);
        }
        set((s) => ({
          projects: s.projects.filter((w) => w.orgId !== orgId),
          groups: s.groups.filter((g) => g.orgId !== orgId),
          mountedProjectIds: s.mountedProjectIds.filter((x) => !removedIds.has(x)),
        }));
      },

      setColor: (id, color) => {
        set((s) => ({
          projects: s.projects.map((w) => (w.id === id ? { ...w, color: color ?? undefined } : w)),
        }));
        scheduleAppStateSave();
      },
      rename: (id, name) => {
        set((s) => ({
          projects: s.projects.map((w) => (w.id === id ? { ...w, name } : w)),
        }));
        scheduleAppStateSave();
      },
      beginRenameProject: (id) => set({ editingProjectId: id }),
      endRenameProject: () => set({ editingProjectId: null }),
      setGroup: (id, groupId) => {
        set((s) => ({
          projects: s.projects.map((w) => (w.id === id ? { ...w, groupId } : w)),
        }));
        scheduleAppStateSave();
      },
      reorder: (orderedIds) => {
        set((s) => {
          const byId = new Map(s.projects.map((w) => [w.id, w]));
          const reordered = orderedIds
            .map((wid) => byId.get(wid))
            .filter((w): w is Project => Boolean(w));
          // Append any projects missing from the order list (defensive).
          for (const w of s.projects) {
            if (!orderedIds.includes(w.id)) reordered.push(w);
          }
          return { projects: reordered };
        });
        scheduleAppStateSave();
      },
      addGroup: (name) => {
        const org = requireActiveOrgId();
        if (!org) return refuseWithoutOrg("no organisation available to own a new group");
        const group: ProjectGroup = {
          id: uuid(),
          name,
          order: get().groups.length,
          orgId: org,
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
          // Ungroup any projects that belonged to it.
          projects: s.projects.map((w) => (w.groupId === id ? { ...w, groupId: null } : w)),
        }));
        scheduleAppStateSave();
      },
      pinGroup: (id) => {
        set((s) => ({
          groups: s.groups.map((g) => (g.id === id ? { ...g, pinned: true } : g)),
        }));
        scheduleAppStateSave();
      },
      unpinGroup: (id) => {
        set((s) => ({
          groups: s.groups.map((g) => (g.id === id ? { ...g, pinned: false } : g)),
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
          return sidebarPinned ? { sidebarPinned, sidebarOpen: true } : { sidebarPinned };
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
          // Names used to be the last `/`-segment of the path, which on
          // Windows is the whole path — re-derive those so saved rows heal.
          projects: (payload.projects ?? []).map((w) =>
            w.name === w.path ? { ...w, name: nameOf(w.path) } : w,
          ),
          groups: payload.groups ?? [],
          activeProjectId: payload.activeProjectId ?? null,
        });
      },
    },
  })),
);
