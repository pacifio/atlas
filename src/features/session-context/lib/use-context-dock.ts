// The room a chat panel keeps at its top-right for the docked Details card.
//
// `useContextDock` measures the panel and answers the room to reserve
// (`resolveContextDock`, from the width alone) and whether it docks at all.
// It reports `dockable` to the Details store, so `openSessionDetails` (the
// palette, ⌘⌥C) can pick the docked card or the popover from outside the
// panel. The card itself is drawn into that room by the chat panel's dock
// lane (`session-dock-lane.tsx`), an absolute layer: opening or closing it
// changes nothing the transcript or the composer is laid out from, so
// neither moves.

import { useEffect, useState, type RefObject } from "react";

import { useSessionDetailsStore } from "../stores/session-details-store";
import { parseColumnMax, resolveContextDock, type ContextDock } from "./context-dock";

const NO_DOCK: ContextDock = { docked: false, reserve: 0, inset: 0 };

/**
 * The dock for the chat panel whose conversation column is `ref`. `enabled`
 * is false where there is no column to clear (an empty session): the card is
 * the popover then, and nothing is reserved for it.
 */
export function useContextDock(
  tabId: string,
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
): ContextDock {
  const [dock, setDock] = useState<ContextDock>(NO_DOCK);

  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el || typeof ResizeObserver === "undefined") {
      setDock(NO_DOCK);
      return;
    }
    const measure = () => {
      const columnMax = parseColumnMax(
        getComputedStyle(el).getPropertyValue("--atlas-chat-column"),
      );
      const next = resolveContextDock(el.clientWidth, columnMax);
      setDock((prev) =>
        prev.docked === next.docked && prev.reserve === next.reserve && prev.inset === next.inset
          ? prev
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, enabled]);

  useEffect(() => {
    useSessionDetailsStore.getState().actions.setDockable(tabId, dock.docked);
  }, [tabId, dock.docked]);
  // A closed tab leaves no dockable flag behind.
  useEffect(() => {
    return () => useSessionDetailsStore.getState().actions.setDockable(tabId, false);
  }, [tabId]);

  return dock;
}
