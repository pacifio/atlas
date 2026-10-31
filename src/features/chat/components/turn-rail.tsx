// The turn rail: a column of short ticks in the gutter left of the transcript,
// one per turn. Hovering a tick previews its prompt and the start of the reply;
// clicking it jumps there. The ticks whose prompt is on screen are lit.
//
// Layout. The transcript is capped at the reading column's width (its parent in
// `chat-panel.tsx` centres it), so the gutter is OUTSIDE the transcript box. The
// rail hangs left into it, absolutely positioned and anchored to the left edge
// of the row the column is centred in. It takes no space: nothing about the
// column's width or position depends on whether the rail is showing. A gutter
// too narrow for it leaves the rail inert and invisible; one too narrow to keep
// it showing reveals it on hover only.
//
// Scrolling never re-renders the transcript for this. Which prompts are in view
// comes from an IntersectionObserver on the user rows, so the scroll path does
// no work at all; a crossing writes `data-in-view` on that tick's element
// directly, and only a change of the CURRENT turn (which moves the
// previous/next targets) is React state, held here rather than in the
// transcript.

import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
} from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { IconButton } from "@/ui/icon-button";
import { Hint } from "@/ui/tooltip";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import {
  resolveTurnRailCurrentIndex,
  resolveTurnRailHasPersistentGutter,
  resolveTurnRailHeightStyle,
  resolveTurnRailHitStripWidth,
  resolveTurnRailIndexFromPointer,
  resolveTurnRailInteractiveWidth,
  resolveTurnRailNavigationInteractive,
  resolveTurnRailPreview,
  resolveTurnRailTopPercent,
  TURN_RAIL_MIN_ITEMS,
  type TurnRailItem,
  type TurnRailPlacement,
  type TurnRailPreview,
} from "../lib/turn-rail";
import { forwardWheelToScroller } from "../lib/turn-rail-wheel";

export interface TurnRailProps {
  items: readonly TurnRailItem[];
  /** The transcript's scroller: the observer's root and the wheel's target. */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** The scroller's content, whose direct children are the row wrappers. */
  contentRef: RefObject<HTMLDivElement | null>;
  /** Height of the floating header over the top of the scroller. A prompt
   *  under it is not in view. */
  topInset: number;
  /** The first mounted row. A change mounts rows the observer has not seen. */
  windowStart: number;
  /** The raw prompt and reply for a turn, read when its card opens. */
  getPreview: (item: TurnRailItem) => TurnRailPreview | null;
  onSelect: (item: TurnRailItem) => void;
}

/** Off in Settings, or a session too short to navigate: nothing mounts. */
export const TurnRail = memo(function TurnRail(props: TurnRailProps) {
  const enabled = useSettingsStore((s) => s.settings.showTurnRail);
  if (!enabled || props.items.length < TURN_RAIL_MIN_ITEMS) return null;
  return <TurnRailView {...props} />;
});

function eventTargetsPreview(target: EventTarget): boolean {
  return target instanceof Element && target.closest("[data-turn-rail-preview]") !== null;
}

// A release outside the window can skip `mouseup`, so the next button-free
// `mousemove` also counts.
function onMouseButtonsReleased(onRelease: () => void): () => void {
  const check = (event: globalThis.MouseEvent) => {
    if (event.buttons !== 0) return;
    stop();
    onRelease();
  };
  const stop = () => {
    window.removeEventListener("mouseup", check);
    window.removeEventListener("mousemove", check);
  };
  window.addEventListener("mouseup", check);
  window.addEventListener("mousemove", check);
  return stop;
}

function TurnRailView({
  items,
  scrollRef,
  contentRef,
  topInset,
  windowStart,
  getPreview,
  onSelect,
}: TurnRailProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const stripMap = useRef(new Map<string, HTMLSpanElement>()).current;
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [currentIndex, setCurrentIndex] = useState<number | null>(null);
  const [gutter, setGutter] = useState(0);

  // ── Gutter ────────────────────────────────────────────────────────────
  // The distance from the left edge of the row the column is centred in to
  // the column itself. Re-measured when either resizes (window, split, the
  // overview rail opening, the column width setting).
  useLayoutEffect(() => {
    const transcript = railRef.current?.parentElement;
    const row = transcript?.parentElement?.parentElement;
    if (!transcript || !row) return;
    const measure = () => {
      const next = Math.max(
        0,
        Math.round(transcript.getBoundingClientRect().left - row.getBoundingClientRect().left),
      );
      setGutter((current) => (current === next ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(transcript);
    observer.observe(row);
    return () => observer.disconnect();
  }, []);

  // ── In view and current ───────────────────────────────────────────────
  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    const indexById = new Map<string, number>();
    items.forEach((item, index) => indexById.set(item.id, index));
    // A prompt above the mounted window has no element; it is above by
    // definition. Every mounted one is reported by the observer's first
    // callback.
    const placements: TurnRailPlacement[] = items.map(() => "above");
    for (const strip of stripMap.values()) {
      if (strip.dataset.inView !== "false") strip.dataset.inView = "false";
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.rowId;
          const index = id === undefined ? undefined : indexById.get(id);
          if (index === undefined) continue;
          const rootTop = entry.rootBounds?.top ?? 0;
          placements[index] = entry.isIntersecting
            ? "in"
            : entry.boundingClientRect.top < rootTop
              ? "above"
              : "below";
          const strip = stripMap.get(items[index].id);
          const inView = placements[index] === "in" ? "true" : "false";
          if (strip && strip.dataset.inView !== inView) strip.dataset.inView = inView;
        }
        const next = resolveTurnRailCurrentIndex(placements);
        setCurrentIndex((current) => (current === next ? current : next));
      },
      { root: scroller, rootMargin: `-${topInset}px 0px 0px 0px` },
    );
    for (const child of content.children) {
      const id = (child as HTMLElement).dataset?.rowId;
      if (id !== undefined && indexById.has(id)) observer.observe(child);
    }
    return () => observer.disconnect();
  }, [items, windowStart, topInset, scrollRef, contentRef, stripMap]);

  // ── Wheel ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const onWheel = (event: WheelEvent) => {
      const scroller = scrollRef.current;
      if (scroller) forwardWheelToScroller(event, scroller);
    };
    rail.addEventListener("wheel", onWheel, { passive: false });
    return () => rail.removeEventListener("wheel", onWheel);
  }, [scrollRef]);

  // ── Drag pass-through ─────────────────────────────────────────────────
  // A text selection dragged across the rail must not be captured by it.
  const pressedOnStripRef = useRef(false);
  const [passThrough, setPassThrough] = useState(false);
  useEffect(() => {
    if (!passThrough) return;
    return onMouseButtonsReleased(() => setPassThrough(false));
  }, [passThrough]);

  const hasPersistentGutter = resolveTurnRailHasPersistentGutter(gutter);
  const hitStripWidth = resolveTurnRailHitStripWidth(gutter);
  const resolvedActiveIndex =
    activeIndex !== null && activeIndex < items.length ? activeIndex : null;
  const activeItem = resolvedActiveIndex === null ? null : (items[resolvedActiveIndex] ?? null);
  // Parsed once per opened card, not per pointer move within it.
  const preview = useMemo(
    () => (activeItem ? resolveTurnRailPreview(getPreview(activeItem)) : null),
    [activeItem, getPreview],
  );
  const navigationInteractive = resolveTurnRailNavigationInteractive(hitStripWidth) && !passThrough;
  const activeTopPercent =
    resolvedActiveIndex === null ? 0 : resolveTurnRailTopPercent(resolvedActiveIndex, items.length);
  const activeCardTranslate =
    resolvedActiveIndex === null
      ? "-50%"
      : resolvedActiveIndex === 0
        ? "0%"
        : resolvedActiveIndex === items.length - 1
          ? "-100%"
          : "-50%";
  const resolvedCurrentIndex =
    currentIndex !== null && currentIndex >= 0 && currentIndex < items.length ? currentIndex : null;
  const previousItem =
    resolvedCurrentIndex === null ? null : (items[resolvedCurrentIndex - 1] ?? null);
  const nextItem = resolvedCurrentIndex === null ? null : (items[resolvedCurrentIndex + 1] ?? null);

  const resolveActiveIndexFromPointer = (event: MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return resolveTurnRailIndexFromPointer({
      itemCount: items.length,
      railTop: rect.top,
      railHeight: rect.height,
      pointerY: event.clientY,
    });
  };

  const moveActiveIndex = (delta: number) => {
    setActiveIndex((current) => {
      const base = current ?? 0;
      return Math.max(0, Math.min(items.length - 1, base + delta));
    });
  };

  return (
    <div
      ref={railRef}
      className={cn(
        "group/turn-rail pointer-events-none absolute inset-y-0 z-panel hidden w-18 pointer-fine:block",
        hasPersistentGutter
          ? "opacity-100"
          : "opacity-0 transition-opacity duration-fast focus-within:opacity-100 hover:opacity-100",
      )}
      // Anchored to the row's left edge, which is `gutter` left of the
      // transcript this is positioned in.
      style={{ left: -gutter }}
      data-testid="turn-rail"
      data-persistent-gutter={hasPersistentGutter ? "true" : "false"}
    >
      <div className="relative h-full w-full select-none">
        <div
          className={cn(
            "absolute top-1/2 left-3 -translate-y-1/2",
            hitStripWidth > 0 && !passThrough ? "pointer-events-auto" : "pointer-events-none",
          )}
          onMouseDown={() => {
            if (pressedOnStripRef.current) return;
            pressedOnStripRef.current = true;
            onMouseButtonsReleased(() => {
              pressedOnStripRef.current = false;
            });
          }}
          onMouseMove={(event) => {
            if (event.buttons !== 0 && !pressedOnStripRef.current) setPassThrough(true);
          }}
          style={{
            height: resolveTurnRailHeightStyle(items.length),
            width: resolveTurnRailInteractiveWidth(hitStripWidth, activeItem !== null),
          }}
        >
          <TurnRailNavigationButton
            direction="previous"
            disabled={previousItem === null}
            interactive={navigationInteractive}
            onClick={() => {
              if (previousItem) onSelect(previousItem);
            }}
          />
          <button
            aria-label={`Jump to turn: ${preview?.userText ?? "User message"}`}
            className="absolute inset-y-0 left-0 w-full cursor-pointer bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            onBlur={() => setActiveIndex(null)}
            onClick={(event) => {
              if (eventTargetsPreview(event.target)) return;
              const index = resolveActiveIndexFromPointer(event);
              const selected = index === null ? null : (items[index] ?? null);
              if (selected) onSelect(selected);
              event.currentTarget.blur();
            }}
            onFocus={() => setActiveIndex((current) => current ?? resolvedCurrentIndex ?? 0)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveActiveIndex(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                moveActiveIndex(-1);
              } else if (event.key === "Home") {
                event.preventDefault();
                setActiveIndex(0);
              } else if (event.key === "End") {
                event.preventDefault();
                setActiveIndex(items.length - 1);
              } else if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                if (activeItem) onSelect(activeItem);
              }
            }}
            onMouseLeave={() => setActiveIndex(null)}
            onMouseMove={(event) => {
              if (event.buttons !== 0 && !pressedOnStripRef.current) return;
              setActiveIndex(resolveActiveIndexFromPointer(event));
            }}
            onMouseDown={(event) => {
              if (eventTargetsPreview(event.target)) return;
              event.preventDefault();
            }}
            type="button"
          >
            <span aria-hidden className="absolute top-0 left-3 h-full w-px bg-border/15" />
            {items.map((item, index) => {
              const activeDistance =
                resolvedActiveIndex === null ? null : Math.abs(index - resolvedActiveIndex);
              return (
                // Compositor-friendly on purpose: in-view state and the hover
                // fisheye change constantly (every scroll crossing and pointer
                // move flips a band of ticks), so a tick animates only
                // transform and opacity.
                <span
                  aria-hidden="true"
                  className={cn(
                    "group/tick pointer-events-none absolute left-0 h-0.5 w-6 origin-left -translate-y-1/2 rounded-full transition-transform duration-fast",
                    activeDistance === 0 ? "bg-muted-foreground/75" : "bg-muted-foreground/35",
                    activeDistance === 0
                      ? "scale-x-100"
                      : activeDistance === 1
                        ? "scale-x-[0.667]"
                        : activeDistance === 2
                          ? "scale-x-[0.417]"
                          : "scale-x-[0.333]",
                  )}
                  data-in-view="false"
                  data-turn-rail-tick
                  key={item.id}
                  ref={(node) => {
                    if (node) stripMap.set(item.id, node);
                    else stripMap.delete(item.id);
                  }}
                  style={{ top: `${resolveTurnRailTopPercent(index, items.length)}%` }}
                >
                  <span className="absolute inset-0 rounded-full bg-foreground/90 opacity-0 transition-opacity duration-fast group-data-[in-view=true]/tick:opacity-100" />
                </span>
              );
            })}
            {preview ? (
              <span
                className="pointer-events-auto absolute left-8 w-80 cursor-text select-text"
                data-turn-rail-preview
                onMouseMove={(event) => event.stopPropagation()}
                style={{
                  top: `${activeTopPercent}%`,
                  transform: `translateY(${activeCardTranslate})`,
                }}
              >
                <span className="block rounded-lg border border-border bg-popover p-3 text-left text-popover-foreground shadow-md">
                  <span className="block truncate text-base font-medium">
                    {preview.userText ?? "User message"}
                  </span>
                  {preview.assistantText ? (
                    <span className="mt-1 line-clamp-3 text-base text-muted-foreground">
                      {preview.assistantText}
                    </span>
                  ) : null}
                </span>
              </span>
            ) : null}
          </button>
          <TurnRailNavigationButton
            direction="next"
            disabled={nextItem === null}
            interactive={navigationInteractive}
            onClick={() => {
              if (nextItem) onSelect(nextItem);
            }}
          />
        </div>
      </div>
    </div>
  );
}

function TurnRailNavigationButton({
  direction,
  disabled,
  interactive,
  onClick,
}: {
  direction: "previous" | "next";
  disabled: boolean;
  interactive: boolean;
  onClick: () => void;
}) {
  const previous = direction === "previous";
  const label = previous ? "Previous turn" : "Next turn";
  return (
    <span
      className={cn(
        "absolute left-1 inline-flex -translate-x-1/2 opacity-0 transition-opacity duration-fast focus-within:opacity-100 hover:opacity-100",
        interactive ? "pointer-events-auto" : "pointer-events-none",
        previous ? "bottom-[calc(100%+2px)]" : "top-[calc(100%+2px)]",
      )}
    >
      <Hint label={label} side={previous ? "top" : "bottom"}>
        <IconButton
          icon={previous ? ChevronUp : ChevronDown}
          label={label}
          size="xs"
          disabled={disabled}
          onClick={onClick}
        />
      </Hint>
    </span>
  );
}
