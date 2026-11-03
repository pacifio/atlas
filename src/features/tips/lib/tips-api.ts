import { invoke } from "@tauri-apps/api/core";

/** Thin IPC wrapper over `src-tauri/src/commands/tips.rs`. Only the tips
 *  store calls these. */

/** Whether this install began after tips existed ("fresh") or before. */
export type TipCohort = "fresh" | "upgrade";

export interface TipsState {
  version: number;
  cohort: TipCohort;
  /** Tip ids already shown, oldest first. */
  seen: string[];
}

/** Rust's `TIPS_CHANGED_EVENT`: the new state, after any window's write. */
export const TIPS_CHANGED_EVENT = "atlas:tips-changed";

export function loadTips(): Promise<TipsState> {
  return invoke<TipsState>("tips_load");
}

export function markTipsSeen(ids: string[]): Promise<TipsState> {
  return invoke<TipsState>("tips_mark_seen", { ids });
}

/** Replay all tips: forget every seen tip but `keep`. */
export function resetTips(keep: string[]): Promise<TipsState> {
  return invoke<TipsState>("tips_reset", { keep });
}
