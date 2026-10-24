import { useLayoutEffect, useState } from "react";

/**
 * The horizontal midpoint (viewport px) of the centre panel — the content area
 * right of the project switcher / left sidebar.
 *
 * For a docked pill or a dialog, "centred" means centred on what the user is
 * looking at, and that is the content, not the window: `fixed left-1/2` puts
 * the pill half a side panel off once one is open. Measured from the DOM
 * rather than derived from the layout store because the panels are resizable
 * and there are several of them per side; the panel's own rect is the one
 * number that is right by construction.
 *
 * `null` when there is no centre panel (projectless window) — callers fall
 * back to the viewport centre.
 */
export function useCenterPanelCenterX(): number | null {
  const [x, setX] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = document.querySelector<HTMLElement>("[data-atlas-center-panel]");
    if (!el) {
      setX(null);
      return;
    }
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setX(rect.left + rect.width / 2);
    };
    measure();
    // A side panel opening or resizing changes the panel's width; the window
    // resizing changes both. Observing the panel covers the first, the
    // listener the second.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  return x;
}
