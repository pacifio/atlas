import { useMemo, useRef, useCallback, useState, useEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@tauri-apps/api/core";
import { activeWorkspaceId } from "@/features/workspaces/lib/active-workspace";
import { toast } from "sonner";
import {
  useExplorerStore,
  flattenTree,
  type FileEntry,
  type TreeNode,
} from "../stores/explorer-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useGitStore } from "@/features/git/stores/git-store";
import { FolderPlus, FoldVertical, UnfoldVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import { PanelSkeleton } from "@/components/panel-skeleton";
import { TreeRow } from "./tree-row";
import { openFile } from "@/lib/open-file";
import { useFileTreeDragDrop, ROOT_DROP } from "../hooks/use-file-tree-drag-drop";
import { useExternalFileDrop } from "../hooks/use-external-file-drop";
import { ROW_HEIGHT } from "../lib/tree-constants";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "@/ui/context-menu";
import { KbdCombo } from "@/ui/kbd";
import { FileTreeConfirmDelete } from "./file-tree-confirm-delete";

/* ── Internal flat-row shape: either a real tree node OR a synthetic
 *    ghost-row carrying the pending new-entry state. The virtualizer
 *    treats both uniformly so the layout stays flicker-free. */

interface FlatRow {
  node: ReturnType<typeof flattenTree>[number] | null;
  ghost?: { parentDir: string; isDir: boolean; depth: number };
}

/** Tab types whose `data.filePath` points at a file on disk — these must be
 *  re-pointed/closed when that file is renamed or deleted. */
const FILE_TAB_TYPES = new Set(["editor", "media", "svg", "pdf", "unsupported"]);

/** Map a git porcelain status char to a gutter-dot color, matching the
 *  Source Control panel's convention (`changes-view.tsx:statusBadge`). */
function gitStatusColor(status: string): string {
  switch (status) {
    case "?": // untracked
    case "A": // added
      return "var(--status-success)";
    case "D": // deleted
    case "U": // unmerged / conflict
      return "var(--status-error)";
    case "R": // renamed
    case "C": // copied
      return "var(--status-info)";
    default: // M and everything else → modified
      return "var(--status-warning)";
  }
}

export function FileTree() {
  const tree = useExplorerStore.use.tree();
  const rootPath = useExplorerStore.use.rootPath();
  const loading = useExplorerStore.use.loading();
  const clipboard = useExplorerStore.use.clipboard();
  const selectedPaths = useExplorerStore.use.selectedPaths();
  const selectionAnchor = useExplorerStore.use.selectionAnchor();
  const pendingRenamePath = useExplorerStore.use.pendingRenamePath();
  const pendingNewEntry = useExplorerStore.use.pendingNewEntry();
  const {
    toggleExpand,
    reconcileDirectory,
    collapseAll,
    expandAllLoaded,
    setClipboard,
    clearClipboard,
    setSelection,
    toggleSelection,
    clearSelection,
    beginRename,
    endRename,
    beginNewEntry,
    endNewEntry,
    ensureExpanded,
  } = useExplorerStore.use.actions();
  const projectPath = useProjectStore.use.currentProject()?.path ?? null;
  const activeTabId = useLayoutStore.use.activeTabId();
  const tabs = useLayoutStore.use.tabs();
  const { closeTab } = useLayoutStore.use.actions();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [deleteTargets, setDeleteTargets] = useState<
    { path: string; name: string; isDir: boolean }[] | null
  >(null);

  // Active editor tab's file path — used to highlight the matching
  // row in the tree (pill style like the screenshot).
  const activeFilePath = useMemo(() => {
    const t = tabs.find((tab) => tab.id === activeTabId);
    if (!t || t.type !== "editor") return null;
    const fp = (t.data as { filePath?: string }).filePath;
    return typeof fp === "string" ? fp : null;
  }, [tabs, activeTabId]);

  // Ensure the parent dir is expanded when a new-entry ghost is queued,
  // so the user sees the input inside the target folder. Skips for root
  // (which is always rendered).
  useEffect(() => {
    if (pendingNewEntry && rootPath && pendingNewEntry.parentDir !== rootPath) {
      void ensureExpanded(pendingNewEntry.parentDir);
    }
  }, [pendingNewEntry, rootPath, ensureExpanded]);

  // Flatten the tree, then splice in the ghost row for pendingNewEntry
  // at the correct position (immediately after the parent dir row, or
  // at the top of the root list when parentDir === root).
  const flat = useMemo<FlatRow[]>(() => {
    const base = flattenTree(tree).map((n) => ({ node: n }) as FlatRow);
    if (!pendingNewEntry) return base;
    if (rootPath && pendingNewEntry.parentDir === rootPath) {
      return [
        { node: null, ghost: { parentDir: rootPath, isDir: pendingNewEntry.isDir, depth: 0 } },
        ...base,
      ];
    }
    const idx = base.findIndex((r) => r.node?.entry.path === pendingNewEntry.parentDir);
    if (idx === -1) return base;
    const parentDepth = base[idx].node?.depth ?? 0;
    const next: FlatRow[] = [...base];
    next.splice(idx + 1, 0, {
      node: null,
      ghost: {
        parentDir: pendingNewEntry.parentDir,
        isDir: pendingNewEntry.isDir,
        depth: parentDepth + 1,
      },
    });
    return next;
  }, [tree, pendingNewEntry, rootPath]);

  // Git-status overlay for the tree. `git_status` paths are repo-relative;
  // resolve them to absolute against the repo root so they key off the same
  // `entry.path` the tree rows use. Files get their exact status color; a
  // collapsed directory gets a marker when it (transitively) contains a
  // change, so hidden edits are still visible without expanding.
  const gitFiles = useGitStore.use.files();
  const gitRepoPath = useGitStore.use.repoPath();
  const { fileColors, dirtyDirs } = useMemo(() => {
    const fileColors = new Map<string, string>();
    const dirtyDirs = new Set<string>();
    const root = gitRepoPath ?? rootPath;
    if (!root) return { fileColors, dirtyDirs };
    for (const f of gitFiles) {
      const abs = `${root}/${f.path}`;
      fileColors.set(abs, gitStatusColor(f.status));
      // Walk ancestors up to (and excluding) the root so each enclosing
      // folder knows it contains a change.
      let dir = abs.slice(0, abs.lastIndexOf("/"));
      while (dir.length > root.length) {
        if (dirtyDirs.has(dir)) break; // ancestors already recorded
        dirtyDirs.add(dir);
        dir = dir.slice(0, dir.lastIndexOf("/"));
      }
    }
    return { fileColors, dirtyDirs };
  }, [gitFiles, gitRepoPath, rootPath]);

  const virtualizer = useVirtualizer({
    count: flat.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 15,
  });

  // Cold-wake warm-up: re-measure on the window-active rising edge so the first
  // scroll after a long idle doesn't eat WebKit's main-thread throttle catch-up.
  useEffect(() => {
    const onActive = () => virtualizer.measure();
    window.addEventListener("atlas:window-active", onActive);
    return () => window.removeEventListener("atlas:window-active", onActive);
  }, [virtualizer]);

  const handleOpenFile = useCallback((path: string, _name: string) => {
    // Single entry point: classifies by extension and routes text → editor,
    // images/video/audio → media viewer, everything else → unsupported view.
    openFile(path);
  }, []);

  // Click handling with Finder/Zed-style multi-select:
  //   • plain click → single-select + open/expand
  //   • ⌘/Ctrl-click → toggle this row in the selection (no open)
  //   • ⇧-click → range-select from the anchor to here (no open)
  const handleRowClick = useCallback(
    (node: TreeNode, e?: React.MouseEvent) => {
      const path = node.entry.path;
      if (e && (e.metaKey || e.ctrlKey)) {
        toggleSelection(path);
        return;
      }
      if (e && e.shiftKey && selectionAnchor) {
        // Range over the currently-visible (flattened) rows.
        const paths = flat
          .filter((r): r is FlatRow & { node: TreeNode } => r.node != null)
          .map((r) => r.node.entry.path);
        const a = paths.indexOf(selectionAnchor);
        const b = paths.indexOf(path);
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          setSelection(paths.slice(lo, hi + 1), selectionAnchor);
          return;
        }
      }
      // Plain click: collapse selection to this row, then act on it.
      setSelection([path], path);
      if (node.entry.is_dir) {
        void toggleExpand(path);
      } else {
        handleOpenFile(path, node.entry.name);
      }
    },
    [flat, selectionAnchor, toggleSelection, setSelection, toggleExpand, handleOpenFile],
  );

  const handlePickFolder = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true });
      if (selected) {
        useExplorerStore.getState().actions.openFolder(selected as string);
      }
    } catch {
      // user cancelled
    }
  };

  /* ── Action handlers ───────────────────────────────────────── */

  const dirOfPath = (p: string): string => {
    const idx = p.lastIndexOf("/");
    return idx >= 0 ? p.slice(0, idx) : p;
  };
  const basenameOfPath = (p: string): string => {
    const idx = p.lastIndexOf("/");
    return idx >= 0 ? p.slice(idx + 1) : p;
  };

  const handleNewFileCommit = async (parentDir: string, name: string) => {
    const path = `${parentDir}/${name}`;
    try {
      await invoke("fs_create_file", { path });
      await reconcileDirectory(parentDir);
      handleOpenFile(path, name);
    } catch (e) {
      toast.error(String(e));
    } finally {
      endNewEntry();
    }
  };

  const handleNewFolderCommit = async (parentDir: string, name: string) => {
    const path = `${parentDir}/${name}`;
    try {
      await invoke("fs_create_dir", { path });
      await reconcileDirectory(parentDir);
    } catch (e) {
      toast.error(String(e));
    } finally {
      endNewEntry();
    }
  };

  const handleRenameCommit = async (oldPath: string, name: string) => {
    const newPath = `${dirOfPath(oldPath)}/${name}`;
    if (newPath === oldPath) {
      endRename();
      return;
    }
    try {
      await invoke("fs_rename", { from: oldPath, to: newPath });
      await reconcileDirectory(dirOfPath(oldPath));
      // Re-point recent-files entries so the mention picker shows the new name
      // (the file-index search already self-updates via the fs watcher).
      void invoke("recent_files_rename", {
        oldPath,
        newPath,
        workspaceId: activeWorkspaceId(),
      }).catch(() => {});
      // If the renamed file is open in ANY file-backed viewer (editor, media,
      // svg, pdf, unsupported), swap those tabs to the new path — otherwise the
      // viewer keeps loading the old (now-missing) path and 404s. Re-opening
      // also re-classifies, so a changed extension routes to the right viewer.
      const stale = tabs.filter(
        (t) => FILE_TAB_TYPES.has(t.type) && (t.data as { filePath?: string }).filePath === oldPath,
      );
      if (stale.length) {
        for (const t of stale) closeTab(t.id);
        handleOpenFile(newPath, name);
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      endRename();
    }
  };

  const handleDelete = async (entries: FileEntry[]) => {
    try {
      for (const entry of entries) {
        await invoke("fs_delete", { path: entry.path });
        await reconcileDirectory(dirOfPath(entry.path));
        // Close any open file-backed tab pointing at this file.
        for (const t of tabs.filter(
          (t) =>
            FILE_TAB_TYPES.has(t.type) && (t.data as { filePath?: string }).filePath === entry.path,
        )) {
          closeTab(t.id);
        }
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      const deleted = new Set(entries.map((e) => e.path));
      if (clipboard?.paths.some((p) => deleted.has(p))) clearClipboard();
      clearSelection();
      setDeleteTargets(null);
    }
  };

  const handlePaste = async (destDir: string) => {
    if (!clipboard) return;
    try {
      // Each source resolves its own collision suffix inside destDir.
      for (const src of clipboard.paths) {
        const destPath = await resolveCollision(src, destDir);
        if (clipboard.isCut) {
          await invoke("fs_rename", { from: src, to: destPath });
          await reconcileDirectory(dirOfPath(src));
          void invoke("recent_files_rename", {
            oldPath: src,
            newPath: destPath,
            workspaceId: activeWorkspaceId(),
          }).catch(() => {});
        } else {
          await invoke("fs_copy", { from: src, to: destPath });
        }
      }
      if (clipboard.isCut) clearClipboard();
      await reconcileDirectory(destDir);
    } catch (e) {
      toast.error(String(e));
    }
  };

  // Resolve a destination path for `src` inside `destDir`, suffixing
  // " copy" / " copy N" on collision (mirrors paste behavior).
  const resolveCollision = useCallback(async (src: string, destDir: string) => {
    const baseName = basenameOfPath(src);
    let destPath = `${destDir}/${baseName}`;
    let n = 0;
    while (await pathExists(destPath)) {
      n += 1;
      const dot = baseName.lastIndexOf(".");
      if (n === 1) {
        destPath =
          dot > 0
            ? `${destDir}/${baseName.slice(0, dot)} copy${baseName.slice(dot)}`
            : `${destDir}/${baseName} copy`;
      } else {
        destPath =
          dot > 0
            ? `${destDir}/${baseName.slice(0, dot)} copy ${n}${baseName.slice(dot)}`
            : `${destDir}/${baseName} copy ${n}`;
      }
      if (n > 50) break;
    }
    return destPath;
  }, []);

  const handleMove = useCallback(
    async (src: string, destDir: string) => {
      // No-op: dropping onto own parent dir.
      const parent = dirOfPath(src);
      if (parent === destDir) return;
      // No-op: dropping a folder onto itself or a descendant.
      if (destDir === src || destDir.startsWith(src + "/")) {
        toast.error("Can't move a folder into itself");
        return;
      }
      try {
        const destPath = await resolveCollision(src, destDir);
        await invoke("fs_rename", { from: src, to: destPath });
        void invoke("recent_files_rename", { oldPath: src, newPath: destPath }).catch(() => {});
        // Refresh both ends — the source's old parent loses the entry
        // and the destination gains it. The fs-watcher would catch
        // both eventually but the user expects an immediate update.
        await Promise.all([reconcileDirectory(parent), reconcileDirectory(destDir)]);
      } catch (e) {
        toast.error(String(e));
      }
    },
    [resolveCollision, reconcileDirectory],
  );

  // Pointer-based drag-and-drop (Zed/Athas style). Owns the floating
  // filename preview + destination hit-testing; delegates the actual
  // move to `handleMove` and auto-expand to `ensureExpanded`.
  const { dragState, onContainerMouseDown } = useFileTreeDragDrop({
    rootPath,
    onMove: handleMove,
    onAutoExpand: ensureExpanded,
  });

  // Copy files dragged in from Finder/Explorer into the hovered folder.
  const handleExternalDrop = useCallback(
    async (paths: string[], destDir: string) => {
      let copied = 0;
      for (const src of paths) {
        try {
          const destPath = await resolveCollision(src, destDir);
          await invoke("fs_copy", { from: src, to: destPath });
          copied += 1;
        } catch (e) {
          const name = src.slice(src.lastIndexOf("/") + 1);
          toast.error(`Couldn't import ${name}: ${String(e)}`);
        }
      }
      if (copied > 0) await reconcileDirectory(destDir);
    },
    [resolveCollision, reconcileDirectory],
  );

  const { externalDropPath } = useExternalFileDrop({
    rootPath,
    onDropFiles: handleExternalDrop,
  });

  // Unified drop target for highlighting: the internal pointer-drag
  // destination takes precedence, otherwise the external OS-drop one.
  const dropTargetPath = dragState.dragOverPath ?? externalDropPath;

  const handleDuplicate = async (path: string) => {
    try {
      await invoke<string>("fs_duplicate", { path });
      await reconcileDirectory(dirOfPath(path));
    } catch (e) {
      toast.error(String(e));
    }
  };

  const handleRevealInFinder = async (path: string) => {
    try {
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(path);
    } catch (e) {
      toast.error(String(e));
    }
  };

  const handleOpenInDefaultApp = async (path: string) => {
    try {
      const { openPath } = await import("@tauri-apps/plugin-opener");
      await openPath(path);
    } catch (e) {
      toast.error(String(e));
    }
  };

  const handleOpenInTerminal = async (path: string) => {
    try {
      await invoke("fs_open_in_terminal", { path });
    } catch (e) {
      toast.error(String(e));
    }
  };

  const handleCopyPath = (paths: string[]) => {
    void navigator.clipboard.writeText(paths.join("\n")).catch(() => {});
  };
  const handleCopyRelativePath = (paths: string[]) => {
    const rels = paths.map((path) =>
      projectPath && path.startsWith(projectPath) ? path.slice(projectPath.length + 1) : path,
    );
    void navigator.clipboard.writeText(rels.join("\n")).catch(() => {});
  };

  const handleAddToGitignore = async (path: string) => {
    if (!projectPath) return;
    const rel = path.startsWith(projectPath) ? path.slice(projectPath.length + 1) : path;
    try {
      await invoke("fs_add_to_gitignore", { projectPath, pattern: rel });
      toast.success(`Added to .gitignore: ${rel}`);
    } catch (e) {
      toast.error(String(e));
    }
  };

  /* ── Render ────────────────────────────────────────────────── */

  // Resolve the current selection to FileEntry objects (via the visible
  // flattened rows; synthesize a minimal entry for any selected path no
  // longer in view, e.g. after its folder was collapsed).
  const selectionEntries = (): FileEntry[] => {
    const byPath = new Map(
      flat.filter((r) => r.node).map((r) => [r.node!.entry.path, r.node!.entry] as const),
    );
    return selectedPaths.map(
      (p) =>
        byPath.get(p) ?? {
          name: basenameOfPath(p),
          path: p,
          is_dir: false,
          is_symlink: false,
          size: 0,
          extension: null,
        },
    );
  };

  const rowMenuItems = (entry: FileEntry) => {
    const isDir = entry.is_dir;
    // When the right-clicked row is part of a multi-selection, the
    // batchable actions (cut/copy/delete/copy-path) operate on the whole
    // selection; single-row actions (rename/duplicate/new/paste) always
    // act on `entry`.
    const multi = selectedPaths.length > 1 && selectedPaths.includes(entry.path);
    const targets = multi ? selectionEntries() : [entry];
    const targetPaths = targets.map((t) => t.path);
    const countSuffix = multi ? ` (${targets.length})` : "";
    return (
      <>
        {isDir ? (
          <>
            <ContextMenuItem onSelect={() => beginNewEntry(entry.path, false)}>
              New File
              <ContextMenuShortcut>
                <KbdCombo combo="⌘N" />
              </ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => beginNewEntry(entry.path, true)}>
              New Folder
              <ContextMenuShortcut>
                <KbdCombo combo="⌥⌘N" />
              </ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        ) : (
          <>
            <ContextMenuItem onSelect={() => handleOpenFile(entry.path, entry.name)}>
              Open
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem onSelect={() => handleRevealInFinder(entry.path)}>
          Reveal in Finder
          <ContextMenuShortcut>
            <KbdCombo combo="⌥⌘R" />
          </ContextMenuShortcut>
        </ContextMenuItem>
        {!isDir && (
          <ContextMenuItem onSelect={() => handleOpenInDefaultApp(entry.path)}>
            Open in Default App
          </ContextMenuItem>
        )}
        {isDir && (
          <ContextMenuItem onSelect={() => handleOpenInTerminal(entry.path)}>
            Open in Terminal
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => setClipboard(targetPaths, true)}>
          Cut{countSuffix}
          <ContextMenuShortcut>
            <KbdCombo combo="⌘X" />
          </ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => setClipboard(targetPaths, false)}>
          Copy{countSuffix}
          <ContextMenuShortcut>
            <KbdCombo combo="⌘C" />
          </ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void handleDuplicate(entry.path)}>
          Duplicate
          <ContextMenuShortcut>
            <KbdCombo combo="⌘D" />
          </ContextMenuShortcut>
        </ContextMenuItem>
        {isDir && clipboard && (
          <ContextMenuItem onSelect={() => void handlePaste(entry.path)}>
            Paste
            <ContextMenuShortcut>
              <KbdCombo combo="⌘V" />
            </ContextMenuShortcut>
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => handleCopyPath(targetPaths)}>
          Copy Path{countSuffix}
          <ContextMenuShortcut>
            <KbdCombo combo="⌥⌘C" />
          </ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => handleCopyRelativePath(targetPaths)}>
          Copy Relative Path{countSuffix}
          <ContextMenuShortcut>
            <KbdCombo combo="⇧⌥⌘C" />
          </ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void handleAddToGitignore(entry.path)}>
          Add to .gitignore
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => beginRename(entry.path)}>
          Rename
          <ContextMenuShortcut>
            <KbdCombo combo="↵" />
          </ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() =>
            setDeleteTargets(targets.map((t) => ({ path: t.path, name: t.name, isDir: t.is_dir })))
          }
        >
          Delete{countSuffix}
          <ContextMenuShortcut>⌫</ContextMenuShortcut>
        </ContextMenuItem>
      </>
    );
  };

  const emptyAreaMenu = (
    <ContextMenuContent>
      <ContextMenuItem
        disabled={!rootPath}
        onSelect={() => rootPath && beginNewEntry(rootPath, false)}
      >
        New File
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!rootPath}
        onSelect={() => rootPath && beginNewEntry(rootPath, true)}
      >
        New Folder
      </ContextMenuItem>
      {rootPath && clipboard && (
        <ContextMenuItem onSelect={() => void handlePaste(rootPath)}>
          Paste
          <ContextMenuShortcut>
            <KbdCombo combo="⌘V" />
          </ContextMenuShortcut>
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      {rootPath && (
        <ContextMenuItem onSelect={() => handleRevealInFinder(rootPath)}>
          Reveal Project in Finder
        </ContextMenuItem>
      )}
      {rootPath && (
        <ContextMenuItem onSelect={() => handleOpenInTerminal(rootPath)}>
          Open in Terminal
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => collapseAll()}>Collapse All</ContextMenuItem>
    </ContextMenuContent>
  );

  return (
    <div className="h-full flex flex-col">
      {/* Panel header. Height + bottom border match the center tab strip
          (h-[29px] border-b) so the divider reads as one continuous straight
          line across the file tree and the tab bar. No refresh button — the
          file-tree updates live off the filesystem watcher. */}
      <div className="flex items-center justify-between px-3 h-[29px] shrink-0 border-b border-border-default">
        <span className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider truncate flex-1">
          {rootPath ? rootPath.split("/").pop() : "Files"}
        </span>
        <div className="flex items-center gap-0.5">
          <FoldExpandButton tree={tree} onCollapseAll={collapseAll} onExpandAll={expandAllLoaded} />
          <button
            onClick={handlePickFolder}
            className="p-1 rounded hover:bg-bg-hover text-text-tertiary hover:text-text-secondary transition-colors"
            title="Open folder"
          >
            <FolderPlus size={11} />
          </button>
        </div>
      </div>

      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={scrollRef}
            data-tree-root
            className={cn(
              "flex-1 overflow-auto hide-scrollbar px-1.5 pb-2 relative",
              dropTargetPath === ROOT_DROP &&
                "bg-[var(--accent-primary-muted)] ring-1 ring-inset ring-accent/40",
            )}
            onMouseDown={onContainerMouseDown}
            // Esc clears the multi-selection (keydown bubbles up from the
            // focused row). Only swallow it when there's something to clear.
            onKeyDown={(e) => {
              if (e.key === "Escape" && selectedPaths.length > 0) {
                e.preventDefault();
                e.stopPropagation();
                clearSelection();
              }
            }}
          >
            {loading ? (
              <PanelSkeleton rows={10} className="p-2 gap-1.5" />
            ) : flat.length === 0 ? (
              <div className="px-3 py-4 text-[11px] text-text-tertiary text-center">
                Empty folder
              </div>
            ) : (
              <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                {virtualizer.getVirtualItems().map((virtualRow) => {
                  const row = flat[virtualRow.index];

                  // Ghost row for pending new-file/new-folder input.
                  if (row.ghost) {
                    return (
                      <TreeRow
                        key={`ghost-${virtualRow.index}`}
                        depth={row.ghost.depth}
                        isDir={row.ghost.isDir}
                        isExpanded={false}
                        isActive
                        name=""
                        editingMode="new"
                        initialValue=""
                        onCommit={(name) => {
                          if (row.ghost!.isDir) {
                            void handleNewFolderCommit(row.ghost!.parentDir, name);
                          } else {
                            void handleNewFileCommit(row.ghost!.parentDir, name);
                          }
                        }}
                        onCancel={endNewEntry}
                        onClick={() => {}}
                        style={{ transform: `translateY(${virtualRow.start}px)` }}
                      />
                    );
                  }

                  const node = row.node!;
                  const isDir = node.entry.is_dir;
                  // Files show their own status color; a collapsed dir shows a
                  // marker when it contains a change (expanded dirs let their
                  // children carry the signal instead, to avoid double-marking).
                  const gitColor = isDir
                    ? !node.expanded && dirtyDirs.has(node.entry.path)
                      ? "var(--status-warning)"
                      : null
                    : (fileColors.get(node.entry.path) ?? null);
                  const isSelected = selectedPaths.includes(node.entry.path);
                  const isActive = !isDir && node.entry.path === activeFilePath;
                  const isCut =
                    clipboard?.isCut === true && clipboard.paths.includes(node.entry.path);
                  const isRenaming = pendingRenamePath === node.entry.path;

                  return (
                    <ContextMenu key={node.entry.path}>
                      <ContextMenuTrigger asChild>
                        <div
                          // Right-clicking a row that isn't part of the
                          // current multi-selection collapses the
                          // selection to just that row (Finder behavior),
                          // so the menu acts on what the user clicked.
                          onContextMenu={() => {
                            if (!selectedPaths.includes(node.entry.path)) {
                              setSelection([node.entry.path], node.entry.path);
                            }
                          }}
                        >
                          <TreeRow
                            depth={node.depth}
                            isDir={isDir}
                            isExpanded={node.expanded}
                            // Selection fill wins; keep them mutually
                            // exclusive so a row never shows two bgs.
                            isActive={isActive && !isSelected}
                            isSelected={isSelected}
                            name={node.entry.name}
                            title={node.entry.path}
                            editingMode={isRenaming ? "rename" : undefined}
                            initialValue={isRenaming ? node.entry.name : undefined}
                            onCommit={(name) => void handleRenameCommit(node.entry.path, name)}
                            onCancel={endRename}
                            isCut={isCut}
                            dataPath={node.entry.path}
                            isDropTarget={isDir && dropTargetPath === node.entry.path}
                            isDragging={dragState.draggedItem?.path === node.entry.path}
                            gitColor={gitColor}
                            onClick={(e) => handleRowClick(node, e)}
                            onRename={() => beginRename(node.entry.path)}
                            style={{ transform: `translateY(${virtualRow.start}px)` }}
                          />
                        </div>
                      </ContextMenuTrigger>
                      <ContextMenuContent>{rowMenuItems(node.entry)}</ContextMenuContent>
                    </ContextMenu>
                  );
                })}
              </div>
            )}
          </div>
        </ContextMenuTrigger>
        {emptyAreaMenu}
      </ContextMenu>

      {deleteTargets && deleteTargets.length > 0 && (
        <FileTreeConfirmDelete
          open={deleteTargets.length > 0}
          name={deleteTargets[0].name}
          isDir={deleteTargets[0].isDir}
          count={deleteTargets.length}
          onConfirm={() => {
            const ts = deleteTargets;
            if (!ts) return;
            void handleDelete(
              ts.map((t) => ({
                name: t.name,
                path: t.path,
                is_dir: t.isDir,
                is_symlink: false,
                size: 0,
                extension: null,
              })),
            );
          }}
          onOpenChange={(open) => {
            if (!open) setDeleteTargets(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * Header button that toggles between "collapse all" and "expand all"
 * depending on whether anything is currently expanded.
 */
function FoldExpandButton({
  tree,
  onCollapseAll,
  onExpandAll,
}: {
  tree: TreeNode[];
  onCollapseAll: () => void;
  onExpandAll: () => void;
}) {
  const anyExpanded = useMemo(() => hasAnyExpanded(tree), [tree]);
  return (
    <button
      onClick={anyExpanded ? onCollapseAll : onExpandAll}
      className="p-1 rounded hover:bg-bg-hover text-text-tertiary hover:text-text-secondary transition-colors"
      title={anyExpanded ? "Collapse all" : "Expand all"}
    >
      {anyExpanded ? <FoldVertical size={11} /> : <UnfoldVertical size={11} />}
    </button>
  );
}

function hasAnyExpanded(nodes: TreeNode[]): boolean {
  for (const n of nodes) {
    if (n.expanded) return true;
    if (n.children && hasAnyExpanded(n.children)) return true;
  }
  return false;
}

// Cheap exists check via read_directory probe — Tauri doesn't expose
// a dedicated `exists` command and we don't want to add one for the
// paste-collision loop. We try to read the parent's listing and look
// for the basename. Falls back to false on error.
async function pathExists(path: string): Promise<boolean> {
  try {
    const lastSlash = path.lastIndexOf("/");
    const parent = lastSlash > 0 ? path.slice(0, lastSlash) : "/";
    const name = path.slice(lastSlash + 1);
    const entries = await invoke<Array<{ name: string }>>("read_directory", { path: parent });
    return entries.some((e) => e.name === name);
  } catch {
    return false;
  }
}
