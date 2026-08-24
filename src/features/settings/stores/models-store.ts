// Local Model Manager store — the curated catalog with per-machine downloaded /
// selected state, live download progress, and HuggingFace search results.
// Pattern mirrors byok-store.ts. Business logic (download/select/reindex) lives in
// Rust; this store is view state + orchestration only.

import { create } from "zustand";
import { toast } from "sonner";
import { createSelectors } from "@/lib/create-selectors";
import {
  models,
  listenModelProgress,
  listenModelDone,
  listenModelsChanged,
  type ModelStatus,
  type DownloadProgress,
} from "../lib/models-api";
import type { UnlistenFn } from "@tauri-apps/api/event";

interface ModelsState {
  list: ModelStatus[];
  loaded: boolean;
  /** model id → live download progress (present only while downloading). */
  downloading: Record<string, DownloadProgress>;
  /** model id currently being removed/selected (inline busy). */
  pending: string | null;
  actions: {
    init: () => Promise<void>;
    refresh: () => Promise<void>;
    download: (id: string) => Promise<void>;
    remove: (id: string) => Promise<void>;
    /** Returns whether a memory re-index is required (embedding switch). */
    select: (id: string) => Promise<boolean>;
  };
}

let unlistens: UnlistenFn[] = [];
let started = false;

export const useModelsStore = createSelectors(
  create<ModelsState>((set, get) => ({
    list: [],
    loaded: false,
    downloading: {},
    pending: null,
    actions: {
      init: async () => {
        await get().actions.refresh();
        if (started) return;
        started = true;
        // Progress + completion for BOTH the manager's generic downloads and the
        // memory views' downloads land on the generic event (Rust emits it too),
        // so the table reflects any in-flight download.
        unlistens.push(
          await listenModelProgress((p) =>
            set((s) => ({ downloading: { ...s.downloading, [p.id]: p } })),
          ),
        );
        unlistens.push(
          await listenModelDone((d) => {
            const model = get().list.find((entry) => entry.id === d.id);
            set((s) => {
              const next = { ...s.downloading };
              delete next[d.id];
              return { downloading: next };
            });
            if (model) {
              if (d.success) {
                toast.success(`${model.name} downloaded`);
              } else {
                toast.error(`${model.name} download failed`, {
                  description: d.error ?? undefined,
                });
              }
            }
            void get().actions.refresh();
          }),
        );
        unlistens.push(await listenModelsChanged(() => void get().actions.refresh()));
      },

      refresh: async () => {
        try {
          const list = await models.list();
          set({ list, loaded: true });
        } catch (err) {
          console.error("models.list failed", err);
          set({ loaded: true });
        }
      },

      download: async (id) => {
        // Seed a 0% row immediately so the UI flips to "downloading" without
        // waiting for the first progress tick.
        set((s) => ({
          downloading: {
            ...s.downloading,
            [id]: { id, file: "", fileIndex: 0, fileCount: 1, received: 0, total: 0 },
          },
        }));
        try {
          await models.download(id);
        } catch (err) {
          set((s) => {
            const next = { ...s.downloading };
            delete next[id];
            return { downloading: next };
          });
          throw err;
        }
      },

      remove: async (id) => {
        set({ pending: id });
        try {
          await models.remove(id);
          await get().actions.refresh();
        } finally {
          set({ pending: null });
        }
      },

      select: async (id) => {
        set({ pending: id });
        try {
          const res = await models.select(id);
          await get().actions.refresh();
          return res.needsReindex;
        } finally {
          set({ pending: null });
        }
      },
    },
  })),
);
