import { create } from "zustand";
import {
  getProjectUsage,
  type ProjectUsage,
} from "@/features/chat/lib/claude-api";

/**
 * Cached project-usage report, keyed by workspace cwd. The panel renders
 * the cached value instantly (optimistic) and `load()` revalidates in the
 * background — so reopening the accordion never flashes a spinner, and the
 * left-panel header refresh button shares the same data.
 */
interface UsageReportState {
  byCwd: Record<string, ProjectUsage>;
  /** The cwd currently being (re)fetched, or null. */
  loadingCwd: string | null;
  load: (cwd: string) => Promise<void>;
}

export const useUsageReport = create<UsageReportState>((set) => ({
  byCwd: {},
  loadingCwd: null,
  load: async (cwd) => {
    if (!cwd) return;
    set({ loadingCwd: cwd });
    try {
      const data = await getProjectUsage(cwd);
      set((s) => ({
        byCwd: { ...s.byCwd, [cwd]: data },
        loadingCwd: s.loadingCwd === cwd ? null : s.loadingCwd,
      }));
    } catch {
      set((s) => ({ loadingCwd: s.loadingCwd === cwd ? null : s.loadingCwd }));
    }
  },
}));
