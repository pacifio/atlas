// Markdown insertion for a plain <textarea>.
//
// The repo has no `wrapSelection` helper — the only formatting toolbar is
// Tiptap's bubble menu, whose commands operate on a ProseMirror document and do
// not port to a textarea. These are the textarea equivalents, written so the
// caller can apply them and then restore the caret.
//
// Every function is pure: it takes the current value and selection and returns
// the next value plus where the selection should end up. The caller writes the
// value through the store and re-applies the range on the next frame, the way
// `insertMention` already does in the composer.

export interface Edit {
  value: string;
  /** Where the selection should sit afterwards. */
  start: number;
  end: number;
}

export interface Selection {
  value: string;
  start: number;
  end: number;
}

/**
 * Wrap the selection in a marker, or unwrap it if it is already wrapped.
 *
 * Toggling matters more than it looks: without it, clicking **B** twice leaves
 * `****text****`, which renders as literal asterisks rather than undoing.
 * With no selection, the markers are inserted and the caret is parked between
 * them so typing continues inside the mark.
 */
export function wrap(sel: Selection, marker: string, closing = marker): Edit {
  const { value, start, end } = sel;
  const selected = value.slice(start, end);

  const before = value.slice(Math.max(0, start - marker.length), start);
  const after = value.slice(end, end + closing.length);
  if (before === marker && after === closing) {
    // Already wrapped just outside the selection — strip the markers.
    return {
      value: value.slice(0, start - marker.length) + selected + value.slice(end + closing.length),
      start: start - marker.length,
      end: end - marker.length,
    };
  }
  if (
    selected.startsWith(marker) &&
    selected.endsWith(closing) &&
    selected.length > marker.length + closing.length
  ) {
    // The markers are inside the selection — strip them.
    const inner = selected.slice(marker.length, selected.length - closing.length);
    return {
      value: value.slice(0, start) + inner + value.slice(end),
      start,
      end: start + inner.length,
    };
  }

  const next = value.slice(0, start) + marker + selected + closing + value.slice(end);
  return selected
    ? { value: next, start: start + marker.length, end: end + marker.length }
    : // Empty selection: sit between the markers.
      { value: next, start: start + marker.length, end: start + marker.length };
}

/**
 * Prefix every line the selection touches, or strip the prefix if all of them
 * already have it.
 *
 * `ordered` renumbers from 1 rather than repeating "1." — a list that reads
 * `1. 1. 1.` in the composer is a list somebody will fix by hand.
 */
export function linePrefix(sel: Selection, prefix: string, ordered = false): Edit {
  const { value, start, end } = sel;
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const lineEndIdx = value.indexOf("\n", end);
  const lineEnd = lineEndIdx === -1 ? value.length : lineEndIdx;

  const block = value.slice(lineStart, lineEnd);
  const lines = block.split("\n");
  const matcher = ordered ? /^\d+\.\s/ : new RegExp(`^${escapeRegex(prefix)}`);
  const allPrefixed = lines.every((l) => l.trim() === "" || matcher.test(l));

  const next = lines
    .map((l, i) => {
      if (l.trim() === "") return l;
      if (allPrefixed) return l.replace(matcher, "");
      return ordered ? `${i + 1}. ${l}` : `${prefix}${l}`;
    })
    .join("\n");

  const value2 = value.slice(0, lineStart) + next + value.slice(lineEnd);
  // Select the whole block afterwards, so a second click toggles it back.
  return { value: value2, start: lineStart, end: lineStart + next.length };
}

/** Insert a markdown link, using the selection as the label when there is one. */
export function insertLink(sel: Selection): Edit {
  const { value, start, end } = sel;
  const label = value.slice(start, end) || "text";
  const snippet = `[${label}](url)`;
  const next = value.slice(0, start) + snippet + value.slice(end);
  // Select `url` so the next keystroke replaces it — the useful thing to edit.
  const urlStart = start + label.length + 3;
  return { value: next, start: urlStart, end: urlStart + 3 };
}

/** Insert plain text at the caret (emoji, and anything else literal). */
export function insertText(sel: Selection, text: string): Edit {
  const { value, start, end } = sel;
  const next = value.slice(0, start) + text + value.slice(end);
  return { value: next, start: start + text.length, end: start + text.length };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
