import { useState } from "react";
import { GitBranch } from "lucide-react";
import { toast } from "sonner";
import { switchBranchIfClean } from "@/features/git/lib/git-remote-api";
import { isGitError } from "@/features/git/lib/git-errors";
import { useGitStore } from "@/features/git/stores/git-store";
import { busySessions } from "@/features/projects/lib/stop-agents-confirm";
import { useBranchChangeStore } from "../stores/branch-change-store";
import { ChatNoticeView } from "./views/chat-notice-view";

/**
 * The agent's last turn left the checkout on another branch than the one it
 * started on (`branch-change-watch.ts`). Tucked into the composer like the
 * other strips, because the next message would run on the new branch: it says
 * which branch the session was on, and switches back in one click.
 *
 * The switch refuses where moving the tree would disturb something — the
 * same rules as starting a session on a branch: uncommitted changes, or
 * another agent working in the checkout. It goes away once the branch is
 * restored, when it is closed, or when the next turn starts.
 */
export function BranchChangedBar({ tabId }: { tabId: string }) {
  const change = useBranchChangeStore((s) => s.changes[tabId]);
  const { clear } = useBranchChangeStore.use.actions();
  const [restoring, setRestoring] = useState(false);
  if (!change) return null;

  const restore = async () => {
    const leftAlone = (why: string) =>
      toast(`Still on ${change.now}`, {
        description: `${why}, so Atlas left the checkout alone.`,
      });
    if (busySessions(change.cwd).length > 0) {
      leftAlone("An agent is working in this checkout");
      return;
    }
    setRestoring(true);
    try {
      await switchBranchIfClean(change.cwd, change.was);
      clear(tabId);
      void useGitStore.getState().actions.refreshStatusNow(change.cwd);
    } catch (err) {
      if (isGitError(err) && err.code === "uncommitted-changes") {
        leftAlone(`${change.now} has uncommitted changes`);
      } else {
        toast.error(`Couldn't switch back to ${change.was}`, {
          description: isGitError(err) ? err.message : String(err),
        });
      }
    } finally {
      setRestoring(false);
    }
  };

  return (
    <ChatNoticeView
      placement="tucked"
      icon={GitBranch}
      data-testid="branch-changed-bar"
      live
      title={`The last turn switched this checkout to ${change.now}`}
      action={{ label: "Restore branch", onClick: () => void restore(), disabled: restoring }}
      onDismiss={() => clear(tabId)}
    >
      Branch changed — was <span className="font-mono text-foreground">{change.was}</span>
    </ChatNoticeView>
  );
}
