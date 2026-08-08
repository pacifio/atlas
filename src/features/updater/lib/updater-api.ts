import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface UpdateStatus {
  available: boolean;
  version: string | null;
  currentVersion: string;
}

/** Snapshot for UI hydration on mount. `phase`: "idle" | "downloading" | "ready". */
export interface UpdaterSnapshot {
  phase: string;
  version: string | null;
  currentVersion: string;
}

export interface UpdateAvailable {
  version: string;
  currentVersion: string;
}

export interface UpdateProgress {
  version: string;
  downloaded: number;
  total: number;
  /** "downloading" | "verifying" */
  phase: string;
}

export interface UpdateReady {
  version: string;
}

export interface UpdateApplied {
  version: string;
}

export interface UpdateError {
  message: string;
}

export interface UpdateChecking {
  checking: boolean;
}

export const updater = {
  /** Manual "Check for updates" — bypasses the auto-update/ignored gates. */
  checkNow: () => invoke<UpdateStatus>("update_check_now"),
  /** Current updater state (for hydrating the UI on mount). */
  state: () => invoke<UpdaterSnapshot>("update_state"),
  /** Restart now: swap the staged update in and relaunch. */
  apply: () => invoke<void>("update_apply"),
  /** Persist "don't prompt for this version again". */
  ignore: (version: string) => invoke<void>("update_ignore", { version }),
};

export const listenUpdateProgress = (handler: (e: UpdateProgress) => void): Promise<UnlistenFn> =>
  listen<UpdateProgress>("atlas:update-progress", (e) => handler(e.payload));

export const listenUpdateReady = (handler: (e: UpdateReady) => void): Promise<UnlistenFn> =>
  listen<UpdateReady>("atlas:update-ready", (e) => handler(e.payload));

export const listenUpdateApplied = (handler: (e: UpdateApplied) => void): Promise<UnlistenFn> =>
  listen<UpdateApplied>("atlas:update-applied", (e) => handler(e.payload));

export const listenUpdateError = (handler: (e: UpdateError) => void): Promise<UnlistenFn> =>
  listen<UpdateError>("atlas:update-error", (e) => handler(e.payload));

export const listenUpdateChecking = (handler: (e: UpdateChecking) => void): Promise<UnlistenFn> =>
  listen<UpdateChecking>("atlas:update-checking", (e) => handler(e.payload));
