/**
 * "Is Atlas actually in front of the user?" — one answer for the whole app.
 *
 * Tracked via the NATIVE window focus, NOT web focus/blur. The web events keep
 * reporting "focused" when Atlas is fullscreen on its own macOS Space and the
 * user swipes to another desktop (the webview never blurs), so notifications
 * would wrongly stay suppressed. The native key-window status flips correctly
 * on a Space switch / app deactivation, which is the signal that matters.
 *
 * This used to be a closure local inside one `App.tsx` effect, readable by
 * nothing else. The chat notifications and the terminal notifier both need it,
 * so it is a module now. `App.tsx` calls `initWindowFocusTracking()` once.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";

let focused = true;
let lastInteractionAt = Date.now();
const listeners = new Set<(focused: boolean) => void>();

export function isWindowFocused(): boolean {
  return focused;
}

/** Wall-clock ms of the last discrete input (pointer, key, wheel). */
export function lastInteraction(): number {
  return lastInteractionAt;
}

export function interactedWithin(ms: number, now = Date.now()): boolean {
  return now - lastInteractionAt < ms;
}

/** Fires on every native focus transition, with the new state. */
export function onWindowFocusChange(cb: (focused: boolean) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function setFocused(next: boolean): void {
  if (next === focused) return;
  focused = next;
  for (const l of listeners) {
    try {
      l(next);
    } catch (e) {
      console.warn("window-focus listener failed:", e);
    }
  }
}

/**
 * Start tracking. Returns a stop function. Also fires `atlas:window-active`
 * on the focus RISING edge and on the page becoming visible — the "cold wake"
 * signal the chat pipeline warms itself on.
 */
export function initWindowFocusTracking(): () => void {
  const signalActive = () => window.dispatchEvent(new CustomEvent("atlas:window-active"));
  let unlistenFocus: (() => void) | null = null;
  let disposed = false;
  const appWindow = getCurrentWindow();
  void appWindow
    .isFocused()
    .then((f) => {
      if (!disposed) setFocused(f);
    })
    .catch(() => {});
  void appWindow
    .onFocusChanged(({ payload }) => {
      if (payload && !focused) signalActive();
      setFocused(payload);
    })
    .then((un) => {
      if (disposed) un();
      else unlistenFocus = un;
    })
    .catch(() => {});
  // Space switches / occlusion don't always flip native key-window focus, so
  // also wake on the page becoming visible again.
  const onVisible = () => {
    if (document.visibilityState === "visible") signalActive();
  };
  document.addEventListener("visibilitychange", onVisible);

  // Discrete inputs only (not pointermove) to keep this effectively free.
  const onUserActivity = () => {
    lastInteractionAt = Date.now();
  };
  window.addEventListener("pointerdown", onUserActivity, { passive: true });
  window.addEventListener("keydown", onUserActivity, { passive: true });
  window.addEventListener("wheel", onUserActivity, { passive: true });

  return () => {
    disposed = true;
    unlistenFocus?.();
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("pointerdown", onUserActivity);
    window.removeEventListener("keydown", onUserActivity);
    window.removeEventListener("wheel", onUserActivity);
  };
}
