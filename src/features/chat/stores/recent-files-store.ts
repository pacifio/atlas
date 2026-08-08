// "Recently opened files" queue. RUST owns the truth — see
// `src-tauri/src/commands/recent_files.rs` — and persists per-project
// to `<project>/.atlas/recent-files.json`. This store is a thin
// in-memory mirror that hydrates from Rust on project change and
// listens for `atlas:recent-files-changed` to stay in sync.
//
// Callers push intents through `actions.push(...)` which invokes the
// Tauri command; the Rust side dedupes, caps, persists, and emits the
// new list back. We mirror locally on event for instant render of the
// mention picker's "Recent files" section.

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { activeWorkspaceId } from "@/features/workspaces/lib/active-workspace";

export interface RecentFile {
  absPath: string;
  rel: string;
  /** Unix ms of the most-recent open. */
  touchedAt: number;
}

interface RecentFilesState {
  items: RecentFile[];
  actions: {
    /** Send a push intent to Rust. The event listener below mirrors
     *  the resulting state back into `items`. Fire-and-forget. */
    push: (entry: { absPath: string; rel: string }) => void;
    clear: () => void;
    /** Replace items from a Rust snapshot (used by the project-change
     *  hydrator in App.tsx). */
    hydrate: (items: RecentFile[]) => void;
  };
}

export const useRecentFilesStore = createSelectors(
  create<RecentFilesState>()((set) => ({
    items: [],
    actions: {
      push: (entry) => {
        const workspaceId = activeWorkspaceId();
        if (!workspaceId) return;
        // Fire-and-forget — the Rust side emits the updated list
        // through the global listener wired in App.tsx.
        void invoke<RecentFile[]>("recent_files_push", {
          absPath: entry.absPath,
          rel: entry.rel,
          workspaceId,
        })
          .then((items) => set({ items }))
          .catch((e) => console.warn("recent_files_push failed:", e));
      },
      clear: () => {
        const workspaceId = activeWorkspaceId();
        if (!workspaceId) return;
        void invoke("recent_files_clear", { workspaceId })
          .then(() => set({ items: [] }))
          .catch((e) => console.warn("recent_files_clear failed:", e));
      },
      hydrate: (items) => set({ items }),
    },
  })),
);

// Singleton event listener — installed lazily on first store read so
// it doesn't fire during SSR / tests that don't touch the store.
let listenerInit = false;
export function ensureRecentFilesListener(): void {
  if (listenerInit) return;
  listenerInit = true;
  void listen<{ workspaceId?: string; project: string; items: RecentFile[] }>(
    "atlas:recent-files-changed",
    (e) => {
      // Only mirror events for the active workspace — a background
      // workspace's push must not overwrite the visible picker.
      const active = activeWorkspaceId();
      if (e.payload.workspaceId && active && e.payload.workspaceId !== active) {
        return;
      }
      useRecentFilesStore.setState({ items: e.payload.items });
    },
  );
}
