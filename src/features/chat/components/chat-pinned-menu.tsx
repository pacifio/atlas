import { pinsFor, useChatPinsStore, type ChatPin } from "../stores/chat-pins-store";
import { ChatPinnedMenuView } from "./views/chat-pinned-menu-view";

/** The session's pins from the local pins store, as the title-bar dropdown
 *  (`ChatPinnedMenuView` says what it shows and why). */
export function ChatPinnedMenu({
  pinScopeKey,
  onJump,
}: {
  pinScopeKey: string;
  onJump: (pin: ChatPin) => void;
}) {
  const pins = useChatPinsStore((s) => pinsFor(s, pinScopeKey));
  return (
    <ChatPinnedMenuView
      pins={pins}
      onJump={onJump}
      onUnpin={(id) => useChatPinsStore.getState().actions.unpin(pinScopeKey, id)}
    />
  );
}
