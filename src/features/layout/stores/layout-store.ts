import { create } from "zustand";
import { persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { createSelectors } from "@/lib/create-selectors";
import { invoke } from "@tauri-apps/api/core";
import type { TabType } from "@/lib/constants";
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

/** A workspace's saved tab/split view — everything needed to restore its
 *  CenterPanel without touching disk. */
export interface WorkspaceView {
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
  leftVisible: boolean;
  rightVisible: boolean;
}

interface LayoutState {
  leftPanel: {
    visible: boolean;
    width: number;
    activeSection: "files" | "knowledge";
    usagePanelHeight: number;
    /** Show the project "Usage" report accordion below the file tree.
     *  Toggled by the chevron in its header. */
    usagePanelVisible: boolean;
  };
  rightPanel: {
    visible: boolean;
    width: number;
    activeSection: "changes" | "github" | "git-graph";
  };
  /** Per-app KB tab layout — survives tab switches (each KB tab gets the
   *  same panel layout, matching the global-left/right model). */
  knowledgePanel: {
    showSidebar: boolean;
    showInspector: boolean;
    sidebarWidth: number;
    inspectorWidth: number;
  };
  bottomPanel: {
    visible: boolean;
    height: number;
  };
  chatSidebar: {
    visible: boolean;
    width: number;
  };
  bashPanel: {
    width: number;
  };
  plansPanel: {
    width: number;
  };
  tabs: Tab[];
  /** Per-workspace saved view (tabs + split layout + history). The singular
   *  fields below (`tabs`/`groupOrder`/`activeByGroup`/…) are a live MIRROR of
   *  the ACTIVE workspace's view; `viewsByWs` holds every *other* open
   *  workspace's last-committed view so CenterPanel can keep their tab subtrees
   *  mounted (hidden) for instant switching. Committed on switch-away. Session
   *  state — excluded from the persist `partialize`. */
  viewsByWs: Record<string, WorkspaceView>;
  /** Which workspace the singular mirror currently represents. */
  currentViewWsId: string | null;
  /** Mirror of the FOCUSED column's active tab — kept in sync so the many
   *  existing readers (status bar, persistence, etc.) don't need to know about
   *  split columns. */
  activeTabId: string | null;
  // ── Split view ──────────────────────────────────────────────────────────
  /** Ordered split columns, left→right. Length 1–3. */
  groupOrder: string[];
  /** Active tab id per column. */
  activeByGroup: Record<string, string | null>;
  /** The column that owns keyboard focus (tab hotkeys target it). */
  focusedGroupId: string;
  /** Zen mode: a focused Knowledge │ Chat │ Browser 3-column split with the
   *  global side panels hidden. `zenPrev` snapshots the layout to restore. */
  zen: boolean;
  zenPrev: ZenSnapshot | null;
  tabBarVisible: boolean;
  // Back/forward stack of tab ids — entries are pushed every time the user
  // navigates to a tab; back() / forward() rewind/advance an index.
  tabHistory: string[];
  tabHistoryIndex: number;
}

interface LayoutActions {
  actions: {
    toggleLeftPanel: () => void;
    toggleRightPanel: () => void;
    toggleBottomPanel: () => void;
    toggleChatSidebar: () => void;
    toggleUsagePanel: () => void;
    toggleKnowledgeSidebar: () => void;
    toggleKnowledgeInspector: () => void;
    setKnowledgeSidebarWidth: (width: number) => void;
    setKnowledgeInspectorWidth: (width: number) => void;
    setChatSidebarWidth: (width: number) => void;
    setBashPanelWidth: (width: number) => void;
    setPlansPanelWidth: (width: number) => void;
    setLeftSection: (section: LayoutState["leftPanel"]["activeSection"]) => void;
    setRightSection: (section: LayoutState["rightPanel"]["activeSection"]) => void;
    /** Make the right panel visible AND switch it to `section` (e.g. open the
     *  Source Control pane from the status bar). */
    revealRightSection: (section: LayoutState["rightPanel"]["activeSection"]) => void;
    addTab: (tab: Tab, groupId?: string) => void;
    closeTab: (id: string) => void;
    setActiveTab: (id: string) => void;
    setTabDirty: (id: string, dirty: boolean) => void;
    toggleTabBar: () => void;
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
    /** Toggle Zen mode: a Knowledge │ Chat │ Browser 3-column split with the
     *  global side panels hidden; toggling again restores the prior layout. */
    toggleZenMode: () => void;
    /** Apply a predefined layout template to the active workspace: set panels +
     *  split columns + a tab of each template type per column (reusing existing
     *  tabs; other open tabs are preserved in the first column). */
    applyLayoutTemplate: (template: LayoutTemplate) => void;
    saveEditorState: (projectPath: string) => void;
    /** Awaitable variant of `saveEditorState` used by the workspace flush
     *  coordinator — resolves only once the editor-state write hits disk. */
    flushEditorState: (projectPath: string) => Promise<void>;
    loadEditorState: (projectPath: string) => Promise<void>;
    // ── Multi-workspace view (mounted-tabs fast switching) ──
    /** Save the active mirror into `viewsByWs[wsId]` (on switch-away / quit). */
    commitWorkspaceView: (wsId: string) => void;
    /** Load `viewsByWs[wsId]` (or a fresh welcome view) into the mirror. */
    loadWorkspaceView: (wsId: string) => void;
    /** Drop a workspace's saved view (on close). */
    removeWorkspaceView: (wsId: string) => void;
  };
}

const initialState: LayoutState = {
  leftPanel: {
    visible: true,
    width: 240,
    activeSection: "files",
    usagePanelHeight: 220,
    usagePanelVisible: false,
  },
  rightPanel: {
    visible: true,
    width: 280,
    activeSection: "changes",
  },
  knowledgePanel: {
    showSidebar: true,
    showInspector: true,
    sidebarWidth: 240,
    inspectorWidth: 280,
  },
  bottomPanel: {
    visible: true,
    height: 32,
  },
  chatSidebar: {
    visible: true,
    width: 220,
  },
  bashPanel: {
    width: 260,
  },
  plansPanel: {
    width: 380,
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
  tabBarVisible: true,
  tabHistory: ["welcome-chat"],
  tabHistoryIndex: 0,
};

const DEFAULT_GROUP = "main";
const MAX_GROUPS = 3;

function groupOf(tab: Tab | undefined): string {
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
 *  tab, and focus is valid. Used after bulk group changes (workspace restore,
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

const WELCOME_TAB = (groupId: string): Tab => ({
  id: "welcome-chat",
  type: "chat",
  title: "Chat",
  closable: false,
  dirty: false,
  data: {},
  groupId,
});

/** Per-workspace welcome tab id — distinct so two workspaces' welcome chats
 *  don't collide in `chat-store.sessions` (which keys by tab id). */
const welcomeIdFor = (wsId: string): string => `welcome-chat-${wsId}`;

/** A fresh single-welcome-tab view for a workspace never visited this session. */
function welcomeView(wsId: string): WorkspaceView {
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

/** Snapshot the singular mirror fields into a portable WorkspaceView. */
function captureView(s: LayoutState): WorkspaceView {
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

/** Load a WorkspaceView into the singular mirror fields. */
function applyView(s: LayoutState, v: WorkspaceView): void {
  s.tabs = v.tabs.map((t) => ({ ...t }));
  s.activeTabId = v.activeTabId;
  s.groupOrder = [...v.groupOrder];
  s.activeByGroup = { ...v.activeByGroup };
  s.focusedGroupId = v.focusedGroupId;
  s.tabHistory = [...v.tabHistory];
  s.tabHistoryIndex = v.tabHistoryIndex;
}

export const useLayoutStore = createSelectors(
  create<LayoutState & LayoutActions>()(
    persist(
      immer((set) => ({
        ...initialState,
        actions: {
          toggleLeftPanel: () =>
            set((s) => {
              s.leftPanel.visible = !s.leftPanel.visible;
            }),
          toggleRightPanel: () =>
            set((s) => {
              s.rightPanel.visible = !s.rightPanel.visible;
            }),
          toggleBottomPanel: () =>
            set((s) => {
              s.bottomPanel.visible = !s.bottomPanel.visible;
            }),
          toggleChatSidebar: () =>
            set((s) => {
              s.chatSidebar.visible = !s.chatSidebar.visible;
            }),
          toggleUsagePanel: () =>
            set((s) => {
              s.leftPanel.usagePanelVisible = !s.leftPanel.usagePanelVisible;
            }),
          toggleKnowledgeSidebar: () =>
            set((s) => {
              s.knowledgePanel.showSidebar = !s.knowledgePanel.showSidebar;
            }),
          toggleKnowledgeInspector: () =>
            set((s) => {
              s.knowledgePanel.showInspector = !s.knowledgePanel.showInspector;
            }),
          setKnowledgeSidebarWidth: (width) =>
            set((s) => {
              s.knowledgePanel.sidebarWidth = Math.max(180, Math.min(width, 480));
            }),
          setKnowledgeInspectorWidth: (width) =>
            set((s) => {
              s.knowledgePanel.inspectorWidth = Math.max(220, Math.min(width, 520));
            }),
          setChatSidebarWidth: (width) =>
            set((s) => {
              s.chatSidebar.width = Math.max(160, Math.min(width, 420));
            }),
          setBashPanelWidth: (width) =>
            set((s) => {
              s.bashPanel.width = Math.max(200, Math.min(width, 480));
            }),
          setPlansPanelWidth: (width) =>
            set((s) => {
              s.plansPanel.width = Math.max(300, Math.min(width, 640));
            }),
          setLeftSection: (section) =>
            set((s) => {
              s.leftPanel.activeSection = section;
            }),
          setRightSection: (section) =>
            set((s) => {
              s.rightPanel.activeSection = section;
            }),
          revealRightSection: (section) =>
            set((s) => {
              s.rightPanel.visible = true;
              s.rightPanel.activeSection = section;
            }),
          addTab: (tab, groupId) =>
            set((s) => {
              // chat: each session is its own tab. File-backed viewers (editor /
              // diff / media / svg / pdf / unsupported) are one-per-FILE (deduped
              // by id, which is `${type}:${path}`) so opening a different file
              // always gets its own tab. Everything else is a singleton PER COLUMN
              // (focus the existing instance in the target column, else open one).
              const allowMultiple =
                tab.type === "editor" ||
                tab.type === "diff" ||
                tab.type === "chat" ||
                tab.type === "media" ||
                tab.type === "svg" ||
                tab.type === "pdf" ||
                tab.type === "unsupported";

              let targetId = tab.id;
              // Where the tab lands: caller-specified column, else the focused one.
              let targetGroup = groupId ?? s.focusedGroupId;
              if (!s.groupOrder.includes(targetGroup)) targetGroup = s.focusedGroupId;

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
              pushTabHistory(s, targetId);
              syncActiveMirror(s);
            }),
          closeTab: (id) =>
            set((s) => {
              const idx = s.tabs.findIndex((t) => t.id === id);
              if (idx === -1) return;
              const tab = s.tabs[idx];
              if (!tab.closable) return;
              const grp = groupOf(tab);
              const groupIdxInGroup = s.tabs
                .filter((t) => groupOf(t) === grp)
                .findIndex((t) => t.id === id);
              s.tabs.splice(idx, 1);

              const remaining = s.tabs.filter((t) => groupOf(t) === grp);
              if (remaining.length === 0) {
                if (s.groupOrder.length > 1) {
                  // The column emptied — collapse the split.
                  s.groupOrder = s.groupOrder.filter((g) => g !== grp);
                  delete s.activeByGroup[grp];
                  if (s.focusedGroupId === grp) s.focusedGroupId = s.groupOrder[0];
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
            }),
          setActiveTab: (id) =>
            set((s) => {
              const tab = s.tabs.find((t) => t.id === id);
              const target = tab ? id : (s.tabs[0]?.id ?? null);
              if (target === null) return;
              const grp = groupOf(s.tabs.find((t) => t.id === target));
              s.focusedGroupId = grp;
              s.activeByGroup[grp] = target;
              pushTabHistory(s, target);
              syncActiveMirror(s);
            }),
          toggleTabBar: () =>
            set((s) => {
              s.tabBarVisible = !s.tabBarVisible;
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
              syncActiveMirror(s);
            }),
          closeGroup: (groupId) =>
            set((s) => {
              if (s.groupOrder.length <= 1) return;
              const gi = s.groupOrder.indexOf(groupId);
              if (gi === -1) return;
              const leftId = s.groupOrder[gi - 1] ?? s.groupOrder[gi + 1];
              // Move the column's tabs to the neighbour (they remount there).
              for (const t of s.tabs) {
                if (groupOf(t) === groupId) t.groupId = leftId;
              }
              const moved = s.activeByGroup[groupId];
              s.groupOrder.splice(gi, 1);
              delete s.activeByGroup[groupId];
              if (moved) s.activeByGroup[leftId] = moved;
              s.focusedGroupId = leftId;
              syncActiveMirror(s);
            }),
          toggleZenMode: () =>
            set((s) => {
              // Exit: restore the snapshot.
              if (s.zen && s.zenPrev) {
                const p = s.zenPrev;
                s.leftPanel.visible = p.leftVisible;
                s.rightPanel.visible = p.rightVisible;
                s.groupOrder = p.groupOrder.length ? [...p.groupOrder] : [DEFAULT_GROUP];
                s.activeByGroup = { ...p.activeByGroup };
                s.focusedGroupId = p.focusedGroupId;
                for (const t of s.tabs) t.groupId = p.tabGroups[t.id] ?? s.groupOrder[0];
                s.zen = false;
                s.zenPrev = null;
                reconcileGroups(s);
                return;
              }
              // Enter: snapshot the current layout, then build Knowledge │ Chat │
              // Browser with the side panels hidden.
              const tabGroups: Record<string, string> = {};
              for (const t of s.tabs) tabGroups[t.id] = groupOf(t);
              s.zenPrev = {
                groupOrder: [...s.groupOrder],
                activeByGroup: { ...s.activeByGroup },
                focusedGroupId: s.focusedGroupId,
                tabGroups,
                leftVisible: s.leftPanel.visible,
                rightVisible: s.rightPanel.visible,
              };
              const G_KB = "zen-kb";
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
              const kbId = ensure("knowledge", "Knowledge", G_KB);
              // A chat tab always exists (welcome-chat is the non-closable baseline).
              let chat = s.tabs.find((x) => x.type === "chat");
              if (!chat) {
                chat = {
                  id: "chat-zen",
                  type: "chat",
                  title: "Chat",
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
              s.groupOrder = [G_KB, G_CHAT, G_BROWSER];
              s.activeByGroup = { [G_KB]: kbId, [G_CHAT]: chat.id, [G_BROWSER]: browserId };
              s.focusedGroupId = G_CHAT;
              s.leftPanel.visible = false;
              s.rightPanel.visible = false;
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
              // validate actives/focus.
              reconcileGroups(s);

              // Panels — left/right are explicitly controlled by templates;
              // bottom (status bar) is only touched when a template opts in.
              s.leftPanel.visible = !!template.panels.left;
              s.rightPanel.visible = !!template.panels.right;
              if (template.panels.bottom !== undefined)
                s.bottomPanel.visible = template.panels.bottom;
              if (template.leftSection) s.leftPanel.activeSection = template.leftSection;
              if (template.rightSection) s.rightPanel.activeSection = template.rightSection;
            }),
          setTabDirty: (id, dirty) =>
            set((s) => {
              const tab = s.tabs.find((t) => t.id === id);
              if (tab) tab.dirty = dirty;
            }),
          // Persist the whole workspace layout (split columns + their tabs) per
          // project so the AKB arrangement comes back on reopen. The Rust
          // save/load commands store the JSON opaquely, so the shape is ours.
          saveEditorState: (projectPath) => {
            const state = useLayoutStore.getState();
            // Zen mode is a transient overlay — don't persist its 3-column layout
            // over the real workspace (the pre-zen snapshot stays saved, so
            // quitting in zen reopens the underlying layout).
            if (state.zen) return;
            // Persist every closable tab (welcome-chat is the recreated baseline).
            const tabs = state.tabs
              .filter((t) => t.closable)
              .map((t) => ({
                id: t.id,
                type: t.type,
                title: t.title,
                data: t.data,
                groupId: groupOf(t),
              }));
            const data = {
              version: 2,
              tabs,
              groupOrder: state.groupOrder,
              activeByGroup: state.activeByGroup,
              focusedGroupId: state.focusedGroupId,
              activeTabId: state.activeTabId, // legacy readers
            };
            invoke("save_editor_state", {
              projectPath,
              stateJson: JSON.stringify(data),
            }).catch(() => {});
          },
          flushEditorState: async (projectPath) => {
            const state = useLayoutStore.getState();
            if (state.zen) return;
            const tabs = state.tabs
              .filter((t) => t.closable)
              .map((t) => ({
                id: t.id,
                type: t.type,
                title: t.title,
                data: t.data,
                groupId: groupOf(t),
              }));
            const data = {
              version: 2,
              tabs,
              groupOrder: state.groupOrder,
              activeByGroup: state.activeByGroup,
              focusedGroupId: state.focusedGroupId,
              activeTabId: state.activeTabId,
            };
            await invoke("save_editor_state", {
              projectPath,
              stateJson: JSON.stringify(data),
            }).catch(() => {});
          },
          commitWorkspaceView: (wsId) =>
            set((s) => {
              s.viewsByWs[wsId] = captureView(s);
              s.currentViewWsId = wsId;
            }),
          loadWorkspaceView: (wsId) =>
            set((s) => {
              const v = s.viewsByWs[wsId] ?? welcomeView(wsId);
              applyView(s, v);
              s.currentViewWsId = wsId;
            }),
          removeWorkspaceView: (wsId) =>
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
              };
              if (data.tabs && data.tabs.length > 0) {
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
                    if (s.tabs.find((t) => t.id === saved.id)) continue;
                    let gid = saved.groupId ?? DEFAULT_GROUP;
                    if (!s.groupOrder.includes(gid)) gid = s.groupOrder[0];
                    s.tabs.push({
                      id: saved.id,
                      type: saved.type as TabType,
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
        version: 1,
        partialize: (s) => ({
          leftPanel: s.leftPanel,
          rightPanel: s.rightPanel,
          knowledgePanel: s.knowledgePanel,
          bottomPanel: s.bottomPanel,
          chatSidebar: s.chatSidebar,
          bashPanel: s.bashPanel,
          plansPanel: s.plansPanel,
          tabBarVisible: s.tabBarVisible,
        }),
        // One-level-deep merge so persisted slices overlay the defaults
        // without dropping any fields added in newer versions (the
        // default shallow merge would replace whole slices).
        merge: (persisted, current) => {
          const p = (persisted ?? {}) as Partial<LayoutState>;
          const leftPanel = { ...current.leftPanel, ...p.leftPanel };
          const rightPanel = { ...current.rightPanel, ...p.rightPanel };
          // Coerce section ids that no longer belong to this panel (e.g. a
          // pre-move `state.json` with "git-graph" on the left or "analysis"
          // on the right) back to a valid default so the panel isn't blank.
          const LEFT = ["files", "knowledge"];
          const RIGHT = ["changes", "github", "git-graph"];
          if (!LEFT.includes(leftPanel.activeSection)) leftPanel.activeSection = "files";
          if (!RIGHT.includes(rightPanel.activeSection)) rightPanel.activeSection = "changes";
          return {
            ...current,
            ...p,
            leftPanel,
            rightPanel,
            knowledgePanel: { ...current.knowledgePanel, ...p.knowledgePanel },
            bottomPanel: { ...current.bottomPanel, ...p.bottomPanel },
            chatSidebar: { ...current.chatSidebar, ...p.chatSidebar },
            bashPanel: { ...current.bashPanel, ...p.bashPanel },
            plansPanel: { ...current.plansPanel, ...p.plansPanel },
          };
        },
      },
    ),
  ),
);
