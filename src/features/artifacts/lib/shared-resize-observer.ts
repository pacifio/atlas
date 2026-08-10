/**
 * One `ResizeObserver` for the whole timeline, instead of one per row.
 *
 * The detail view measured 1098 `ResizeObserver` constructions in a single
 * browsing session — one per `Clamp`, i.e. per prompt, response and thinking row
 * — to answer the same question every time: *did this content overflow?* Each
 * construction allocates an observer, registers it with the engine, and adds a
 * callback the engine must consult on every layout pass. A single observer
 * watching N elements costs the engine one pass over N entries; N observers
 * watching one element each costs N passes.
 *
 * The API supports this directly and always has: `observe()` takes any number of
 * elements and the callback receives them batched.
 */

type Callback = (entry: ResizeObserverEntry) => void;

/**
 * Element → its callback.
 *
 * A `WeakMap` so a row removed from the DOM without its cleanup running — a
 * crash mid-unmount, a parent replaced wholesale — does not pin the node in
 * memory. The observer's own reference is cleared by `unobserve` in the normal
 * path.
 */
const callbacks = new WeakMap<Element, Callback>();

let observer: ResizeObserver | null = null;

function shared(): ResizeObserver {
  return (observer ??= new ResizeObserver((entries) => {
    for (const entry of entries) callbacks.get(entry.target)?.(entry);
  }));
}

/**
 * Watch one element's size. Returns its unsubscribe.
 *
 * Both registration and cleanup are idempotent, which is not optional: React 19
 * StrictMode double-invokes effects in development, so an implementation that
 * assumed one call each would double-observe and then unobserve a live element.
 */
export function observeSize(element: Element, callback: Callback): () => void {
  callbacks.set(element, callback);
  shared().observe(element);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    callbacks.delete(element);
    observer?.unobserve(element);
  };
}
