import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import { ChevronsDownUp, ChevronsUpDown, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { openInProject } from "../lib/open-in-project";
import { IconButton } from "@/ui/icon-button";
import { Hint } from "@/ui/tooltip";
import { KbdCombo } from "@/ui/kbd";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/ui/context-menu";
import { PanelSkeleton } from "@/components/panel-skeleton";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
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
import {
  buildSearchRows,
  collectMatches,
  literalIndexQuery,
  normalizeTreeQuery,
  SEARCH_DEBOUNCE_MS,
  SEARCH_INDEX_LIMIT,
  type TreeSearchState,
} from "../lib/tree-search";
import { searchProjectFiles } from "@/features/file-picker/lib/file-picker-api";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { absoluteOf, ProjectFileOps, relativeTo } from "../lib/project-file-ops";
import { INDENT_PER_LEVEL, ROW_HEIGHT } from "../lib/tree-constants";
import { ROOT_DROP, useFileTreeDragDrop } from "../hooks/use-file-tree-drag-drop";
import { useExternalFileDrop } from "../hooks/use-external-file-drop";
import { ProjectTreeRow, RenameInput } from "./project-tree-row";
import { FileTreeConfirmDelete } from "./file-tree-confirm-delete";
import { OpenInEditorContextItems } from "@/features/external-editor/components/open-in-editor-menu";
import { SYSTEM_EDITOR_ID } from "@/features/external-editor/lib/external-editor-api";
import { openInEditor } from "@/features/external-editor/lib/preferred-editor";
import { isFileTab } from "../lib/file-tabs";

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

interface GhostRow {
  kind: "ghost";
  /** The folder the new entry goes in (root-relative). */
  parent: string;
  depth: number;
  isDir: boolean;
}

type DisplayRow = TreeRowData | GhostRow;

const isGhost = (row: DisplayRow): row is GhostRow => row.kind === "ghost";

async function revealInFinder(abs: string) {
  try {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(abs);
  } catch (e) {
    toast.error(String(e));
  }
}
const rowHeight = () => ROW_HEIGHT;
const GHOST_KEY = "\0new-entry";

interface Selection {
  paths: ReadonlySet<string>;
  anchor: string | null;
}
const NO_SELECTION: Selection = { paths: new Set(), anchor: null };

/** Tab types whose `data.filePath` is a file the tree can point at. */

/**
 * The file the reader is looking at: the active tab of the focused column, or
 * of any column, or failing both the most recent file tab. The last matters
 * because a file opened from this tree opens in the tree's own column (editors
 * are surfaces, ADR-0024), so coming back to the tree means that file's tab
 * is no longer the active one, and the highlight must not vanish with it.
 */
function useActiveFilePath(): string | null {
  return useLayoutStore((s) => {
    const fileOf = (id: string | null | undefined) => {
      const tab = id ? s.tabs.find((t) => t.id === id) : undefined;
      return tab && isFileTab(tab.type) && typeof tab.data.filePath === "string"
        ? tab.data.filePath
        : null;
    };
    const groups = [s.focusedGroupId, ...s.groupOrder.filter((g) => g !== s.focusedGroupId)];
    for (const group of groups) {
      const path = fileOf(s.activeByGroup[group]);
      if (path) return path;
    }
    for (let i = s.tabHistory.length - 1; i >= 0; i--) {
      const path = fileOf(s.tabHistory[i]);
      if (path) return path;
    }
    return null;
  });
}

const domIdOf = (rel: string) =>
  `ptree-${rel.replace(/[^A-Za-z0-9_-]/g, (c) => `_${c.charCodeAt(0)}`)}`;

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

  // ── Search ──────────────────────────────────────────────────────────────
  // The field updates on every keystroke; nothing else does. After a pause
  // the project's file index is asked, and the tree is filtered from its
  // answer plus the listings already loaded (`tree-search.ts`). Until then
  // the tree shows what it showed before, so typing never waits on a filter.
  //
  // The search belongs to the project root, not to this view: it is kept on
  // the root's model, so picking a hit on the Files surface (which hands off
  // to the file's tab) carries the search into that tab's tree.
  const workspaceId = useProjectStore((s) => s.projects.find((p) => p.path === root)?.id ?? null);
  const searchRef = useRef<HTMLInputElement>(null);
  const saved = model.view.search;
  const [query, setQuery] = useState(saved?.query ?? "");
  const [search, setSearch] = useState<TreeSearchState["applied"]>(saved?.applied ?? null);
  /** Folders closed by hand during this search; every other one is open. */
  const [searchCollapsed, setSearchCollapsed] = useState<ReadonlySet<string>>(
    () => saved?.collapsed ?? new Set(),
  );
  useEffect(() => {
    model.view.search = query ? { query, applied: search, collapsed: searchCollapsed } : null;
  }, [model, query, search, searchCollapsed]);
  const searchSeq = useRef(0);
  /** The query of the answer on screen. */
  const appliedRef = useRef(saved?.applied?.query ?? null);
  /** Bumped to ask the index again for the same query (refresh, disk change). */
  const [searchNonce, setSearchNonce] = useState(0);
  useEffect(() => {
    const q = normalizeTreeQuery(query);
    if (!q) {
      searchSeq.current++;
      appliedRef.current = null;
      setSearch(null);
      return;
    }
    const seq = ++searchSeq.current;
    const timer = setTimeout(() => {
      const answer = workspaceId
        ? searchProjectFiles(workspaceId, root, literalIndexQuery(q), SEARCH_INDEX_LIMIT).then(
            (hits) => hits.map((h) => h.rel),
            () => [] as string[],
          )
        : Promise.resolve([] as string[]);
      void answer.then((indexHits) => {
        if (seq !== searchSeq.current) return;
        // A new query starts with every folder open; the same one asked
        // again keeps what the user closed.
        if (appliedRef.current !== q) setSearchCollapsed(new Set());
        appliedRef.current = q;
        setSearch({ query: q, indexHits });
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, root, workspaceId, searchNonce]);
  const searching = search !== null;
  // The listings changed under a search (a file added, deleted, renamed):
  // ask the index again once things settle. Stale hits are already dropped
  // by `collectMatches`; this is what brings new ones in.
  const listingsChanged = useRef(snapshot);
  useEffect(() => {
    if (listingsChanged.current === snapshot) return;
    listingsChanged.current = snapshot;
    if (!searching) return;
    const timer = setTimeout(() => setSearchNonce((n) => n + 1), 300);
    return () => clearTimeout(timer);
  }, [snapshot, searching]);
  const searchResult = useMemo(
    () =>
      search
        ? buildSearchRows(
            collectMatches(model.listingMap(), search.indexHits, search.query, showHidden),
            searchCollapsed,
          )
        : null,
    // `snapshot` stands for the listings: a folder that loads or changes
    // during a search is searched too.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [model, search, searchCollapsed, showHidden, snapshot],
  );
  const rows = searchResult ? searchResult.rows : snapshot.rows;
  const clearSearch = useCallback(() => {
    setQuery("");
    searchSeq.current++;
    setSearch(null);
    setSearchCollapsed(new Set());
  }, []);

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

  // ── Reveal the active file ──────────────────────────────────────────────
  const lastViewed = useActiveFilePath();
  const activeAbs = activeFile !== undefined ? activeFile : lastViewed;
  const activeRel = activeAbs ? relativeTo(root, activeAbs) : null;
  // A file opened from the tree is already in view: revealing it must not
  // end the search it was picked from. Anything else that points the tree
  // at a file (another tab, ⌘P, an agent) does.
  // Kept on the model: the tree that reveals it is often a different view
  // (the file's tab) from the one that opened it (the Files surface).
  useEffect(() => {
    if (!activeRel) return;
    if (activeAbs !== model.view.openedFromTree) clearSearch();
    let cancelled = false;
    void model.reveal(activeRel).then((index) => {
      if (cancelled || index < 0) return;
      setFocused(activeRel);
      setScrollTarget({ path: activeRel, center: false });
    });
    return () => {
      cancelled = true;
    };
    // `activeAbs` moves with `activeRel`; `clearSearch` is stable.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [model, activeRel, revealNonce]);

  // A folder the breadcrumbs walked up to: open the way to it, select it and
  // bring it to the middle. The root has no row; it scrolls to the top.
  const folderPath = revealFolder?.path ?? null;
  const folderNonce = revealFolder?.nonce ?? 0;
  useEffect(() => {
    if (folderPath === null) return;
    clearSearch();
    if (folderPath === "") {
      setSelection(NO_SELECTION);
      setFocused(null);
      scrollRef.current?.scrollTo({ top: 0 });
      return;
    }
    let cancelled = false;
    void model.reveal(folderPath).then((index) => {
      if (cancelled || index < 0) return;
      setSelection({ paths: new Set([folderPath]), anchor: folderPath });
      setFocused(folderPath);
      setScrollTarget({ path: folderPath, center: true });
    });
    return () => {
      cancelled = true;
    };
    // Per request: `clearSearch` is stable.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [model, folderPath, folderNonce]);

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

  // ── Pointer ─────────────────────────────────────────────────────────────
  const rowAt = (target: EventTarget | null): TreeRowData | null => {
    const el = (target as HTMLElement | null)?.closest?.<HTMLElement>("[data-rel-path]");
    const rel = el?.dataset.relPath;
    if (rel === undefined) return null;
    return rowsRef.current.find((r) => r.path === rel) ?? null;
  };

  const onClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("input")) return;
    const row = rowAt(target);
    if (!row) return;
    if (target.closest("[data-tree-action='diff']")) {
      onShowDiff?.(row.path);
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      setSelection((s) => {
        const paths = new Set(s.paths);
        if (paths.has(row.path)) paths.delete(row.path);
        else paths.add(row.path);
        return { paths, anchor: row.path };
      });
      setFocused(row.path);
      return;
    }
    if (e.shiftKey && selection.anchor) {
      selectRange(selection.anchor, row.path);
      setFocused(row.path);
      return;
    }
    selectOnly(row.path);
    activate(row);
  };

  const selectRange = (from: string, to: string) => {
    const all = rowsRef.current;
    const a = all.findIndex((r) => r.path === from);
    const b = all.findIndex((r) => r.path === to);
    if (a < 0 || b < 0) return;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    setSelection({ paths: new Set(all.slice(lo, hi + 1).map((r) => r.path)), anchor: from });
  };

  const onContextMenu = (e: MouseEvent) => {
    const row = rowAt(e.target);
    setMenuTarget(row);
    if (row && !selection.paths.has(row.path)) selectOnly(row.path);
  };

  // ── Keyboard ────────────────────────────────────────────────────────────
  const moveFocus = (index: number, extend: boolean) => {
    const all = rowsRef.current;
    if (all.length === 0) return;
    const next = all[Math.max(0, Math.min(all.length - 1, index))];
    if (extend) selectRange(selection.anchor ?? focused ?? next.path, next.path);
    else setSelection({ paths: new Set([next.path]), anchor: next.path });
    setFocused(next.path);
    // The virtualizer counts `display` rows, which a new-entry row shifts.
    setScrollTarget({ path: next.path, center: false });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input")) return;
    const all = rowsRef.current;
    const index = focused ? all.findIndex((r) => r.path === focused) : -1;
    const row = index >= 0 ? all[index] : null;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 0) / ROW_HEIGHT) - 1);
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };

    switch (e.key) {
      case "ArrowDown":
        handled();
        return moveFocus(index + 1, e.shiftKey);
      case "ArrowUp":
        handled();
        return moveFocus(index < 0 ? 0 : index - 1, e.shiftKey);
      case "PageDown":
        handled();
        return moveFocus(index + page, e.shiftKey);
      case "PageUp":
        handled();
        return moveFocus(index - page, e.shiftKey);
      case "Home":
        handled();
        return moveFocus(0, e.shiftKey);
      case "End":
        handled();
        return moveFocus(all.length - 1, e.shiftKey);
      case "ArrowRight":
        if (!row || row.kind !== "directory") return;
        handled();
        if (!isOpen(row)) setOpen(row, true);
        else if (all[index + 1]?.depth === row.depth + 1) moveFocus(index + 1, false);
        return;
      case "ArrowLeft": {
        if (!row) return;
        handled();
        if (isOpen(row)) return setOpen(row, false);
        // A compacted row's parent is the one above its outermost folder.
        const parent = parentOf(row.chain?.[0] ?? row.path);
        if (parent)
          moveFocus(
            all.findIndex((r) => r.path === parent),
            false,
          );
        return;
      }
      case "Enter":
      case "F2":
        // Enter renames, as in Finder and the explorer; Space opens.
        if (!row || mod) return;
        handled();
        return setRenaming(row.path);
      case " ":
        if (!row) return;
        handled();
        return activate(row);
      case "Escape":
        if (selection.paths.size === 0) return;
        handled();
        return setSelection(NO_SELECTION);
      case "Delete":
      case "Backspace":
        if (!row || (e.key === "Backspace" && !mod)) return;
        handled();
        return setDeleteTargets(targetsFor(row));
    }
    if (!mod) return;
    if (key === "c" && e.altKey && row) {
      handled();
      const targets = targetsFor(row).map((r) => (e.shiftKey ? r.path : absoluteOf(root, r.path)));
      return copyText(targets.join("\n"));
    }
    if (e.altKey || e.shiftKey) return;
    if ((key === "c" || key === "x") && row) {
      handled();
      return setClipboard({
        paths: targetsFor(row).map((r) => absoluteOf(root, r.path)),
        isCut: key === "x",
      });
    }
    if (key === "v" && clipboard) {
      handled();
      return paste(dirForPaste(row));
    }
    if (key === "d" && row) {
      handled();
      return void ops.duplicate(absoluteOf(root, row.path));
    }
  };

  // ── Menus ───────────────────────────────────────────────────────────────
  const rowMenu = (row: TreeRowData) => {
    const abs = absoluteOf(root, row.path);
    const isDir = row.kind === "directory";
    const targets = targetsFor(row);
    const count = targets.length > 1 ? ` (${targets.length})` : "";
    // A compacted row is its innermost folder; say which, since the row
    // shows several names.
    const which = row.chain && targets.length === 1 ? ` ${row.name}` : "";
    const changed = !isDir && changes.files.has(abs);
    return (
      <>
        {isDir ? (
          <>
            <ContextMenuItem onClick={() => beginNewEntry(row.path, false)}>
              New File
            </ContextMenuItem>
            <ContextMenuItem onClick={() => beginNewEntry(row.path, true)}>
              New Folder
            </ContextMenuItem>
          </>
        ) : (
          <>
            <ContextMenuItem onClick={() => open(abs)}>Open</ContextMenuItem>
            {changed && onShowDiff && (
              <ContextMenuItem onClick={() => onShowDiff(row.path)}>Open Changes</ContextMenuItem>
            )}
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => void revealInFinder(abs)}>Reveal in Finder</ContextMenuItem>
        {isDir ? (
          <ContextMenuItem onClick={() => terminalAt(abs)}>Open in Terminal</ContextMenuItem>
        ) : (
          <ContextMenuItem onClick={() => void openInDefaultApp(abs)}>
            Open in Default App
          </ContextMenuItem>
        )}
        <OpenInEditorContextItems path={abs} />
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={() =>
            setClipboard({ paths: targets.map((t) => absoluteOf(root, t.path)), isCut: true })
          }
        >
          Cut{count}
          <ContextMenuShortcut>
            <KbdCombo combo="⌘X" />
          </ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() =>
            setClipboard({ paths: targets.map((t) => absoluteOf(root, t.path)), isCut: false })
          }
        >
          Copy{count}
          <ContextMenuShortcut>
            <KbdCombo combo="⌘C" />
          </ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void ops.duplicate(abs)}>
          Duplicate
          <ContextMenuShortcut>
            <KbdCombo combo="⌘D" />
          </ContextMenuShortcut>
        </ContextMenuItem>
        {clipboard && (
          <ContextMenuItem onClick={() => paste(dirForPaste(row))}>
            Paste
            <ContextMenuShortcut>
              <KbdCombo combo="⌘V" />
            </ContextMenuShortcut>
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={() => copyText(targets.map((t) => absoluteOf(root, t.path)).join("\n"))}
        >
          Copy Path{count}
          <ContextMenuShortcut>
            <KbdCombo combo="⌥⌘C" />
          </ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onClick={() => copyText(targets.map((t) => t.path).join("\n"))}>
          Copy Relative Path{count}
          <ContextMenuShortcut>
            <KbdCombo combo="⇧⌥⌘C" />
          </ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        {!row.ignored && (
          <ContextMenuItem onClick={() => ignore(row.path)}>Add to .gitignore</ContextMenuItem>
        )}
        <ContextMenuItem onClick={() => setRenaming(row.path)}>
          Rename{which}
          <ContextMenuShortcut>
            <KbdCombo combo="↵" />
          </ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onClick={() => setDeleteTargets(targets)}>
          Delete{which}
          {count}
          <ContextMenuShortcut>
            <KbdCombo combo="⌘⌫" />
          </ContextMenuShortcut>
        </ContextMenuItem>
      </>
    );
  };

  const emptyMenu = (
    <>
      <ContextMenuItem onClick={() => beginNewEntry("", false)}>New File</ContextMenuItem>
      <ContextMenuItem onClick={() => beginNewEntry("", true)}>New Folder</ContextMenuItem>
      {clipboard && <ContextMenuItem onClick={() => paste("")}>Paste</ContextMenuItem>}
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => void revealInFinder(root)}>
        Reveal Project in Finder
      </ContextMenuItem>
      <ContextMenuItem onClick={() => terminalAt(root)}>Open in Terminal</ContextMenuItem>
      <OpenInEditorContextItems path={root} />
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => model.collapseAll()}>Collapse All</ContextMenuItem>
    </>
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

  // One quiet row, as in the file view's header band: refresh, the search
  // field filling the width, then collapse/expand all. New files and folders
  // are on the tree's context menu (a row's, or the empty space below).
  const header = (
    <div className="flex h-control-lg shrink-0 items-center gap-1 px-2">
      {leading}
      <Hint label="Refresh">
        <IconButton size="sm" icon={RefreshCw} label="Refresh files" onClick={refresh} />
      </Hint>
      <div className="flex h-control-md min-w-0 flex-1 items-center rounded-md px-1.5 transition-colors duration-fast hover:bg-element-hover focus-within:bg-element-hover">
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              clearSearch();
              e.currentTarget.blur();
            } else if (e.key === "ArrowDown" && rows.length > 0) {
              // Into the results, at the first hit (or the first row).
              e.preventDefault();
              const first = searchResult?.firstMatch ?? rows[0].path;
              setFocused(first);
              setSelection({ paths: new Set([first]), anchor: first });
              scrollRef.current?.focus({ preventScroll: true });
            }
          }}
          placeholder="Search files"
          aria-label={`Search ${nameOf(root)} files`}
          spellCheck={false}
          autoComplete="off"
          maxLength={256}
          className="min-w-0 flex-1 bg-transparent font-sans text-md text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>
      <Hint label={anyExpanded ? "Collapse all folders" : "Expand all folders"}>
        <IconButton
          size="sm"
          icon={anyExpanded ? ChevronsDownUp : ChevronsUpDown}
          label={anyExpanded ? "Collapse all folders" : "Expand all folders"}
          onClick={toggleAll}
        />
      </Hint>
    </div>
  );

  // ── Body ────────────────────────────────────────────────────────────────
  const rootError = errors.get("");
  let body: ReactNode;
  if (!ready && rootError) {
    body = (
      <button
        type="button"
        onClick={() => void model.refresh()}
        className="p-4 text-left text-xs text-error"
      >
        {rootError} Click to retry.
      </button>
    );
  } else if (!ready) {
    body = <PanelSkeleton rows={10} className="gap-1.5 p-2" />;
  } else if (searchResult && searchResult.matchCount === 0) {
    body = (
      <div role="status" className="px-3 py-4 text-xs text-muted-foreground">
        No matching files.
      </div>
    );
  } else if (display.length === 0) {
    body = <div className="px-3 py-4 text-center text-xs text-muted-foreground">Empty folder</div>;
  } else {
    body = (
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = display[item.index];
          if (isGhost(row)) {
            return (
              <div
                key={GHOST_KEY}
                className="absolute top-0 right-1 left-1 flex items-center gap-1.5 rounded-md bg-card"
                style={{
                  height: ROW_HEIGHT,
                  transform: `translateY(${item.start}px)`,
                  paddingLeft: 2 + row.depth * INDENT_PER_LEVEL + 12 + 6,
                  paddingRight: 6,
                }}
              >
                <RenameInput
                  initial=""
                  onCommit={(name) => {
                    setNewEntry(null);
                    scrollRef.current?.focus({ preventScroll: true });
                    const parent = absoluteOf(root, row.parent);
                    void (row.isDir
                      ? ops.createFolder(parent, name)
                      : ops.createFile(parent, name));
                  }}
                  onCancel={() => {
                    setNewEntry(null);
                    scrollRef.current?.focus({ preventScroll: true });
                  }}
                />
              </div>
            );
          }
          const abs = absoluteOf(root, row.path);
          const isDir = row.kind === "directory";
          const rowOpen = isOpen(row);
          const change = isDir ? undefined : changes.files.get(abs);
          // A folder keeps its dot open or closed: it says "something below
          // here changed" either way.
          const gitColor = isDir ? (changes.dirs.get(abs)?.color ?? null) : (change?.color ?? null);
          return (
            <ProjectTreeRow
              key={row.path}
              row={row}
              absPath={abs}
              domId={domIdOf(row.path)}
              start={item.start}
              expanded={rowOpen}
              loading={rowOpen && loading.has(row.path)}
              error={errors.get(row.path) ?? null}
              selected={selection.paths.has(row.path)}
              focused={focused === row.path}
              active={abs === activeAbs}
              cut={clipboard?.isCut === true && clipboard.paths.includes(abs)}
              dropTarget={isDir && dropTarget === abs}
              dropSegment={
                row.chain && dropTarget && row.chain.some((l) => absoluteOf(root, l) === dropTarget)
                  ? dropTarget
                  : null
              }
              dragging={dragState.draggedItem?.path === abs}
              gitColor={gitColor}
              additions={change?.stat.additions ?? null}
              deletions={change?.stat.deletions ?? null}
              changed={!!change && !!onShowDiff && change.stat.status !== "deleted"}
              hideArrows={hideArrows}
              renaming={renaming === row.path}
              onRenameCommit={commitRename}
              onRenameCancel={cancelRename}
            />
          );
        })}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--atlas-editor-background)]">
      {header}
      {searchResult?.truncated && (
        <div className="shrink-0 px-3 py-1 text-xs text-muted-foreground">
          More matches available. Refine your search.
        </div>
      )}
      <ContextMenu>
        <ContextMenuTrigger render={<div className="flex min-h-0 flex-1 flex-col" />}>
          <div
            ref={scrollRef}
            role="tree"
            aria-label={`${nameOf(root)} files`}
            aria-multiselectable
            aria-activedescendant={focused ? domIdOf(focused) : undefined}
            tabIndex={0}
            data-tree-root
            className={cn(
              "group/tree relative min-h-0 flex-1 overflow-auto py-1 outline-none",
              dropTarget === ROOT_DROP &&
                "bg-[var(--atlas-primary-muted)] ring-1 ring-primary/40 ring-inset",
            )}
            onMouseDown={onContainerMouseDown}
            onClick={onClick}
            onContextMenu={onContextMenu}
            onKeyDown={onKeyDown}
          >
            {body}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>{menuTarget ? rowMenu(menuTarget) : emptyMenu}</ContextMenuContent>
      </ContextMenu>

      {deleteTargets && deleteTargets.length > 0 && (
        <FileTreeConfirmDelete
          open
          name={deleteTargets[0].name}
          isDir={deleteTargets[0].kind === "directory"}
          count={deleteTargets.length}
          onConfirm={() => {
            const targets = deleteTargets.map((t) => absoluteOf(root, t.path));
            setDeleteTargets(null);
            setSelection(NO_SELECTION);
            setClipboard((c) => (c && c.paths.some((p) => targets.includes(p)) ? null : c));
            void ops.delete(targets);
          }}
          onOpenChange={(open) => {
            if (!open) setDeleteTargets(null);
          }}
        />
      )}
    </div>
  );
}
