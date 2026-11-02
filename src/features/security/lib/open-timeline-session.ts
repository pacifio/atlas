import { useArtifactsStore } from "@/features/artifacts/stores/artifacts-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";

/** Open a session on the Timeline at one commit's Checkpoint, as the commit
 *  view's "Made in" links do. */
export function openTimelineSession(t: {
  projectPath: string;
  sessionId: string;
  commitSha: string;
}): void {
  useArtifactsStore.getState().actions.openSession({
    sessionId: t.sessionId,
    projectPath: t.projectPath,
    commitSha: t.commitSha,
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
