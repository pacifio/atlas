import { useEffect, useState } from "react";
import { RefreshCw, ArrowDown, ArrowUp, UploadCloud, Loader2, GitMerge } from "lucide-react";
import { useGitStore } from "../../stores/git-store";
import { handleGitError } from "../../lib/git-errors";
import { fetchHint } from "../../lib/auto-fetch";
import { gitErrorText, notifyGitRemoteOp } from "@/features/notifications/lib/outcome-notifier";
import { BranchSwitcher } from "./branch-switcher";
import { MergeBranchDialog } from "./merge-branch-dialog";
import { GitErrorDialog } from "./git-error-dialog";
import { PullChoiceDialog } from "./pull-choice-dialog";
import { ChangesView } from "./changes-view";
import { HistoryView } from "./history-view";
import { StashesView } from "./stashes-view";
import { Button, IconButton, HintGroup, HintItem } from "@tryatlas/design";

type View = "changes" | "history" | "stashes";

/**
 * Unified Source-Control manager — one header row (the Changes / History /
 * Stashes switch, then the branch switcher and fetch/pull/push with
 * ahead/behind) over the selected view. Lives in the source-control surface and is the single place to run
 * the project repo's git workflow.
 */
export function GitManagerPanel() {
  const isRepo = useGitStore.use.isRepo();
  const repoPath = useGitStore.use.repoPath();
  const ahead = useGitStore.use.ahead();
  const behind = useGitStore.use.behind();
  const branchesFull = useGitStore.use.branchesFull();
  const files = useGitStore.use.files();
  const actions = useGitStore.use.actions();

  const [view, setView] = useState<View>("changes");
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
  const changedCount = files.length;
  const mergeLabel = `Merge a branch into ${current?.name ?? "the current branch"}`;

  return (
    <div className="h-full flex flex-col relative">
      {/* Weighted progress for streaming network ops (fetch/pull/push/clone). */}
      {progress && (
        <div
          className="absolute top-0 left-0 h-0.5 bg-primary transition-[width] duration-base z-panel"
          style={{ width: `${Math.min(100, progress.percent)}%` }}
          title={progress.title}
        />
      )}
      {/* One header row: the view switch, then the branch and its sync, in
          that tab order. Too narrow for both, the branch group wraps onto a
          second line (still right-aligned) instead of clipping, and there the
          branch name truncates before anything else gives. */}
      <HintGroup>
        <div className="shrink-0 flex flex-wrap items-center gap-x-1 gap-y-0.5 px-1.5 py-1 border-b border-border-subtle">
          <div className="flex items-center gap-0.5">
            <ViewTab active={view === "changes"} onClick={() => setView("changes")}>
              Changes{changedCount > 0 ? ` (${changedCount})` : ""}
            </ViewTab>
            <ViewTab active={view === "history"} onClick={() => setView("history")}>
              History
            </ViewTab>
            <ViewTab active={view === "stashes"} onClick={() => setView("stashes")}>
              Stashes
            </ViewTab>
          </div>
          <div className="ml-auto flex min-w-0 max-w-full items-center gap-0.5">
            <BranchSwitcher />
            <HintItem label={mergeLabel}>
              <IconButton
                size="sm"
                icon={GitMerge}
                label={mergeLabel}
                onClick={() => setMergeOpen(true)}
              />
            </HintItem>
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
          </div>
        </div>
      </HintGroup>

      <div className="flex-1 min-h-0">
        {view === "changes" && <ChangesView />}
        {view === "history" && <HistoryView />}
        {view === "stashes" && <StashesView />}
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

/** A view switch: the selected one carries the pressed ring, the rest sit
 *  back as ghosts — the same pair as the section row above it. */
function ViewTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button variant="ghost" size="sm" aria-pressed={active} onClick={onClick}>
      {children}
    </Button>
  );
}
