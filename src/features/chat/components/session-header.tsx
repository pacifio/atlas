// A session's controls, in the window's title bar.
//
// The session's name is in the title bar already, as the breadcrumb's last
// segment, so nothing here repeats it. There used to be a second header row
// inside the session; the title bar has its own sidebar toggle, a new session
// is ⌘N or the sidebar's button, and the rest moved up here. The row's height
// went back to the transcript.
//
// The header's right end reads, in order: these controls, the column's own,
// and the window group's panel toggle when the column is the rightmost
// (`TopbarTrailing`). Here:
//
//  - the remote-control pill, only while the session has a room: its state,
//    and the room's menu (`rc-header-menu.tsx`). A room is started from the
//    Details card;
//  - the pinned-messages pill, only while something is pinned;
//  - Details: the session's card, docked where the chat panel keeps room at
//    its top-right, a popover under the button anywhere else
//    (`session-details-button.tsx`). Its Activity section opens the Bash
//    calls and Plans panels.
//
// Rendered by `ChatPanel`, which owns all of that state, and portalled into
// the column header's slot (`session-header-slot-store.ts`).

import { memo, type RefObject } from "react";

import { SessionDetailsButton } from "@/features/session-context/components/session-details-button";

import type { ChatPin } from "../stores/chat-pins-store";
import { ChatPinnedMenu } from "./chat-pinned-menu";
import { RcHeaderMenu } from "./rc-header-menu";

interface SessionHeaderControlsProps {
  tabId: string;
  /** The session's scope (`sessionScope`). */
  scope: string;
  /** Whether the chat panel has room to dock the Details card. */
  docked: boolean;
  /** The transcript's box: the Details popover is capped at its height, so
   *  it can never reach the composer below it. */
  stageRef: RefObject<HTMLElement | null>;
  /** Pin scope for this session (see `chat-pins-store`). */
  pinScopeKey: string;
  onJumpToPin: (pin: ChatPin) => void;
}

// memo: rendered by ChatPanel once per streaming rAF flush; every prop is
// identity-stable there (strings/booleans/refs + the *Stable useCallback
// wrappers), so this bails per frame and re-renders only on real changes.
export const SessionHeaderControls = memo(function SessionHeaderControls({
  tabId,
  scope,
  docked,
  stageRef,
  pinScopeKey,
  onJumpToPin,
}: SessionHeaderControlsProps) {
  return (
    <div data-session-controls className="flex shrink-0 items-center gap-0.5">
      <RcHeaderMenu tabId={tabId} />
      <ChatPinnedMenu pinScopeKey={pinScopeKey} onJump={onJumpToPin} />
      <SessionDetailsButton tabId={tabId} scope={scope} docked={docked} stageRef={stageRef} />
    </div>
  );
});
