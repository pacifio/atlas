import { invoke } from "@tauri-apps/api/core";

/** Thin IPC wrapper over `src-tauri/src/commands/tips.rs`. Only the tips
 *  store and First run call these. Every command also sends its onboarding
 *  telemetry from Rust (ids only). */

/** Whether this install began after tips existed ("fresh") or before. */
export type TipCohort = "fresh" | "upgrade";

/** How a tip closed: its own button, or waved away. */
export type TipOutcome = "done" | "dismissed";

export interface TipsState {
  version: number;
  cohort: TipCohort;
  /** Tip ids already shown, oldest first. */
  seen: string[];
  /** Get started items done, in order. */
  checklist: string[];
  /** The user closed Get started. */
  checklistDismissed: boolean;
  /** Local dates (`YYYY-MM-DD`) Atlas was opened on, the last week of them. */
  activeDays: string[];
}

/** Rust's `TIPS_CHANGED_EVENT`: the new state, after any window's write. */
export const TIPS_CHANGED_EVENT = "atlas:tips-changed";

/** Load the record; counts today as a day Atlas was used. */
export function loadTips(): Promise<TipsState> {
  return invoke<TipsState>("tips_load");
}

export function reportTipShown(id: string): Promise<void> {
  return invoke("tips_shown", { id });
}

export function markTipSeen(id: string, outcome: TipOutcome): Promise<TipsState> {
  return invoke<TipsState>("tips_mark_seen", { id, outcome });
}

/** Replay all tips: forget every seen tip but `keep`. */
export function resetTips(keep: string[]): Promise<TipsState> {
  return invoke<TipsState>("tips_reset", { keep });
}

export function completeChecklistItem(item: string): Promise<TipsState> {
  return invoke<TipsState>("tips_checklist_done", { item });
}

export function dismissGetStarted(): Promise<TipsState> {
  return invoke<TipsState>("tips_checklist_dismiss");
}

/** First run finished; `keymap` is the preset chosen, "atlas" for Atlas's
 *  own keys, or "later" when the question was put off (Escape included). */
export function reportFirstRunComplete(keymap: string): Promise<void> {
  return invoke("first_run_complete", { keymap });
}
