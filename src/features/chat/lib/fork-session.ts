import { toast } from "sonner";

import { agents } from "./agents-api";
import { errInfo } from "./agent-signin";
import { openAgentSession } from "./open-agent-session";
import { workspacePathForTab } from "./tab-workspace";
import { useChatStore } from "../stores/chat-store";
import { useProjectStore } from "@/features/project/stores/project-store";

/**
 * Fork the tab's bound session and open the branch in a new tab, so the
 * thread that got here stays intact — which is the entire point of forking.
 *
 * One implementation for both ways in: the chat header's "branch from here"
 * menu item and the composer's `/fork` command.
 */
export function forkSessionToNewTab(tabId: string): void {
  void (async () => {
    const sess = useChatStore.getState().sessions[tabId];
    if (!sess?.acpAgentId || !sess.acpSessionId) return;
    try {
      const forked = await agents.forkSession({
        agent_id: sess.acpAgentId,
        session_id: sess.acpSessionId,
      });
      if (!forked) {
        toast.error("This agent cannot branch a session.");
        return;
      }
      await openAgentSession({
        acpSessionId: forked,
        title: `${sess.title ?? "Session"} (branch)`,
        // A branch belongs to the SOURCE session's project, not to whichever
        // workspace happens to be active when the fork is triggered.
        cwd:
          sess.workingDirectory ||
          workspacePathForTab(tabId) ||
          useProjectStore.getState().currentProject?.path ||
          "",
        agentType: sess.agentType,
      });
    } catch (err) {
      toast.error(errInfo(err).message);
    }
  })();
}
