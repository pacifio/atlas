/**
 * "Is this surface showing AND caught up?"
 *
 * A chat tab that is not the one showing in its column stays MOUNTED AND LAID
 * OUT (`visibility:hidden` — see the chat wrapper in `center-panel.tsx`),
 * which is what makes switching back to a long thread instant. The transcript
 * freezes while hidden so a background thread costs nothing per streaming
 * chunk; this hook decides when it unfreezes.
 *
 * Not on the frame the tab becomes visible. That frame is already the most
 * expensive one of a tab switch, and dropping a thread's worth of new rows
 * into it puts back the stall the whole arrangement exists to remove. One
 * frame later the switch has painted and the catch-up is on its own.
 *
 * Going hidden is immediate — there is nothing to defer, and every frame spent
 * still live is frame budget taken from whatever the reader IS looking at.
 */

import { useEffect, useState } from "react";

/** How long to wait for the animation frame before catching up on a timer.
 *  Only ever reached when WebKit has rAF paused (the webview is not
 *  frontmost); short enough that stale content is never something a reader can
 *  sit and look at. */
export const THAW_BACKSTOP_MS = 100;

export function useThawed(visible: boolean): boolean {
  const [thawed, setThawed] = useState(visible);

  useEffect(() => {
    if (!visible) {
      setThawed(false);
      return;
    }
    // rAF for the common case, a timer as the backstop. WebKit PAUSES rAF
    // whenever the webview is not frontmost, and a thaw that never fires is a
    // surface stuck on stale content — the one failure mode worse than the
    // stall this is avoiding. Locals rather than refs: a cancelled id latched
    // in a ref is exactly how a StrictMode remount froze streaming once
    // already (see the rAF-latch note in `App.tsx`).
    const raf = requestAnimationFrame(() => setThawed(true));
    const backstop = window.setTimeout(() => setThawed(true), THAW_BACKSTOP_MS);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(backstop);
    };
  }, [visible]);

  return visible && thawed;
}
