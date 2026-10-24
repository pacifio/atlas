// The window group's panel toggle: shows or hides the surfaces pane, the
// right panel.
//
// Always present while a project is open, at a fixed place beside the
// account, and pressed (`aria-pressed`) while the pane is on screen. It is the
// pane's one show/hide control: the pane's own strip keeps only Maximize
// (`PanelPlacementControls`), and nothing else hides it.
//
// Subscribes to one boolean, so it re-renders when the pane does and
// for nothing else. No motion: hover is a colour step, and the pane appearing
// is the feedback.

import { PanelRight } from "lucide-react";

import { HintItem } from "@/ui/hint-group";
import { IconButton } from "@/ui/icon-button";

import { useLayoutStore } from "../stores/layout-store";

type LayoutSnapshot = ReturnType<typeof useLayoutStore.getState>;

/** Whether the surfaces pane is on screen. Selector-shaped. */
export function rightPanelShown(s: LayoutSnapshot): boolean {
  return s.groupOrder.length > 1 && s.surfaces !== "hidden";
}

/** Show the surfaces pane (opening one on its launcher when there is none),
 *  or hide it. Its tabs keep running while hidden. Over a destination, the
 *  press goes back to the session with the pane on screen: hiding a pane
 *  nobody can see would look like nothing happened. */
export function toggleRightPanel(): void {
  const s = useLayoutStore.getState();
  const { setSurfaces, setFocusedGroup, addGroup, hideDestination } = s.actions;
  const overDestination = s.destinationShown;
  if (overDestination) hideDestination();
  if (rightPanelShown(s)) {
    if (!overDestination) setSurfaces("hidden");
    return;
  }
  if (s.groupOrder.length === 1) {
    setFocusedGroup(s.groupOrder[0]);
    addGroup();
  }
  setSurfaces("shown");
}

export function RightPanelToggle() {
  const shown = useLayoutStore(rightPanelShown);
  const label = shown ? "Hide panel" : "Show panel";
  return (
    <HintItem label={label}>
      <IconButton
        icon={PanelRight}
        label={label}
        size="sm"
        iconSize="md"
        aria-pressed={shown}
        data-right-panel-toggle
        onClick={toggleRightPanel}
      />
    </HintItem>
  );
}
