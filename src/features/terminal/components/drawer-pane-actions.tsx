// Kept for later: the session terminal drawer is unmounted (no UI reaches it) until the terminal rework. Not dead code; do not delete.
//
// A drawer pane's actions while it holds a single terminal.
//
// In a terminal tab every pane carries the side list, whose header holds these
// actions. A session's terminal drawer is a few lines tall and usually holds
// one shell, where a 220px list of one is all chrome; so until a second
// terminal arrives the actions float, small, over the pane's top-right corner
// and the shell has the full width. A second terminal brings the list back.

import { Columns2, Maximize2, Plus, Rows2, Trash2, X } from "lucide-react";

import { HintGroup, HintItem } from "@/ui/hint-group";
import { IconButton } from "@/ui/icon-button";

import { useTerminalStore, type PaneNode } from "../stores/terminal-store";

export function DrawerPaneActions({
  pane,
  tabId,
  hasSplits,
  zoomed,
}: {
  pane: PaneNode;
  tabId: string;
  hasSplits: boolean;
  zoomed?: boolean;
}) {
  const {
    addTerminalToPane,
    splitPane,
    closeTerminalInPane,
    closePane,
    setActivePane,
    toggleZoom,
  } = useTerminalStore.use.actions();
  const only = pane.activeTerminalId ?? pane.terminals[0];
  return (
    <div
      data-drawer-pane-actions
      className="pointer-events-none absolute top-1.5 right-2 z-10 flex justify-end"
    >
      <HintGroup>
        <div className="pointer-events-auto inline-flex items-center gap-px rounded-md border border-border bg-background p-px shadow-sm">
          <HintItem label="Split right">
            <IconButton
              icon={Columns2}
              label="Split right"
              variant="ghost"
              size="xs"
              onClick={() => splitPane(tabId, pane.id, "horizontal")}
            />
          </HintItem>
          <HintItem label="Split down">
            <IconButton
              icon={Rows2}
              label="Split down"
              variant="ghost"
              size="xs"
              onClick={() => splitPane(tabId, pane.id, "vertical")}
            />
          </HintItem>
          <HintItem label="New terminal">
            <IconButton
              icon={Plus}
              label="New terminal"
              variant="ghost"
              size="xs"
              onClick={() => {
                addTerminalToPane(tabId, pane.id);
                setActivePane(tabId, pane.id);
              }}
            />
          </HintItem>
          {hasSplits && (
            <HintItem label={zoomed ? "Unzoom pane" : "Zoom pane"}>
              <IconButton
                icon={Maximize2}
                label={zoomed ? "Unzoom pane" : "Zoom pane"}
                variant="ghost"
                size="xs"
                aria-pressed={!!zoomed}
                onClick={() => toggleZoom(tabId, pane.id)}
              />
            </HintItem>
          )}
          {hasSplits ? (
            <HintItem label="Close pane">
              <IconButton
                icon={X}
                label="Close pane"
                variant="ghost"
                size="xs"
                onClick={() => closePane(tabId, pane.id)}
              />
            </HintItem>
          ) : (
            // The drawer's last terminal: closing it ends the shell and the
            // drawer closes with it.
            only && (
              <HintItem label="Close terminal">
                <IconButton
                  icon={Trash2}
                  label="Close terminal"
                  variant="ghost"
                  size="xs"
                  onClick={() => closeTerminalInPane(tabId, pane.id, only)}
                />
              </HintItem>
            )
          )}
        </div>
      </HintGroup>
    </div>
  );
}
