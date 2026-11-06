/**
 * Who the shared timeline's sockets say is here, per server Project.
 *
 * Every Workspace socket (a board socket per bound Project, a follower per open
 * Session) is told the Project's roster whenever somebody connects or drops —
 * the `presence` frame on `atlas:artifacts-cloud`. Held at app scope rather
 * than by the Timeline panel, because the roster is only re-sent on a change:
 * a panel that started listening after the board sockets connected would wait,
 * blank, for the next person to come or go.
 *
 * Rust sends an empty roster when this machine stops listening to a Project,
 * or when its only socket there drops and is redialling, so an entry here is
 * always what a live socket last heard.
 */

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";

interface TeamPresenceState {
  /** Server Project id → user ids connected to it. */
  byProject: Record<string, string[]>;
  actions: {
    /** One Project's roster, replaced whole — the frame is never a delta. */
    setProject: (projectId: string, online: string[]) => void;
    /** Forget a Project (membership revoked). */
    dropProject: (projectId: string) => void;
    /** Forget everything — the Organisation changed or the user signed out. */
    reset: () => void;
  };
}

function sameIds(a: string[] | undefined, b: string[]): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((id, i) => id === b[i]);
}

export const useTeamPresenceStore = createSelectors(
  create<TeamPresenceState>((set) => ({
    byProject: {},
    actions: {
      setProject: (projectId, online) =>
        set((s) => {
          // An empty roster is the same as no entry: drop it rather than keep a
          // key that every reader has to skip.
          if (online.length === 0) {
            if (!(projectId in s.byProject)) return s;
            const { [projectId]: _gone, ...rest } = s.byProject;
            return { byProject: rest };
          }
          // The roster is re-sent whole on every connect anywhere on the
          // Project; an unchanged one must not hand readers a new object.
          if (sameIds(s.byProject[projectId], online)) return s;
          return { byProject: { ...s.byProject, [projectId]: [...online] } };
        }),
      dropProject: (projectId) =>
        set((s) => {
          if (!(projectId in s.byProject)) return s;
          const { [projectId]: _gone, ...rest } = s.byProject;
          return { byProject: rest };
        }),
      reset: () => set((s) => (Object.keys(s.byProject).length === 0 ? s : { byProject: {} })),
    },
  })),
);
