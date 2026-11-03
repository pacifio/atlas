import { useEffect, useRef } from "react";
import { deepActiveElement } from "@/lib/deep-active-element";
import { useSettingsNav } from "@/features/settings/stores/settings-nav-store";
import { SURFACES, openSurface, surfaceForKey } from "../lib/surfaces";
import { useLayoutStore } from "../stores/layout-store";
import { SurfaceLauncherView } from "./views/surface-launcher-view";

/** True while focus is somewhere typing belongs — a letter there is text. */
function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const html = el as HTMLElement;
  return (
    html.isContentEditable ||
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT"
  );
}

/**
 * An empty column: the "Open a surface" launcher. Each row's letter
 * picks it from anywhere while this column is focused and nothing that takes
 * typing has focus — no ⌘ needed. Esc closes the pane, so a stray ⌘T is one
 * key to undo.
 */
export function SurfaceLauncher({
  groupId,
  focused,
  closable,
}: {
  groupId: string;
  focused: boolean;
  closable: boolean;
}) {
  // Take focus when the launcher opens in the focused column. `⌘T` is
  // pressed from wherever you were — usually the chat composer — and without
  // this the letter that follows would be typed into it.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) rootRef.current?.focus({ preventScroll: true });
  }, [focused]);

  useEffect(() => {
    if (!focused) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(deepActiveElement())) return;
      // A dialog or menu owns the keyboard while it is up, and so does the
      // Settings screen, which covers the workspace without being a dialog.
      if (document.querySelector("[role='dialog'], [role='menu']")) return;
      if (useSettingsNav.getState().open) return;
      if (e.key === "Escape" && closable) {
        e.preventDefault();
        useLayoutStore.getState().actions.closeGroup(groupId);
        return;
      }
      const surface = surfaceForKey(e);
      if (!surface) return;
      e.preventDefault();
      openSurface(surface, groupId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focused, closable, groupId]);

  return (
    <SurfaceLauncherView
      rootRef={rootRef}
      surfaces={SURFACES}
      onPick={(surface) => openSurface(surface, groupId)}
    />
  );
}
