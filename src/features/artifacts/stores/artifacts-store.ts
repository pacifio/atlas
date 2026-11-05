/**
 * What the Timeline board is showing, kept outside the panel.
 *
 * Three things need it there. Switching tabs unmounts the panel, and local
 * state would drop the open Session and the project filter every time — you
 * would land back on an unfiltered list after glancing at a diff. And the git
 * panel opens a Session from a commit, which means writing this from outside
 * the component tree.
 */

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import type { ProjectFilter } from "../types";

/** Which Session the board is showing, and where inside it to land. */
export interface OpenSession {
  sessionId: string;
  /** Empty for a Session from a Project this machine has no checkout of. */
  projectPath: string;
  /** The server Project id, for comments and the realtime subscription.
   *  `null` or absent on a Session that is not shared. */
  remoteProjectId?: string | null;
  /** Arrived from a commit: scroll to that Checkpoint instead of the top. A
   *  Session can produce many commits, and the one you clicked is the only part
   *  of it you asked about. */
  commitSha?: string;
  /** Arrived from the inbox: land on the comment's thread and open it. The
   *  anchor's id is the row it hangs off (the Session's own id for a comment
   *  on the whole Session). */
  anchor?: { kind: string; id: string };
}

interface ArtifactsState {
  /** The open Session, with the project whose store holds it. */
  open: OpenSession | null;
  /** The Project the board is narrowed to, or `null` for every project. */
  projectFilter: ProjectFilter | null;
  actions: {
    openSession: (open: OpenSession | null) => void;
    setProjectFilter: (filter: ProjectFilter | null) => void;
  };
}

export const useArtifactsStore = createSelectors(
  create<ArtifactsState>((set) => ({
    open: null,
    projectFilter: null,
    actions: {
      openSession: (open) => set({ open }),
      setProjectFilter: (projectFilter) => set({ projectFilter }),
    },
  })),
);
