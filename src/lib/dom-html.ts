/**
 * In-place HTML patching for rendered markdown.
 *
 * `dangerouslySetInnerHTML` is a REPLACEMENT: every time the string changes the
 * browser tears down the whole subtree and builds a new one. For settled
 * content that happens once and costs nothing. For the streaming tail it
 * happened every frame, and the cost is not the parse — it is that the nodes
 * the reader is looking at stop existing several times a second:
 *
 *  - a text selection inside the live answer is dropped the instant the next
 *    token lands (selecting text while the agent writes was impossible),
 *  - `:hover` state and scroll position inside a wide table or code block reset,
 *  - WebKit repaints the entire block rather than the one line that changed,
 *    which is the visible shimmer/flicker on a long streaming paragraph.
 *
 * `morphdom` walks the old DOM against the new HTML and mutates only what
 * actually differs — usually a single text node at the end of a paragraph. It
 * is ~5 KB, dependency-free, and the same primitive Phoenix LiveView uses for
 * exactly this problem.
 *
 * SAFETY: every string reaching `applyHtml` comes out of `markdown-render.ts`,
 * whose pipeline ends in `rehype-sanitize` — no scripts, no inline handlers, no
 * `javascript:` URLs. The one string built here (the raw-source placeholder) is
 * escaped by `escapeHtml`. Nothing else may be passed in.
 */

import morphdom from "morphdom";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

/** For building the raw-source placeholder without going through a parser. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ESCAPES[c]);
}

/**
 * Make `el`'s children match `html`, changing as little of the DOM as possible.
 *
 * The first fill is a plain `innerHTML` — there is nothing to preserve yet, and
 * a parse beats a diff. Subsequent calls morph.
 */
export function applyHtml(el: HTMLElement, html: string): void {
  if (!el.firstChild) {
    el.innerHTML = html;
    return;
  }
  try {
    morphdom(el, `<div>${html}</div>`, {
      childrenOnly: true,
      onBeforeElUpdated: (from, to) => {
        // morphdom's documented fast path: an identical subtree is skipped
        // whole, so a stable paragraph above the growing one is never touched.
        if (from.isEqualNode(to)) return false;
        // The copy/language bar is injected into `<pre>` AFTER parsing, so it
        // is absent from every incoming string. Keep the flag that says so, or
        // the enhance pass would inject a second one.
        if (from.dataset.enhanced) to.dataset.enhanced = from.dataset.enhanced;
        return true;
      },
      // …and keep the bar itself, for the same reason.
      onBeforeNodeDiscarded: (node) =>
        !(node instanceof HTMLElement && node.classList.contains("atlas-code-bar")),
    });
  } catch {
    // A morph can only fail on malformed input; correctness beats the diff.
    el.innerHTML = html;
  }
}
