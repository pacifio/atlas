import type { CSSProperties, ReactNode, RefObject } from "react";

interface ChatPanelLayoutProps {
  rootRef: RefObject<HTMLDivElement | null>;
  conversationRef: RefObject<HTMLDivElement | null>;
  stageRef: RefObject<HTMLDivElement | null>;
  /** The docked Details card's room, from the panel's width; null when the
   *  card is not docked (`use-context-dock.ts`). */
  dock: { inset: number; reserve: number } | null;
  /** First in the conversation column: the `data-dock-open` flag writer and
   *  the title-bar controls portal. Neither renders in place. */
  columnHead: ReactNode;
  /** No messages yet: the stage shows `emptyStage` instead of the transcript. */
  isEmpty: boolean;
  emptyStage: ReactNode;
  transcript: ReactNode;
  /** The docked Details card, an absolute layer over the transcript. */
  dockLane: ReactNode;
  /** The jump pill, the permission card, the question drawer, the composer. */
  composerStack: ReactNode;
  /** Siblings of the conversation column: side panels, overlays. */
  children: ReactNode;
}

/** The session panel's frame: the conversation column (stage over composer)
 *  and whatever sits beside it. Every piece of content is a slot. */
export function ChatPanelLayout({
  rootRef,
  conversationRef,
  stageRef,
  dock,
  columnHead,
  isEmpty,
  emptyStage,
  transcript,
  dockLane,
  composerStack,
  children,
}: ChatPanelLayoutProps) {
  return (
    // Flat, edge to edge. This used to be a rounded card inset 4px on a
    // lighter frame, which put a second panel inside the column's own — the
    // column border already says where the conversation ends.
    <div
      ref={rootRef}
      // `relative` is the positioning context for the bash-history panel,
      // which slides in from the right as an absolute overlay (scrim +
      // panel) instead of a flex column that shrinks the chat.
      className="relative flex h-full min-h-0 overflow-hidden bg-[var(--background)]"
    >
      {/* `data-chat-drop-zone`: Finder drops land anywhere on the conversation
          column, not just the composer (see `attachPaths` in message-input). */}
      <div
        ref={conversationRef}
        data-chat-drop-zone
        className="group/dock relative flex-1 flex flex-col min-w-0"
        // The docked card's room, from the panel's width; the row and the
        // composer stack apply it only while the card is open (`data-dock-open`,
        // set by `DockOpenFlag`).
        style={
          dock
            ? ({
                "--chat-dock-inset": `${dock.inset}px`,
                "--chat-dock-reserve": `${dock.reserve}px`,
              } as CSSProperties)
            : undefined
        }
      >
        {columnHead}
        {isEmpty ? (
          <div ref={stageRef} className="flex-1 overflow-y-auto">
            {emptyStage}
          </div>
        ) : (
          <div ref={stageRef} className="relative flex-1 min-h-0 flex flex-col">
            <div
              data-chat-row
              // The docked card's room, as padding on the row the column is
              // centred in, while the card is open: the column centres in what
              // is left, and once it has to narrow, the left padding keeps the
              // turn rail's gutter. Padding, so the rail — which measures from
              // this row's left edge to the column — still reads the real
              // gutter.
              className="relative flex min-h-0 flex-1 justify-center group-data-[dock-open]/dock:pl-(--chat-dock-inset) group-data-[dock-open]/dock:pr-(--chat-dock-reserve)"
            >
              {/* Capped at the transcript's own column width, so the thread
                    reads as one column centred in whatever space there is. */}
              <div
                data-chat-column
                className="relative flex min-h-0 w-full min-w-0 max-w-(--atlas-chat-column) flex-1 flex-col"
              >
                {transcript}
              </div>
            </div>
            {/* The docked Details card: an absolute layer over the transcript's
                top-right, in room the row above already leaves. */}
            {dockLane}
          </div>
        )}

        <div
          data-chat-composer-stack
          // The docked card's room, reserved the way the row above reserves
          // it (only while the card is open), so the composer stays centred
          // under the column.
          //
          // A MARGIN, not padding: the pill below is `absolute inset-x-0`
          // against this element, and an absolute child is laid out against
          // the padding box, so under padding it would still span the full
          // width. A margin shrinks the box itself, which every child honours.
          className="relative group-data-[dock-open]/dock:ml-(--chat-dock-inset) group-data-[dock-open]/dock:mr-(--chat-dock-reserve)"
        >
          {composerStack}
        </div>
      </div>

      {children}
    </div>
  );
}
