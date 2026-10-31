// The title bar's Details button: the first of a session's controls.
//
// Two forms, by whether the chat panel keeps room for the card (`docked`):
// where it does, this is a toggle for the docked card (`aria-pressed`);
// anywhere else it opens the card as a popover under itself, growing out of
// the button. The button itself never animates: no press scale, and hover is
// a colour step only.
//
// It also answers the card's two shortcuts for the session on screen
// (`details-commands.ts`): ⌘⌥B shows or hides the card in whichever form
// fits, ⌘O opens the session's checkout in the preferred editor.
//
// Each form subscribes to its own slice of the Details store, so a toggle
// re-renders this button and the card, never the chat panel.

import { lazy, Suspense, useEffect, type RefObject } from "react";
import { Popover } from "@base-ui/react/popover";
import { SquareDashedMousePointer } from "lucide-react";

import { useElementHeight } from "@/features/chat/lib/use-element-height";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useExternalEditorStore } from "@/features/external-editor/stores/external-editor-store";
import { resolvePreferredEditor } from "@/features/external-editor/lib/preferred-editor";
import { cn } from "@/lib/utils";
import { HintItem } from "@/ui/hint-group";
import { IconButton } from "@/ui/icon-button";

import {
  OPEN_SESSION_IN_EDITOR_EVENT,
  TOGGLE_SESSION_DETAILS_EVENT,
} from "../lib/details-commands";
import { DETAILS_CARD_GAP } from "../lib/details-density";
import { useDetailsProjectPath } from "../lib/details-project-path";
import { useSessionWorkPath } from "../lib/session-work-path";
import { selectDockedOpen, useSessionDetailsStore } from "../stores/session-details-store";
import { openWithPreference } from "./workspace-section";

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
}: {
  tabId: string;
  /** The session's scope (`sessionScope`). */
  scope: string;
  /** Whether the chat panel keeps room to dock the card. */
  docked: boolean;
  /** The transcript's box: the popover is capped at its height, so it can
   *  never reach the composer below it. */
  stageRef: RefObject<HTMLElement | null>;
}) {
  useDetailsShortcuts(tabId, scope, docked);
  return docked ? (
    <DockToggle scope={scope} />
  ) : (
    <DetailsPopover tabId={tabId} scope={scope} stageRef={stageRef} />
  );
}

/** ⌘⌥B and ⌘O, answered only by the session on screen. */
function useDetailsShortcuts(tabId: string, scope: string, docked: boolean) {
  const projectPath = useDetailsProjectPath(tabId);
  const workPath = useSessionWorkPath(tabId, projectPath) ?? projectPath;
  useEffect(() => {
    const onScreen = () => useLayoutStore.getState().activeTabId === tabId;
    const toggle = () => {
      if (!onScreen()) return;
      const { actions, popoverFor } = useSessionDetailsStore.getState();
      if (docked) actions.toggle(scope, { instant: true });
      else actions.setPopover(scope, popoverFor !== scope, { instant: true });
    };
    const openInEditor = () => {
      if (!onScreen() || !workPath) return;
      const setting = useSettingsStore.getState().settings.preferredEditor;
      const editors = useExternalEditorStore.getState().editors;
      void openWithPreference(resolvePreferredEditor(setting, editors)?.id ?? null, workPath);
    };
    window.addEventListener(TOGGLE_SESSION_DETAILS_EVENT, toggle);
    window.addEventListener(OPEN_SESSION_IN_EDITOR_EVENT, openInEditor);
    return () => {
      window.removeEventListener(TOGGLE_SESSION_DETAILS_EVENT, toggle);
      window.removeEventListener(OPEN_SESSION_IN_EDITOR_EVENT, openInEditor);
    };
  }, [tabId, scope, docked, workPath]);
}

/** Docked: the button shows or hides the card drawn into the panel's room. */
function DockToggle({ scope }: { scope: string }) {
  const open = useSessionDetailsStore((s) => selectDockedOpen(s, scope));
  const { toggle } = useSessionDetailsStore.use.actions();
  return (
    <HintItem label={DETAILS_LABEL}>
      <IconButton
        icon={SquareDashedMousePointer}
        label={DETAILS_LABEL}
        size="sm"
        iconSize="md"
        aria-pressed={open}
        data-session-details-toggle
        onPointerEnter={() => void loadCard()}
        onClick={(e) => toggle(scope, { instant: fromKeyboard(e.nativeEvent) })}
      />
    </HintItem>
  );
}

/** No room to dock: the card is a popover anchored under the button. */
function DetailsPopover({
  tabId,
  scope,
  stageRef,
}: {
  tabId: string;
  scope: string;
  stageRef: RefObject<HTMLElement | null>;
}) {
  const open = useSessionDetailsStore((s) => s.popoverFor === scope);
  const instant = useSessionDetailsStore((s) => s.instant);
  const { setPopover } = useSessionDetailsStore.use.actions();
  // Measured only while open: the room under the title bar, down to the
  // composer, less the gap the card keeps from it.
  const stage = useElementHeight(stageRef, open);
  const maxHeight = stage === null ? null : Math.max(0, stage - POPOVER_OFFSET - DETAILS_CARD_GAP);
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next, details) =>
        setPopover(scope, next, { instant: fromKeyboard(details.event) })
      }
    >
      <HintItem label={DETAILS_LABEL}>
        <Popover.Trigger
          data-session-details-toggle
          onPointerEnter={() => void loadCard()}
          render={
            <IconButton
              icon={SquareDashedMousePointer}
              label={DETAILS_LABEL}
              size="sm"
              iconSize="md"
              aria-pressed={open}
            />
          }
        />
      </HintItem>
      <Popover.Portal>
        <Popover.Positioner
          className="z-popover"
          side="bottom"
          align="end"
          sideOffset={POPOVER_OFFSET}
          collisionPadding={DETAILS_CARD_GAP}
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
              <SessionDetailsCard tabId={tabId} presentation="popover" maxHeight={maxHeight} />
            </Suspense>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
