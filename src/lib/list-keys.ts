/**
 * Arrow-key focus movement for a listbox whose options are focusable
 * elements (a roving tab stop: one option has `tabIndex=0`, the rest -1).
 *
 * `listKeyTarget` answers which option a key moves to: ↑/↓ step without
 * wrapping, Home/End jump to the ends. It returns null for any other key, or
 * when the list is empty, so the caller lets the event through.
 */
export function listKeyTarget(key: string, index: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowDown":
      return Math.min(count - 1, index + 1);
    case "ArrowUp":
      return Math.max(0, index - 1);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** Keydown handler body for a listbox of focusable `[role="option"]` rows:
 *  moves DOM focus and returns true when it handled the key. */
export function moveOptionFocus(list: HTMLElement, key: string, from: Element | null): boolean {
  const options = Array.from(list.querySelectorAll<HTMLElement>('[role="option"]'));
  const current = from ? options.findIndex((o) => o === from || o.contains(from)) : -1;
  const next = listKeyTarget(key, Math.max(0, current), options.length);
  if (next === null) return false;
  options[next]?.focus();
  return true;
}
