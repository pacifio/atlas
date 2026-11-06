// What the Commit row shows while its action runs, and for a moment after:
// per checkout path, so two sessions on one checkout show the same run.
//
// `run` is the action in flight: its phase ("Committing…"), the last line of
// output the git op streamed (a hook's, a push's), and when it started, for
// the elapsed time. `success` is the inline confirmation that replaces the
// row for a few seconds once it lands. A failure is a toast, never inline.

import { create } from "zustand";

import { createSelectors } from "@/lib/create-selectors";

export interface GitActionRun {
  label: string;
  /** The op whose output feeds `line`. */
  opId: string | null;
  line: string | null;
  startedAt: number;
}

export interface GitActionSuccess {
  title: string;
  description: string | null;
}

interface GitActionState {
  runs: Record<string, GitActionRun>;
  success: Record<string, GitActionSuccess>;
  actions: {
    start: (path: string, label: string) => void;
    /** A new phase, streaming under `opId` when it streams at all. */
    phase: (path: string, label: string, opId?: string | null) => void;
    output: (opId: string, line: string) => void;
    finish: (path: string, success: GitActionSuccess | null) => void;
    clearSuccess: (path: string) => void;
  };
}

export const useGitActionStore = createSelectors(
  create<GitActionState>()((set) => ({
    runs: {},
    success: {},
    actions: {
      start: (path, label) =>
        set((s) => {
          const success = { ...s.success };
          delete success[path];
          return {
            runs: { ...s.runs, [path]: { label, opId: null, line: null, startedAt: Date.now() } },
            success,
          };
        }),
      phase: (path, label, opId = null) =>
        set((s) => {
          const run = s.runs[path];
          if (!run) return s;
          return { runs: { ...s.runs, [path]: { ...run, label, opId, line: null } } };
        }),
      output: (opId, line) =>
        set((s) => {
          const entry = Object.entries(s.runs).find(([, run]) => run.opId === opId);
          if (!entry || !line.trim()) return s;
          const [path, run] = entry;
          return { runs: { ...s.runs, [path]: { ...run, line: line.trim() } } };
        }),
      finish: (path, success) =>
        set((s) => {
          const runs = { ...s.runs };
          delete runs[path];
          return success ? { runs, success: { ...s.success, [path]: success } } : { runs };
        }),
      clearSuccess: (path) =>
        set((s) => {
          if (!s.success[path]) return s;
          const success = { ...s.success };
          delete success[path];
          return { success };
        }),
    },
  })),
);
