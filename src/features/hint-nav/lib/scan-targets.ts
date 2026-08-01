/**
 * One-shot DOM scan for hint mode: find the visible, in-viewport interactive
 * elements and return them with their viewport rects. Runs ONLY on activation
 * (no observers), reads layout in a single batched pass.
 */

export interface HintTarget {
  el: HTMLElement;
  rect: DOMRect;
}

/** Attribute set on the overlay root so we never hint our own badges/HUD. */
export const HINT_OVERLAY_ATTR = "data-hint-overlay";

const SELECTOR = [
  "button",
  "a[href]",
  '[role="button"]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]',
  '[role="tab"]',
  '[role="link"]',
  '[role="option"]',
  '[role="switch"]',
  '[role="checkbox"]',
  'input:not([type="hidden"])',
  "textarea",
  "select",
  "summary",
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
  "[data-hint]",
].join(",");

/** Cap so a pathological page can't blow up label length / render cost. */
const MAX_TARGETS = 250;

function isHidden(el: HTMLElement, style: CSSStyleDeclaration): boolean {
  if (style.visibility === "hidden" || style.display === "none") return true;
  if (style.opacity === "0" || style.pointerEvents === "none") return true;
  if (el.hasAttribute("inert")) return true;
  if (el.getAttribute("aria-hidden") === "true") return true;
  if ((el as HTMLButtonElement).disabled) return true;
  return false;
}

export function scanTargets(): HintTarget[] {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(SELECTOR));

  const visible: HintTarget[] = [];
  for (const el of nodes) {
    // Skip our own overlay subtree.
    if (el.closest(`[${HINT_OVERLAY_ATTR}]`)) continue;

    const rect = el.getBoundingClientRect();
    // Off-screen or zero-size → not a hint target.
    if (rect.width < 4 || rect.height < 4) continue;
    if (
      rect.bottom <= 0 ||
      rect.right <= 0 ||
      rect.top >= vh ||
      rect.left >= vw
    )
      continue;

    const style = getComputedStyle(el);
    if (isHidden(el, style)) continue;

    visible.push({ el, rect });
  }

  // Dedupe nested actionables: if a visible target contains another visible
  // target, prefer the INNER one (the actual control) and drop the wrapper —
  // unless the wrapper opted in explicitly with [data-hint].
  const els = visible.map((t) => t.el);
  const deduped = visible.filter((t) => {
    if (t.el.hasAttribute("data-hint")) return true;
    return !els.some((other) => other !== t.el && t.el.contains(other));
  });

  // Closest-to-viewport-center first, so the easiest labels land near the focus
  // of attention, and so the cap keeps the most relevant targets.
  const cx = vw / 2;
  const cy = vh / 2;
  deduped.sort((a, b) => {
    const da = Math.hypot(
      a.rect.left + a.rect.width / 2 - cx,
      a.rect.top + a.rect.height / 2 - cy,
    );
    const db = Math.hypot(
      b.rect.left + b.rect.width / 2 - cx,
      b.rect.top + b.rect.height / 2 - cy,
    );
    return da - db;
  });

  return deduped.slice(0, MAX_TARGETS);
}
