// What the session has done, as panels beside the transcript — the Activity
// group: every Bash call it ran, and its plans. Each row toggles its panel;
// one shows at a time, and the open one's row stays lit.
//
// The panels are the chat panel's to draw; which one is open is kept by tab
// in `session-side-panel-store`, which is how this card, outside that panel's
// tree, opens them. As a popover the card closes on a pick: it sits over the
// transcript's top-right, where the panel opens. Docked, it stays.

import { Activity, ClipboardList, TerminalSquare, type LucideIcon } from "lucide-react";

import {
  useSessionSidePanel,
  useSessionSidePanelStore,
  type SessionSidePanel,
} from "@/features/chat/stores/session-side-panel-store";

import { useSessionDetailsStore } from "../stores/session-details-store";
import type { DetailsPresentation } from "./session-details-card";
import { DetailsRow, DetailsSection, RowIcon, RowLabel } from "./details-rows";

const ROWS: { panel: SessionSidePanel; label: string; icon: LucideIcon }[] = [
  { panel: "bash", label: "Bash calls", icon: TerminalSquare },
  { panel: "plans", label: "Plans", icon: ClipboardList },
];

export function ActivitySection({
  tabId,
  presentation,
}: {
  tabId: string;
  presentation: DetailsPresentation;
}) {
  const open = useSessionSidePanel(tabId);
  const { toggle } = useSessionSidePanelStore.use.actions();
  const pick = (panel: SessionSidePanel) => {
    if (presentation === "popover") {
      const { popoverFor, actions } = useSessionDetailsStore.getState();
      if (popoverFor) actions.setPopover(popoverFor, false);
    }
    toggle(tabId, panel);
  };
  return (
    <DetailsSection label="Activity" title="Activity" icon={Activity}>
      {ROWS.map(({ panel, label, icon }) => (
        <DetailsRow
          key={panel}
          onClick={() => pick(panel)}
          className={open === panel ? "bg-element-hover text-foreground" : undefined}
        >
          <RowIcon icon={icon} />
          <RowLabel>{label}</RowLabel>
        </DetailsRow>
      ))}
    </DetailsSection>
  );
}
