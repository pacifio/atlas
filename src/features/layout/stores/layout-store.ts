import { create } from "zustand";
import { persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { createSelectors } from "@/lib/create-selectors";
import { useTerminalStore, type TerminalTabState } from "@/features/terminal/stores/terminal-store";
import { invoke } from "@tauri-apps/api/core";
import {
  LEGACY_TAB_TYPES,
  ORG_SCOPED_TYPES,
  TAB_TYPES,
  WINDOW_TYPES,
  isDestinationOnly,
  isDualPlacement,
  migrateTabType,
  type DualPlacementType,
  type TabType,
} from "@/lib/constants";
import type { LayoutTemplate } from "../templates";

export interface Tab {
  id: string;
  type: TabType;
  title: string;
  closable: boolean;
  dirty: boolean;
  data: Record<string, unknown>;
  /** Which split column this tab lives in. Absent = the default "main"
   *  column (so existing tab literals don't need to set it). */
  groupId?: string;
}

/** A project's saved tab/split view — everything needed to restore its
 *  CenterPanel without touching disk. */
export interface ProjectView {
  tabs: Tab[];
  activeTabId: string | null;
  groupOrder: string[];
  activeByGroup: Record<string, string | null>;
  focusedGroupId: string;
  tabHistory: string[];
  tabHistoryIndex: number;
}

interface ZenSnapshot {
  groupOrder: string[];
  activeByGroup: Record<string, string | null>;
  focusedGroupId: string;
  tabGroups: Record<string, string>;
}

interface LayoutState {
  /** The source-control surface's last section, kept across reopening it. */
  sourceControl: {
    section: SourceControlSection;
  };
  /** Per-app KB tab layout — survives tab switches (each KB tab gets the
   *  same panel layout, matching the global-left/right model). */
  knowledgePanel: {
    showSidebar: boolean;
    showInspector: boolean;
    sidebarWidth: number;
    inspectorWidth: number;
  };
  bashPanel: {
    width: number;
  };
  plansPanel: {
    width: number;
  };
  /** The Timeline tab's split: the session nav on the left, the open Session
   *  on the right. `showSidebar` only applies while a Session is open — with
   *  nothing open the nav is the whole point and is always drawn. */
  timelinePanel: {
    showSidebar: boolean;
    sidebarWidth: number;
  };
  tabs: Tab[];
  /** Per-project saved view (tabs + split layout + history). The singular
   *  fields below (`tabs`/`groupOrder`/`activeByGroup`/…) are a live MIRROR of
   *  the ACTIVE project's view; `viewsByWs` holds every *other* open
   *  project's last-committed view so CenterPanel can keep their tab subtrees
   *  mounted (hidden) for instant switching. Committed on switch-away. Session
   *  state — excluded from the persist `partialize`. */
  viewsByWs: Record<string, ProjectView>;
  /** Which project the singular mirror currently represents. */
  currentViewWsId: string | null;
  /** Mirror of the FOCUSED column's active tab — kept in sync so the many
   *  existing readers (persistence, the title bar, etc.) don't need to know about
   *  split columns. */
  activeTabId: string | null;
  // ── Split view ──────────────────────────────────────────────────────────
  /** Ordered split columns, left→right. Length 1–3. */
  groupOrder: string[];
  /** Active tab id per column. */
  activeByGroup: Record<string, string | null>;
  /** The column that owns keyboard focus (tab hotkeys target it). */
  focusedGroupId: string;
  /** Zen mode: the session beside a browser, with the global side panels
   *  hidden. `zenPrev` snapshots the layout to restore. */
  zen: boolean;
  zenPrev: ZenSnapshot | null;
  /** The surfaces pane — every split column after the first, which is the
   *  main pane. `hidden` collapses it to nothing while its tabs keep
   *  running; `expanded` gives it the whole centre,
   *  collapsing the main pane instead. Not persisted: a relaunch starts with
   *  both on screen. */
  surfaces: SurfacesMode;
  /**
   * The destination (ADR-0024): a full-page view taking the area right of the
   * rail, one at a time, never a tab in a column. `destinationShown` false is
   * Back: the view stays mounted, hidden, so returning to it is instant, until
   * another destination replaces it or it is closed. Not persisted: a relaunch
   * starts at the session.
   */
  destination: Tab | null;
  destinationShown: boolean;
  /** The form each `surface-or-destination` type was last shown in (team
   *  chat): what its own shortcut reopens it as. Persisted: it is how the
   *  reader likes to use it. */
  lastForm: Partial<Record<DualPlacementType, PlacementForm>>;
  // Back/forward stack of tab ids — entries are pushed every time the user
  // navigates to a tab; back() / forward() rewind/advance an index.
  tabHistory: string[];
  tabHistoryIndex: number;
}

export type SurfacesMode = "shown" | "hidden" | "expanded";
/** Which of its two forms a `surface-or-destination` type is in. */
export type PlacementForm = "surface" | "destination";

/** The source-control surface's sections, in the order its header shows them. */
export const SOURCE_CONTROL_SECTIONS = ["changes", "git-graph", "github"] as const;
export type SourceControlSection = (typeof SOURCE_CONTROL_SECTIONS)[number];

interface LayoutActions {
  actions: {
    /** Show, hide or expand the surfaces pane (see `surfaces`). */
    setSurfaces: (mode: SurfacesMode) => void;
    toggleKnowledgeSidebar: () => void;
    toggleKnowledgeInspector: () => void;
    setKnowledgeSidebarWidth: (width: number) => void;
    setKnowledgeInspectorWidth: (width: number) => void;
    setBashPanelWidth: (width: number) => void;
    setPlansPanelWidth: (width: number) => void;
    toggleTimelineSidebar: () => void;
    setTimelineSidebarWidth: (width: number) => void;
    setSourceControlSection: (section: SourceControlSection) => void;
    addTab: (tab: Tab, groupId?: string) => void;
    closeTab: (id: string) => void;
    /** Move a tab to `toIndex` among its own column's tabs (a drag in the
     *  strip). It never leaves its column, and every other column's tabs keep
     *  their places. The order is the column's order everywhere: the strip,
     *  ⌘1–9, and the per-project layout file. */
    moveTab: (id: string, toIndex: number) => void;
    setActiveTab: (id: string) => void;
    /** Back to the session from a destination; it stays mounted, hidden. */
    hideDestination: () => void;
    /** Open `tab` on the destination screen. A destination-only type is the
     *  same as `addTab`; a `surface-or-destination` type (team chat) leaves
     *  its column for it, so the window still holds one. */
    showDestination: (tab: Tab) => void;
    setTabDirty: (id: string, dirty: boolean) => void;
    /** Rename a tab, e.g. once a pull request's title has loaded. */
    setTabTitle: (id: string, title: string) => void;
    /** Merge fields into a tab's persisted `data` (a pull request tab's
     *  `openedFrom`, when it is opened again from somewhere else). */
    setTabData: (id: string, patch: Record<string, unknown>) => void;
    navigateTabBack: () => void;
    navigateTabForward: () => void;
    activateTabByIndex: (i: number) => void;
    cycleTab: (delta: 1 | -1) => void;
    // ── Split view ──
    /** Set which column has keyboard focus. */
    setFocusedGroup: (groupId: string) => void;
    /** Move focus to the column delta steps away (clamped). */
    focusAdjacentGroup: (delta: 1 | -1) => void;
    /** Open a new empty split column to the right of the focused one (≤3). */
    addGroup: () => void;
    /** Close a split column, moving its tabs to the left neighbour (never the
     *  last remaining column). */
    closeGroup: (groupId: string) => void;
    /** Toggle Zen mode: the session beside a browser with the global side
     *  panels hidden; toggling again restores the prior layout. */
    toggleZenMode: () => void;
    /** Apply a predefined layout template to the active project: set panels +
     *  split columns + a tab of each template type per column (reusing existing
     *  tabs; other open tabs are preserved in the first column). */
    applyLayoutTemplate: (template: LayoutTemplate) => void;
    saveEditorState: (projectPath: string) => void;
    /** Awaitable variant of `saveEditorState` used by the project flush
     *  coordinator — resolves only once the editor-state write hits disk. */
    flushEditorState: (projectPath: string) => Promise<void>;
    loadEditorState: (projectPath: string) => Promise<void>;
    // ── Multi-project view (mounted-tabs fast switching) ──
    /** Save the active mirror into `viewsByWs[wsId]` (on switch-away / quit). */
    commitProjectView: (wsId: string) => void;
    /** Load `viewsByWs[wsId]` (or a fresh welcome view) into the mirror. */
    loadProjectView: (wsId: string) => void;
    /** Drop a project's saved view (on close). */
    removeProjectView: (wsId: string) => void;
  };
}

const initialState: LayoutState = {
  sourceControl: {
    section: "changes",
  },
  knowledgePanel: {
    showSidebar: true,
    showInspector: true,
    sidebarWidth: 240,
    inspectorWidth: 280,
  },
  bashPanel: {
    width: 260,
  },
  plansPanel: {
    width: 380,
  },
  timelinePanel: {
    showSidebar: true,
    sidebarWidth: 300,
  },
  tabs: [
    {
      id: "welcome-chat",
      type: "chat",
      title: "Agents",
      closable: false,
      dirty: false,
      data: {},
      groupId: "main",
    },
  ],
  viewsByWs: {},
  currentViewWsId: null,
  activeTabId: "welcome-chat",
  groupOrder: ["main"],
  activeByGroup: { main: "welcome-chat" },
  focusedGroupId: "main",
  zen: false,
  zenPrev: null,
  surfaces: "shown",
  destination: null,
  destinationShown: false,
  lastForm: {},
  tabHistory: ["welcome-chat"],
  tabHistoryIndex: 0,
};

const DEFAULT_GROUP = "main";

/** Bring `groupId` on screen: a tab landing in the hidden surfaces pane shows
 *  it, and one landing in the main pane while surfaces are expanded restores
 *  the split. */
function revealGroup(s: { surfaces: SurfacesMode; groupOrder: string[] }, groupId: string): void {
  const isMain = groupId === s.groupOrder[0];
  if (s.surfaces === "hidden" && !isMain) s.surfaces = "shown";
  else if (s.surfaces === "expanded" && isMain) s.surfaces = "shown";
}
export const MAX_GROUPS = 3;

/** Which split column a tab lives in. Exported because anything asking "is
 *  this tab the one on screen" has to read `activeByGroup`, and doing that
 *  without this would mean restating the default-group literal. */
export function groupOf(tab: { groupId?: string } | undefined): string {
  return tab?.groupId ?? DEFAULT_GROUP;
}

/** Return `base` if no tab uses it, else a suffixed variant ("base-2", …).
 *  Lets a singleton type (terminal/browser/settings…) be opened in more than
 *  one split column: callers may reuse a fixed id (e.g. "terminal"), and two
 *  tabs sharing an id would collide React keys / activeByGroup / closeTab. */
function uniqueTabId(s: LayoutState, base: string): string {
  if (!s.tabs.some((t) => t.id === base)) return base;
  let i = 2;
  while (s.tabs.some((t) => t.id === `${base}-${i}`)) i++;
  return `${base}-${i}`;
}

/** Keep `activeTabId` pointing at the focused column's active tab. */
function syncActiveMirror(s: LayoutState): void {
  s.activeTabId = s.activeByGroup[s.focusedGroupId] ?? null;
}

function pushTabHistory(s: LayoutState, id: string): void {
  if (s.tabHistory[s.tabHistoryIndex] === id) return;
  s.tabHistory = s.tabHistory.slice(0, s.tabHistoryIndex + 1);
  s.tabHistory.push(id);
  s.tabHistoryIndex = s.tabHistory.length - 1;
}

/** Ensure every tab sits in a live column, every column has a valid active
 *  tab, and focus is valid. Used after bulk group changes (project restore,
 *  zen toggle). */
function reconcileGroups(s: LayoutState): void {
  if (s.groupOrder.length === 0) s.groupOrder = [DEFAULT_GROUP];
  for (const t of s.tabs) if (!s.groupOrder.includes(groupOf(t))) t.groupId = s.groupOrder[0];
  for (const k of Object.keys(s.activeByGroup)) {
    if (!s.groupOrder.includes(k)) delete s.activeByGroup[k];
  }
  for (const g of s.groupOrder) {
    const a = s.activeByGroup[g];
    if (!a || !s.tabs.find((t) => t.id === a && groupOf(t) === g)) {
      s.activeByGroup[g] = s.tabs.find((t) => groupOf(t) === g)?.id ?? null;
    }
  }
  if (!s.groupOrder.includes(s.focusedGroupId)) s.focusedGroupId = s.groupOrder[0];
  syncActiveMirror(s);
}

/**
 * Whether `type` may live in the main column. The main column is the session:
 * it never shows a tab strip, so it holds the agent and nothing else, and
 * files, editors and tools open in the surfaces pane beside it. That includes
 * the projectless types: the projectless shell shows its tabs from whichever
 * column has focus, so they need no exception.
 */
function belongsInMain(type: TabType): boolean {
  return type === "chat";
}

/** The surfaces column a tool should open in: the focused one when it is not
 *  the main column, else the first beside it — made when there is none. */
function surfaceGroupFor(s: LayoutState): string {
  const main = s.groupOrder[0];
  if (s.focusedGroupId !== main && s.groupOrder.includes(s.focusedGroupId)) {
    return s.focusedGroupId;
  }
  if (s.groupOrder.length > 1) return s.groupOrder[1];
  const gid = `split-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
  s.groupOrder.push(gid);
  s.activeByGroup[gid] = null;
  return gid;
}

/**
 * Put every tab in the column its placement says (ADR-0024): anything that
 * is not a session out of the main column, and any session out of the
 * surfaces pane into it. Restored layouts, templates and zen can leave either
 * behind. A surfaces column emptied by losing its sessions closes.
 */
function keepMainForSessions(s: LayoutState): void {
  const main = s.groupOrder[0];
  const strays = s.tabs.filter((t) => groupOf(t) === main && !belongsInMain(t.type));
  const exiles = s.tabs.filter((t) => groupOf(t) !== main && belongsInMain(t.type));
  if (strays.length === 0 && exiles.length === 0) return;
  const emptied = new Set(exiles.map(groupOf));
  for (const t of exiles) t.groupId = main;
  for (const g of emptied) {
    if (s.tabs.some((t) => groupOf(t) === g)) continue;
    s.groupOrder = s.groupOrder.filter((x) => x !== g);
    delete s.activeByGroup[g];
  }
  if (s.groupOrder.length === 1) s.surfaces = "shown";
  if (strays.length > 0) {
    const target = surfaceGroupFor(s);
    for (const t of strays) t.groupId = target;
  }
  if (!s.tabs.some((t) => groupOf(t) === main)) s.tabs.push(WELCOME_TAB(main));
  reconcileGroups(s);
}

const WELCOME_TAB = (groupId: string): Tab => ({
  id: "welcome-chat",
  type: "chat",
  title: "Session",
  closable: false,
  dirty: false,
  data: {},
  groupId,
});

/** Per-project welcome tab id — distinct so two projects' welcome chats
 *  don't collide in `chat-store.sessions` (which keys by tab id). */
const welcomeIdFor = (wsId: string): string => `welcome-chat-${wsId}`;

/** A fresh single-welcome-tab view for a project never visited this session. */
function welcomeView(wsId: string): ProjectView {
  const id = welcomeIdFor(wsId);
  return {
    tabs: [
      {
        id,
        type: "chat",
        title: "Agents",
        closable: false,
        dirty: false,
        data: {},
        groupId: DEFAULT_GROUP,
      },
    ],
    activeTabId: id,
    groupOrder: [DEFAULT_GROUP],
    activeByGroup: { [DEFAULT_GROUP]: id },
    focusedGroupId: DEFAULT_GROUP,
    tabHistory: [id],
    tabHistoryIndex: 0,
  };
}

/** Snapshot the singular mirror fields into a portable ProjectView. */
function captureView(s: LayoutState): ProjectView {
  return {
    tabs: s.tabs.map((t) => ({ ...t })),
    activeTabId: s.activeTabId,
    groupOrder: [...s.groupOrder],
    activeByGroup: { ...s.activeByGroup },
    focusedGroupId: s.focusedGroupId,
    tabHistory: [...s.tabHistory],
    tabHistoryIndex: s.tabHistoryIndex,
  };
}

/**
 * Save side of the per-project layout file: every closable tab (welcome-chat
 * is the recreated baseline), minus org-scoped ones — this file is keyed by
 * project path, and the same project is often open in several orgs.
 * Exported for `org-tabs.test.ts`.
 */
export function persistsInEditorState(t: { type: TabType; closable: boolean }): boolean {
  return t.closable && !ORG_SCOPED_TYPES.has(t.type) && !WINDOW_TYPES.has(t.type);
}

/**
 * A saved tab whose surface no longer exists in that form, dropped on restore.
 *
 * A Git Diff tab with no file is the retired standalone Git Diff module (a
 * file tree plus commit picker, opened from the new-tab menu). The commit tab
 * replaced it; a "diff" tab now always shows one file.
 */
export function isRetiredTab(tab: { type: string; data?: Record<string, unknown> }): boolean {
  return tab.type === "diff" && !tab.data?.file;
}

/**
 * Restore side: the type a saved tab comes back as, or `null` when it is
 * dropped. Renamed types (mission-control → usage) map forward; a type this
 * build no longer knows is dropped; and org-scoped types are dropped because
 * files written before they were excluded can still carry them, pointing at
 * another org's conversation. Exported for `org-tabs.test.ts`.
 */
export function restoredTabType(saved: string): TabType | null {
  const type = migrateTabType(saved);
  if (type === null || ORG_SCOPED_TYPES.has(type) || WINDOW_TYPES.has(type)) return null;
  // A destination is never a column tab (ADR-0024). Files saved before then
  // carry Knowledge or Timeline tabs; they do not come back as columns.
  if (isDestinationOnly(type)) return null;
  return type;
}

/**
 * The per-project layout file (`save_editor_state`). Split columns + their
 * tabs, and — since v3 — the pane trees of the terminal tabs, so a split
 * terminal layout comes back the way it was left. Rust stores the JSON
 * opaquely; the shape is ours.
 *
 * Returns null in zen mode: that is a transient overlay, and persisting its
 * layout over the real project would reopen the app in zen.
 */
function buildEditorState(state: LayoutState) {
  if (state.zen) return null;
  // Closable, non-org-scoped tabs only (see `persistsInEditorState`).
  const tabs = state.tabs.filter(persistsInEditorState).map((t) => ({
    id: t.id,
    type: t.type,
    title: t.title,
    data: t.data,
    groupId: groupOf(t),
  }));
  const terminalTabIds = tabs.filter((t) => t.type === "terminal").map((t) => t.id);
  return {
    version: 3,
    tabs,
    groupOrder: state.groupOrder,
    activeByGroup: state.activeByGroup,
    focusedGroupId: state.focusedGroupId,
    activeTabId: state.activeTabId, // legacy readers
    terminalTrees: useTerminalStore.getState().actions.exportTrees(terminalTabIds),
  };
}

/** Load a ProjectView into the singular mirror fields. */
function applyView(s: LayoutState, v: ProjectView): void {
  s.tabs = v.tabs.map((t) => ({ ...t }));
  s.activeTabId = v.activeTabId;
  s.groupOrder = [...v.groupOrder];
  s.activeByGroup = { ...v.activeByGroup };
  s.focusedGroupId = v.focusedGroupId;
  s.tabHistory = [...v.tabHistory];
  s.tabHistoryIndex = v.tabHistoryIndex;
}

/** Team chat's tab. One per window (`WINDOW_TYPES`); `team-chat.ts` opens it. */
export const TEAM_CHAT_TAB: Tab = {
  id: "team-chat",
  type: "team-chat",
  title: "Team chat",
  closable: true,
  dirty: false,
  data: {},
};

/**
 * `applyView`, except that the window's own tabs (team chat) come along
 * instead of being swapped out with the outgoing project. The incoming view's
 * copy, captured when that project was last left, is stale: the window's
 * current state wins, so a team chat closed elsewhere stays closed.
 *
 * A carried tab keeps its column position when the incoming view has a column
 * there (never the main one), else it opens in the surfaces pane; and it stays
 * the column's active tab if it was. Exported for `window-tabs.test.ts`.
 */
export function applyViewKeepingWindowTabs(s: LayoutState, v: ProjectView): void {
  const carried = s.tabs
    .filter((t) => WINDOW_TYPES.has(t.type))
    .map((t) => ({
      tab: { ...t },
      column: s.groupOrder.indexOf(groupOf(t)),
      active: s.activeByGroup[groupOf(t)] === t.id,
    }));
  applyView(s, {
    ...v,
    tabs: v.tabs.filter((t) => !WINDOW_TYPES.has(t.type) && !isDestinationOnly(t.type)),
  });
  for (const c of carried) {
    const gid =
      c.column > 0 && c.column < s.groupOrder.length ? s.groupOrder[c.column] : surfaceGroupFor(s);
    s.tabs.push({ ...c.tab, groupId: gid });
    if (c.active || !s.activeByGroup[gid]) s.activeByGroup[gid] = c.tab.id;
  }
  reconcileGroups(s);
}

/**
 * Put `tab` on the destination screen (ADR-0024). One at a time: the same kind
 * reopens in place, keeping its mounted state; a Space is per conversation,
 * so another one replaces it. A `surface-or-destination` type leaves its
 * column first, so the window never holds it twice.
 */
function enterDestination(s: LayoutState, tab: Tab): void {
  if (isDualPlacement(tab.type)) {
    const inColumn = s.tabs.find((t) => t.type === tab.type);
    if (inColumn) removeColumnTab(s, inColumn.id);
    s.lastForm[tab.type] = "destination";
  }
  const perConversation = tab.type === "spaces";
  const same =
    s.destination?.type === tab.type && (!perConversation || s.destination.id === tab.id);
  s.destination = same
    ? { ...s.destination!, title: tab.title, data: tab.data }
    : { ...tab, groupId: undefined };
  s.destinationShown = true;
}

/** Take `id` out of its column, as closing it would: its neighbour takes
 *  over, an emptied surfaces column collapses, an emptied last column gets
 *  the welcome session back. */
function removeColumnTab(s: LayoutState, id: string): void {
  const idx = s.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const grp = groupOf(s.tabs[idx]);
  const groupIdxInGroup = s.tabs.filter((t) => groupOf(t) === grp).findIndex((t) => t.id === id);
  s.tabs.splice(idx, 1);
  const remaining = s.tabs.filter((t) => groupOf(t) === grp);
  if (remaining.length === 0) {
    if (s.groupOrder.length > 1) {
      // The column emptied — collapse the split.
      s.groupOrder = s.groupOrder.filter((g) => g !== grp);
      delete s.activeByGroup[grp];
      if (s.focusedGroupId === grp) s.focusedGroupId = s.groupOrder[0];
      if (s.groupOrder.length === 1) s.surfaces = "shown";
    } else {
      // Last column emptied — restore the permanent welcome chat.
      s.tabs.push(WELCOME_TAB(grp));
      s.activeByGroup[grp] = "welcome-chat";
    }
  } else if (s.activeByGroup[grp] === id) {
    // Activate the neighbour at the same slot within the column.
    const next = remaining[Math.min(groupIdxInGroup, remaining.length - 1)];
    s.activeByGroup[grp] = next.id;
  }
  syncActiveMirror(s);
}

export const useLayoutStore = createSelectors(
  create<LayoutState & LayoutActions>()(
    persist(
      immer((set) => ({
        ...initialState,
        actions: {
          toggleKnowledgeSidebar: () =>
            set((s) => {
              s.knowledgePanel.showSidebar = !s.knowledgePanel.showSidebar;
            }),
          toggleKnowledgeInspector: () =>
            set((s) => {
              s.knowledgePanel.showInspector = !s.knowledgePanel.showInspector;
            }),
          toggleTimelineSidebar: () =>
            set((s) => {
              s.timelinePanel.showSidebar = !s.timelinePanel.showSidebar;
            }),
          setTimelineSidebarWidth: (width) =>
            set((s) => {
              s.timelinePanel.sidebarWidth = Math.max(220, Math.min(width, 480));
            }),
          setKnowledgeSidebarWidth: (width) =>
            set((s) => {
              s.knowledgePanel.sidebarWidth = Math.max(180, Math.min(width, 480));
            }),
          setKnowledgeInspectorWidth: (width) =>
            set((s) => {
              s.knowledgePanel.inspectorWidth = Math.max(220, Math.min(width, 520));
            }),
          setBashPanelWidth: (width) =>
            set((s) => {
              s.bashPanel.width = Math.max(200, Math.min(width, 480));
            }),
          setPlansPanelWidth: (width) =>
            set((s) => {
              s.plansPanel.width = Math.max(300, Math.min(width, 640));
            }),
          setSourceControlSection: (section) =>
            set((s) => {
              s.sourceControl.section = section;
            }),
          addTab: (tab, groupId) =>
            set((s) => {
              // A destination never enters a column (ADR-0024).
              if (isDestinationOnly(tab.type)) {
                enterDestination(s, tab);
                return;
              }
              s.destinationShown = false;
              // A `surface-or-destination` type opened as a tab is the surface
              // form: it leaves the destination screen for the column, so the
              // window still holds one.
              if (isDualPlacement(tab.type)) {
                if (s.destination?.type === tab.type) s.destination = null;
                s.lastForm[tab.type] = "surface";
              }
              // Source control and team chat are one per window, and Files one
              // per project (these tabs are the project's), wherever the open
              // one is.
              if (
                tab.type === "source-control" ||
                tab.type === "files" ||
                WINDOW_TYPES.has(tab.type)
              ) {
                const open = s.tabs.find((t) => t.type === tab.type);
                if (open) {
                  const grp = groupOf(open);
                  s.focusedGroupId = grp;
                  s.activeByGroup[grp] = open.id;
                  revealGroup(s, grp);
                  pushTabHistory(s, open.id);
                  syncActiveMirror(s);
                  return;
                }
              }
              // chat: each session is its own tab. File-backed viewers (editor /
              // diff / media / svg / pdf / notebook / unsupported) are one-per-FILE (deduped
              // by id, which is `${type}:${path}`) so opening a different file
              // always gets its own tab. Everything else is a singleton PER COLUMN
              // (focus the existing instance in the target column, else open one).
              const allowMultiple =
                tab.type === "editor" ||
                tab.type === "diff" ||
                // One per COMMIT (id is `commit:{repoPath}:{sha}`).
                tab.type === "commit" ||
                // One per AGENT SESSION (id is `session-changes:{sessionId}`).
                tab.type === "session-changes" ||
                // One per PULL REQUEST (id is `pull-request:{repoPath}:{number}`).
                tab.type === "pull-request" ||
                // One per REPOSITORY (id is `pull-requests:{repoPath}`).
                tab.type === "pull-requests" ||
                // One per SESSION (id is `session-pull-requests:{threadId}`).
                tab.type === "session-pull-requests" ||
                tab.type === "chat" ||
                tab.type === "media" ||
                tab.type === "svg" ||
                tab.type === "pdf" ||
                tab.type === "notebook" ||
                // One per DRAFT (id is `comms-draft-{id}`): the singleton rule
                // would focus draft A when asked to open draft B.
                tab.type === "comms-draft" ||
                tab.type === "unsupported";

              let targetId = tab.id;
              // Where the tab lands: caller-specified column, else the focused one.
              let targetGroup = groupId ?? s.focusedGroupId;
              if (!s.groupOrder.includes(targetGroup)) targetGroup = s.focusedGroupId;
              // …unless that is the main column and this is not a session. And
              // a session always opens in the main column, wherever the focus
              // was (ADR-0024): a session in the surfaces pane gets the
              // narrow column's cramped layout and no breadcrumb.
              if (belongsInMain(tab.type)) targetGroup = s.groupOrder[0];
              else if (targetGroup === s.groupOrder[0]) targetGroup = surfaceGroupFor(s);

              if (!allowMultiple) {
                const existingInGroup = s.tabs.find(
                  (t) => t.type === tab.type && groupOf(t) === targetGroup,
                );
                if (existingInGroup) {
                  targetId = existingInGroup.id; // focus the one already in this column
                } else {
                  // New instance in the target column; ensure a unique id since
                  // callers may reuse a fixed id (e.g. "terminal", "settings").
                  targetId = uniqueTabId(s, tab.id);
                  s.tabs.push({ ...tab, id: targetId, groupId: targetGroup });
                }
              } else {
                const existsById = s.tabs.find((t) => t.id === tab.id);
                if (existsById) {
                  targetGroup = groupOf(existsById);
                } else {
                  s.tabs.push({ ...tab, groupId: targetGroup });
                }
              }
              s.focusedGroupId = targetGroup;
              s.activeByGroup[targetGroup] = targetId;
              revealGroup(s, targetGroup);
              pushTabHistory(s, targetId);
              syncActiveMirror(s);
            }),
          closeTab: (id) =>
            set((s) => {
              if (s.destination?.id === id) {
                s.destination = null;
                s.destinationShown = false;
                return;
              }
              const tab = s.tabs.find((t) => t.id === id);
              if (!tab?.closable) return;
              removeColumnTab(s, id);
            }),
          moveTab: (id, toIndex) =>
            set((s) => {
              const tab = s.tabs.find((t) => t.id === id);
              if (!tab) return;
              const grp = groupOf(tab);
              const column = s.tabs.filter((t) => groupOf(t) === grp);
              const from = column.indexOf(tab);
              const to = Math.max(0, Math.min(toIndex, column.length - 1));
              if (from === to) return;
              column.splice(from, 1);
              column.splice(to, 0, tab);
              // Refill the column's own slots in `tabs`, in the new order, so
              // the tabs of every other column stay exactly where they were.
              let next = 0;
              s.tabs = s.tabs.map((t) => (groupOf(t) === grp ? column[next++] : t));
            }),
          hideDestination: () =>
            set((s) => {
              s.destinationShown = false;
            }),
          showDestination: (tab) =>
            set((s) => {
              if (isDestinationOnly(tab.type) || isDualPlacement(tab.type))
                enterDestination(s, tab);
            }),
          setActiveTab: (id) =>
            set((s) => {
              if (s.destination?.id === id) {
                s.destinationShown = true;
                return;
              }
              // Going to any session or surface leaves the destination.
              s.destinationShown = false;
              const tab = s.tabs.find((t) => t.id === id);
              const target = tab ? id : (s.tabs[0]?.id ?? null);
              if (target === null) return;
              const grp = groupOf(s.tabs.find((t) => t.id === target));
              s.focusedGroupId = grp;
              s.activeByGroup[grp] = target;
              revealGroup(s, grp);
              pushTabHistory(s, target);
              syncActiveMirror(s);
            }),
          navigateTabBack: () =>
            set((s) => {
              for (let i = s.tabHistoryIndex - 1; i >= 0; i--) {
                const id = s.tabHistory[i];
                const tab = s.tabs.find((t) => t.id === id);
                if (tab) {
                  s.tabHistoryIndex = i;
                  s.focusedGroupId = groupOf(tab);
                  s.activeByGroup[s.focusedGroupId] = id;
                  syncActiveMirror(s);
                  return;
                }
              }
            }),
          navigateTabForward: () =>
            set((s) => {
              for (let i = s.tabHistoryIndex + 1; i < s.tabHistory.length; i++) {
                const id = s.tabHistory[i];
                const tab = s.tabs.find((t) => t.id === id);
                if (tab) {
                  s.tabHistoryIndex = i;
                  s.focusedGroupId = groupOf(tab);
                  s.activeByGroup[s.focusedGroupId] = id;
                  syncActiveMirror(s);
                  return;
                }
              }
            }),
          // ⌘1–9 — select the i-th tab WITHIN the focused column.
          activateTabByIndex: (i) =>
            set((s) => {
              const groupTabs = s.tabs.filter((t) => groupOf(t) === s.focusedGroupId);
              const target = i < 0 ? groupTabs[groupTabs.length - 1] : groupTabs[i];
              if (!target) return;
              s.activeByGroup[s.focusedGroupId] = target.id;
              pushTabHistory(s, target.id);
              syncActiveMirror(s);
            }),
          cycleTab: (delta) =>
            set((s) => {
              const groupTabs = s.tabs.filter((t) => groupOf(t) === s.focusedGroupId);
              if (groupTabs.length === 0) return;
              const cur = s.activeByGroup[s.focusedGroupId];
              const ci = Math.max(
                0,
                groupTabs.findIndex((t) => t.id === cur),
              );
              const next = groupTabs[(ci + delta + groupTabs.length) % groupTabs.length];
              s.activeByGroup[s.focusedGroupId] = next.id;
              pushTabHistory(s, next.id);
              syncActiveMirror(s);
            }),
          setSurfaces: (mode) =>
            set((s) => {
              s.surfaces = s.groupOrder.length > 1 ? mode : "shown";
              const main = s.groupOrder[0];
              // Keyboard focus follows what is on screen: hidden surfaces hand
              // it to the main pane, an expanded one takes it.
              if (s.surfaces === "hidden") s.focusedGroupId = main;
              else if (s.surfaces === "expanded" && s.focusedGroupId === main) {
                s.focusedGroupId = s.groupOrder[1];
              }
              syncActiveMirror(s);
            }),
          setFocusedGroup: (groupId) =>
            set((s) => {
              if (!s.groupOrder.includes(groupId) || s.focusedGroupId === groupId) return;
              s.focusedGroupId = groupId;
              syncActiveMirror(s);
            }),
          focusAdjacentGroup: (delta) =>
            set((s) => {
              const i = s.groupOrder.indexOf(s.focusedGroupId);
              const ni = i + delta;
              if (ni < 0 || ni >= s.groupOrder.length) return;
              s.focusedGroupId = s.groupOrder[ni];
              syncActiveMirror(s);
            }),
          addGroup: () =>
            set((s) => {
              if (s.groupOrder.length >= MAX_GROUPS) return;
              const gid = `split-${Date.now().toString(36)}-${Math.random()
                .toString(36)
                .slice(2, 5)}`;
              const fi = s.groupOrder.indexOf(s.focusedGroupId);
              s.groupOrder.splice(fi + 1, 0, gid);
              s.activeByGroup[gid] = null;
              s.focusedGroupId = gid;
              if (s.surfaces === "hidden") s.surfaces = "shown";
              syncActiveMirror(s);
            }),
          closeGroup: (groupId) =>
            set((s) => {
              if (s.groupOrder.length <= 1) return;
              const gi = s.groupOrder.indexOf(groupId);
              if (gi === -1) return;
              const remaining = s.groupOrder.filter((g) => g !== groupId);
              const main = remaining[0];
              // The column's tabs move (and remount): sessions to the main
              // column, tools to the nearest surfaces column left standing.
              const toolHome =
                [s.groupOrder[gi - 1], s.groupOrder[gi + 1]].find((g) => g && g !== main) ??
                remaining.find((g) => g !== main);
              const here = s.tabs.filter((t) => groupOf(t) === groupId);
              if (!toolHome && here.some((t) => !belongsInMain(t.type))) {
                // The only surfaces column, with tools in it: they have nowhere
                // to go but the main column, which shows no tabs. Hide the
                // pane instead; its tools keep running and come back with it.
                s.surfaces = "hidden";
                s.focusedGroupId = main;
                syncActiveMirror(s);
                return;
              }
              const moved = s.activeByGroup[groupId];
              for (const t of here) t.groupId = belongsInMain(t.type) ? main : toolHome!;
              s.groupOrder = remaining;
              delete s.activeByGroup[groupId];
              const movedTab = here.find((t) => t.id === moved);
              if (movedTab) s.activeByGroup[groupOf(movedTab)] = movedTab.id;
              s.focusedGroupId = movedTab ? groupOf(movedTab) : main;
              if (s.groupOrder.length === 1) s.surfaces = "shown";
              reconcileGroups(s);
              keepMainForSessions(s);
            }),
          toggleZenMode: () =>
            set((s) => {
              // Exit: restore the snapshot.
              if (s.zen && s.zenPrev) {
                const p = s.zenPrev;
                s.groupOrder = p.groupOrder.length ? [...p.groupOrder] : [DEFAULT_GROUP];
                s.activeByGroup = { ...p.activeByGroup };
                s.focusedGroupId = p.focusedGroupId;
                for (const t of s.tabs) t.groupId = p.tabGroups[t.id] ?? s.groupOrder[0];
                s.zen = false;
                s.zenPrev = null;
                reconcileGroups(s);
                keepMainForSessions(s);
                return;
              }
              // Enter: snapshot the current layout, then build Session │ Browser.
              const tabGroups: Record<string, string> = {};
              for (const t of s.tabs) tabGroups[t.id] = groupOf(t);
              s.zenPrev = {
                groupOrder: [...s.groupOrder],
                activeByGroup: { ...s.activeByGroup },
                focusedGroupId: s.focusedGroupId,
                tabGroups,
              };
              const G_CHAT = "zen-chat";
              const G_BROWSER = "zen-browser";
              // Reuse the existing singleton tab if present, else create one.
              const ensure = (type: TabType, title: string, gid: string): string => {
                const existing = s.tabs.find((x) => x.type === type);
                if (existing) {
                  existing.groupId = gid;
                  return existing.id;
                }
                const id = `${type}-zen`;
                s.tabs.push({
                  id,
                  type,
                  title,
                  closable: true,
                  dirty: false,
                  data: {},
                  groupId: gid,
                });
                return id;
              };
              // A chat tab always exists (welcome-chat is the non-closable baseline).
              let chat = s.tabs.find((x) => x.type === "chat");
              if (!chat) {
                chat = {
                  id: "chat-zen",
                  type: "chat",
                  title: "Session",
                  closable: true,
                  dirty: false,
                  data: {},
                  groupId: G_CHAT,
                };
                s.tabs.push(chat);
              } else {
                chat.groupId = G_CHAT;
              }
              const browserId = ensure("browser", "Browser", G_BROWSER);
              // The agent first: the main column holds the session.
              s.groupOrder = [G_CHAT, G_BROWSER];
              s.activeByGroup = { [G_CHAT]: chat.id, [G_BROWSER]: browserId };
              s.focusedGroupId = G_CHAT;
              // Team chat, like every tab outside the three, stays where it
              // was and comes back on exit.
              s.zen = true;
              syncActiveMirror(s);
            }),
          applyLayoutTemplate: (template) =>
            set((s) => {
              // Leaving zen if we were in it.
              s.zen = false;
              s.zenPrev = null;

              // One column per template cell. Reuse an existing tab of the cell's
              // type when present (preserve open work), else create one.
              const order: string[] = [];
              const active: Record<string, string | null> = {};
              template.columns.forEach((col, i) => {
                const gid = i === 0 ? DEFAULT_GROUP : `tpl-${i}`;
                order.push(gid);
                const existing = s.tabs.find((t) => t.type === col.type);
                let id: string;
                if (existing) {
                  existing.groupId = gid;
                  id = existing.id;
                } else {
                  const ts = Date.now().toString(36);
                  id = `${col.type}-tpl-${i}-${ts}`;
                  // A fresh editor needs a buffer key or it renders blank; seed an
                  // untitled scratch buffer (same convention as ⌘N).
                  const data = col.type === "editor" ? { filePath: `untitled:tpl-${i}-${ts}` } : {};
                  s.tabs.push({
                    id,
                    type: col.type,
                    title: col.title,
                    closable: col.type !== "chat",
                    dirty: false,
                    data,
                    groupId: gid,
                  });
                }
                active[gid] = id;
              });

              s.groupOrder = order;
              s.activeByGroup = active;
              s.focusedGroupId =
                order[Math.min(template.focus ?? order.length - 1, order.length - 1)];

              // Park any OTHER open tabs in the first column (kept, not lost) and
              // validate actives/focus — then move the tools among them out of
              // it, since the main column shows no tabs.
              reconcileGroups(s);
              keepMainForSessions(s);
              // A one-column template means the session alone: tools parked
              // beside it stay open but out of sight.
              if (template.columns.length === 1 && s.groupOrder.length > 1) s.surfaces = "hidden";
            }),
          setTabDirty: (id, dirty) =>
            set((s) => {
              const tab = s.tabs.find((t) => t.id === id);
              if (tab) tab.dirty = dirty;
            }),
          setTabTitle: (id, title) =>
            set((s) => {
              const tab = s.tabs.find((t) => t.id === id);
              if (tab && tab.title !== title) tab.title = title;
            }),
          setTabData: (id, patch) =>
            set((s) => {
              const tab = s.tabs.find((t) => t.id === id);
              if (tab) tab.data = { ...tab.data, ...patch };
            }),
          // Persist the whole project layout (split columns + their tabs) per
          // project so the AKB arrangement comes back on reopen. The Rust
          // save/load commands store the JSON opaquely, so the shape is ours.
          saveEditorState: (projectPath) => {
            const data = buildEditorState(useLayoutStore.getState());
            if (!data) return;
            invoke("save_editor_state", {
              projectPath,
              stateJson: JSON.stringify(data),
            }).catch(() => {});
          },
          flushEditorState: async (projectPath) => {
            const data = buildEditorState(useLayoutStore.getState());
            if (!data) return;
            await invoke("save_editor_state", {
              projectPath,
              stateJson: JSON.stringify(data),
            }).catch(() => {});
          },
          commitProjectView: (wsId) =>
            set((s) => {
              s.viewsByWs[wsId] = captureView(s);
              s.currentViewWsId = wsId;
            }),
          loadProjectView: (wsId) =>
            set((s) => {
              const v = s.viewsByWs[wsId] ?? welcomeView(wsId);
              applyViewKeepingWindowTabs(s, v);
              keepMainForSessions(s);
              s.currentViewWsId = wsId;
            }),
          removeProjectView: (wsId) =>
            set((s) => {
              delete s.viewsByWs[wsId];
            }),
          loadEditorState: async (projectPath) => {
            try {
              const raw = await invoke<string>("load_editor_state", { projectPath });
              const data = JSON.parse(raw) as {
                tabs?: Array<{
                  id: string;
                  type: string;
                  title: string;
                  data: Record<string, unknown>;
                  groupId?: string;
                }>;
                groupOrder?: string[];
                activeByGroup?: Record<string, string | null>;
                focusedGroupId?: string;
                activeTabId?: string;
                terminalTrees?: Record<string, TerminalTabState>;
              };
              if (data.tabs && data.tabs.length > 0) {
                // Pane trees first, so `TerminalPanel`'s `initTab` (a no-op
                // when the tree exists) finds the restored one. Only for tabs
                // that are actually coming back.
                if (data.terminalTrees) {
                  const restoredIds = new Set(data.tabs.map((t) => t.id));
                  const trees = Object.fromEntries(
                    Object.entries(data.terminalTrees).filter(([id]) => restoredIds.has(id)),
                  );
                  useTerminalStore.getState().actions.importTrees(trees);
                }
                set((s) => {
                  // Restore the column structure (≤3). Falls back to the existing
                  // single "main" column for the legacy (v1) format.
                  if (data.groupOrder && data.groupOrder.length > 0) {
                    s.groupOrder = data.groupOrder.slice(0, MAX_GROUPS);
                    // If "main" (the welcome tab's column) was dropped, re-home it.
                    if (!s.groupOrder.includes(DEFAULT_GROUP)) {
                      const first = s.groupOrder[0];
                      for (const t of s.tabs) if (groupOf(t) === DEFAULT_GROUP) t.groupId = first;
                    }
                  }
                  // Add the saved tabs into their columns.
                  for (const saved of data.tabs!) {
                    // Renamed types map forward; unknown and org-scoped
                    // types are dropped (see `restoredTabType`).
                    const type = restoredTabType(saved.type);
                    if (type === null || isRetiredTab(saved)) continue;
                    const id = saved.id in LEGACY_TAB_TYPES ? LEGACY_TAB_TYPES[saved.id] : saved.id;
                    if (s.tabs.find((t) => t.id === id)) continue;
                    let gid = saved.groupId ?? DEFAULT_GROUP;
                    if (!s.groupOrder.includes(gid)) gid = s.groupOrder[0];
                    s.tabs.push({
                      id,
                      type,
                      title: saved.title,
                      closable: true,
                      dirty: false,
                      data: saved.data,
                      groupId: gid,
                    });
                  }
                  // Reconcile: every tab in a live column; every column with a
                  // valid active tab; restore focus.
                  for (const t of s.tabs)
                    if (!s.groupOrder.includes(groupOf(t))) t.groupId = s.groupOrder[0];
                  const saved = data.activeByGroup ?? {};
                  for (const g of s.groupOrder) {
                    const want = saved[g];
                    const valid = want && s.tabs.find((t) => t.id === want && groupOf(t) === g);
                    if (valid) s.activeByGroup[g] = want!;
                    else if (
                      !s.activeByGroup[g] ||
                      !s.tabs.find((t) => t.id === s.activeByGroup[g] && groupOf(t) === g)
                    ) {
                      s.activeByGroup[g] = s.tabs.find((t) => groupOf(t) === g)?.id ?? null;
                    }
                  }
                  // Legacy: no per-group active map — fall back to activeTabId.
                  if (
                    !data.activeByGroup &&
                    data.activeTabId &&
                    s.tabs.find((t) => t.id === data.activeTabId)
                  ) {
                    s.activeByGroup[DEFAULT_GROUP] = data.activeTabId;
                  }
                  s.focusedGroupId =
                    data.focusedGroupId && s.groupOrder.includes(data.focusedGroupId)
                      ? data.focusedGroupId
                      : s.groupOrder[0];
                  syncActiveMirror(s);
                  keepMainForSessions(s);
                });
              }
            } catch {
              // no saved state
            }
          },
        },
      })),
      {
        // Persist only durable UI layout preferences across app
        // restarts — panel visibility/widths, the KB panel layout, etc.
        // Tabs/history/actions are session- or project-scoped and are
        // restored separately (saveEditorState / project bootstrap), so
        // they're deliberately excluded.
        name: "atlas-layout-prefs",
        version: 2,
        partialize: (s) => ({
          // Derived, not a field: the tab is the truth while the app runs.
          teamChat: { open: s.tabs.some((t) => t.type === "team-chat") },
          sourceControl: s.sourceControl,
          knowledgePanel: s.knowledgePanel,
          bashPanel: s.bashPanel,
          plansPanel: s.plansPanel,
          timelinePanel: s.timelinePanel,
          lastForm: s.lastForm,
        }),
        // One-level-deep merge so persisted slices overlay the defaults
        // without dropping any fields added in newer versions (the
        // default shallow merge would replace whole slices).
        merge: (persisted, current) => {
          const p = (persisted ?? {}) as Partial<LayoutState>;
          // Team chat open at quit reopens. A save from before it was a tab
          // says so as the right slot showing chat (`rightPanel`, which source
          // control shared before that, with `mode`).
          const persisted_ = (persisted ?? {}) as {
            teamChat?: { open?: boolean };
            rightPanel?: { visible?: boolean; mode?: string };
          };
          const legacyRight = persisted_.rightPanel;
          const teamChatOpen =
            persisted_.teamChat?.open ??
            (!!legacyRight?.visible &&
              (legacyRight.mode === undefined || legacyRight.mode === "chat"));
          const sourceControl = { ...current.sourceControl, ...p.sourceControl };
          // Coerce a section id that no longer belongs to this panel (e.g. a
          // pre-move `state.json` with "analysis") back to a valid default so
          // the panel isn't blank.
          if (!(SOURCE_CONTROL_SECTIONS as readonly string[]).includes(sourceControl.section)) {
            sourceControl.section = "changes";
          }
          // Tabs whose feature has since been removed (pomodoro, model-chat,
          // research…) still sit in persisted state.json; restoring them
          // yields a permanent placeholder tab. Drop them, and repoint
          // activeTabId if it pointed at one.
          const validTypes = new Set<string>(TAB_TYPES);
          const tabs = (p.tabs ?? current.tabs)
            .map((t) => {
              // Renamed types map forward (mission-control → usage) so the
              // tab survives the rename instead of reading as removed.
              const type = migrateTabType(t.type);
              if (type === null || type === t.type) return t;
              const id = t.id in LEGACY_TAB_TYPES ? LEGACY_TAB_TYPES[t.id] : t.id;
              return { ...t, id, type };
            })
            .filter(
              (t) =>
                validTypes.has(t.type) && !isRetiredTab(t) && !isDestinationOnly(t.type as TabType),
            );
          // Seeded into the tab set here so the first `loadProjectView` (or the
          // projectless shell) carries it like any open team chat.
          if (teamChatOpen && !tabs.some((t) => t.type === "team-chat")) {
            tabs.push({ ...TEAM_CHAT_TAB });
          }
          let activeTabId = p.activeTabId ?? current.activeTabId;
          if (activeTabId !== null && !tabs.some((t) => t.id === activeTabId)) {
            activeTabId = tabs[0]?.id ?? null;
          }
          // `chatSidebar` is the per-chat session column the app sidebar
          // replaced; a save from before carries it, and nothing reads it.
          const {
            rightPanel: _legacy,
            teamChat: _derived,
            chatSidebar: _retired,
            ...rest
          } = p as Partial<LayoutState> & {
            rightPanel?: unknown;
            teamChat?: unknown;
            chatSidebar?: unknown;
          };
          return {
            ...current,
            ...rest,
            lastForm: { ...rest.lastForm },
            tabs,
            activeTabId,
            sourceControl,
            knowledgePanel: { ...current.knowledgePanel, ...p.knowledgePanel },
            bashPanel: { ...current.bashPanel, ...p.bashPanel },
            plansPanel: { ...current.plansPanel, ...p.plansPanel },
          };
        },
      },
    ),
  ),
);
