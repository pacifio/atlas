/** The notification drawer's day headings. Pure; `now` is passed in. */
import type { AppNotification } from "../stores/notifications-store";

export type { AppNotification };

export interface NotificationDayGroup {
  label: string;
  items: AppNotification[];
}

const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();

/** Today, Yesterday, a weekday within the week, otherwise a short date. */
export function dayBucket(iso: string, now: Date): string {
  const d = new Date(iso);
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Consecutive items sharing a day, in the order given (newest first). */
export function groupNotificationsByDay(
  items: AppNotification[],
  now: Date,
): NotificationDayGroup[] {
  const out: NotificationDayGroup[] = [];
  for (const n of items) {
    const label = dayBucket(n.timestamp, now);
    const last = out[out.length - 1];
    if (last && last.label === label) last.items.push(n);
    else out.push({ label, items: [n] });
  }
  return out;
}
