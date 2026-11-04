import type { KeyboardEvent, MouseEvent, ReactNode, RefObject } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import { ChevronsDownUp, ChevronsUpDown, RefreshCw } from "lucide-react";

import { cn } from "@/lib/utils";
import { IconButton } from "@/ui/icon-button";
import { Hint } from "@/ui/tooltip";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/ui/context-menu";
import { PanelSkeleton } from "@/components/panel-skeleton";
import type { WorkingTreeChanges } from "@/features/git/lib/use-working-tree-changes";

import { absoluteOf } from "../../lib/project-file-ops";
import { nameOf, type TreeRowData } from "../../lib/project-tree-model";
import { INDENT_PER_LEVEL, ROW_HEIGHT } from "../../lib/tree-constants";
import { ROOT_DROP } from "../../hooks/use-file-tree-drag-drop";
import { ProjectTreeRow, RenameInput } from "../project-tree-row";
import { FileTreeConfirmDelete } from "../file-tree-confirm-delete";

/**
 * What `ProjectFileTree` draws, from props alone: the header band, the
 * virtualized rows (and the new-entry row among them), and the frame around
 * them with its context menu and delete confirmation.
 */

export interface GhostRow {
  kind: "ghost";
  /** The folder the new entry goes in (root-relative). */
  parent: string;
  depth: number;
  isDir: boolean;
}

export type DisplayRow = TreeRowData | GhostRow;

export const isGhost = (row: DisplayRow): row is GhostRow => row.kind === "ghost";

export const GHOST_KEY = "\0new-entry";

export const domIdOf = (rel: string) =>
  `ptree-${rel.replace(/[^A-Za-z0-9_-]/g, (c) => `_${c.charCodeAt(0)}`)}`;

// ── Header ────────────────────────────────────────────────────────────────

// One quiet row, as in the file view's header band: refresh, the search
// field filling the width, then collapse/expand all. New files and folders
// are on the tree's context menu (a row's, or the empty space below).
export function ProjectFileTreeHeader({
  root,
  leading,
  searchRef,
  query,
  onQueryChange,
  onClearSearch,
  canEnterResults,
  onEnterResults,
  onRefresh,
  anyExpanded,
  onToggleAll,
}: {
  root: string;
  leading?: ReactNode;
  searchRef: RefObject<HTMLInputElement | null>;
  query: string;
  onQueryChange: (query: string) => void;
  onClearSearch: () => void;
  /** There are rows for ↓ to move into. */
  canEnterResults: boolean;
  /** ↓ from the field: into the results, at the first hit (or the first row). */
  onEnterResults: () => void;
  onRefresh: () => void;
  anyExpanded: boolean;
  onToggleAll: () => void;
}) {
  return (
    <div className="flex h-control-lg shrink-0 items-center gap-1 px-2">
      {leading}
      <Hint label="Refresh">
        <IconButton size="sm" icon={RefreshCw} label="Refresh files" onClick={onRefresh} />
      </Hint>
      <div className="flex h-control-md min-w-0 flex-1 items-center rounded-md px-1.5 transition-colors duration-fast hover:bg-element-hover focus-within:bg-element-hover">
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onClearSearch();
              e.currentTarget.blur();
            } else if (e.key === "ArrowDown" && canEnterResults) {
              // Into the results, at the first hit (or the first row).
              e.preventDefault();
              onEnterResults();
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
          onClick={onToggleAll}
        />
      </Hint>
    </div>
  );
}

// ── Body ──────────────────────────────────────────────────────────────────

export interface ProjectFileTreeBodyProps {
  root: string;
  ready: boolean;
  rootError: string | undefined;
  onRetry: () => void;
  /** A search is applied and nothing matched. */
  noMatches: boolean;
  display: readonly DisplayRow[];
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  isOpen: (row: TreeRowData) => boolean;
  loading: ReadonlySet<string>;
  errors: ReadonlyMap<string, string>;
  selectedPaths: ReadonlySet<string>;
  focused: string | null;
  activeAbs: string | null;
  clipboard: { paths: string[]; isCut: boolean } | null;
  dropTarget: string | null;
  draggedPath: string | undefined;
  changes: WorkingTreeChanges;
  onShowDiff?: (path: string) => void;
  hideArrows: boolean;
  renaming: string | null;
  onRenameCommit: (path: string, name: string) => void;
  onRenameCancel: () => void;
  onGhostCommit: (row: GhostRow, name: string) => void;
  onGhostCancel: () => void;
}

export function ProjectFileTreeBody({
  root,
  ready,
  rootError,
  onRetry,
  noMatches,
  display,
  virtualizer,
  isOpen,
  loading,
  errors,
  selectedPaths,
  focused,
  activeAbs,
  clipboard,
  dropTarget,
  draggedPath,
  changes,
  onShowDiff,
  hideArrows,
  renaming,
  onRenameCommit,
  onRenameCancel,
  onGhostCommit,
  onGhostCancel,
}: ProjectFileTreeBodyProps) {
  let body: ReactNode;
  if (!ready && rootError) {
    body = (
      <button type="button" onClick={() => onRetry()} className="p-4 text-left text-xs text-error">
        {rootError} Click to retry.
      </button>
    );
  } else if (!ready) {
    body = <PanelSkeleton rows={10} className="gap-1.5 p-2" />;
  } else if (noMatches) {
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
                  onCommit={(name) => onGhostCommit(row, name)}
                  onCancel={() => onGhostCancel()}
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
              selected={selectedPaths.has(row.path)}
              focused={focused === row.path}
              active={abs === activeAbs}
              cut={clipboard?.isCut === true && clipboard.paths.includes(abs)}
              dropTarget={isDir && dropTarget === abs}
              dropSegment={
                row.chain && dropTarget && row.chain.some((l) => absoluteOf(root, l) === dropTarget)
                  ? dropTarget
                  : null
              }
              dragging={draggedPath === abs}
              gitColor={gitColor}
              additions={change?.stat.additions ?? null}
              deletions={change?.stat.deletions ?? null}
              changed={!!change && !!onShowDiff && change.stat.status !== "deleted"}
              hideArrows={hideArrows}
              renaming={renaming === row.path}
              onRenameCommit={onRenameCommit}
              onRenameCancel={onRenameCancel}
            />
          );
        })}
      </div>
    );
  }
  return <>{body}</>;
}

// ── Frame ─────────────────────────────────────────────────────────────────

export function ProjectFileTreeFrame({
  root,
  header,
  truncated,
  scrollRef,
  focused,
  dropTarget,
  onContainerMouseDown,
  onClick,
  onContextMenu,
  onKeyDown,
  body,
  menu,
  deleteTargets,
  onConfirmDelete,
  onDismissDelete,
}: {
  root: string;
  header: ReactNode;
  /** The search found more than it shows. */
  truncated: boolean | undefined;
  scrollRef: RefObject<HTMLDivElement | null>;
  focused: string | null;
  dropTarget: string | null;
  onContainerMouseDown: (e: MouseEvent) => void;
  onClick: (e: MouseEvent) => void;
  onContextMenu: (e: MouseEvent) => void;
  onKeyDown: (e: KeyboardEvent) => void;
  body: ReactNode;
  menu: ReactNode;
  deleteTargets: TreeRowData[] | null;
  onConfirmDelete: () => void;
  onDismissDelete: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--editor-background)]">
      {header}
      {truncated && (
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
              dropTarget === ROOT_DROP && "bg-primary-muted ring-1 ring-primary/40 ring-inset",
            )}
            onMouseDown={onContainerMouseDown}
            onClick={onClick}
            onContextMenu={onContextMenu}
            onKeyDown={onKeyDown}
          >
            {body}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>{menu}</ContextMenuContent>
      </ContextMenu>

      {deleteTargets && deleteTargets.length > 0 && (
        <FileTreeConfirmDelete
          open
          name={deleteTargets[0].name}
          isDir={deleteTargets[0].kind === "directory"}
          count={deleteTargets.length}
          onConfirm={onConfirmDelete}
          onOpenChange={(open) => {
            if (!open) onDismissDelete();
          }}
        />
      )}
    </div>
  );
}
