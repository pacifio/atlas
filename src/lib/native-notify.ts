/**
 * macOS notifications, behind one permission state machine and one focus gate.
 *
 * Permission is primed EAGERLY at startup (`primeNativeNotificationPermission`).
 * The old lazy path only asked the OS the first time a notification fired while
 * unfocused — so if every agent turn finished while Atlas was focused, the
 * first real background notification was lost to the permission prompt.
 *
 * Every sender goes through `sendNativeNotification`, which refuses while the
 * window is focused (see `window-focus.ts` for why that is the native focus,
 * not the web one). Callers therefore never need their own gate.
 *
 * Known limit: the desktop notification plugin has no click callback (it
 * shells out to notify_rust with no delegate), so a click only activates the
 * app. In-app surfaces carry the click-to-focus.
 */
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { isWindowFocused } from "./window-focus";

type PermissionState = "unknown" | "granted" | "denied";
let permission: PermissionState = "unknown";
let priming: Promise<PermissionState> | null = null;

export function primeNativeNotificationPermission(): Promise<PermissionState> {
  if (permission !== "unknown") return Promise.resolve(permission);
  if (priming) return priming;
  priming = (async () => {
    try {
      permission = (await isPermissionGranted())
        ? "granted"
        : (await requestPermission()) === "granted"
          ? "granted"
          : "denied";
    } catch {
      // Permission unavailable — notifications silently no-op.
      permission = "denied";
    }
    priming = null;
    return permission;
  })();
  return priming;
}

export interface NativeNotification {
  title: string;
  body: string;
  /** A macOS system sound name (e.g. "Ping"), or omit for silent. */
  sound?: string;
}

/**
 * Send if the window is not focused and permission is granted. Resolves to
 * whether anything was shown. Never throws.
 */
export async function sendNativeNotification(n: NativeNotification): Promise<boolean> {
  if (isWindowFocused()) return false;
  try {
    if ((await primeNativeNotificationPermission()) !== "granted") return false;
    sendNotification({ title: n.title, body: n.body, sound: n.sound });
    return true;
  } catch (e) {
    console.warn("native notification failed:", e);
    return false;
  }
}
