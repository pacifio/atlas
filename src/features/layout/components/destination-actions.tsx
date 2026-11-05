import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * A destination's own actions, in the destination bar beside its title
 * (ADR-0024). The bar already names the page, so a destination that draws a
 * header of its own just to hold a few controls repeats the title; it hands
 * the controls here instead.
 */
export const DestinationActionsSlot = createContext<HTMLElement | null>(null);

/** Render `children` in the destination bar; inline when not on one. */
export function DestinationActions({ children }: { children: ReactNode }) {
  const slot = useContext(DestinationActionsSlot);
  return slot ? createPortal(children, slot) : children;
}
