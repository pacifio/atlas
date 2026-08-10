/**
 * Animated scroll that survives a list whose height is still settling.
 *
 * `scrollIntoView({ behavior: "smooth" })` samples the target's position **once**
 * and animates to that number. A jump routinely grows the render window first,
 * so the rows between here and the target are freshly mounted — markdown still
 * resolving off the worker, clamps still measuring — and each one that settles
 * moves the target. (Rows once carried `content-visibility: auto`, which made
 * this worse; that is gone, but the settling-height problem is inherent to
 * jumping into just-mounted content.) The single sampled offset is wrong by the
 * time the animation reaches it, so the browser lands somewhere else.
 *
 * This re-reads the target every frame and eases toward wherever it *now* is, so
 * the correction is absorbed continuously instead of arriving as a jump at the
 * end. It also runs long enough (450ms) for the rows being revealed to paint
 * before they are scrolled past.
 */

/** How long a jump takes. Long enough to follow, short enough not to feel slow. */
const DURATION_MS = 450;

/**
 * Ease-in-out cubic.
 *
 * Symmetric on purpose: a jump has no "arrival" the way a fling does — the
 * reader is being carried somewhere, and a gentle start reads as intentional
 * where a linear one reads as a teleport that happens to take time.
 */
function ease(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

interface ScrollToOptions {
  /** Where in the viewport the target should end up. */
  block?: "start" | "center";
  /** Extra offset (px) — for a sticky header the target must clear. */
  offset?: number;
}

/**
 * Scroll `container` so `target` is visible, over {@link DURATION_MS}.
 *
 * Returns a cancel function. Call it when the destination stops being relevant —
 * a second jump, a filter change, an unmount — otherwise two animations fight
 * over `scrollTop` and neither arrives.
 */
export function animatedScrollTo(
  container: HTMLElement,
  target: HTMLElement,
  { block = "start", offset = 0 }: ScrollToOptions = {},
): () => void {
  const from = container.scrollTop;
  const started = performance.now();
  let frame = 0;
  let cancelled = false;

  /** Where the target sits *right now*, clamped to what is scrollable. */
  const destination = (): number => {
    const containerTop = container.getBoundingClientRect().top;
    const targetTop = target.getBoundingClientRect().top;
    const current = container.scrollTop + (targetTop - containerTop) - offset;
    const centred =
      block === "center" ? current - (container.clientHeight - target.offsetHeight) / 2 : current;
    const max = container.scrollHeight - container.clientHeight;
    return Math.max(0, Math.min(max, centred));
  };

  const tick = (now: number) => {
    if (cancelled) return;
    const t = Math.min(1, (now - started) / DURATION_MS);
    // Re-read every frame: this is the whole point. A row revealing its real
    // height mid-flight moves the destination, and interpolating toward the
    // *current* one turns that into a smooth correction rather than an
    // overshoot followed by a snap.
    container.scrollTop = from + (destination() - from) * ease(t);
    if (t < 1) frame = requestAnimationFrame(tick);
  };

  frame = requestAnimationFrame(tick);

  // A user scroll during the animation is a decision, and continuing to drive
  // `scrollTop` after it would fight them for control.
  const abort = () => {
    cancelled = true;
    cancelAnimationFrame(frame);
    container.removeEventListener("wheel", abort);
    container.removeEventListener("touchstart", abort);
  };
  container.addEventListener("wheel", abort, { passive: true, once: true });
  container.addEventListener("touchstart", abort, { passive: true, once: true });

  return abort;
}
