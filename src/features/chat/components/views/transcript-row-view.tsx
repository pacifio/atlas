import { RowKind, type Row } from "../../lib/turn-rows";
import {
  UserRowView,
  ProseRowView,
  ThinkingRowView,
  MarkerRowView,
  MarkerGroupRowView,
  SubagentRowView,
  WorkHeaderRowView,
  SeparatorRowView,
  TurnFooterRowView,
} from "../transcript-rows";
import { InterruptionRowView } from "../interruption-row";
import { InjectedRowView } from "../injected-row";

/** Row dispatch. Kept out of the list body so the map stays flat. */
export function RowView({
  row,
  justSentMessageId,
  tabId,
  agentLabel,
  priority,
  onToggleExpand,
  onExpandTurn,
  canRetryRowId,
  canBranchRowId,
  canContinue,
  pinScopeKey,
  fileRoot,
}: {
  row: Row;
  justSentMessageId?: string;
  tabId: string;
  agentLabel: string;
  priority: number;
  onToggleExpand: (id: string) => void;
  onExpandTurn: (turnId: string) => void;
  /** Id of the one row allowed to show a retry button, or `undefined` when no
   *  retry is possible. An id compare here keeps `UserRowView`'s prop a plain
   *  boolean. */
  canRetryRowId?: string;
  /** Id of the one prose row allowed to show "Branch from here" — the latest
   *  settled response — or `undefined` when the session cannot fork now. */
  canBranchRowId?: string;
  /** Whether a message could be sent now (an interrupted turn's Continue). */
  canContinue: boolean;
  /** Pin scope for this thread — resolved once here rather than per row, so a
   *  row never reads the chat store. */
  pinScopeKey: string;
  /** The session's project root, for file chips. Resolved once, like
   *  `pinScopeKey`. */
  fileRoot?: string;
}) {
  switch (row.kind) {
    case RowKind.User:
      return (
        <UserRowView
          row={row}
          priority={priority}
          // Row ids are prefixed (`u:<messageId>`); the store records the raw
          // message id. The unprefixed compare never matched — the entrance
          // animation was silently dead until this fix.
          justSent={row.id === `u:${justSentMessageId}`}
          tabId={tabId}
          canRetry={row.id === canRetryRowId}
          pinScopeKey={pinScopeKey}
          fileRoot={fileRoot}
          onToggleExpand={onToggleExpand}
        />
      );
    case RowKind.Prose:
      return (
        <ProseRowView
          row={row}
          tabId={tabId}
          agentLabel={agentLabel}
          priority={priority}
          pinScopeKey={pinScopeKey}
          canBranch={row.id === canBranchRowId}
          fileRoot={fileRoot}
        />
      );
    case RowKind.Thinking:
      return <ThinkingRowView row={row} tabId={tabId} onToggleExpand={onToggleExpand} />;
    case RowKind.Marker:
      return <MarkerRowView row={row} tabId={tabId} />;
    case RowKind.MarkerGroup:
      return <MarkerGroupRowView row={row} tabId={tabId} onExpandTurn={onExpandTurn} />;
    case RowKind.Subagent:
      return <SubagentRowView row={row} tabId={tabId} />;
    case RowKind.Separator:
      return <SeparatorRowView row={row} />;
    case RowKind.WorkHeader:
      return <WorkHeaderRowView row={row} onToggle={onExpandTurn} />;
    case RowKind.TurnFooter:
      return (
        <TurnFooterRowView
          row={row}
          tabId={tabId}
          pinScopeKey={pinScopeKey}
          canBranch={row.responseRowId !== undefined && row.responseRowId === canBranchRowId}
        />
      );
    case RowKind.Injected:
      return <InjectedRowView row={row} />;
    case RowKind.Interruption:
      return (
        <InterruptionRowView
          row={row}
          tabId={tabId}
          canRetry={canRetryRowId !== undefined}
          canContinue={canContinue}
        />
      );
    default:
      return null;
  }
}
