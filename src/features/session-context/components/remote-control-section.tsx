// Remote control, in the Details card: where a room is started. One row,
// "Start remote control", off until the session has bound an agent (a room
// needs a live session — `rc_start` looks the id up on the host; a fresh
// chat binds one as soon as its panel mounts, so this is off only for the
// seconds the bind takes, and the hint says why). While a room exists the
// row says what the room is doing; what can be done with it — Take over,
// Copy viewer link, Share, Stop — is the title bar pill's menu
// (`rc-header-menu.tsx`), not repeated here.
//
// The card sits outside the chat panel's tree, so the session is read off
// the chat store by tab, as the other sections read theirs.

import { RadioTower } from "lucide-react";

import { sessionDisplayTitle } from "@/features/chat/lib/session-title";
import { useRemoteControl } from "@/features/chat/lib/use-remote-control";
import { pillLabel } from "@/features/chat/components/rc-status-pill";
import { useChatStore } from "@/features/chat/stores/chat-store";

import { useSessionDetailsStore } from "../stores/session-details-store";
import type { DetailsPresentation } from "./session-details-card";
import { DetailsRow, DetailsSection, RowIcon, RowLabel, RowMeta } from "./details-rows";

export const START_LABEL = "Start remote control";
export const UNBOUND_HINT = "Available once the agent has connected";

export function RemoteControlSection({
  tabId,
  presentation,
}: {
  tabId: string;
  presentation: DetailsPresentation;
}) {
  const acpSessionId = useChatStore((s) => s.sessions[tabId]?.acpSessionId ?? "");
  const title = useChatStore((s) => {
    const session = s.sessions[tabId];
    return session ? sessionDisplayTitle(session.title, session.firstUserContent) : "";
  });
  const remote = useRemoteControl(acpSessionId, title);
  const room = remote.room;

  const start = () => {
    // As a popover the card closes on a pick: the toast that follows says
    // where the room is.
    if (presentation === "popover") {
      const { popoverFor, actions } = useSessionDetailsStore.getState();
      if (popoverFor) actions.setPopover(popoverFor, false);
    }
    remote.start();
  };

  return (
    <DetailsSection label="Remote control">
      {room && room.state !== "ended" ? (
        <DetailsRow>
          <RowIcon icon={RadioTower} />
          <RowLabel>Remote control</RowLabel>
          <RowMeta>
            {pillLabel(remote)}
            {room.state === "live" && room.viewers > 0 && ` · ${room.viewers} watching`}
          </RowMeta>
        </DetailsRow>
      ) : (
        <DetailsRow
          onClick={start}
          disabled={!acpSessionId || remote.busy}
          title={acpSessionId ? undefined : UNBOUND_HINT}
        >
          <RowIcon icon={RadioTower} />
          <RowLabel>{START_LABEL}</RowLabel>
        </DetailsRow>
      )}
    </DetailsSection>
  );
}
