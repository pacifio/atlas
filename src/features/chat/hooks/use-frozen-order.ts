import { useCallback, useMemo, useRef, useState, type FocusEvent } from "react";

/*
 * Hold a list's order still while the user is aiming at it.
 *
 * The session sidebar sorts by recency, and a session another process keeps
 * writing moves its row to the top on every write — so a row could jump under
 * the pointer between aim and click, and the click opened the wrong session.
 * While the pointer is over the list, or keyboard focus is inside it, rows
 * keep the order they had when that started. Row CONTENT still updates
 * (titles, times, the live dot): only the order is held. Rows that appear go
 * on top; rows that are removed disappear. Leaving applies the real order.
 *
 * Cheap by construction: the only state is one "engaged" flag, flipped on
 * enter/leave and focus-in/focus-out — never on pointer movement — and the
 * frozen order lives in a ref.
 */

/** `items` in the order `frozen` names; keys `frozen` lacks go first, in their own order. */
export function applyFrozenOrder<T>(
  items: readonly T[],
  frozen: readonly string[],
  keyOf: (item: T) => string,
): T[] {
  const rank = new Map(frozen.map((key, i) => [key, i]));
  const fresh: T[] = [];
  const held: T[] = [];
  for (const item of items) (rank.has(keyOf(item)) ? held : fresh).push(item);
  held.sort((a, b) => rank.get(keyOf(a))! - rank.get(keyOf(b))!);
  return [...fresh, ...held];
}

export interface FrozenOrderListProps {
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: () => void;
  onBlur: (e: FocusEvent<HTMLElement>) => void;
}

/**
 * `items`, with their order held while the list is hovered or focused. Spread
 * `listProps` on the element that contains the rows. Pass a stable `keyOf`.
 */
export function useFrozenOrder<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
): { ordered: readonly T[]; listProps: FrozenOrderListProps } {
  const [engaged, setEngaged] = useState(false);
  const engagedRef = useRef(false);
  const hovered = useRef(false);
  const focused = useRef(false);
  const frozen = useRef<string[]>([]);
  // The order as last rendered, so engaging freezes what the user is seeing.
  const latest = useRef<readonly T[]>(items);
  latest.current = items;
  const keyOfRef = useRef(keyOf);
  keyOfRef.current = keyOf;

  const engage = useCallback(() => {
    if (engagedRef.current) return;
    engagedRef.current = true;
    frozen.current = latest.current.map((item) => keyOfRef.current(item));
    setEngaged(true);
  }, []);
  const release = useCallback(() => {
    if (hovered.current || focused.current || !engagedRef.current) return;
    engagedRef.current = false;
    setEngaged(false);
  }, []);

  const listProps = useMemo<FrozenOrderListProps>(
    () => ({
      onMouseEnter: () => {
        hovered.current = true;
        engage();
      },
      onMouseLeave: () => {
        hovered.current = false;
        release();
      },
      // React's focus/blur bubble (focusin/focusout): any row control counts.
      onFocus: () => {
        focused.current = true;
        engage();
      },
      onBlur: (e) => {
        // Focus moving between rows stays inside the list.
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
        focused.current = false;
        release();
      },
    }),
    [engage, release],
  );

  const ordered = useMemo(
    () => (engaged ? applyFrozenOrder(items, frozen.current, keyOf) : items),
    // `keyOf` should be stable (module-level); it only re-derives the order.
    [engaged, items, keyOf],
  );
  return { ordered, listProps };
}
