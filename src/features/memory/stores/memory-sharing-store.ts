// Shared Cross-Agent Memory — UI state for the Memory panel's Shared toggle +
// summarizer selector. Caches the per-project toggle and summarizer preference
// and persists changes through `memory-sharing-api`. Scoped to one project at a
// time (the active project), reloaded via `load(projectPath)`.

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import { memorySharing, type SummarizerPref } from "../lib/memory-sharing-api";

const DEFAULT_PREF: SummarizerPref = { mode: "raw", provider: "", model: "" };

interface MemorySharingState {
  projectPath: string | null;
  enabled: boolean;
  /** Extraction also reads sessions imported from outside Atlas. */
  fromExternalSessions: boolean;
  pref: SummarizerPref;
  loaded: boolean;
  actions: {
    load: (projectPath: string) => Promise<void>;
    setEnabled: (enabled: boolean) => Promise<void>;
    setFromExternalSessions: (on: boolean) => Promise<void>;
    setPref: (pref: SummarizerPref) => Promise<void>;
  };
}

export const useMemorySharingStore = createSelectors(
  create<MemorySharingState>((set, get) => ({
    projectPath: null,
    enabled: true, // optimistic default (matches Rust DEFAULT_ENABLED)
    fromExternalSessions: false, // matches Rust DEFAULT_FROM_EXTERNAL_SESSIONS
    pref: DEFAULT_PREF,
    loaded: false,
    actions: {
      load: async (projectPath) => {
        set({ projectPath, loaded: false });
        try {
          const [enabled, fromExternalSessions, pref] = await Promise.all([
            memorySharing.getEnabled(projectPath),
            memorySharing.getFromExternalSessions(projectPath),
            memorySharing.getSummarizer(projectPath),
          ]);
          // Ignore a stale response if the project changed mid-flight.
          if (get().projectPath !== projectPath) return;
          set({ enabled, fromExternalSessions, pref, loaded: true });
        } catch (err) {
          console.error("memorySharing.load failed", err);
          set({ loaded: true });
        }
      },

      setEnabled: async (enabled) => {
        const projectPath = get().projectPath;
        if (!projectPath) return;
        const prev = get().enabled;
        set({ enabled }); // optimistic
        try {
          await memorySharing.setEnabled(projectPath, enabled);
        } catch (err) {
          console.error("memorySharing.setEnabled failed", err);
          set({ enabled: prev }); // revert
        }
      },

      setFromExternalSessions: async (on) => {
        const projectPath = get().projectPath;
        if (!projectPath) return;
        const prev = get().fromExternalSessions;
        set({ fromExternalSessions: on }); // optimistic
        try {
          await memorySharing.setFromExternalSessions(projectPath, on);
        } catch (err) {
          console.error("memorySharing.setFromExternalSessions failed", err);
          set({ fromExternalSessions: prev }); // revert
        }
      },

      setPref: async (pref) => {
        const projectPath = get().projectPath;
        if (!projectPath) return;
        const prev = get().pref;
        set({ pref }); // optimistic
        try {
          await memorySharing.setSummarizer(projectPath, pref);
        } catch (err) {
          console.error("memorySharing.setPref failed", err);
          set({ pref: prev }); // revert
        }
      },
    },
  })),
);
