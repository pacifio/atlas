// "Ask agent about…" (⌘K) asks about whatever was focused before the palette
// took the focus.
//
// A surface says what its elements are about with `useAskAgentContext`: the
// element is registered with a function that returns its contexts, given the
// text selected inside it (if any). The tracker remembers the last element
// focused and the last text selected outside an overlay, so when the palette
// runs the entry, `focusedAskContext` walks up from there to the nearest
// registered element. With none, a selection is asked about as a quote; with
// no selection either, the box opens empty.

import { useCallback, useEffect, useRef, type RefCallback } from "react";

import type { AgentContext } from "./agent-context";

type ContextSource = (selection: string | null) => readonly AgentContext[];

const sources = new WeakMap<Element, { current: ContextSource }>();

/**
 * Register the element this ref lands on as being about `get(selection)`.
 * Re-read on every call, so `get` may close over the latest props.
 */
export function useAskAgentContext<T extends Element>(get: ContextSource): RefCallback<T> {
  const latest = useRef(get);
  useEffect(() => {
    latest.current = get;
  });
  return useCallback((el: T | null) => {
    if (el) sources.set(el, latest);
  }, []);
}

/** Where focus and selection moving does not count: overlays, the palette,
 *  the ask box itself. */
const OVERLAY = '[role="dialog"], [role="menu"], [data-ask-agent-box]';

function inOverlay(node: Node | null): boolean {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  return !!el?.closest(OVERLAY);
}

let lastFocus: Element | null = null;
let lastSelection: { text: string; el: Element } | null = null;

function onFocusIn(e: FocusEvent): void {
  if (e.target instanceof Element && !inOverlay(e.target)) lastFocus = e.target;
}

function onSelectionChange(): void {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0 || inOverlay(sel.anchorNode)) return;
  const text = sel.toString();
  const node = sel.anchorNode;
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  lastSelection = !sel.isCollapsed && text.trim() && el ? { text, el } : null;
}

/** Start tracking; returns the stop. `AskAgentHost` runs it once. */
export function trackFocusedContext(): () => void {
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("selectionchange", onSelectionChange);
  return () => {
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("selectionchange", onSelectionChange);
  };
}

/** The contexts of `from` or its nearest registered ancestor, else a
 *  selection as a quote. Pure over the registry; exported for tests. */
export function contextAt(from: Element | null, selection: string | null): AgentContext[] {
  for (let el = from; el; el = el.parentElement) {
    const source = sources.get(el);
    if (source) return [...source.current(selection)];
  }
  return selection?.trim() ? [{ kind: "quote", text: selection }] : [];
}

/** What was focused before an overlay opened, and the element to anchor to. */
export function focusedAskContext(): { context: AgentContext[]; anchor: Element | null } {
  const sel = lastSelection?.el.isConnected ? lastSelection : null;
  const el = sel?.el ?? (lastFocus?.isConnected ? lastFocus : null);
  return { context: contextAt(el, sel?.text ?? null), anchor: el };
}

/** Test seam. */
export function resetFocusedContextForTests(): void {
  lastFocus = null;
  lastSelection = null;
}
