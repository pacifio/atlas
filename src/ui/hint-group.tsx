// A row of icon controls sharing one tooltip that slides between them — the
// titlebar dock's tooltip (`components/titlebar-dock.tsx`), usable around any
// toolbar without adopting the dock's pill:
//
//   <HintGroup>
//     <div className="flex gap-1">
//       <HintItem label="Undo"><button …/></HintItem>
//       <HintItem label="Redo"><button …/></HintItem>
//     </div>
//   </HintGroup>
//
// The group adds no DOM, so it can sit outside whatever element lays the row
// out. Each item is an `inline-flex` span around its control: that span is
// what gets measured and hovered, so a Radix trigger or a disabled button
// inside it still works.
//
// The strip is portalled to <body> with fixed positioning because toolbars
// live inside panels that clip their overflow. It is only mounted while the
// group is in use, so a list with one group per row costs nothing until a row
// is hovered.
//
// Timing (delay, warm window, curves) comes from `tooltip-timing.ts`, shared
// with the Base UI tooltips. The titlebar dock uses this same group. It can open
// upward for toolbars at the bottom of a panel. Vertical rails are not
// supported — use `Hint` there.

import {
  cloneElement,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";
import { slideGeometry, type SlideGeometry } from "@/ui/slide-geometry";
import { hintTriggerProps, isFocusVisible } from "@/ui/tooltip";
import {
  isTooltipWarm,
  markTooltipClosed,
  markTooltipOpen,
  prefersReducedMotion,
  slideTransition,
  TOOLTIP_EASE,
  TOOLTIP_CLOSE_DELAY,
  TOOLTIP_FADE_IN_MS,
  TOOLTIP_OPEN_DELAY,
} from "@/ui/tooltip-timing";

/** Unmount the strip this long after it hides, unless the group is back in use. */
const UNMOUNT_AFTER = 500;
const EDGE_MARGIN = 8;
const GAP = 6;

interface Item {
  label: string;
  el: HTMLElement | null;
}

interface GroupApi {
  register: (id: string, item: Item) => void;
  unregister: (id: string) => void;
  enter: (id: string, keyboard?: boolean) => void;
  leave: () => void;
  blur: () => void;
  hide: () => void;
}

const GroupContext = createContext<GroupApi | null>(null);
// Separate from the stable registration API: showing a hint must not unregister its trigger.
const ActiveHintContext = createContext<string | null>(null);

interface State {
  active: string | null;
  visible: boolean;
  /** False for the first reveal: it must appear in place, not fly in. */
  animate: boolean;
}

export function HintGroup({
  side = "bottom",
  children,
}: {
  side?: "top" | "bottom";
  children: ReactNode;
}) {
  const items = useRef(new Map<string, Item>());
  const [version, setVersion] = useState(0);
  const [mounted, setMounted] = useState(false);
  const [state, setState] = useState<State>({ active: null, visible: false, animate: false });
  const [geometry, setGeometry] = useState<(SlideGeometry & { y: number; originX: number }) | null>(
    null,
  );

  const labels = useRef(new Map<string, HTMLDivElement | null>());
  const openTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const unmountTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const visibleRef = useRef(false);
  /** The item a scheduled open is for, and the item currently shown. */
  const pendingId = useRef<string | null>(null);
  const activeId = useRef<string | null>(null);
  const focusedId = useRef<string | null>(null);
  const hoveredId = useRef<string | null>(null);
  const popupHovered = useRef(false);

  const clearTimers = () => {
    pendingId.current = null;
    clearTimeout(openTimer.current);
    clearTimeout(leaveTimer.current);
    clearTimeout(unmountTimer.current);
  };
  const setVisible = useCallback((visible: boolean) => {
    if (visible === visibleRef.current) return;
    visibleRef.current = visible;
    if (visible) markTooltipOpen();
    else markTooltipClosed();
  }, []);

  useEffect(
    () => () => {
      clearTimers();
      setVisible(false);
    },
    [setVisible],
  );

  const hide = useCallback(() => {
    clearTimers();
    activeId.current = null;
    focusedId.current = null;
    hoveredId.current = null;
    popupHovered.current = false;
    setVisible(false);
    setState((s) => (s.visible ? { ...s, visible: false } : s));
    unmountTimer.current = setTimeout(() => setMounted(false), UNMOUNT_AFTER);
  }, [setVisible]);

  const api = useMemo<GroupApi>(
    () => ({
      register: (id, item) => {
        const prev = items.current.get(id);
        items.current.set(id, item);
        if (!prev || prev.label !== item.label || prev.el !== item.el) setVersion((v) => v + 1);
      },
      unregister: (id) => {
        if (items.current.delete(id)) setVersion((v) => v + 1);
        // A control can vanish without a leave or blur (e.g. a clear button
        // that removes itself): don't open for it later, or keep showing it.
        if (pendingId.current === id) {
          clearTimeout(openTimer.current);
          pendingId.current = null;
        }
        if (activeId.current === id) hide();
      },
      enter: (id, keyboard = false) => {
        if (keyboard) focusedId.current = id;
        else hoveredId.current = id;
        clearTimers();
        setMounted(true);
        const travelling = visibleRef.current;
        const show = () => {
          pendingId.current = null;
          activeId.current = id;
          setVisible(true);
          setState({ active: id, visible: true, animate: travelling });
        };
        if (keyboard || travelling || isTooltipWarm()) show();
        else {
          pendingId.current = id;
          openTimer.current = setTimeout(show, TOOLTIP_OPEN_DELAY);
        }
      },
      leave: () => {
        hoveredId.current = null;
        pendingId.current = null;
        clearTimeout(openTimer.current);
        clearTimeout(leaveTimer.current);
        if (focusedId.current && activeId.current !== focusedId.current) {
          const focused = focusedId.current;
          activeId.current = focused;
          setState((s) => ({ ...s, active: focused }));
        }
        if (!focusedId.current && !popupHovered.current) {
          leaveTimer.current = setTimeout(hide, TOOLTIP_CLOSE_DELAY);
        }
      },
      blur: () => {
        focusedId.current = null;
        if (!hoveredId.current && !popupHovered.current) hide();
      },
      hide,
    }),
    [hide, setVisible],
  );

  // Strip order follows the DOM, so the tooltip slides the way the pointer
  // moves. `version` is the dependency that stands for the ref's contents.
  const order = useMemo(() => {
    void version;
    return [...items.current.entries()]
      .sort(([, a], [, b]) => {
        if (!a.el || !b.el) return 0;
        return a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1;
      })
      .map(([id, item]) => ({ id, label: item.label }));
  }, [version]);

  useLayoutEffect(() => {
    if (!state.active || !state.visible) return;
    const control = items.current.get(state.active)?.el?.getBoundingClientRect();
    if (!control) return;
    const index = order.findIndex((o) => o.id === state.active);
    const slide = slideGeometry({
      index,
      widths: order.map((o) => labels.current.get(o.id)?.getBoundingClientRect().width ?? 0),
      controlCentre: control.left + control.width / 2,
      stripLeft: 0,
      viewportWidth: window.innerWidth,
      margin: EDGE_MARGIN,
    });
    if (!slide) return;
    const y = side === "bottom" ? control.bottom + GAP : window.innerHeight - control.top + GAP;
    setGeometry({ ...slide, y, originX: control.left + control.width / 2 });
  }, [state, order, side, mounted]);

  // Escape also works for a pointer-opened hint when focus is elsewhere.
  // Scrolling/resizing invalidates the measured anchor.
  useEffect(() => {
    if (!mounted) return;
    const onScroll = () => hide();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [mounted, hide]);

  const shown = state.visible && geometry !== null;
  // The first reveal grows from the hovered control; travel between items
  // doesn't scale. Reduced motion keeps only the fade.
  const grow = !prefersReducedMotion();

  return (
    <GroupContext.Provider value={api}>
      <ActiveHintContext.Provider value={shown ? state.active : null}>
        {children}
      </ActiveHintContext.Provider>
      {mounted &&
        createPortal(
          <div
            data-slot="hint-group-tooltip"
            className="pointer-events-none fixed left-0 z-tooltip"
            style={{
              ...(side === "bottom" ? { top: geometry?.y ?? 0 } : { bottom: geometry?.y ?? 0 }),
              transformOrigin: `${geometry?.originX ?? 0}px ${side === "bottom" ? "0%" : "100%"}`,
              transform: grow && !shown ? "scale(0.97)" : undefined,
              transition: grow ? `transform ${TOOLTIP_FADE_IN_MS}ms ${TOOLTIP_EASE}` : undefined,
            }}
          >
            <div
              onMouseEnter={() => {
                popupHovered.current = true;
                clearTimeout(leaveTimer.current);
              }}
              onMouseLeave={() => {
                popupHovered.current = false;
                api.leave();
              }}
              className={cn(
                "flex w-max",
                shown && "pointer-events-auto",
                "bg-[var(--popover)] text-foreground",
                "outline outline-1 outline-[var(--border)]",
                // The menu step, like every other popover in `src/ui`. It was a
                // literal 50%-black halo, which is a hole punched in a cream
                // surface on any light theme.
                "shadow-md",
              )}
              style={{
                opacity: shown ? 1 : 0,
                transform: `translateX(${geometry?.tx ?? 0}px)`,
                clipPath: `inset(0 ${geometry?.right ?? 0}% 0 ${geometry?.left ?? 0}% round 6px)`,
                transition: slideTransition({ visible: shown, travel: state.animate }),
              }}
            >
              {order.map(({ id, label }) => (
                <div
                  key={id}
                  id={id}
                  role={shown && state.active === id ? "tooltip" : undefined}
                  aria-hidden={!shown || state.active !== id}
                  ref={(el) => {
                    labels.current.set(id, el);
                  }}
                  className="flex h-[22px] shrink-0 items-center whitespace-nowrap px-2.5 text-xs leading-none"
                >
                  {label}
                </div>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </GroupContext.Provider>
  );
}

/**
 * One control in a `HintGroup`. Outside a group it renders the control
 * unchanged apart from its accessible name, so a shared button component can
 * use it unconditionally.
 */
export function HintItem({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactElement<Record<string, unknown>>;
}) {
  const api = useContext(GroupContext);
  const activeHint = useContext(ActiveHintContext);
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    if (!api) return;
    api.register(id, { label, el: ref.current });
  }, [api, id, label]);
  useEffect(() => {
    if (!api) return;
    return () => api.unregister(id);
  }, [api, id]);

  const control = cloneElement(
    children,
    hintTriggerProps(children.props, label, activeHint === id ? id : undefined),
  );
  if (!api) return control;

  return (
    <span
      ref={ref}
      className={cn("inline-flex [&>:disabled]:pointer-events-none", className)}
      onMouseEnter={() => api.enter(id)}
      onMouseLeave={api.leave}
      onFocus={(e) => {
        // Pointer focus comes with a hover already; only keyboard focus opens.
        if (isFocusVisible(e.target)) api.enter(id, true);
      }}
      onBlur={api.blur}
      onPointerDown={api.hide}
      onKeyDown={(e) => {
        if (e.key === "Escape") api.hide();
      }}
    >
      {control}
    </span>
  );
}
