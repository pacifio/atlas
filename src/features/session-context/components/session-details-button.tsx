// The title bar's Details button: the first of a session's controls.
//
// Two forms, by whether the chat panel keeps room for the card (`docked`):
// where it does, this is a toggle for the docked card (`aria-pressed`);
// anywhere else it opens the card as a popover under itself, growing out of
// the button. The button itself never animates: no press scale, and hover is
// a colour step only.
//
// While capture is recording it carries a small STEADY dot, never a pulse:
// capture is on for hours, and a light that moves pulls the eye every time it
// does. A fault keeps its own colour: a stopped recorder painted green would
// be a lie.
//
// Each form subscribes to its own slice of the Details store, so a toggle
// re-renders this button and the card, never the chat panel.

import { lazy, Suspense, useEffect, type ReactNode, type RefObject } from "react";
import { Popover } from "@base-ui/react/popover";
import { SquareMenu } from "lucide-react";

import { CaptureDot } from "@/features/capture/components/capture-status";
import { OVERVIEW_CARD_GAP } from "@/features/chat/lib/session-overview-layout";
import { useElementHeight } from "@/features/chat/lib/use-element-height";
import { cn } from "@/lib/utils";
import { HintItem } from "@/ui/hint-group";
import { IconButton } from "@/ui/icon-button";

import { useDetailsProjectPath } from "../lib/details-project-path";
import { useCaptureState, type CaptureState } from "../lib/use-capture-state";
import { useSessionDetailsStore } from "../stores/session-details-store";

const loadCard = () => import("./session-details-card");
const SessionDetailsCard = lazy(() => loadCard().then((m) => ({ default: m.SessionDetailsCard })));

/** The popover's distance below its button. */
const POPOVER_OFFSET = 6;

/** The button's name; the tooltip says the same. */
export const DETAILS_LABEL = "Session details";

/** A click that came from the keyboard (Enter / Space on the button). */
function fromKeyboard(event: Event | undefined | null): boolean {
  return !!event && "detail" in event && (event as MouseEvent).detail === 0;
}

export function SessionDetailsButton({
  tabId,
  scope,
  docked,
  stageRef,
  onOpenSearch,
}: {
  tabId: string;
  /** The session's scope (`sessionScope`). */
  scope: string;
  /** Whether the chat panel keeps room to dock the card. */
  docked: boolean;
  /** The transcript's box: the popover is capped at its height, so it can
   *  never reach the composer below it. */
  stageRef: RefObject<HTMLElement | null>;
  onOpenSearch: () => void;
}) {
  const projectPath = useDetailsProjectPath(tabId);
  const capture = useCaptureState(projectPath);
  const label = capture.recording
    ? `${DETAILS_LABEL} · ${capture.health?.summary ?? "capture is on"}`
    : DETAILS_LABEL;
  return (
    <>
      {docked ? (
        <DockToggle scope={scope} label={label} capture={capture} />
      ) : (
        <DetailsPopover
          tabId={tabId}
          scope={scope}
          label={label}
          capture={capture}
          stageRef={stageRef}
          onOpenSearch={onOpenSearch}
        />
      )}
      <HandOver scope={scope} docked={docked} />
    </>
  );
}

/** Docked: the button shows or hides the card drawn into the panel's room. */
function DockToggle({
  scope,
  label,
  capture,
}: {
  scope: string;
  label: string;
  capture: CaptureState;
}) {
  const open = useSessionDetailsStore((s) => !!s.open[scope]);
  const { toggle } = useSessionDetailsStore.use.actions();
  return (
    <DotFrame capture={capture}>
      <HintItem label={label}>
        <IconButton
          icon={SquareMenu}
          label={DETAILS_LABEL}
          size="sm"
          iconSize="md"
          aria-pressed={open}
          data-session-details-toggle
          onPointerEnter={() => void loadCard()}
          onClick={(e) => toggle(scope, { instant: fromKeyboard(e.nativeEvent) })}
        />
      </HintItem>
    </DotFrame>
  );
}

/** No room to dock: the card is a popover anchored under the button. */
function DetailsPopover({
  tabId,
  scope,
  label,
  capture,
  stageRef,
  onOpenSearch,
}: {
  tabId: string;
  scope: string;
  label: string;
  capture: CaptureState;
  stageRef: RefObject<HTMLElement | null>;
  onOpenSearch: () => void;
}) {
  const open = useSessionDetailsStore((s) => s.popoverFor === scope);
  const instant = useSessionDetailsStore((s) => s.instant);
  const { setPopover } = useSessionDetailsStore.use.actions();
  // Measured only while open: the room under the title bar, down to the
  // composer, less the gap the card keeps from it.
  const stage = useElementHeight(stageRef, open);
  const maxHeight = stage === null ? null : Math.max(0, stage - POPOVER_OFFSET - OVERVIEW_CARD_GAP);
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next, details) => {
        // The Session section's comments and share morphs open in a portal of
        // their own, and so do the card's menus; a press inside one is not a
        // press outside the card.
        if (!next && (details.reason === "outside-press" || details.reason === "focus-out")) {
          const target =
            details.reason === "focus-out"
              ? (details.event as FocusEvent).relatedTarget
              : details.event.target;
          if (target instanceof Element && target.closest("[data-session-details-portal]")) {
            details.cancel();
            return;
          }
        }
        setPopover(scope, next, { instant: fromKeyboard(details.event) });
      }}
    >
      <DotFrame capture={capture}>
        <HintItem label={label}>
          <Popover.Trigger
            data-session-details-toggle
            onPointerEnter={() => void loadCard()}
            render={
              <IconButton
                icon={SquareMenu}
                label={DETAILS_LABEL}
                size="sm"
                iconSize="md"
                aria-pressed={open}
              />
            }
          />
        </HintItem>
      </DotFrame>
      <Popover.Portal>
        <Popover.Positioner
          className="z-popover"
          side="bottom"
          align="end"
          sideOffset={POPOVER_OFFSET}
          collisionPadding={OVERVIEW_CARD_GAP}
        >
          <Popover.Popup
            aria-label={DETAILS_LABEL}
            className={cn(
              "origin-(--transform-origin) outline-none",
              // Grows out of its button (from 0.97 and transparent, 150ms,
              // a strong ease-out); not at all when the keyboard opened it,
              // where the card should be there on the key.
              !instant && "data-open:animate-card-in data-closed:animate-scale-out",
            )}
          >
            <Suspense fallback={null}>
              <SessionDetailsCard
                tabId={tabId}
                onOpenSearch={onOpenSearch}
                presentation="popover"
                maxHeight={maxHeight}
              />
            </Suspense>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** A popover left open when the panel gains room to dock becomes the docked
 *  card, so the card the user opened stays open. */
function HandOver({ scope, docked }: { scope: string; docked: boolean }) {
  useEffect(() => {
    if (docked) useSessionDetailsStore.getState().actions.handOver(scope);
  }, [docked, scope]);
  return null;
}

/** The button's box, with the capture dot over its corner. */
function DotFrame({ capture, children }: { capture: CaptureState; children: ReactNode }) {
  return (
    <span className="relative inline-flex">
      {children}
      {capture.recording && (
        <span
          data-capture-dot
          className="pointer-events-none absolute -top-0.5 -right-0.5"
          aria-hidden
        >
          <CaptureDot tone={capture.tone === "idle" ? "success" : capture.tone} />
        </span>
      )}
    </span>
  );
}
