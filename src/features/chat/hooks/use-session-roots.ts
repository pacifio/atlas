/**
 * A session's roots (`session-roots.ts`) as a hook: the main project and the
 * projects attached to the session, read from the attached-projects mirror
 * (`session-projects-store`). The array keeps its identity until a root is
 * added, removed or changes access, so a memo keyed on it holds.
 */

import { useMemo } from "react";

import { basename } from "@/lib/paths";
import { useProjectStore } from "@/features/projects/stores/project-store";

import type { AttachedProject } from "../lib/history-api";
import { sessionRoots, type SessionRoot } from "../lib/session-roots";
import { useSessionProjectsStore } from "../stores/session-projects-store";

const NONE: readonly AttachedProject[] = [];

/** The projects attached to the session `sessionId` (a live ACP id). */
export function useAttachedProjects(
  sessionId: string | null | undefined,
): readonly AttachedProject[] {
  return useSessionProjectsStore((s) => (sessionId ? (s.bySession[sessionId] ?? NONE) : NONE));
}

export function useSessionRoots(
  sessionId: string | null | undefined,
  mainPath: string | null | undefined,
): SessionRoot[] {
  const attached = useAttachedProjects(sessionId);
  const mainName = useProjectStore((s) =>
    mainPath ? (s.projects.find((p) => p.path === mainPath)?.name ?? null) : null,
  );
  return useMemo(
    () =>
      sessionRoots(
        mainPath ? { path: mainPath, name: mainName ?? basename(mainPath) } : null,
        attached,
      ),
    [mainPath, mainName, attached],
  );
}
