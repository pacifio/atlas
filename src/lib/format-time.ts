/**
 * Times of day in the user's `timeFormat`: a 12- or 24-hour clock, or the
 * system's. Every place Atlas shows a time goes through here, so the setting
 * reaches all of them.
 *
 * The format is held here rather than read from the settings store, so these
 * pure helpers stay importable anywhere (tests included) without pulling in
 * the store and its IPC. The settings store pushes it in with
 * `setTimeFormat` on load and on every change; a view shows it on its next
 * render.
 */

export type TimeFormat = "system" | "12h" | "24h";

let current: TimeFormat = "system";

export function setTimeFormat(format: TimeFormat): void {
  current = format;
}

export function timeFormat(): TimeFormat {
  return current;
}

/** `hourCycle` for the active format; nothing for "system", so the locale
 *  decides. Not `hour12: false`: some engines read that as the `h24` cycle for
 *  a 12-hour locale and print midnight as "24:05". */
export function hourCycle(): { hourCycle?: "h12" | "h23" } {
  if (current === "12h") return { hourCycle: "h12" };
  if (current === "24h") return { hourCycle: "h23" };
  return {};
}

type DateInput = Date | number | string;

const SHORT_TIME: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };

const TIME_FIELDS = ["hour", "minute", "second", "dayPeriod", "fractionalSecondDigits"] as const;
const DATE_FIELDS = ["weekday", "year", "month", "day"] as const;

/**
 * The fields `toLocaleTimeString` / `toLocaleDateString` / `toLocaleString`
 * fill in when the caller names none (ECMA-402 `ToDateTimeOptions`), so a
 * cached formatter prints exactly what the `toLocale*` call it replaces did.
 */
function withDefaults(
  options: Intl.DateTimeFormatOptions,
  kind: "time" | "date" | "any",
): Intl.DateTimeFormatOptions {
  if (options.dateStyle || options.timeStyle) return options;
  const hasTime = TIME_FIELDS.some((f) => options[f] !== undefined);
  const hasDate = DATE_FIELDS.some((f) => options[f] !== undefined);
  if (kind === "time" && !hasTime)
    return { ...options, hour: "numeric", minute: "numeric", second: "numeric" };
  if (kind === "date" && !hasDate)
    return { ...options, year: "numeric", month: "numeric", day: "numeric" };
  if (kind === "any" && !hasTime && !hasDate)
    return {
      ...options,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    };
  return options;
}

const adhocFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * A `toLocale*String` call, with its `Intl.DateTimeFormat` built once.
 *
 * Every `toLocale*String` constructs a formatter, and constructing one costs
 * far more than calling one — ~0.25ms each. That is invisible for one label
 * and was the single largest cost of mounting a long Session's timeline:
 * every row prints its time, and a comment jump that mounted seven hundred
 * rows spent ~200ms in this function alone. The key carries the options and
 * the locale, and the caller's hour cycle is already folded into the options,
 * so flipping the 12h/24h setting builds a new formatter rather than reusing a
 * stale one.
 */
export function formatWith(
  at: DateInput,
  options: Intl.DateTimeFormatOptions,
  kind: "time" | "date" | "any",
  locale?: string | string[],
): string {
  const date = new Date(at);
  // What `toLocale*String` prints for an invalid date; `format` would throw.
  if (Number.isNaN(date.getTime())) return "Invalid Date";
  const key = `${kind}|${String(locale ?? "")}|${JSON.stringify(options)}`;
  let formatter = adhocFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, withDefaults(options, kind));
    adhocFormatters.set(key, formatter);
  }
  return formatter.format(date);
}

/** A time of day, e.g. "3:07 PM" or "15:07". `options` picks the fields. */
export function formatTime(
  at: DateInput,
  options: Intl.DateTimeFormatOptions = SHORT_TIME,
  locale?: string | string[],
): string {
  return formatWith(at, { ...options, ...hourCycle() }, "time", locale);
}

/** A date with its time, e.g. "Oct 22, 2026, 3:07 PM". */
export function formatDateTime(
  at: DateInput,
  options?: Intl.DateTimeFormatOptions,
  locale?: string | string[],
): string {
  return formatWith(at, { ...options, ...hourCycle() }, "any", locale);
}

/**
 * The message-timestamp formats, by name. Each is built once per locale and
 * hour cycle and reused (`cachedFormatter`): a transcript formats one per
 * visible message on every render, and constructing an `Intl.DateTimeFormat`
 * costs far more than calling one.
 */
const MESSAGE_FORMATS = {
  time: { hour: "numeric", minute: "2-digit" },
  monthDay: { month: "numeric", day: "numeric" },
  monthDayYear: { month: "numeric", day: "numeric", year: "numeric" },
  full: {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  },
} satisfies Record<string, Intl.DateTimeFormatOptions>;

type MessageFormat = keyof typeof MESSAGE_FORMATS;

/** Only these carry a time, so only these take the user's hour cycle. */
const TIMED: ReadonlySet<MessageFormat> = new Set<MessageFormat>(["time", "full"]);

const formatters = new Map<string, Intl.DateTimeFormat>();

function cachedFormatter(
  name: MessageFormat,
  locale: string | string[] | undefined,
): Intl.DateTimeFormat {
  const timed = TIMED.has(name);
  // The hour cycle is part of the key, so flipping the 12h/24h setting picks
  // up a new formatter rather than reusing a stale one.
  const key = `${name}|${String(locale ?? "")}|${timed ? current : ""}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      ...MESSAGE_FORMATS[name],
      ...(timed ? hourCycle() : {}),
    });
    formatters.set(key, formatter);
  }
  return formatter;
}

/**
 * A message's time, as short as it can be without hiding the day: "4:34 PM"
 * for today, "yesterday at 4:34 PM", "10/22 4:34 PM" for another day this year
 * and "10/22/2025 4:34 PM" for another year. Days are compared at local
 * midnight, so a DST day of 23 or 25 hours still counts as one. A bare time
 * means the same calendar day and nothing else: a date ahead of this clock (a
 * skewed agent, a wrong system clock) gets its date too.
 *
 * `now` is a parameter so a test can pin it. The caller formats on every
 * render, but nothing re-renders a row at midnight or when the 12h/24h setting
 * changes, and a settled row seldom renders again — so a row that stays
 * mounted keeps the label it last rendered with. That is the cheap side of the
 * trade against a ticking clock in every row.
 */
export function formatDayAwareTime(
  at: DateInput,
  now: DateInput = Date.now(),
  locale?: string | string[],
): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const time = cachedFormatter("time", locale).format(date);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOfToday - startOfDay) / 86_400_000);
  if (days === 0) return time;
  if (days === 1) return `yesterday at ${time}`;
  const sameYear = date.getFullYear() === today.getFullYear();
  const day = cachedFormatter(sameYear ? "monthDay" : "monthDayYear", locale).format(date);
  return `${day} ${time}`;
}

/** The whole date and time, for the tooltip behind a short timestamp:
 *  "Thursday, October 22, 2026 at 4:34 PM". */
export function formatFullTimestamp(at: DateInput, locale?: string | string[]): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return cachedFormatter("full", locale).format(date);
}
