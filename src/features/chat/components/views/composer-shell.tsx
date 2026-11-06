// The composer's shell: the positioned, stacking-context box that holds the
// overlays, the input card and the tray. Props-only — focus and fold state
// arrive as callbacks.

import type { ReactNode, Ref } from "react";
import { cn } from "@/lib/utils";

export function ComposerShell({
  composerRef,
  collapsed,
  collapsible,
  locked,
  onFocusCapture,
  onBlurCapture,
  onPress,
  onFold,
  children,
}: {
  composerRef: Ref<HTMLDivElement>;
  collapsed: boolean;
  /** Nothing in the composer would be hidden by folding it. */
  collapsible: boolean;
  /** A GitHub repo is syncing into `.atlas/repos`. */
  locked: boolean;
  onFocusCapture: () => void;
  onBlurCapture: () => void;
  /** A press anywhere in the composer. */
  onPress: () => void;
  /** Esc folded the composer. */
  onFold: () => void;
  children: ReactNode;
}) {
  return (
    <div
      ref={composerRef}
      data-chat-composer
      data-tip-anchor="composer"
      data-collapsed={collapsed || undefined}
      className={cn(
        // Positioned + z-indexed so the composer paints over — and visually
        // tucks — the PlanDock's bottom edge (the attached-panel recipe).
        //
        // The VALUE has to clear the floating pill row above the composer
        // (`z-20` in chat-panel.tsx), not just the PlanDock. This element
        // has a z-index, so it opens a stacking context, and every dropup
        // inside it — the model picker, the agent/mode picker, the toolbar
        // tooltip — is trapped in it: their `z-popover` sorts them against
        // each other and against nothing else. At `z-10` the whole composer,
        // menus included, painted UNDER the "Scroll to bottom" pill, which
        // also swallowed clicks on the menu's first row (the pill sets
        // `pointer-events-auto`). Raising the context is the fix; raising
        // the menus themselves cannot work from inside it.
        // The shell draws nothing: the input card is a surface of its own
        // and the toolbar a tray tucked under it (a muted outer card
        // around both is gone).
        "relative z-30",
        // The footer pills' labels collapse against THIS width.
        "@container",
        // NOTE: the disabled dim is NOT applied here. It used to be
        // (`disabled && "opacity-60"` on this shell), and it faded the
        // whole composer — footer pills, the agent switcher, and every
        // dropup, since the menus are absolutely-positioned CHILDREN of
        // this element (not portals) and inherit its opacity. The escape
        // hatch has to look reachable, not just be reachable, so the dim
        // now lives on the inner input surface alone.
        // Lock the composer while a GitHub repo syncs into `.atlas/repos`.
        locked && "opacity-60 pointer-events-none",
      )}
      onFocusCapture={onFocusCapture}
      onBlurCapture={onBlurCapture}
      // A press anywhere in it is being in it, focus or not (see above).
      onPointerDownCapture={onPress}
      // A press on the composer's own surface — the tray's padding, the
      // gaps between pills — keeps focus where it is. Left alone, it
      // moved focus to <body>, which folded the composer under the click.
      onMouseDown={(e) => {
        const target = e.target as Element;
        if (
          !target.closest(
            "button, a, input, textarea, select, [contenteditable='true'], [role='button'], [role='menuitem'], [tabindex]",
          )
        ) {
          e.preventDefault();
        }
      }}
      // Esc folds it, as clicking away does. Caught on the way DOWN:
      // ProseMirror marks Esc handled in the editor, so it never
      // bubbles back out unprevented. An open picker or menu keeps the
      // composer from folding (`collapsible`), and is left its own Esc.
      onKeyDownCapture={(e) => {
        if (e.key !== "Escape" || !collapsible) return;
        // A tray dropup (agent, model, options) that is open takes Esc to
        // close itself.
        if (e.currentTarget.querySelector("[data-popup-open], [aria-expanded='true']")) return;
        (document.activeElement as HTMLElement | null)?.blur();
        onFold();
      }}
    >
      {children}
    </div>
  );
}
