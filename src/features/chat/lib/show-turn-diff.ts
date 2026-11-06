// What `atlas:open-turn-diff` does once it reaches the chat that owns the turn:
// show that turn's changes in the review panel beside the session, in the
// turn's own scope, scrolled to the file.
//
// The panel is the session's changes tab (`openSessionChanges`), so a turn
// opened twice walks one tab rather than stacking them, and the reader can
// widen the same view to the whole session or the working tree from its
// scope menu.
//
// Every chat panel hears the event, so a turn that is not this chat's is
// ignored without a word. One that is this chat's never is: when the turn
// scope has nothing to show, the reader is told why, or shown the session's
// changes instead.

import { toast } from "sonner";
import { useAppStore } from "@/features/app/stores/app-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { openSessionChanges } from "@/features/git/lib/open-session-changes";
import { useChatStore } from "../stores/chat-store";
import { collectTurnEdits } from "./turn-edits";
import { findTurnRun, stableTurnKey } from "./turn-identity";
import { toRepoRelative, type TurnDiffRequest } from "./open-turn-diff";

/** Show `request`'s turn of the chat in `tabId`. False when the turn is not
 *  this chat's, or there was nothing to open. */
export function showTurnDiff(tabId: string, request: TurnDiffRequest): boolean {
  const session = useChatStore.getState().sessions[tabId];
  const run = session ? findTurnRun(session.messages, request.turnId) : null;
  if (!session || !run) return false;

  const projectPath = useAppStore.getState().currentProject?.path ?? "";
  const sessionId = session.acpSessionId;
  if (!projectPath) {
    toast.info("Open a project to see this turn's changes.");
    return false;
  }
  if (!sessionId) {
    toast.info("This turn's changes can be shown once the session has connected to its agent.");
    return false;
  }

  const title = useLayoutStore.getState().tabs.find((t) => t.id === tabId)?.title;
  const edits = collectTurnEdits(session.messages, request.turnId, projectPath, request.file);
  const turnId = stableTurnKey(session.messages, run);
  if (edits.files.length === 0 || !turnId) {
    // The agent reported the files but not what it wrote to them. Git still
    // knows what the session changed.
    openSessionChanges({
      projectPath,
      sessionId,
      file: request.file ? toRepoRelative(request.file, projectPath) : "",
      title,
    });
    toast.info(
      "This turn's edits weren't recorded with their text. Showing the session's changes.",
    );
    return true;
  }
  openSessionChanges({ projectPath, sessionId, file: edits.initial, title, turnId });
  return true;
}
