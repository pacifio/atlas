/**
 * Agent warning rules — pure, explicit state in / state out, no store or Tauri
 * imports. They decide WHEN a warning-tier notification fires; the copy and
 * channels come from `agent-notifier-rules.ts` and the catalog.
 *
 *  - Context window: fires when usage reaches `CONTEXT_WARN_PERCENT`, then
 *    stays quiet until usage drops back below it (compaction) — one per crossing.
 *  - Rate limit: fires when a quota window reaches `RATE_WARN_PERCENT`, once
 *    per window (keyed by its reset time). Quotas are account-level, so this
 *    state is global, not per thread.
 *  - Retry: silent for the first attempt; from the second on, one toast per
 *    retry episode that is updated in place as attempts advance.
 */

import { formatTime } from "@/lib/format-time";

export const CONTEXT_WARN_PERCENT = 90;
export const RATE_WARN_PERCENT = 90;
/** The first retry attempt is silent — most blips clear on their own. */
export const RETRY_NOTIFY_FROM_ATTEMPT = 2;

// --- Context window ------------------------------------------------------

export interface ContextWarnState {
  /** True while usage is below the threshold — the next crossing fires. */
  armed: boolean;
  /** Crossings fired so far; makes each crossing's dedupe key unique. */
  crossings: number;
  /** False until the first observation, which only seeds `armed` — a thread
   *  restored already above the threshold is not a crossing. */
  seeded: boolean;
}

export const INITIAL_CONTEXT_STATE: ContextWarnState = {
  armed: true,
  crossings: 0,
  seeded: false,
};

export interface ContextWarning {
  percent: number;
  crossing: number;
}

export function evaluateContextUsage(
  state: ContextWarnState,
  used: number,
  size: number,
): { state: ContextWarnState; warning: ContextWarning | null } {
  if (!(size > 0) || !Number.isFinite(used)) return { state, warning: null };
  const percent = (used / size) * 100;
  if (!state.seeded) {
    return {
      state: { ...state, seeded: true, armed: percent < CONTEXT_WARN_PERCENT },
      warning: null,
    };
  }
  if (percent < CONTEXT_WARN_PERCENT) {
    return { state: state.armed ? state : { ...state, armed: true }, warning: null };
  }
  if (!state.armed) return { state, warning: null };
  const crossings = state.crossings + 1;
  return {
    state: { armed: false, crossings, seeded: true },
    warning: { percent: Math.min(100, Math.floor(percent)), crossing: crossings },
  };
}

// --- Rate limits ---------------------------------------------------------

export type RateSlot = "primary" | "secondary";

export interface RateWindowInput {
  used_percent: number;
  window_minutes: number | null;
  /** Epoch seconds. */
  resets_at: number | null;
}

export interface RateWarnState {
  /** Window key the slot last warned for; null = not warned (or re-armed). */
  fired: Record<RateSlot, string | null>;
  count: number;
  /** False until the first snapshot, which only records what is already at
   *  the threshold (as fired) without warning. */
  seeded: boolean;
}

export const INITIAL_RATE_STATE: RateWarnState = {
  fired: { primary: null, secondary: null },
  count: 0,
  seeded: false,
};

export interface RateWarning {
  slot: RateSlot;
  percent: number;
  windowMinutes: number | null;
  /** Epoch seconds, when the window reports one. */
  resetsAt: number | null;
  /** Unique per warning — for the dedupe key. */
  seq: number;
}

const UNKNOWN_RESET = "unknown";
/** A window is identified by its reset time, to the minute. */
const windowKey = (resetsAt: number | null) =>
  resetsAt == null ? UNKNOWN_RESET : String(Math.round(resetsAt / 60));

export function evaluateRateLimits(
  state: RateWarnState,
  windows: Record<RateSlot, RateWindowInput | null>,
): { state: RateWarnState; warnings: RateWarning[] } {
  const fired = { ...state.fired };
  let count = state.count;
  const warnings: RateWarning[] = [];
  for (const slot of ["primary", "secondary"] as const) {
    const w = windows[slot];
    if (!w || !Number.isFinite(w.used_percent)) continue;
    if (w.used_percent < RATE_WARN_PERCENT) {
      // A window with no reset time cannot be told apart from its successor,
      // so it re-arms once usage falls; a dated window never re-fires.
      if (fired[slot] === UNKNOWN_RESET) fired[slot] = null;
      continue;
    }
    const key = windowKey(w.resets_at);
    if (fired[slot] === key) continue;
    fired[slot] = key;
    if (!state.seeded) continue;
    count += 1;
    warnings.push({
      slot,
      percent: Math.min(100, Math.floor(w.used_percent)),
      windowMinutes: w.window_minutes,
      resetsAt: w.resets_at,
      seq: count,
    });
  }
  return { state: { fired, count, seeded: true }, warnings };
}

// --- Retry ---------------------------------------------------------------

export interface RetryWarnState {
  /** A retry toast is live for this episode. */
  active: boolean;
  /** Retry episodes so far; part of the toast / dedupe key. */
  episode: number;
}

export const INITIAL_RETRY_STATE: RetryWarnState = { active: false, episode: 0 };

export interface RetryUpdate {
  episode: number;
  /** First notification of the episode (create); otherwise update in place. */
  first: boolean;
}

export function evaluateRetry(
  state: RetryWarnState,
  attempt: number,
): { state: RetryWarnState; update: RetryUpdate | null } {
  if (attempt < RETRY_NOTIFY_FROM_ATTEMPT) {
    // Attempt 1 (or a reset) closes any previous episode; nothing to show.
    return { state: state.active ? { ...state, active: false } : state, update: null };
  }
  if (state.active) {
    return { state, update: { episode: state.episode, first: false } };
  }
  const episode = state.episode + 1;
  return { state: { active: true, episode }, update: { episode, first: true } };
}

/** The turn ended (success, failure, cancel): the episode is over. */
export function endRetryEpisode(state: RetryWarnState): RetryWarnState {
  return state.active ? { ...state, active: false } : state;
}

// --- Copy ----------------------------------------------------------------

/** "5-hour" / "weekly" / "" for a quota window length. */
export function rateWindowLabel(minutes: number | null): string {
  if (!minutes || minutes <= 0) return "";
  if (minutes % 10080 === 0) return minutes === 10080 ? "weekly" : `${minutes / 10080}-week`;
  if (minutes % 1440 === 0) return minutes === 1440 ? "daily" : `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

/** The reset moment in the user's locale: time of day when it is today,
 *  otherwise weekday + time. */
export function formatResetTime(
  resetsAtSec: number,
  now: Date = new Date(),
  locale?: string | string[],
): string {
  const d = new Date(resetsAtSec * 1000);
  const time = formatTime(d, undefined, locale);
  if (d.toDateString() === now.toDateString()) return time;
  const day = d.toLocaleDateString(locale, { weekday: "short" });
  return `${day} ${time}`;
}
