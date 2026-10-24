// Kept for later: the session terminal drawer is unmounted (no UI reaches it) until the terminal rework. Not dead code; do not delete.
//
// The open drawer: a resizable box around an ordinary `TerminalPanel`
// (variant `drawer`) over the drawer's terminal tab — the same panes, side
// list, block renderer, xterm and PTY IPC as a terminal tab. Loaded on the
// first open (`session-terminal-drawer.tsx` is the gate the chat panel
// renders), so a session that never opens its drawer never loads the terminal
// stack for it.

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { useIsTabVisible } from "@/features/layout/lib/use-tab-visible";

import { useTerminalStore } from "../stores/terminal-store";
import {
  DEFAULT_DRAWER_HEIGHT,
  drawerHeightFor,
  useSessionDrawerStore,
} from "../stores/session-drawer-store";
import {
  clampDrawerHeight,
  drawerTabId,
  MIN_TRANSCRIPT_HEIGHT,
  resolveDrawerMaxHeight,
} from "../lib/session-drawer";
import { TerminalPanel } from "./terminal-panel";

export interface SessionTerminalDrawerProps {
  /** The chat tab the drawer sits in. */
  tabId: string;
  /** The session it belongs to (`sessionScope`). */
  scope: string;
}

function viewportHeight(): number {
  return typeof window === "undefined" ? 0 : window.innerHeight;
}

export default function SessionTerminalDrawerBody({ tabId, scope }: SessionTerminalDrawerProps) {
  const terminalTabId = drawerTabId(scope);
  const hasTree = useTerminalStore((s) => !!s.tabs[terminalTabId]);
  // Hidden with its tab (chat panels stay mounted across tab switches): its
  // terminals stop rendering, exactly as a hidden terminal tab's do.
  const tabVisible = useIsTabVisible(tabId);
  const preferred = useSessionDrawerStore((s) => drawerHeightFor(s, scope));
  const { setHeight, setOpen, setFocusedTab } = useSessionDrawerStore.use.actions();

  const rootRef = useRef<HTMLElement>(null);
  const [maxHeight, setMaxHeight] = useState(() =>
    resolveDrawerMaxHeight({ viewportHeight: viewportHeight() }),
  );
  const height = clampDrawerHeight(preferred, maxHeight, DEFAULT_DRAWER_HEIGHT);

  // Its last terminal closed: the drawer closes with it, and the keyboard
  // goes back to the composer.
  useEffect(() => {
    if (hasTree || useTerminalStore.getState().tabs[terminalTabId]) return;
    setOpen(scope, false);
    if (useSessionDrawerStore.getState().focusedTab === terminalTabId) setFocusedTab(null);
    window.dispatchEvent(new CustomEvent("atlas:chat-focus", { detail: { tabId } }));
  }, [hasTree, scope, setFocusedTab, setOpen, tabId, terminalTabId]);

  // The tallest it may be: never more than the column can give without
  // pushing the composer out. Measured only while on screen; the column may
  // have changed while hidden, so measure before the first visible paint.
  useLayoutEffect(() => {
    if (!tabVisible) return;
    const root = rootRef.current;
    const column = root?.closest<HTMLElement>("[data-chat-drop-zone]") ?? null;
    const composer = column?.querySelector<HTMLElement>("[data-chat-composer-stack]") ?? null;
    const measure = () => {
      setMaxHeight(
        resolveDrawerMaxHeight({
          viewportHeight: viewportHeight(),
          ...(column
            ? {
                columnHeight: column.clientHeight,
                reservedHeight: (composer?.offsetHeight ?? 0) + MIN_TRANSCRIPT_HEIGHT,
              }
            : {}),
        }),
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (column) ro.observe(column);
    if (composer) ro.observe(composer);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [tabVisible]);

  // The drag writes the box's height straight to the DOM and commits once, on
  // release: a store write per pointer move would re-render on every frame.
  const drag = useRef<{ pointerId: number; startY: number; startHeight: number; live: number }>(
    null,
  );
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { pointerId: e.pointerId, startY: e.clientY, startHeight: height, live: height };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    e.preventDefault();
    const next = clampDrawerHeight(d.startHeight + (d.startY - e.clientY), maxHeight, height);
    if (next === d.live) return;
    d.live = next;
    rootRef.current?.style.setProperty("height", `${next}px`);
  };
  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    // A press that never moved keeps the stored preference, which may be
    // taller than the capped height it started from.
    if (d.live === d.startHeight) {
      rootRef.current?.style.setProperty("height", `${height}px`);
      return;
    }
    setHeight(scope, d.live);
  };

  // Whose terminal owns the keyboard: a drawer is not a layout tab, so it
  // reports focus entering and leaving it (`focus.ts`).
  const onFocus = () => setFocusedTab(terminalTabId);
  const onBlur = (e: ReactFocusEvent<HTMLElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    if (useSessionDrawerStore.getState().focusedTab === terminalTabId) setFocusedTab(null);
  };

  // Height changes re-render this box only; the panel below it is unchanged.
  const panel = useMemo(
    () => <TerminalPanel tabId={terminalTabId} visible={tabVisible} variant="drawer" />,
    [terminalTabId, tabVisible],
  );

  return (
    <section
      ref={rootRef}
      aria-label="Session terminal"
      data-session-terminal-drawer={scope}
      className="relative flex shrink-0 flex-col border-t border-border bg-[var(--atlas-terminal-background)]"
      style={{ height }}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal"
        data-session-terminal-resize
        className="absolute inset-x-0 -top-0.5 z-20 h-1.5 cursor-row-resize transition-colors duration-fast hover:bg-primary/40"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onLostPointerCapture={onPointerEnd}
      />
      <div className="min-h-0 flex-1">{hasTree ? panel : null}</div>
    </section>
  );
}
