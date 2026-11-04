import { useEffect } from "react";
import { useGitStore } from "../../stores/git-store";
import { handleGitError } from "../../lib/git-errors";
import { openCommit } from "../../lib/open-commit";
import { CommitAvatar } from "../commit-avatar";
import { Button, HintGroup, HintItem } from "@tryatlas/design";

export function HistoryView() {
  const repoPath = useGitStore.use.repoPath();
  const log = useGitStore.use.log();
  const actions = useGitStore.use.actions();

  useEffect(() => {
    if (repoPath) void actions.loadLog(repoPath);
  }, [repoPath, actions]);

  const run = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      handleGitError(e);
    }
  };

  return (
    <div className="h-full overflow-y-auto hide-scrollbar">
      {log.length === 0 ? (
        <div className="px-3 py-8 text-center text-xs text-muted-foreground">No history</div>
      ) : (
        <HintGroup>
          {log.map((c, i) => (
            <div key={c.hash} className="relative group">
              <HintItem
                label={`View commit diff · ${c.short_hash.slice(0, 7)}`}
                className="flex w-full"
              >
                <button
                  // Named for what the row IS — otherwise the hint's label
                  // ("View commit diff · sha") becomes its accessible name.
                  aria-label={`${c.message} — ${c.author}, ${c.date}`}
                  onClick={() => repoPath && openCommit(repoPath, c.hash, c.message)}
                  className="w-full text-left flex flex-col gap-1 px-3 py-2 border-b border-border-subtle transition-colors duration-fast hover:bg-element-hover"
                >
                  <span className="text-xs font-medium text-secondary-foreground group-hover:text-foreground truncate pr-12">
                    {c.message}
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5 caption">
                    <CommitAvatar email={c.email} size={14} />
                    <span className="truncate">{c.author}</span>
                    <span className="shrink-0">·</span>
                    <span className="shrink-0">{c.date}</span>
                    <span className="shrink-0">·</span>
                    <span className="shrink-0 font-mono">{c.short_hash.slice(0, 7)}</span>
                  </span>
                </button>
              </HintItem>
              {i === 0 && (
                <span className="absolute right-2 top-1.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      void run(() => actions.undoCommit());
                    }}
                    title="Undo this commit — changes return to the staged area (blocked once pushed)"
                  >
                    Undo
                  </Button>
                </span>
              )}
            </div>
          ))}
        </HintGroup>
      )}
    </div>
  );
}
