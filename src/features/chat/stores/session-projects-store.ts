// The projects attached to each session, mirrored for the composer.
//
// Rust owns them (`ThreadRow.attachedProjects`, the `attached_projects`
// column); this is a read-through copy keyed by live ACP session id, so a
// composer chip can show and flip its project's access without each chip
// asking the backend. Two writers, both answers from Rust: the composer's
// history read (`use-live-elsewhere-feed.ts`, refreshed on
// `atlas:threads-changed`, so an agent's granted access request lands too),
// and the answer to an attach or access change, applied at once.

import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { createSelectors } from "@/lib/create-selectors";

import type { AttachedProject, ThreadRow } from "../lib/history-api";

interface SessionProjectsState {
  bySession: Record<string, AttachedProject[]>;
  actions: {
    /** Replace a session's list with the backend's answer. */
    replace: (sessionId: string, projects: AttachedProject[]) => void;
    /** Take every listed session's projects from history rows. A session
     *  with no row yet (a draft before its first send) keeps what an attach
     *  answered. */
    mergeRows: (rows: readonly ThreadRow[]) => void;
  };
}

export const useSessionProjectsStore = createSelectors(
  create<SessionProjectsState>()(
    immer((set) => ({
      bySession: {},
      actions: {
        replace: (sessionId, projects) =>
          set((s) => {
            s.bySession[sessionId] = projects;
          }),
        mergeRows: (rows) =>
          set((s) => {
            for (const row of rows) {
              if (!row.sessionId) continue;
              const next = row.attachedProjects ?? [];
              const prev = s.bySession[row.sessionId];
              // Leave untouched sessions alone so their chips do not re-render.
              if (!prev ? next.length === 0 : sameProjects(prev, next)) continue;
              s.bySession[row.sessionId] = next;
            }
          }),
      },
    })),
  ),
);

function sameProjects(a: readonly AttachedProject[], b: readonly AttachedProject[]): boolean {
  return (
    a.length === b.length && a.every((p, i) => p.path === b[i]!.path && p.access === b[i]!.access)
  );
}

/** The attached project at `path` in this session, if it is attached. */
export function useAttachedProject(
  sessionId: string | null | undefined,
  path: string | null | undefined,
): AttachedProject | undefined {
  return useSessionProjectsStore((s) =>
    sessionId && path ? s.bySession[sessionId]?.find((p) => p.path === path) : undefined,
  );
}
