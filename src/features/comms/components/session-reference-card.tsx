import { useArtifactsStore } from "@/features/artifacts/stores/artifacts-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import type { ChatSessionReference } from "../types";
import { SessionReferenceCardView } from "./views/session-reference-card-view";

/**
 * Open the recorded session a reference points at on the Timeline, the way
 * the git panel opens one from a commit: the board's open Session set first,
 * then the Timeline tab. The Session is addressed by its Workspace (the
 * Timeline's `remoteProjectId`) with no local checkout, so it is read from
 * the server — a teammate's run may never have existed on this machine. A
 * checkpoint reference lands on its commit.
 */
export function openRecordedSession(ref: ChatSessionReference): void {
  useArtifactsStore.getState().actions.openSession({
    sessionId: ref.session_id,
    projectPath: "",
    remoteProjectId: ref.workspace_ref_id,
    commitSha: ref.kind === "checkpoint" ? ref.commit_sha : undefined,
  });
  useLayoutStore.getState().actions.addTab({
    id: "artifacts",
    type: "artifacts",
    title: "Timeline",
    closable: true,
    dirty: false,
    data: {},
  });
}

/** A Session Reference a message carries; opens its recorded session on the Timeline. */
export function SessionReferenceCard({ reference }: { reference: ChatSessionReference }) {
  return (
    <SessionReferenceCardView reference={reference} onOpen={() => openRecordedSession(reference)} />
  );
}
