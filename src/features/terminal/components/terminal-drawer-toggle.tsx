// Kept for later: the session terminal drawer is unmounted (no UI reaches it) until the terminal rework. Not dead code; do not delete.
//
// A button for a session's terminal drawer. Its ⌘⇧J hint went with the
// unregistered shortcut; the rework decides where (and whether) both return.
//
// Self-contained: give it the chat tab, put it in the session's header slot.
// It subscribes to two strings (the tab's session id, and that session's
// drawer flag), so a toggle re-renders this button and the drawer, never the
// chat panel. Hover changes its colour and nothing else; on, it shows the
// pressed fill (`aria-pressed`).

import { SquareTerminal } from "lucide-react";

import { useChatStore } from "@/features/chat/stores/chat-store";
import { sessionScope } from "@/features/chat/lib/session-scope";
import { HintItem } from "@/ui/hint-group";
import { IconButton } from "@/ui/icon-button";

import { toggleSessionDrawer } from "../lib/session-drawer";
import { useSessionDrawerStore } from "../stores/session-drawer-store";

export function TerminalDrawerToggle({ tabId }: { tabId: string }) {
  const acpSessionId = useChatStore((s) => s.sessions[tabId]?.acpSessionId);
  const scope = sessionScope(tabId, acpSessionId);
  const open = useSessionDrawerStore((s) => !!s.open[scope]);
  const label = open ? "Hide terminal" : "Show terminal";
  return (
    <HintItem label={label}>
      <IconButton
        icon={SquareTerminal}
        label={label}
        size="sm"
        iconSize="md"
        aria-pressed={open}
        data-session-terminal-toggle
        onClick={() => toggleSessionDrawer(tabId)}
      />
    </HintItem>
  );
}
