// The mention picker's floating panel: placement against the caret, the
// empty / indexing state, the row list and the key-hint footer. Props-only;
// the container (`mention-picker.tsx`) owns the search and the cursor.

import type { MutableRefObject } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { Kbd } from "@/ui/kbd";
import type { MentionData, MentionKind, PastSessionRef } from "@/features/chat/lib/mentions";
import { emptyStateCopy, type Row } from "../../lib/mention-picker-rows";
import { VirtualizedRows } from "./mention-picker-list";

export function MentionPickerPopover({
  anchor,
  rows,
  activeRowIdx,
  navIndices,
  setActive,
  setScope,
  setPastSession,
  onSelect,
  indexing,
  scope,
  pastSession,
  query,
  projectPath,
}: {
  anchor: { x: number; y: number };
  rows: Row[];
  activeRowIdx: number | undefined;
  navIndices: number[];
  setActive: (n: number) => void;
  setScope: (k: MentionKind) => void;
  setPastSession: (s: PastSessionRef) => void;
  onSelect: MutableRefObject<(m: MentionData) => void>;
  indexing: boolean;
  scope: MentionKind | null;
  pastSession: PastSessionRef | null;
  query: string;
  projectPath: string | null;
}) {
  // Position: prefer below the caret so it doesn't cover lines above
  // the cursor (the common case for mid-page editors like the
  // knowledge note editor). Fall back to above when there isn't
  // enough room below — that's the chat composer's case since it
  // sits flush at the bottom of the viewport.
  //
  // Coords come from `view.coordsAtPos` which is viewport-relative,
  // so `position: fixed` lines up cleanly regardless of sidebars or
  // resizable panels in between.
  const PICKER_WIDTH = 420;
  const PICKER_MAX_HEIGHT = 360;
  const GAP = 6;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.max(8, Math.min(anchor.x, vw - PICKER_WIDTH - 8));
  // anchor.y is the caret's TOP. We need the line's height so the
  // popup sits just under the active line — we don't have it here,
  // so use a sensible default (matches the chat composer's caret).
  const LINE_HEIGHT = 20;
  const caretBottom = anchor.y + LINE_HEIGHT;
  const roomBelow = vh - caretBottom - 8;
  const placeBelow = roomBelow >= PICKER_MAX_HEIGHT;
  const positionStyle: React.CSSProperties = placeBelow
    ? { top: Math.max(8, caretBottom + GAP) }
    : { bottom: Math.max(8, vh - anchor.y + GAP) };

  return createPortal(
    <div
      className={cn(
        "atlas-mention-picker",
        "rounded-lg overflow-hidden",
        // Solid AMOLED panel. Deliberately NOT frosted: backdrop-blur (plus a
        // grain overlay) made the compositor re-blend this layer against the
        // composer beneath it, which glitched against the blinking caret and
        // shifting message layout. Opaque black has no such coupling.
        "bg-popover border border-border",
        "inset-highlight shadow-md",
        "flex flex-col",
      )}
      // Keep mouse interactions from blurring CM:
      onMouseDown={(e) => e.preventDefault()}
      style={{
        position: "fixed",
        left,
        ...positionStyle,
        width: PICKER_WIDTH,
        maxHeight: PICKER_MAX_HEIGHT,
        zIndex: "var(--z-popover)",
      }}
    >
      {rows.length === 0 || (rows.length === 1 && rows[0].type === "header") ? (
        <div className="flex-1 px-3 py-6 text-center text-xs text-muted-foreground leading-snug">
          {indexing && (scope === null || scope === "file" || scope === "folder") ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-muted-foreground animate-pulse" />
              Indexing files…
            </span>
          ) : (
            emptyStateCopy({
              scope,
              pastSession: pastSession !== null,
              query: query.trim(),
              hasProject: projectPath !== null,
            })
          )}
        </div>
      ) : (
        <VirtualizedRows
          rows={rows}
          activeRowIdx={activeRowIdx}
          navIndices={navIndices}
          setActive={setActive}
          setScope={setScope}
          setPastSession={setPastSession}
          onSelect={onSelect}
        />
      )}
      <div className="border-t border-border px-3 h-[34px] flex items-center justify-between shrink-0">
        <span className="flex items-center gap-1.5 text-3xs text-muted-foreground">
          <Kbd>↑↓</Kbd>
          <span>navigate</span>
          <Kbd>↵</Kbd>
          <span>select</span>
        </span>
        <span className="flex items-center gap-1.5 text-3xs text-muted-foreground">
          <Kbd>esc</Kbd>
          <span>close</span>
        </span>
      </div>
    </div>,
    document.body,
  );
}
