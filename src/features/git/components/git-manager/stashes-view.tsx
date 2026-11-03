import { useEffect } from "react";
import { Archive } from "lucide-react";
import { Button } from "@/ui/button";
import { useGitStore } from "../../stores/git-store";
import { handleGitError } from "../../lib/git-errors";

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
      handleGitError(e);
    }
  };

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 border-b border-border-subtle p-2">
        <Button
          variant="outline"
          onClick={() => run(() => actions.stashPush())}
          disabled={files.length === 0}
          className="w-full"
        >
          <Archive size={12} />
          Stash all changes
        </Button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto hide-scrollbar">
        {stashes.length === 0 ? (
          <div className="px-3 py-8 text-center text-xs text-muted-foreground">No stashes</div>
        ) : (
          stashes.map((s) => (
            <div
              key={s.index}
              className="group flex flex-col gap-0.5 py-2 pr-1.5 pl-3 border-b border-border-subtle transition-colors duration-fast hover:bg-element-hover"
            >
              <span className="text-xs font-medium text-secondary-foreground group-hover:text-foreground truncate">
                {s.message}
              </span>
              <div className="flex items-center gap-0.5">
                <span className="font-mono text-2xs text-muted-foreground flex-1 truncate">
                  stash@{`{${s.index}}`} {s.branch && `· ${s.branch}`}
                </span>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => run(() => actions.stashApply(s.index))}
                >
                  Apply
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => run(() => actions.stashPop(s.index))}
                >
                  Pop
                </Button>
                <Button
                  variant="ghost-destructive"
                  size="xs"
                  onClick={() => run(() => actions.stashDrop(s.index))}
                >
                  Drop
                </Button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
