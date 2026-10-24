// The hover footer under an agent response: copy, branch, pin, and the
// timestamp.
//
// The same footer the prompt wears (`user-row-actions.tsx`), with the same
// three constraints and the same reveal: absolutely positioned into a gap the
// row reserves (`pb-7` on the prose column, only once the row has settled), no
// subscription to the chat store, and a snap rather than a fade. Read the
// notes there before changing anything here. Which action sits where is
// decided by `lib/message-footer.ts`; a response has no rare actions, so it
// has no "…" menu.
//
// Left-aligned rather than right: a response starts at the column's left
// edge and the footer belongs under it, where the reader's eye is when the
// answer ends. Mirrored from the prompt's, so the timestamp is last here.
//
// A turn's last response does not draw its own: when the turn ends on a
// changed-files card (or a "files read" line), the footer comes after that,
// at the end of the whole response, drawn by `TurnFooterRowView` from the
// same props (`ProseRow.footerBelow` in `turn-rows.ts`).

import { useCallback, useMemo } from "react";
import { GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";
import { HintGroup } from "@/ui/hint-group";
import { forkSessionToNewTab } from "../lib/fork-session";
import { responseFooterActions } from "../lib/message-footer";
import { useChatPinsStore } from "../stores/chat-pins-store";
import { useRowHasComments } from "./chat-comment-pills";
import {
  ActionButton,
  CommentAndCopy,
  FOOTER_REVEAL,
  MessageTimestamp,
  PinToggle,
} from "./user-row-actions";

export function ProseRowActions({
  tabId,
  messageId,
  timestamp,
  text,
  pinScopeKey,
  canBranch,
  showTimestamp,
  className,
}: {
  tabId: string;
  /** `ChatMessage.id` — the row id is `p:<messageId>`. */
  messageId: string;
  timestamp: string;
  /** The prose as shown (`row.text`): the markdown source, which is what copy
   *  hands over and half of the pin's durable key. */
  text: string;
  pinScopeKey: string;
  /** Resolved by the transcript: this is the session's latest settled
   *  response and the agent can fork. A plain boolean so the row memo holds. */
  canBranch: boolean;
  /** False when the row's header line already shows the time — one response
   *  does not need two clocks. */
  showTimestamp: boolean;
  /** Placement override for a host that reserves its gap elsewhere (the turn
   *  footer row puts the footer above its own bottom padding). */
  className?: string;
}) {
  const pinned = useChatPinsStore((s) =>
    (s.pins[pinScopeKey] ?? []).some((p) => p.messageId === messageId),
  );
  const discussed = useRowHasComments(tabId, messageId);

  const onPin = useCallback(() => {
    useChatPinsStore.getState().actions.toggle(pinScopeKey, {
      messageId,
      timestamp,
      text,
      at: new Date().toISOString(),
      role: "assistant",
    });
  }, [pinScopeKey, messageId, timestamp, text]);

  // The same fork the header's menu and `/fork` run: the session as it
  // stands, opened in a new tab. Offered only on the latest response, where
  // "as it stands" and "from here" are the same thing.
  const onBranch = useCallback(() => forkSessionToNewTab(tabId), [tabId]);

  const actions = useMemo(() => responseFooterActions({ canBranch }), [canBranch]);

  return (
    <HintGroup>
      <div
        className={cn(
          // Into the column's reserved `pb-7`: 4px of air, then the 24px
          // buttons, the first square's edge on the prose's left edge.
          "absolute bottom-0 left-6 z-popover flex w-max items-center gap-2 pt-1",
          discussed ? "visible" : FOOTER_REVEAL,
          className,
        )}
        data-response-footer
      >
        <div className="flex items-center gap-0.5">
          {actions.inline.map((action) =>
            action === "branch" ? (
              <ActionButton key={action} label="Branch from here" onClick={onBranch}>
                <GitBranch size={12} />
              </ActionButton>
            ) : action === "pin" ? (
              <PinToggle key={action} label="Pin response" pinned={pinned} onToggle={onPin} />
            ) : (
              <CommentAndCopy
                key={action}
                tabId={tabId}
                messageId={messageId}
                text={text}
                label="Copy response"
              />
            ),
          )}
        </div>
        {showTimestamp && <MessageTimestamp timestamp={timestamp} />}
      </div>
    </HintGroup>
  );
}
