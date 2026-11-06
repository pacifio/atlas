import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

/**
 * The composer footer's dropup grammar, in one place.
 *
 * Three pills (Options, Plan, Usage) open a right-anchored panel above the
 * composer that morphs to its content's height, closes on Escape / a click
 * outside, and yields to whichever sibling opens next. Options and Plan each
 * carried a private copy of that machinery; a third copy for Usage was the
 * point at which it became a component.
 *
 * Behaviour is unchanged from the copies it replaces:
 * - The panel stays MOUNTED while closed, pinned to `height: 0`, so opening is
 *   a height tween rather than a mount. Content that runs an infinite
 *   animation must gate it on `open` itself (see `StepIcon` in the plan pill).
 * - The content is only measured while open — observing a closed panel just
 *   re-measures under every store delta for nothing.
 * - Mutual exclusion is a window event: opening dispatches
 *   `atlas:composer-menu-open` with this menu's id, and every other open menu
 *   closes on hearing an id that is not its own. The + menu and the groups
 *   menu speak the same event.
 */

// The pill class strings live in a pure module so views can use them; they are
// re-exported here for the containers that already import them from this file.
export { composerPillClass, composerPillLabelClass } from "../lib/composer-pill-class";

export interface ComposerDropupState {
  open: boolean;
  toggle: () => void;
  close: () => void;
  /** Put on the pill's wrapper: the click-outside test is "inside this". */
  ref: RefObject<HTMLDivElement | null>;
  /** Put on the panel's content: what the height tween measures. */
  contentRef: RefObject<HTMLDivElement | null>;
  panelHeight: number;
}

export function useComposerDropup(
  menuId: string,
  opts: {
    /** A disabled pill has nothing to open; if it was open, it closes. */
    disabled?: boolean;
    /** Re-measure when this changes (a list that grows while open). */
    measureKey?: unknown;
  } = {},
): ComposerDropupState {
  const { disabled = false, measureKey } = opts;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [panelHeight, setPanelHeight] = useState(0);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onOther = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== menuId) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("atlas:composer-menu-open", onOther);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("atlas:composer-menu-open", onOther);
    };
  }, [open, menuId]);

  useEffect(() => {
    if (!open) return;
    const el = contentRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPanelHeight(el.offsetHeight));
    ro.observe(el);
    setPanelHeight(el.offsetHeight);
    return () => ro.disconnect();
  }, [open, measureKey]);

  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  const toggle = useCallback(() => {
    if (disabled) return;
    setOpen((cur) => {
      if (cur) return false;
      window.dispatchEvent(new CustomEvent("atlas:composer-menu-open", { detail: menuId }));
      return true;
    });
  }, [disabled, menuId]);
  const close = useCallback(() => setOpen(false), []);

  return { open, toggle, close, ref, contentRef, panelHeight };
}

/** The morphing panel. Render it as the first child of the pill's wrapper. */
export function ComposerDropup({
  open,
  panelHeight,
  contentRef,
  width = 300,
  children,
}: {
  open: boolean;
  panelHeight: number;
  contentRef: RefObject<HTMLDivElement | null>;
  width?: number;
  children: ReactNode;
}) {
  return (
    <div
      aria-hidden={!open}
      className="absolute bottom-full right-0 z-popover mb-1.5 overflow-hidden rounded-xl border border-border bg-card shadow-md"
      style={{
        width,
        height: open ? panelHeight : 0,
        opacity: open ? 1 : 0,
        pointerEvents: open ? "auto" : "none",
        transition: "height 260ms cubic-bezier(0.32,0.72,0,1), opacity 180ms ease-out",
      }}
    >
      <div ref={contentRef}>{children}</div>
    </div>
  );
}
