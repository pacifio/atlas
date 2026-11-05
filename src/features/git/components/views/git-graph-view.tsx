import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { GitBranch, GitCommit, Maximize2, Minimize2, RefreshCw } from "lucide-react";
import { Button, EmptyState, HintGroup, HintItem, IconButton, Skeleton } from "@tryatlas/design";
import { ROW_HEIGHT, commitCountLabel, type BuiltGraph } from "../../lib/git-graph";
import { CommitRowView } from "./commit-row-view";

/** Scroll position per repo, shared by the inline and fullscreen mounts so
 *  toggling fullscreen (or leaving the tab) lands back where you were. */
const scrollPositionCache = new Map<string, number>();

export type GitGraphState = "loading" | "ready" | "not-a-repo";

export interface GitGraphViewProps {
  state: GitGraphState;
  /** The repository shown: keys the scroll cache and the avatars. */
  repoPath: string;
  rows: BuiltGraph["rows"];
  totalCommits: number;
  /** Fullscreen shows every ref plus the author, sha and date columns. */
  compact: boolean;
  selectedSha: string | null;
  onSelect: (sha: string) => void;
  /** How many more rows "Show more" asks for; null hides the button. */
  showMoreCount: number | null;
  onShowMore: () => void;
  refreshing: boolean;
  onRefresh: () => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}

/** The commit graph: a header with the count and controls over a virtualised
 *  list of commit rows. Renders from its props alone. */
export function GitGraphView(props: GitGraphViewProps) {
  if (props.state === "not-a-repo") {
    return (
      <EmptyState
        data-view="git-graph"
        className="h-full"
        icon={GitBranch}
        title="Not a git repository."
        description="Open a project that contains a `.git` folder to see its history."
      />
    );
  }
  return <GraphBody {...props} />;
}

function GraphBody({
  state,
  repoPath,
  rows,
  totalCommits,
  compact,
  selectedSha,
  onSelect,
  showMoreCount,
  onShowMore,
  refreshing,
  onRefresh,
  fullscreen,
  onToggleFullscreen,
}: GitGraphViewProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    getItemKey: (i) => rows[i]?.sha ?? i,
  });

  useLayoutEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const cached = scrollPositionCache.get(repoPath);
    if (cached !== undefined) el.scrollTop = cached;
  }, [repoPath]);

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const onScroll = () => {
      scrollPositionCache.set(repoPath, el.scrollTop);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    // No write on cleanup: by then the scroller can be detached, reading 0,
    // and would overwrite the position the other mount should restore.
    return () => {
      el.removeEventListener("scroll", onScroll);
    };
  }, [repoPath]);

  // The keyboard cursor: the list is one Tab stop, and arrows move this
  // index (`aria-activedescendant`) without moving DOM focus off the list,
  // since the rows it points at may not be mounted yet.
  const listId = useId();
  const selectedIndex = selectedSha ? rows.findIndex((r) => r.sha === selectedSha) : -1;
  const [cursor, setCursor] = useState(() => Math.max(0, selectedIndex));
  const focusIndex = Math.min(cursor, Math.max(0, rows.length - 1));
  const rowId = (sha: string) => `${listId}-commit-${sha}`;
  const focusedSha = rows[focusIndex]?.sha;

  const selectRow = useCallback(
    (sha: string) => {
      const i = rows.findIndex((r) => r.sha === sha);
      if (i >= 0) setCursor(i);
      onSelect(sha);
    },
    [rows, onSelect],
  );

  const onListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || rows.length === 0) return;
    if ((e.key === "Enter" || e.key === " ") && focusedSha) {
      e.preventDefault();
      onSelect(focusedSha);
      return;
    }
    const page = Math.max(1, Math.floor(e.currentTarget.clientHeight / ROW_HEIGHT) - 1);
    const last = rows.length - 1;
    const next =
      e.key === "ArrowDown"
        ? Math.min(last, focusIndex + 1)
        : e.key === "ArrowUp"
          ? Math.max(0, focusIndex - 1)
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : e.key === "PageDown"
                ? Math.min(last, focusIndex + page)
                : e.key === "PageUp"
                  ? Math.max(0, focusIndex - page)
                  : null;
    if (next === null) return;
    e.preventDefault();
    setCursor(next);
    virtualizer.scrollToIndex(next, { align: "auto" });
  };

  const items = virtualizer.getVirtualItems();
  const loading = state === "loading";
  const fullscreenLabel = fullscreen ? "Exit fullscreen" : "Fullscreen";

  return (
    <div data-view="git-graph" className="flex h-full flex-col bg-card">
      <div className="flex h-control-lg shrink-0 items-center justify-between border-b border-border-subtle pr-1.5 pl-3">
        <div className="flex items-center gap-1.5">
          {rows.length > 0 && (
            <span className="eyebrow tabular-nums">
              {commitCountLabel(rows.length, totalCommits)}
            </span>
          )}
        </div>
        <HintGroup>
          <div className="flex items-center gap-0.5">
            <HintItem label={fullscreenLabel}>
              <IconButton
                size="sm"
                icon={fullscreen ? Minimize2 : Maximize2}
                label={fullscreenLabel}
                onClick={onToggleFullscreen}
              />
            </HintItem>
            {/* Inline, the branch bar above already has a refresh-shaped
                Fetch and the watcher keeps the graph current, so a second
                refresh glyph only shows in fullscreen, where that bar is not. */}
            {fullscreen && (
              <HintItem label="Refresh">
                <IconButton
                  size="sm"
                  icon={RefreshCw}
                  label="Refresh"
                  loading={refreshing}
                  onClick={onRefresh}
                />
              </HintItem>
            )}
          </div>
        </HintGroup>
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={parentRef}
          role={rows.length > 0 ? "listbox" : undefined}
          aria-label={rows.length > 0 ? "Commits" : undefined}
          aria-activedescendant={rows.length > 0 && focusedSha ? rowId(focusedSha) : undefined}
          tabIndex={rows.length > 0 ? 0 : undefined}
          onKeyDown={onListKeyDown}
          className="group/graph absolute inset-0 overflow-auto outline-none hide-scrollbar"
        >
          {loading && (
            <div role="status" aria-busy className="py-1.5">
              <span className="sr-only">Loading…</span>
              {Array.from({ length: 12 }, (_, i) => (
                <Skeleton key={i} className="mx-3 my-1.5 h-4" />
              ))}
            </div>
          )}
          {rows.length === 0 && !loading && <EmptyState icon={GitCommit} title="No commits." />}
          {rows.length > 0 && (
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {items.map((v) => {
                const row = rows[v.index];
                return (
                  <div
                    key={row.sha}
                    data-index={v.index}
                    className="absolute top-0 left-0 w-full"
                    style={{ transform: `translateY(${v.start}px)` }}
                  >
                    <CommitRowView
                      row={row}
                      repoPath={repoPath}
                      selected={row.sha === selectedSha}
                      focused={v.index === focusIndex}
                      id={rowId(row.sha)}
                      compact={compact}
                      onSelect={selectRow}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {showMoreCount !== null && (
          <>
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 z-panel h-16 bg-linear-to-b from-transparent to-card"
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={onShowMore}
              className="absolute bottom-3 left-1/2 z-panel -translate-x-1/2"
              title={`Show ${showMoreCount} more commits`}
            >
              Show {showMoreCount} more
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
