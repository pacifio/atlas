import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Dialog } from "@base-ui/react/dialog";
import { RefreshCw, GitBranch, Maximize2, Minimize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { HintGroup, HintItem } from "@/ui/hint-group";
import { IconButton, iconButtonVariants } from "@/ui/icon-button";
import { useAppStore } from "@/features/app/stores/app-store";
import { useGitStore } from "@/features/git/stores/git-store";
import { CommitRowView } from "./commit-node";
import { openCommit } from "../lib/open-commit";
import { ROW_HEIGHT, commitCountLabel, type BuiltGraph } from "../lib/git-graph";

const DEFAULT_LIMIT = 1000;

// Persist scroll position per repo path across mount/unmount + fullscreen toggle.
const scrollPositionCache = new Map<string, number>();

export function GitGraphPanel() {
  const project = useAppStore.use.currentProject();
  const isRepo = useGitStore.use.isRepo();
  const path = project?.path ?? "";

  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const queryClient = useQueryClient();

  // No polling — the Rust-side git watcher (commands/git_watcher.rs)
  // emits `atlas:git-changed` on commit / checkout / branch / fetch
  // ops, and the effect below invalidates this query in response.
  // Refocus also triggers a refetch in case the user did something in
  // an external terminal while Atlas was backgrounded.
  const sigQuery = useQuery({
    queryKey: ["git-graph-signature", path],
    queryFn: () => invoke<string>("git_graph_signature", { path }),
    enabled: !!path && isRepo,
    staleTime: Infinity,
    refetchOnWindowFocus: true,
  });
  const signature = sigQuery.data ?? "";

  // Single invoke: Rust runs `git log` + `git for-each-ref` in
  // parallel, lays out the lanes/segments, and ships the finished
  // BuiltGraph. React just renders. The 300-LOC JS layout algorithm
  // that used to live in `lib/git-graph.ts::buildGraph` is gone.
  const graphQuery = useQuery<BuiltGraph>({
    queryKey: ["git-graph", path, signature, limit],
    queryFn: () => invoke<BuiltGraph>("git_graph_build", { path, limit, all: true }),
    enabled: !!path && isRepo && !!signature,
    staleTime: Infinity,
    placeholderData: (prev) => prev,
  });

  const rows = graphQuery.data?.rows ?? [];

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen("atlas:git-changed", () => {
      if (cancelled) return;
      queryClient.invalidateQueries({ queryKey: ["git-graph-signature", path] });
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [path, queryClient]);

  // Read through a ref so `onSelect` keeps one identity across graph refetches
  // — every memoised row takes it as a prop.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const onSelect = useCallback(
    (sha: string) => {
      setSelectedSha(sha);
      openCommit(path, sha, rowsRef.current.find((r) => r.sha === sha)?.message);
    },
    [path],
  );

  if (!path || !isRepo) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-sm text-muted-foreground gap-2 px-6 text-center">
        <GitBranch size={18} className="opacity-60" />
        <div>Not a git repository.</div>
        <div className="text-2xs">
          Open a project that contains a `.git` folder to see its history.
        </div>
      </div>
    );
  }

  const refreshing = sigQuery.isFetching || graphQuery.isFetching;

  const inner = (
    <GraphView
      path={path}
      rows={rows}
      totalCommits={graphQuery.data?.totalCommits ?? rows.length}
      isLoading={graphQuery.isLoading && !graphQuery.data}
      compact={!fullscreen}
      selectedSha={selectedSha}
      onSelect={onSelect}
      limit={limit}
      onShowMore={() => setLimit((l) => l + DEFAULT_LIMIT)}
      refreshing={refreshing}
      onRefresh={() => sigQuery.refetch()}
      fullscreen={fullscreen}
      onToggleFullscreen={() => setFullscreen((f) => !f)}
    />
  );

  if (!fullscreen) return inner;

  // Fullscreen: same component, just inside a centered Radix Dialog covering the viewport.
  return (
    <Dialog.Root open onOpenChange={(open) => !open && setFullscreen(false)}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-overlay scrim" />
        <Dialog.Popup
          aria-describedby={undefined}
          className="fixed top-8.5 left-4 right-4 bottom-6 z-modal rounded-xl border border-border bg-card overflow-hidden flex flex-col shadow-lg focus:outline-none"
        >
          <Dialog.Title className="sr-only">Git Graph</Dialog.Title>
          {inner}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface GraphViewProps {
  path: string;
  rows: BuiltGraph["rows"];
  totalCommits: number;
  isLoading: boolean;
  compact: boolean;
  selectedSha: string | null;
  onSelect: (sha: string) => void;
  limit: number;
  onShowMore: () => void;
  refreshing: boolean;
  onRefresh: () => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}

function GraphView({
  path,
  rows,
  totalCommits,
  isLoading,
  compact,
  selectedSha,
  onSelect,
  limit,
  onShowMore,
  refreshing,
  onRefresh,
  fullscreen,
  onToggleFullscreen,
}: GraphViewProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    getItemKey: (i) => rows[i]?.sha ?? i,
  });

  // Scroll cache — keyed by repo path, shared between inline + fullscreen mounts.
  useLayoutEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const cached = scrollPositionCache.get(path);
    if (cached !== undefined) el.scrollTop = cached;
  }, [path]);

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const onScroll = () => {
      scrollPositionCache.set(path, el.scrollTop);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scrollPositionCache.set(path, el.scrollTop);
      el.removeEventListener("scroll", onScroll);
    };
  }, [path]);

  const items = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const showMore = useMemo(() => rows.length >= limit, [rows.length, limit]);

  return (
    <div className="h-full flex flex-col bg-card">
      {/* Header */}
      <div className="flex items-center justify-between pl-3 pr-1.5 h-control-lg shrink-0 border-b border-border-subtle">
        <div className="flex items-center gap-1.5">
          {rows.length > 0 && (
            <span className="eyebrow tabular-nums">
              {commitCountLabel(rows.length, totalCommits)}
            </span>
          )}
        </div>
        <HintGroup>
          <div className="flex items-center gap-0.5">
            <HintItem label={fullscreen ? "Exit fullscreen" : "Fullscreen"}>
              <IconButton
                size="sm"
                icon={fullscreen ? Minimize2 : Maximize2}
                label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
                onClick={onToggleFullscreen}
              />
            </HintItem>
            {/* `IconButton`'s own square on a plain button: the glyph spins
                while refreshing, which the primitive's fixed glyph can't. */}
            <HintItem label="Refresh">
              <button
                type="button"
                onClick={onRefresh}
                className={iconButtonVariants({ size: "sm" })}
              >
                <RefreshCw size={12} className={cn(refreshing && "animate-spin")} />
              </button>
            </HintItem>
          </div>
        </HintGroup>
      </div>

      {/* Virtualized commit list */}
      <div className="flex-1 min-h-0 relative">
        <div ref={parentRef} className="absolute inset-0 overflow-auto hide-scrollbar">
          {isLoading && <div className="px-3 py-3 text-xs text-muted-foreground">Loading…</div>}
          {rows.length === 0 && !isLoading && (
            <div className="px-3 py-3 text-xs text-muted-foreground">No commits.</div>
          )}
          {rows.length > 0 && (
            <div style={{ height: totalSize, width: "100%", position: "relative" }}>
              {items.map((v) => {
                const row = rows[v.index];
                return (
                  <div
                    key={row.sha}
                    data-index={v.index}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${v.start}px)`,
                    }}
                  >
                    <CommitRowView
                      row={row}
                      repoPath={path}
                      selected={row.sha === selectedSha}
                      compact={compact}
                      onSelect={onSelect}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {showMore && (
          <>
            <div
              aria-hidden
              className="pointer-events-none absolute left-0 right-0 bottom-0 h-16 z-panel"
              style={{
                background: "linear-gradient(to bottom, transparent, var(--card))",
              }}
            />
            <button
              onClick={onShowMore}
              className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 px-3 h-control-md rounded-full border border-border bg-card text-xs font-medium text-secondary-foreground hover:text-foreground hover:bg-element-hover shadow-sm transition-colors duration-fast cursor-pointer"
              title={`Show ${DEFAULT_LIMIT} more commits`}
            >
              Show {DEFAULT_LIMIT} more
            </button>
          </>
        )}
      </div>
    </div>
  );
}
