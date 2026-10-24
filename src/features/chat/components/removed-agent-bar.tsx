import { ArrowLeftRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { NATIVE_AGENT_ID, pluginIdForAgent } from "@/types/agent";
import { agentMeta, catalogEntry } from "@/features/agents/lib/agent-meta";
import { useAgentRegistryStore } from "@/features/agents/stores/agent-registry-store";
import { useChatStore } from "../stores/chat-store";
import { cycleChatAgent } from "../lib/switch-agent";
import { COMPOSER_STRIP, COMPOSER_STRIP_ACTION } from "./composer-strip";
import { ComposerStripClose, useStripHidden } from "./composer-strip-close";

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
    <div
      data-testid="removed-agent-bar"
      className={COMPOSER_STRIP}
      title="Switch this session to another agent, or reinstall it from Settings → Agents"
    >
      <span className="min-w-0 truncate">
        <span className="font-semibold text-[var(--foreground)]">{agentMeta(agentType).label}</span>
        <span className="text-[var(--muted-foreground)]"> is no longer installed</span>
      </span>
      <span className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={() => cycleChatAgent(tabId)}
          title="Switch this session to another agent"
          className={cn(COMPOSER_STRIP_ACTION, "cursor-pointer")}
        >
          <ArrowLeftRight size={11} />
          Switch agent
        </button>
        <ComposerStripClose onClick={hide} />
      </span>
    </div>
  );
}
