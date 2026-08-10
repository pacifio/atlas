// Updater store — drives the titlebar arc/badge and the "Restart to update"
// modal. Fed by Rust events (`atlas:update-*`) wired up once in App.tsx.
//
// The download/verify/stage happens silently in Rust; this store only reflects
// its phase so the UI stays non-blocking (arc in the titlebar while downloading,
// a modal only once the update is staged and ready to restart).

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";

/** Phase of the update pipeline as reflected in the UI. */
export type UpdatePhase =
  | "idle"
  | "downloading" // background download / verify in progress
  | "ready" // staged; restart to apply
  | "applying" // swap + relaunch in progress
  | "error";

interface UpdaterState {
  phase: UpdatePhase;
  version: string | null;
  /** 0..1 download progress (null = indeterminate, e.g. verifying). */
  progress: number | null;
  error: string | null;
  /** True while the backend is checking for an update (titlebar spinner). */
  checking: boolean;
  /** Whether the "Restart to update" modal is open (ready state can be dismissed
   *  to the titlebar badge, then reopened). */
  modalOpen: boolean;
  actions: {
    setDownloading: (version: string, downloaded: number, total: number, phase: string) => void;
    setReady: (version: string) => void;
    setError: (message: string) => void;
    setChecking: (checking: boolean) => void;
    /** Enter the applying (restart) state. */
    beginApply: () => void;
    /** Reopen the "Restart to update" modal from the titlebar badge. */
    openModal: () => void;
    /** Close the modal but keep the ready state (staged update remains). */
    dismissModal: () => void;
    /** Fully reset (e.g. after an update is applied). */
    reset: () => void;
  };
}

const useUpdaterStoreBase = create<UpdaterState>()((set) => ({
  phase: "idle",
  version: null,
  progress: null,
  error: null,
  checking: false,
  modalOpen: false,
  actions: {
    setDownloading: (version, downloaded, total, phase) =>
      set({
        phase: "downloading",
        version,
        progress: phase === "verifying" || total <= 0 ? null : Math.min(1, downloaded / total),
        error: null,
        // Background download must NOT steal focus — no modal here.
        modalOpen: false,
      }),
    setReady: (version) =>
      set({ phase: "ready", version, progress: null, error: null, modalOpen: true }),
    setError: (message) => set({ phase: "error", error: message, modalOpen: true }),
    setChecking: (checking) => set({ checking }),
    beginApply: () => set({ phase: "applying" }),
    openModal: () => set({ modalOpen: true }),
    dismissModal: () => set({ modalOpen: false }),
    reset: () =>
      set({ phase: "idle", version: null, progress: null, error: null, modalOpen: false }),
  },
}));

export const useUpdaterStore = createSelectors(useUpdaterStoreBase);
