import { memo, useState } from "react";
import { pluginIdForAgent, NATIVE_AGENT_ID } from "@/types/agent";
import type { ImageAttachment } from "@/types/agents";
import { agentMeta, catalogEntry as agentCatalogEntry } from "@/features/agents/lib/agent-meta";
import { useAgentRegistryStore } from "@/features/agents/stores/agent-registry-store";
import { useChatStore } from "../stores/chat-store";
import { rebindDisconnectedSession } from "../lib/agent-rebind";
import type { MentionData } from "../lib/mentions";
import { CONTENT_COLUMN } from "../lib/row-metrics";
import { MessageInput } from "./message-input";
import { AgentUpdateBar } from "./agent-update-bar";
import { DisconnectedBannerView } from "./views/disconnected-banner-view";

/** Shown when the session's agent process died: one explicit affordance to
 *  respawn + resume. Sending a message does the same thing implicitly.
 *
 *  An agent that was UNINSTALLED is the one case a restart cannot fix. That
 *  state is not this banner's: `RemovedAgentBar` (tucked into the composer,
 *  rendered from `message-input.tsx`) takes it, and offers a switch. */
function DisconnectedBanner({ tabId }: { tabId: string }) {
  const disconnected = useChatStore((s) => !!s.sessions[tabId]?.disconnected);
  const bindError = useChatStore((s) => s.sessions[tabId]?.bindError);
  const updatedTo = useChatStore((s) => s.sessions[tabId]?.updatedTo);
  const agentType = useChatStore((s) => s.sessions[tabId]?.agentType);
  // Re-render on install/uninstall: reinstalling the agent turns this back
  // into an ordinary restart.
  useAgentRegistryStore((s) => s.signature);
  const [restarting, setRestarting] = useState(false);
  if (!disconnected) return null;
  // By plugin id, not `meta.external`: a `claude*` registry agent wears
  // first-party branding (`external: false`) while still being uninstallable.
  const pluginId = pluginIdForAgent(agentType);
  const removed =
    pluginId !== pluginIdForAgent(NATIVE_AGENT_ID) &&
    useAgentRegistryStore.getState().catalog.length > 0 &&
    !agentCatalogEntry(pluginId)?.installed;
  if (removed) return null;
  return (
    <DisconnectedBannerView
      bindError={bindError}
      updatedTo={updatedTo}
      agentLabel={agentMeta(agentType).label}
      restarting={restarting}
      onRestart={async () => {
        setRestarting(true);
        try {
          await rebindDisconnectedSession(tabId);
        } finally {
          setRestarting(false);
        }
      }}
    />
  );
}

/**
 * Composer wrapper: the login dialog + the real `MessageInput`.
 *
 * It no longer gates on anything. Two agent-specific surfaces used to live
 * here: a Claude setup banner that hard-disabled the input until Claude Code
 * was installed and authed, and a Codex sign-in pill driven by a probe of
 * `~/.codex/auth.json`. Both are gone (ADR-0002). A composer disabled by one
 * agent's readiness was a trap, because the agent switcher lives INSIDE it —
 * the user could not switch to an agent that WAS ready. Failures now arrive as
 * `atlas:auth-required` and route through `canSignIn`, which asks the catalog
 * whether an agent has a sign-in, never which agent it is.
 */
// Memoized: with the parent passing stable callbacks + value props, this heavy
// subtree (input, mode/agent pickers, attach menu) skips re-render on every
// streaming chunk. Its own store subscriptions (drafts/modes) still update it.
export const ChatComposer = memo(function ChatComposer({
  tabId,
  onSend,
  onStop,
  running,
  stopping,
}: {
  tabId: string;
  onSend: (message: string, mentions: MentionData[], attachments?: ImageAttachment[]) => void;
  onStop: () => void;
  running: boolean;
  stopping: boolean;
}) {
  // OpenCode / Cursor / Kilo auth used to raise a "copy `cursor-agent login`"
  // pill here. It is gone: `atlas:auth-required` now routes ONLY to the
  // AgentLoginDialog (see message-input.tsx), which runs the login for the
  // user instead of asking them to run it themselves. The pill also gave
  // advice that was wrong on the machines that needed it most — when Atlas
  // downloaded the CLI into its app-data dir, there was no such command on the
  // user's PATH to run. The dialog's error phase now shows the real absolute
  // path as a manual fallback.

  return (
    <>
      <div className="relative">
        {/* The composer's own frame, so a banner lines up with the input. */}
        <div className={CONTENT_COLUMN}>
          <AgentUpdateBar tabId={tabId} />
          <DisconnectedBanner tabId={tabId} />
        </div>
        <MessageInput
          tabId={tabId}
          onSend={onSend}
          onStop={onStop}
          running={running}
          stopping={stopping}
          placeholder="Ask Atlas what to do ..."
        />
      </div>
    </>
  );
});
