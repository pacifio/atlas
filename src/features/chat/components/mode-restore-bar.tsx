import { ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { useChatStore } from "../stores/chat-store";
import { modeName } from "../lib/resume-mode";
import { COMPOSER_STRIP, COMPOSER_STRIP_ACTION } from "./composer-strip";
import { ComposerStripClose, useStripHidden } from "./composer-strip-close";

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
    <div
      data-testid="mode-restore-bar"
      role="status"
      className={COMPOSER_STRIP}
      title="The agent would not take this mode on resume, so nothing is sent until you choose one"
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <ShieldAlert size={11} className="shrink-0 text-warning" />
        <span className="min-w-0 truncate">
          <span className="text-[var(--muted-foreground)]">Couldn't restore </span>
          <span className="font-semibold text-[var(--foreground)]">
            {modeName(wantedId, modes ?? [])}
          </span>
          <span className="text-[var(--muted-foreground)]"> · choose a mode to send</span>
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={() =>
            window.dispatchEvent(new CustomEvent(OPEN_MODE_PICKER_EVENT, { detail: { tabId } }))
          }
          title="Open the mode picker"
          className={cn(COMPOSER_STRIP_ACTION, "cursor-pointer")}
        >
          Choose mode
        </button>
        <ComposerStripClose onClick={hide} />
      </span>
    </div>
  );
}
