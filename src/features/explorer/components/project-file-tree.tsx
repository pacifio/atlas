import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import { openInProject } from "../lib/open-in-project";
import { openAskAgent } from "@/features/ask-agent/lib/ask-agent";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { useIconThemeStore } from "@/features/icon-theme/stores/icon-theme-store";
import { useWorkingTreeChanges } from "@/features/git/lib/use-working-tree-changes";
import {
  addToGitignore,
  openInTerminal,
  readDirectories,
  type DirectoryListing,
} from "../lib/fs-api";
import {
  chainOpen,
  chainOwners,
  nameOf,
  parentOf,
  projectTreeModel,
  type TreeRowData,
} from "../lib/project-tree-model";
import { absoluteOf, ProjectFileOps, relativeTo } from "../lib/project-file-ops";
import { ROW_HEIGHT } from "../lib/tree-constants";
import { useFileTreeDragDrop } from "../hooks/use-file-tree-drag-drop";
import { useExternalFileDrop } from "../hooks/use-external-file-drop";
import { useProjectTreeSearch } from "../hooks/use-project-tree-search";
import { useProjectTreeReveal } from "../hooks/use-project-tree-reveal";
import { NO_SELECTION, projectTreeInput, type Selection } from "../lib/project-tree-input";
import { SYSTEM_EDITOR_ID } from "@/features/external-editor/lib/external-editor-api";
import { openInEditor } from "@/features/external-editor/lib/preferred-editor";
import {
  GHOST_KEY,
  isGhost,
  ProjectFileTreeBody,
  ProjectFileTreeFrame,
  ProjectFileTreeHeader,
  type DisplayRow,
  type GhostRow,
} from "./views/project-file-tree-view";
import { ProjectTreeEmptyMenu, ProjectTreeRowMenu } from "./views/project-tree-menus";

/**
 * The project's files, as a lazily loaded, virtualized tree: the Files
 * surface, and the column beside every file tab.
 *
 * The model (`project-tree-model.ts`) owns what is loaded and what is open
 * and hands back a flat list of rows; this component owns everything the user
 * is doing to it (selection, focus, rename, clipboard, drag) and draws only the
 * rows in view. See `ProjectTreeRow` for why a folder opening re-renders so
 * little.
 */

async function revealInFinder(abs: string) {
  try {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(abs);
  } catch (e) {
    toast.error(String(e));
  }
}
const rowHeight = () => ROW_HEIGHT;

export interface ProjectFileTreeProps {
  /** The project root, absolute. */
  root: string;
  /** Header content before the tree's own buttons (the review view switch). */
  leading?: ReactNode;
  /** Show a changed file's diff; root-relative path. */
  onShowDiff?: (path: string) => void;
  /**
   * The file to highlight and reveal, absolute. A file tab passes its own
   * file; omitted, the tree follows whatever file the reader last looked at.
   */
  activeFile?: string | null;
  /** Changing it reveals `activeFile` again (a file tab coming back into
   *  view, or its file asked for a second time). */
  revealNonce?: number;
  /** After the tree opened a file. */
  onFileOpened?: (path: string) => void;
  /**
   * A folder to reveal and select, root-relative (`""` is the root, which
   * scrolls back to the top). A file's breadcrumbs ask for it when the
   * reader walks up from the file; a new `nonce` asks again.
   */
  revealFolder?: { path: string; nonce: number } | null;
}

export function ProjectFileTree({
  root,
  leading,
  onShowDiff,
  activeFile,
  revealNonce = 0,
  onFileOpened,
  revealFolder = null,
}: ProjectFileTreeProps) {
  const showHidden = useSettingsStore((s) => s.settings.showHiddenFiles);
  const model = useMemo(
    () => projectTreeModel(root, readDirectories, { showHidden }),
    // `showHidden` is pushed in by the effect below; a new model per toggle
    // would throw away what is loaded.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [root],
  );
  const ops = useMemo(() => new ProjectFileOps(model), [model]);
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const { expanded, loading, errors, ready } = snapshot;
  const {
    saved,
    searchRef,
    query,
    setQuery,
    search,
    searchCollapsed,
    setSearchCollapsed,
    setSearchNonce,
    searching,
    searchResult,
    rows,
    clearSearch,
  } = useProjectTreeSearch({ model, root, snapshot, showHidden });

  useEffect(() => model.setShowHidden(showHidden), [model, showHidden]);
  useEffect(() => {
    void model.load([""]);
  }, [model]);

  // Live updates reach the model from `App`'s watcher listener
  // (`refreshProjectTree`), which keeps a cached tree current while it is not
  // on screen too.

  // ── What the user is doing ──────────────────────────────────────────────
  const [selection, setSelection] = useState<Selection>(NO_SELECTION);
  const [focused, setFocused] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newEntry, setNewEntry] = useState<{ parent: string; isDir: boolean } | null>(null);
  const [clipboard, setClipboard] = useState<{ paths: string[]; isCut: boolean } | null>(null);
  const [deleteTargets, setDeleteTargets] = useState<TreeRowData[] | null>(null);
  const [menuTarget, setMenuTarget] = useState<TreeRowData | null>(null);

  // A folder that was a row of its own can fold into a compacted chain once
  // its listing loads (or a refresh leaves it one child). Focus and
  // selection on it follow it to the row now drawing it, or ↓ would start
  // from nowhere and "New file" would land at the root.
  const owners = useMemo(() => chainOwners(rows), [rows]);
  useEffect(() => {
    if (owners.size === 0) return;
    const to = (path: string) => owners.get(path) ?? path;
    setFocused((f) => (f && owners.has(f) ? to(f) : f));
    setSelection((s) => {
      const moved = [...s.paths].some((p) => owners.has(p)) || (!!s.anchor && owners.has(s.anchor));
      if (!moved) return s;
      return { paths: new Set([...s.paths].map(to)), anchor: s.anchor && to(s.anchor) };
    });
  }, [owners]);

  const display = useMemo<readonly DisplayRow[]>(() => {
    if (!newEntry) return rows;
    if (newEntry.parent === "") {
      return [{ kind: "ghost", parent: "", depth: 0, isDir: newEntry.isDir }, ...rows];
    }
    const at = rows.findIndex((r) => r.path === newEntry.parent);
    if (at < 0) return rows;
    const ghost: GhostRow = {
      kind: "ghost",
      parent: newEntry.parent,
      depth: rows[at].depth + 1,
      isDir: newEntry.isDir,
    };
    return [...rows.slice(0, at + 1), ghost, ...rows.slice(at + 1)];
  }, [rows, newEntry]);

  // ── Virtualization ──────────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  // Keyed by path, so the rows below a folder that opens keep their DOM and
  // only move; by index, each would become a different file. Both callbacks
  // must keep their identity between renders: the virtualizer recomputes
  // every row's offset (all 50,000 of them) whenever either changes, which
  // as inline functions would be on every scroll frame.
  const getItemKey = useCallback(
    (index: number) => {
      const row = display[index];
      return isGhost(row) ? GHOST_KEY : row.path;
    },
    [display],
  );
  const virtualizer = useVirtualizer({
    count: display.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: rowHeight,
    getItemKey,
    overscan: 10,
  });

  // A scroll asked for before its row exists (a reveal waits for listings).
  const [scrollTarget, setScrollTarget] = useState<{ path: string; center: boolean } | null>(null);
  useEffect(() => {
    if (!scrollTarget) return;
    // Indexed in `display`, which the new-entry row shifts by one.
    const index = display.findIndex((r) => !isGhost(r) && r.path === scrollTarget.path);
    if (index < 0) return;
    virtualizer.scrollToIndex(index, { align: scrollTarget.center ? "center" : "auto" });
    setScrollTarget(null);
  }, [display, scrollTarget, virtualizer]);

  // A fresh answer starts at the top, with the first hit focused, so Tab
  // or ↓ from the field lands on it.
  const appliedQuery = search?.query ?? null;
  const restoredQuery = useRef(saved?.applied?.query ?? null);
  useEffect(() => {
    if (!appliedQuery) return;
    // A search carried over from another view keeps its place.
    if (appliedQuery === restoredQuery.current) {
      restoredQuery.current = null;
      return;
    }
    virtualizer.scrollToOffset(0);
    if (searchResult?.firstMatch) setFocused(searchResult.firstMatch);
    // Per new query, not per re-ask or re-filter while folders load.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedQuery]);

  const { activeAbs } = useProjectTreeReveal({
    model,
    root,
    activeFile,
    revealNonce,
    revealFolder,
    clearSearch,
    setSelection,
    setFocused,
    setScrollTarget,
    scrollRef,
  });

  // ── Decorations ─────────────────────────────────────────────────────────
  const changes = useWorkingTreeChanges(root);
  const hideArrows = useIconThemeStore.use.hidesExplorerArrows();

  // ── Actions ─────────────────────────────────────────────────────────────
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const selectOnly = useCallback((path: string) => {
    setSelection({ paths: new Set([path]), anchor: path });
    setFocused(path);
  }, []);

  const open = useCallback(
    (abs: string) => {
      model.view.openedFromTree = abs;
      // After the file's tab exists: a caller that closes its own tab on
      // this (the Files surface) must not empty the column first. Neither
      // happens if the project changed while the file was being classified.
      void openInProject(abs, onFileOpened);
    },
    [model, onFileOpened],
  );

  /** A folder row's open state: during a search, open unless closed by hand
   *  in it; otherwise the model's (every link of a compacted chain). */
  const isOpen = useCallback(
    (row: TreeRowData) =>
      row.kind === "directory" &&
      (searching ? !searchCollapsed.has(row.path) : chainOpen(row, expanded)),
    [searching, searchCollapsed, expanded],
  );
  const setOpen = useCallback(
    (row: TreeRowData, open: boolean) => {
      if (!searching) {
        void model.setRowExpanded(row, open);
        return;
      }
      setSearchCollapsed((prev) => {
        const next = new Set(prev);
        if (open) next.delete(row.path);
        else next.add(row.path);
        return next;
      });
    },
    [model, searching],
  );

  /**
   * A link is never followed into the tree (its target may be anywhere, and
   * may loop). Ask the backend what it points at: a folder inside the project
   * is said so, anything outside is shown in Finder, and a file opens.
   */
  const activateLink = useCallback(
    async (row: TreeRowData) => {
      const abs = absoluteOf(root, row.path);
      let listing: DirectoryListing | undefined;
      try {
        [listing] = await readDirectories(root, [row.path]);
      } catch (e) {
        toast.error(String(e));
        return;
      }
      const error = listing?.error ?? null;
      if (listing && !error) {
        toast.info(`${nameOf(row.path)} links to a folder; links are not followed in the tree.`);
      } else if (error?.includes("outside the project root")) {
        void revealInFinder(abs);
      } else {
        open(abs);
      }
    },
    [root, open],
  );

  const activate = useCallback(
    (row: TreeRowData) => {
      if (row.kind === "directory") setOpen(row, !isOpen(row));
      else if (row.kind === "symlink") void activateLink(row);
      else open(absoluteOf(root, row.path));
    },
    [root, open, activateLink, isOpen, setOpen],
  );

  /** The selection as rows, in tree order; the given row when it is not part
   *  of the selection (a right-click outside it acts on what was clicked). */
  const targetsFor = useCallback((row: TreeRowData): TreeRowData[] => {
    const sel = selectionRef.current.paths;
    if (!sel.has(row.path) || sel.size < 2) return [row];
    return rowsRef.current.filter((r) => sel.has(r.path));
  }, []);

  const beginNewEntry = useCallback(
    (parent: string, isDir: boolean) => {
      setRenaming(null);
      // The new entry goes in the real tree, where it will land.
      clearSearch();
      if (parent !== "") void model.expand(parent);
      setNewEntry({ parent, isDir });
    },
    [model, clearSearch],
  );

  const copyText = (text: string) => void navigator.clipboard.writeText(text).catch(() => {});

  // Through the external-editor command's system default: the opener
  // plugin's JS `openPath` is outside Atlas's capabilities, and Rust shows an
  // executable in Finder rather than running it.
  const openInDefaultApp = (abs: string) => openInEditor(SYSTEM_EDITOR_ID, abs);
  const terminalAt = (abs: string) => void openInTerminal(abs).catch((e) => toast.error(String(e)));
  const ignore = (rel: string) =>
    void addToGitignore(root, rel)
      .then(() => toast.success(`Added to .gitignore: ${rel}`))
      .catch((e) => toast.error(String(e)));

  const commitRename = useCallback(
    (path: string, name: string) => {
      setRenaming(null);
      scrollRef.current?.focus({ preventScroll: true });
      void ops.rename(absoluteOf(root, path), name).then((to) => {
        const rel = to ? relativeTo(root, to) : null;
        if (rel) selectOnly(rel);
      });
    },
    [ops, root, selectOnly],
  );
  const cancelRename = useCallback(() => {
    setRenaming(null);
    scrollRef.current?.focus({ preventScroll: true });
  }, []);

  const paste = (destRel: string) => {
    if (!clipboard) return;
    const dest = absoluteOf(root, destRel);
    void ops.paste(clipboard, dest);
    if (clipboard.isCut) setClipboard(null);
  };
  const dirForPaste = (row: TreeRowData | null) =>
    !row ? "" : row.kind === "directory" ? row.path : parentOf(row.path);

  // ── Drag and drop ───────────────────────────────────────────────────────
  const onMove = useCallback((src: string, destDir: string) => void ops.move(src, destDir), [ops]);
  const onAutoExpand = useCallback(
    (abs: string) => {
      const rel = relativeTo(root, abs);
      if (rel) void model.expand(rel);
    },
    [model, root],
  );
  const { dragState, onContainerMouseDown } = useFileTreeDragDrop({
    rootPath: root,
    onMove,
    onAutoExpand,
    scopeRef: scrollRef,
  });
  const onDropFiles = useCallback(
    (paths: string[], destDir: string) => void ops.copyInto(paths, destDir),
    [ops],
  );
  const { externalDropPath } = useExternalFileDrop({
    rootPath: root,
    onDropFiles,
    scopeRef: scrollRef,
  });
  const dropTarget = dragState.dragOverPath ?? externalDropPath;

  // ── Ask the agent ───────────────────────────────────────────────────────
  // A file as itself, by its project-relative path: the agent reads it.
  const askAgent = (files: readonly TreeRowData[], anchor: Element | null) =>
    openAskAgent({ context: files.map((f) => ({ kind: "file", path: f.path })), anchor });
  // From the menu: the box grows from the row it was opened on.
  const rowElement = (row: TreeRowData) =>
    scrollRef.current?.querySelector(`[data-rel-path="${CSS.escape(row.path)}"]`) ?? null;

  const { onClick, onContextMenu, onKeyDown } = projectTreeInput({
    root,
    ops,
    rowsRef,
    scrollRef,
    selection,
    setSelection,
    focused,
    setFocused,
    setMenuTarget,
    setScrollTarget,
    setRenaming,
    setDeleteTargets,
    clipboard,
    setClipboard,
    onShowDiff,
    onAskAgent: (row, anchor) => askAgent([row], anchor),
    selectOnly,
    activate,
    isOpen,
    setOpen,
    targetsFor,
    copyText,
    paste,
    dirForPaste,
  });

  // ── Menus ───────────────────────────────────────────────────────────────
  const rowMenu = (row: TreeRowData) => (
    <ProjectTreeRowMenu
      row={row}
      root={root}
      changes={changes}
      clipboard={clipboard}
      onShowDiff={onShowDiff}
      askAgent={(files) => askAgent(files, rowElement(row))}
      targetsFor={targetsFor}
      beginNewEntry={beginNewEntry}
      open={open}
      revealInFinder={revealInFinder}
      terminalAt={terminalAt}
      openInDefaultApp={openInDefaultApp}
      setClipboard={setClipboard}
      duplicate={(abs) => ops.duplicate(abs)}
      paste={paste}
      dirForPaste={dirForPaste}
      copyText={copyText}
      ignore={ignore}
      setRenaming={setRenaming}
      setDeleteTargets={setDeleteTargets}
    />
  );

  const emptyMenu = (
    <ProjectTreeEmptyMenu
      root={root}
      clipboard={clipboard}
      beginNewEntry={beginNewEntry}
      paste={paste}
      revealInFinder={revealInFinder}
      terminalAt={terminalAt}
      collapseAll={() => model.collapseAll()}
    />
  );

  // ── Header ──────────────────────────────────────────────────────────────
  const expandAbort = useRef<AbortController | null>(null);
  useEffect(() => () => expandAbort.current?.abort(), []);
  const anyExpanded = expanded.size > 0;
  const toggleAll = () => {
    expandAbort.current?.abort();
    clearSearch();
    if (anyExpanded) {
      model.collapseAll();
      return;
    }
    const controller = new AbortController();
    expandAbort.current = controller;
    void model.expandAll(controller.signal);
  };

  const refresh = () => {
    void model.refresh();
    // The index has its own watcher; asking again picks up what it saw.
    if (searching) setSearchNonce((n) => n + 1);
  };

  const header = (
    <ProjectFileTreeHeader
      root={root}
      leading={leading}
      searchRef={searchRef}
      query={query}
      onQueryChange={setQuery}
      onClearSearch={clearSearch}
      canEnterResults={rows.length > 0}
      onEnterResults={() => {
        const first = searchResult?.firstMatch ?? rows[0].path;
        setFocused(first);
        setSelection({ paths: new Set([first]), anchor: first });
        scrollRef.current?.focus({ preventScroll: true });
      }}
      onRefresh={refresh}
      anyExpanded={anyExpanded}
      onToggleAll={toggleAll}
    />
  );

  // ── Body ────────────────────────────────────────────────────────────────
  const body = (
    <ProjectFileTreeBody
      root={root}
      ready={ready}
      rootError={errors.get("")}
      onRetry={() => void model.refresh()}
      noMatches={!!searchResult && searchResult.matchCount === 0}
      display={display}
      virtualizer={virtualizer}
      isOpen={isOpen}
      loading={loading}
      errors={errors}
      selectedPaths={selection.paths}
      focused={focused}
      activeAbs={activeAbs}
      clipboard={clipboard}
      dropTarget={dropTarget}
      draggedPath={dragState.draggedItem?.path}
      changes={changes}
      onShowDiff={onShowDiff}
      hideArrows={hideArrows}
      renaming={renaming}
      onRenameCommit={commitRename}
      onRenameCancel={cancelRename}
      onGhostCommit={(row: GhostRow, name) => {
        setNewEntry(null);
        scrollRef.current?.focus({ preventScroll: true });
        const parent = absoluteOf(root, row.parent);
        void (row.isDir ? ops.createFolder(parent, name) : ops.createFile(parent, name));
      }}
      onGhostCancel={() => {
        setNewEntry(null);
        scrollRef.current?.focus({ preventScroll: true });
      }}
    />
  );

  return (
    <ProjectFileTreeFrame
      root={root}
      header={header}
      truncated={searchResult?.truncated}
      scrollRef={scrollRef}
      focused={focused}
      dropTarget={dropTarget}
      onContainerMouseDown={onContainerMouseDown}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
      body={body}
      menu={menuTarget ? rowMenu(menuTarget) : emptyMenu}
      deleteTargets={deleteTargets}
      onConfirmDelete={() => {
        if (!deleteTargets) return;
        const targets = deleteTargets.map((t) => absoluteOf(root, t.path));
        setDeleteTargets(null);
        setSelection(NO_SELECTION);
        setClipboard((c) => (c && c.paths.some((p) => targets.includes(p)) ? null : c));
        void ops.delete(targets);
      }}
      onDismissDelete={() => setDeleteTargets(null)}
    />
  );
}
