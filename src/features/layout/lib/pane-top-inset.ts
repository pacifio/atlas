import { createContext, useContext } from "react";

/**
 * How far the session column's header reaches over its content, in px.
 *
 * The session column's header floats over the tab instead of taking a row, so
 * the transcript scrolls under it behind a progressive blur. The content
 * starts at the column's top edge, and whatever must clear the bar (the
 * transcript's padding, the docked Details card) offsets by this much. 0
 * outside the session column, where the header is an ordinary row.
 */
export const PaneTopInsetContext = createContext(0);

export function usePaneTopInset(): number {
  return useContext(PaneTopInsetContext);
}
