import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import type {
  CodeViewDiffItem,
  CodeViewItem,
  DiffLineAnnotation,
  FileDiffContentsLoader,
  FileDiffMetadata,
  LineAnnotation,
} from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  FolderTree,
  Info,
  Pilcrow,
  RefreshCw,
  Rows3,
  Settings2,
  WrapText,
} from "lucide-react";
import { IconButton } from "@/ui/icon-button";
import { Segmented } from "@/ui/segmented";
import { Hint } from "@/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { ContextMenu, ContextMenuTrigger } from "@/ui/context-menu";
import { useScopedHotkeys } from "@/features/keybindings/lib/use-scoped-hotkeys";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { useWordWrap } from "@/features/settings/lib/use-word-wrap";
import { cn } from "@/lib/utils";
import type { DiffFileStat } from "../../lib/git-review-api";
import { buildFileDiffContentVersion, fnv1a32 } from "../../lib/diff-rendering";
import { useDiffJump } from "../../lib/diff-jump";
import { formatCompactCount } from "../../lib/format-compact-count";
import type { ReviewFile } from "../../lib/use-review-files";
import {
  isFolded,
  NO_FOLDS,
  useDiffPanelStore,
  type DiffLayout,
} from "../../stores/diff-panel-store";
import { CopyPathButton } from "./copy-path-button";
import { DiffFileContextMenuContent } from "./diff-file-context-menu";
import { DiffFileTree, type TreeGroup } from "./diff-file-tree";
import { DiffFindBar, type DiffFindHandle } from "./diff-find-bar";
import { DiffPanelSkeleton } from "./diff-panel-skeleton";
import { FileViewedContext, FileViewedToggle, type FileViewedState } from "./file-viewed-toggle";
import { StyledCodeView, type StyledCodeViewOptions } from "./styled-code-view";

/**
 * The diff panel's view: a header of how to show the diff, and every file of
 * it stacked in one virtualized viewer beside a tree of the files. What it
 * shows comes in as a {@link DiffViewSource}: the working tree, a branch or a
 * session's turn (`diff-panel.tsx`), or a pull request
 * (`pull-request-code-tab.tsx`). Only a source that brings them turns on the
 * Viewed boxes, line annotations and a paging footer; the rest is the same
 * viewer for both.
 */

/** A file's "Viewed" box, backed by whoever keeps the marks. */
export interface DiffViewedSource {
  isViewed: (path: string) => boolean;
  /** Was viewed, and the file has changed since. */
  isStale: (path: string) => boolean;
  setViewed: (path: string, viewed: boolean) => void;
}

export type DiffAnnotation = DiffLineAnnotation<unknown>;

/** Things drawn under lines (review threads, a comment being written), and the
 *  viewer options that let a reader start one from the gutter. */
export interface DiffAnnotationSource {
  /** One file's annotations and a version that changes when what they show
   *  does; `null` for none. Called per file on every items build, so cheap. */
  of: (file: ReviewFile) => { annotations: DiffAnnotation[]; version: string } | null;
  render: (
    annotation: LineAnnotation<unknown> | DiffLineAnnotation<unknown>,
    item: CodeViewItem<unknown>,
  ) => ReactNode;
  options?: Partial<StyledCodeViewOptions<unknown>>;
  selectedLines?: { id: string; range: import("@pierre/diffs").SelectedLineRange } | null;
  onSelectedLinesChange?: (
    selection: { id: string; range: import("@pierre/diffs").SelectedLineRange } | null,
  ) => void;
}

export interface DiffViewSource {
  /** What is on show. Folds are kept per key, and the viewer remounts (fresh
   *  scroll, fresh tokens) only when it changes. */
  key: string;
  files: readonly ReviewFile[];
  /** The tree's rows and per-root groups; each file's stat by default. */
  tree?: { files: readonly DiffFileStat[]; groups?: TreeGroup[] };
  requestFile?: (path: string) => void;
  retry?: (path: string) => void;
  /** Both sides of a file, so the unchanged lines around a hunk can expand. */
  loadDiffFiles?: FileDiffContentsLoader;
  /** The header's left end: what is shown (scope, turn, commit). */
  picker: ReactNode;
  /** After the picker and the viewed count: refs compared, warnings. */
  info?: ReactNode;
  refresh?: { run: () => void; busy: boolean } | null;
  /** Instead of the viewer: an empty, loading or failed state. */
  placeholder?: ReactNode;
  /** What "Copy path" copies for a file, when not its path. */
  copyPathOf?: (path: string) => string | undefined;
  /** A file's absolute path on disk, for its header's right-click menu
   *  (Reveal in Finder, Open in an editor, Copy Path). Left out, the files
   *  are not on this disk and the menu offers the relative path only. */
  absPathOf?: (path: string) => string | undefined;
  /** A file name's click. Without it the name folds the file, as the rest of
   *  its header row does. */
  openFile?: (file: ReviewFile) => void;
  /** A turn's files: diffed from texts, so "no changes" is not "now". */
  turn?: boolean;
  /** The list's own key for a path a jump names another way (absolute, for
   *  a file outside the main project). */
  resolvePath?: (path: string) => string;
  viewed?: DiffViewedSource | null;
  annotations?: DiffAnnotationSource | null;
  /** Between the header and the viewer (review threads off the diff). */
  banner?: ReactNode;
  /** After the last file, inside the scroller: a paging sentinel. */
  renderFooter?: () => ReactNode;
  /** The viewer's scroll element, for a host that reacts to its scrolling. */
  scrollerRef?: (node: HTMLDivElement | null) => void;
}

const LAYOUT_OPTIONS = [
  { value: "unified", label: "Stacked diff view", icon: <Rows3 size={12} />, iconOnly: true },
  { value: "split", label: "Split diff view", icon: <Columns2 size={12} />, iconOnly: true },
] as const;

/** Hide the viewer's own +/- counts: it counts only what has loaded, and a
 *  pending file would read +0 −0. The header shows the source's numbers. */
const HIDE_VIEWER_COUNTS = "[data-additions-count], [data-deletions-count] { display: none; }";

export const itemIdOf = (file: ReviewFile) => `${file.stat.oldPath ?? ""}\0${file.stat.path}`;

/** The tree beside the diff: its width is saved under this. */
const TREE_LAYOUT_ID = "git-review-diff-tree";

/** The whitespace mode every diff panel follows: the panel's toggle, or the setting. */
export function useDiffIgnoreWhitespace(): boolean {
  const stored = useDiffPanelStore.use.ignoreWhitespace();
  const setting = useSettingsStore((s) => s.settings.diffIgnoreWhitespace);
  return stored ?? setting;
}

/** `+12 −3`, in the diff palette's colours, compact past a thousand. */
export const DiffStat = memo(function DiffStat({
  additions,
  deletions,
  className,
}: {
  additions: number;
  deletions: number;
  className?: string;
}) {
  return (
    <span
      role="group"
      aria-label={`${additions} additions, ${deletions} deletions`}
      className={cn("inline-flex items-center gap-1 font-mono text-2xs tabular-nums", className)}
    >
      <span aria-hidden className="text-[var(--atlas-diff-added-text)]">
        +{formatCompactCount(additions)}
      </span>
      <span aria-hidden className="text-[var(--atlas-diff-removed-text)]">
        −{formatCompactCount(deletions)}
      </span>
    </span>
  );
});

/** A file header's counts: additions then deletions, both always shown
 *  (`+12 −0`), each in a fixed four-character column right-aligned, so the
 *  counts of a list of collapsed files line up down the panel. */
export const HeaderStat = memo(function HeaderStat({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  return (
    <span
      role="group"
      aria-label={`${additions} additions, ${deletions} deletions`}
      className="inline-grid grid-cols-[4ch_4ch] gap-2 text-right font-mono text-xs tabular-nums"
    >
      <span aria-hidden className="text-[var(--atlas-diff-added-text)]">
        +{formatCompactCount(additions)}
      </span>
      <span aria-hidden className="text-[var(--atlas-diff-removed-text)]">
        −{formatCompactCount(deletions)}
      </span>
    </span>
  );
});

/** The fold chevron takes the colour of the change, as the round icon beside
 *  it does: added, removed, or modified (a rename included). */
function chevronToneOf(fileDiff: FileDiffMetadata): string {
  switch (fileDiff.type) {
    case "new":
      return "text-[var(--atlas-diff-added-text)]";
    case "deleted":
      return "text-[var(--atlas-diff-removed-text)]";
    case "change":
    case "rename-pure":
    case "rename-changed":
      return "text-[var(--atlas-diff-modified-text)]";
    default:
      return "text-muted-foreground";
  }
}

/** Per-object memo of the content hash: re-hashing every line of every file on
 *  every render would cost more than the render. A parsed file's cache key
 *  already is its content hash (`withContentCacheKey`), so it is reused. */
const versionCache = new WeakMap<FileDiffMetadata, number>();
function contentVersion(fileDiff: FileDiffMetadata): number {
  let v = versionCache.get(fileDiff);
  if (v === undefined) {
    v = fileDiff.cacheKey ? fnv1a32(fileDiff.cacheKey) : buildFileDiffContentVersion(fileDiff);
    versionCache.set(fileDiff, v);
  }
  return v;
}

const noop = () => {};

export function DiffPanelView({
  tabId,
  repoPath,
  source,
  leading,
  actions,
}: {
  /** The tab this panel is, so `requestDiffJump` and ⌘F can find it. */
  tabId: string;
  /** The tree's root. */
  repoPath: string;
  source: DiffViewSource;
  leading?: ReactNode;
  actions?: ReactNode;
}) {
  const {
    key: scopeKey,
    files,
    viewed = null,
    annotations = null,
    requestFile = noop,
    retry = noop,
    openFile,
    copyPathOf,
    absPathOf,
  } = source;
  const layout = useDiffPanelStore.use.layout();
  // The global `wordWrap` setting: the button below flips it for file tabs too.
  const { wrap: wordWrap, toggle: toggleWordWrap } = useWordWrap();
  const fileTreeOpen = useDiffPanelStore.use.fileTreeOpen();
  const ignoreWhitespace = useDiffIgnoreWhitespace();
  const collapseByDefault = useSettingsStore((s) => s.settings.diffFilesCollapsed);
  const actionsApi = useDiffPanelStore.use.actions();

  // ── Folds: the reader's departures from each file's default, which is
  // folded when the setting says so (on unless turned off: a diff opens as a
  // list of its files, each expanded on a click), or when the file is marked
  // viewed. The departures are kept per scope, so a file opened stays open
  // across tab and scope switches. ──
  const folds = useDiffPanelStore((s) => s.folds[scopeKey] ?? NO_FOLDS);
  const collapseAll = collapseByDefault;
  const isViewed = viewed?.isViewed;
  const foldedByDefault = useCallback(
    (path: string) => collapseAll || (isViewed?.(path) ?? false),
    [collapseAll, isViewed],
  );
  const fileById = useMemo(() => new Map(files.map((f) => [itemIdOf(f), f])), [files]);
  const fileByPath = useMemo(() => new Map(files.map((f) => [f.stat.path, f])), [files]);
  const toggleFile = useCallback(
    (id: string) => actionsApi.toggleFold(scopeKey, id),
    [actionsApi, scopeKey],
  );
  // Stable: every header's chevron and the find bar hold it.
  const unfoldDeps = useRef({ fileById, requestFile, foldedByDefault });
  unfoldDeps.current = { fileById, requestFile, foldedByDefault };
  const unfold = useCallback(
    (id: string) => {
      const { fileById, requestFile, foldedByDefault } = unfoldDeps.current;
      const file = fileById.get(id);
      if (!file) return;
      if (file.state === "pending") requestFile(file.stat.path);
      actionsApi.setFolded(scopeKey, id, false, foldedByDefault(file.stat.path));
    },
    [actionsApi, scopeKey],
  );
  const folded = (file: ReviewFile) =>
    isFolded(folds, itemIdOf(file), foldedByDefault(file.stat.path));
  const allCollapsed = files.length > 0 && files.every(folded);
  const toggleAll = () => actionsApi.foldAll(scopeKey, allCollapsed ? "expanded" : "folded");

  // ── Viewed: a press marks the file and folds it (unmarking opens it), in
  // one render: the source's state and the fold change in the same event. ──
  const viewedSource = useRef(viewed);
  viewedSource.current = viewed;
  const setViewed = useCallback(
    (id: string, path: string, next: boolean) => {
      viewedSource.current?.setViewed(path, next);
      actionsApi.setFolded(scopeKey, id, next, collapseAll || next);
    },
    [actionsApi, scopeKey, collapseAll],
  );
  const viewedState = useMemo<FileViewedState | null>(
    () => (viewed ? { isViewed: viewed.isViewed, isStale: viewed.isStale, setViewed } : null),
    [viewed, setViewed],
  );
  const viewedCount = useMemo(
    () => (viewed ? files.reduce((n, f) => (viewed.isViewed(f.stat.path) ? n + 1 : n), 0) : 0),
    [files, viewed],
  );

  // `opened`: the files the reader wants open, loaded or not. A file still
  // to load is drawn folded until its patch arrives, and asks for it only
  // once it is wanted open: a collapsed row costs a header and no request.
  const { items, opened } = useMemo(() => {
    const opened = new Set<string>();
    const items = files.map((file): CodeViewDiffItem<unknown> => {
      const id = itemIdOf(file);
      const path = file.stat.path;
      const wanted = !isFolded(folds, id, foldedByDefault(path));
      if (wanted) opened.add(id);
      const isFold = file.state !== "ready" || !wanted;
      const viewedMark = viewed
        ? viewed.isStale(path)
          ? "s"
          : viewed.isViewed(path)
            ? "v"
            : ""
        : "";
      const annotated = annotations?.of(file) ?? null;
      return {
        id,
        type: "diff",
        fileDiff: file.fileDiff,
        collapsed: isFold,
        ...(annotated ? { annotations: annotated.annotations } : {}),
        // The viewer re-renders an item only when its version moves, so
        // everything its header and annotations show is in it.
        version: fnv1a32(
          `${contentVersion(file.fileDiff)}:${isFold ? 1 : 0}:${wanted ? 1 : 0}:${file.state}:${viewedMark}:${annotated?.version ?? ""}`,
        ),
      };
    });
    return { items, opened };
  }, [files, folds, foldedByDefault, viewed, annotations]);

  // ── Revealing a file: from the tree, or from outside (`requestDiffJump`) ──
  // The handle is held with the scope key its viewer was mounted for: the
  // viewer remounts per scope, and a jump that changes scope must not land on
  // the handle of the viewer it replaced.
  const [mounted, setMounted] = useState<{
    key: string;
    handle: CodeViewHandle<unknown, undefined>;
  } | null>(null);
  const setViewer = useCallback(
    (handle: CodeViewHandle<unknown, undefined> | null) =>
      setMounted((current) =>
        handle ? { key: scopeKey, handle } : current?.key === scopeKey ? null : current,
      ),
    [scopeKey],
  );
  const viewer = mounted?.key === scopeKey ? mounted.handle : null;
  const [selected, setSelected] = useState<string | null>(null);
  const resolvePath = source.resolvePath;
  const reveal = useCallback(
    (requested: string) => {
      const path = fileByPath.has(requested) ? requested : (resolvePath?.(requested) ?? requested);
      const file = fileByPath.get(path);
      if (!file) return false;
      const id = itemIdOf(file);
      setSelected(path);
      unfold(id);
      viewer?.scrollTo({ type: "item", id, align: "start" });
      return true;
    },
    [fileByPath, resolvePath, unfold, viewer],
  );

  // ── Find (⌘F), scoped to this tab: the session beside it keeps its own ──
  const [find, setFind] = useState({ open: false, focus: 0 });
  const findRef = useRef<DiffFindHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const openFind = useCallback(() => setFind((f) => ({ open: true, focus: f.focus + 1 })), []);
  const closeFind = useCallback(() => {
    setFind((f) => ({ ...f, open: false }));
    rootRef.current?.focus({ preventScroll: true });
  }, []);
  const canFind = files.length > 0;
  const unloaded = useMemo(() => files.filter((f) => f.state === "pending").length, [files]);
  useScopedHotkeys({
    tabId,
    handlers: {
      "diff.find": () => {
        if (!canFind) return false;
        openFind();
      },
    },
  });
  // Each file's render remounts rows; the open find repaints over them.
  const repaintFind = useCallback(() => findRef.current?.repaint(), []);

  const jump = useDiffJump(tabId);
  const handledJump = useRef<number | null>(null);
  useEffect(() => {
    if (!jump || handledJump.current === jump.nonce || !viewer) return;
    if (reveal(jump.path)) handledJump.current = jump.nonce;
  }, [jump, reveal, viewer]);

  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const f of files) {
      additions += f.stat.additions ?? 0;
      deletions += f.stat.deletions ?? 0;
    }
    return { additions, deletions };
  }, [files]);
  const treeFiles = useMemo(
    () => source.tree?.files ?? files.map((f) => f.stat),
    [source.tree?.files, files],
  );

  // The tree's width, remembered across sessions.
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: TREE_LAYOUT_ID });

  // The viewer memoizes each visible file's header and annotation portals on
  // these render props and on `options`: a fresh identity would recreate every
  // portal on screen on any re-render (a viewed press, a keystroke in a
  // comment), so they are held stable and read what changes through refs.
  const renderDeps = useRef({
    fileById,
    opened,
    copyPathOf,
    requestFile,
    retry,
    turn: !!source.turn,
  });
  renderDeps.current = { fileById, opened, copyPathOf, requestFile, retry, turn: !!source.turn };
  const renderHeaderPrefix = useCallback(
    (item: CodeViewItem<unknown>) => {
      const file = renderDeps.current.fileById.get(item.id);
      if (!file || item.type !== "diff") return null;
      return (
        <CollapseToggle
          id={item.id}
          path={file.stat.path}
          collapsed={item.collapsed === true}
          disabled={file.state !== "ready"}
          tone={chevronToneOf(file.fileDiff)}
          onToggle={toggleFile}
        />
      );
    },
    [toggleFile],
  );
  const renderHeaderFilenameSuffix = useCallback((item: CodeViewItem<unknown>) => {
    const { fileById, opened, copyPathOf, requestFile, retry, turn } = renderDeps.current;
    const file = fileById.get(item.id);
    if (!file) return null;
    return (
      <FileStatus
        file={file}
        wanted={opened.has(item.id)}
        copyPath={copyPathOf?.(file.stat.path)}
        onRequest={requestFile}
        onRetry={retry}
        turn={turn}
      />
    );
  }, []);
  const renderHeaderMetadata = useCallback((item: CodeViewItem<unknown>) => {
    const stat = renderDeps.current.fileById.get(item.id)?.stat;
    if (!stat) return null;
    return (
      <FileViewedToggle
        id={item.id}
        path={stat.path}
        stat={
          stat.additions === null ? null : (
            <HeaderStat additions={stat.additions} deletions={stat.deletions ?? 0} />
          )
        }
      />
    );
  }, []);
  const loadDiffFiles = source.loadDiffFiles;
  const annotationOptions = annotations?.options;
  const options = useMemo<StyledCodeViewOptions<unknown>>(
    () => ({
      diffStyle: layout,
      overflow: wordWrap ? "wrap" : "scroll",
      stickyHeaders: true,
      // Whole lines tinted, no word-level boxes inside them: a review reads
      // the line, and the boxes fight the syntax colour.
      lineDiffType: "none",
      onPostRender: repaintFind,
      loadDiffFiles,
      ...annotationOptions,
    }),
    [layout, wordWrap, repaintFind, loadDiffFiles, annotationOptions],
  );

  const header = (
    <div className="@container flex h-control-lg shrink-0 items-center gap-2 border-b border-border-subtle px-2">
      {leading}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {source.picker}
        {viewed && files.length > 0 && (
          <span className="min-w-0 shrink truncate text-xs text-muted-foreground tabular-nums">
            {viewedCount} / {files.length} viewed
          </span>
        )}
        {source.info}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {files.length > 0 && (
          <DiffStat
            additions={totals.additions}
            deletions={totals.deletions}
            className="mr-1 hidden @sm:inline-flex"
          />
        )}
        {source.refresh && (
          <Hint label="Refresh diff">
            <IconButton
              size="sm"
              icon={RefreshCw}
              label="Refresh diff"
              disabled={source.refresh.busy}
              onClick={source.refresh.run}
            />
          </Hint>
        )}
        {files.length > 0 && (
          <Hint label={allCollapsed ? "Expand all files" : "Collapse all files"}>
            <IconButton
              size="sm"
              icon={allCollapsed ? ChevronsUpDown : ChevronsDownUp}
              label={allCollapsed ? "Expand all files" : "Collapse all files"}
              onClick={toggleAll}
            />
          </Hint>
        )}
        <DropdownMenu>
          <Hint label="Diff options">
            <DropdownMenuTrigger
              render={
                <IconButton
                  size="sm"
                  icon={Settings2}
                  label="Diff options"
                  className="@md:hidden"
                />
              }
            />
          </Hint>
          <DropdownMenuContent align="end" sideOffset={4} className="w-48">
            <DropdownMenuRadioGroup
              value={layout}
              onValueChange={(value) => actionsApi.setLayout(value as DiffLayout)}
            >
              <DropdownMenuRadioItem value="unified" closeOnClick>
                Stacked
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="split" closeOnClick>
                Split
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked={wordWrap} onCheckedChange={toggleWordWrap}>
              Wrap lines
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={ignoreWhitespace}
              onCheckedChange={(checked) => actionsApi.setIgnoreWhitespace(checked)}
            >
              Hide whitespace changes
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="hidden items-center gap-1 @md:flex">
          <Segmented
            size="sm"
            aria-label="Diff layout"
            value={layout}
            onValueChange={actionsApi.setLayout}
            options={LAYOUT_OPTIONS}
          />
          <Hint label={wordWrap ? "Disable word wrap" : "Enable word wrap"}>
            <IconButton
              size="sm"
              icon={WrapText}
              label="Word wrap"
              aria-pressed={wordWrap}
              onClick={toggleWordWrap}
            />
          </Hint>
          <Hint label={ignoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}>
            <IconButton
              size="sm"
              icon={Pilcrow}
              label="Hide whitespace changes"
              aria-pressed={ignoreWhitespace}
              onClick={() => actionsApi.setIgnoreWhitespace(!ignoreWhitespace)}
            />
          </Hint>
        </div>
        {files.length > 0 && (
          <Hint label={fileTreeOpen ? "Hide file tree" : "Show file tree"}>
            <IconButton
              size="sm"
              icon={FolderTree}
              label="Show file tree"
              aria-pressed={fileTreeOpen}
              onClick={() => actionsApi.setFileTreeOpen(!fileTreeOpen)}
            />
          </Hint>
        )}
        {actions}
      </div>
    </div>
  );

  // ── A file header's right-click menu: one menu for the viewer, aimed by
  // the header the press was on. A press anywhere else is let through. ──
  const [menuFile, setMenuFile] = useState<ReviewFile | null>(null);
  const onContextMenuCapture = (event: React.MouseEvent) => {
    const file = headerFileAt(event.nativeEvent.composedPath(), fileByPath);
    if (!file) {
      event.stopPropagation();
      return;
    }
    setMenuFile(file);
  };
  const menuTarget = menuFile
    ? {
        deleted: menuFile.stat.status === "deleted",
        absPath: absPathOf?.(menuFile.stat.path) ?? null,
        relPath: copyPathOf?.(menuFile.stat.path) ?? menuFile.stat.path,
        canOpen: !!openFile,
      }
    : null;

  const body = source.placeholder ?? (
    <Group
      id={TREE_LAYOUT_ID}
      orientation="horizontal"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
      className="min-h-0 flex-1"
    >
      <Panel id="review-diff-files" className="min-w-0">
        <ContextMenu>
          <ContextMenuTrigger
            render={<div className="relative h-full min-h-0 min-w-0" />}
            onContextMenuCapture={onContextMenuCapture}
            onClickCapture={(event) => {
              // A file's name opens the file (where the source can); the rest
              // of its header row folds it. Its buttons keep their own actions:
              // the chevron in particular must not also reach the row, or the
              // two folds cancel out.
              const path = event.nativeEvent.composedPath();
              for (const node of path) {
                if (node instanceof HTMLButtonElement || node instanceof HTMLAnchorElement) return;
                if (node instanceof HTMLElement && node.hasAttribute("data-diff-find")) return;
                if (node instanceof HTMLElement && node.hasAttribute("data-viewed-toggle")) return;
              }
              const title = path.find(
                (n): n is HTMLElement => n instanceof HTMLElement && n.hasAttribute("data-title"),
              );
              const headerNode = path.find(
                (n): n is HTMLElement =>
                  n instanceof HTMLElement && n.hasAttribute("data-diffs-header"),
              );
              if (!headerNode) return;
              const name = (title ?? headerNode.querySelector("[data-title]"))?.textContent?.trim();
              const file = name ? fileByPath.get(name) : undefined;
              if (!file) return;
              if (!title || !openFile) {
                if (file.state === "ready") toggleFile(itemIdOf(file));
                return;
              }
              openFile(file);
            }}
          >
            <FileViewedContext value={viewedState}>
              <StyledCodeView<unknown>
                // Remounted only when what it shows is a different diff. A
                // refresh updates items in place, keeping the scroll position
                // and every unchanged file's tokens.
                key={scopeKey}
                viewerRef={setViewer}
                className="h-full min-h-0 overflow-auto"
                items={items}
                fallback={<DiffPanelSkeleton />}
                extraCSS={HIDE_VIEWER_COUNTS}
                options={options}
                selectedLines={annotations?.selectedLines}
                onSelectedLinesChange={annotations?.onSelectedLinesChange}
                renderHeaderPrefix={renderHeaderPrefix}
                renderHeaderFilenameSuffix={renderHeaderFilenameSuffix}
                renderHeaderMetadata={renderHeaderMetadata}
                renderAnnotation={annotations?.render}
                renderCodeViewFooter={source.renderFooter}
                containerRef={source.scrollerRef}
              />
            </FileViewedContext>
            {/* After the viewer: its item updates land first (`DiffFindBar`). */}
            {find.open && (
              <DiffFindBar
                ref={findRef}
                viewer={viewer}
                items={items}
                onUnfold={unfold}
                onClose={closeFind}
                focusRequest={find.focus}
                unloaded={unloaded}
              />
            )}
          </ContextMenuTrigger>
          {menuFile && menuTarget && (
            <DiffFileContextMenuContent target={menuTarget} onOpen={() => openFile?.(menuFile)} />
          )}
        </ContextMenu>
      </Panel>
      {fileTreeOpen && (
        <>
          <Separator className="w-px cursor-col-resize bg-border-subtle transition-colors hover:bg-primary data-[separator=active]:bg-primary" />
          <Panel
            id="review-diff-tree"
            defaultSize="34"
            minSize="16"
            maxSize="50"
            className="flex min-w-0 flex-col"
          >
            <DiffFileTree
              files={treeFiles}
              groups={source.tree?.groups}
              root={repoPath}
              selectedPath={selected}
              onSelect={reveal}
            />
          </Panel>
        </>
      )}
    </Group>
  );

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      data-diff-panel
      className="flex h-full min-h-0 flex-col bg-[var(--atlas-editor-background)] outline-none"
    >
      {header}
      {source.placeholder ? null : source.banner}
      {body}
    </div>
  );
}

/** The file whose header an event's path crosses, by the name it shows. */
export function headerFileAt(
  path: readonly EventTarget[],
  fileByPath: ReadonlyMap<string, ReviewFile>,
): ReviewFile | null {
  const header = path.find(
    (n): n is HTMLElement => n instanceof HTMLElement && n.hasAttribute("data-diffs-header"),
  );
  if (!header) return null;
  const name = header.querySelector("[data-title]")?.textContent?.trim();
  return (name && fileByPath.get(name)) || null;
}

export function DiffEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
      {children}
    </div>
  );
}

const CollapseToggle = memo(function CollapseToggle({
  id,
  path,
  collapsed,
  disabled,
  tone,
  onToggle,
}: {
  id: string;
  path: string;
  collapsed: boolean;
  disabled: boolean;
  /** The change's colour (`chevronToneOf`). */
  tone: string;
  onToggle: (id: string) => void;
}) {
  // A plain button rather than `IconButton`: the glyph wears the change's
  // colour, which the primitive's ghost look would override.
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <Hint label={collapsed ? "Expand diff" : "Collapse diff"}>
      <button
        type="button"
        aria-label={collapsed ? `Expand ${path}` : `Collapse ${path}`}
        aria-expanded={!collapsed}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          onToggle(id);
        }}
        className={cn(
          "-ms-0.5 inline-flex size-control-xs shrink-0 cursor-pointer items-center justify-center rounded transition-colors duration-fast hover:bg-element-hover disabled:cursor-not-allowed disabled:opacity-50",
          tone,
        )}
      >
        <Chevron size={16} aria-hidden />
      </button>
    </Hint>
  );
});

/** The header's tail: copy, and what is wrong with the file if anything. A
 *  pending file the reader wants open asks for its contents when its row
 *  mounts, which is when the viewer has scrolled it into its render window;
 *  a collapsed one asks for nothing until it is opened. */
function FileStatus({
  file,
  wanted,
  copyPath,
  onRequest,
  onRetry,
  turn = false,
}: {
  file: ReviewFile;
  /** The reader wants it open (not collapsed). */
  wanted: boolean;
  /** What "Copy path" copies: the path in the file's own root. */
  copyPath?: string;
  onRequest: (path: string) => void;
  onRetry: (path: string) => void;
  /** A turn's file: diffed from its texts, so "no changes" is not "now". */
  turn?: boolean;
}) {
  const { path } = file.stat;
  const pending = file.state === "pending" && wanted;
  useEffect(() => {
    if (pending) onRequest(path);
  }, [pending, path, onRequest]);
  return (
    <span className="ml-1 inline-flex items-center gap-1">
      <CopyPathButton path={copyPath ?? path} />
      {pending && <span className="text-2xs text-muted-foreground">Loading…</span>}
      {file.state === "binary" && <span className="text-2xs text-muted-foreground">Binary</span>}
      {file.state === "too-large" && (
        <span className="text-2xs text-muted-foreground">Too large to show</span>
      )}
      {file.state === "empty" && (
        <span className="text-2xs text-muted-foreground">
          {turn ? "No changes" : "No changes now"}
        </span>
      )}
      {file.excerpt && (
        <Hint label="Only the lines the agent replaced are known, not the whole file. Line numbers count from the excerpt.">
          <span className="rounded border border-border px-1 text-2xs text-muted-foreground">
            Excerpt
          </span>
        </Hint>
      )}
      {file.state === "error" && (
        <Hint label="Couldn't load this file. Retry">
          <IconButton
            size="xs"
            icon={AlertCircle}
            label="Retry loading diff"
            onClick={(event) => {
              event.stopPropagation();
              onRetry(path);
            }}
          />
        </Hint>
      )}
      {file.truncated && (
        <Hint label="Too large to show in full: only the first hunks are shown. Counts include every change.">
          <span className="inline-flex text-muted-foreground" aria-label="Partial diff">
            <Info size={12} />
          </span>
        </Hint>
      )}
    </span>
  );
}
