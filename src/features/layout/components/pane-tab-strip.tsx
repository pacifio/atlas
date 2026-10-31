import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { HintItem } from "@/ui/hint-group";
import { IconButton } from "@/ui/icon-button";
import type { Tab } from "../stores/layout-store";
import { SortablePaneTab } from "./pane-tab";

/** How far the pointer must travel before a press on a tab becomes a drag.
 *  Below it the press is a click, so selecting, middle-click and the
 *  right-click menu never start one. */
export const TAB_DRAG_ACTIVATION_DISTANCE = 6;

/** The width of the fade at an edge with more tabs past it. A tab scrolled
 *  into view clears it, so the active tab is never half under the fade. */
export const TAB_STRIP_FADE_PX = 20;

/** Sub-pixel slack: at a fractional UI scale the true end of the scroll lands
 *  a hair short of `scrollWidth`, which would leave a fade on forever. */
const EDGE_TOLERANCE = 1;

/** A tab moves along its own strip and nowhere else: not off the row, and not
 *  past the strip's ends into the controls beside it. */
const TAB_DRAG_MODIFIERS = [restrictToHorizontalAxis, restrictToFirstScrollableAncestor];

interface StripScroll {
  overflow: boolean;
  canLeft: boolean;
  canRight: boolean;
}

const NO_OVERFLOW: StripScroll = { overflow: false, canLeft: false, canRight: false };

/**
 * The `scrollLeft` that brings a tab fully into the viewport, clear of the
 * edge fades, moving as little as possible. Positions are in the scroller's
 * content coordinates (0 is the strip's first pixel, not the viewport's).
 */
export function scrollLeftToReveal(
  scrollLeft: number,
  viewportWidth: number,
  tabStart: number,
  tabEnd: number,
  pad: number = TAB_STRIP_FADE_PX,
): number {
  if (tabStart - pad < scrollLeft) return Math.max(0, tabStart - pad);
  if (tabEnd + pad > scrollLeft + viewportWidth) return tabEnd + pad - viewportWidth;
  return scrollLeft;
}

/** The fades for the edges that have tabs past them, as a mask: a mask needs
 *  no colour, so it fades into whatever the header paints. */
function fadeMask({ canLeft, canRight }: StripScroll): string | undefined {
  if (!canLeft && !canRight) return undefined;
  const left = canLeft ? `transparent, black ${TAB_STRIP_FADE_PX}px` : "black, black";
  const right = canRight
    ? `black calc(100% - ${TAB_STRIP_FADE_PX}px), transparent`
    : "black, black";
  return `linear-gradient(to right, ${left}, ${right})`;
}

/**
 * A column's tab strip: its tabs, dragged to reorder, scrolled when they do
 * not fit.
 *
 * - **Reorder.** dnd-kit's sortable list, pointer only, with an activation
 *   distance so a click is never a drag. A tab stays in its strip, its column
 *   and its axis (`TAB_DRAG_MODIFIERS`); there is no dragging between panes.
 *   The order lands in the layout store (`moveTab`), which is the column's
 *   order everywhere, and is saved with the project's layout.
 * - **Overflow.** The tabs scroll inside their own viewport; whatever sits
 *   after the strip in the header (the `+`, maximize, the dock buttons) is
 *   outside it and never scrolls away. An edge with more tabs past it fades,
 *   the scroll arrows appear, a vertical wheel scrolls sideways, and the
 *   active tab is scrolled into view whenever it changes.
 */
export function PaneTabStrip({
  tabs,
  activeId,
  focused,
  runningTabIds,
  onSelect,
  onMove,
}: {
  /** The column's tabs, in order. */
  tabs: readonly Tab[];
  activeId: string | null;
  /** Whether this column has focus: only then is its active tab fully lit. */
  focused: boolean;
  runningTabIds: ReadonlySet<string>;
  /** Stable: the tabs are memoized on it. */
  onSelect: (id: string) => void;
  onMove: (id: string, toIndex: number) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState<StripScroll>(NO_OVERFLOW);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: TAB_DRAG_ACTIVATION_DISTANCE } }),
  );
  const ids = useMemo(() => tabs.map((t) => t.id), [tabs]);
  const handleDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      if (!over || active.id === over.id) return;
      const toIndex = ids.indexOf(String(over.id));
      if (toIndex >= 0) onMove(String(active.id), toIndex);
    },
    [ids, onMove],
  );

  const measure = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const overflow = el.scrollWidth - el.clientWidth > EDGE_TOLERANCE;
    const canLeft = overflow && el.scrollLeft > EDGE_TOLERANCE;
    const canRight = overflow && el.scrollLeft + el.clientWidth < el.scrollWidth - EDGE_TOLERANCE;
    // Same-value guard: `scroll` fires every frame of a scroll.
    setScroll((cur) =>
      cur.overflow === overflow && cur.canLeft === canLeft && cur.canRight === canRight
        ? cur
        : { overflow, canLeft, canRight },
    );
  }, []);

  // Re-measured on scroll and on resize of the viewport or its row: the strip
  // can start overflowing without anyone scrolling it (the panel narrows, a
  // tab opens, a title loads).
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [measure]);

  // A mouse wheel only scrolls vertically; the strip only scrolls sideways.
  // Only claimed while there is somewhere to go, so a page under a strip that
  // fits still scrolls.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return;
      let delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
      if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= el.clientWidth;
      if (delta === 0) return;
      const before = el.scrollLeft;
      el.scrollLeft += delta;
      if (el.scrollLeft === before) return;
      e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // The active tab, scrolled into view whenever it changes or the strip
  // starts overflowing: one opened off the end, or picked with ⌘1–9, is never
  // left out of sight. Before paint, so the strip does not visibly jump.
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el || !activeId || !scroll.overflow) return;
    const tab = Array.from(el.querySelectorAll<HTMLElement>("[data-tab-id]")).find(
      (node) => node.dataset.tabId === activeId,
    );
    if (!tab) return;
    const view = el.getBoundingClientRect();
    const rect = tab.getBoundingClientRect();
    const start = rect.left - view.left + el.scrollLeft;
    const next = scrollLeftToReveal(el.scrollLeft, el.clientWidth, start, start + rect.width);
    if (next !== el.scrollLeft) el.scrollLeft = next;
  }, [activeId, scroll.overflow]);

  const scrollBy = (direction: -1 | 1) => {
    const el = viewportRef.current;
    if (!el) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({
      left: direction * Math.max(120, el.clientWidth * 0.75),
      behavior: reduce ? "auto" : "smooth",
    });
  };

  const mask = fadeMask(scroll);

  return (
    <>
      <div
        ref={viewportRef}
        role="tablist"
        data-pane-tab-strip
        className="flex min-w-0 shrink items-center overflow-x-auto hide-scrollbar"
        style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
      >
        {/* The row is its own box so the viewport can watch it grow. */}
        <div className="flex w-max items-center gap-0.5">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={TAB_DRAG_MODIFIERS}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
              {tabs.map((tab) => (
                <SortablePaneTab
                  key={tab.id}
                  tab={tab}
                  active={tab.id === activeId}
                  focused={focused}
                  running={runningTabIds.has(tab.id)}
                  onSelect={onSelect}
                  menu
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
      </div>
      {scroll.overflow && (
        <div role="group" aria-label="Scroll tabs" className="flex shrink-0 items-center">
          <HintItem label="Scroll tabs left">
            <IconButton
              icon={ChevronLeft}
              label="Scroll tabs left"
              size="xs"
              disabled={!scroll.canLeft}
              onClick={() => scrollBy(-1)}
            />
          </HintItem>
          <HintItem label="Scroll tabs right">
            <IconButton
              icon={ChevronRight}
              label="Scroll tabs right"
              size="xs"
              disabled={!scroll.canRight}
              onClick={() => scrollBy(1)}
            />
          </HintItem>
        </div>
      )}
    </>
  );
}
