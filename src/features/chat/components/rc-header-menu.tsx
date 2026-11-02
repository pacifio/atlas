// The room's pill in the title bar, and the panel it opens — the session's
// remote control while it has a room: who drives, who is here, requests to
// drive, invites, the link and Stop (`rc-room-panel.tsx`); Dismiss once the
// room has ended. Nothing until a room exists: the title bar's session group
// is Details alone, joined by a pill only while there is something to say
// (the pins pill follows the same rule). Starting a room is the Details
// card's (`remote-control-section.tsx`).
//
// Same trigger as the pinned-messages pill. The panel is a popover rather
// than a menu: it holds a roster, a picker and switches, which a menu's
// keyboard model would fight.

import { Popover } from "@base-ui/react/popover";

import { Button } from "@/ui/button";
import { HintItem } from "@/ui/hint-group";

import { sessionDisplayTitle } from "../lib/session-title";
import { useRemoteControl } from "../lib/use-remote-control";
import { useChatStore } from "../stores/chat-store";
import { RcRoomPanel } from "./rc-room-panel";
import { hintFor, RcStatusPill } from "./rc-status-pill";

export function RcHeaderMenu({ tabId }: { tabId: string }) {
  // Read by tab: the controls are portalled out of the chat panel's tree, and
  // the id binds seconds after the tab opens.
  const acpSessionId = useChatStore((s) => s.sessions[tabId]?.acpSessionId ?? "");
  const title = useChatStore((s) => {
    const session = s.sessions[tabId];
    return session ? sessionDisplayTitle(session.title, session.firstUserContent) : "";
  });
  const remote = useRemoteControl(acpSessionId, title);
  const room = remote.room;
  if (!room) return null;

  return (
    <Popover.Root>
      <HintItem label={hintFor(remote)}>
        <Popover.Trigger
          render={
            <Button variant="ghost" size="sm" aria-label="Remote control">
              <RcStatusPill control={remote} />
            </Button>
          }
        />
      </HintItem>
      <Popover.Portal>
        <Popover.Positioner className="z-popover" side="bottom" align="end" sideOffset={6}>
          {/* The page's own appearance: the background as ground, its cards
              on the raised popover grey — the session reader's filter menu. */}
          <Popover.Popup
            aria-label="Remote control"
            className="origin-[var(--transform-origin)] overflow-hidden rounded-2xl border border-border bg-background text-foreground shadow-lg data-closed:animate-scale-out data-open:animate-scale-in"
          >
            <RcRoomPanel sessionId={acpSessionId} remote={remote} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
