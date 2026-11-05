import { useCallback, useRef, useState } from "react";

/**
 * Open state that a parent MAY own.
 *
 * With `open` undefined the component keeps its own state, as before. Given,
 * the parent decides and hears every request through `onOpenChange`. The
 * setter is stable, so effects that close on Escape or an outside click can
 * call it without listing it.
 */
export function useControllableOpen(
  open: boolean | undefined,
  onOpenChange: ((open: boolean) => void) | undefined,
): [boolean, (open: boolean) => void] {
  const [own, setOwn] = useState(false);
  const latest = useRef({ open, onOpenChange });
  latest.current = { open, onOpenChange };
  const setOpen = useCallback((next: boolean) => {
    if (latest.current.open === undefined) setOwn(next);
    latest.current.onOpenChange?.(next);
  }, []);
  return [open ?? own, setOpen];
}
