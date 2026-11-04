import { useMemo } from "react";
import { TerminalSquare } from "lucide-react";
import type { ChatMessage } from "@/types/agent";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { usePaneTopInset } from "@/features/layout/lib/pane-top-inset";
import { bashEntriesOf } from "../lib/bash-history";
import { SidePanelFrameView } from "./views/side-panel-frame-view";
import { BashHistoryPanelView } from "./views/bash-history-panel-view";

interface BashHistoryPanelProps {
  messages: ChatMessage[];
  onJump: (messageIndex: number) => void;
  onClose: () => void;
}

/** The session's Bash calls, as a right-side slide-in overlay; the width is
 *  the layout store's. */
export function BashHistoryPanel({ messages, onJump, onClose }: BashHistoryPanelProps) {
  const bashPanel = useLayoutStore.use.bashPanel();
  // The session column's window bar floats over this pane (z-titlebar); start
  // below it, or the bar covers this panel's header and eats its clicks.
  const topInset = usePaneTopInset();
  const { setBashPanelWidth } = useLayoutStore.use.actions();
  const entries = useMemo(() => bashEntriesOf(messages), [messages]);

  return (
    <SidePanelFrameView
      panel="bash-history"
      icon={TerminalSquare}
      title="Bash calls"
      count={entries.length}
      width={bashPanel.width}
      top={topInset}
      onWidthChange={setBashPanelWidth}
      onClose={onClose}
      closeLabel="Hide bash history"
    >
      <BashHistoryPanelView entries={entries} onJump={onJump} />
    </SidePanelFrameView>
  );
}
