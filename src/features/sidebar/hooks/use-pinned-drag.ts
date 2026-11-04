// Pinned rows reorder by drag (hand-rolled on pointer events): a press that
// travels 4px becomes a drag; the rows between make room; the drop writes one
// fractional key (`pin-order.ts`). Dragging an active row onto the pinned
// block pins it there; dragging a pinned row out unpins it.

import { useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { SidebarSession } from "../lib/sidebar-sessions";
import { reorderPinned, unpinSession, type SidebarListSnapshot } from "../lib/sidebar-actions";
import { useSidebarStore } from "../stores/sidebar-store";
import { CARD_ROW_HEIGHT, type SessionDropVerb } from "../components/session-row";

/** How far a press must travel before it is a drag rather than a click. */
const DRAG_THRESHOLD_PX = 4;

export interface DragState {
  threadId: string;
  from: "pinned" | "active";
  startY: number;
  dy: number;
  /** Past the threshold: the row follows the pointer. */
  active: boolean;
  /** Where in the pinned block a drop would land, or `null` outside it. */
  pinnedIndex: number | null;
}

/** Each pinned row's offset while a pinned row is dragged within the block:
 *  the dragged one follows the pointer, the ones it passes make room. */
export function pinnedOffsets(
  drag: DragState | null,
  pinned: readonly SidebarSession[],
): Map<string, number> {
  const out = new Map<string, number>();
  if (!drag?.active) return out;
  const from = pinned.findIndex((row) => row.threadId === drag.threadId);
  if (drag.from === "pinned") out.set(drag.threadId, drag.dy);
  if (drag.from !== "pinned" || from === -1 || drag.pinnedIndex === null) return out;
  const to = drag.pinnedIndex;
  pinned.forEach((row, i) => {
    if (i === from) return;
    if (from < to && i > from && i <= to) out.set(row.threadId, -CARD_ROW_HEIGHT);
    else if (from > to && i >= to && i < from) out.set(row.threadId, CARD_ROW_HEIGHT);
  });
  return out;
}

export function dropVerbFor(drag: DragState | null): SessionDropVerb | null {
  if (!drag?.active) return null;
  if (drag.from === "pinned") return drag.pinnedIndex === null ? "unpin" : null;
  return drag.pinnedIndex === null ? null : "pin";
}

function commitDrop(session: SidebarSession, state: DragState, list: SidebarListSnapshot) {
  const ids = list.pinned.map((row) => row.threadId);
  if (state.from === "pinned") {
    if (state.pinnedIndex === null) {
      void unpinSession(session);
      return;
    }
    const from = ids.indexOf(session.threadId);
    if (from === -1 || from === state.pinnedIndex) return;
    ids.splice(from, 1);
    ids.splice(state.pinnedIndex, 0, session.threadId);
    void reorderPinned(session.threadId, ids, list);
    return;
  }
  if (state.pinnedIndex === null) return;
  ids.splice(state.pinnedIndex, 0, session.threadId);
  void reorderPinned(session.threadId, ids, list);
}

/** The drag controller. `beginDrag` is stable; it reads the list at call
 *  time through `listRef`. */
export function usePinnedDrag(listRef: RefObject<SidebarListSnapshot>) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const pinnedBlockRef = useRef<HTMLUListElement>(null);
  // The click that follows a drag's pointerup is not an open.
  const suppressClickRef = useRef(false);

  // Window listeners for the life of one press, so a pointer that leaves the
  // row (or the sidebar) still ends the drag.
  const [beginDrag] = useState(
    () => (session: SidebarSession, event: ReactPointerEvent<HTMLElement>) => {
      if (useSidebarStore.getState().search.trim()) return;
      const from = session.pinnedAt !== null ? "pinned" : "active";
      const startY = event.clientY;
      let state: DragState = {
        threadId: session.threadId,
        from,
        startY,
        dy: 0,
        active: false,
        pinnedIndex: null,
      };
      const indexAt = (clientY: number): number | null => {
        const block = pinnedBlockRef.current;
        const count = listRef.current.pinned.length;
        if (!block) return null;
        const rect = block.getBoundingClientRect();
        const slack = CARD_ROW_HEIGHT / 2;
        if (clientY < rect.top - slack || clientY > rect.bottom + slack) return null;
        const max = from === "pinned" ? Math.max(0, count - 1) : count;
        const raw =
          from === "pinned"
            ? Math.floor((clientY - rect.top) / CARD_ROW_HEIGHT)
            : Math.round((clientY - rect.top) / CARD_ROW_HEIGHT);
        return Math.min(Math.max(raw, 0), max);
      };
      const onMove = (ev: PointerEvent) => {
        const dy = ev.clientY - startY;
        if (!state.active && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
        state = { ...state, dy, active: true, pinnedIndex: indexAt(ev.clientY) };
        setDrag(state);
      };
      const finish = (commit: boolean) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey, true);
        setDrag(null);
        if (!state.active) return;
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
        if (commit) commitDrop(session, state, listRef.current);
      };
      const onUp = () => finish(true);
      const onCancel = () => finish(false);
      const onKey = (ev: globalThis.KeyboardEvent) => {
        if (ev.key !== "Escape") return;
        ev.preventDefault();
        ev.stopPropagation();
        finish(false);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey, true);
    },
  );

  return { drag, beginDrag, pinnedBlockRef, suppressClickRef };
}
