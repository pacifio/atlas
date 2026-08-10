import { useEffect } from "react";
import { useBrowserOverlayStore } from "../stores/browser-overlay-store";

/**
 * Centralized "is any DOM overlay open?" detector. A native child webview (the
 * embedded browser) paints above the entire HTML layer, so when a popup opens
 * we must hide the webview — no z-index can put the popup on top.
 *
 * One MutationObserver on document.body, active ONLY while a browser embed is
 * live (gated on embedCount), rAF-coalesced. Catches:
 *   [role="dialog"]        — all Radix Dialogs + Popovers (palettes, modals…)
 *   [role="menu"]          — all Radix DropdownMenu + ContextMenu
 *   [data-hint-overlay]    — the hint-nav overlay
 *   [data-browser-suppress]— opt-in marker for custom (non-Radix) overlays
 * Deliberately NOT [role="tooltip"], so hover tooltips don't flash the browser.
 */
const OVERLAY_SELECTOR =
  '[role="dialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper], [data-hint-overlay], [data-browser-suppress], [data-overlay], [data-modal], [data-state="open"][data-side]';

export function BrowserOverlayWatcher() {
  const embedCount = useBrowserOverlayStore.use.embedCount();
  const { setOverlayOpen } = useBrowserOverlayStore.use.actions();

  useEffect(() => {
    if (embedCount <= 0) return;

    let raf = 0;
    const evaluate = () => {
      raf = 0;
      setOverlayOpen(!!document.querySelector(OVERLAY_SELECTOR));
    };
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(evaluate);
    };

    // Initial read (an overlay may already be open when a browser tab opens).
    evaluate();

    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "role",
        "data-state",
        "style",
        "data-browser-suppress",
        "data-overlay",
        "data-modal",
      ],
    });

    return () => {
      if (raf) cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [embedCount, setOverlayOpen]);

  return null;
}
