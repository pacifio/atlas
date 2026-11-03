// Opening what the agent cited, in THIS app: a Timeline session, a chat
// conversation (landing on the message), a Space, another conversation with
// the agent, the Loops. An Atlas route with no desktop page (a project page,
// a Shared Thread, an RC room) opens on the web app.
//
// Cross-feature on purpose, at an action boundary: each store is reached with
// `getState()`, and chat's jump to a message is asked for with a window event
// that the open conversation takes (`comms-conversation.tsx`).

import { useArtifactsStore } from "@/features/artifacts/stores/artifacts-store";
import { useCommsStore } from "@/features/comms/stores/comms-store";
import { revealTeamChat } from "@/features/layout/lib/team-chat";
import { agentPageShown, revealAgentPage, revealAgentPanel } from "@/features/layout/lib/org-agent";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { openSpaceOnPage, openSpaceTab } from "@/features/spaces/lib/open-space";

import { useOrgAgentStore } from "../stores/org-agent-store";
import { isAtlasRoute, type OrgAgentTarget } from "./org-agent-links";

/** Chat's "jump to this message" request. */
export const COMMS_JUMP_EVENT = "atlas:comms-jump-to-message";

export interface CommsJumpDetail {
  convId: string;
  messageId: string;
}

const WEB_ORIGIN = "https://app.tryatlas.cc";

function conversationName(convId: string): string {
  const c = useCommsStore.getState().conversations.find((x) => x.id === convId);
  return c?.name ? `#${c.name}` : "Conversation";
}

export function openTarget(target: OrgAgentTarget): void {
  const layout = useLayoutStore.getState();
  switch (target.kind) {
    case "session": {
      useArtifactsStore.getState().actions.openSession({
        sessionId: target.sessionId,
        // A teammate's run may never have existed on this machine: read from
        // the server, by its Workspace.
        projectPath: "",
        remoteProjectId: target.workspaceId,
        ...(target.commitSha ? { commitSha: target.commitSha } : {}),
      });
      layout.actions.addTab({
        id: "artifacts",
        type: "artifacts",
        title: "Timeline",
        closable: true,
        dirty: false,
        data: {},
      });
      return;
    }
    case "conversation": {
      const comms = useCommsStore.getState();
      comms.actions.openConversation(target.convId);
      revealTeamChat();
      if (target.messageId) {
        const detail: CommsJumpDetail = { convId: target.convId, messageId: target.messageId };
        // After the conversation has mounted and read its newest page.
        setTimeout(() => window.dispatchEvent(new CustomEvent(COMMS_JUMP_EVENT, { detail })), 350);
      }
      return;
    }
    case "space": {
      const title = conversationName(target.convId);
      if (target.pageId) openSpaceOnPage(target.convId, title, target.pageId);
      else openSpaceTab(target.convId, title);
      return;
    }
    case "ask": {
      const agent = useOrgAgentStore.getState().actions;
      if (agentPageShown(useLayoutStore.getState())) {
        agent.openOnPage(target.askId);
      } else {
        agent.activate(target.askId);
        revealAgentPanel();
      }
      void useOrgAgentStore.getState().actions.openAsk(target.askId);
      return;
    }
    case "loops": {
      useOrgAgentStore.getState().actions.setPageView("loops");
      revealAgentPage();
      return;
    }
    case "web": {
      if (!isAtlasRoute(target.route)) return;
      void import("@tauri-apps/plugin-opener")
        .then((m) => m.openUrl(`${WEB_ORIGIN}${target.route}`))
        .catch(() => {});
      return;
    }
  }
}
