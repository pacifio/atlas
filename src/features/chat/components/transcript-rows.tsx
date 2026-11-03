// Row components for the new transcript.
//
// House rules, all of which exist to keep the thread quiet and cheap to scroll:
//
//  1. No element grows on hover or on load. Anything expandable either toggles
//     via row state (which reflows once, deliberately) or opens the detail
//     panel. Diffs and tool output are the panel's job, never the thread's —
//     that is what keeps a turn's cost bounded no matter what the agent did.
//  2. The only things with colour are diff counts, the running-state glyph, and
//     the turn footer's primary action. Everything else is foreground/muted
//     grey. Per-tool icon SHAPES are fine and are what the marker rows use —
//     per-tool icon COLOURS are the "moving blocks" problem in a new costume,
//     and are the thing to resist.
//  3. Rows never subscribe to the chat store or the detail-panel store. Data
//     arrives as props; actions are fired imperatively via `getState()`.
//
// The rows themselves are props-only views under `./views/`. This module is
// their public face: it re-exports them under the names the transcript and
// other features import, and wraps the four rows that read something (a
// comment count) or fire something (the detail panel, the turn diff) in thin
// containers that do it and hand the view plain props.

import { memo, useCallback, useMemo } from "react";
import { openDetail } from "../stores/detail-panel-store";
import { openTurnDiff } from "../lib/open-turn-diff";
import { useGroupHasComments, useRowHasComments } from "./chat-comment-pills";
import type { MarkerGroupRow, MarkerRow, SubagentRow, ThinkingRow } from "../lib/turn-rows";
import { ThinkingRowBody } from "./views/thinking-row-view";
import { MarkerGroupRowBody, MarkerRowBody, SubagentRowBody } from "./views/marker-row-views";

export { UserRowView } from "./views/user-row-view";
export { ProseRowView } from "./views/prose-row-view";
export { SeparatorRowView, TurnFooterRowView, WorkHeaderRowView } from "./views/turn-row-views";
export {
  formatCalls,
  formatWorked,
  LiveElapsed,
  settledFigure,
  SUBAGENT_STATE,
} from "./views/transcript-row-parts";

// ── Thinking ───────────────────────────────────────────────────────────────

export const ThinkingRowView = memo(function ThinkingRowView({
  row,
  tabId,
  onToggleExpand,
}: {
  row: ThinkingRow;
  tabId: string;
  onToggleExpand: (id: string) => void;
}) {
  // `th:<messageId>` — the key a comment on this thought is filed under.
  const discussed = useRowHasComments(tabId, row.id.slice(3));
  return (
    <ThinkingRowBody
      row={row}
      tabId={tabId}
      discussed={discussed}
      onToggleExpand={onToggleExpand}
    />
  );
});

// ── Marker ─────────────────────────────────────────────────────────────────

/** One tool call. See `MarkerRowBody` for what it renders. */
export const MarkerRowView = memo(function MarkerRowView({
  row,
  tabId,
  embedded = false,
}: {
  row: MarkerRow;
  tabId: string;
  embedded?: boolean;
}) {
  const onClick = useCallback(() => {
    if (row.opens === "diff") {
      // Changes get the real viewer, not the sidebar. The turn id is what the
      // diff is scoped by; the path just says which file to land on.
      openTurnDiff(row.turnId, row.path);
    } else if (row.opens === "output") {
      openDetail(tabId, { kind: "output", toolCallId: row.toolCallId });
    }
  }, [row.opens, row.path, row.toolCallId, tabId]);
  const discussed = useRowHasComments(tabId, row.toolCallId);
  return (
    <MarkerRowBody
      row={row}
      tabId={tabId}
      embedded={embedded}
      discussed={discussed}
      onClick={onClick}
    />
  );
});

/** A folded sequence of tool calls. See `MarkerGroupRowBody`. */
export const MarkerGroupRowView = memo(function MarkerGroupRowView({
  row,
  tabId,
  onExpandTurn,
}: {
  row: MarkerGroupRow;
  tabId: string;
  onExpandTurn: (turnId: string) => void;
}) {
  // The ids of the calls behind this line, which is what a comment on any of
  // them is keyed by. Derived here rather than carried on the row: it is a map
  // over a list the row already holds, and the projection would have to redo it
  // on every marker state change.
  const callIds = useMemo(() => row.markers.map((marker) => marker.toolCallId), [row.markers]);
  const discussed = useGroupHasComments(tabId, callIds);
  return (
    <MarkerGroupRowBody
      row={row}
      tabId={tabId}
      onExpandTurn={onExpandTurn}
      callIds={callIds}
      discussed={discussed}
      Marker={MarkerRowView}
    />
  );
});

/** A delegated child. See `SubagentRowBody`. */
export const SubagentRowView = memo(function SubagentRowView({
  row,
  tabId,
}: {
  row: SubagentRow;
  tabId: string;
}) {
  const onOpen = useCallback(
    () => openDetail(tabId, { kind: "subagent", toolCallId: row.toolCallId }),
    [tabId, row.toolCallId],
  );
  return <SubagentRowBody row={row} onOpen={onOpen} />;
});
