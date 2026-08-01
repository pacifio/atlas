import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { createSelectors } from "@/lib/create-selectors";
import { invoke } from "@tauri-apps/api/core";
import { useProjectStore } from "@/features/project/stores/project-store";

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
  size: number;
  extension: string | null;
}

export interface TreeNode {
  entry: FileEntry;
  children: TreeNode[] | null; // null = not loaded, [] = empty
  expanded: boolean;
  depth: number;
}

/** Drop dotfiles/dot-dirs unless the user enabled "Show hidden files" in
 *  Settings → General. The Rust `read_directory` command returns every
 *  entry; visibility is purely a frontend concern. Read live so the next
 *  directory fetch after a toggle reflects the new preference. */
function applyHiddenFilter(entries: FileEntry[]): FileEntry[] {
  const showHidden = useProjectStore.getState().settings.showHiddenFiles;
  return showHidden ? entries : entries.filter((e) => !e.name.startsWith("."));
}

interface ExplorerState {
  rootPath: string | null;
  tree: TreeNode[];
  loading: boolean;
  /** Cut/Copy clipboard for paste. Holds one or more paths so a
   *  multi-selection can be cut/copied at once. `null` when empty. */
  clipboard: { paths: string[]; isCut: boolean } | null;
  /** Multi-selection (Finder/Zed-style). The set of rows the user has
   *  selected via plain / ⌘-click / ⇧-click. Context-menu actions
   *  (cut/copy/delete/copy-path) operate on this set when the
   *  right-clicked row is part of it. */
  selectedPaths: string[];
  /** Anchor row for ⇧-click range selection (the last plain/⌘-clicked
   *  row). `null` when there's no selection. */
  selectionAnchor: string | null;
  /** Path of the row currently in inline-rename mode (`null` = none). */
  pendingRenamePath: string | null;
  /** Pending New File / New Folder ghost row, scoped to a parent dir.
   *  When set, the file-tree renders an extra input row inside
   *  `parentDir` for the user to type a filename. */
  pendingNewEntry: { parentDir: string; isDir: boolean } | null;
}

interface ExplorerActions {
  actions: {
    openFolder: (path: string) => Promise<void>;
    toggleExpand: (path: string) => Promise<void>;
    /** Re-fetch a specific directory's children and reconcile in
     *  place, preserving expansion state of any subtrees that
     *  survive the refresh. Used by the filesystem-watcher listener
     *  to incrementally patch the tree when the agent (or anything
     *  else) writes a file in the project. No-op if the directory
     *  isn't currently loaded in the tree. */
    reconcileDirectory: (dirPath: string) => Promise<void>;
    /** Full re-walk of the visible tree. Called when the watcher
     *  reports an opaque event (`fullRefresh: true`) that can't be
     *  pinned to a specific dir, OR programmatically when needed. */
    refresh: () => Promise<void>;
    /** Force a folder open if not already loaded. Used before a "New
     *  File" ghost row so the user sees the input inside the target
     *  folder. */
    ensureExpanded: (dirPath: string) => Promise<void>;
    /** Collapse every expanded folder in the tree (root stays mounted). */
    collapseAll: () => void;
    /** Expand every directory whose children are already loaded. We
     *  intentionally don't fetch new directories — a full deep walk on
     *  a large repo can be expensive. Folders the user hasn't visited
     *  yet stay closed; subsequent click opens them normally. */
    expandAllLoaded: () => void;
    setClipboard: (paths: string[], isCut: boolean) => void;
    clearClipboard: () => void;
    /** Replace the selection with `paths`; sets the range anchor. */
    setSelection: (paths: string[], anchor?: string | null) => void;
    /** Toggle a single path in/out of the selection (⌘-click). */
    toggleSelection: (path: string) => void;
    clearSelection: () => void;
    beginRename: (path: string) => void;
    endRename: () => void;
    beginNewEntry: (parentDir: string, isDir: boolean) => void;
    endNewEntry: () => void;
  };
}

export const useExplorerStore = createSelectors(
  create<ExplorerState & ExplorerActions>()(
    immer((set, get) => ({
      rootPath: null,
      tree: [],
      loading: false,
      clipboard: null,
      selectedPaths: [],
      selectionAnchor: null,
      pendingRenamePath: null,
      pendingNewEntry: null,
      actions: {
        openFolder: async (path: string) => {
          set((s) => {
            s.rootPath = path;
            s.loading = true;
          });
          try {
            const entries = await invoke<FileEntry[]>("read_directory", {
              path,
            });
            const nodes: TreeNode[] = applyHiddenFilter(entries).map((e) => ({
              entry: e,
              children: e.is_dir ? null : [],
              expanded: false,
              depth: 0,
            }));
            set((s) => {
              s.tree = nodes;
              s.loading = false;
            });
          } catch {
            set((s) => {
              s.loading = false;
            });
          }
        },
        toggleExpand: async (path: string) => {
          const state = get();
          const node = findNode(state.tree, path);
          if (!node || !node.entry.is_dir) return;

          if (node.expanded) {
            set((s) => {
              const n = findNode(s.tree, path);
              if (n) n.expanded = false;
            });
            return;
          }

          if (node.children === null) {
            try {
              const entries = await invoke<FileEntry[]>("read_directory", {
                path,
              });
              set((s) => {
                const n = findNode(s.tree, path);
                if (n) {
                  n.children = applyHiddenFilter(entries).map((e) => ({
                    entry: e,
                    children: e.is_dir ? null : [],
                    expanded: false,
                    depth: n.depth + 1,
                  }));
                  n.expanded = true;
                }
              });
            } catch {
              // failed to read
            }
          } else {
            set((s) => {
              const n = findNode(s.tree, path);
              if (n) n.expanded = true;
            });
          }
        },
        reconcileDirectory: async (dirPath: string) => {
          const state = get();
          // Root re-walk if this is the project root.
          if (state.rootPath === dirPath) {
            try {
              const entries = await invoke<FileEntry[]>("read_directory", {
                path: dirPath,
              });
              set((s) => {
                s.tree = reconcileChildren(s.tree, entries, 0);
              });
            } catch {
              // ignore — agent may have just deleted the directory; the
              // tree's stale view will self-correct on next event.
            }
            return;
          }
          // Sub-dir: only refetch if it's currently loaded (children !== null).
          const existing = findNode(state.tree, dirPath);
          if (
            !existing ||
            !existing.entry.is_dir ||
            existing.children === null
          ) {
            return;
          }
          try {
            const entries = await invoke<FileEntry[]>("read_directory", {
              path: dirPath,
            });
            set((s) => {
              const n = findNode(s.tree, dirPath);
              if (!n || n.children === null) return;
              n.children = reconcileChildren(n.children, entries, n.depth + 1);
            });
          } catch {
            // ignore
          }
        },
        refresh: async () => {
          const rootPath = get().rootPath;
          if (rootPath) {
            await get().actions.reconcileDirectory(rootPath);
            // Also reconcile every expanded-loaded subtree so a full
            // refresh actually catches changes deeper in the tree.
            const expandedDirs: string[] = [];
            collectExpandedDirs(get().tree, expandedDirs);
            for (const dir of expandedDirs) {
              await get().actions.reconcileDirectory(dir);
            }
          }
        },
        ensureExpanded: async (dirPath: string) => {
          const root = get().rootPath;
          if (root === dirPath) return;
          const node = findNode(get().tree, dirPath);
          if (!node || !node.entry.is_dir) return;
          if (node.expanded && node.children !== null) return;
          await get().actions.toggleExpand(dirPath);
          // Defensive: if it ended up collapsed (the toggle is a
          // flip), force-expand.
          set((s) => {
            const n = findNode(s.tree, dirPath);
            if (n && !n.expanded && n.children !== null) {
              n.expanded = true;
            }
          });
        },
        collapseAll: () => {
          set((s) => {
            collapseAllNodes(s.tree);
          });
        },
        expandAllLoaded: () => {
          set((s) => {
            expandAllLoadedNodes(s.tree);
          });
        },
        setClipboard: (paths, isCut) => {
          set((s) => {
            s.clipboard = paths.length > 0 ? { paths, isCut } : null;
          });
        },
        clearClipboard: () => {
          set((s) => {
            s.clipboard = null;
          });
        },
        setSelection: (paths, anchor) => {
          set((s) => {
            s.selectedPaths = paths;
            // Default the anchor to the last path when not given.
            s.selectionAnchor =
              anchor !== undefined ? anchor : (paths[paths.length - 1] ?? null);
          });
        },
        toggleSelection: (path) => {
          set((s) => {
            if (s.selectedPaths.includes(path)) {
              s.selectedPaths = s.selectedPaths.filter((p) => p !== path);
            } else {
              s.selectedPaths.push(path);
            }
            s.selectionAnchor = path;
          });
        },
        clearSelection: () => {
          set((s) => {
            s.selectedPaths = [];
            s.selectionAnchor = null;
          });
        },
        beginRename: (path) => {
          set((s) => {
            s.pendingRenamePath = path;
            s.pendingNewEntry = null;
          });
        },
        endRename: () => {
          set((s) => {
            s.pendingRenamePath = null;
          });
        },
        beginNewEntry: (parentDir, isDir) => {
          set((s) => {
            s.pendingNewEntry = { parentDir, isDir };
            s.pendingRenamePath = null;
          });
        },
        endNewEntry: () => {
          set((s) => {
            s.pendingNewEntry = null;
          });
        },
      },
    })),
  ),
);

function collapseAllNodes(nodes: TreeNode[]): void {
  for (const n of nodes) {
    if (n.expanded) n.expanded = false;
    if (n.children) collapseAllNodes(n.children);
  }
}

function expandAllLoadedNodes(nodes: TreeNode[]): void {
  for (const n of nodes) {
    if (n.entry.is_dir && n.children !== null && !n.expanded) n.expanded = true;
    if (n.children) expandAllLoadedNodes(n.children);
  }
}

function findNode(nodes: TreeNode[], path: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.entry.path === path) return node;
    if (node.children) {
      const found = findNode(node.children, path);
      if (found) return found;
    }
  }
  return undefined;
}

function collectExpandedDirs(nodes: TreeNode[], out: string[]): void {
  for (const n of nodes) {
    if (n.entry.is_dir && n.expanded && n.children !== null) {
      out.push(n.entry.path);
      collectExpandedDirs(n.children, out);
    }
  }
}

/** Merge a fresh directory listing into an existing children array,
 *  preserving the `expanded` + `children` state of any subtree whose
 *  path still exists. New entries are added (with no preloaded
 *  children); deleted entries are dropped. Used by the watcher
 *  reconciler so opening / expanding / agent-side file writes don't
 *  collapse the user's view. */
function reconcileChildren(
  existing: TreeNode[],
  fresh: FileEntry[],
  depth: number,
): TreeNode[] {
  const filtered = applyHiddenFilter(fresh);
  const byPath = new Map<string, TreeNode>();
  for (const n of existing) byPath.set(n.entry.path, n);
  return filtered.map((e): TreeNode => {
    const prev = byPath.get(e.path);
    if (prev) {
      return {
        ...prev,
        entry: e,
        depth,
      };
    }
    return {
      entry: e,
      children: e.is_dir ? null : [],
      expanded: false,
      depth,
    };
  });
}

export function flattenTree(nodes: TreeNode[]): TreeNode[] {
  const result: TreeNode[] = [];
  for (const node of nodes) {
    result.push(node);
    if (node.expanded && node.children) {
      result.push(...flattenTree(node.children));
    }
  }
  return result;
}
