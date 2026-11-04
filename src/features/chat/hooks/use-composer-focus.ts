import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useComposerFold } from "./use-composer-fold";

/** The composer's focused / folded form: focus moving into it opens it; focus
 *  moving elsewhere, a press outside, or Esc folds it (when `collapsible`). */
export function useComposerFocus({
  composerRef,
  collapsible,
  inputCardRef,
  trayRef,
}: {
  composerRef: RefObject<HTMLDivElement | null>;
  collapsible: boolean;
  inputCardRef: RefObject<HTMLDivElement | null>;
  trayRef: RefObject<HTMLDivElement | null>;
}) {
  const [composerFocused, setComposerFocused] = useState(false);
  const collapsed = collapsible && !composerFocused;
  const trayShown = useComposerFold(collapsed, inputCardRef, trayRef);
  // What folds it: focus moving to something ELSE (Tab away), a press
  // outside it, or Esc. Not focus merely leaving: WebKit does not focus a
  // button on click, so pressing a tray pill drops focus to <body> — read as
  // "left", that folded the tray out from under the pill being pressed.
  // Never while one of its menus is open (they may live in a portal), nor
  // when the WINDOW lost focus (switching apps is not leaving the composer).
  const composerMenuOpen = () =>
    !!composerRef.current?.querySelector("[data-popup-open], [aria-expanded='true']");
  const onComposerBlur = useCallback(() => {
    requestAnimationFrame(() => {
      if (!document.hasFocus()) return;
      const root = composerRef.current;
      const active = document.activeElement;
      if (!root || !active || active === document.body) return;
      if (root.contains(active) || composerMenuOpen()) return;
      setComposerFocused(false);
    });
  }, []);
  useEffect(() => {
    if (!composerFocused) return;
    const onPointerDown = (event: PointerEvent) => {
      const root = composerRef.current;
      if (!root || !(event.target instanceof Node) || root.contains(event.target)) return;
      if (composerMenuOpen()) return;
      setComposerFocused(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [composerFocused]);

  return { setComposerFocused, collapsed, trayShown, onComposerBlur };
}

/** Fire `atlas:chat-input-focused` the first time this composer takes focus.
 *  ChatPanel listens for it to lazily bind an ACP session — deferring the
 *  agent spawn until the user actually intends to chat keeps it off the cold
 *  boot path. Reset per tab so re-focusing a fresh tab still binds. */
export function useChatInputFocusedSignal(tabId: string, disabled: boolean) {
  const focusedOnceRef = useRef(false);
  useEffect(() => {
    focusedOnceRef.current = false;
  }, [tabId]);
  return useCallback(() => {
    // The toolbar (agent / model pickers) stays interactive while the composer
    // is disabled, so focus can now reach this handler from a control rather
    // than the text area. Don't kick off an agent bind against a CLI that
    // isn't ready — the user is most likely on their way to switching agents.
    if (disabled) return;
    if (focusedOnceRef.current) return;
    focusedOnceRef.current = true;
    window.dispatchEvent(new CustomEvent("atlas:chat-input-focused", { detail: { tabId } }));
  }, [tabId, disabled]);
}
