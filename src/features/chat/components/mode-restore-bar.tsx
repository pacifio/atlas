import { ShieldAlert } from "lucide-react";
import { useChatStore } from "../stores/chat-store";
import { modeName } from "../lib/resume-mode";
import { useStripHidden } from "./composer-strip-close";
import { ChatNoticeView } from "./views/chat-notice-view";

/** Asks this tab's composer to open its mode picker (`ComposerGroupsMenu`). */
export const OPEN_MODE_PICKER_EVENT = "atlas:composer-open-mode";

/**
 * A resume could not put this chat in the mode the user picked, so it runs in
 * the agent's own mode (`resume-mode.ts` sets it). Tucked into the composer
 * like the no-grant and removed-agent bars: it explains why the input below
 * cannot send, and the one action that fixes it is right there.
 *
 * It stays until the user picks a mode, any mode, including the one the chat
 * is already in. Sends typed meanwhile are held, not dropped.
 */
export function ModeRestoreBar({ tabId }: { tabId: string }) {
  const wantedId = useChatStore((s) => s.sessions[tabId]?.unrestoredModeId);
  const modes = useChatStore((s) => s.sessions[tabId]?.acpAvailableModes);
  const [hidden, hide] = useStripHidden(wantedId);
  if (!wantedId || hidden) return null;

  return (
    <ChatNoticeView
      placement="tucked"
      tone="warning"
      icon={ShieldAlert}
      data-testid="mode-restore-bar"
      live
      title="The agent would not take this mode on resume, so nothing is sent until you choose one"
      action={{
        label: "Choose mode",
        title: "Open the mode picker",
        onClick: () =>
          window.dispatchEvent(new CustomEvent(OPEN_MODE_PICKER_EVENT, { detail: { tabId } })),
      }}
      onDismiss={hide}
    >
      Couldn't restore{" "}
      <span className="font-semibold text-foreground">{modeName(wantedId, modes ?? [])}</span> ·
      choose a mode to send
    </ChatNoticeView>
  );
}
