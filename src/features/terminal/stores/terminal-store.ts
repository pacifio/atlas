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
    requestTerminalFocus: (tabId: string) => void;
    clearPendingTerminalFocus: () => void;
    /** Mint a terminal in `tabId` to run a command in, and return its id.
     *
     *  A NEW terminal every time, even when the tab already has one: the
     *  existing shell may be mid-command, and typing into it would interleave
     *  with whatever the user is doing. */
    addTerminalForCommand: (tabId: string) => string;
    /** Queue a command for one terminal. */
    setPendingCommand: (terminalId: string, command: string) => void;
    /** Take the queued command, if any. Removes it — see `pendingCommands`. */
    takePendingCommand: (terminalId: string) => string | undefined;
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
      pendingFocus: null,
      pendingCommands: {},
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

        addTerminalForCommand: (tabId) => {
          const ptyId = genId("pty");
          set((s) => {
            const paneId = genId("pane");
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
            }
          }),
      },
    })),
  ),
);
