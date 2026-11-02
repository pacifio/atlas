// The room's pill in the title bar, and its menu — the session's remote
// control while it has a room: Take over (while someone else drives), Copy
// viewer link, Share with the organisation Atlas targets (a solo room, once),
// Let teammates drive (a shared room), Stop. On a room that has ended,
// Dismiss. Nothing until a room exists: the
// title bar's session group is Details alone, joined by a pill only while
// there is something to say (the pins pill follows the same rule). Starting a
// room is the Details card's (`remote-control-section.tsx`).
//
// Same trigger as the pinned-messages pill, same menu as the surfaces `+`:
// no new treatment, only the room's words in them.

import { Hand, Link as LinkIcon, Square, Users, X } from "lucide-react";

import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { HintItem } from "@/ui/hint-group";

import { driverLabel } from "../lib/rc-api";
import { sessionDisplayTitle } from "../lib/session-title";
import { useRemoteControl } from "../lib/use-remote-control";
import { useChatStore } from "../stores/chat-store";
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
  const ended = room.state === "ended";

  return (
    <DropdownMenu>
      <HintItem label={hintFor(remote)}>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="sm" aria-label="Remote control">
              <RcStatusPill control={remote} />
            </Button>
          }
        />
      </HintItem>
      <DropdownMenuContent align="end" sideOffset={4} className="min-w-48">
        {ended ? (
          <DropdownMenuItem onClick={remote.dismiss}>
            <X size={14} />
            Dismiss
          </DropdownMenuItem>
        ) : (
          <>
            {remote.remoteDriver && (
              <DropdownMenuItem onClick={remote.takeOver} disabled={remote.busy}>
                <Hand size={14} />
                Take over from {driverLabel(remote.remoteDriver)}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={remote.copyLink}>
              <LinkIcon size={14} />
              Copy viewer link
            </DropdownMenuItem>
            {remote.shareWith && (
              // A solo room, with a cloud Organisation in front: share it so
              // that Organisation's people can be invited. Set once — the
              // item goes away when the room has a scope.
              <DropdownMenuItem onClick={remote.share} disabled={remote.busy}>
                <Users size={14} />
                Share with {remote.shareWith.name}
              </DropdownMenuItem>
            )}
            {room.scope && (
              // A shared room: whether the invited teammates may prompt and
              // ask for the seat, or only watch. Answering permission prompts
              // stays the owner's either way.
              <DropdownMenuCheckboxItem
                checked={remote.membersDrive}
                onCheckedChange={remote.setMembersDrive}
                disabled={remote.busy}
              >
                Let teammates drive
              </DropdownMenuCheckboxItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={remote.stop} disabled={remote.busy}>
              <Square size={14} />
              Stop remote control
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
