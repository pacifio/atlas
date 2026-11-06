import { openTimelineSession } from "@/features/security/lib/open-timeline-session";
import { useArtifactsStore } from "@/features/artifacts/stores/artifacts-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";

/** Open the recorded session a memory came from on the Timeline: at the
 *  commit it produced when there is one, else at its top. The provenance's
 *  session id is the recorder's, which is what the Timeline opens by. */
export function openMemorySession(t: {
  projectPath: string;
  sessionId: string;
  commitSha?: string | null;
}): void {
  if (t.commitSha) {
    openTimelineSession({
      projectPath: t.projectPath,
      sessionId: t.sessionId,
      commitSha: t.commitSha,
    });
    return;
  }
  useArtifactsStore.getState().actions.openSession({
    sessionId: t.sessionId,
    projectPath: t.projectPath,
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
