/**
 * The dock icon's badge — the count of unread notifications while Atlas is in
 * the background, cleared the moment it comes to the front.
 *
 * Needs `core:window:allow-set-badge-count` in the Tauri capability; without
 * it the call rejects and this stays silent.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";

let last: number | null = null;

export function setDockBadge(count: number): void {
  const next = count > 0 ? count : 0;
  if (next === last) return;
  last = next;
  void getCurrentWindow()
    .setBadgeCount(next > 0 ? next : undefined)
    .catch(() => {});
}
