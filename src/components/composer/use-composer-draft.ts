// Draft save/restore for a composer.
//
// The editor owns the document; the draft is a text mirror kept somewhere
// that outlives it (a store, keyed by tab or conversation), so a remount —
// a tab switch unmounts the composer — restores what was being typed. The
// mirror is a 300ms trailing debounce plus a flush on unmount: per-keystroke
// it costs one timer reset, and nothing is serialized until the user pauses.
//
// The unmount flush runs as a LAYOUT effect cleanup on purpose. React runs a
// parent's layout cleanups before it detaches the children's refs, so the
// editor handle is still there to read; a passive cleanup would find it gone.

import { useCallback, useLayoutEffect, useRef, useState } from "react";

export interface ComposerDraft {
  /** The draft as it was at mount — the editor's `initialValue`. */
  initialValue: string;
  /** Wire to the editor's `onDocChange`. */
  onDocChange: () => void;
  /** The last text known: the editor's at the last flush, or a write made
   *  before the editor existed. */
  latest: React.RefObject<string>;
  /** Write the draft now (e.g. after a programmatic replace). */
  flush: () => void;
}

/**
 * @param scope   what the draft belongs to (a tab id); a change flushes the
 *                old scope's draft under the old `save`.
 * @param load    read once, at mount.
 * @param save    persist a draft; an empty string means "none".
 * @param read    the editor's current text, or undefined when it has none.
 */
export function useComposerDraft(
  scope: string,
  load: () => string,
  save: (text: string) => void,
  read: () => string | undefined,
): ComposerDraft {
  const [initialValue] = useState(load);
  const latest = useRef(initialValue);
  const timer = useRef<number | null>(null);
  const readRef = useRef(read);
  readRef.current = read;
  const saveRef = useRef(save);
  saveRef.current = save;

  const flushWith = useCallback((persist: (text: string) => void) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    const text = readRef.current();
    if (text !== undefined) latest.current = text;
    persist(latest.current);
  }, []);

  const flush = useCallback(() => flushWith(saveRef.current), [flushWith]);

  const onDocChange = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 300);
  }, [flush]);

  useLayoutEffect(() => {
    const persist = save;
    return () => flushWith(persist);
    // Keyed on the scope alone: `save` is captured per scope so the cleanup
    // writes the draft back to the scope it was typed in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, flushWith]);

  return { initialValue, onDocChange, latest, flush };
}
