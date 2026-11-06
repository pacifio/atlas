import { MAX_GROUPS, useLayoutStore } from "@/features/layout/stores/layout-store";
import { useDiffPanelStore } from "../stores/diff-panel-store";
import { requestDiffJump } from "./diff-jump";

/**
 * Show a session's changes beside it, scrolled to `file`: all of them, or
 * one turn's (`turnId`).
 *
 * One tab per agent session (`session-changes:<id>`). If it is already open —
 * in the split, or anywhere — this only activates it and jumps to the file:
 * clicking down the overview's list walks one tab, never stacks new ones.
 * Otherwise the tab goes where the reader is not:
 *  1. the column already showing another thread's changes, so they share it;
 *  2. else an empty split column;
 *  3. else a new split to the right of the chat (⌘\'s column);
 *  4. else, at the column limit, the chat's neighbour.
 */
export function openSessionChanges(opts: {
  projectPath: string;
  sessionId: string;
  file: string;
  title?: string;
  /** Show this turn's own edits (the panel's turn scope) rather than the
   *  branch's changes. Without it, a panel left on a turn goes back to
   *  Changes: the file asked for may not be in that turn. The turn's stable
   *  key (`stableTurnKey`): it is persisted. */
  turnId?: string;
}): void {
  const { projectPath, sessionId, file, title, turnId } = opts;
  const id = `session-changes:${sessionId}`;
  const diffPanel = useDiffPanelStore.getState();
  if (turnId) diffPanel.actions.setTurn(id, turnId);
  else if (diffPanel.scope[id] === "turn") diffPanel.actions.setScope(id, "branch-range");
  requestDiffJump(id, file);

  const layout = useLayoutStore.getState();
  const { actions } = layout;
  if (layout.tabs.some((t) => t.id === id)) {
    actions.setActiveTab(id);
    return;
  }

  const groupOf = (t: { groupId?: string }) => t.groupId ?? "main";
  const here = layout.focusedGroupId;
  const sibling = layout.tabs.find((t) => t.type === "session-changes" && groupOf(t) !== here);
  let target = sibling
    ? groupOf(sibling)
    : layout.groupOrder.find((g) => g !== here && !layout.tabs.some((t) => groupOf(t) === g));
  if (!target && layout.groupOrder.length < MAX_GROUPS) {
    actions.addGroup();
    target = useLayoutStore.getState().focusedGroupId;
  }
  if (!target) {
    const i = layout.groupOrder.indexOf(here);
    target = layout.groupOrder[i + 1] ?? layout.groupOrder[i - 1] ?? here;
  }

  actions.addTab(
    {
      id,
      type: "session-changes",
      title: title ? `Changes · ${title}` : "Changes",
      closable: true,
      dirty: false,
      data: { projectPath, sessionId },
    },
    target,
  );
}
