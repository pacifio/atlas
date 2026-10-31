// The chat panel's dock lane: the room at its top-right that the panel keeps
// for the docked Details card while it shows (`context-dock.ts`).
//
// The lane is an absolute layer over the transcript area: it starts a gap
// below the title bar, ends a gap above the composer, and takes no layout
// space itself — the room beside the column is the chat panel's padding,
// kept while the card is open. A card taller than the lane first sheds rows it can do
// without (`details-density.ts`), then scrolls inside itself.
//
// A component of its own so the open flag it reads re-renders this and
// nothing else: the chat panel, and the transcript under it, never hear a
// toggle.

import { lazy, Suspense, useEffect, useRef } from "react";

import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { usePaneTopInset } from "@/features/layout/lib/pane-top-inset";
import {
  selectDockedOpen,
  useSessionDetailsStore,
} from "@/features/session-context/stores/session-details-store";

import { DETAILS_CARD_GAP } from "@/features/session-context/lib/details-density";
import { CONTEXT_CARD_GAP } from "@/features/session-context/lib/context-dock";
import { useElementHeight } from "../lib/use-element-height";

const SessionDetailsCard = lazy(() =>
  import("@/features/session-context/components/session-details-card").then((m) => ({
    default: m.SessionDetailsCard,
  })),
);

export function SessionDockLane({
  tabId,
  scope,
  docked,
}: {
  tabId: string;
  /** The session's scope (`sessionScope`). */
  scope: string;
  /** Whether the panel keeps the room at all; nothing docks without it. */
  docked: boolean;
}) {
  const open = useSessionDetailsStore((s) => docked && selectDockedOpen(s, scope));
  const topInset = usePaneTopInset();
  const laneRef = useRef<HTMLDivElement>(null);
  const laneHeight = useElementHeight(laneRef, open);
  useDetailsEscape(tabId, scope, open);

  if (!docked) return null;
  return (
    <div
      ref={laneRef}
      data-session-dock-lane
      // `pointer-events-none`: the lane is mostly empty air over the
      // transcript's gutter; only the card in it takes the pointer.
      className="pointer-events-none absolute z-panel flex flex-col items-end"
      // Right inset from `CONTEXT_CARD_GAP`, the gap the panel's reservation
      // is computed with, so the card lands where the room was left for it.
      // The top clears the window bar, which floats over the panel.
      style={{
        top: topInset + DETAILS_CARD_GAP,
        bottom: DETAILS_CARD_GAP,
        right: CONTEXT_CARD_GAP,
      }}
    >
      {open && (
        // No entrance: docked, the card is a panel the toggle shows, and the
        // toggle is the feedback. Only the popover form grows from its button.
        <div data-session-details-dock className="pointer-events-auto flex min-h-0 shrink flex-col">
          <Suspense fallback={null}>
            <SessionDetailsCard tabId={tabId} presentation="docked" maxHeight={laneHeight} />
          </Suspense>
        </div>
      )}
    </div>
  );
}

/**
 * Escape closes the docked card, the way it closes the popover form. Only
 * while the key is pressed inside the card, on its title-bar button, or with
 * nothing focused: an Escape in the composer belongs to the composer (its
 * menus, stopping a turn), and a card that stays open across turns must not
 * vanish because the reader dismissed something else.
 */
function useDetailsEscape(tabId: string, scope: string, open: boolean) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Hidden sessions stay mounted; only the one on screen answers.
      if (useLayoutStore.getState().activeTabId !== tabId) return;
      const target = e.target instanceof Element ? e.target : null;
      const inCard = !!target?.closest("[data-session-details-dock]");
      const onToggle = !!target?.closest("[data-session-details-toggle]");
      const unfocused = !target || target === document.body;
      if (!inCard && !onToggle && !unfocused) return;
      e.preventDefault();
      useSessionDetailsStore.getState().actions.close(scope);
      if (inCard) {
        // Focus would otherwise drop to <body> with the card it was in.
        document.querySelector<HTMLElement>("[data-session-details-toggle]")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabId, scope, open]);
}
