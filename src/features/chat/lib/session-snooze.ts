/**
 * Snooze presets and custom snooze times, in the user's local calendar.
 *
 * A snoozed session leaves the way until its time, when Rust's wake timer
 * brings it back (`run_snooze_waker`); it comes back early if it raises its
 * hand (a permission, a question, a failure). This module only works out
 * *when*: every answer is an ISO instant for `snoozeSession`.
 *
 * Calendar arithmetic is by local calendar day, never by adding 24 hours: a
 * DST day is 23 or 25 hours long, and a fixed offset would land on the wrong
 * day or hour.
 */

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const EVENING_HOUR = 18;
const MORNING_HOUR = 9;

export type SnoozePresetId = "hour" | "three-hours" | "evening" | "tomorrow" | "next-week";

export interface SnoozePreset {
  id: SnoozePresetId;
  /** "In 1 hour", "This evening"… */
  label: string;
  /** When it lands, in the user's locale: "18:00", "Mon 09:00". */
  whenLabel: string;
  /** ISO instant to pass to `snoozeSession`. */
  until: string;
}

function timeOfDay(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function atHour(base: Date, hour: number): Date {
  const next = new Date(base.getTime());
  next.setHours(hour, 0, 0, 0);
  return next;
}

function addDays(base: Date, days: number): Date {
  const next = new Date(base.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * The presets offered at `now`: In 1 hour, In 3 hours, This evening (18:00,
 * only when that is more than an hour away), Tomorrow (09:00) and Next week
 * (Monday 09:00 — left out on a Sunday, when it would be Tomorrow again).
 */
export function snoozePresets(now: Date): SnoozePreset[] {
  const inAnHour = new Date(now.getTime() + HOUR_MS);
  const inThreeHours = new Date(now.getTime() + 3 * HOUR_MS);
  const presets: SnoozePreset[] = [
    {
      id: "hour",
      label: "In 1 hour",
      whenLabel: timeOfDay(inAnHour),
      until: inAnHour.toISOString(),
    },
    {
      id: "three-hours",
      label: "In 3 hours",
      whenLabel: timeOfDay(inThreeHours),
      until: inThreeHours.toISOString(),
    },
  ];

  const evening = atHour(now, EVENING_HOUR);
  if (evening.getTime() - now.getTime() > HOUR_MS) {
    presets.push({
      id: "evening",
      label: "This evening",
      whenLabel: timeOfDay(evening),
      until: evening.toISOString(),
    });
  }

  const tomorrow = atHour(addDays(now, 1), MORNING_HOUR);
  presets.push({
    id: "tomorrow",
    label: "Tomorrow",
    whenLabel: timeOfDay(tomorrow),
    until: tomorrow.toISOString(),
  });

  const daysUntilMonday = (1 - now.getDay() + 7) % 7 || 7;
  const nextWeek = atHour(addDays(now, daysUntilMonday), MORNING_HOUR);
  if (nextWeek.getTime() !== tomorrow.getTime()) {
    presets.push({
      id: "next-week",
      label: "Next week",
      whenLabel: `${nextWeek.toLocaleDateString(undefined, { weekday: "short" })} ${timeOfDay(nextWeek)}`,
      until: nextWeek.toISOString(),
    });
  }
  return presets;
}

export type CustomSnooze =
  | { mode: "date"; /** `YYYY-MM-DD`, local */ date: string; /** `HH:MM`, local */ time: string }
  | { mode: "duration"; amount: string; unit: "minutes" | "hours" | "days" };

/**
 * A custom snooze as an ISO instant, or `null` when it is not a valid time in
 * the future — a malformed or impossible date (Feb 30, a time skipped by DST)
 * or a non-positive duration.
 */
export function customSnoozeUntil(input: CustomSnooze, now: Date): string | null {
  let wake: Date;
  if (input.mode === "duration") {
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const unitMs = { minutes: 60_000, hours: HOUR_MS, days: DAY_MS }[input.unit];
    wake = new Date(now.getTime() + amount * unitMs);
  } else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !/^\d{2}:\d{2}$/.test(input.time)) return null;
    wake = new Date(`${input.date}T${input.time}:00`);
    // A rolled-over date or a nonexistent local time reads back differently.
    if (localDate(wake) !== input.date || localTime(wake) !== input.time) return null;
  }
  return Number.isFinite(wake.getTime()) && wake.getTime() > now.getTime()
    ? wake.toISOString()
    : null;
}

export function localDate(date: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function localTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** How long until a snooze wakes, compactly: "45m", "3h", "2d", or "now". */
export function snoozeRemainingLabel(until: string, now: Date): string {
  const remaining = Date.parse(until) - now.getTime();
  if (Number.isNaN(remaining) || remaining <= 0) return "now";
  if (remaining < HOUR_MS) return `${Math.max(1, Math.ceil(remaining / 60_000))}m`;
  if (remaining < DAY_MS) return `${Math.ceil(remaining / HOUR_MS)}h`;
  return `${Math.ceil(remaining / DAY_MS)}d`;
}
