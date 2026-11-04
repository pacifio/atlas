import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Dialog, DialogContent, DialogTitle } from "@tryatlas/design";
import { useAppStore } from "@/features/app/stores/app-store";
import { useGitStore } from "@/features/git/stores/git-store";
import { openCommit } from "../lib/open-commit";
import type { BuiltGraph } from "../lib/git-graph";
import { GitGraphView } from "./views/git-graph-view";

const DEFAULT_LIMIT = 1000;

/** The commit graph's container: reads the repo, runs the graph queries, and
 *  hands `GitGraphView` plain props. */
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
  // BuiltGraph. React just renders.
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

  const notARepo = !path || !isRepo;
  const view = (
    <GitGraphView
      state={
        notARepo ? "not-a-repo" : graphQuery.isLoading && !graphQuery.data ? "loading" : "ready"
      }
      repoPath={path}
      rows={rows}
      totalCommits={graphQuery.data?.totalCommits ?? rows.length}
      compact={!fullscreen}
      selectedSha={selectedSha}
      onSelect={onSelect}
      showMoreCount={rows.length >= limit ? DEFAULT_LIMIT : null}
      onShowMore={() => setLimit((l) => l + DEFAULT_LIMIT)}
      refreshing={sigQuery.isFetching || graphQuery.isFetching}
      onRefresh={() => sigQuery.refetch()}
      fullscreen={fullscreen}
      onToggleFullscreen={() => setFullscreen((f) => !f)}
    />
  );

  if (notARepo || !fullscreen) return view;

  // Fullscreen: the same view in the house dialog, stretched to the window
  // below the titlebar.
  return (
    <Dialog open onOpenChange={(open) => !open && setFullscreen(false)}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="top-8.5 right-4 bottom-6 left-4 w-auto max-w-none translate-x-0 translate-y-0 gap-0 overflow-hidden p-0"
      >
        <DialogTitle className="sr-only">Git Graph</DialogTitle>
        {view}
      </DialogContent>
    </Dialog>
  );
}
