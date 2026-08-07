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
}

export type TreeNode = PaneNode | SplitNode;

export interface TerminalTabState {
  root: TreeNode;
  activePaneId: string | null;
}

interface TerminalState {
  tabs: Record<string, TerminalTabState>;
  /** Per-terminal "a command is running" flag, keyed by the layout terminal id.
   *  Surfaced as a spinner on the tab strip; the BlockTerminal reports it. */
  busy: Record<string, boolean>;
}

interface TerminalActions {
  actions: {
    initTab: (tabId: string) => void;
    addTerminalToPane: (tabId: string, paneId: string) => void;
    splitPane: (tabId: string, paneId: string, direction: SplitDirection) => void;
    closeTerminalInPane: (tabId: string, paneId: string, ptyId: string) => void;
    closePane: (tabId: string, paneId: string) => void;
    setActiveTerminalInPane: (tabId: string, paneId: string, ptyId: string) => void;
    setActivePane: (tabId: string, paneId: string) => void;
    setTerminalBusy: (ptyId: string, busy: boolean) => void;
    /** Drop several terminal tabs (used when a workspace is DISCARDED). PTYs
     *  are already closed by the BlockTerminal unmount; this frees the trees. */
    removeTabs: (tabIds: string[]) => void;
  };
}

let counter = 0;
function genId(prefix: string): string {
  return `${prefix}-${++counter}-${Math.random().toString(36).slice(2, 5)}`;
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
  return { ...node, children: newChildren };
}

export function collectPanes(node: TreeNode): PaneNode[] {
  if (node.type === "pane") return [node];
  return node.children.flatMap(collectPanes);
}

export const useTerminalStore = createSelectors(
  create<TerminalState & TerminalActions>()(
    immer((set, get) => ({
      tabs: {},
      busy: {},
      actions: {
        initTab: (tabId) => {
          if (get().tabs[tabId]) return;
          const ptyId = genId("pty");
          const paneId = genId("pane");
          set((s) => {
            s.tabs[tabId] = {
              root: { type: "pane", id: paneId, terminals: [ptyId], activeTerminalId: ptyId },
              activePaneId: paneId,
            };
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
          });
        },

        closeTerminalInPane: (tabId, paneId, ptyId) => {
          set((s) => {
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
                return;
              }
              t.root = result;
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

        closePane: (tabId, paneId) => {
          set((s) => {
            const t = s.tabs[tabId];
            if (!t) return;
            const result = removePaneFromTree(t.root, paneId);
            if (!result) {
              delete s.tabs[tabId];
              return;
            }
            t.root = result;
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

        removeTabs: (tabIds) =>
          set((s) => {
            for (const id of tabIds) delete s.tabs[id];
          }),
      },
    })),
  ),
);
