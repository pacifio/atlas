import { useEffect } from "react";
import { toast } from "sonner";
import { Archive } from "lucide-react";
import { useGitStore } from "../../stores/git-store";

export function StashesView() {
  const repoPath = useGitStore.use.repoPath();
  const stashes = useGitStore.use.stashes();
  const files = useGitStore.use.files();
  const actions = useGitStore.use.actions();

  useEffect(() => {
    if (repoPath) void actions.loadStashes();
  }, [repoPath, actions]);

  const run = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      toast.error(String(e));
    }
  };

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 border-b border-border-default p-2">
        <button
          onClick={() => run(() => actions.stashPush())}
          disabled={files.length === 0}
          className="w-full flex items-center justify-center gap-1.5 h-7 rounded-md text-[11px] font-medium bg-bg-elevated text-text-secondary hover:text-text-primary hover:bg-bg-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Archive size={12} />
          Stash all changes
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto hide-scrollbar">
        {stashes.length === 0 ? (
          <div className="px-3 py-8 text-center text-[11px] text-text-tertiary">
            No stashes
          </div>
        ) : (
          stashes.map((s) => (
            <div
              key={s.index}
              className="group flex flex-col gap-1 px-3 py-2 border-b border-border-subtle"
            >
              <span className="text-[11px] text-text-secondary truncate">
                {s.message}
              </span>
              <div className="flex items-center gap-2">
                <span className="text-[9px] font-mono text-text-tertiary flex-1">
                  stash@{`{${s.index}}`} {s.branch && `· ${s.branch}`}
                </span>
                <button
                  onClick={() => run(() => actions.stashApply(s.index))}
                  className="text-[10px] text-text-tertiary hover:text-text-primary"
                >
                  Apply
                </button>
                <button
                  onClick={() => run(() => actions.stashPop(s.index))}
                  className="text-[10px] text-text-tertiary hover:text-text-primary"
                >
                  Pop
                </button>
                <button
                  onClick={() => run(() => actions.stashDrop(s.index))}
                  className="text-[10px] text-text-tertiary hover:text-[var(--status-error)]"
                >
                  Drop
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
