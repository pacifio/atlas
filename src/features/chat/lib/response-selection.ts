/** A row a comment can hang off: a prompt or a settled response, carrying
 *  its chat key. A response also carries `data-agent-response`, which is what
 *  makes its text citable — a cite points the agent at ITS words. */
export const ANCHOR_SELECTOR = "[data-comment-anchor]";
const CONTROL_SELECTOR =
  'button, input, textarea, select, [role="button"], [contenteditable="true"], [data-comment-threads]';

function elementOf(node: Node | null): Element | null {
  return node instanceof Element ? node : (node?.parentElement ?? null);
}

export function anchorAt(node: Node | null, viewport: HTMLElement): HTMLElement | null {
  const element = elementOf(node);
  if (element?.closest(CONTROL_SELECTOR)) return null;
  const anchor = element?.closest<HTMLElement>(ANCHOR_SELECTOR);
  return anchor && viewport.contains(anchor) ? anchor : null;
}

export function chatKeyOf(anchor: HTMLElement): string {
  return anchor.dataset.commentAnchor!;
}

export function isCitable(anchor: HTMLElement): boolean {
  return anchor.hasAttribute("data-agent-response");
}

/** A range belongs to one row, never two rows or UI chrome. */
export function selectedAnchor(selection: Selection | null, viewport: HTMLElement) {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  const anchor = anchorAt(range.startContainer, viewport);
  if (!anchor || anchorAt(range.endContainer, viewport) !== anchor) return null;
  // Endpoints can be in valid text while the range crosses a toolbar.
  if (range.cloneContents().querySelector(CONTROL_SELECTOR)) return null;
  const text = selection.toString();
  if (!text.trim()) return null;
  return { anchor, text, range };
}

/** Clamp in the transcript's coordinate system. The panel can be CSS-scaled;
 * DOM rects are screen pixels but absolute positions are layout pixels. */
export function actionPosition(
  bounds: DOMRect,
  size: { width: number; height: number; offsetWidth: number; offsetHeight: number },
  anchor: { x: number; top: number; bottom: number },
  popup: { width: number; height: number },
) {
  const sx = bounds.width / size.offsetWidth || 1;
  const sy = bounds.height / size.offsetHeight || 1;
  const gap = 8;
  const x = (anchor.x - bounds.left) / sx;
  const below = (anchor.bottom - bounds.top) / sy + gap;
  const above = (anchor.top - bounds.top) / sy - popup.height - gap;
  return {
    left: Math.max(gap, Math.min(x, size.width - popup.width - gap)),
    top: Math.max(
      gap,
      Math.min(
        below + popup.height <= size.height - gap ? below : above,
        size.height - popup.height - gap,
      ),
    ),
  };
}

/** A targeted insert carries a complete draft; an untargeted one appends to
 * the active session's. (Cite used to append quoted text through here; it now
 * drops a `cited_text` chip instead — `cited-text.ts`.) */
export interface ChatInsertDetail {
  text: string;
  tabId?: string;
}

export function insertedDraft(current: string, detail: ChatInsertDetail): string {
  if (detail.tabId) return detail.text;
  return current.trim() ? `${current}\n\n${detail.text}` : detail.text;
}
