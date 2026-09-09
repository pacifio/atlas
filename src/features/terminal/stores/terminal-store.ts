import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { createSelectors } from "@/lib/create-selectors";

export type SplitDirection = "horizontal" | "vertical";

export interface PaneNode {
  type: "pane";
  id: string;
  terminals: string[];
  activeTerminalId: string | null;
}

export interface SplitNode {
  type: "split";
  id: string;
  direction: SplitDirection;
  children: TreeNode[];
  /** Child id → percentage, the `Layout` shape react-resizable-panels emits.
   *  Absent until the user drags a separator (equal split until then). */
  sizes?: Record<string, number>;
}

export type TreeNode = PaneNode | SplitNode;

export interface TerminalTabState {
  root: TreeNode;
  activePaneId: string | null;
  /** One pane shown alone (⌘⇧↩). Cleared by any structural change. */
  zoomedPaneId?: string | null;
}

interface PendingTerminalFocus {
  tabId: string;
  requestId: number;
}

interface TerminalState {
  tabs: Record<string, TerminalTabState>;
  /** Per-terminal "a command is running" flag, keyed by the layout terminal id.
   *  Surfaced as a spinner on the tab strip; the BlockTerminal reports it. */
  busy: Record<string, boolean>;
  pendingFocus: PendingTerminalFocus | null;
  /** A command to run in one terminal, once its PTY exists.
   *
   *  Keyed by the LAYOUT TERMINAL id, not by tab. Keying by tab looked simpler
   *  but was wrong twice over: a terminal tab is a singleton per column, so the
   *  tab a caller asks for usually already exists (and `addTab` rewrites the id
   *  even when it does not), and a tab can hold several terminals, so "the
   *  tab's terminal" is not a thing. The opener mints the terminal it wants and
   *  queues against that.
   *
   *  Consumed once — a command must not re-run when the terminal remounts
   *  (HMR, a tab switch that unmounts the panel), which for a login would mean
   *  signing in twice. */
  pendingCommands: Record<string, string>;
  /** Which workspace each terminal TAB belongs to.
   *
   *  A notification about a terminal has to be able to find its way back to
   *  it, and a tab id alone is not enough once the tab has left the layout
   *  mirror (its workspace went to the background). The layout store's view
   *  snapshot knows too, but only after a commit; this is written at the
   *  moment the tab is initialised, by the panel that knows its workspace. */
  owners: Record<string, string>;
}

interface TerminalActions {
  actions: {
    initTab: (tabId: string, workspaceId?: string) => void;
    addTerminalToPane: (tabId: string, paneId: string) => void;
    splitPane: (tabId: string, paneId: string, direction: SplitDirection) => void;
    closeTerminalInPane: (tabId: string, paneId: string, ptyId: string) => void;
    /** Close one terminal wherever it lives.
     *
     *  The opener of a command terminal knows the terminal it minted but not
     *  which pane the panel put it in, and by the time it wants to close it the
     *  user may have moved or split things. */
    closeTerminalById: (ptyId: string) => void;
    closePane: (tabId: string, paneId: string) => void;
    setActiveTerminalInPane: (tabId: string, paneId: string, ptyId: string) => void;
    setActivePane: (tabId: string, paneId: string) => void;
    setTerminalBusy: (ptyId: string, busy: boolean) => void;
    /** Persist a split's proportions after a user drag. */
    setSplitSizes: (tabId: string, splitId: string, sizes: Record<string, number>) => void;
    toggleZoom: (tabId: string, paneId: string) => void;
    /** Pane trees for persistence. */
    exportTrees: (tabIds: string[]) => Record<string, TerminalTabState>;
    /** Restore pane trees. Every id is re-minted so a restored tree can never
     *  collide with a live one; tabs already present are left alone. */
    importTrees: (trees: Record<string, TerminalTabState>) => void;
    requestTerminalFocus: (tabId: string) => void;
    clearPendingTerminalFocus: () => void;
    /** Mint a terminal in `tabId` to run a command in, and return its id.
     *
     *  A NEW terminal every time, even when the tab already has one: the
     *  existing shell may be mid-command, and typing into it would interleave
     *  with whatever the user is doing. */
    addTerminalForCommand: (tabId: string, workspaceId?: string) => string;
    /** Queue a command for one terminal. */
    setPendingCommand: (terminalId: string, command: string) => void;
    /** Take the queued command, if any. Removes it — see `pendingCommands`. */
    takePendingCommand: (terminalId: string) => string | undefined;
    /** Drop several terminal tabs (used when a workspace is DISCARDED). PTYs
     *  are already closed by the BlockTerminal unmount; this frees the trees. */
    removeTabs: (tabIds: string[]) => void;
  };
}

// Random, not a counter: pane trees are persisted and restored (see
// `importTrees`), and a counter that restarts at 0 would hand a fresh terminal
// the id of a restored one.
function genId(prefix: string): string {
  const rnd =
    globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
  return `${prefix}-${rnd}`;
}

function findPane(node: TreeNode, paneId: string): PaneNode | null {
  if (node.type === "pane") return node.id === paneId ? node : null;
  for (const child of node.children) {
    const found = findPane(child, paneId);
    if (found) return found;
  }
  return null;
}

function splitPaneInTree(
  node: TreeNode,
  paneId: string,
  direction: SplitDirection,
  newPane: PaneNode,
): boolean {
  if (node.type === "split") {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      if (child.type === "pane" && child.id === paneId) {
        node.children[i] = {
          type: "split",
          id: genId("split"),
          direction,
          children: [child, newPane],
        };
        return true;
      }
      if (splitPaneInTree(child, paneId, direction, newPane)) return true;
    }
  }
  return false;
}

function removePaneFromTree(node: TreeNode, paneId: string): TreeNode | null {
  if (node.type === "pane") return node.id === paneId ? null : node;
  const newChildren: TreeNode[] = [];
  for (const child of node.children) {
    const result = removePaneFromTree(child, paneId);
    if (result) newChildren.push(result);
  }
  if (newChildren.length === 0) return null;
  if (newChildren.length === 1) return newChildren[0];
  // Drop the removed child's share and renormalise the rest to 100.
  let sizes: Record<string, number> | undefined;
  if (node.sizes) {
    const kept = newChildren.map((c) => [c.id, node.sizes![c.id] ?? 0] as const);
    const total = kept.reduce((a, [, v]) => a + v, 0);
    sizes =
      total > 0 ? Object.fromEntries(kept.map(([id, v]) => [id, (v / total) * 100])) : undefined;
  }
  return { ...node, children: newChildren, sizes };
}

function findSplit(node: TreeNode, splitId: string): SplitNode | null {
  if (node.type === "pane") return null;
  if (node.id === splitId) return node;
  for (const c of node.children) {
    const hit = findSplit(c, splitId);
    if (hit) return hit;
  }
  return null;
}

/** Deep-copy a tree with fresh ids, mapping `sizes` keys along. */
function remintTree(node: TreeNode): TreeNode {
  if (node.type === "pane") {
    const terminals = node.terminals.map(() => genId("pty"));
    const activeIdx = node.activeTerminalId ? node.terminals.indexOf(node.activeTerminalId) : -1;
    return {
      type: "pane",
      id: genId("pane"),
      terminals,
      activeTerminalId: terminals[activeIdx >= 0 ? activeIdx : 0] ?? null,
    };
  }
  const children = node.children.map(remintTree);
  let sizes: Record<string, number> | undefined;
  if (node.sizes) {
    sizes = {};
    node.children.forEach((old, i) => {
      const v = node.sizes![old.id];
      if (v != null) sizes![children[i].id] = v;
    });
  }
  return { type: "split", id: genId("split"), direction: node.direction, children, sizes };
}

export function collectPanes(node: TreeNode): PaneNode[] {
  if (node.type === "pane") return [node];
  return node.children.flatMap(collectPanes);
}

/** Where a terminal lives: its tab and pane, or null if it is in no tree. */
export function findTerminal(
  tabs: Record<string, TerminalTabState>,
  terminalId: string,
): { tabId: string; paneId: string } | null {
  for (const [tabId, t] of Object.entries(tabs)) {
    const pane = collectPanes(t.root).find((p) => p.terminals.includes(terminalId));
    if (pane) return { tabId, paneId: pane.id };
  }
  return null;
}

export const useTerminalStore = createSelectors(
  create<TerminalState & TerminalActions>()(
    immer((set, get) => ({
      tabs: {},
      busy: {},
      pendingFocus: null,
      pendingCommands: {},
      owners: {},
      actions: {
        initTab: (tabId, workspaceId) => {
          if (get().tabs[tabId]) {
            // Already seeded (e.g. by addTerminalForCommand); still record the
            // owner if we learn it now.
            if (workspaceId && get().owners[tabId] !== workspaceId) {
              set((s) => {
                s.owners[tabId] = workspaceId;
              });
            }
            return;
          }
          const ptyId = genId("pty");
          const paneId = genId("pane");
          set((s) => {
            s.tabs[tabId] = {
              root: { type: "pane", id: paneId, terminals: [ptyId], activeTerminalId: ptyId },
              activePaneId: paneId,
            };
            if (workspaceId) s.owners[tabId] = workspaceId;
          });
        },

        addTerminalToPane: (tabId, paneId) => {
          set((s) => {
            const t = s.tabs[tabId];
            if (!t) return;
            const pane = findPane(t.root, paneId);
            if (!pane) return;
            const ptyId = genId("pty");
            pane.terminals.push(ptyId);
            pane.activeTerminalId = ptyId;
          });
        },

        splitPane: (tabId, paneId, direction) => {
          set((s) => {
            const t = s.tabs[tabId];
            if (!t) return;
            const newPtyId = genId("pty");
            const newPaneId = genId("pane");
            const newPane: PaneNode = {
              type: "pane",
              id: newPaneId,
              terminals: [newPtyId],
              activeTerminalId: newPtyId,
            };
            if (t.root.type === "pane" && t.root.id === paneId) {
              t.root = {
                type: "split",
                id: genId("split"),
                direction,
                children: [t.root, newPane],
              };
            } else {
              splitPaneInTree(t.root, paneId, direction, newPane);
            }
            t.activePaneId = newPaneId;
            t.zoomedPaneId = null;
          });
        },

        closeTerminalInPane: (tabId, paneId, ptyId) => {
          set((s) => {
            // A queued command outlives nothing: its terminal is gone, and the
            // line can hold an agent's login.
            delete s.pendingCommands[ptyId];
            const t = s.tabs[tabId];
            if (!t) return;
            const pane = findPane(t.root, paneId);
            if (!pane) return;
            const closedIdx = pane.terminals.indexOf(ptyId);
            pane.terminals = pane.terminals.filter((id) => id !== ptyId);
            if (pane.terminals.length === 0) {
              const result = removePaneFromTree(t.root, paneId);
              if (!result) {
                delete s.tabs[tabId];
                delete s.owners[tabId];
                return;
              }
              t.root = result;
              t.zoomedPaneId = null;
              if (t.activePaneId === paneId) {
                t.activePaneId = collectPanes(t.root)[0]?.id ?? null;
              }
            } else if (pane.activeTerminalId === ptyId) {
              // Activate the LEFT neighbour (the tab that was at closedIdx-1);
              // items before the closed one keep their indices after filtering.
              const nextIdx = Math.min(Math.max(0, closedIdx - 1), pane.terminals.length - 1);
              pane.activeTerminalId = pane.terminals[nextIdx];
            }
          });
        },

        closeTerminalById: (ptyId) => {
          for (const [tabId, t] of Object.entries(get().tabs)) {
            const pane = collectPanes(t.root).find((p) => p.terminals.includes(ptyId));
            if (pane) {
              get().actions.closeTerminalInPane(tabId, pane.id, ptyId);
              return;
            }
          }
          // Never mounted, or already closed — the queued command must still go
          // (it can hold an agent's login).
          set((s) => {
            delete s.pendingCommands[ptyId];
          });
        },

        closePane: (tabId, paneId) => {
          set((s) => {
            const t = s.tabs[tabId];
            if (!t) return;
            const result = removePaneFromTree(t.root, paneId);
            if (!result) {
              delete s.tabs[tabId];
              delete s.owners[tabId];
              return;
            }
            t.root = result;
            t.zoomedPaneId = null;
            if (t.activePaneId === paneId) {
              t.activePaneId = collectPanes(t.root)[0]?.id ?? null;
            }
          });
        },

        setActiveTerminalInPane: (tabId, paneId, ptyId) => {
          set((s) => {
            const t = s.tabs[tabId];
            if (!t) return;
            const pane = findPane(t.root, paneId);
            if (pane) pane.activeTerminalId = ptyId;
          });
        },

        setActivePane: (tabId, paneId) => {
          set((s) => {
            const t = s.tabs[tabId];
            if (t) t.activePaneId = paneId;
          });
        },

        setTerminalBusy: (ptyId, busy) => {
          set((s) => {
            if (busy) s.busy[ptyId] = true;
            else delete s.busy[ptyId];
          });
        },

        setSplitSizes: (tabId, splitId, sizes) =>
          set((s) => {
            const t = s.tabs[tabId];
            if (!t) return;
            const split = findSplit(t.root, splitId);
            if (split) split.sizes = { ...sizes };
          }),

        toggleZoom: (tabId, paneId) =>
          set((s) => {
            const t = s.tabs[tabId];
            if (!t) return;
            t.zoomedPaneId = t.zoomedPaneId === paneId ? null : paneId;
          }),

        exportTrees: (tabIds) => {
          const out: Record<string, TerminalTabState> = {};
          const tabs = get().tabs;
          for (const id of tabIds) if (tabs[id]) out[id] = tabs[id];
          return out;
        },

        importTrees: (trees) =>
          set((s) => {
            for (const [tabId, t] of Object.entries(trees)) {
              if (s.tabs[tabId]) continue;
              const root = remintTree(t.root);
              const panes = collectPanes(root);
              s.tabs[tabId] = {
                root,
                activePaneId: panes[0]?.id ?? null,
                zoomedPaneId: null,
              };
            }
          }),

        addTerminalForCommand: (tabId, workspaceId) => {
          const ptyId = genId("pty");
          set((s) => {
            const paneId = genId("pane");
            if (workspaceId) s.owners[tabId] = workspaceId;
            const t = s.tabs[tabId];
            if (!t) {
              // The tab has no terminal state yet — it was just created, and
              // the panel has not mounted to `initTab` it. Seed it, so the
              // terminal we hand back is the one that mounts.
              s.tabs[tabId] = {
                root: { type: "pane", id: paneId, terminals: [ptyId], activeTerminalId: ptyId },
                activePaneId: paneId,
              };
              return;
            }
            const pane =
              (t.activePaneId && findPane(t.root, t.activePaneId)) ?? collectPanes(t.root)[0];
            if (!pane) return;
            pane.terminals.push(ptyId);
            pane.activeTerminalId = ptyId;
            t.activePaneId = pane.id;
          });
          return ptyId;
        },

        setPendingCommand: (terminalId, command) =>
          set((s) => {
            s.pendingCommands[terminalId] = command;
          }),

        takePendingCommand: (terminalId) => {
          const command = get().pendingCommands[terminalId];
          if (command === undefined) return undefined;
          set((s) => {
            delete s.pendingCommands[terminalId];
          });
          return command;
        },

        requestTerminalFocus: (tabId) => {
          set((s) => {
            s.pendingFocus = { tabId, requestId: (s.pendingFocus?.requestId ?? 0) + 1 };
          });
        },

        clearPendingTerminalFocus: () => {
          set((s) => {
            s.pendingFocus = null;
          });
        },
        removeTabs: (tabIds) =>
          set((s) => {
            for (const id of tabIds) {
              // Any command still queued for a terminal in this tab will never
              // run — and the line can hold an agent's login.
              for (const pane of s.tabs[id] ? collectPanes(s.tabs[id].root) : []) {
                for (const terminalId of pane.terminals) delete s.pendingCommands[terminalId];
              }
              delete s.tabs[id];
              delete s.owners[id];
            }
          }),
      },
    })),
  ),
);
