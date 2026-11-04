import { lazy, Suspense, useEffect, useState } from "react";
import {
  RefreshCw,
  ArrowDown,
  ArrowUp,
  UploadCloud,
  Loader2,
  GitMerge,
  Archive,
  MoreHorizontal,
} from "lucide-react";
import { useGitStore } from "../../stores/git-store";
import { handleGitError } from "../../lib/git-errors";
import { fetchHint } from "../../lib/auto-fetch";
import { gitErrorText, notifyGitRemoteOp } from "@/features/notifications/lib/outcome-notifier";
import { PanelSkeleton } from "@/components/panel-skeleton";
import { BranchSwitcher } from "./branch-switcher";
import { MergeBranchDialog } from "./merge-branch-dialog";
import { GitErrorDialog } from "./git-error-dialog";
import { PullChoiceDialog } from "./pull-choice-dialog";
import { ChangesView } from "./changes-view";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  HintGroup,
  HintItem,
  IconButton,
} from "@tryatlas/design";

// xyflow-free but virtualised and IPC-heavy: loaded only when History opens.
const GitGraphPanel = lazy(() =>
  import("../git-graph-panel").then((m) => ({ default: m.GitGraphPanel })),
);

export type GitManagerView = "changes" | "history";

/**
 * The repository half of source control: the branch bar (the branch, its
 * sync with the remote, and a menu for merge and stash) over Changes or
 * History. The branch bar is shared because both views are about the same
 * branch; the dialogs live here because the bar's operations open them.
 */
export function GitManagerPanel({ view }: { view: GitManagerView }) {
  const isRepo = useGitStore.use.isRepo();
  const repoPath = useGitStore.use.repoPath();
  const ahead = useGitStore.use.ahead();
  const behind = useGitStore.use.behind();
  const branchesFull = useGitStore.use.branchesFull();
  const files = useGitStore.use.files();
  const actions = useGitStore.use.actions();

  const [busy, setBusy] = useState<string | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  // Only the progress bar's input, never the whole op: `activeOp` changes on
  // every output batch a hook prints (~12 a second), and this panel is the
  // parent of the changes list — re-rendering it per batch re-rendered every
  // changed file's row, which on a big change set outran the batches and
  // froze the window until the hook finished, or for good.
  const progress = useGitStore((s) => (s.activeOp?.running ? s.activeOp.progress : null));

  useEffect(() => {
    if (repoPath) void actions.refreshAll(repoPath).catch(() => {});
  }, [repoPath, actions]);

  // The toolbar buttons are the user-started remote operations — the only
  // callers that notify (auto-fetch and the merge dialog's fetch never do).
  const run = async (label: "fetch" | "pull" | "push" | "publish", fn: () => Promise<void>) => {
    setBusy(label);
    const startedAt = Date.now();
    const path = repoPath;
    try {
      await fn();
      notifyGitRemoteOp(label, path, startedAt, null);
    } catch (e) {
      notifyGitRemoteOp(label, path, startedAt, gitErrorText(e));
      handleGitError(e);
    } finally {
      setBusy(null);
    }
  };

  // Diverged: a plain pull reconciles only if git config names a strategy.
  // Honour a saved one; ask up front only where git itself would refuse.
  const onPull = async () => {
    if (ahead > 0 && behind > 0) {
      const preference = await actions.pullPreference().catch(() => "ask" as const);
      if (preference === "ask") {
        actions.showPullChoice({ kind: "diverged" });
        return;
      }
    }
    await run("pull", () => actions.pull());
  };

  if (!isRepo) {
    return (
      <div className="px-3 py-8 text-center text-xs text-muted-foreground">
        Not a git repository
      </div>
    );
  }

  const current = branchesFull.find((b) => b.isCurrent);
  const hasUpstream = !!current?.upstream;
  const mergeLabel = `Merge a branch into ${current?.name ?? "the current branch"}…`;

  return (
    <div className="relative flex h-full flex-col">
      {/* Weighted progress for streaming network ops (fetch/pull/push/clone). */}
      {progress && (
        <div
          className="absolute top-0 left-0 z-panel h-0.5 bg-primary transition-[width] duration-base"
          style={{ width: `${Math.min(100, progress.percent)}%` }}
          title={progress.title}
        />
      )}
      {/* The branch bar: which branch, and how it stands with its remote.
          Too narrow, the branch name truncates before anything else gives. */}
      <HintGroup>
        <div className="flex h-control-lg shrink-0 items-center gap-0.5 border-b border-border-subtle px-1.5">
          <BranchSwitcher />
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            <FetchButton
              repoPath={repoPath}
              onClick={() => run("fetch", () => actions.fetch())}
              busy={busy === "fetch"}
            />
            {hasUpstream ? (
              <>
                <ToolbarBtn
                  onClick={() => void onPull()}
                  busy={busy === "pull"}
                  title={ahead > 0 && behind > 0 ? "Pull (branch has diverged)" : "Pull"}
                  icon={<ArrowDown size={12} />}
                  badge={behind > 0 ? behind : undefined}
                />
                <ToolbarBtn
                  onClick={() => run("push", () => actions.push())}
                  busy={busy === "push"}
                  title="Push"
                  icon={<ArrowUp size={12} />}
                  badge={ahead > 0 ? ahead : undefined}
                />
              </>
            ) : (
              <ToolbarBtn
                onClick={() => run("publish", () => actions.publishBranch())}
                busy={busy === "publish"}
                title="Publish branch (push -u origin)"
                icon={<UploadCloud size={12} />}
                label="Publish"
              />
            )}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<IconButton size="sm" icon={MoreHorizontal} label="More git actions" />}
              />
              <DropdownMenuContent align="end" className="min-w-56">
                <DropdownMenuItem onClick={() => setMergeOpen(true)}>
                  <GitMerge />
                  {mergeLabel}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={files.length === 0}
                  title={files.length === 0 ? "There are no changes to stash." : undefined}
                  onClick={() => void actions.stashPush().catch((e: unknown) => handleGitError(e))}
                >
                  <Archive />
                  Stash all changes
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </HintGroup>

      <div className="min-h-0 flex-1">
        {view === "changes" ? (
          <ChangesView />
        ) : (
          <Suspense fallback={<PanelSkeleton label="Loading…" />}>
            <GitGraphPanel />
          </Suspense>
        )}
      </div>

      <MergeBranchDialog open={mergeOpen} onOpenChange={setMergeOpen} />
      <GitErrorDialog onForcePush={() => run("push", () => actions.push(true))} />
      <PullChoiceDialog onChoose={(strategy) => run("pull", () => actions.pull(strategy))} />
    </div>
  );
}

/** Fetch, hinting when the remote was last fetched (by auto-fetch or by
 *  hand). Re-renders on its own every 30s so "3m ago" doesn't freeze while
 *  the rest of the panel sits idle. */
function FetchButton({
  repoPath,
  onClick,
  busy,
}: {
  repoPath: string | null;
  onClick: () => void;
  busy: boolean;
}) {
  const autoFetch = useGitStore.use.autoFetch();
  const status = repoPath ? autoFetch[repoPath] : undefined;
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  return (
    <ToolbarBtn
      onClick={onClick}
      busy={busy}
      title={fetchHint(status)}
      icon={<RefreshCw size={12} />}
    />
  );
}

function ToolbarBtn({
  onClick,
  busy,
  title,
  icon,
  badge,
  label,
}: {
  onClick: () => void;
  busy?: boolean;
  title: string;
  icon: React.ReactNode;
  badge?: number;
  label?: string;
}) {
  const button = (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      disabled={busy}
      // A labelled button explains itself; its title only adds the detail.
      title={label ? title : undefined}
    >
      {busy ? <Loader2 size={12} className="animate-spin" /> : icon}
      {label && <span>{label}</span>}
      {badge !== undefined && <span className="font-mono tabular-nums">{badge}</span>}
    </Button>
  );
  return label ? button : <HintItem label={title}>{button}</HintItem>;
}
