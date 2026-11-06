/**
 * The element that really has focus, looking inside shadow roots.
 *
 * `document.activeElement` stops at a shadow host: while the file view's
 * editable surface (inside the code viewer's shadow root) has focus, it
 * reports the host, which is neither an input nor contenteditable. Anything
 * asking "is the user typing?" must ask this instead.
 */
export function deepActiveElement(root: Document | ShadowRoot = document): Element | null {
  let el = root.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

/** The host of the shadow root `el` sits at the top of, if it does. */
export function shadowHost(el: Element): Element | null {
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

/** The element a keyboard event really started on, inside any shadow root. */
export function eventOrigin(e: Event): Element | null {
  const first = e.composedPath()[0];
  return first instanceof Element ? first : null;
}
