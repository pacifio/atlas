// Review-Agents store. Owns provider/model selection, the diff source, the
// live state of an in-flight report (per-file progress + streamed synthesis),
// and the list of persisted past reviews. A single global `atlas:review`
// listener routes events into state, keyed by the active review id.

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import {
  review,
  listenReview,
  type FileVerdict,
  type ReviewRecord,
  type ReviewSource,
} from "../lib/review-api";
import { curateModels, defaultModelFor } from "../lib/model-catalog";

const LS_PROVIDER = "atlas-review-provider";
// Model choice is persisted PER PROVIDER so a model picked for one provider can
// never be sent to another (the cause of cross-provider 404s).
const lsModelKey = (provider: string) => `atlas-review-model:${provider}`;

interface ReviewState {
  providers: string[];
  providersLoaded: boolean;
  selectedProvider: string | null;
  models: string[];
  loadingModels: boolean;
  selectedModel: string | null;
  source: ReviewSource;
  records: ReviewRecord[];
  /** Review currently selected for viewing (past or just-finished). */
  selectedRecord: ReviewRecord | null;
  /** Id of the in-flight (or last-started) review. */
  activeId: string | null;
  streaming: boolean;
  // ── Live run state ──
  /** Files started but not yet done (in-flight). */
  pendingFiles: string[];
  /** Per-file verdicts as they complete. */
  liveFiles: FileVerdict[];
  /** Streamed synthesis summary text. */
  synthesisText: string;
  /** Non-fatal per-file errors during the current run. */
  fileErrors: string[];
  /** Fatal error that aborted the run. */
  streamError: string | null;
  /** A source preset requested from elsewhere (Source Control). */
  pendingSource: { mode: "working" | "staged" | "commit" | "branch"; sha?: string } | null;
  actions: {
    init: (project: string) => Promise<void>;
    refreshRecords: (project: string) => Promise<void>;
    /** Re-read which BYOK providers are usable (after a key is added/removed in
     *  Settings). Switches off a provider whose key was just deleted. */
    refreshProviders: () => Promise<void>;
    setProvider: (provider: string) => Promise<void>;
    setModel: (model: string) => void;
    setSource: (source: ReviewSource) => void;
    start: (project: string) => Promise<void>;
    cancel: () => void;
    selectRecord: (record: ReviewRecord | null) => void;
    requestReview: (mode: "working" | "staged" | "commit" | "branch", sha?: string) => void;
    consumePending: () => void;
  };
}

let listenerReady = false;

export const useReviewStore = createSelectors(
  create<ReviewState>((set, get) => ({
    providers: [],
    providersLoaded: false,
    selectedProvider: null,
    models: [],
    loadingModels: false,
    selectedModel: null,
    source: { type: "working" },
    records: [],
    selectedRecord: null,
    activeId: null,
    streaming: false,
    pendingFiles: [],
    liveFiles: [],
    synthesisText: "",
    fileErrors: [],
    streamError: null,
    pendingSource: null,
    actions: {
      init: async (project) => {
        // Reset per-project view state up front so switching projects never
        // shows the previous project's records or the report we were viewing.
        set({
          records: [],
          selectedRecord: null,
          streaming: false,
          streamError: null,
          pendingFiles: [],
          liveFiles: [],
          synthesisText: "",
          fileErrors: [],
          activeId: null,
        });

        if (!listenerReady) {
          listenerReady = true;
          await listenReview((e) => {
            if (e.id !== get().activeId) return;
            switch (e.kind) {
              case "file_started":
                set((s) => ({ pendingFiles: [...s.pendingFiles, e.path] }));
                break;
              case "file_done":
                set((s) => ({
                  pendingFiles: s.pendingFiles.filter((p) => p !== e.verdict.path),
                  liveFiles: [...s.liveFiles.filter((f) => f.path !== e.verdict.path), e.verdict],
                }));
                break;
              case "file_error":
                set((s) => ({ fileErrors: [...s.fileErrors, e.message] }));
                break;
              case "delta":
                set((s) => ({ synthesisText: s.synthesisText + e.delta }));
                break;
              case "complete":
                set((s) => ({
                  streaming: false,
                  synthesisText: "",
                  liveFiles: [],
                  pendingFiles: [],
                  selectedRecord: e.record,
                  records: [e.record, ...s.records.filter((r) => r.id !== e.record.id)],
                }));
                break;
              case "error":
                set({ streaming: false, streamError: e.message });
                break;
            }
          });
        }

        const [providers] = await Promise.all([
          review.providers().catch(() => [] as string[]),
          get().actions.refreshRecords(project),
        ]);
        set({ providers, providersLoaded: true });

        const saved = localStorage.getItem(LS_PROVIDER);
        const provider = saved && providers.includes(saved) ? saved : (providers[0] ?? null);
        if (provider) {
          await get().actions.setProvider(provider);
        }
      },

      refreshRecords: async (project) => {
        try {
          const records = await review.list(project);
          set({ records });
        } catch {
          set({ records: [] });
        }
      },

      refreshProviders: async () => {
        let providers: string[] = [];
        try {
          providers = await review.providers();
        } catch {
          providers = [];
        }
        set({ providers, providersLoaded: true });
        const { selectedProvider } = get();
        if (!selectedProvider) {
          // Nothing selected yet (or was cleared) — pick the first available.
          if (providers.length > 0) await get().actions.setProvider(providers[0]);
        } else if (!providers.includes(selectedProvider)) {
          // The selected provider's key was removed — switch or clear.
          if (providers.length > 0) {
            await get().actions.setProvider(providers[0]);
          } else {
            set({ selectedProvider: null, models: [], selectedModel: null });
          }
        }
      },

      setProvider: async (provider) => {
        localStorage.setItem(LS_PROVIDER, provider);
        set({ selectedProvider: provider, loadingModels: true, models: [] });
        let liveIds: string[] = [];
        try {
          liveIds = (await review.models(provider)).map((m) => m.id);
        } catch {
          liveIds = [];
        }
        const models = curateModels(provider, liveIds);
        const saved = localStorage.getItem(lsModelKey(provider));
        const selectedModel =
          saved && models.includes(saved) ? saved : defaultModelFor(provider, models);
        if (selectedModel) localStorage.setItem(lsModelKey(provider), selectedModel);
        set({ models, selectedModel, loadingModels: false });
      },

      setModel: (model) => {
        const provider = get().selectedProvider;
        if (provider) localStorage.setItem(lsModelKey(provider), model);
        set({ selectedModel: model });
      },

      setSource: (source) => set({ source }),

      start: async (project) => {
        const { selectedProvider, selectedModel, source, streaming } = get();
        if (streaming || !selectedProvider || !selectedModel) return;
        const id = crypto.randomUUID();
        set({
          activeId: id,
          streaming: true,
          pendingFiles: [],
          liveFiles: [],
          synthesisText: "",
          fileErrors: [],
          streamError: null,
          selectedRecord: null,
        });
        try {
          await review.start(id, project, selectedProvider, selectedModel, source);
        } catch (err) {
          if (get().activeId === id && get().streaming) {
            set({ streaming: false, streamError: String(err) });
          }
        }
      },

      cancel: () => {
        const { activeId, streaming } = get();
        if (activeId && streaming) {
          void review.cancel(activeId);
          set({ streaming: false });
        }
      },

      selectRecord: (record) => set({ selectedRecord: record, streamError: null }),

      requestReview: (mode, sha) => set({ pendingSource: { mode, sha } }),

      consumePending: () => set({ pendingSource: null }),
    },
  })),
);
