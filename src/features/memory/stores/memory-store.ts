import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { createSelectors } from "@/lib/create-selectors";
import type { AgentMemory, MemorySubTab } from "../lib/memory-types";
import { memoryPolicy, type Policy } from "../lib/memory-policy-api";
import {
  memoryTimeline,
  type MemoryTimeline,
} from "../lib/memory-timeline-api";

/**
 * Module-level cache for the Memory module. The Memory tab isn't persistent —
 * switching center tabs (or Memory sub-tabs) unmounts/remounts the views — so
 * without this every visit re-ran the expensive Rust indexing (agent_memory_read,
 * memory_policies). This store survives remounts and is keyed by project: views
 * render cached data instantly (optimistic) and only fetch on first load, project
 * change, or an explicit refresh. (The graph keeps its own memory-graph-store,
 * which is already module-level and self-guards.)
 */

type PolicyPhase =
  | "idle"
  | "checking"
  | "not-downloaded"
  | "downloading"
  | "loading"
  | "ready"
  | "error";

interface MemoryStoreState {
  /** Active sub-tab, preserved across remounts. */
  subTab: MemorySubTab;
  /** Which project the caches below belong to (reset on change). */
  project: string | null;

  // Claude/Codex panel data.
  agentMemory: AgentMemory | null;
  agentMemoryLoading: boolean;

  // Policy table.
  policies: Policy[] | null;
  policyPhase: PolicyPhase;
  policyError: string | null;

  // Timeline.
  timeline: MemoryTimeline | null;
  timelineLoading: boolean;
  /** Project path of an in-flight background refresh (coalesces duplicates). */
  timelineRefreshing: string | null;

  /**
   * Cross-tab navigation request: jump to a sub-tab AND select a specific item
   * (e.g. Timeline → the Claude/Codex memory file it came from). The `nonce`
   * lets the same target re-fire. `id` is the memory-doc id ("claude:<name>",
   * "codex:<threadId>", "codex:AGENTS.md") or a raw Codex thread id.
   */
  navTarget: { sub: MemorySubTab; id: string; nonce: number } | null;

  actions: {
    setSubTab: (t: MemorySubTab) => void;
    /** Switch to `sub` and ask its view to select/scroll to `id`. */
    navigateToMemory: (sub: MemorySubTab, id: string) => void;
    /** Drop caches when the project changes. */
    ensureProject: (projectPath: string | null) => void;
    loadAgentMemory: (projectPath: string, force?: boolean) => Promise<void>;
    loadPolicies: (projectPath: string, force?: boolean) => Promise<void>;
    loadTimeline: (projectPath: string, force?: boolean) => Promise<void>;
    setPolicyPhase: (phase: PolicyPhase, error?: string | null) => void;
    setPolicies: (rows: Policy[]) => void;
    /** Optimistic in-place value update after an edit saves. */
    updatePolicyValue: (id: string, value: string) => void;
  };
}

export const useMemoryStore = createSelectors(
  create<MemoryStoreState>()((set, get) => ({
    subTab: "chat",
    project: null,
    agentMemory: null,
    agentMemoryLoading: false,
    policies: null,
    policyPhase: "idle",
    policyError: null,
    timeline: null,
    timelineLoading: false,
    timelineRefreshing: null,
    navTarget: null,
    actions: {
      setSubTab: (t) => set({ subTab: t }),

      navigateToMemory: (sub, id) =>
        set((st) => ({
          subTab: sub,
          navTarget: { sub, id, nonce: (st.navTarget?.nonce ?? 0) + 1 },
        })),

      ensureProject: (projectPath) => {
        if (get().project === projectPath) return;
        // New project → invalidate every cache.
        set({
          project: projectPath,
          agentMemory: null,
          agentMemoryLoading: false,
          policies: null,
          policyPhase: "idle",
          policyError: null,
          timeline: null,
          timelineLoading: false,
          timelineRefreshing: null,
          navTarget: null,
        });
      },

      loadAgentMemory: async (projectPath, force = false) => {
        const s = get();
        if (!force && s.project === projectPath && s.agentMemory) return; // cache hit
        set({ agentMemoryLoading: true });
        try {
          const data = await invoke<AgentMemory>("agent_memory_read", {
            projectPath,
          });
          set({
            agentMemory: data,
            agentMemoryLoading: false,
            project: projectPath,
          });
        } catch {
          set({ agentMemory: null, agentMemoryLoading: false });
        }
      },

      loadPolicies: async (projectPath, force = false) => {
        const s = get();
        if (
          !force &&
          s.project === projectPath &&
          s.policies &&
          s.policyPhase === "ready"
        ) {
          return; // cache hit — no re-index
        }
        set({ policyPhase: "loading", policyError: null });
        try {
          const rows = await memoryPolicy.list(projectPath);
          set({ policies: rows, policyPhase: "ready", project: projectPath });
        } catch (e) {
          const msg = String(e);
          if (msg.includes("model-not-downloaded")) {
            set({ policyPhase: "not-downloaded" });
          } else {
            set({ policyError: msg, policyPhase: "error" });
          }
        }
      },

      loadTimeline: async (projectPath, force = false) => {
        const s = get();

        // Optimistic: the first time we see a project, paint the disk cache
        // instantly (survives app restarts). On revisits we already hold the
        // in-memory result, so skip the disk read and just refresh below.
        if (!s.timeline || s.project !== projectPath) {
          try {
            const cached = await memoryTimeline.loadCached(projectPath);
            if (cached && get().project === projectPath) {
              set({ timeline: cached, project: projectPath });
            }
          } catch {
            /* no cache yet */
          }
        }

        // Always recompute in the background so new commits/sessions/memory
        // (and their influence links) appear without a manual refresh — the
        // old in-memory short-circuit left the view stale until Refresh.
        // Coalesce duplicate in-flight refreshes (tab switches, StrictMode
        // double-mount) so we don't fire several git walks at once.
        if (!force && get().timelineRefreshing === projectPath) return;
        set({ timelineRefreshing: projectPath });

        // Only show the blocking spinner when nothing is on screen; otherwise
        // update silently (optimistic).
        const hadData = !!get().timeline && get().project === projectPath;
        set({ timelineLoading: !hadData });
        try {
          const t = await memoryTimeline.load(projectPath);
          set({ timeline: t, timelineLoading: false, project: projectPath });
        } catch {
          set({ timelineLoading: false });
          if (!hadData) set({ timeline: null });
        } finally {
          if (get().timelineRefreshing === projectPath)
            set({ timelineRefreshing: null });
        }
      },

      setPolicyPhase: (phase, error = null) =>
        set({ policyPhase: phase, policyError: error }),
      setPolicies: (rows) => set({ policies: rows, policyPhase: "ready" }),
      updatePolicyValue: (id, value) =>
        set((st) => ({
          policies:
            st.policies?.map((p) => (p.id === id ? { ...p, value } : p)) ??
            null,
        })),
    },
  })),
);
