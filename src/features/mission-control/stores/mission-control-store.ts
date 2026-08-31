import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { createSelectors } from "@/lib/create-selectors";
import { activeOrgWorkspacesSnapshot } from "@/features/workspaces/lib/org-scope";
import type { MissionControlUsage, TimeRange } from "../types";

/**
 * Mission Control dashboard data. ONE Rust call (`mission_control_usage`)
 * returns all-time per-project metrics + a daily series + grand totals; the
 * `range` is applied CLIENT-SIDE to the daily series for the trend charts, so
 * toggling 7d/30d/90d/all needs no re-fetch.
 */
interface MissionControlState {
  range: TimeRange;
  data: MissionControlUsage | null;
  loading: boolean;
  error: string | null;
  actions: {
    setRange: (range: TimeRange) => void;
    refresh: () => Promise<void>;
  };
}

export const useMissionControlStore = createSelectors(
  create<MissionControlState>()((set) => ({
    range: "30d",
    data: null,
    loading: false,
    error: null,
    actions: {
      setRange: (range) => set({ range }),
      refresh: async () => {
        set({ loading: true, error: null });
        try {
          // Only the ACTIVE org's projects — Mission Control must not
          // aggregate usage across organisations.
          const projectPaths = activeOrgWorkspacesSnapshot().map((w) => w.path);
          const data = await invoke<MissionControlUsage>("mission_control_usage", {
            projectPaths,
          });
          set({ data, loading: false });
        } catch (e) {
          set({ error: String(e), loading: false });
        }
      },
    },
  })),
);
