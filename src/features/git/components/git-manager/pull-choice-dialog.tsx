import { Dialog } from "@base-ui/react/dialog";
import { GitBranch } from "lucide-react";
import { useGitStore, type PullStrategy } from "../../stores/git-store";

const OPTIONS: { strategy: Exclude<PullStrategy, "default">; label: string; detail: string }[] = [
  {
    strategy: "rebase",
    label: "Rebase",
    detail:
      "Replay your commits on top of the remote's. Keeps history linear; if you already pushed them, the next push needs a force-push.",
  },
  {
    strategy: "merge",
    label: "Merge",
    detail: "Join both with a merge commit. Nothing is rewritten.",
  },
];

/**
 * The rebase-or-merge prompt for a branch that diverged from its upstream.
 * Opens only where git itself would refuse: before pulling, when
 * `git_pull_preference` finds no strategy in config (or `pull.ff=only`), and
 * as a fallback when a pull fails with `divergent-branches`. A saved
 * `pull.rebase` is honoured without asking. Either choice runs the pull with
 * an explicit flag — the same choice JetBrains' Update Project asks.
 */
export function PullChoiceDialog({ onChoose }: { onChoose: (strategy: PullStrategy) => void }) {
  const choice = useGitStore.use.pullChoice();
  const ahead = useGitStore.use.ahead();
  const behind = useGitStore.use.behind();
  const actions = useGitStore.use.actions();

  const choose = (strategy: PullStrategy) => {
    actions.dismissPullChoice();
    onChoose(strategy);
  };
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  return (
    <Dialog.Root open={choice !== null} onOpenChange={(o) => !o && actions.dismissPullChoice()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 scrim z-overlay" />
        <Dialog.Popup className="fixed left-1/2 top-[24%] -translate-x-1/2 z-modal w-[440px] max-w-[calc(100vw-32px)] rounded-xl overflow-hidden bg-[var(--card)] border border-border shadow-md flex flex-col">
          {choice && (
            <>
              <div className="px-4 pt-3.5 pb-3 border-b border-border">
                <Dialog.Title className="text-base font-semibold text-foreground flex items-center gap-1.5">
                  <GitBranch size={13} className="text-secondary-foreground shrink-0" />
                  Your branch has diverged
                </Dialog.Title>
                <Dialog.Description className="text-xs text-secondary-foreground mt-1.5">
                  {ahead > 0 && behind > 0
                    ? `You have ${plural(ahead, "commit")} the remote doesn't, and it has ${plural(behind, "commit")} you don't.`
                    : "You and the remote both have commits the other doesn't."}{" "}
                  Choose how to bring them together.
                </Dialog.Description>
              </div>

              <div className="p-2 flex flex-col gap-1">
                {OPTIONS.map((o) => (
                  <button
                    key={o.strategy}
                    onClick={() => choose(o.strategy)}
                    className="text-left px-2.5 py-2 rounded hover:bg-element-hover transition-colors"
                  >
                    <div className="text-xs font-medium text-foreground">{o.label}</div>
                    <div className="text-2xs text-secondary-foreground mt-0.5">{o.detail}</div>
                  </button>
                ))}
              </div>

              {choice.kind === "failed" && choice.error.rawStderr && (
                <details className="border-t border-border bg-[var(--background)] px-3 py-2">
                  <summary className="text-2xs text-muted-foreground cursor-pointer">
                    What git said
                  </summary>
                  <pre className="mt-1.5 max-h-[140px] overflow-y-auto hide-scrollbar font-mono text-2xs leading-[15px] text-secondary-foreground whitespace-pre-wrap break-all">
                    {choice.error.rawStderr}
                  </pre>
                </details>
              )}

              <div className="border-t border-border px-3 py-2.5 flex justify-end">
                <button
                  onClick={() => actions.dismissPullChoice()}
                  className="px-3 h-7 rounded text-xs text-secondary-foreground hover:bg-element-hover transition-colors"
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
