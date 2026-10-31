// The changed-files card at the end of a turn: what the turn edited, as a
// folder tree with line counts, and a way into the turn's diff.
//
// Performance contract (see `turn-rows.ts`): the card is the footer row of a
// SETTLED turn — `turnSummary` is frozen at `turn_finished` and its `files`
// array keeps its identity across projections, so the tree below is built
// once per turn and a streaming turn elsewhere never re-renders it. Nothing
// here animates in a loop, so the offscreen-animation rules have nothing to
// pause. The rows are real DOM like the rest of the transcript; a turn that
// touched hundreds of files shows the first `ROW_LIMIT` rows until asked.

import { memo, useMemo, useState, type MouseEvent } from "react";
import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Eye,
  FileDiff,
  FolderGit2,
  FolderInput,
  Pencil,
} from "lucide-react";
import type { TurnFile } from "@/types/agent";
import { cn } from "@/lib/utils";
import { copyText } from "@/lib/clipboard";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { Hint } from "@/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/ui/context-menu";
import { useAppStore } from "@/features/app/stores/app-store";
import { FileIcon } from "@/features/icon-theme/components/file-icon";
import { openReviewFile } from "@/features/git/lib/open-review-file";
import {
  buildChangedFilesTree,
  changedFilesByRoot,
  folderPaths,
  formatDiffCount,
  splitForMiddleTruncate,
  sumStats,
  visibleRows,
  type ChangedFile,
  type ChangedNode,
  type ChangedRow,
  type DiffStat,
} from "../lib/changed-files-tree";
import { isAbsolutePath, joinPath, openTurnDiff } from "../lib/open-turn-diff";
import { needsGroupHeaders, type SessionRoot } from "../lib/session-roots";
import { useSessionRoots } from "../hooks/use-session-roots";
import { useChatStore } from "../stores/chat-store";
import { useChangedFilesStore } from "../stores/changed-files-store";

/** Rows drawn before "Show all": a card is a summary, not the file list. */
export const ROW_LIMIT = 200;
/** One level of the tree's indent, in px. */
const INDENT = 14;
const NO_OVERRIDES: Record<string, boolean> = {};

/**
 * Settled cards off screen cost nothing per frame.
 *
 * A card is a few dozen nodes, and a long session has one under every turn
 * that edited, so they add up to thousands. A streaming frame restyles the
 * document, and measured against the card-less footer that was +0.4 ms a
 * frame and twice the dropped frames. `content-visibility: auto` lets the
 * browser skip their style and layout until they scroll near.
 *
 * Skipped, a card measures as its intrinsic size. `auto` makes that the size
 * it last rendered at; before its first render it is this estimate, which is
 * exact: the header (`h-control-xs` plus `py-2`), a 1.75rem (`h-7`) row per
 * visible row, and the tree's `p-2`. An exact guess matters because the
 * transcript grows upward, and a card that changed height as it scrolled in
 * would move everything under the reader.
 */
function cardStyle(rows: number) {
  return {
    contentVisibility: "auto",
    containIntrinsicSize: `auto calc(var(--control-xs) + 2rem + ${rows} * 1.75rem)`,
  } as const;
}

/** `+12 −3`, compact past a thousand. Zero sides are kept: a column of
 *  figures reads by position. `aligned` sets the two sides in fixed columns,
 *  right-aligned, so the rows of a tree line up figure under figure. */
export function DiffCounts({
  added,
  removed,
  layout = "inline",
  className,
}: {
  added: number;
  removed: number;
  layout?: "inline" | "aligned";
  className?: string;
}) {
  return (
    <span
      role="group"
      aria-label={`${added} added, ${removed} removed`}
      className={cn(
        "shrink-0 font-mono tabular-nums",
        layout === "aligned"
          ? "inline-grid grid-cols-[4ch_4ch] gap-2 text-right"
          : "inline-flex gap-1",
        className,
      )}
    >
      <span aria-hidden className="text-[var(--atlas-diff-added-text)]">
        +{formatDiffCount(added)}
      </span>
      <span aria-hidden className="text-[var(--atlas-diff-removed-text)]">
        −{formatDiffCount(removed)}
      </span>
    </span>
  );
}

/** A group's share of the card: its root and the tree of its files. */
interface CardGroup {
  key: string;
  label: string;
  root: SessionRoot | null;
  /** What a relative path in this group is relative to; "" for "Other". */
  base: string;
  stat: DiffStat;
  tree: ChangedNode[];
}

export const ChangedFilesCard = memo(function ChangedFilesCard({
  turnKey,
  tabId,
  files: turnFiles,
}: {
  /** The turn's stable key (`stableTurnKey`): what the card opens, and
   *  what its expand-all answer is remembered by across relaunches. */
  turnKey: string;
  /** The chat the turn is in: its session's attached projects decide the
   *  groups. Without it the card is the main project's alone. */
  tabId?: string;
  /** The turn's frozen `turnSummary.files`; reads are left out here. */
  files: readonly TurnFile[];
}) {
  const repoPath = useAppStore((s) => s.currentProject?.path ?? "");
  const sessionId = useChatStore((s) => (tabId ? (s.sessions[tabId]?.acpSessionId ?? null) : null));
  const roots = useSessionRoots(sessionId, repoPath);
  // A turn inside the main project only (the common case) keeps the one
  // ungrouped tree; one that reached into an attached project, or outside
  // every root, gets a group per root.
  const groups = useMemo(() => changedFilesByRoot(turnFiles, roots), [turnFiles, roots]);
  const grouped = needsGroupHeaders(groups);
  const files = useMemo(() => groups.flatMap((g) => g.files), [groups]);
  const total = useMemo(() => sumStats(files), [files]);
  const cardGroups = useMemo<CardGroup[]>(
    () =>
      groups.map((g) => ({
        key: g.key,
        label: g.label,
        root: g.root,
        base: g.root?.path ?? "",
        stat: g.stat,
        tree: buildChangedFilesTree(g.files),
      })),
    [groups],
  );
  const hasFolders = cardGroups.some((g) => g.tree.some((n) => n.kind === "dir"));

  const allExpanded = useChangedFilesStore((s) => s.expanded[turnKey] === true);
  const { setExpanded } = useChangedFilesStore.use.actions();
  // What the card measures before it has ever been laid out (see `cardStyle`).
  // A group header is one row.
  const firstRows = useMemo(() => {
    let rows = 0;
    for (const g of cardGroups) {
      const n = visibleRows(g.tree, NO_OVERRIDES, allExpanded).length;
      rows += (n > ROW_LIMIT ? ROW_LIMIT + 1 : n) + (grouped ? 1 : 0);
    }
    return rows;
  }, [cardGroups, allExpanded, grouped]);

  return (
    <div
      className="@container/changed-files rounded-lg bg-card"
      data-changed-files=""
      style={cardStyle(firstRows)}
    >
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 rounded-t-lg bg-card px-3 py-2">
        <div className="flex min-w-0 items-center gap-3 text-xs font-medium text-foreground">
          <span className="truncate">
            {files.length} changed file{files.length === 1 ? "" : "s"}
          </span>
          {(total.added > 0 || total.removed > 0) && (
            <DiffCounts added={total.added} removed={total.removed} className="text-xs" />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {hasFolders && (
            <Hint label={allExpanded ? "Collapse all folders" : "Expand all folders"} side="top">
              <IconButton
                size="xs"
                icon={allExpanded ? ChevronsDownUp : ChevronsUpDown}
                label={allExpanded ? "Collapse all folders" : "Expand all folders"}
                onClick={() => setExpanded(turnKey, !allExpanded)}
              />
            </Hint>
          )}
          <Hint label="Open this turn's diff" side="top">
            <Button
              variant="ghost"
              size="xs"
              aria-label="Open diff"
              onClick={() => openTurnDiff(turnKey)}
            >
              <FileDiff size={12} />
              {/* A narrow card keeps the icon alone. */}
              <span className="hidden @sm/changed-files:inline">Open diff</span>
            </Button>
          </Hint>
        </div>
      </div>
      <div className="p-2">
        {cardGroups.map((g) => (
          <div
            key={g.key}
            role={grouped ? "group" : undefined}
            aria-label={grouped ? g.label : undefined}
          >
            {grouped && <GroupHeader group={g} />}
            <ChangedFilesTree
              // A new expand-all answer starts the folders afresh, as it says.
              key={allExpanded ? "all" : "folded"}
              turnKey={turnKey}
              repoPath={g.base}
              tree={g.tree}
              allExpanded={allExpanded}
            />
          </div>
        ))}
      </div>
    </div>
  );
});

/** A root's header in a grouped card: the project's name, how the session
 *  may use it, and its share of the counts. The root's path is its title. */
function GroupHeader({ group }: { group: CardGroup }) {
  const Icon = group.root ? FolderGit2 : FolderInput;
  const access = group.root?.access;
  return (
    <div
      className="flex h-7 min-w-0 items-center gap-2 px-2 text-xs font-medium text-secondary-foreground"
      title={group.root ? group.root.path : "Files outside the session's projects"}
    >
      <Icon size={14} className="shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 truncate">{group.label}</span>
      {group.root?.kind === "main" && (
        <span className="shrink-0 text-2xs font-normal text-muted-foreground">Main</span>
      )}
      {access && (
        <span className="inline-flex shrink-0 text-muted-foreground">
          {access === "read_write" ? (
            <Pencil size={11} aria-label="Read and write" />
          ) : (
            <Eye size={11} aria-label="Read only" />
          )}
        </span>
      )}
      <DiffCounts
        added={group.stat.added}
        removed={group.stat.removed}
        layout="aligned"
        className="ml-auto text-2xs"
      />
    </div>
  );
}

const ChangedFilesTree = memo(function ChangedFilesTree({
  turnKey,
  repoPath,
  tree,
  allExpanded,
}: {
  turnKey: string;
  repoPath: string;
  tree: ReturnType<typeof buildChangedFilesTree>;
  allExpanded: boolean;
}) {
  // The reader's own folder toggles, over the expand-all default. Keyed by
  // the tree's folders, so a different set of folders starts clean.
  const folderKey = useMemo(() => folderPaths(tree).join("\0"), [tree]);
  const [overrides, setOverrides] = useState<{ key: string; open: Record<string, boolean> }>({
    key: folderKey,
    open: NO_OVERRIDES,
  });
  const open = overrides.key === folderKey ? overrides.open : NO_OVERRIDES;
  const toggle = (path: string) =>
    setOverrides((current) => {
      const prior = current.key === folderKey ? current.open : NO_OVERRIDES;
      return { key: folderKey, open: { ...prior, [path]: !(prior[path] ?? allExpanded) } };
    });

  const rows = useMemo(() => visibleRows(tree, open, allExpanded), [tree, open, allExpanded]);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? rows : rows.slice(0, ROW_LIMIT);
  const flat = !tree.some((n) => n.kind === "dir");

  // One menu for the whole tree, aimed by the row that was right-clicked.
  const [menuFile, setMenuFile] = useState<ChangedFile | null>(null);
  const onContextMenu = (event: MouseEvent) => {
    const el = (event.target as HTMLElement).closest<HTMLElement>("[data-changed-file]");
    const path = el?.dataset.changedFile;
    const row = path ? rows.find((r) => r.node.kind === "file" && r.node.path === path) : null;
    setMenuFile(row?.node.kind === "file" ? row.node.file : null);
  };
  const absolute = (file: ChangedFile) =>
    isAbsolutePath(file.source) || !repoPath ? file.source : joinPath(repoPath, file.path);

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={<div role="tree" aria-label="Changed files" />}
        onContextMenu={onContextMenu}
      >
        {shown.map((row) => (
          <TreeRow
            key={`${row.node.kind}:${row.node.path}`}
            row={row}
            open={row.node.kind === "dir" && (open[row.node.path] ?? allExpanded)}
            flat={flat}
            onToggle={toggle}
            onOpen={(file) => openTurnDiff(turnKey, file.source)}
          />
        ))}
        {rows.length > shown.length && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="flex h-7 w-full cursor-pointer items-center rounded-md px-2 text-left text-2xs text-muted-foreground hover:bg-element-hover hover:text-foreground"
          >
            Show {rows.length - shown.length} more
          </button>
        )}
      </ContextMenuTrigger>
      {menuFile && (
        <ContextMenuContent>
          <ContextMenuItem onClick={() => openTurnDiff(turnKey, menuFile.source)}>
            Show diff
          </ContextMenuItem>
          <ContextMenuItem onClick={() => void openReviewFile(absolute(menuFile))}>
            Open file
          </ContextMenuItem>
          <ContextMenuItem onClick={() => void copyText(menuFile.path)}>Copy path</ContextMenuItem>
        </ContextMenuContent>
      )}
    </ContextMenu>
  );
});

const ROW =
  "group flex h-7 w-full cursor-pointer items-center gap-2 rounded-md pr-2 text-left outline-none transition-colors duration-fast hover:bg-element-hover focus-visible:ring-1 focus-visible:ring-border-strong focus-visible:ring-inset";

/** A name cut in the middle, not at the end: `use-turn-revi…s.test.tsx`. The
 *  whole name is the row's title. */
function MiddleTruncate({ value }: { value: string }) {
  const split = splitForMiddleTruncate(value);
  if (!split) return <span className="min-w-0 truncate">{value}</span>;
  return (
    <span className="inline-flex min-w-0 max-w-full overflow-hidden whitespace-nowrap">
      <span className="min-w-0 truncate">{split.head}</span>
      <span className="shrink-0">{split.tail}</span>
    </span>
  );
}

function TreeRow({
  row,
  open,
  flat,
  onToggle,
  onOpen,
}: {
  row: ChangedRow;
  open: boolean;
  /** No folders anywhere: files sit flush, with no chevron column. */
  flat: boolean;
  onToggle: (path: string) => void;
  onOpen: (file: ChangedFile) => void;
}) {
  const { node, depth } = row;
  const indent = { paddingLeft: 8 + depth * INDENT };
  if (node.kind === "dir") {
    return (
      <button
        type="button"
        role="treeitem"
        aria-expanded={open}
        title={node.path}
        onClick={() => onToggle(node.path)}
        className={ROW}
        style={indent}
      >
        <ChevronRight
          size={14}
          className={cn(
            "shrink-0 text-muted-foreground transition-transform duration-fast group-hover:text-foreground",
            open && "rotate-90",
          )}
        />
        <FileIcon path={node.path} kind={open ? "folderExpanded" : "folder"} size={14} />
        <span className="min-w-0 truncate font-mono text-2xs text-muted-foreground group-hover:text-foreground">
          {node.name}
        </span>
        {(node.stat.added > 0 || node.stat.removed > 0) && (
          <DiffCounts
            added={node.stat.added}
            removed={node.stat.removed}
            layout="aligned"
            className="ml-auto text-2xs"
          />
        )}
      </button>
    );
  }
  const { file } = node;
  return (
    <button
      type="button"
      role="treeitem"
      title={file.movedFrom ? `${file.path}\nRenamed from ${file.movedFrom}` : file.path}
      data-changed-file={file.path}
      onClick={() => onOpen(file)}
      className={ROW}
      style={indent}
    >
      {!flat && <span className="size-3.5 shrink-0" aria-hidden />}
      <FileIcon path={file.path} size={14} />
      <span className="flex min-w-0 font-mono text-xs text-secondary-foreground group-hover:text-foreground">
        <MiddleTruncate value={node.name} />
      </span>
      <DiffCounts
        added={file.added}
        removed={file.removed}
        layout="aligned"
        className="ml-auto text-2xs"
      />
    </button>
  );
}
