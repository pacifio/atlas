import { ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { useChatStore } from "../stores/chat-store";
import { COMPOSER_STRIP, COMPOSER_STRIP_ACTION } from "./composer-strip";

/** Asks this tab's composer to open its mode picker (`ComposerGroupsMenu`). */
export const OPEN_MODE_PICKER_EVENT = "atlas:composer-open-mode";

/**
 * A resume could not put this chat in the mode the user picked, so it runs in
 * the agent's own mode (`resume-mode.ts` sets it). Tucked into the composer
 * like the no-grant and removed-agent bars, because it is about the next
 * prompt: that prompt would run under a mode the user never chose.
 *
 * It stays until the user picks a mode, any mode, including the one the chat
 * is already in. It used to be a toast, which went away by itself and left
 * nothing behind for anyone who had looked away.
 */
export function ModeRestoreBar({ tabId }: { tabId: string }) {
  const wanted = useChatStore((s) => s.sessions[tabId]?.unrestoredMode);
  if (!wanted) return null;

  return (
    <div
      data-testid="mode-restore-bar"
      role="status"
      className={COMPOSER_STRIP}
      title="The agent would not take this mode on resume, so the chat is in the agent's own mode"
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <ShieldAlert size={11} className="shrink-0 text-[var(--atlas-status-warning-foreground)]" />
        <span className="min-w-0 truncate">
          <span className="text-[var(--muted-foreground)]">Couldn't restore </span>
          <span className="font-semibold text-[var(--foreground)]">{wanted}</span>
          <span className="text-[var(--muted-foreground)]"> · check the mode before sending</span>
        </span>
      </span>
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
    </div>
  );
}
