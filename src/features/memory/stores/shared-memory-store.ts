// Shared Cross-Agent Memory (v2) — UI state for the Memory panel's "Shared"
// view. Loads the per-project derived state (active plan, decisions, recent
// changes, facts) and supports an on-demand query + clear. Scoped to one
// project at a time (the active workspace), reloaded via `load(projectPath)`.
// Mirrors `memory-sharing-store.ts`.

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import { sharedMemory, type MemoryEvent, type SharedState } from "../lib/shared-memory-api";

const EMPTY_STATE: SharedState = {
  lastSeq: 0,
  activePlan: null,
  decisions: [],
  recentChanges: [],
  facts: [],
  failures: [],
  architecture: [],
  sessionAgents: {},
  updatedAt: 0,
};

interface SharedMemoryStore {
  projectPath: string | null;
  state: SharedState;
  events: MemoryEvent[];
  loaded: boolean;
  queryText: string;
  queryResults: MemoryEvent[];
  actions: {
    load: (projectPath: string) => Promise<void>;
    refresh: () => Promise<void>;
    runQuery: (query: string) => Promise<void>;
    clear: () => Promise<void>;
  };
}

export const useSharedMemoryStore = createSelectors(
  create<SharedMemoryStore>((set, get) => ({
    projectPath: null,
    state: EMPTY_STATE,
    events: [],
    loaded: false,
    queryText: "",
    queryResults: [],
    actions: {
      load: async (projectPath) => {
        set({ projectPath, loaded: false });
        try {
          // Derived view + the raw event log (newest-first) in parallel.
          const [state, events] = await Promise.all([
            sharedMemory.getState(projectPath),
            sharedMemory.listEvents(projectPath),
          ]);
          // Ignore a stale response if the project changed mid-flight.
          if (get().projectPath !== projectPath) return;
          set({ state, events, loaded: true });
        } catch {
          if (get().projectPath !== projectPath) return;
          set({ state: EMPTY_STATE, events: [], loaded: true });
        }
      },
      refresh: async () => {
        const { projectPath } = get();
        if (!projectPath) return;
        try {
          const [state, events] = await Promise.all([
            sharedMemory.getState(projectPath),
            sharedMemory.listEvents(projectPath),
          ]);
          if (get().projectPath !== projectPath) return;
          set({ state, events });
        } catch {
          /* keep last good state */
        }
      },
      runQuery: async (query) => {
        const { projectPath } = get();
        set({ queryText: query });
        if (!projectPath || !query.trim()) {
          set({ queryResults: [] });
          return;
        }
        try {
          const queryResults = await sharedMemory.query(projectPath, query);
          if (get().projectPath !== projectPath) return;
          set({ queryResults });
        } catch {
          set({ queryResults: [] });
        }
      },
      clear: async () => {
        const { projectPath } = get();
        if (!projectPath) return;
        await sharedMemory.clear(projectPath);
        if (get().projectPath !== projectPath) return;
        set({ state: EMPTY_STATE, events: [], queryResults: [], queryText: "" });
      },
    },
  })),
);
