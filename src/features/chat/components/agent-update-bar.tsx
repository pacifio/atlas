// The update affordance where the agent is being used: above the composer of
// a chat whose agent has a newer version installed-but-not-yet, or an update
// in flight. Settings → Agents has the same button; this is so nobody has to
// go looking for it to find out why a chat is on an old version.
//
// Reads the registry listing (`updateAvailable` is measured against the copy
// on disk) and the live update phase. Renders nothing otherwise — including
// for the native agent, which is versioned with the app.

import { ArrowUpCircle } from "lucide-react";
import { pluginIdForAgent } from "@/types/agent";
import { useChatStore } from "../stores/chat-store";
import { useAgentRegistryStore } from "@/features/agents/stores/agent-registry-store";
import { updateAgent, updatePhaseLabel } from "@/features/agents/lib/agent-update";
import { ChatNoticeView } from "./views/chat-notice-view";

export function AgentUpdateBar({ tabId }: { tabId: string }) {
  const agentType = useChatStore((s) => s.sessions[tabId]?.agentType);
  const pluginId = pluginIdForAgent(agentType);
  const phase = useAgentRegistryStore((s) => s.updatePhases[pluginId]);
  // The listing is read through getState(); the signature is what changes
  // when it does (the store's documented selector trap).
  useAgentRegistryStore((s) => s.signature);
  const entry = useAgentRegistryStore
    .getState()
    .registryEntries.find((e) => e.id === pluginId && e.installed);
  if (!entry || (!phase && !entry.updateAvailable)) return null;

  return (
    <ChatNoticeView
      placement="above"
      data-testid="agent-update-bar"
      progress={phase ? updatePhaseLabel(phase.phase, phase.version) : undefined}
      action={
        phase
          ? undefined
          : {
              label: "Update",
              icon: ArrowUpCircle,
              title: "Waits for any reply in progress to finish, then installs the new version.",
              onClick: () => void updateAgent(entry.id, entry.name, entry.version),
            }
      }
    >
      {phase
        ? `Updating ${entry.name} to v${phase.version}. Your conversation continues on it with your next message.`
        : `${entry.name} v${entry.version} is available${
            entry.installedVersion ? ` — this session runs v${entry.installedVersion}` : ""
          }.`}
    </ChatNoticeView>
  );
}
