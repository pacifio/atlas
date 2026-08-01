import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  RefreshCw,
  ArrowDown,
  ArrowUp,
  UploadCloud,
  Loader2,
  GitMerge,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useGitStore } from "../../stores/git-store";
import { BranchSwitcher } from "./branch-switcher";
import { MergeBranchDialog } from "./merge-branch-dialog";
import { ChangesView } from "./changes-view";
import { HistoryView } from "./history-view";
import { StashesView } from "./stashes-view";

type View = "changes" | "history" | "stashes";

/**
 * Unified Source-Control manager — GitHub-Desktop-style toolbar (branch
 * switcher + fetch/pull/push with ahead/behind) over Changes / History /
 * Stashes views. Lives in the right panel and is the single place to run
 * the workspace repo's git workflow.
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

  useEffect(() => {
    if (repoPath) void actions.refreshAll(repoPath).catch(() => {});
  }, [repoPath, actions]);

  // When a commit is selected elsewhere (e.g. clicking a node in the Git Graph),
  // jump this panel to History so its commit-detail view shows.
  const selectedCommit = useGitStore.use.selectedCommit();
  useEffect(() => {
    if (selectedCommit) setView("history");
  }, [selectedCommit]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
    }
  };

  if (!isRepo) {
    return (
      <div className="px-3 py-8 text-center text-[11px] text-text-tertiary">
        Not a git repository
      </div>
    );
  }

  const current = branchesFull.find((b) => b.isCurrent);
  const hasUpstream = !!current?.upstream;
  const changedCount = files.length;

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar: branch + sync */}
      <div className="shrink-0 flex items-center gap-1 px-1.5 h-[29px] border-b border-border-default">
        <BranchSwitcher />
        <button
          onClick={() => setMergeOpen(true)}
          className="flex items-center justify-center w-6 h-6 rounded text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer shrink-0"
          title={`Merge a branch into ${current?.name ?? "the current branch"}`}
        >
          <GitMerge size={12} />
        </button>
        <div className="ml-auto flex items-center gap-0.5">
          <ToolbarBtn
            onClick={() => run("fetch", () => actions.fetch())}
            busy={busy === "fetch"}
            title="Fetch"
            icon={<RefreshCw size={12} />}
          />
          {hasUpstream ? (
            <>
              <ToolbarBtn
                onClick={() => run("pull", () => actions.pull(false))}
                busy={busy === "pull"}
                title="Pull"
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

      {/* View tabs */}
      <div className="shrink-0 flex items-center gap-0.5 px-1.5 h-[29px] border-b border-border-default">
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

      <div className="flex-1 min-h-0">
        {view === "changes" && <ChangesView />}
        {view === "history" && <HistoryView />}
        {view === "stashes" && <StashesView />}
      </div>

      <MergeBranchDialog open={mergeOpen} onOpenChange={setMergeOpen} />
    </div>
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
  return (
    <button
      onClick={onClick}
      disabled={busy}
      title={title}
      className="flex items-center gap-1 h-6 px-1.5 rounded text-[10px] font-medium text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-50"
    >
      {busy ? <Loader2 size={12} className="animate-spin" /> : icon}
      {label && <span>{label}</span>}
      {badge !== undefined && (
        <span className="font-mono text-[9px] text-text-secondary">
          {badge}
        </span>
      )}
    </button>
  );
}

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
    <button
      onClick={onClick}
      className={cn(
        "px-2 h-6 rounded text-[11px] font-medium transition-colors",
        active
          ? "text-text-primary bg-bg-selected"
          : "text-text-tertiary hover:text-text-secondary hover:bg-bg-hover",
      )}
    >
      {children}
    </button>
  );
}
