/**
 * The thread list for a live chat: the Timeline's comments panel, docked to
 * the right of the conversation. Unlike the Bash and Plans overlays it takes
 * layout space — the transcript reflows narrower beside it.
 *
 * Navigation goes through the transcript's own jump (`atlas:chat-jump`),
 * addressed by message index as every other jump is, plus the row ids to
 * highlight once it lands. A tool-call thread inside a folded "Worked" section
 * lands on the header when the row is not in the DOM.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";

import { useLayoutStore } from "@/features/layout/stores/layout-store";
import {
  CommentsPanelBase,
  type PanelAnchor,
} from "@/features/artifacts/components/session-comments-panel";
import type { RowComments } from "@/features/artifacts/components/session-detail";

import { useChatCommentsStore } from "../stores/chat-comments-store";
import { useChatStore } from "../stores/chat-store";

export interface ChatJumpDetail {
  index: number;
  /** Rows to highlight on arrival, first one found wins. */
  highlightRowIds?: string[];
}

export function ChatCommentsPanel({ tabId, onClose }: { tabId: string; onClose: () => void }) {
  const tab = useChatCommentsStore((s) => s.byTab[tabId]);
  const bashPanel = useLayoutStore.use.bashPanel();
  const { setBashPanelWidth } = useLayoutStore.use.actions();

  // Focus. The panel is docked, not modal: the composer and transcript stay
  // usable beside it, so keys typed there are theirs. Escape therefore closes
  // the panel only when focus is IN it — a window-wide listener here also
  // fired on the composer's Escape (closing a slash picker), on a permission
  // card's Escape (cancel), and in every hidden chat tab that had the panel
  // open. Opening moves focus into the panel, so Escape closes it straight
  // away; closing hands focus back to whatever opened it (the header button)
  // when the panel was holding it, instead of dropping it on <body>.
  const rootRef = useRef<HTMLDivElement>(null);
  const ready = tab?.actions != null && tab.directory != null;
  useEffect(() => {
    if (!ready) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = rootRef.current;
    root?.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      const lost = !active || active === document.body || (root?.contains(active) ?? false);
      if (lost && opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [ready]);
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // A control inside that consumed its own Escape (a menu closing, the
      // search box clearing) has said so with `preventDefault`.
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      onClose();
    },
    [onClose],
  );

  const resizeStartXRef = useRef<number | null>(null);
  const resizeStartWidthRef = useRef<number>(0);
  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      resizeStartXRef.current = e.clientX;
      // From the width ON SCREEN, not the stored one: the half-pane cap can
      // hold the panel narrower than the store says, and starting from the
      // stored width made the first stretch of a drag do nothing.
      resizeStartWidthRef.current = rootRef.current?.offsetWidth ?? bashPanel.width;
      const onMove = (ev: MouseEvent) => {
        if (resizeStartXRef.current === null) return;
        setBashPanelWidth(resizeStartWidthRef.current + (resizeStartXRef.current - ev.clientX));
      };
      const onUp = () => {
        resizeStartXRef.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [bashPanel.width, setBashPanelWidth],
  );

  const anchors = useMemo<PanelAnchor[]>(
    () =>
      (tab?.anchors.ordered ?? []).map((a) => ({ id: a.id, kind: a.kind, toolName: a.toolName })),
    [tab?.anchors],
  );
  const comments = useMemo<RowComments | null>(
    () =>
      tab?.actions && tab.directory
        ? {
            byAnchor: tab.byAnchor,
            session: tab.session,
            actions: tab.actions,
            directory: tab.directory,
          }
        : null,
    [tab?.byAnchor, tab?.session, tab?.actions, tab?.directory],
  );

  const onJump = useCallback(
    (anchorId: string) => {
      const state = useChatCommentsStore.getState().byTab[tabId];
      const chatKey = state?.anchors.chatKeyByRowId.get(anchorId);
      if (!chatKey) return;
      const messages = useChatStore.getState().sessions[tabId]?.messages ?? [];
      // The message this key is, or the one holding the tool call.
      let index = messages.findIndex((m) => m.id === chatKey);
      let rowId: string;
      if (index >= 0) {
        const m = messages[index];
        rowId =
          m.role === "user" ? `u:${m.id}` : m.mode === "thinking" ? `th:${m.id}` : `p:${m.id}`;
      } else {
        index = messages.findIndex((m) => m.toolCalls.some((tc) => tc.id === chatKey));
        if (index < 0) return;
        rowId = `mk:${chatKey}`;
      }
      // Jumps address a TURN by its first message; an assistant run is one
      // turn, so walk back to where the run starts.
      let start = index;
      if (messages[index].role !== "user") {
        while (start > 0 && messages[start - 1].role !== "user") start -= 1;
      }
      const turnId = `t:${messages[start].id}`;
      window.dispatchEvent(
        new CustomEvent<ChatJumpDetail>("atlas:chat-jump", {
          detail: { index: start, highlightRowIds: [rowId, `wk:${turnId}`] },
        }),
      );
    },
    [tabId],
  );

  if (!comments) return null;

  // A flex column beside the conversation, not an overlay: comments are read
  // AGAINST the transcript (and a jump lands in it), so covering the right
  // edge of the very messages being discussed defeated the panel. Capped at
  // half the pane so a wide saved width on a narrow window still leaves the
  // conversation — and its composer — usable.
  return (
    <div
      ref={rootRef}
      role="complementary"
      aria-label="Comments"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={{ width: bashPanel.width }}
      className="relative h-full max-w-[50%] shrink-0 flex flex-col border-l border-[var(--border)] bg-[var(--sidebar)] outline-none animate-slide-in-right"
    >
      <div
        onMouseDown={onResizeStart}
        className="absolute left-0 top-0 bottom-0 z-10 w-1 cursor-col-resize hover:bg-[var(--atlas-border-strong)]"
        aria-hidden
      />
      <CommentsPanelBase anchors={anchors} comments={comments} onJump={onJump} onClose={onClose} />
    </div>
  );
}
