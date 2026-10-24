import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * `ref`'s height in px, kept current while `enabled`; `null` before the first
 * measure, while disabled, and when there is no element. Only ever re-renders
 * the caller on a real change, and observes nothing while disabled, so a
 * closed card costs no observer.
 */
export function useElementHeight(
  ref: RefObject<HTMLElement | null>,
  enabled = true,
): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!enabled || !el) {
      setHeight(null);
      return;
    }
    const measure = () => {
      const next = Math.round(el.clientHeight);
      setHeight((prev) => (prev === next ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, enabled]);
  return height;
}
