import { ArrowLeftRight } from "lucide-react";
import { NATIVE_AGENT_ID, pluginIdForAgent } from "@/types/agent";
import { agentMeta, catalogEntry } from "@/features/agents/lib/agent-meta";
import { useAgentRegistryStore } from "@/features/agents/stores/agent-registry-store";
import { useChatStore } from "../stores/chat-store";
import { cycleChatAgent } from "../lib/switch-agent";
import { useStripHidden } from "./composer-strip-close";
import { ChatNoticeView } from "./views/chat-notice-view";

/**
 * The tab's agent was uninstalled. Tucked into the top of the composer like
 * the no-grant bar: it explains why the input below cannot send, and the one
 * action that fixes it — switching agents — is right there.
 *
 * `removed-agents.ts` is what flags the tab; this only renders it. Shown only
 * while the agent is still absent: reinstalling it hides the bar without the
 * user doing anything here.
 */
export function RemovedAgentBar({ tabId }: { tabId: string }) {
  const disconnected = useChatStore((s) => !!s.sessions[tabId]?.disconnected);
  const agentType = useChatStore((s) => s.sessions[tabId]?.agentType);
  // Re-render on install/uninstall so a reinstall clears the bar.
  useAgentRegistryStore((s) => s.signature);
  const [hidden, hide] = useStripHidden(agentType);
  if (!disconnected || hidden) return null;
  // By plugin id, not `meta.external`: a `claude*` registry agent wears
  // first-party branding while still being uninstallable.
  const pluginId = pluginIdForAgent(agentType);
  const removed =
    pluginId !== pluginIdForAgent(NATIVE_AGENT_ID) &&
    useAgentRegistryStore.getState().catalog.length > 0 &&
    !catalogEntry(pluginId)?.installed;
  if (!removed) return null;

  return (
    <ChatNoticeView
      placement="tucked"
      data-testid="removed-agent-bar"
      title="Switch this session to another agent, or reinstall it from Settings → Agents"
      action={{
        label: "Switch agent",
        icon: ArrowLeftRight,
        title: "Switch this session to another agent",
        onClick: () => cycleChatAgent(tabId),
      }}
      onDismiss={hide}
    >
      <span className="font-semibold text-foreground">{agentMeta(agentType).label}</span> is no
      longer installed
    </ChatNoticeView>
  );
}
