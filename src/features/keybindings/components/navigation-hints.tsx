import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useHintStore } from "@/features/hint-nav/stores/hint-store";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { Kbd } from "@/ui/kbd";
import { isActionId, type ActionId } from "../lib/actions";
import { displayKeys, matchesCombo } from "../lib/combo";
import {
  bindingForTarget,
  NAVIGATION_HINT_DELAY,
  NAVIGATION_OVERLAY_ATTR,
  NAVIGATION_TARGET_ATTR,
  type HeldModifiers,
} from "../lib/navigation-hints";
import { liveNavigationBindings, useNavigationBindings } from "../lib/use-navigation-bindings";
import { useKeybindingsStore } from "../stores/keybindings-store";

function targetActions(el: Element): ActionId[] {
  return (el.getAttribute(NAVIGATION_TARGET_ATTR) ?? "").split(" ").filter(isActionId);
}

function hasKeyboardOverlay(): boolean {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-hint-overlay]',
    ),
  ).some((el) => {
    const rect = el.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      !el.closest('[hidden], [inert], [aria-hidden="true"]') &&
      getComputedStyle(el).visibility !== "hidden"
    );
  });
}

function modifiers(e: KeyboardEvent): HeldModifiers {
  return { metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey };
}

function hasPrimary(e: KeyboardEvent): boolean {
  // Control also serves presets with macOS Control+1…9. Windows' Win key
  // and AltGraph are not hold triggers, even though chord matching folds Meta.
  return (isMac ? e.metaKey || e.ctrlKey : e.ctrlKey) && !e.getModifierState("AltGraph");
}

function isModifier(e: KeyboardEvent): boolean {
  return /^(Meta|Control|Alt|Shift)(Left|Right)?$/.test(e.code || e.key);
}

/**
 * Observe modifier lifetime without consuming events. Unrelated chords suppress
 * hints until release, so a long save/copy/IME chord cannot leave a stale overlay.
 */
function useHeldModifiers(blocked: boolean) {
  const [held, setHeld] = useState<HeldModifiers | null>(null);
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const dismissRef = useRef<() => void>(() => {});
  const dismiss = useCallback(() => dismissRef.current(), []);

  // Register before passive shortcut effects: even a scoped listener that
  // stops immediate propagation must not hide an unrelated key from us.
  useLayoutEffect(() => {
    let armed = false;
    let suppressed = false;
    let shown = false;
    let current: HeldModifiers | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hide = () => {
      clearTimeout(timer);
      shown = false;
      setHeld(null);
    };
    const reset = () => {
      hide();
      armed = false;
      suppressed = false;
      current = null;
    };
    const suppress = () => {
      hide();
      suppressed = armed;
    };
    dismissRef.current = suppress;

    const onKeyDown = (e: KeyboardEvent) => {
      if (!hasPrimary(e)) {
        if (armed) reset();
        return;
      }
      if (!armed && (!isModifier(e) || e.repeat)) return;
      current = modifiers(e);
      if (!armed) {
        armed = true;
        timer = setTimeout(() => {
          if (suppressed || blockedRef.current || hasKeyboardOverlay()) return suppress();
          shown = true;
          setHeld(current);
        }, NAVIGATION_HINT_DELAY);
      }
      if (blockedRef.current || e.isComposing || hasKeyboardOverlay()) return suppress();
      if (suppressed) return;
      if (isModifier(e)) {
        if (shown) setHeld(current);
        return;
      }
      const targets = new Set(
        Array.from(document.querySelectorAll<HTMLElement>("[" + NAVIGATION_TARGET_ATTR + "]"))
          .filter((el) => visibleRect(el) !== null)
          .flatMap(targetActions),
      );
      if (
        !liveNavigationBindings().some((b) => targets.has(b.actionId) && matchesCombo(e, b.combo))
      )
        suppress();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!hasPrimary(e)) return reset();
      current = modifiers(e);
      if (shown && !suppressed) setHeld(current);
    };
    const onVisibility = () => {
      if (document.hidden) reset();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", reset);
    window.addEventListener("pointerdown", suppress, true);
    window.addEventListener("compositionstart", suppress, true);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", reset);
      window.removeEventListener("pointerdown", suppress, true);
      window.removeEventListener("compositionstart", suppress, true);
      document.removeEventListener("visibilitychange", onVisibility);
      dismissRef.current = () => {};
    };
  }, []);

  useEffect(() => {
    if (blocked) dismiss();
  }, [blocked, dismiss]);
  return { held, dismiss };
}

interface Badge {
  actionId: ActionId;
  key: string;
  alignStart: boolean;
  left: number;
  top: number;
}

/** Hidden projects, disabled controls and clipped tabs must not advertise a destination. */
function visibleRect(el: HTMLElement): DOMRect | null {
  if (
    el.matches(':disabled, [aria-disabled="true"]') ||
    el.closest('[hidden], [inert], [aria-hidden="true"]')
  )
    return null;
  const rect = el.getBoundingClientRect();
  if (
    rect.width < 4 ||
    rect.height < 4 ||
    rect.left < -1 ||
    rect.top < -1 ||
    rect.right > window.innerWidth + 1 ||
    rect.bottom > window.innerHeight + 1
  )
    return null;
  for (let parent: HTMLElement | null = el; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")
      return null;
    if (parent === el) continue;
    const bounds = parent.getBoundingClientRect();
    if (
      /(auto|scroll|hidden|clip)/.test(style.overflowX) &&
      (rect.left < bounds.left - 1 || rect.right > bounds.right + 1)
    )
      return null;
    if (
      /(auto|scroll|hidden|clip)/.test(style.overflowY) &&
      (rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1)
    )
      return null;
  }
  return rect;
}

/** Static, non-interactive caps. All navigation remains in the existing dispatchers. */
export function NavigationHints() {
  const bindings = useNavigationBindings();
  const recording = useKeybindingsStore.use.recording();
  const hintNavigationOpen = useHintStore.use.open();
  const blocked = recording || hintNavigationOpen;
  const { held, dismiss } = useHeldModifiers(blocked);
  const [badges, setBadges] = useState<Badge[]>([]);

  useLayoutEffect(() => {
    if (!held || blocked) {
      setBadges([]);
      return;
    }
    const update = () => {
      if (hasKeyboardOverlay()) return dismiss();
      const bindings = liveNavigationBindings();
      const next: Badge[] = [];
      for (const el of document.querySelectorAll<HTMLElement>("[" + NAVIGATION_TARGET_ATTR + "]")) {
        const binding = bindingForTarget(targetActions(el), bindings, held, isMac);
        if (!binding) continue;
        const rect = visibleRect(el);
        if (!rect) continue;
        const keys = displayKeys(binding.combo);
        // Use a tab's icon area so its title remains readable during a hold.
        const alignStart = el.getAttribute("role") === "tab";
        next.push({
          actionId: binding.actionId,
          key: binding.combo.code === "Space" ? "␣" : keys[keys.length - 1]!,
          alignStart,
          left: alignStart ? rect.left + 2 : rect.right - 2,
          top: Math.max(2, rect.top + 1),
        });
      }
      setBadges(next);
    };
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        update();
      });
    };
    update();
    const observer = new MutationObserver((records) => {
      if (
        records.some((r) => {
          const el = r.target instanceof Element ? r.target : r.target.parentElement;
          return !el?.closest("[" + NAVIGATION_OVERLAY_ATTR + "]");
        })
      )
        schedule();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        NAVIGATION_TARGET_ATTR,
        "class",
        "style",
        "hidden",
        "inert",
        "aria-hidden",
        "disabled",
        "aria-disabled",
        "role",
      ],
    });
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    window.addEventListener("focusin", schedule);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("focusin", schedule);
    };
  }, [held, blocked, bindings, dismiss]);

  if (!held || blocked || !badges.length) return null;
  return createPortal(
    <div
      {...{ [NAVIGATION_OVERLAY_ATTR]: "" }}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-tooltip overflow-hidden"
    >
      {badges.map((badge, index) => (
        <Kbd
          key={badge.actionId + ":" + index}
          data-navigation-action={badge.actionId}
          className={cn(
            "absolute bg-popover text-foreground shadow-sm",
            !badge.alignStart && "-translate-x-full",
          )}
          style={{ left: badge.left, top: badge.top }}
        >
          {badge.key}
        </Kbd>
      ))}
    </div>,
    document.body,
  );
}
