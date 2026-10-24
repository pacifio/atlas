// The second click a risky action needs: the first press arms the control
// ("Confirm merge?"), the second, on the same element, runs it. Pressing
// elsewhere, Escape, blurring the window or three seconds disarm it.
//
// The second press has to be a second decision: a held Enter's key repeat
// (which activates a focused button again and again) never confirms, and
// neither does a press within `INLINE_CONFIRM_GRACE_MS` of arming.

import { useEffect, useState, type KeyboardEvent, type MouseEvent } from "react";

export const INLINE_CONFIRM_TIMEOUT_MS = 3000;
/** A confirm this soon after arming is a bounce or a repeat, not a choice. */
export const INLINE_CONFIRM_GRACE_MS = 300;

export function useInlineConfirm(scopeKey: string, now: () => number = Date.now) {
  const [armed, setArmed] = useState<{
    scopeKey: string;
    action: string;
    element: HTMLElement;
    at: number;
  } | null>(null);
  const active = armed?.scopeKey === scopeKey ? armed : null;

  useEffect(() => {
    if (!armed) return;
    const disarm = () => setArmed(null);
    if (armed.scopeKey !== scopeKey) {
      disarm();
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !armed.element.contains(event.target)) disarm();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        disarm();
      }
    };
    const timeout = window.setTimeout(disarm, INLINE_CONFIRM_TIMEOUT_MS);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", disarm);
    return () => {
      window.clearTimeout(timeout);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", disarm);
    };
  }, [armed, scopeKey]);

  return {
    isArmed: (action: string) => active?.action === action,
    props: (action: string, onConfirm: () => void) => ({
      // A repeated Enter or Space would activate the button once per repeat;
      // swallowing the repeat leaves only the first press.
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault();
      },
      onClick: (event: MouseEvent<HTMLElement>) => {
        if (active?.action === action && active.element === event.currentTarget) {
          if (now() - active.at < INLINE_CONFIRM_GRACE_MS) return;
          setArmed(null);
          onConfirm();
        } else {
          setArmed({ scopeKey, action, element: event.currentTarget, at: now() });
        }
      },
    }),
  };
}
